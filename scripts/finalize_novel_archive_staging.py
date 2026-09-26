#!/usr/bin/env python3
"""Finalize a complete interrupted ZIP staging tree without re-extracting it.

The expected path and size inventory comes from the ZIP central directory.
Content is checked for a deterministic distributed sample both before and
after publishing.  The source ZIP is removed only after the complete metadata
inventory and all samples match.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, ZipInfo

try:
    from .extract_novel_archives import (
        DEFAULT_SAMPLE_FILES,
        archive_identity,
        archive_output_root,
        archive_stem,
        distributed_sample_indexes,
        fsync_directory,
        is_noise,
        verify_archive_identity,
        verify_archive_stable,
    )
except ImportError:  # Direct execution: python scripts/finalize_novel_archive_staging.py
    from extract_novel_archives import (
        DEFAULT_SAMPLE_FILES,
        archive_identity,
        archive_output_root,
        archive_stem,
        distributed_sample_indexes,
        fsync_directory,
        is_noise,
        verify_archive_identity,
        verify_archive_stable,
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest_stream(handle) -> str:
    digest = hashlib.sha256()
    while chunk := handle.read(8 * 1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def digest_file(path: Path) -> str:
    with path.open("rb") as handle:
        return digest_stream(handle)


def decoded_zip_name(info: ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    for encoding in ("gbk", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return name


def expected_inventory(archive: Path) -> tuple[ZipFile, dict[Path, ZipInfo]]:
    handle = ZipFile(archive)
    entries: list[tuple[Path, ZipInfo]] = []
    for info in handle.infolist():
        if info.is_dir():
            continue
        normalized = decoded_zip_name(info).replace("\\", "/")
        parts = PurePosixPath(normalized).parts
        if not parts or normalized.startswith("/") or ".." in parts:
            handle.close()
            raise RuntimeError(f"unsafe ZIP member: {info.filename!r}")
        relative = Path(*parts)
        if not is_noise(relative):
            entries.append((relative, info))
    if not entries:
        handle.close()
        raise RuntimeError("ZIP contains no non-noise files")

    stem = archive_stem(archive)
    if all(len(relative.parts) > 1 and relative.parts[0] == stem for relative, _ in entries):
        entries = [(Path(*relative.parts[1:]), info) for relative, info in entries]

    inventory: dict[Path, ZipInfo] = {}
    for relative, info in entries:
        if relative in inventory:
            handle.close()
            raise RuntimeError(f"duplicate normalized ZIP path: {relative}")
        inventory[relative] = info
    return handle, inventory


def actual_inventory(root: Path) -> dict[Path, Path]:
    inventory: dict[Path, Path] = {}
    if not root.exists():
        return inventory
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(directory)
        dirnames.sort(key=os.fsencode)
        filenames.sort(key=os.fsencode)
        for name in filenames:
            path = current / name
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise RuntimeError(f"non-regular staged/final path: {path}")
            relative = path.relative_to(root)
            if not is_noise(relative):
                inventory[relative] = path
    return inventory


def finalize(
    archive: Path,
    staging: Path,
    *,
    sample_files: int,
    stable_age_seconds: float,
    dry_run: bool,
) -> dict[str, object]:
    archive = archive.resolve()
    staging = staging.resolve()
    output_root = archive_output_root(archive)
    before = archive.stat()
    expected_identity = archive_identity(before)
    verify_archive_stable(archive, before, stable_age_seconds)
    if not staging.is_dir():
        raise RuntimeError(f"staging directory does not exist: {staging}")

    zip_handle, expected = expected_inventory(archive)
    try:
        final = actual_inventory(output_root)
        staged = actual_inventory(staging)
        overlap = set(final) & set(staged)
        if overlap:
            raise RuntimeError(f"target/staging path overlap: {min(overlap, key=str)}")
        actual = {**final, **staged}
        if set(actual) != set(expected):
            missing = sorted(set(expected) - set(actual), key=lambda p: os.fsencode(str(p)))
            extra = sorted(set(actual) - set(expected), key=lambda p: os.fsencode(str(p)))
            raise RuntimeError(
                "incomplete staging inventory: "
                f"expected={len(expected)}, actual={len(actual)}, "
                f"missing={len(missing)}, extra={len(extra)}"
            )
        for relative, path in actual.items():
            size = path.stat().st_size
            if size != expected[relative].file_size:
                raise RuntimeError(
                    f"size mismatch for {relative}: expected {expected[relative].file_size}, got {size}"
                )

        ordered = sorted(expected, key=lambda p: os.fsencode(p.as_posix()))
        sampled = [ordered[index] for index in distributed_sample_indexes(len(ordered), sample_files)]
        for relative in sampled:
            with zip_handle.open(expected[relative]) as source:
                archive_digest = digest_stream(source)
            if digest_file(actual[relative]) != archive_digest:
                raise RuntimeError(f"pre-publish sample mismatch: {relative}")
        verify_archive_identity(archive, expected_identity)

        event: dict[str, object] = {
            "status": "validated" if dry_run else "complete",
            "archive": str(archive),
            "staging": str(staging),
            "output_root": str(output_root),
            "files": len(expected),
            "bytes": sum(info.file_size for info in expected.values()),
            "sample_files": len(sampled),
            "sampled_relative_paths": [path.as_posix() for path in sampled],
            "archive_deleted": False,
            "finished_at": utc_now(),
        }
        if dry_run:
            return event

        output_root.mkdir(parents=True, exist_ok=True)
        for relative, source in sorted(staged.items(), key=lambda item: os.fsencode(item[0].as_posix())):
            destination = output_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise RuntimeError(f"destination appeared during publish: {destination}")
            os.link(source, destination)
            os.unlink(source)

        # Flush the hard-linked extracted data and directory updates once as a
        # batch. This is much faster than fsyncing tens of thousands of files.
        os.sync()
        final = actual_inventory(output_root)
        if set(final) != set(expected):
            raise RuntimeError(
                f"post-publish inventory mismatch: expected={len(expected)}, actual={len(final)}"
            )
        for relative in sampled:
            with zip_handle.open(expected[relative]) as source:
                archive_digest = digest_stream(source)
            if digest_file(final[relative]) != archive_digest:
                raise RuntimeError(f"post-publish sample mismatch: {relative}")
        verify_archive_identity(archive, expected_identity)
        shutil.rmtree(staging)
        fsync_directory(archive.parent)
        verify_archive_identity(archive, expected_identity)
        archive.unlink()
        fsync_directory(archive.parent)
        event["archive_deleted"] = True
        return event
    finally:
        zip_handle.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--sample-files", type=int, default=DEFAULT_SAMPLE_FILES)
    parser.add_argument("--stable-age-seconds", type=float, default=600.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.sample_files < 1:
        parser.error("--sample-files must be at least 1")
    if args.stable_age_seconds < 0:
        parser.error("--stable-age-seconds must be non-negative")
    args.run_dir.mkdir(parents=True, exist_ok=True)
    try:
        event = finalize(
            args.archive,
            args.staging,
            sample_files=args.sample_files,
            stable_age_seconds=args.stable_age_seconds,
            dry_run=args.dry_run,
        )
        exit_code = 0
    except Exception as error:
        event = {
            "status": "failed",
            "archive": str(args.archive),
            "staging": str(args.staging),
            "error": f"{type(error).__name__}: {error}",
            "archive_deleted": False,
            "finished_at": utc_now(),
        }
        exit_code = 1
    summary = args.run_dir / "summary.json"
    summary.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(event, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
