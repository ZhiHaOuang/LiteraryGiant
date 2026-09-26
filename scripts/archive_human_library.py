from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import time
import zipfile
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence, TypeVar

from fetcher.local_resources import available_cpu_count


DEFAULT_SOURCE_ROOT = Path("Library/TaciturnHuman")
DEFAULT_TARGET_ROOT = Path("Library/TaciturnHumanZip")
DEFAULT_MAX_FILES = 2_500
DEFAULT_MAX_BYTES = 10 * 1024**3
DEFAULT_COMPRESSION_LEVEL = 6
DEFAULT_MINIMUM_FREE_BYTES = 20_000_000_000
_CATEGORY_RE = re.compile(r"^(?P<code>\d{2})_(?P<label>.+)$")
_ID_RE = re.compile(r"(?:^|_)id(?P<number>\d{6})(?:_|\.)")


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    source: Path
    arcname: str
    canonical_id: str
    size: int


@dataclass(frozen=True, slots=True)
class ArchiveShard:
    category: str
    part: int
    entries: tuple[ArchiveEntry, ...]
    raw_bytes: int
    output: Path

    @property
    def first_id(self) -> str:
        return self.entries[0].canonical_id

    @property
    def last_id(self) -> str:
        return self.entries[-1].canonical_id


@dataclass(frozen=True, slots=True)
class ArchiveResult:
    output: Path
    status: str
    files: int
    raw_bytes: int
    archive_bytes: int
    elapsed_seconds: float


def _canonical_id(filename: str) -> str:
    match = _ID_RE.search(filename)
    if match is None:
        raise ValueError(f"filename does not contain a six-digit canonical ID: {filename!r}")
    return f"id{match.group('number')}"


