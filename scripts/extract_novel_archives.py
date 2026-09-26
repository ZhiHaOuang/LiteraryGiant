#!/usr/bin/env python3
"""Safely extract completed novel archives and remove verified originals.

Extraction always happens in an empty sibling staging directory.  Files are
then published without overwriting existing paths and only then is the source
archive unlinked.  Full verification hashes every final file; the optional
sample mode verifies the complete file metadata inventory and hashes a stable,
distributed sample.  This script is deliberately separate from the TXT
organizer: extracting changes the source snapshot, so it must run before a move
plan is created.
"""

from __future__ import annotations

import argparse
import binascii
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


ARCHIVE_SUFFIXES = (".zip", ".rar", ".7z", ".tar", ".tar.gz", ".tgz")
NOISE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
DEFAULT_STABLE_AGE_SECONDS = 600.0
DEFAULT_SAMPLE_FILES = 32
VERIFY_MODES = ("full", "sample")
_JOURNAL_LOCK = threading.Lock()


class BsdtarFailure(RuntimeError):
    """A non-zero bsdtar result with structured audit details."""

    def __init__(self, phase: str, returncode: int, stderr: str) -> None:
        self.phase = phase
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(stderr or f"bsdtar {phase} failed with return code {returncode}")


@dataclass(frozen=True, slots=True)
class ZipFallbackMember:
    index: int
    canonical_name: str
    is_dir: bool
    file_size: int
    compressed_size: int
    crc32: int
    flag_bits: int
    compress_type: int
    header_offset: int

    @property
    def relative_path(self) -> Path:
        return Path(*PurePosixPath(self.canonical_name.rstrip("/")).parts)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def archive_stem(path: Path) -> str:
    lowered = path.name.lower()
    for suffix in sorted(ARCHIVE_SUFFIXES, key=len, reverse=True):
        if lowered.endswith(suffix):
            return path.name[: -len(suffix)]
    return path.stem


def archive_output_root(path: Path) -> Path:
    """Return the sibling directory which replaces an extracted archive."""

    stem = archive_stem(path)
    if not stem or stem in {".", ".."}:
        raise RuntimeError(f"archive has no safe output directory name: {path}")
    return path.parent / stem


def archive_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def verify_archive_identity(path: Path, expected: tuple[int, int, int, int, int]) -> None:
    current = path.stat()
    if not stat.S_ISREG(current.st_mode):
        raise RuntimeError(f"archive is no longer a regular file: {path}")
    if archive_identity(current) != expected:
        raise RuntimeError(f"archive changed during validation/extraction: {path}")


def verify_archive_stable(path: Path, value: os.stat_result, stable_age_seconds: float) -> None:
    minimum_age_ns = int(max(0.0, stable_age_seconds) * 1_000_000_000)
    age_ns = time.time_ns() - value.st_mtime_ns
    if age_ns < minimum_age_ns:
        age_seconds = max(0.0, age_ns / 1_000_000_000)
        raise RuntimeError(
            f"archive is too recent ({age_seconds:.1f}s old, "
            f"requires {stable_age_seconds:.1f}s): {path}"
        )


def discover_archives(roots: Iterable[Path]) -> list[Path]:
    archives: list[Path] = []
    for root in roots:
        if not root.is_dir():
            raise FileNotFoundError(f"source root does not exist: {root}")
        for directory, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(name for name in dirnames if not name.startswith(".extract-"))
            for name in sorted(filenames):
                lowered = name.lower()
                if any(lowered.endswith(suffix) for suffix in ARCHIVE_SUFFIXES):
                    archives.append(Path(directory) / name)
    return sorted(archives, key=lambda item: os.fsencode(str(item)))


def select_archives(roots: Iterable[Path], explicit: Iterable[Path]) -> list[Path]:
    selected = discover_archives(roots)
    for path in explicit:
        resolved = path.expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"archive does not exist: {resolved}")
        lowered = resolved.name.lower()
        if not any(lowered.endswith(suffix) for suffix in ARCHIVE_SUFFIXES):
            raise ValueError(f"unsupported archive suffix: {resolved}")
        selected.append(resolved)
    unique = {str(path.resolve()): path.resolve() for path in selected}
    return sorted(unique.values(), key=lambda item: os.fsencode(str(item)))


