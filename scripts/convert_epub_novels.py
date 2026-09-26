#!/usr/bin/env python3
"""Audit and convert EPUB novels to UTF-8 TXT.

The default mode is deliberately read-only.  Passing ``--confirmed`` enables
TXT publication and deletion of EPUBs rejected by content validation.  A
durable JSONL audit record is written *before* every such deletion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import threading
import time
import unicodedata
import uuid
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

from fetcher.epub_converter import (
    EpubLimits,
    EpubRejection,
    delete_rejected_epub,
    inspect_epub,
    source_identity_unchanged,
    write_utf8_text,
)
from fetcher.local_resources import available_cpu_count


AUDIT_SCHEMA = "literary-giant-epub-batch-v1"
CHECKPOINT_ALGORITHM_VERSION = 2


def _absolute(path: str | Path) -> Path:
    return Path(os.path.abspath(os.fspath(Path(path).expanduser())))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _source_label(root: Path) -> str:
    normalized = unicodedata.normalize("NFKC", root.name).strip().strip(".")
    cleaned = "".join(
        character if character.isalnum() or character in {"-", "_", "."} else "_"
        for character in normalized
    ).strip("._")
    cleaned = cleaned[:80] or "source"
    suffix = hashlib.sha256(os.fsencode(str(root))).hexdigest()[:10]
    return f"{cleaned}__{suffix}"


@dataclass(frozen=True, slots=True)
class SourceItem:
    path: Path
    source_root: Path
    relative_path: Path
    source_label: str

    def destination(self, output_root: Path) -> Path:
        relative_txt = self.relative_path.with_suffix(".txt")
        return output_root / self.source_label / relative_txt


class DurableJsonlAudit:
    """Append-only JSONL writer with batching and explicit durability barriers."""

    def __init__(
        self,
        path: Path,
        *,
        sync_every: int = 64,
        sync_interval_seconds: float = 1.0,
    ) -> None:
        self.path = _absolute(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY
        flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        self._fd = os.open(self.path, flags, 0o600)
        self._lock = threading.Lock()
        self._sync_every = max(1, sync_every)
        self._sync_interval_seconds = max(0.05, sync_interval_seconds)
        self._pending = 0
        self._last_sync = time.monotonic()
        mode = os.fstat(self._fd).st_mode
        if not stat.S_ISREG(mode):
            os.close(self._fd)
            raise OSError(f"Audit destination is not a regular file: {self.path}")
        os.fsync(self._fd)
        directory_fd = os.open(
            self.path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        )
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def append(self, payload: Mapping[str, object], *, durable: bool = False) -> None:
        encoded = (
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        with self._lock:
            view = memoryview(encoded)
            while view:
                written = os.write(self._fd, view)
                if written <= 0:
                    raise OSError(f"Could not append audit record: {self.path}")
                view = view[written:]
            self._pending += 1
            now = time.monotonic()
            if (
                durable
                or self._pending >= self._sync_every
                or now - self._last_sync >= self._sync_interval_seconds
            ):
                os.fsync(self._fd)
                self._pending = 0
                self._last_sync = now

    def flush(self) -> None:
        with self._lock:
            if self._fd >= 0 and self._pending:
                os.fsync(self._fd)
                self._pending = 0
                self._last_sync = time.monotonic()

    def close(self) -> None:
        with self._lock:
            if self._fd >= 0:
                if self._pending:
                    os.fsync(self._fd)
                os.close(self._fd)
                self._fd = -1
                self._pending = 0

    def __enter__(self) -> "DurableJsonlAudit":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _walk_epubs(root: Path) -> Iterable[Path]:
    def raise_walk_error(error: OSError) -> None:
        raise error

    for directory, child_dirs, filenames in os.walk(
        root, followlinks=False, onerror=raise_walk_error
    ):
        directory_path = Path(directory)
        child_dirs[:] = sorted(
            name for name in child_dirs if not (directory_path / name).is_symlink()
        )
        for filename in sorted(filenames):
            if filename.lower().endswith(".epub"):
                yield directory_path / filename


def discover_epubs(source_arguments: Sequence[str], *, limit: int | None) -> list[SourceItem]:
    """Discover EPUBs deterministically while preserving per-source structure."""

    discovered: list[SourceItem] = []
    seen: set[str] = set()
    for argument in source_arguments:
        source = _absolute(argument)
        if not source.exists() and not source.is_symlink():
            raise FileNotFoundError(f"Source does not exist: {source}")
        if source.is_dir() and not source.is_symlink():
            root = source
            candidates = _walk_epubs(root)
        else:
            if source.suffix.lower() != ".epub":
                raise ValueError(f"Source file is not an EPUB: {source}")
            root = source.parent
            candidates = (source,)
        label = _source_label(root)
        for candidate in candidates:
            absolute_candidate = _absolute(candidate)
            key = os.path.normcase(str(absolute_candidate))
            if key in seen:
                continue
            seen.add(key)
            discovered.append(
                SourceItem(
                    path=absolute_candidate,
                    source_root=root,
                    relative_path=absolute_candidate.relative_to(root),
                    source_label=label,
                )
            )
            if limit is not None and len(discovered) >= limit:
                return discovered
    return discovered


def _base_record(run_id: str, *, mode: str, event: str) -> dict[str, object]:
    return {
        "schema": AUDIT_SCHEMA,
        "run_id": run_id,
        "timestamp": _utc_now(),
        "mode": mode,
        "event": event,
    }


def _merge_inspection(
    record: dict[str, object], inspection_payload: Mapping[str, object]
) -> None:
    payload = dict(inspection_payload)
    record["inspection_schema"] = payload.pop("schema", "")
    record.update(payload)


def _emit(
    payload: Mapping[str, object],
    *,
    audit: DurableJsonlAudit | None,
    quiet: bool,
    durable: bool = False,
) -> None:
    if audit is not None:
        audit.append(payload, durable=durable)
    if not quiet:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate EPUB containers and OPF spines, then convert readable novels "
            "to UTF-8 TXT. The default mode only audits."
        ),
        epilog=(
            "DANGER: --confirmed writes TXT files and permanently deletes EPUBs "
            "rejected as corrupt, encrypted/DRM, unsafe, or lacking valid text."
        ),
    )
    parser.add_argument("sources", nargs="*", help="EPUB files or directories to scan")
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        dest="option_sources",
        help="Additional EPUB file or directory (repeatable)",
    )
    parser.add_argument(
        "--max-pending",
        type=_positive_int,
        help="Maximum submitted tasks (default: twice --workers)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help=(
            "Reuse terminal records in --report only when source identity, "
            "configuration, and (in confirmed mode) TXT identity still match"
        ),
    )
    parser.add_argument(
        "--audit-sync-records",
        type=_positive_int,
        default=64,
        help="Batch ordinary audit fsyncs; delete intents always fsync immediately",
    )
    parser.add_argument("--output-root", type=Path, help="Root for structure-preserving TXT output")
    parser.add_argument("--report", type=Path, help="Append-only JSONL audit report")
    parser.add_argument(
        "--confirmed",
        action="store_true",
        help="Execute conversion and audited deletion of validation-rejected EPUBs",
    )
    parser.add_argument("--limit", type=_positive_int, help="Inspect at most this many EPUBs")
    parser.add_argument(
        "--workers",
        type=_positive_int,
        default=min(16, available_cpu_count()),
        help=(
            "Concurrent EPUB inspections/conversions "
            "(default: min(16, detected affinity/cgroup CPU quota))"
        ),
    )
    parser.add_argument("--quiet", action="store_true", help="Do not mirror JSONL records to stdout")
    parser.add_argument(
        "--minimum-text-characters",
        type=_positive_int,
        default=100,
        help="Minimum alphanumeric characters for an EPUB to be accepted (default: 100)",
    )
    parser.add_argument("--max-members", type=_positive_int, default=20_000)
    parser.add_argument(
        "--max-total-uncompressed-mib", type=_positive_int, default=1024
    )
    parser.add_argument(
        "--max-entry-uncompressed-mib", type=_positive_int, default=256
    )
    parser.add_argument("--max-compression-ratio", type=_positive_float, default=200.0)
    return parser


def _process_one(
    item: SourceItem,
    *,
    run_id: str,
    mode: str,
    confirmed: bool,
    output_root: Path | None,
    limits: EpubLimits,
    audit: DurableJsonlAudit | None,
    quiet: bool,
) -> tuple[str, bool]:
    planned_output = item.destination(output_root) if output_root is not None else None
    try:
        inspection = inspect_epub(item.path, limits=limits)
    except EpubRejection as exc:
        record = _base_record(run_id, mode=mode, event="source_error")
        record.update(
            {
                "status": "source_retained",
                "source_path": str(item.path),
                "error": {"code": exc.code, "reason": str(exc), "details": exc.details},
            }
        )
        _emit(record, audit=audit, quiet=quiet)
        return "errors", False
    except Exception as exc:
        record = _base_record(run_id, mode=mode, event="source_error")
        record.update(
            {
                "status": "source_retained",
                "source_path": str(item.path),
                "error": {"code": "inspection_error", "reason": f"{type(exc).__name__}: {exc}"},
            }
        )
        _emit(record, audit=audit, quiet=quiet)
        return "errors", False

    if not inspection.accepted:
        status = "rejected_pending_delete" if confirmed else "rejected_retained_dry_run"
        record = _base_record(run_id, mode=mode, event="validation_result")
        _merge_inspection(
            record, inspection.to_dict(status=status, include_chapters=False)
        )
        if planned_output is not None:
            record["planned_output_path"] = str(planned_output)
        # This fsynced record is intentionally emitted before a destructive action.
        _emit(record, audit=audit, quiet=quiet, durable=confirmed)
        if not confirmed:
            return "rejected", False
        try:
            delete_rejected_epub(inspection)
        except Exception as exc:
            retained = _base_record(run_id, mode=mode, event="delete_result")
            _merge_inspection(
                retained,
                inspection.to_dict(
                    status="rejected_retained_delete_error", include_chapters=False
                ),
            )
            retained["error"] = f"{type(exc).__name__}: {exc}"
            _emit(retained, audit=audit, quiet=quiet)
            return "errors", False
        deleted = _base_record(run_id, mode=mode, event="delete_result")
        _merge_inspection(
            deleted,
            inspection.to_dict(status="rejected_deleted", include_chapters=False),
        )
        _emit(deleted, audit=audit, quiet=quiet)
        return "rejected", True

    if not confirmed:
        record = _base_record(run_id, mode=mode, event="validation_result")
        _merge_inspection(
            record,
            inspection.to_dict(
                status="convertible_dry_run",
                output_path=str(planned_output) if planned_output is not None else None,
                include_chapters=False,
            ),
        )
        _emit(record, audit=audit, quiet=quiet)
        return "convertible", False

    assert inspection.document is not None
    assert planned_output is not None
    try:
        # The source was fully hashed before inspection and stat-checked after
        # it.  Conversion publishes the already decoded document and does not
        # delete the EPUB, so a second full source hash adds I/O without adding
        # destructive-action safety.
        if not source_identity_unchanged(inspection.identity, verify_digest=False):
            raise RuntimeError("EPUB changed after inspection; conversion was not published")
        write_result = write_utf8_text(inspection.document, planned_output)
    except Exception as exc:
        record = _base_record(run_id, mode=mode, event="conversion_result")
        _merge_inspection(
            record,
            inspection.to_dict(
                status="conversion_error_source_retained", include_chapters=False
            ),
        )
        record["error"] = f"{type(exc).__name__}: {exc}"
        _emit(record, audit=audit, quiet=quiet)
        return "errors", False
    record = _base_record(run_id, mode=mode, event="conversion_result")
    _merge_inspection(
        record,
        inspection.to_dict(
            status=str(write_result["status"]),
            output_path=str(write_result["path"]),
            output_sha256=str(write_result["sha256"]),
            include_chapters=False,
        ),
    )
    record["output_bytes"] = int(write_result["bytes"])
    _emit(record, audit=audit, quiet=quiet)
    return "converted", False


def _configuration_fingerprint(
    *, mode: str, output_root: Path | None, limits: EpubLimits
) -> str:
    payload = {
        "checkpoint_algorithm_version": CHECKPOINT_ALGORITHM_VERSION,
        "mode": mode,
        "output_root": str(output_root) if output_root is not None else None,
        "limits": {
            "max_members": limits.max_members,
            "max_total_uncompressed_bytes": limits.max_total_uncompressed_bytes,
            "max_entry_uncompressed_bytes": limits.max_entry_uncompressed_bytes,
            "max_compression_ratio": limits.max_compression_ratio,
            "compression_ratio_min_bytes": limits.compression_ratio_min_bytes,
            "max_xml_bytes": limits.max_xml_bytes,
            "max_spine_items": limits.max_spine_items,
            "minimum_text_characters": limits.min_meaningful_chars,
        },
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_resume_records(
    report_path: Path,
    *,
    configuration_fingerprint: str,
    confirmed: bool,
) -> dict[str, dict[str, object]]:
    """Load only terminal per-source records from matching prior runs."""

    if not report_path.exists():
        return {}
    run_fingerprints: dict[str, str] = {}
    checkpoints: dict[str, dict[str, object]] = {}
    terminal_statuses = (
        {"converted", "already_present"}
        if confirmed
        else {"convertible_dry_run", "rejected_retained_dry_run"}
    )
    with report_path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                if not raw_line.endswith("\n"):
                    break
                raise ValueError(
                    f"Cannot safely resume from malformed JSONL line {line_number}: {exc}"
                ) from exc
            if not isinstance(record, dict):
                continue
            run_id = str(record.get("run_id", ""))
            if record.get("event") == "run_started":
                run_fingerprints[run_id] = str(
                    record.get("configuration_fingerprint", "")
                )
                continue
            if (
                run_fingerprints.get(run_id) != configuration_fingerprint
                or record.get("status") not in terminal_statuses
            ):
                continue
            source = record.get("source")
            if isinstance(source, dict) and isinstance(source.get("path"), str):
                checkpoints[str(source["path"])] = record
    return checkpoints


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _resume_record_matches(
    record: Mapping[str, object],
    *,
    item: SourceItem,
    planned_output: Path | None,
    confirmed: bool,
) -> bool:
    source = record.get("source")
    if not isinstance(source, Mapping) or source.get("path") != str(item.path):
        return False
    try:
        current = item.path.lstat()
        if item.path.is_symlink() or not stat.S_ISREG(current.st_mode):
            return False
        expected_stat = (
            int(source["device_id"]),
            int(source["inode"]),
            int(source["size_bytes"]),
            int(source["mtime_ns"]),
        )
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != expected_stat:
            return False
        if _sha256_file(item.path) != str(source["sha256"]):
            return False
        if not confirmed:
            return True
        if planned_output is None or record.get("output_path") != str(planned_output):
            return False
        output_stat = planned_output.lstat()
        if planned_output.is_symlink() or not stat.S_ISREG(output_stat.st_mode):
            return False
        if output_stat.st_size != int(record["output_bytes"]):
            return False
        return _sha256_file(planned_output) == str(record["output_sha256"])
    except (FileNotFoundError, KeyError, OSError, TypeError, ValueError):
        return False


def _bounded_parallel_outcomes(
    executor: ThreadPoolExecutor,
    items: Sequence[SourceItem],
    process: Callable[[SourceItem], tuple[str, bool]],
    *,
    max_pending: int,
) -> Iterable[tuple[str, bool]]:
    """Submit only a bounded window instead of one Future per EPUB."""

    iterator = iter(items)
    pending: set[Future[tuple[str, bool]]] = set()

    def fill() -> None:
        while len(pending) < max_pending:
            try:
                item = next(iterator)
            except StopIteration:
                return
            pending.add(executor.submit(process, item))

    fill()
    while pending:
        completed, pending_remainder = wait(pending, return_when=FIRST_COMPLETED)
        pending = set(pending_remainder)
        for future in completed:
            yield future.result()
        fill()


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    source_arguments = [*args.sources, *args.option_sources]
    if not source_arguments:
        parser.error("at least one source file or directory is required")
    if args.confirmed and args.output_root is None:
        parser.error("--confirmed requires --output-root")
    if args.confirmed and args.report is None:
        parser.error("--confirmed requires --report so deletions have a durable audit trail")
    if args.resume and args.report is None:
        parser.error("--resume requires --report")

    output_root = _absolute(args.output_root) if args.output_root is not None else None
    report_path = _absolute(args.report) if args.report is not None else None
    try:
        items = discover_epubs(source_arguments, limit=args.limit)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    limits = EpubLimits(
        max_members=args.max_members,
        max_total_uncompressed_bytes=args.max_total_uncompressed_mib * 1024 * 1024,
        max_entry_uncompressed_bytes=args.max_entry_uncompressed_mib * 1024 * 1024,
        max_compression_ratio=args.max_compression_ratio,
        min_meaningful_chars=args.minimum_text_characters,
    )
    run_id = uuid.uuid4().hex
    mode = "confirmed" if args.confirmed else "dry_run"
    configuration_fingerprint = _configuration_fingerprint(
        mode=mode, output_root=output_root, limits=limits
    )
    try:
        resume_records = (
            _load_resume_records(
                report_path,
                configuration_fingerprint=configuration_fingerprint,
                confirmed=args.confirmed,
            )
            if args.resume and report_path is not None
            else {}
        )
    except (OSError, UnicodeError, ValueError) as exc:
        parser.error(str(exc))
    counts = {
        "found": len(items),
        "convertible": 0,
        "converted": 0,
        "rejected": 0,
        "deleted": 0,
        "skipped": 0,
        "errors": 0,
    }

    audit_context = (
        DurableJsonlAudit(report_path, sync_every=args.audit_sync_records)
        if report_path is not None
        else None
    )
    try:
        start = _base_record(run_id, mode=mode, event="run_started")
        start.update(
            {
                "sources": [str(_absolute(value)) for value in source_arguments],
                "output_root": str(output_root) if output_root is not None else None,
                "report_path": str(report_path) if report_path is not None else None,
                "found": len(items),
                "workers": args.workers,
                "max_pending": args.max_pending or args.workers * 2,
                "resume": bool(args.resume),
                "resume_candidates": len(resume_records),
                "checkpoint_algorithm_version": CHECKPOINT_ALGORITHM_VERSION,
                "configuration_fingerprint": configuration_fingerprint,
                "limits": {
                    "max_members": limits.max_members,
                    "max_total_uncompressed_bytes": limits.max_total_uncompressed_bytes,
                    "max_entry_uncompressed_bytes": limits.max_entry_uncompressed_bytes,
                    "max_compression_ratio": limits.max_compression_ratio,
                    "compression_ratio_min_bytes": limits.compression_ratio_min_bytes,
                    "max_xml_bytes": limits.max_xml_bytes,
                    "max_spine_items": limits.max_spine_items,
                    "minimum_text_characters": limits.min_meaningful_chars,
                },
            }
        )
        _emit(start, audit=audit_context, quiet=args.quiet, durable=True)

        def process(item: SourceItem) -> tuple[str, bool]:
            checkpoint = resume_records.get(str(item.path))
            planned_output = item.destination(output_root) if output_root is not None else None
            if checkpoint is not None and _resume_record_matches(
                checkpoint,
                item=item,
                planned_output=planned_output,
                confirmed=args.confirmed,
            ):
                record = _base_record(run_id, mode=mode, event="resume_skipped")
                record.update(
                    {
                        "status": "identity_verified_resume_skip",
                        "source": checkpoint["source"],
                        "checkpoint_status": checkpoint.get("status"),
                        "output_path": checkpoint.get("output_path"),
                        "output_sha256": checkpoint.get("output_sha256"),
                        "output_bytes": checkpoint.get("output_bytes"),
                    }
                )
                _emit(record, audit=audit_context, quiet=args.quiet)
                return "skipped", False
            return _process_one(
                item,
                run_id=run_id,
                mode=mode,
                confirmed=args.confirmed,
                output_root=output_root,
                limits=limits,
                audit=audit_context,
                quiet=args.quiet,
            )

        if args.workers == 1 or len(items) <= 1:
            outcomes = map(process, items)
            for outcome, deleted in outcomes:
                counts[outcome] += 1
                if deleted:
                    counts["deleted"] += 1
        else:
            with ThreadPoolExecutor(
                max_workers=min(args.workers, len(items)),
                thread_name_prefix="epub-convert",
            ) as executor:
                outcomes = _bounded_parallel_outcomes(
                    executor,
                    items,
                    process,
                    max_pending=max(1, args.max_pending or args.workers * 2),
                )
                for outcome, deleted in outcomes:
                    counts[outcome] += 1
                    if deleted:
                        counts["deleted"] += 1
        summary = _base_record(run_id, mode=mode, event="run_completed")
        summary["counts"] = counts
        _emit(summary, audit=audit_context, quiet=args.quiet, durable=True)
    finally:
        if audit_context is not None:
            audit_context.close()
    return 1 if counts["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