def _scan_category(category_dir: Path) -> list[ArchiveEntry]:
    category = category_dir.name
    match = _CATEGORY_RE.fullmatch(category)
    if match is None:
        raise ValueError(f"invalid category directory: {category_dir}")
    expected_suffix = ".pdf" if match.group("code") == "22" else ".txt"
    rows: list[tuple[int, str, Path, int]] = []
    with os.scandir(category_dir) as iterator:
        for directory_entry in iterator:
            if not directory_entry.is_file(follow_symlinks=False):
                raise ValueError(f"unexpected non-file in category: {directory_entry.path}")
            path = Path(directory_entry.path)
            if path.suffix.lower() != expected_suffix:
                raise ValueError(f"unexpected suffix in {category}: {path.name}")
            canonical_id = _canonical_id(path.name)
            rows.append(
                (
                    int(canonical_id[2:]),
                    path.name,
                    path,
                    directory_entry.stat(follow_symlinks=False).st_size,
                )
            )
    rows.sort(key=lambda row: (row[0], row[1]))
    ids = [row[0] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate canonical IDs in category {category}")
    return [
        ArchiveEntry(
            source=path,
            arcname=f"{category}/{name}",
            canonical_id=f"id{identifier:06d}",
            size=size,
        )
        for identifier, name, path, size in rows
    ]


def build_archive_plan(
    source_root: Path,
    target_root: Path,
    *,
    max_files: int = DEFAULT_MAX_FILES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> list[ArchiveShard]:
    if max_files <= 0 or max_bytes <= 0:
        raise ValueError("max_files and max_bytes must be positive")
    source_root = source_root.resolve()
    target_root = target_root.resolve()
    if target_root == source_root or source_root in target_root.parents:
        raise ValueError("archive target must not be inside the source library")
    raw_root = source_root / "01_RawData"
    if not raw_root.is_dir():
        raise FileNotFoundError(raw_root)
    categories = sorted(path for path in raw_root.iterdir() if path.is_dir())
    if len(categories) != 23:
        raise ValueError(f"expected 23 categories, found {len(categories)}")
    shards: list[ArchiveShard] = []
    for category_dir in categories:
        entries = _scan_category(category_dir)
        if not entries:
            raise ValueError(f"empty category: {category_dir}")
        part = 0
        pending: list[ArchiveEntry] = []
        pending_bytes = 0

        def flush() -> None:
            nonlocal part, pending, pending_bytes
            if not pending:
                return
            part += 1
            first_id = pending[0].canonical_id
            last_id = pending[-1].canonical_id
            filename = (
                f"{category_dir.name}_part{part:03d}_{first_id}-{last_id}.zip"
            )
            shards.append(
                ArchiveShard(
                    category=category_dir.name,
                    part=part,
                    entries=tuple(pending),
                    raw_bytes=pending_bytes,
                    output=target_root / category_dir.name / filename,
                )
            )
            pending = []
            pending_bytes = 0

        for entry in entries:
            if pending and (
                len(pending) >= max_files or pending_bytes + entry.size > max_bytes
            ):
                flush()
            pending.append(entry)
            pending_bytes += entry.size
            if len(pending) >= max_files or pending_bytes >= max_bytes:
                flush()
        flush()
    outputs = [shard.output for shard in shards]
    if len(outputs) != len(set(outputs)):
        raise ValueError("archive plan contains duplicate output paths")
    return shards


def _validate_central_directory(shard: ArchiveShard, archive: Path) -> int:
    expected = {entry.arcname: entry.size for entry in shard.entries}
    with zipfile.ZipFile(archive, "r", allowZip64=True) as handle:
        actual = {info.filename: info.file_size for info in handle.infolist()}
    if actual != expected:
        raise RuntimeError(f"ZIP central directory does not match plan: {archive}")
    return archive.stat().st_size


def _create_archive(payload: tuple[ArchiveShard, int]) -> ArchiveResult:
    shard, compression_level = payload
    shard.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if shard.output.exists():
        archive_bytes = _validate_central_directory(shard, shard.output)
        return ArchiveResult(
            output=shard.output,
            status="skipped",
            files=len(shard.entries),
            raw_bytes=shard.raw_bytes,
            archive_bytes=archive_bytes,
            elapsed_seconds=time.monotonic() - started,
        )
    temporary = shard.output.parent / f".{shard.output.name}.partial"
    temporary.unlink(missing_ok=True)
    completed_files = completed_bytes = 0
    next_report = time.monotonic() + 20.0
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=compression_level,
            allowZip64=True,
            strict_timestamps=False,
        ) as archive:
            for entry in shard.entries:
                before = entry.source.stat()
                if before.st_size != entry.size:
                    raise RuntimeError(f"source changed after planning: {entry.source}")
                archive.write(entry.source, arcname=entry.arcname)
                after = entry.source.stat()
                if (before.st_size, before.st_mtime_ns) != (
                    after.st_size,
                    after.st_mtime_ns,
                ):
                    raise RuntimeError(f"source changed during compression: {entry.source}")
                completed_files += 1
                completed_bytes += entry.size
                now = time.monotonic()
                if now >= next_report:
                    print(
                        json.dumps(
                            {
                                "stage": "archive_worker",
                                "archive": shard.output.name,
                                "files": completed_files,
                                "total_files": len(shard.entries),
                                "raw_bytes": completed_bytes,
                                "total_raw_bytes": shard.raw_bytes,
                                "percent": round(
                                    completed_bytes * 100 / shard.raw_bytes, 2
                                ),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    next_report = now + 20.0
        archive_bytes = _validate_central_directory(shard, temporary)
        os.replace(temporary, shard.output)
        return ArchiveResult(
            output=shard.output,
            status="created",
            files=len(shard.entries),
            raw_bytes=shard.raw_bytes,
            archive_bytes=archive_bytes,
            elapsed_seconds=time.monotonic() - started,
        )
    finally:
        temporary.unlink(missing_ok=True)


T = TypeVar("T")


def _bounded_results(
    values: Iterable[T],
    function,
    *,
    workers: int,
) -> Iterator[ArchiveResult]:
    iterator = iter(values)
    with ProcessPoolExecutor(max_workers=workers) as executor:
        pending: dict[Future[ArchiveResult], T] = {}
        for _ in range(workers):
            try:
                value = next(iterator)
            except StopIteration:
                break
            pending[executor.submit(function, value)] = value
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                del pending[future]
                yield future.result()
                try:
                    value = next(iterator)
                except StopIteration:
                    continue
                pending[executor.submit(function, value)] = value


def create_archives(
    shards: Sequence[ArchiveShard],
    *,
    workers: int,
    compression_level: int,
    minimum_free_bytes: int,
    max_bytes: int,
) -> dict[str, int | float]:
    total_raw_bytes = sum(shard.raw_bytes for shard in shards)
    started = time.monotonic()
    completed_raw_bytes = completed_archive_bytes = 0
    created_raw_bytes = created_archive_bytes = 0
    created = skipped = completed = 0
    # Enough headroom for every in-flight shard in the worst case plus the
    # requested final reserve. The check is intentionally conservative.
    required_headroom = minimum_free_bytes + workers * max_bytes
    archive_root = shards[0].output.parents[1]
    archive_root.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(archive_root).free
    if free_bytes <= required_headroom:
        raise RuntimeError(
            f"insufficient safe headroom: free={free_bytes}, required={required_headroom}"
        )
    payloads = [(shard, compression_level) for shard in shards]
    for result in _bounded_results(payloads, _create_archive, workers=workers):
        completed += 1
        completed_raw_bytes += result.raw_bytes
        completed_archive_bytes += result.archive_bytes
        created += int(result.status == "created")
        skipped += int(result.status == "skipped")
        if result.status == "created":
            created_raw_bytes += result.raw_bytes
            created_archive_bytes += result.archive_bytes
        elapsed = max(time.monotonic() - started, 0.001)
        # Existing, validated archives complete almost instantly on a resumed run.
        # Do not count their raw bytes as work performed in this invocation or the
        # reported throughput and ETA would be grossly inflated.
        raw_rate = created_raw_bytes / elapsed
        remaining = max(total_raw_bytes - completed_raw_bytes, 0)
        free_bytes = shutil.disk_usage(result.output.parent).free
        print(
            json.dumps(
                {
                    "stage": "archive",
                    "completed_archives": completed,
                    "total_archives": len(shards),
                    "created": created,
                    "skipped": skipped,
                    "completed_raw_bytes": completed_raw_bytes,
                    "total_raw_bytes": total_raw_bytes,
                    "percent": round(completed_raw_bytes * 100 / total_raw_bytes, 3),
                    "archive_bytes": completed_archive_bytes,
                    "compression_ratio": round(
                        completed_archive_bytes / completed_raw_bytes, 4
                    ),
                    "created_raw_bytes": created_raw_bytes,
                    "created_archive_bytes": created_archive_bytes,
                    "raw_mib_per_second": (
                        round(raw_rate / (1024 * 1024), 2) if raw_rate else None
                    ),
                    "eta_seconds": round(remaining / raw_rate, 1) if raw_rate else None,
                    "free_bytes": free_bytes,
                    "last_archive": result.output.name,
                    "last_elapsed_seconds": round(result.elapsed_seconds, 1),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        if completed < len(shards) and free_bytes <= required_headroom:
            raise RuntimeError(
                "free-space safety gate reached after a complete shard; rerun is safe "
                f"after adding space: free={free_bytes}, required={required_headroom}"
            )
    return {
        "archives": len(shards),
        "created": created,
        "skipped": skipped,
        "raw_bytes": total_raw_bytes,
        "archive_bytes": completed_archive_bytes,
        "elapsed_seconds": time.monotonic() - started,
    }


def copy_catalog(source_root: Path, target_root: Path) -> None:
    source = source_root / "02_Catalog"
    target = target_root / "02_Catalog"
    if {path.name for path in source.iterdir()} != {"全部书目.xlsx", "分类目录"}:
        raise RuntimeError(f"source catalog has unexpected entries: {source}")
    if target.exists():
        if not target.is_dir():
            raise RuntimeError(f"catalog target is not a directory: {target}")
        shutil.rmtree(target)
    shutil.copytree(source, target, copy_function=shutil.copyfile)


def verify_archives(shards: Sequence[ArchiveShard], target_root: Path) -> dict[str, int]:
    archive_bytes = raw_bytes = files = 0
    expected_outputs = {shard.output for shard in shards}
    for shard in shards:
        archive_bytes += _validate_central_directory(shard, shard.output)
        raw_bytes += shard.raw_bytes
        files += len(shard.entries)
    actual_outputs = set(target_root.glob("[0-9][0-9]_*/*.zip"))
    if actual_outputs != expected_outputs:
        raise RuntimeError(
            f"archive outputs differ from plan: missing={len(expected_outputs-actual_outputs)}, "
            f"unexpected={len(actual_outputs-expected_outputs)}"
        )
    partials = list(target_root.rglob(".*.partial"))
    if partials:
        raise RuntimeError(f"partial archives remain: {partials[:3]}")
    catalog_entries = {path.name for path in (target_root / "02_Catalog").iterdir()}
    if catalog_entries != {"全部书目.xlsx", "分类目录"}:
        raise RuntimeError(f"unexpected archived catalog entries: {catalog_entries}")
    return {
        "archives": len(shards),
        "files": files,
        "raw_bytes": raw_bytes,
        "archive_bytes": archive_bytes,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Archive TaciturnHuman by category into bounded ZIP64 shards."
    )
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--target-root", type=Path, default=DEFAULT_TARGET_ROOT)
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--compression-level", type=int, default=DEFAULT_COMPRESSION_LEVEL)
    parser.add_argument("--workers", type=int, default=available_cpu_count())
    parser.add_argument(
        "--minimum-free-bytes", type=int, default=DEFAULT_MINIMUM_FREE_BYTES
    )
    parser.add_argument(
        "--mode", choices=("plan", "archive", "verify", "all"), default="all"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    workers = max(1, int(args.workers))
    source_root = args.source_root.resolve()
    target_root = args.target_root.resolve()
    shards = build_archive_plan(
        source_root,
        target_root,
        max_files=int(args.max_files),
        max_bytes=int(args.max_bytes),
    )
    total_files = sum(len(shard.entries) for shard in shards)
    total_bytes = sum(shard.raw_bytes for shard in shards)
    print(
        json.dumps(
            {
                "stage": "plan",
                "categories": len({shard.category for shard in shards}),
                "archives": len(shards),
                "files": total_files,
                "raw_bytes": total_bytes,
                "max_files": int(args.max_files),
                "max_bytes": int(args.max_bytes),
                "compression": "ZIP64 Deflate",
                "compression_level": int(args.compression_level),
                "workers": workers,
                "target": str(target_root),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if args.mode == "plan":
        return 0
    if args.mode in {"archive", "all"}:
        target_root.mkdir(parents=True, exist_ok=True)
        create_archives(
            shards,
            workers=workers,
            compression_level=int(args.compression_level),
            minimum_free_bytes=int(args.minimum_free_bytes),
            max_bytes=int(args.max_bytes),
        )
        copy_catalog(source_root, target_root)
    if args.mode in {"verify", "all"}:
        result = verify_archives(shards, target_root)
        print(
            json.dumps({"stage": "verify", "status": "complete", **result}),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