def canonical_member_name(member: str, archive: Path, *, is_dir: bool = False) -> str:
    """Normalize one archive name and reject paths outside a private staging tree."""

    normalized = unicodedata.normalize("NFC", member.replace("\\", "/"))
    if (
        not normalized
        or "\x00" in normalized
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:/", normalized)
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise RuntimeError(f"unsafe archive member in {archive}: {member!r}")
    parts = PurePosixPath(normalized).parts
    if ".." in parts:
        raise RuntimeError(f"unsafe archive member in {archive}: {member!r}")
    canonical = "/".join(parts)
    if canonical in {"", "."}:
        raise RuntimeError(f"unsafe archive member in {archive}: {member!r}")
    return canonical + ("/" if is_dir else "")


def validate_unique_member_names(members: Iterable[str], archive: Path) -> list[str]:
    normalized_members: set[str] = set()
    normalized: list[str] = []
    file_paths: set[str] = set()
    for member in members:
        canonical = canonical_member_name(
            member,
            archive,
            is_dir=member.replace("\\", "/").endswith("/"),
        )
        collision_key = canonical.rstrip("/")
        if collision_key in normalized_members:
            raise RuntimeError(
                f"duplicate normalized archive member in {archive}: {collision_key!r}"
            )
        normalized_members.add(collision_key)
        if not canonical.endswith("/"):
            file_paths.add(collision_key)
        normalized.append(canonical)

    # Reject a file used as the parent directory of a second member.  Waiting
    # for extraction to discover this would make behaviour depend on order.
    for canonical in normalized:
        parts = PurePosixPath(canonical.rstrip("/")).parts
        for length in range(1, len(parts)):
            prefix = "/".join(parts[:length])
            if prefix in file_paths:
                raise RuntimeError(
                    f"archive member traverses through file {prefix!r} in {archive}"
                )
    return normalized


def list_members(archive: Path, bsdtar: str) -> list[str]:
    result = subprocess.run(
        [bsdtar, "-tf", str(archive)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise BsdtarFailure(
            "list",
            result.returncode,
            result.stderr.decode("utf-8", "replace").strip(),
        )
    output = result.stdout.decode("utf-8", "surrogateescape")
    return validate_unique_member_names(output.splitlines(), archive)


def decode_zip_member_name(info: zipfile.ZipInfo, archive: Path) -> tuple[str, bool]:
    """Decode a ZIP central-directory name without trusting mojibake.

    Python exposes legacy, non-UTF-8 ZIP names through a CP437 decoding.  A
    strict CP437 round trip recovers the original bytes; this corpus uses the
    common Chinese GB18030 convention for those bytes.  Undecodable names are
    rejected instead of published under a guessed filename.
    """

    original = info.orig_filename
    if "\x00" in original:
        raise RuntimeError(f"ZIP member contains NUL in {archive}: {original!r}")
    recoded = False
    if info.flag_bits & 0x800:
        decoded = original
    else:
        try:
            raw_name = original.encode("cp437", errors="strict")
            decoded = raw_name.decode("gb18030", errors="strict")
        except (UnicodeEncodeError, UnicodeDecodeError) as exc:
            raise RuntimeError(
                f"cannot strictly decode legacy ZIP member name in {archive}: "
                f"{original!r}"
            ) from exc
        recoded = any(byte >= 0x80 for byte in raw_name) and decoded != original
    is_dir = info.is_dir() or decoded.replace("\\", "/").endswith("/")
    return canonical_member_name(decoded, archive, is_dir=is_dir), recoded


def inspect_zip_fallback(
    archive: Path,
) -> tuple[list[str], list[ZipFallbackMember], dict[str, Any]]:
    """Strictly inspect all ZIP entries before creating a staging directory."""

    try:
        with zipfile.ZipFile(archive, "r") as handle:
            infos = handle.infolist()
    except (OSError, zipfile.BadZipFile, NotImplementedError) as exc:
        raise RuntimeError(f"Python ZIP fallback cannot list {archive}: {exc}") from exc

    members: list[ZipFallbackMember] = []
    names: list[str] = []
    recoded_names = 0
    for index, info in enumerate(infos):
        canonical, recoded = decode_zip_member_name(info, archive)
        recoded_names += int(recoded)
        is_dir = canonical.endswith("/")
        if info.flag_bits & 0x1:
            raise RuntimeError(f"encrypted ZIP member is unsupported in {archive}: {canonical}")
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(unix_mode)
        if is_dir:
            if file_type not in {0, stat.S_IFDIR}:
                raise RuntimeError(
                    f"ZIP directory has unsafe file type in {archive}: {canonical}"
                )
        elif file_type not in {0, stat.S_IFREG}:
            raise RuntimeError(
                f"ZIP member is not a regular file in {archive}: {canonical}"
            )
        if info.file_size < 0 or info.compress_size < 0:
            raise RuntimeError(f"ZIP member has invalid size in {archive}: {canonical}")
        names.append(canonical)
        members.append(
            ZipFallbackMember(
                index=index,
                canonical_name=canonical,
                is_dir=is_dir,
                file_size=info.file_size,
                compressed_size=info.compress_size,
                crc32=info.CRC & 0xFFFFFFFF,
                flag_bits=info.flag_bits,
                compress_type=info.compress_type,
                header_offset=info.header_offset,
            )
        )
    normalized_names = validate_unique_member_names(names, archive)
    if normalized_names != names:
        raise RuntimeError(f"ZIP member normalization was not stable in {archive}")
    inventory_digest = hashlib.sha256()
    for member in members:
        inventory_digest.update(member.canonical_name.encode("utf-8"))
        inventory_digest.update(b"\0")
        inventory_digest.update(str(member.file_size).encode("ascii"))
        inventory_digest.update(b"\0")
        inventory_digest.update(f"{member.crc32:08x}".encode("ascii"))
        inventory_digest.update(b"\n")
    return (
        names,
        members,
        {
            "zip_members_inspected": len(members),
            "zip_filename_recoded": recoded_names,
            "zip_inventory_sha256": inventory_digest.hexdigest(),
            "zip_uncompressed_bytes_listed": sum(
                member.file_size for member in members if not member.is_dir
            ),
            "zip_compressed_bytes_listed": sum(
                member.compressed_size for member in members if not member.is_dir
            ),
        },
    )


def _zip_member_matches(info: zipfile.ZipInfo, member: ZipFallbackMember) -> bool:
    return (
        info.file_size == member.file_size
        and info.compress_size == member.compressed_size
        and (info.CRC & 0xFFFFFFFF) == member.crc32
        and info.flag_bits == member.flag_bits
        and info.compress_type == member.compress_type
        and info.header_offset == member.header_offset
    )


def extract_zip_fallback(
    archive: Path,
    staging: Path,
    members: list[ZipFallbackMember],
    *,
    workers: int,
) -> dict[str, int]:
    """Extract a prevalidated ZIP inventory with per-file CRC verification."""

    if workers < 1:
        raise ValueError("ZIP fallback workers must be at least 1")
    if any(staging.iterdir()):
        raise RuntimeError(f"ZIP fallback staging is not empty: {staging}")

    for member in members:
        destination = staging / member.relative_path
        if member.is_dir:
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)

    files = [member for member in members if not member.is_dir]
    if not files:
        return {
            "zip_crc_files_verified": 0,
            "zip_crc_bytes_verified": 0,
            "zip_fallback_workers": 0,
        }
    worker_count = min(workers, len(files))
    buckets: list[list[ZipFallbackMember]] = [[] for _ in range(worker_count)]
    bucket_sizes = [0] * worker_count
    for member in sorted(files, key=lambda item: (-item.file_size, item.index)):
        selected = min(range(worker_count), key=lambda index: (bucket_sizes[index], index))
        buckets[selected].append(member)
        bucket_sizes[selected] += member.file_size

    def extract_bucket(bucket: list[ZipFallbackMember]) -> tuple[int, int]:
        verified_files = verified_bytes = 0
        with zipfile.ZipFile(archive, "r") as handle:
            infos = handle.infolist()
            for member in sorted(bucket, key=lambda item: item.index):
                if member.index >= len(infos):
                    raise RuntimeError(
                        f"ZIP inventory changed before extraction: {archive}"
                    )
                info = infos[member.index]
                canonical, _ = decode_zip_member_name(info, archive)
                if canonical != member.canonical_name or not _zip_member_matches(info, member):
                    raise RuntimeError(
                        f"ZIP central directory changed before extraction: "
                        f"{member.canonical_name}"
                    )
                destination = staging / member.relative_path
                crc = 0
                size = 0
                try:
                    with handle.open(info, "r") as source, destination.open("xb") as target:
                        while chunk := source.read(8 * 1024 * 1024):
                            target.write(chunk)
                            size += len(chunk)
                            crc = binascii.crc32(chunk, crc)
                        target.flush()
                    crc &= 0xFFFFFFFF
                    if size != member.file_size or crc != member.crc32:
                        raise RuntimeError(
                            f"ZIP CRC/size mismatch for {member.canonical_name}: "
                            f"size={size}/{member.file_size}, crc={crc:08x}/{member.crc32:08x}"
                        )
                except BaseException:
                    destination.unlink(missing_ok=True)
                    raise
                verified_files += 1
                verified_bytes += size
        return verified_files, verified_bytes

    with ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="zip-crc-extract",
    ) as executor:
        results = list(executor.map(extract_bucket, buckets))
    return {
        "zip_crc_files_verified": sum(item[0] for item in results),
        "zip_crc_bytes_verified": sum(item[1] for item in results),
        "zip_fallback_workers": worker_count,
    }


def list_members_with_zip_fallback(
    archive: Path,
    bsdtar: str,
) -> tuple[list[str], list[ZipFallbackMember] | None, dict[str, Any]]:
    try:
        return list_members(archive, bsdtar), None, {"extractor": "bsdtar"}
    except BsdtarFailure as error:
        if archive.suffix.lower() != ".zip":
            raise
        names, inventory, zip_audit = inspect_zip_fallback(archive)
        return (
            names,
            inventory,
            {
                "extractor": "python_zip_fallback",
                "zip_fallback_reason": "bsdtar_list_failed",
                "bsdtar_list_returncode": error.returncode,
                "bsdtar_list_stderr": error.stderr,
                **zip_audit,
            },
        )


def append_journal(path: Path, event: dict[str, Any]) -> None:
    # A single append is serialized across archive workers so JSONL records
    # cannot interleave. Each event is flushed and fsynced before the lock is
    # released.
    with _JOURNAL_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def extracted_files(staging: Path) -> list[Path]:
    files: list[Path] = []
    for directory, dirnames, filenames in os.walk(staging, followlinks=False):
        current = Path(directory)
        safe_dirs: list[str] = []
        for name in sorted(dirnames):
            candidate = current / name
            mode = candidate.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise RuntimeError(f"archive contains a symlink: {candidate}")
            if not stat.S_ISDIR(mode):
                raise RuntimeError(f"archive contains a non-directory entry: {candidate}")
            safe_dirs.append(name)
        dirnames[:] = safe_dirs
        for name in sorted(filenames):
            candidate = current / name
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise RuntimeError(f"archive contains a non-regular file: {candidate}")
            files.append(candidate)
    return files


def content_root(staging: Path, archive: Path) -> tuple[Path, bool]:
    visible = sorted(
        (
            item
            for item in staging.iterdir()
            if item.name != "__MACOSX" and item.name not in NOISE_NAMES
        ),
        key=lambda item: os.fsencode(item.name),
    )
    if (
        len(visible) == 1
        and visible[0].is_dir()
        and visible[0].name == archive_stem(archive)
    ):
        return visible[0], True
    return staging, False


def is_noise(relative: Path) -> bool:
    return any(part == "__MACOSX" for part in relative.parts) or relative.name in NOISE_NAMES


def validate_member_inventory(members: Iterable[str], archive: Path) -> int:
    candidates = 0
    for member in members:
        normalized = member.replace("\\", "/")
        if normalized.endswith("/"):
            continue
        relative = Path(*PurePosixPath(normalized).parts)
        if not is_noise(relative):
            candidates += 1
    if not candidates:
        raise RuntimeError(f"archive contains no non-noise member candidates: {archive}")
    return candidates


def apply_explicit_member_skips(
    members: list[str],
    requested: Iterable[str],
    archive: Path,
) -> tuple[list[str], tuple[str, ...]]:
    """Resolve exact, user-authorized corrupt members against one inventory."""

    normalized: list[str] = []
    for value in requested:
        canonical = canonical_member_name(str(value), archive, is_dir=False)
        if canonical.endswith("/"):
            raise RuntimeError(f"cannot skip a ZIP/archive directory: {canonical}")
        relative = Path(*PurePosixPath(canonical).parts)
        if is_noise(relative):
            raise RuntimeError(f"refusing unnecessary skip of noise member: {canonical}")
        if canonical in normalized:
            raise RuntimeError(f"duplicate --skip-member authorization: {canonical}")
        normalized.append(canonical)
    if not normalized:
        return list(members), ()

    inventory_counts = {member: members.count(member) for member in normalized}
    invalid = {
        member: count for member, count in inventory_counts.items() if count != 1
    }
    if invalid:
        raise RuntimeError(
            f"explicit skipped member must exist exactly once in {archive}: {invalid}"
        )
    skipped = tuple(sorted(normalized, key=os.fsencode))
    skipped_set = set(skipped)
    filtered = [member for member in members if member not in skipped_set]
    validate_member_inventory(filtered, archive)
    return filtered, skipped


def expected_extracted_paths(
    members: Iterable[str],
    archive: Path,
    *,
    flattened_wrapper: bool,
) -> set[str]:
    expected: set[str] = set()
    wrapper = archive_stem(archive)
    for member in members:
        if member.endswith("/"):
            continue
        relative = Path(*PurePosixPath(member).parts)
        if is_noise(relative):
            continue
        parts = relative.parts
        if flattened_wrapper and parts and parts[0] == wrapper:
            parts = parts[1:]
        if not parts:
            raise RuntimeError(f"archive member has no publishable relative path: {member}")
        expected.add(Path(*parts).as_posix())
    return expected


def conflict_destination(destination: Path, archive: Path, digest: str) -> Path:
    label = re.sub(r"[^0-9A-Za-z._\-\u3400-\u9fff]+", "_", archive_stem(archive)).strip("._")
    label = label[:48] or "archive"
    return destination.with_name(
        f"{destination.stem}.archive-{label}-{digest[:12]}{destination.suffix}"
    )


def distributed_sample_indexes(total: int, limit: int) -> tuple[int, ...]:
    """Return stable indexes spread across an already sorted inventory."""

    if total < 0:
        raise ValueError("total must be non-negative")
    if limit < 1:
        raise ValueError("sample limit must be at least 1")
    if total <= limit:
        return tuple(range(total))
    if limit == 1:
        return (total // 2,)
    # Integer arithmetic makes the selection independent of floating-point
    # rounding and includes both ends of the sorted inventory.
    return tuple(index * (total - 1) // (limit - 1) for index in range(limit))


def publish_file(
    source: Path,
    destination: Path,
    archive: Path,
    *,
    calculate_digest: bool = True,
    verify_after_publish: bool = True,
) -> tuple[Path, str, str | None]:
    digest = sha256_file(source) if calculate_digest else None
    destination.parent.mkdir(parents=True, exist_ok=True)
    selected = destination
    state = "written"
    if selected.exists():
        if not selected.is_file():
            raise RuntimeError(f"destination exists and is not a file: {selected}")
        if digest is None:
            digest = sha256_file(source)
        if sha256_file(selected) == digest:
            return selected, "identical", digest
        assert digest is not None
        selected = conflict_destination(destination, archive, digest)
        state = "conflict_renamed"
        if selected.exists():
            if selected.is_file() and sha256_file(selected) == digest:
                return selected, "identical_conflict", digest
            raise RuntimeError(f"deterministic conflict destination is occupied: {selected}")

    # Hard-linking inside one filesystem provides an exclusive, non-overwriting
    # publish operation.  Removing the staging name afterwards leaves an
    # independent normal file at the destination.
    os.link(source, selected)
    os.unlink(source)
    with selected.open("rb") as handle:
        os.fsync(handle.fileno())
    fsync_directory(selected.parent)
    if verify_after_publish and (digest is None or sha256_file(selected) != digest):
        raise RuntimeError(f"post-publish hash mismatch: {selected}")
    return selected, state, digest


def extract_one(
    archive: Path,
    bsdtar: str,
    journal: Path,
    *,
    stable_age_seconds: float = DEFAULT_STABLE_AGE_SECONDS,
    verify_mode: str = "full",
    sample_files: int = DEFAULT_SAMPLE_FILES,
    workers: int = 1,
    skip_members: Iterable[str] = (),
) -> dict[str, Any]:
    if verify_mode not in VERIFY_MODES:
        raise ValueError(f"unsupported verify mode: {verify_mode!r}")
    if sample_files < 1:
        raise ValueError("sample_files must be at least 1")
    if workers < 1:
        raise ValueError("workers must be at least 1")
    requested_skip_members = tuple(str(value) for value in skip_members)
    archive = archive.resolve()
    before = archive.stat()
    expected_identity = archive_identity(before)
    staging: Path | None = None
    event: dict[str, Any] = {
        "event": "archive_extract",
        "archive": str(archive),
        "archive_bytes": before.st_size,
        "archive_identity": {
            "device": before.st_dev,
            "inode": before.st_ino,
            "size": before.st_size,
            "mtime_ns": before.st_mtime_ns,
            "ctime_ns": before.st_ctime_ns,
        },
        "stable_age_seconds": stable_age_seconds,
        "verify_mode": verify_mode,
        "sample_files_requested": sample_files if verify_mode == "sample" else 0,
        "workers": workers,
        "requested_skip_members": list(requested_skip_members),
        "started_at": utc_now(),
        "status": "running",
    }
    append_journal(journal, event)
    try:
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError(f"archive is not a regular file: {archive}")
        verify_archive_stable(archive, before, stable_age_seconds)
        listed_members, zip_inventory, listing_audit = list_members_with_zip_fallback(
            archive,
            bsdtar,
        )
        event.update(listing_audit)
        event["members"] = len(listed_members)
        event["member_candidates_before_skip"] = validate_member_inventory(
            listed_members,
            archive,
        )
        members, skipped_corrupt_members = apply_explicit_member_skips(
            listed_members,
            requested_skip_members,
            archive,
        )
        event["member_candidates"] = validate_member_inventory(members, archive)
        event["skipped_corrupt_members"] = list(skipped_corrupt_members)
        event["skipped_corrupt_member_count"] = len(skipped_corrupt_members)
        if zip_inventory is not None and skipped_corrupt_members:
            skipped_set = set(skipped_corrupt_members)
            zip_inventory = [
                member
                for member in zip_inventory
                if member.canonical_name not in skipped_set
            ]
        verify_archive_identity(archive, expected_identity)

        staging = archive.parent / f".extract-{archive.name}-{uuid.uuid4().hex}"
        staging.mkdir(mode=0o700)
        if zip_inventory is not None:
            event.update(
                extract_zip_fallback(
                    archive,
                    staging,
                    zip_inventory,
                    workers=workers,
                )
            )
        else:
            result = subprocess.run(
                [
                    bsdtar,
                    "-xf",
                    str(archive),
                    "-C",
                    str(staging),
                    "--no-same-owner",
                    "--no-same-permissions",
                    *(
                        option
                        for member in skipped_corrupt_members
                        for option in ("--exclude", member)
                    ),
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if result.returncode:
                stderr = result.stderr.decode("utf-8", "replace").strip()
                if archive.suffix.lower() != ".zip":
                    raise BsdtarFailure("extract", result.returncode, stderr)
                # Never let the fallback consume or publish a partial libarchive
                # extraction.  It receives a fresh, independently named staging
                # directory after the old one is durably removed.
                shutil.rmtree(staging)
                fsync_directory(archive.parent)
                staging = None
                fallback_listed, zip_inventory, zip_audit = inspect_zip_fallback(archive)
                members, fallback_skipped = apply_explicit_member_skips(
                    fallback_listed,
                    skipped_corrupt_members,
                    archive,
                )
                if fallback_skipped != skipped_corrupt_members:
                    raise RuntimeError(
                        "bsdtar/Python ZIP skipped member inventory mismatch"
                    )
                skipped_set = set(skipped_corrupt_members)
                zip_inventory = [
                    member
                    for member in zip_inventory
                    if member.canonical_name not in skipped_set
                ]
                member_candidates = validate_member_inventory(members, archive)
                if member_candidates != event["member_candidates"]:
                    raise RuntimeError(
                        "bsdtar/Python ZIP member inventory mismatch: "
                        f"{event['member_candidates']} != {member_candidates}"
                    )
                event.update(
                    extractor="python_zip_fallback",
                    zip_fallback_reason="bsdtar_extract_failed",
                    bsdtar_extract_returncode=result.returncode,
                    bsdtar_extract_stderr=stderr,
                    **zip_audit,
                )
                staging = archive.parent / f".extract-{archive.name}-{uuid.uuid4().hex}"
                staging.mkdir(mode=0o700)
                event.update(
                    extract_zip_fallback(
                        archive,
                        staging,
                        zip_inventory,
                        workers=workers,
                    )
                )
            else:
                event.update(
                    zip_crc_files_verified=0,
                    zip_crc_bytes_verified=0,
                    zip_fallback_workers=0,
                )

        # Do not publish data extracted from a source which changed while
        # libarchive was reading it.
        verify_archive_identity(archive, expected_identity)
        files = extracted_files(staging)
        root, flattened = content_root(staging, archive)
        output_root = archive_output_root(archive)
        summary: dict[str, Any] = {
            "written": 0,
            "identical": 0,
            "identical_conflict": 0,
            "conflict_renamed": 0,
            "noise_skipped": 0,
            "valid_files": 0,
            "txt_files": 0,
            "published_bytes": 0,
            "metadata_files_verified": 0,
            "metadata_bytes_verified": 0,
            "content_files_verified": 0,
        }
        candidates: list[tuple[Path, Path]] = []
        for source in files:
            relative = (
                source.relative_to(root)
                if source.is_relative_to(root)
                else source.relative_to(staging)
            )
            if is_noise(relative):
                summary["noise_skipped"] += 1
                continue
            candidates.append((source, relative))
        candidates.sort(key=lambda item: os.fsencode(item[1].as_posix()))
        summary["valid_files"] = len(candidates)
        if not candidates:
            raise RuntimeError(f"archive contains no non-noise regular files: {archive}")
        if skipped_corrupt_members:
            actual_paths = {relative.as_posix() for _, relative in candidates}
            expected_paths = expected_extracted_paths(
                members,
                archive,
                flattened_wrapper=flattened,
            )
            if actual_paths != expected_paths:
                raise RuntimeError(
                    "explicit skip extracted inventory mismatch: "
                    f"missing={sorted(expected_paths - actual_paths)}, "
                    f"unexpected={sorted(actual_paths - expected_paths)}"
                )
        if verify_mode == "sample" and len(candidates) != event["member_candidates"]:
            raise RuntimeError(
                "sample verification member count mismatch: "
                f"listed={event['member_candidates']}, extracted={len(candidates)}"
            )

        sample_indexes = (
            set(distributed_sample_indexes(len(candidates), sample_files))
            if verify_mode == "sample"
            else set()
        )
        sampled_relative_paths = [
            relative.as_posix()
            for index, (_, relative) in enumerate(candidates)
            if index in sample_indexes
        ]

        published: list[tuple[Path, int, str | None, bool]] = []
        for index, (source, relative) in enumerate(candidates):
            source_size = source.stat().st_size
            is_sampled = index in sample_indexes
            destination = output_root / relative
            final_path, state, digest = publish_file(
                source,
                destination,
                archive,
                calculate_digest=verify_mode == "full" or is_sampled,
                verify_after_publish=verify_mode == "full",
            )
            summary[state] += 1
            summary["published_bytes"] += source_size
            if final_path.suffix.lower() == ".txt":
                summary["txt_files"] += 1
            published.append((final_path, source_size, digest, is_sampled))

        if verify_mode == "full":
            # Preserve the original full mode: every published file is hashed
            # again immediately before the destructive archive unlink.
            for final_path, expected_size, expected_digest, _ in published:
                if not final_path.is_file() or sha256_file(final_path) != expected_digest:
                    raise RuntimeError(f"final verification failed: {final_path}")
                summary["metadata_files_verified"] += 1
                summary["metadata_bytes_verified"] += expected_size
                summary["content_files_verified"] += 1
        else:
            # Sample mode still walks the complete published inventory.  It
            # requires every path to remain a regular file with exactly the
            # extracted size, then content-verifies a deterministic sample.
            for final_path, expected_size, expected_digest, is_sampled in published:
                final_stat = final_path.lstat()
                if not stat.S_ISREG(final_stat.st_mode):
                    raise RuntimeError(f"final path is not a regular file: {final_path}")
                if final_stat.st_size != expected_size:
                    raise RuntimeError(
                        "final verification size mismatch: "
                        f"{final_path} (expected {expected_size}, got {final_stat.st_size})"
                    )
                summary["metadata_files_verified"] += 1
                summary["metadata_bytes_verified"] += final_stat.st_size
                if is_sampled:
                    if expected_digest is None or sha256_file(final_path) != expected_digest:
                        raise RuntimeError(f"sample content verification failed: {final_path}")
                    summary["content_files_verified"] += 1
            summary["sampled_relative_paths"] = sampled_relative_paths
        verify_archive_identity(archive, expected_identity)

        # At this point every non-noise file has an independently verified
        # final path.  Remove the now-empty/noise-only staging tree before the
        # destructive archive unlink so a cleanup failure still retains the
        # source archive.
        shutil.rmtree(staging)
        staging = None
        fsync_directory(archive.parent)
        verify_archive_identity(archive, expected_identity)
        archive.unlink()
        fsync_directory(archive.parent)
        event.update(
            summary,
            status="complete",
            flattened_wrapper=flattened,
            output_root=str(output_root),
            staging_cleanup="removed",
            finished_at=utc_now(),
            archive_deleted=True,
        )
        append_journal(journal, event)
        return event
    except BaseException as error:
        cleanup = "not_created"
        cleanup_error: str | None = None
        if staging is not None and staging.exists():
            try:
                shutil.rmtree(staging)
                fsync_directory(archive.parent)
                cleanup = "removed_after_failure"
            except BaseException as staging_error:
                cleanup = "failed"
                cleanup_error = f"{type(staging_error).__name__}: {staging_error}"
        event.update(
            status="failed",
            finished_at=utc_now(),
            error=f"{type(error).__name__}: {error}",
            archive_deleted=False,
            staging_cleanup=cleanup,
        )
        if cleanup_error is not None:
            event["staging_cleanup_error"] = cleanup_error
        append_journal(journal, event)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[], help="Completed source root; repeatable")
    parser.add_argument(
        "--archive",
        action="append",
        default=[],
        help="One completed archive to process exactly; repeatable",
    )
    parser.add_argument("--run-dir", type=Path, required=True, help="Directory for JSONL journal/summary")
    parser.add_argument("--bsdtar", default=shutil.which("bsdtar") or "bsdtar")
    parser.add_argument(
        "--stable-age-seconds",
        type=float,
        default=DEFAULT_STABLE_AGE_SECONDS,
        help="Refuse archives modified more recently than this (default: 600)",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop after the first failed archive instead of reporting the rest",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help=(
            "Archives to extract concurrently and workers per Python ZIP fallback "
            "(default: 1; pass 7 on this host)"
        ),
    )
    parser.add_argument(
        "--verify-mode",
        choices=VERIFY_MODES,
        default="full",
        help="Final verification: hash every file or metadata plus a sample (default: full)",
    )
    parser.add_argument(
        "--sample-files",
        type=int,
        default=DEFAULT_SAMPLE_FILES,
        help="Files content-hashed per archive in sample mode (default: 32)",
    )
    parser.add_argument(
        "--skip-member",
        action="append",
        default=[],
        metavar="ARCHIVE::MEMBER",
        help=(
            "Explicitly exclude one known corrupt member from one exact archive; "
            "repeatable and disabled by default. The member must exist exactly once."
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="List and validate members without extracting")
    return parser


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with path.open("rb") as handle:
        os.fsync(handle.fileno())
    fsync_directory(path.parent)


def parse_skip_member_specs(
    values: Iterable[str],
    archives: Iterable[Path],
) -> dict[Path, tuple[str, ...]]:
    selected = {path.resolve() for path in archives}
    grouped: dict[Path, list[str]] = {}
    for value in values:
        archive_value, separator, member = str(value).partition("::")
        if not separator or not archive_value or not member:
            raise ValueError(
                "--skip-member must use the exact ARCHIVE::MEMBER form"
            )
        archive = Path(archive_value).expanduser().resolve()
        if archive not in selected:
            raise ValueError(
                f"--skip-member archive was not selected for this run: {archive}"
            )
        grouped.setdefault(archive, []).append(member)
    return {archive: tuple(members) for archive, members in grouped.items()}


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.source and not args.archive:
        parser.error("at least one --source or --archive is required")
    if args.stable_age_seconds < 0:
        parser.error("--stable-age-seconds must be non-negative")
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.sample_files < 1:
        parser.error("--sample-files must be at least 1")
    if args.fail_fast and args.workers > 1:
        parser.error("--fail-fast cannot be combined with --workers greater than 1")
    roots = [Path(value).expanduser().resolve() for value in args.source]
    explicit = [Path(value) for value in args.archive]
    archives = select_archives(roots, explicit)
    try:
        skip_members_by_archive = parse_skip_member_specs(args.skip_member, archives)
    except ValueError as error:
        parser.error(str(error))
    args.run_dir.mkdir(parents=True, exist_ok=True)
    if args.dry_run:
        payload: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []

        def validate_path(path: Path) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
            try:
                before = path.stat()
                expected_identity = archive_identity(before)
                verify_archive_stable(path, before, args.stable_age_seconds)
                listed_members, _, listing_audit = list_members_with_zip_fallback(
                    path,
                    args.bsdtar,
                )
                members, skipped = apply_explicit_member_skips(
                    listed_members,
                    skip_members_by_archive.get(path.resolve(), ()),
                    path,
                )
                member_candidates = validate_member_inventory(members, path)
                verify_archive_identity(path, expected_identity)
                return (
                    {
                        "archive": str(path),
                        "bytes": before.st_size,
                        "members": len(members),
                        "member_candidates": member_candidates,
                        "member_candidates_before_skip": validate_member_inventory(
                            listed_members,
                            path,
                        ),
                        "skipped_corrupt_members": list(skipped),
                        "skipped_corrupt_member_count": len(skipped),
                        "output_root": str(archive_output_root(path)),
                        "status": "validated",
                        **listing_audit,
                    },
                    None,
                )
            except Exception as error:
                return (
                    None,
                    {
                        "archive": str(path),
                        "requested_skip_members": list(
                            skip_members_by_archive.get(path.resolve(), ())
                        ),
                        "error": f"{type(error).__name__}: {error}",
                    },
                )

        if args.workers == 1:
            validation_results = []
            for path in archives:
                outcome = validate_path(path)
                validation_results.append(outcome)
                if args.fail_fast and outcome[1] is not None:
                    break
        else:
            with ThreadPoolExecutor(
                max_workers=args.workers,
                thread_name_prefix="archive-validate",
            ) as executor:
                # Executor.map preserves the already deterministic archive
                # path order even though validation completes concurrently.
                validation_results = list(executor.map(validate_path, archives))

        for validated, failure in validation_results:
            if validated is not None:
                payload.append(validated)
            if failure is not None:
                failures.append(failure)
        dry_summary: dict[str, Any] = {
            "status": "complete" if not failures else ("partial" if payload else "failed"),
            "mode": "dry_run",
            "workers": args.workers,
            "verify_mode": args.verify_mode,
            "finished_at": utc_now(),
            "archives_discovered": len(archives),
            "archives_validated": len(payload),
            "archives_failed": len(failures),
            "skipped_corrupt_member_count": sum(
                int(item.get("skipped_corrupt_member_count") or 0)
                for item in payload
            ),
            "archives": payload,
            "failures": failures,
        }
        write_summary(args.run_dir / "dry_run_summary.json", dry_summary)
        print(json.dumps(dry_summary, ensure_ascii=False, indent=2))
        return 1 if failures else 0

    journal = args.run_dir / "journal.jsonl"
    results: list[dict[str, Any]] = []
    failures = []
    archive_results: list[dict[str, Any]] = []

    def extract_path(path: Path) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        try:
            return (
                extract_one(
                    path,
                    args.bsdtar,
                    journal,
                    stable_age_seconds=args.stable_age_seconds,
                    verify_mode=args.verify_mode,
                    sample_files=args.sample_files,
                    workers=args.workers,
                    skip_members=skip_members_by_archive.get(path.resolve(), ()),
                ),
                None,
            )
        except Exception as error:
            return (
                None,
                {
                    "archive": str(path),
                    "requested_skip_members": list(
                        skip_members_by_archive.get(path.resolve(), ())
                    ),
                    "error": f"{type(error).__name__}: {error}",
                },
            )

    if args.workers == 1:
        extraction_results = []
        for path in archives:
            outcome = extract_path(path)
            extraction_results.append(outcome)
            if args.fail_fast and outcome[1] is not None:
                break
    else:
        with ThreadPoolExecutor(
            max_workers=args.workers,
            thread_name_prefix="archive-extract",
        ) as executor:
            # Result order remains path-stable; journal event order records
            # actual concurrent progress and is protected by _JOURNAL_LOCK.
            extraction_results = list(executor.map(extract_path, archives))

    for extracted, failure in extraction_results:
        if extracted is not None:
            results.append(extracted)
            archive_results.append(
                {
                    "archive": extracted["archive"],
                    "status": "complete",
                    "output_root": extracted["output_root"],
                    "archive_deleted": bool(extracted["archive_deleted"]),
                    "extractor": str(extracted.get("extractor") or "bsdtar"),
                    "zip_fallback_reason": str(
                        extracted.get("zip_fallback_reason") or ""
                    ),
                    "txt_files": int(extracted["txt_files"]),
                    "published_bytes": int(extracted["published_bytes"]),
                    "conflicts_renamed": int(extracted["conflict_renamed"]),
                    "metadata_files_verified": int(extracted["metadata_files_verified"]),
                    "content_files_verified": int(extracted["content_files_verified"]),
                    "zip_crc_files_verified": int(
                        extracted.get("zip_crc_files_verified") or 0
                    ),
                    "zip_crc_bytes_verified": int(
                        extracted.get("zip_crc_bytes_verified") or 0
                    ),
                    "zip_filename_recoded": int(
                        extracted.get("zip_filename_recoded") or 0
                    ),
                    "zip_inventory_sha256": str(
                        extracted.get("zip_inventory_sha256") or ""
                    ),
                    "skipped_corrupt_members": list(
                        extracted.get("skipped_corrupt_members") or []
                    ),
                    "skipped_corrupt_member_count": int(
                        extracted.get("skipped_corrupt_member_count") or 0
                    ),
                }
            )
        if failure is not None:
            failures.append(failure)
            archive_results.append({**failure, "status": "failed"})
    summary = {
        "status": "complete" if not failures else ("partial" if results else "failed"),
        "workers": args.workers,
        "verify_mode": args.verify_mode,
        "sample_files_requested": args.sample_files if args.verify_mode == "sample" else 0,
        "finished_at": utc_now(),
        "archives_discovered": len(archives),
        "archives_attempted": len(results) + len(failures),
        "archives_succeeded": len(results),
        "archives_failed": len(failures),
        "archives": len(results),
        "archives_deleted": sum(bool(item.get("archive_deleted")) for item in results),
        "txt_files": sum(int(item["txt_files"]) for item in results),
        "published_bytes": sum(int(item["published_bytes"]) for item in results),
        "conflicts_renamed": sum(int(item["conflict_renamed"]) for item in results),
        "metadata_files_verified": sum(int(item["metadata_files_verified"]) for item in results),
        "content_files_verified": sum(int(item["content_files_verified"]) for item in results),
        "zip_fallback_archives": sum(
            item.get("extractor") == "python_zip_fallback" for item in results
        ),
        "zip_crc_files_verified": sum(
            int(item.get("zip_crc_files_verified") or 0) for item in results
        ),
        "zip_crc_bytes_verified": sum(
            int(item.get("zip_crc_bytes_verified") or 0) for item in results
        ),
        "zip_filename_recoded": sum(
            int(item.get("zip_filename_recoded") or 0) for item in results
        ),
        "skipped_corrupt_member_count": sum(
            int(item.get("skipped_corrupt_member_count") or 0) for item in results
        ),
        "skipped_corrupt_members": [
            {
                "archive": str(item["archive"]),
                "members": list(item.get("skipped_corrupt_members") or []),
            }
            for item in results
            if item.get("skipped_corrupt_members")
        ],
        "identical": sum(int(item["identical"]) + int(item["identical_conflict"]) for item in results),
        "archive_results": archive_results,
        "failures": failures,
    }
    write_summary(args.run_dir / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
