"""Resumable organizer for large, messy local TXT novel collections.

This is intentionally separate from :class:`fetcher.registry.BookRegistry`.
The latter allocates the canonical ``Library/TaciturnRaw`` IDs and historically
deduplicates on title alone; neither behaviour is safe for an uncurated corpus.

The organizer has four explicit phases:

``scan`` -> ``plan`` -> ``apply`` -> ``verify``

Scanning and planning never mutate source files. Applying publishes selected
originals directly under ``Library/Noise/<genre>`` and writes one root-level
``index.jsonl``. Only successfully published canonical/edition versions enter
that public index; duplicate and rejected sources remain traceable in SQLite,
the immutable plan and audit artifacts without creating extra visible copies.
"""

from __future__ import annotations

import codecs
import errno
import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import stat as stat_module
import threading
import time
import unicodedata
import uuid
from concurrent.futures import (
    FIRST_COMPLETED,
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    wait,
)
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence

from .local_catalog import LocalNovelCatalog, utc_now
from .local_fingerprint import (
    FileFingerprint,
    FINGERPRINT_VERSION,
    READ_CHUNK_BYTES,
    compare_fingerprints,
    fingerprint_file,
    read_head_text,
)


logger = logging.getLogger(__name__)

# These codes are persisted in filenames and indexes.  Do not derive them from
# tuple position: adding or reordering a genre must never silently renumber an
# existing category.
CATEGORY_CODES: dict[str, str] = {
    "玄幻": "00",
    "奇幻": "01",
    "武侠": "02",
    "仙侠": "03",
    "都市": "04",
    "现实": "05",
    "言情": "06",
    "后宫": "07",
    "耽美": "08",
    "百合": "09",
    "历史": "10",
    "军事": "11",
    "科幻": "12",
    "悬疑": "13",
    "惊悚": "14",
    "游戏": "15",
    "体育": "16",
    "同人": "17",
    "二次元": "18",
    "轻小说": "19",
    "其他": "20",
    "露骨H": "21",
}
DEFAULT_CATEGORY = "其他"
DEFAULT_CATEGORY_CODE = CATEGORY_CODES[DEFAULT_CATEGORY]

try:  # Optional at runtime; declared as a lightweight project dependency.
    from pypinyin import lazy_pinyin as _lazy_pinyin
except ImportError:  # pragma: no cover - exercised in minimal environments
    _lazy_pinyin = None


# GB2312 level-one characters are arranged by pronunciation.  These boundary
# values provide a deterministic A-Z initial and a useful approximate order
# when pypinyin is not installed.  Rare/polyphonic characters fall back to a
# stable GB18030 byte key rather than making index order nondeterministic.
_GB2312_INITIAL_BOUNDARIES: tuple[tuple[int, str], ...] = (
    (-20319, "A"),
    (-20284, "B"),
    (-19776, "C"),
    (-19219, "D"),
    (-18711, "E"),
    (-18527, "F"),
    (-18240, "G"),
    (-17923, "H"),
    (-17418, "J"),
    (-16475, "K"),
    (-16213, "L"),
    (-15641, "M"),
    (-15166, "N"),
    (-14923, "O"),
    (-14915, "P"),
    (-14631, "Q"),
    (-14150, "R"),
    (-14091, "S"),
    (-13319, "T"),
    (-12839, "W"),
    (-12557, "X"),
    (-11848, "Y"),
    (-11056, "Z"),
)

DEFAULT_ARCHIVE_RELATIVE_PATH = Path("Library/Noise")
CATALOG_RELATIVE_PATH = Path(".state/catalog.sqlite3")
ACTIVE_TRANSFER_SUFFIXES = (
    ".raysync.uploading",
    ".uploading",
    ".part",
    ".partial",
    ".tmp",
    ".download",
    ".crdownload",
)
ARCHIVE_SUFFIXES = (".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz")
MAX_LITERAL_REPLACEMENT_RATE = 0.0002
QUALITY_POLICY_VERSION = "strict-literal-ufffd-v1"
_LOGICAL_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class SourceEntry:
    path: Path
    root: Path
    label: str
    relative_path: Path


@dataclass(frozen=True, slots=True)
class StrictSourceValidation:
    """One stable full-file strict-decode and fingerprint verification."""

    status: str
    error: str
    raw_sha256: str
    normalized_sha256: str
    non_whitespace_chars: int
    line_count: int
    literal_replacement_chars: int
    stat_token: tuple[int, int, int, int, int]

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["stat_token"] = list(self.stat_token)
        return payload


@dataclass(frozen=True, slots=True)
class DedupeThresholds:
    minimum_fuzzy_chars: int = 50_000
    same_edition_length_ratio: float = 0.97
    same_edition_containment: float = 0.96
    same_edition_jaccard: float = 0.90
    same_edition_order_ratio: float = 0.98
    same_work_length_ratio: float = 0.70
    same_work_containment: float = 0.92
    same_work_order_ratio: float = 0.95
    minimum_shared_anchors: int = 10
    review_containment: float = 0.65
    review_order_ratio: float = 0.85
    # A shorter edition is only an *incomplete candidate* when its sampled
    # content is an almost perfectly ordered subset of the longer edition.
    # These intentionally conservative thresholds are separate from ordinary
    # same-work matching: the default plan keeps both versions and merely
    # sends the pair to review.
    incomplete_min_length_ratio: float = 0.45
    incomplete_max_length_ratio: float = 0.80
    incomplete_containment: float = 0.99
    incomplete_order_ratio: float = 0.99
    incomplete_min_shared_anchors: int = 24


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    created_at: str
    roots: tuple[str, ...]
    txt_count: int
    txt_size_bytes: int
    archive_count: int
    archive_size_bytes: int
    active_transfer_markers: tuple[str, ...]
    metadata_sha256: str

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["roots"] = list(self.roots)
        payload["active_transfer_markers"] = list(self.active_transfer_markers)
        return payload


class _UnionFind:
    def __init__(self, values: Iterable[int]) -> None:
        self.parent = {value: value for value in values}
        self.rank = {value: 0 for value in self.parent}
        # Singleton ``set`` objects dominate memory for a mostly unique corpus.
        # Materialize member sets only after an actual union.
        self.members: dict[int, set[int]] = {}

    def find(self, value: int) -> int:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: int, right: int) -> bool:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return False
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        left_members = self.members.pop(left_root, {left_root})
        left_members.update(self.members.pop(right_root, {right_root}))
        self.members[left_root] = left_members
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1
        return True

    def group(self, value: int) -> set[int]:
        root = self.find(value)
        return self.members.get(root, {root})

    def groups(self) -> dict[int, list[int]]:
        groups: dict[int, list[int]] = {}
        for value in self.parent:
            groups.setdefault(self.find(value), []).append(value)
        return {root: sorted(values) for root, values in groups.items()}


def default_archive_root(project_root: str | Path) -> Path:
    """Return the isolated ``Library/Noise`` staging root."""

    return Path(project_root).resolve() / DEFAULT_ARCHIVE_RELATIVE_PATH


def _source_labels(roots: Sequence[Path]) -> dict[Path, str]:
    labels: dict[Path, str] = {}
    for root in roots:
        base = _safe_component(root.name or "root", fallback="root")
        # The label must remain unique even when roots are scanned in separate
        # invocations (two unrelated directories may both be named "txt").
        digest = hashlib.blake2s(str(root).encode("utf-8"), digest_size=6).hexdigest()
        labels[root] = f"{base}-{digest}"
    return labels


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def iter_source_entries(
    roots: Sequence[str | Path],
    *,
    archive_root: str | Path | None = None,
    include_archives: bool = False,
) -> Iterator[SourceEntry]:
    """Recursively discover books; each TXT is one whole-book candidate."""

    resolved_roots = [Path(root).expanduser().resolve() for root in roots]
    labels = _source_labels(resolved_roots)
    excluded = Path(archive_root).resolve() if archive_root else None
    for root in resolved_roots:
        if not root.exists():
            raise FileNotFoundError(f"Source root does not exist: {root}")
        if not root.is_dir():
            raise NotADirectoryError(f"Source root is not a directory: {root}")

        def raise_walk_error(error: OSError) -> None:
            raise error

        for current, dir_names, file_names in os.walk(
            root, followlinks=False, onerror=raise_walk_error
        ):
            current_path = Path(current)
            dir_names.sort()
            file_names.sort()
            if excluded is not None:
                dir_names[:] = [
                    name for name in dir_names
                    if not _is_relative_to((current_path / name).resolve(), excluded)
                ]
            for file_name in file_names:
                path = current_path / file_name
                suffix = path.suffix.lower()
                if suffix != ".txt" and not (include_archives and suffix in ARCHIVE_SUFFIXES):
                    continue
                try:
                    mode = path.lstat().st_mode
                except OSError as exc:
                    raise OSError(f"Cannot inspect source entry {path}: {exc}") from exc
                if stat_module.S_ISLNK(mode) or not stat_module.S_ISREG(mode):
                    continue
                yield SourceEntry(
                    path=path.resolve(),
                    root=root,
                    label=labels[root],
                    relative_path=path.relative_to(root),
                )


def snapshot_sources(roots: Sequence[str | Path]) -> SourceSnapshot:
    """Hash path/size/mtime metadata to gate a later destructive apply."""

    resolved = tuple(str(Path(root).expanduser().resolve()) for root in roots)
    digest = hashlib.sha256()
    txt_count = txt_size = archive_count = archive_size = 0
    markers: list[str] = []
    for root_value in resolved:
        root = Path(root_value)
        if not root.exists():
            raise FileNotFoundError(f"Snapshot source root does not exist: {root}")
        if not root.is_dir():
            raise NotADirectoryError(f"Snapshot source root is not a directory: {root}")

        def raise_walk_error(error: OSError) -> None:
            raise error

        for current, dir_names, file_names in os.walk(
            root, followlinks=False, onerror=raise_walk_error
        ):
            dir_names.sort()
            file_names.sort()
            for name in file_names:
                path = Path(current) / name
                lowered = name.lower()
                if lowered.endswith(ACTIVE_TRANSFER_SUFFIXES):
                    if len(markers) < 100:
                        markers.append(str(path))
                suffix = path.suffix.lower()
                if suffix != ".txt" and suffix not in ARCHIVE_SUFFIXES:
                    continue
                try:
                    stat = path.lstat()
                except OSError as exc:
                    raise OSError(f"Cannot snapshot source entry {path}: {exc}") from exc
                if stat_module.S_ISLNK(stat.st_mode) or not stat_module.S_ISREG(stat.st_mode):
                    continue
                relative = path.relative_to(root)
                digest.update(os.fsencode(str(root)))
                digest.update(b"\0")
                digest.update(os.fsencode(str(relative)))
                digest.update(b"\0")
                digest.update(str(stat.st_size).encode("ascii"))
                digest.update(b"\0")
                digest.update(str(stat.st_mtime_ns).encode("ascii"))
                digest.update(b"\n")
                if suffix == ".txt":
                    txt_count += 1
                    txt_size += stat.st_size
                else:
                    archive_count += 1
                    archive_size += stat.st_size
    return SourceSnapshot(
        created_at=utc_now(),
        roots=resolved,
        txt_count=txt_count,
        txt_size_bytes=txt_size,
        archive_count=archive_count,
        archive_size_bytes=archive_size,
        active_transfer_markers=tuple(markers),
        metadata_sha256=digest.hexdigest(),
    )


def snapshots_match(left: SourceSnapshot, right: SourceSnapshot) -> bool:
    """Compare stability fields while deliberately ignoring timestamps."""

    return (
        left.roots == right.roots
        and left.txt_count == right.txt_count
        and left.txt_size_bytes == right.txt_size_bytes
        and left.archive_count == right.archive_count
        and left.archive_size_bytes == right.archive_size_bytes
        and not left.active_transfer_markers
        and not right.active_transfer_markers
        and left.metadata_sha256 == right.metadata_sha256
    )


def source_snapshot_from_dict(payload: Mapping[str, object]) -> SourceSnapshot:
    return SourceSnapshot(
        created_at=str(payload.get("created_at") or ""),
        roots=tuple(str(value) for value in payload.get("roots", [])),
        txt_count=int(payload.get("txt_count") or 0),
        txt_size_bytes=int(payload.get("txt_size_bytes") or 0),
        archive_count=int(payload.get("archive_count") or 0),
        archive_size_bytes=int(payload.get("archive_size_bytes") or 0),
        active_transfer_markers=tuple(
            str(value) for value in payload.get("active_transfer_markers", [])
        ),
        metadata_sha256=str(payload.get("metadata_sha256") or ""),
    )


def _empty_scan_record(entry: SourceEntry, status: str, error: str = "") -> dict[str, object]:
    try:
        stat = entry.path.stat()
        size_bytes = stat.st_size
        mtime_ns = stat.st_mtime_ns
        ctime_ns = stat.st_ctime_ns
        device_id = stat.st_dev
        inode = stat.st_ino
    except OSError:
        size_bytes = 0
        mtime_ns = 0
        ctime_ns = 0
        device_id = 0
        inode = 0
    return {
        "source_path": str(entry.path),
        "source_root": str(entry.root),
        "source_label": entry.label,
        "relative_path": str(entry.relative_path),
        "size_bytes": size_bytes,
        "mtime_ns": mtime_ns,
        "ctime_ns": ctime_ns,
        "device_id": device_id,
        "inode": inode,
        "scan_status": status,
        "fingerprint_version": FINGERPRINT_VERSION,
        "scan_error": error,
        "raw_sha256": "",
        "normalized_sha256": "",
        "non_whitespace_chars": 0,
        "line_count": 0,
        "replacement_chars": 0,
        "encoding": "",
        "encoding_confidence": "",
        "encoding_score": 0.0,
        "encoding_margin": 0.0,
        "sketch_json": "[]",
        "ordered_sketch_json": "[]",
        "sampled_chars": 0,
        "source_name": entry.path.name,
        "display_title": entry.path.stem,
        "title_key": "",
        "author": "",
        "aliases_json": "[]",
        "title_confidence": 0.0,
        "title_evidence_json": "[]",
        "genre": "unknown",
        "genre_confidence": 0.0,
        "genre_tags_json": "[]",
        "genre_evidence_json": "[]",
        "source_priority": 0,
        "source_kind": "raw",
        "inspected_at": utc_now(),
        "last_seen_scan_id": "",
    }


def _processed_export_provenance(path: Path, raw_sha256: str) -> dict[str, object]:
    """Load a verified processed-corpus sidecar emitted by the exporter.

    A sidecar is allowed to override title/author and representative priority
    only when it identifies the exact TXT bytes being scanned.  A present but
    malformed sidecar is an error rather than a silent downgrade to raw input.
    """

    sidecar = path.parent / "provenance.json"
    if not sidecar.is_file():
        return {}
    try:
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid processed export provenance: {sidecar}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"processed export provenance must be an object: {sidecar}")
    if payload.get("layout_version") != "processed-existing-export-v1":
        raise ValueError(f"unsupported processed export provenance: {sidecar}")
    if payload.get("existing_processed") is not True:
        raise ValueError(f"processed export provenance lacks existing_processed=true: {sidecar}")
    if str(payload.get("source_sha256") or "") != raw_sha256:
        raise ValueError(f"processed export provenance hash mismatch: {sidecar}")
    source_kind = str(payload.get("source_kind") or "")
    if source_kind != "existing_processed":
        raise ValueError(f"invalid processed export source_kind: {sidecar}")
    try:
        source_priority = int(payload.get("source_priority"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid processed export source_priority: {sidecar}") from exc
    if not 1 <= source_priority <= 1_000:
        raise ValueError(f"processed export source_priority is out of range: {sidecar}")
    return payload


def _metadata_payload(
    path: Path,
    head_text: str,
    *,
    provenance: Mapping[str, object] | None = None,
) -> tuple[dict[str, object], dict[str, object]]:
    """Adapt local_metadata's typed results to stable catalog dictionaries."""

    from .local_metadata import build_local_metadata, canonical_name_key

    provenance = provenance or {}
    provenance_title = str(provenance.get("title") or "").strip()
    provenance_author = str(provenance.get("author") or "").strip()
    filename = path.name
    if provenance_title:
        filename = f"《{provenance_title}》"
        if provenance_author:
            filename += f"作者：{provenance_author}"
        filename += ".txt"
    combined = build_local_metadata(
        {
            "filename": filename,
            "path": str(path),
            "head_excerpt": head_text[:24_000],
        }
    )
    field_confidence = combined.get("field_confidence") or {}
    display_title = provenance_title or str(combined.get("title") or path.stem)
    author = provenance_author or str(combined.get("author") or "")
    aliases = [str(value) for value in combined.get("aliases") or [] if str(value).strip()]
    inferred_title = str(combined.get("title") or "").strip()
    if provenance_title and inferred_title and inferred_title != provenance_title:
        aliases.append(inferred_title)
    aliases = list(dict.fromkeys(value for value in aliases if value != display_title))
    evidence = [str(value) for value in combined.get("evidence") or []]
    if provenance_title:
        evidence.append("processed-export:verified-provenance-title")
    if provenance_author:
        evidence.append("processed-export:verified-provenance-author")
    title_payload = {
        "display_title": display_title,
        "canonical_key": canonical_name_key(display_title),
        "author": author,
        "aliases": aliases,
        "confidence": (
            1.0
            if provenance_title
            else field_confidence.get("title", combined.get("confidence", 0.0))
        ),
        "evidence": evidence,
    }
    genre_payload = {
        "genre": combined.get("genre") or "其他",
        "tags": combined.get("tags") or [],
        "confidence": field_confidence.get("genre", combined.get("confidence", 0.0)),
        "evidence": combined.get("evidence") or [],
    }
    return title_payload, genre_payload


def inspect_source_entry(entry: SourceEntry) -> dict[str, object]:
    """Worker-safe inspection of one file."""

    try:
        stat_before = entry.path.stat()
        fingerprint = fingerprint_file(entry.path)
        stat_after = entry.path.stat()
        if (
            stat_before.st_size,
            stat_before.st_mtime_ns,
            stat_before.st_ctime_ns,
            stat_before.st_dev,
            stat_before.st_ino,
            stat_before.st_mode,
        ) != (
            stat_after.st_size,
            stat_after.st_mtime_ns,
            stat_after.st_ctime_ns,
            stat_after.st_dev,
            stat_after.st_ino,
            stat_after.st_mode,
        ):
            return _empty_scan_record(entry, "unstable", "file changed while scanning")
        provenance = _processed_export_provenance(entry.path, fingerprint.raw_sha256)
        head = read_head_text(entry.path, fingerprint.encoding)
        title_payload, genre_payload = _metadata_payload(
            entry.path,
            head,
            provenance=provenance,
        )
        replacement_rate = fingerprint.replacement_chars / max(
            1, fingerprint.non_whitespace_chars
        )
        strict_validation: StrictSourceValidation | None = None
        if (
            fingerprint.replacement_chars
            and fingerprint.encoding_confidence == "high"
            and replacement_rate <= MAX_LITERAL_REPLACEMENT_RATE
        ):
            strict_validation = _strict_validate_source(
                str(entry.path),
                encoding=fingerprint.encoding,
                expected_raw_sha256=fingerprint.raw_sha256,
                expected_normalized_sha256=fingerprint.normalized_sha256,
                expected_size_bytes=fingerprint.size_bytes,
                expected_mtime_ns=stat_after.st_mtime_ns,
                expected_ctime_ns=stat_after.st_ctime_ns,
                expected_device_id=stat_after.st_dev,
                expected_inode=stat_after.st_ino,
                expected_non_whitespace_chars=fingerprint.non_whitespace_chars,
                expected_line_count=fingerprint.line_count,
                expected_replacement_chars=fingerprint.replacement_chars,
            )
        verified_literal_replacements = bool(
            strict_validation
            and strict_validation.status == "verified_literal_replacements"
        )
        if verified_literal_replacements:
            evidence = (
                f"encoding:{QUALITY_POLICY_VERSION}="
                f"{fingerprint.replacement_chars};rate={replacement_rate:.8f};"
                f"codec={fingerprint.encoding}"
            )
            title_payload["evidence"] = list(title_payload.get("evidence") or []) + [
                evidence
            ]
            if provenance and fingerprint.encoding == "utf-8":
                title_payload["evidence"].append(
                    "processed-export:verified-utf8-literal-replacements="
                    f"{fingerprint.replacement_chars};rate={replacement_rate:.8f}"
                )
        if fingerprint.size_bytes == 0 or fingerprint.non_whitespace_chars < 100:
            status = "invalid"
            error = "empty or too little decodable text"
        # Apply uses strict decoding.  Do not let even one replacement produced
        # by the permissive fingerprint pass reach the destructive phase.
        elif strict_validation and strict_validation.status in {
            "source_changed",
            "fingerprint_mismatch",
        }:
            status = "unstable"
            error = (
                f"quality_policy={QUALITY_POLICY_VERSION};"
                f"decision={strict_validation.status};{strict_validation.error}"
            )
        elif fingerprint.encoding_confidence == "ambiguous" or (
            fingerprint.replacement_chars and not verified_literal_replacements
        ):
            status = "quarantine"
            error = (
                f"quality_policy={QUALITY_POLICY_VERSION};decision="
                f"{'strict_decode_failed' if strict_validation else 'policy_rejected'};"
                f"encoding={fingerprint.encoding};confidence="
                f"{fingerprint.encoding_confidence};replacement_rate="
                f"{replacement_rate:.8f}"
            )
        else:
            status = "ok"
            error = ""
        return {
            "source_path": str(entry.path),
            "source_root": str(entry.root),
            "source_label": entry.label,
            "relative_path": str(entry.relative_path),
            "size_bytes": stat_after.st_size,
            "mtime_ns": stat_after.st_mtime_ns,
            "ctime_ns": stat_after.st_ctime_ns,
            "device_id": stat_after.st_dev,
            "inode": stat_after.st_ino,
            "scan_status": status,
            "scan_error": error,
            **fingerprint.to_dict(),
            "sketch_json": json.dumps(list(fingerprint.sketch)),
            "ordered_sketch_json": json.dumps(list(fingerprint.ordered_sketch)),
            "source_name": entry.path.name,
            "display_title": str(title_payload.get("display_title") or entry.path.stem),
            "title_key": str(title_payload.get("canonical_key") or ""),
            "author": str(title_payload.get("author") or ""),
            "aliases_json": json.dumps(title_payload.get("aliases") or [], ensure_ascii=False),
            "title_confidence": float(title_payload.get("confidence") or 0.0),
            "title_evidence_json": json.dumps(
                title_payload.get("evidence") or [], ensure_ascii=False
            ),
            "genre": str(genre_payload.get("genre") or "unknown"),
            "genre_confidence": float(genre_payload.get("confidence") or 0.0),
            "genre_tags_json": json.dumps(genre_payload.get("tags") or [], ensure_ascii=False),
            "genre_evidence_json": json.dumps(
                genre_payload.get("evidence") or [], ensure_ascii=False
            ),
            "source_priority": int(provenance.get("source_priority") or 0),
            "source_kind": str(provenance.get("source_kind") or "raw"),
            "inspected_at": utc_now(),
        }
    except Exception as exc:
        logger.exception("Could not inspect %s", entry.path)
        try:
            return _empty_scan_record(entry, "error", f"{type(exc).__name__}: {exc}")
        except OSError:
            return {
                "source_path": str(entry.path),
                "source_root": str(entry.root),
                "source_label": entry.label,
                "relative_path": str(entry.relative_path),
                "size_bytes": 0,
                "mtime_ns": 0,
                "scan_status": "error",
                "scan_error": f"{type(exc).__name__}: {exc}",
                "source_priority": 0,
                "source_kind": "raw",
                "inspected_at": utc_now(),
            }


def scan_sources(
    catalog: LocalNovelCatalog,
    roots: Sequence[str | Path],
    *,
    archive_root: str | Path,
    workers: int = 4,
    stable_age_seconds: float = 600.0,
    limit: int | None = None,
    force: bool = False,
    run_id: str | None = None,
) -> dict[str, object]:
    """Inventory and fingerprint source TXT files with bounded concurrency."""

    resolved_run_id = run_id or f"scan-{uuid.uuid4().hex[:12]}"
    resolved_roots = [str(Path(root).expanduser().resolve()) for root in roots]
    options = {
        "roots": resolved_roots,
        "archive_root": str(Path(archive_root).resolve()),
        "workers": workers,
        "stable_age_seconds": stable_age_seconds,
        "limit": limit,
        "force": force,
    }
    catalog.start_run(resolved_run_id, "scan", options)
    counters = {
        "discovered": 0,
        "cached": 0,
        "submitted": 0,
        "written": 0,
        "missing_marked": 0,
    }
    status_counts: dict[str, int] = {}
    now = time.time()

    entries = iter_source_entries(roots, archive_root=archive_root)
    max_pending = max(2, workers * 3)
    pending: dict[Future[dict[str, object]], SourceEntry] = {}

    def persist(record: Mapping[str, object]) -> None:
        payload = dict(record)
        payload["last_seen_scan_id"] = resolved_run_id
        catalog.upsert_file(payload)
        counters["written"] += 1
        status = str(record.get("scan_status") or "error")
        status_counts[status] = status_counts.get(status, 0) + 1
        if counters["written"] % 100 == 0:
            catalog.commit()

    try:
        # Decoding/NFKC is CPU-heavy Python work. Processes scale across cores;
        # the bounded queue prevents them from flooding the shared filesystem.
        with ProcessPoolExecutor(max_workers=max(1, workers)) as executor:
            for entry in entries:
                if limit is not None and counters["discovered"] >= limit:
                    break
                counters["discovered"] += 1
                try:
                    stat = entry.path.stat()
                except OSError as exc:
                    persist(_empty_scan_record(entry, "error", str(exc)))
                    continue
                cached = None if force else catalog.cached_file(
                    entry.path,
                    size_bytes=stat.st_size,
                    mtime_ns=stat.st_mtime_ns,
                    ctime_ns=stat.st_ctime_ns,
                    device_id=stat.st_dev,
                    inode=stat.st_ino,
                )
                if cached is not None:
                    counters["cached"] += 1
                    catalog.mark_seen(entry.path, resolved_run_id)
                    cached_status = str(cached["scan_status"] or "error")
                    status_counts[cached_status] = status_counts.get(cached_status, 0) + 1
                    continue
                if now - stat.st_mtime < stable_age_seconds:
                    persist(_empty_scan_record(entry, "unstable", "mtime is inside stability window"))
                    continue
                pending[executor.submit(inspect_source_entry, entry)] = entry
                counters["submitted"] += 1
                if len(pending) >= max_pending:
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        pending.pop(future, None)
                        persist(future.result())
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    pending.pop(future, None)
                    persist(future.result())
        if limit is None:
            counters["missing_marked"] = catalog.reconcile_completed_scan(
                resolved_roots, resolved_run_id
            )
        catalog.commit()
        catalog_stats = catalog.stats()
        catalog_statuses = dict(catalog_stats.get("scan_status") or {})
        unresolved = sum(
            int(catalog_statuses.get(value, 0)) for value in ("unstable", "error")
        )
        status = "partial" if unresolved else "complete"
        summary = {
            **counters,
            "status": status,
            "unresolved": unresolved,
            "statuses": status_counts,
            "catalog": catalog_stats,
        }
        catalog.finish_run(resolved_run_id, status, summary)
        return {"run_id": resolved_run_id, **summary}
    except Exception:
        catalog.connection.rollback()
        catalog.finish_run(resolved_run_id, "failed", {**counters, "statuses": status_counts})
        raise


def _fingerprint_from_row(row: sqlite3.Row) -> FileFingerprint:
    return FileFingerprint(
        raw_sha256=str(row["raw_sha256"]),
        normalized_sha256=str(row["normalized_sha256"]),
        size_bytes=int(row["size_bytes"]),
        non_whitespace_chars=int(row["non_whitespace_chars"]),
        line_count=int(row["line_count"]),
        replacement_chars=int(row["replacement_chars"]),
        encoding=str(row["encoding"]),
        encoding_confidence=str(row["encoding_confidence"]),
        encoding_score=float(row["encoding_score"]),
        encoding_margin=float(row["encoding_margin"]),
        sketch=tuple(json.loads(str(row["sketch_json"]))),
        ordered_sketch=tuple(json.loads(str(row["ordered_sketch_json"]))),
        sampled_chars=int(row["sampled_chars"]),
        fingerprint_version=int(row["fingerprint_version"]),
    )


def _title_similarity(left: sqlite3.Row, right: sqlite3.Row) -> float:
    left_key = str(left["title_key"])
    right_key = str(right["title_key"])
    if not left_key or not right_key:
        return 0.0
    if left_key == right_key:
        return 1.0
    return SequenceMatcher(None, left_key, right_key, autojunk=False).ratio()


def _high_confidence_incomplete_evidence(
    left: sqlite3.Row,
    right: sqlite3.Row,
    thresholds: DedupeThresholds,
    evidence: Mapping[str, object],
) -> dict[str, object] | None:
    """Return directed evidence when one row is a very likely truncated copy.

    A content sketch alone is not permission to delete a book.  Require a
    substantial-but-clearly-shorter text, near-perfect containment and order,
    enough independent anchors, plus compatible title/author metadata.  The
    result identifies the shorter and longer file explicitly so callers never
    infer the deletion direction from an undirected duplicate edge.
    """

    left_chars = int(left["non_whitespace_chars"] or 0)
    right_chars = int(right["non_whitespace_chars"] or 0)
    if left_chars == right_chars or min(left_chars, right_chars) < thresholds.minimum_fuzzy_chars:
        return None
    length_ratio = float(evidence.get("length_ratio") or 0.0)
    if not (
        thresholds.incomplete_min_length_ratio
        <= length_ratio
        <= thresholds.incomplete_max_length_ratio
    ):
        return None
    if (
        float(evidence.get("sketch_containment") or 0.0)
        < thresholds.incomplete_containment
        or float(evidence.get("order_ratio") or 0.0)
        < thresholds.incomplete_order_ratio
        or int(evidence.get("shared_anchors") or 0)
        < thresholds.incomplete_min_shared_anchors
    ):
        return None

    left_title = str(left["title_key"] or "")
    right_title = str(right["title_key"] or "")
    left_author = str(left["author"] or "").strip()
    right_author = str(right["author"] or "").strip()
    same_title = bool(left_title and left_title == right_title)
    same_author = bool(left_author and right_author and left_author == right_author)
    authors_conflict = bool(left_author and right_author and left_author != right_author)
    title_similarity = float(evidence.get("title_similarity") or 0.0)
    generic_authors = {"佚名", "未知", "未知作者", "unknown", "anonymous"}
    meaningful_same_author = same_author and left_author.casefold() not in generic_authors

    # Exact titles tolerate one missing author, but never a conflicting one.
    # Otherwise both a meaningful author match and a very close title are
    # mandatory.  Completely unrelated filenames therefore remain editions.
    metadata_consistent = (same_title and not authors_conflict) or (
        meaningful_same_author and title_similarity >= 0.92
    )
    if not metadata_consistent:
        return None

    shorter, longer = (
        (left, right) if left_chars < right_chars else (right, left)
    )
    result = dict(evidence)
    result.update(
        {
            "incomplete_candidate": True,
            "shorter_file_id": int(shorter["file_id"]),
            "longer_file_id": int(longer["file_id"]),
            "shorter_chars": min(left_chars, right_chars),
            "longer_chars": max(left_chars, right_chars),
            "metadata_consistent": True,
            "metadata_basis": (
                "exact_title_no_author_conflict"
                if same_title and not authors_conflict
                else "matching_author_and_similar_title"
            ),
        }
    )
    return result


def _relation_for_pair(
    left: sqlite3.Row,
    right: sqlite3.Row,
    thresholds: DedupeThresholds,
) -> tuple[str, bool, dict[str, object]]:
    left_fp = _fingerprint_from_row(left)
    right_fp = _fingerprint_from_row(right)
    evidence = compare_fingerprints(left_fp, right_fp).to_dict()
    title_similarity = _title_similarity(left, right)
    evidence["title_similarity"] = round(title_similarity, 6)
    evidence["same_author"] = bool(
        left["author"] and right["author"] and left["author"] == right["author"]
    )
    if left_fp.normalized_sha256 == right_fp.normalized_sha256:
        relation = "byte_exact" if left_fp.raw_sha256 == right_fp.raw_sha256 else "text_exact"
        return relation, True, evidence

    minimum_chars = min(left_fp.non_whitespace_chars, right_fp.non_whitespace_chars)
    if minimum_chars >= thresholds.minimum_fuzzy_chars:
        if (
            evidence["length_ratio"] >= thresholds.same_edition_length_ratio
            and evidence["sketch_containment"] >= thresholds.same_edition_containment
            and evidence["sketch_jaccard"] >= thresholds.same_edition_jaccard
            and evidence["order_ratio"] >= thresholds.same_edition_order_ratio
            and evidence["shared_anchors"] >= thresholds.minimum_shared_anchors
        ):
            return "same_edition", True, evidence
        incomplete_evidence = _high_confidence_incomplete_evidence(
            left, right, thresholds, evidence
        )
        if incomplete_evidence is not None:
            # ``auto_merge`` means only "same work" here.  It does not delete
            # the shorter version; default planning retains it as _v2/_v3 and
            # writes this edge to review.jsonl.
            return "possible_incomplete", True, incomplete_evidence
        if (
            evidence["length_ratio"] >= thresholds.same_work_length_ratio
            and evidence["sketch_containment"] >= thresholds.same_work_containment
            and evidence["order_ratio"] >= thresholds.same_work_order_ratio
            and evidence["shared_anchors"] >= thresholds.minimum_shared_anchors
        ):
            return "same_work_version", True, evidence
        if (
            evidence["sketch_containment"] >= thresholds.review_containment
            and evidence["order_ratio"] >= thresholds.review_order_ratio
            and evidence["shared_anchors"] >= max(4, thresholds.minimum_shared_anchors // 2)
        ):
            return "possible_same_work", False, evidence
    if title_similarity == 1.0 and float(evidence["sketch_containment"]) < 0.30:
        return "title_collision", False, evidence
    return "distinct", False, evidence


def _representative(rows: Sequence[sqlite3.Row]) -> sqlite3.Row:
    max_chars = max(int(row["non_whitespace_chars"]) for row in rows) or 1

    def quality(row: sqlite3.Row) -> tuple[int, float, int, str]:
        source_priority = int(row["source_priority"] or 0)
        completeness = int(row["non_whitespace_chars"]) / max_chars
        decode = 1.0 if row["encoding_confidence"] == "high" else 0.6
        replacement_rate = int(row["replacement_chars"]) / max(
            1, int(row["non_whitespace_chars"])
        )
        metadata = min(1.0, float(row["title_confidence"]))
        score = (
            completeness * 0.40
            + decode * 0.25
            + max(0.0, 1.0 - replacement_rate * 1_000) * 0.20
            + metadata * 0.15
        )
        # Stable tiebreakers: larger text, then lexical source path.
        return (
            source_priority,
            score,
            int(row["non_whitespace_chars"]),
            str(row["source_path"]),
        )

    best_quality = max(quality(row)[:3] for row in rows)
    # The comment above promises lexical order; ``max(..., source_path)`` used
    # to select the greatest path.  Prefer the smallest path deterministically.
    return min(
        (row for row in rows if quality(row)[:3] == best_quality),
        key=lambda row: os.fsencode(str(row["source_path"])),
    )


def _safe_component(value: str, *, fallback: str = "unknown") -> str:
    value = unicodedata.normalize("NFKC", value).strip().lower()
    value = re.sub(r"[^0-9a-z\u4e00-\u9fff_-]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-_.")
    return value[:80] or fallback


def _readable_component(value: str, *, fallback: str, maximum: int = 80) -> str:
    value = unicodedata.normalize("NFKC", value).strip()
    # Final visible names deliberately use a very small portable alphabet:
    # Chinese, ASCII letters/digits, and the English underscore.
    value = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("_")
    return (value[:maximum].rstrip("_") or fallback)


def _truncate_component_bytes(value: str, maximum_bytes: int) -> str:
    """Fit a visible component into a filesystem byte budget.

    Linux limits one filename component to 255 *bytes*, not characters.  Keep a
    short digest when truncation occurs so two long names with the same prefix
    do not collide.
    """

    encoded = os.fsencode(value)
    if len(encoded) <= maximum_bytes:
        return value
    digest = hashlib.blake2s(encoded, digest_size=4).hexdigest()
    suffix = f"_{digest}"
    budget = max(1, maximum_bytes - len(os.fsencode(suffix)))
    kept: list[str] = []
    used = 0
    for character in value:
        size = len(os.fsencode(character))
        if used + size > budget:
            break
        kept.append(character)
        used += size
    prefix = "".join(kept).rstrip("_") or value[0]
    return f"{prefix}{suffix}"


def _fallback_pinyin_initial(value: str) -> str:
    for character in unicodedata.normalize("NFKC", value):
        if character.isascii() and character.isalpha():
            return character.upper()
        if not ("\u3400" <= character <= "\u9fff"):
            continue
        try:
            encoded = character.encode("gbk")
        except UnicodeEncodeError:
            return "#"
        if len(encoded) != 2:
            return "#"
        signed_code = (encoded[0] - 256) * 256 + (encoded[1] - 256)
        initial = "#"
        for boundary, candidate in _GB2312_INITIAL_BOUNDARIES:
            if signed_code < boundary:
                break
            initial = candidate
        return initial
    return "#"


@lru_cache(maxsize=131_072)
def _pinyin_sort_metadata(value: str) -> tuple[str, str, str]:
    """Return ``(key, initial, method)`` for deterministic Chinese A-Z order."""

    normalized = unicodedata.normalize("NFKC", value).strip()
    if _lazy_pinyin is not None:
        tokens = _lazy_pinyin(
            normalized,
            errors=lambda text: [
                "".join(f"u{ord(character):06x}" for character in text)
            ],
        )
        romanized = "".join(str(token) for token in tokens).casefold()
        romanized = re.sub(r"[^0-9a-z]+", "", romanized)
        initial = next(
            (character.upper() for character in romanized if character.isalpha()),
            "#",
        )
        return f"{initial}|{romanized}|{normalized.casefold()}", initial, "pypinyin"

    initial = _fallback_pinyin_initial(normalized)
    encoded_key = normalized.casefold().encode("gb18030", errors="replace").hex()
    return f"{initial}|{encoded_key}|{normalized.casefold()}", initial, "gb18030-fallback"


def _category_for(value: object) -> tuple[str, str]:
    genre = str(value or DEFAULT_CATEGORY)
    if genre not in CATEGORY_CODES:
        genre = DEFAULT_CATEGORY
    return genre, CATEGORY_CODES[genre]


def _flat_destination(
    row: Mapping[str, object],
    *,
    library_id: int,
    category_code: str,
    version: int = 1,
) -> Path:
    def value(key: str, default: str = "") -> object:
        try:
            return row[key]
        except (KeyError, IndexError):
            return default

    if not 1 <= int(library_id) <= 999_999:
        raise ValueError(f"library_id must fit six digits: {library_id}")
    if not re.fullmatch(r"\d{2}", category_code):
        raise ValueError(f"category_code must contain exactly two digits: {category_code!r}")
    genre, _resolved_code = _category_for(value("genre", DEFAULT_CATEGORY))
    genre = _readable_component(genre, fallback=DEFAULT_CATEGORY, maximum=24)
    title = _readable_component(
        str(value("display_title") or value("source_name") or "未命名"),
        fallback="未命名",
    )
    author = _readable_component(str(value("author") or ""), fallback="佚名", maximum=48)
    title = _truncate_component_bytes(title, 150)
    author = _truncate_component_bytes(author, 72)
    stem = f"{category_code}_id{int(library_id):06d}_{title}_{author}"
    if version > 1:
        stem = f"{stem}_v{int(version)}"
    filename = f"{stem}.txt"
    if len(os.fsencode(filename)) > 255:  # defensive against future prefix changes
        raise ValueError(f"visible filename exceeds 255 bytes: {filename!r}")
    return Path(genre) / filename


def _versioned_destination(base: Path, version: int) -> Path:
    if version <= 1:
        return base
    return base.with_name(f"{base.stem}_v{version}{base.suffix}")


_VISIBLE_LIBRARY_ID_RE = re.compile(r"(?:\d{2}_)?id(\d{1,6})(?!\d)", re.IGNORECASE)


def _seed_library_id_high_watermark(catalog: LocalNovelCatalog, root: Path) -> int:
    """Reserve IDs already present in a unified index or an exporter id-map."""

    high_watermark = 0
    candidates = (
        root / "index.jsonl",
        root / "id_map.jsonl",
        root / ".state" / "id_map.jsonl",
    )
    for path in candidates:
        if not path.is_file():
            continue
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                for match in _VISIBLE_LIBRARY_ID_RE.finditer(line):
                    high_watermark = max(high_watermark, int(match.group(1)))
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                for key in ("library_id", "new_library_id", "edition_library_id"):
                    try:
                        value = int(payload.get(key) or 0)
                    except (TypeError, ValueError):
                        continue
                    if 0 < value <= 999_999:
                        high_watermark = max(high_watermark, value)
    return catalog.reserve_library_id_high_watermark(high_watermark)


def _plan_catalog_impl(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    thresholds: DedupeThresholds | None = None,
    run_id: str | None = None,
    draft: bool = False,
    max_candidate_pair_rows: int | None = 25_000_000,
    delete_high_confidence_incomplete: bool = False,
) -> dict[str, object]:
    """Create explainable work/edition relationships and destination paths."""

    resolved_thresholds = thresholds or DedupeThresholds()
    resolved_run_id = run_id or f"plan-{uuid.uuid4().hex[:12]}"
    root = Path(archive_root).resolve()
    seeded_library_id_high_watermark = (
        0 if draft else _seed_library_id_high_watermark(catalog, root)
    )
    catalog.require_new_run_id(resolved_run_id)
    unresolved_statuses = {
        str(row[0]): int(row[1])
        for row in catalog.connection.execute(
            """
            SELECT scan_status, COUNT(*) FROM files
            WHERE scan_status IN ('unstable', 'error') GROUP BY scan_status
            """
        )
    }
    if unresolved_statuses:
        raise RuntimeError(
            "Cannot plan while scanned files remain unresolved; rescan after transfer stabilizes: "
            + json.dumps(unresolved_statuses, ensure_ascii=False, sort_keys=True)
        )
    catalog.start_run(
        resolved_run_id,
        "plan",
        {
            "archive_root": str(root),
            "thresholds": asdict(resolved_thresholds),
            "draft": draft,
            "max_candidate_pair_rows": max_candidate_pair_rows,
            "delete_high_confidence_incomplete": delete_high_confidence_incomplete,
        },
    )
    file_ids = [
        int(row[0])
        for row in catalog.connection.execute(
            "SELECT file_id FROM files WHERE scan_status='ok' ORDER BY file_id"
        )
    ]
    union = _UnionFind(file_ids)

    # Hundreds of thousands of 96+96-anchor rows can consume gigabytes if
    # loaded at once. Candidate comparison uses a bounded working-set cache.
    @lru_cache(maxsize=32768)
    def row_for(file_id: int) -> sqlite3.Row:
        return catalog.get_file(file_id)

    @lru_cache(maxsize=131072)
    def relation_for_ids(
        left_id: int, right_id: int
    ) -> tuple[str, bool, dict[str, object]]:
        left_id, right_id = sorted((left_id, right_id))
        return _relation_for_pair(
            row_for(left_id), row_for(right_id), resolved_thresholds
        )

    def complete_link_union(
        left_id: int, right_id: int
    ) -> tuple[bool, dict[str, object] | None]:
        """Merge only when every distinct edition across both groups agrees.

        Plain union-find creates an unsafe fuzzy transitive closure: A may be
        similar to B and B to C even though A and C are different books.  One
        representative per normalized hash is enough here because exact-text
        duplicates are interchangeable.
        """

        if union.find(left_id) == union.find(right_id):
            return True, None

        def unique_editions(file_ids: Iterable[int]) -> list[int]:
            by_hash: dict[str, int] = {}
            for file_id in file_ids:
                row = row_for(file_id)
                by_hash.setdefault(str(row["normalized_sha256"]), file_id)
            return list(by_hash.values())

        left_members = unique_editions(union.group(left_id))
        right_members = unique_editions(union.group(right_id))
        for candidate_left in left_members:
            for candidate_right in right_members:
                relation, auto, evidence = relation_for_ids(
                    candidate_left, candidate_right
                )
                if not auto:
                    return False, {
                        "reason": "complete_link_rejected_transitive_merge",
                        "conflicting_file_ids": sorted(
                            (candidate_left, candidate_right)
                        ),
                        "conflicting_relation": relation,
                        "conflicting_evidence": evidence,
                    }
        union.union(left_id, right_id)
        return True, None

    catalog.reset_plan(resolved_run_id)
    exact_edges = near_edges = review_edges = title_collisions = 0
    possible_incomplete_edges = 0

    for group in catalog.exact_groups():
        first = group[0]
        for other in group[1:]:
            relation, auto, evidence = relation_for_ids(first, other)
            catalog.add_duplicate_edge(
                resolved_run_id, first, other, relation, auto_merge=auto, evidence=evidence
            )
            union.union(first, other)
            exact_edges += 1

    candidate_stats = catalog.build_near_candidate_table(
        max_pair_rows=max_candidate_pair_rows
    )
    for left_id, right_id, _shared in catalog.iter_near_candidates():
        left_row = row_for(left_id)
        right_row = row_for(right_id)
        if left_row["normalized_sha256"] == right_row["normalized_sha256"]:
            continue
        relation, auto, evidence = relation_for_ids(left_id, right_id)
        if relation == "distinct":
            continue
        if auto:
            merged, conflict = complete_link_union(left_id, right_id)
            if not merged:
                catalog.add_duplicate_edge(
                    resolved_run_id,
                    left_id,
                    right_id,
                    "transitive_conflict",
                    auto_merge=False,
                    evidence={"direct_relation": relation, "direct_evidence": evidence, **(conflict or {})},
                )
                review_edges += 1
                continue
        catalog.add_duplicate_edge(
            resolved_run_id, left_id, right_id, relation, auto_merge=auto, evidence=evidence
        )
        possible_incomplete_edges += int(relation == "possible_incomplete")
        if auto:
            near_edges += 1
        else:
            review_edges += 1
            title_collisions += int(relation == "title_collision")

    # Exact title groups are only extra recall/review.  They never merge by title.
    for left_id, right_id in catalog.iter_title_candidate_pairs():
        pair = tuple(sorted((left_id, right_id)))
        already_checked = catalog.connection.execute(
            """
            SELECT 1 FROM duplicate_edges
            WHERE plan_run_id=? AND left_file_id=? AND right_file_id=?
            """,
            (resolved_run_id, pair[0], pair[1]),
        ).fetchone()
        if already_checked is not None:
            continue
        relation, auto, evidence = relation_for_ids(left_id, right_id)
        if relation in {"distinct"}:
            continue
        if auto:
            merged, conflict = complete_link_union(left_id, right_id)
            if not merged:
                catalog.add_duplicate_edge(
                    resolved_run_id,
                    left_id,
                    right_id,
                    "transitive_conflict",
                    auto_merge=False,
                    evidence={"direct_relation": relation, "direct_evidence": evidence, **(conflict or {})},
                )
                review_edges += 1
                continue
        catalog.add_duplicate_edge(
            resolved_run_id, left_id, right_id, relation, auto_merge=auto, evidence=evidence
        )
        possible_incomplete_edges += int(relation == "possible_incomplete")
        if auto:
            near_edges += 1
        else:
            review_edges += 1
            title_collisions += int(relation == "title_collision")

    planned_components = [sorted(values) for values in union.groups().values()]

    def partition_component_editions(
        component_ids: Sequence[int],
    ) -> tuple[
        list[sqlite3.Row],
        sqlite3.Row,
        dict[int, tuple[str, dict[str, object]]],
        dict[str, list[sqlite3.Row]],
        list[str],
        dict[str, sqlite3.Row],
        set[int],
    ]:
        """Partition a work by same-edition relations, not a representative star."""

        component_rows = [row_for(file_id) for file_id in component_ids]
        edition_union = _UnionFind(component_ids)
        by_normalized_hash: dict[str, list[int]] = {}
        for row in component_rows:
            by_normalized_hash.setdefault(str(row["normalized_sha256"]), []).append(
                int(row["file_id"])
            )
        for ids in by_normalized_hash.values():
            for other in ids[1:]:
                edition_union.union(ids[0], other)

        # Work components are normally tiny after exact-content collapse.  The
        # complete-link pass has already evaluated most of these pairs, so this
        # mainly reuses its bounded relation cache and fixes B/C editions that
        # are both non-canonical relative to A.
        unique_representatives = [min(ids) for ids in by_normalized_hash.values()]
        for index, left_id in enumerate(unique_representatives):
            for right_id in unique_representatives[index + 1 :]:
                relation, _auto, _evidence = relation_for_ids(left_id, right_id)
                if relation in {"byte_exact", "text_exact", "same_edition"}:
                    edition_union.union(left_id, right_id)

        raw_groups = [sorted(ids) for ids in edition_union.groups().values()]
        raw_groups.sort(key=lambda ids: min(ids))
        incomplete_file_ids: set[int] = set()

        if delete_high_confidence_incomplete and len(raw_groups) > 1:
            # Evaluate longest groups first.  A short group may collapse only
            # into a retained longer group with direct high-confidence
            # evidence for *every* cross-edition pair.  We never follow a
            # fuzzy transitive chain to decide deletion.
            retained: list[dict[str, list[int]]] = []
            ordered_groups = sorted(
                raw_groups,
                key=lambda ids: (
                    -max(int(row_for(file_id)["non_whitespace_chars"]) for file_id in ids),
                    min(ids),
                ),
            )
            for source_ids in ordered_groups:
                source_max = max(
                    int(row_for(file_id)["non_whitespace_chars"]) for file_id in source_ids
                )
                selected_target: dict[str, list[int]] | None = None
                for target in retained:
                    target_identity_ids = target["identity_ids"]
                    target_min = min(
                        int(row_for(file_id)["non_whitespace_chars"])
                        for file_id in target_identity_ids
                    )
                    if source_max >= target_min:
                        continue
                    all_pairs_agree = True
                    for source_id in source_ids:
                        for target_id in target_identity_ids:
                            relation, _auto, evidence = relation_for_ids(
                                source_id, target_id
                            )
                            if (
                                relation != "possible_incomplete"
                                or int(evidence.get("shorter_file_id") or 0) != source_id
                                or int(evidence.get("longer_file_id") or 0) != target_id
                            ):
                                all_pairs_agree = False
                                break
                        if not all_pairs_agree:
                            break
                    if all_pairs_agree:
                        selected_target = target
                        break
                if selected_target is None:
                    retained.append(
                        {"all_ids": list(source_ids), "identity_ids": list(source_ids)}
                    )
                else:
                    selected_target["all_ids"].extend(source_ids)
                    incomplete_file_ids.update(source_ids)
            raw_groups = [sorted(group["all_ids"]) for group in retained]
            identity_ids_by_group = {
                min(group["all_ids"]): set(group["identity_ids"]) for group in retained
            }
        else:
            identity_ids_by_group = {min(ids): set(ids) for ids in raw_groups}

        # Select the visible canonical only from retained identities.  A
        # curated-but-truncated source must never remain canonical merely due
        # to source priority after an explicit incomplete-collapse plan.
        identity_rows = [
            row_for(file_id)
            for ids in identity_ids_by_group.values()
            for file_id in ids
        ]
        representative = _representative(identity_rows)
        representative_id = int(representative["file_id"])
        canonical_key = str(
            representative["normalized_sha256"] or representative["raw_sha256"]
        )
        raw_groups.sort(key=lambda ids: (representative_id not in ids, min(ids)))
        edition_rows: dict[str, list[sqlite3.Row]] = {}
        visible_by_edition: dict[str, sqlite3.Row] = {}
        target_visible_by_file: dict[int, sqlite3.Row] = {}
        ordered_keys: list[str] = []
        for ids in raw_groups:
            rows = [row_for(file_id) for file_id in ids]
            group_identity_ids = identity_ids_by_group[min(ids)]
            group_identity_rows = [row_for(file_id) for file_id in group_identity_ids]
            visible = (
                representative
                if representative_id in group_identity_ids
                else _representative(group_identity_rows)
            )
            key = (
                canonical_key
                if representative_id in group_identity_ids
                else str(visible["normalized_sha256"] or visible["raw_sha256"])
            )
            if key in edition_rows:
                raise RuntimeError(f"edition key collision inside component: {key}")
            edition_rows[key] = rows
            visible_by_edition[key] = visible
            ordered_keys.append(key)
            for file_id in ids:
                target_visible_by_file[file_id] = visible

        relation_by_file: dict[int, tuple[str, dict[str, object]]] = {}
        for row in component_rows:
            file_id = int(row["file_id"])
            if file_id in incomplete_file_ids:
                target_id = int(target_visible_by_file[file_id]["file_id"])
                relation, _auto, evidence = relation_for_ids(target_id, file_id)
                if relation != "possible_incomplete":
                    raise RuntimeError(
                        "Incomplete collapse lost its direct evidence: "
                        f"source={file_id}, target={target_id}, relation={relation}"
                    )
                relation_by_file[file_id] = (
                    "incomplete_duplicate",
                    {
                        **evidence,
                        "decision": "explicit_high_confidence_incomplete_collapse",
                        "target_file_id": target_id,
                    },
                )
            elif file_id == representative_id:
                relation_by_file[file_id] = ("representative", {})
            else:
                relation, _auto, evidence = relation_for_ids(representative_id, file_id)
                relation_by_file[file_id] = (relation, evidence)
        return (
            component_rows,
            representative,
            relation_by_file,
            edition_rows,
            ordered_keys,
            visible_by_edition,
            incomplete_file_ids,
        )

    # A draft is used only to select deduplicated LLM representatives and must
    # not consume permanent IDs.  A final plan allocates once in visible A-Z
    # order and retains the returned mapping for the assembly pass below.
    allocated_library_ids: dict[str, int] = {}
    if not draft:
        allocation_items: list[
            tuple[tuple[object, ...], str, list[int], list[str]]
        ] = []
        for component_ids in planned_components:
            (
                _component_rows,
                representative,
                _relations,
                edition_rows_for_allocation,
                ordered_keys,
                _visible,
                incomplete_file_ids,
            ) = partition_component_editions(component_ids)
            _genre, category_code = _category_for(representative["genre"])
            title_sort_key = _pinyin_sort_metadata(
                str(
                    representative["display_title"]
                    or representative["source_name"]
                    or "未命名"
                )
            )[0]
            author_sort_key = _pinyin_sort_metadata(
                str(representative["author"] or "佚名")
            )[0]
            for version_rank, edition_key in enumerate(ordered_keys, start=1):
                rows = [
                    row
                    for row in edition_rows_for_allocation[edition_key]
                    if int(row["file_id"]) not in incomplete_file_ids
                ]
                if not rows:
                    raise RuntimeError("Incomplete collapse produced an identity-less edition")
                allocation_items.append(
                    (
                        (
                            category_code,
                            title_sort_key,
                            author_sort_key,
                            version_rank,
                            edition_key,
                        ),
                        edition_key,
                        [int(row["file_id"]) for row in rows],
                        [
                            str(row["normalized_sha256"] or row["raw_sha256"])
                            for row in rows
                        ],
                    )
                )
        claimed_library_ids: set[int] = set()
        for _sort_key, edition_key, edition_file_ids, edition_content_keys in sorted(
            allocation_items, key=lambda item: item[0]
        ):
            library_id = catalog.assign_library_id(
                edition_file_ids,
                edition_content_keys,
                reserved_library_ids=claimed_library_ids,
            )
            allocated_library_ids[edition_key] = library_id
            claimed_library_ids.add(library_id)

    # The materialized current view is one row per file and can be read in one
    # pass.  Only files whose latest completed plan is not itself published
    # need the larger immutable plan-history fallback.
    previous_destinations = catalog.bulk_current_published_destinations()
    missing_previous_ids = [
        file_id for file_id in file_ids if file_id not in previous_destinations
    ]
    if missing_previous_ids:
        historical = catalog.bulk_latest_published_destinations(
            missing_previous_ids if len(missing_previous_ids) <= 10_000 else None
        )
        for file_id in missing_previous_ids:
            destination = historical.get(file_id)
            if destination:
                previous_destinations[file_id] = destination

    work_count = edition_count = source_duplicate_count = incomplete_duplicate_count = 0
    used_destinations: set[Path] = set()
    plan_update_batch: list[tuple[int, Mapping[str, object]]] = []

    def queue_plan_update(file_id: int, fields: Mapping[str, object]) -> None:
        plan_update_batch.append((int(file_id), fields))
        if len(plan_update_batch) >= 1000:
            catalog.set_plans(plan_update_batch)
            plan_update_batch.clear()

    for component_ids in planned_components:
        (
            component_rows,
            representative,
            relation_by_file,
            edition_rows,
            ordered_edition_keys,
            visible_by_edition,
            incomplete_file_ids,
        ) = partition_component_editions(component_ids)
        representative_id = int(representative["file_id"])
        canonical_content_key = str(
            representative["normalized_sha256"] or representative["raw_sha256"]
        )
        representative_title_key = str(representative["title_key"])
        component_aliases: list[str] = [
            str(value) for value in json.loads(str(representative["aliases_json"]))
        ]
        for candidate in component_rows:
            candidate_title = str(candidate["display_title"] or "").strip()
            if (
                candidate_title
                and str(candidate["title_key"]) != representative_title_key
                and candidate_title not in component_aliases
            ):
                component_aliases.append(candidate_title)
            for value in json.loads(str(candidate["aliases_json"])):
                value = str(value).strip()
                if value and value not in component_aliases:
                    component_aliases.append(value)

        if draft:
            library_id_by_edition = {key: 0 for key in ordered_edition_keys}
            version_by_edition = {
                key: version for version, key in enumerate(ordered_edition_keys, start=1)
            }
            draft_anchor = hashlib.sha256(
                "\0".join(str(value) for value in component_ids).encode("ascii")
            ).hexdigest()[:16]
            work_id = f"draft_{draft_anchor}"
        else:
            library_id_by_edition = {
                key: allocated_library_ids[key] for key in ordered_edition_keys
            }
            work_anchor_id = min(library_id_by_edition.values())
            version_by_library_id = catalog.ensure_work_versions(
                work_anchor_id,
                [library_id_by_edition[key] for key in ordered_edition_keys],
            )
            version_by_edition = {
                key: version_by_library_id[library_id_by_edition[key]]
                for key in ordered_edition_keys
            }
            work_id = f"work_{work_anchor_id:06d}"
        canonical_genre, category_code = _category_for(representative["genre"])
        title_sort_key, sort_initial, title_sort_method = _pinyin_sort_metadata(
            str(representative["display_title"] or representative["source_name"] or "未命名")
        )
        author_sort_key, _author_initial, author_sort_method = _pinyin_sort_metadata(
            str(representative["author"] or "佚名")
        )
        sort_method = (
            "pypinyin"
            if title_sort_method == author_sort_method == "pypinyin"
            else "gb18030-fallback"
        )
        destination_by_edition: dict[str, Path] = {}
        for edition_key in ordered_edition_keys:
            library_id = library_id_by_edition[edition_key]
            version = version_by_edition[edition_key]
            destination = Path()
            if not draft:
                destination = _flat_destination(
                    {**dict(representative), "genre": canonical_genre},
                    library_id=library_id,
                    category_code=category_code,
                    version=version,
                )
                if destination in used_destinations:
                    raise RuntimeError(f"Stable library destination collision: {destination}")
                used_destinations.add(destination)
            destination_by_edition[edition_key] = destination

        work_count += 1
        edition_count += len(ordered_edition_keys)
        for edition_key in ordered_edition_keys:
            visible = visible_by_edition[edition_key]
            visible_id = int(visible["file_id"])
            library_id = library_id_by_edition[edition_key]
            version = version_by_edition[edition_key]
            destination = destination_by_edition[edition_key]
            edition_id = f"ed_{str(visible['normalized_sha256'])[:24]}"
            for row in edition_rows[edition_key]:
                file_id = int(row["file_id"])
                relation, evidence = relation_by_file[file_id]
                if file_id == visible_id:
                    action = "canonical" if edition_key == canonical_content_key else "edition"
                    duplicate_of_file_id = None
                    duplicate_kind = ""
                else:
                    action = "source_duplicate"
                    duplicate_of_file_id = visible_id
                    if relation == "incomplete_duplicate":
                        duplicate_kind = relation
                        incomplete_duplicate_count += 1
                    else:
                        duplicate_kind, _auto, evidence = relation_for_ids(
                            visible_id, file_id
                        )
                    source_duplicate_count += 1
                previous_destination = previous_destinations.get(file_id, "")
                plan_fields: dict[str, object] = {
                    "plan_run_id": resolved_run_id,
                    "planned_action": action,
                    "work_id": work_id,
                    "edition_id": edition_id,
                    "duplicate_of_file_id": duplicate_of_file_id,
                    "duplicate_kind": duplicate_kind,
                    "duplicate_evidence_json": json.dumps(
                        evidence, ensure_ascii=False, sort_keys=True
                    ),
                    "library_id": library_id,
                    "category_code": category_code,
                    "edition_version": version,
                    "title_sort_key": title_sort_key,
                    "author_sort_key": author_sort_key,
                    "sort_initial": sort_initial,
                    "sort_method": sort_method,
                    "previous_destination": previous_destination,
                    "raw_destination": "" if draft else str(destination),
                    "work_destination": "" if draft else str(destination),
                }
                if file_id == representative_id:
                    plan_fields["aliases_json"] = json.dumps(
                        component_aliases, ensure_ascii=False
                    )
                queue_plan_update(file_id, plan_fields)

    # Text that cannot be decoded reliably is explicitly rejected. During a
    # confirmed move apply its source is deleted, as requested by the corpus
    # owner, and the reason remains in the index/journal.
    for status in ("quarantine", "invalid"):
        for row in catalog.iter_files(status=status):
            file_id = int(row["file_id"])
            title_sort_key, sort_initial, sort_method = _pinyin_sort_metadata(
                str(row["display_title"] or row["source_name"] or "未命名")
            )
            queue_plan_update(
                file_id,
                {
                    "plan_run_id": resolved_run_id,
                    "planned_action": "delete_invalid",
                    "work_id": "",
                    "edition_id": "",
                    "duplicate_of_file_id": None,
                    "duplicate_kind": status,
                    "duplicate_evidence_json": json.dumps(
                        {"reason": row["scan_error"]},
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    "library_id": 0,
                    "category_code": "99",
                    "edition_version": 0,
                    "title_sort_key": title_sort_key,
                    "author_sort_key": "",
                    "sort_initial": sort_initial,
                    "sort_method": sort_method,
                    "previous_destination": "",
                    "raw_destination": "",
                    "work_destination": "",
                    "apply_status": "",
                    "applied_at": None,
                },
            )

    if plan_update_batch:
        catalog.set_plans(plan_update_batch)
        plan_update_batch.clear()

    frozen_rows = catalog.freeze_plan(resolved_run_id)
    inherited_apply_states = (
        0
        if draft
        else catalog.inherit_completed_apply_states(resolved_run_id)
    )
    run_dir = root / ".state" / "runs" / resolved_run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    plan_path = run_dir / "plan.jsonl"
    review_path = run_dir / "review.jsonl"
    with plan_path.open("w", encoding="utf-8") as plan_handle:
        for row in catalog.plan_rows(resolved_run_id):
            plan_handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True) + "\n")
    with review_path.open("w", encoding="utf-8") as review_handle:
        cursor = catalog.connection.execute(
            """
            SELECT * FROM duplicate_edges
            WHERE plan_run_id=?
              AND (auto_merge=0 OR relation='possible_incomplete')
            ORDER BY left_file_id, right_file_id
            """,
            (resolved_run_id,),
        )
        for row in cursor:
            review_handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True) + "\n")
    summary = {
        "run_id": resolved_run_id,
        "draft": draft,
        "works": work_count,
        "editions": edition_count,
        "source_duplicates": source_duplicate_count,
        "exact_edges": exact_edges,
        "near_edges": near_edges,
        "review_edges": review_edges,
        "review_items": review_edges + possible_incomplete_edges,
        "title_collisions": title_collisions,
        "possible_incomplete_edges": possible_incomplete_edges,
        "incomplete_duplicates": incomplete_duplicate_count,
        "delete_high_confidence_incomplete": delete_high_confidence_incomplete,
        "near_candidate_stats": candidate_stats,
        "library_id_high_watermark": seeded_library_id_high_watermark,
        "planned_files": frozen_rows,
        "inherited_apply_states": inherited_apply_states,
        "plan_path": str(plan_path),
        "review_path": str(review_path),
        "catalog": catalog.stats(),
    }
    _atomic_write_json(run_dir / "summary.json", summary)
    catalog.finish_run(resolved_run_id, "complete", summary)
    return summary


def plan_catalog(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    thresholds: DedupeThresholds | None = None,
    run_id: str | None = None,
    draft: bool = False,
    max_candidate_pair_rows: int | None = 25_000_000,
    delete_high_confidence_incomplete: bool = False,
) -> dict[str, object]:
    """Create a draft dedupe graph or a final publish plan.

    Draft plans deliberately do not allocate permanent library IDs.  Any
    exception rolls back the planning transaction and closes the durable run
    record as failed instead of leaving it permanently ``running``.
    """

    resolved_run_id = run_id or f"plan-{uuid.uuid4().hex[:12]}"
    try:
        return _plan_catalog_impl(
            catalog,
            archive_root,
            thresholds=thresholds,
            run_id=resolved_run_id,
            draft=draft,
            max_candidate_pair_rows=max_candidate_pair_rows,
            delete_high_confidence_incomplete=delete_high_confidence_incomplete,
        )
    except Exception as exc:
        catalog.connection.rollback()
        run = catalog.connection.execute(
            "SELECT phase, status FROM runs WHERE run_id=?", (resolved_run_id,)
        ).fetchone()
        if run is not None and run["phase"] == "plan" and run["status"] == "running":
            catalog.finish_run(
                resolved_run_id,
                "failed",
                {
                    "error": f"{type(exc).__name__}: {exc}",
                    "draft": draft,
                    "delete_high_confidence_incomplete": (
                        delete_high_confidence_incomplete
                    ),
                },
            )
        raise


def enrich_low_confidence_metadata(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    model: str,
    base_url: str = "http://127.0.0.1:8000/v1",
    api_key: str | None = None,
    title_confidence_below: float = 0.80,
    genre_confidence_below: float = 0.55,
    accept_confidence: float = 0.72,
    batch_size: int = 32,
    items_per_request: int = 2,
    candidate_mode: str = "difficult",
    representative_plan_run_id: str | None = None,
    candidate_sample_seed: int | None = None,
    limit: int | None = None,
    run_id: str | None = None,
) -> dict[str, object]:
    """Ask a local OpenAI-compatible vLLM only about ambiguous metadata.

    Model titles must remain close to a rule/header candidate; conflicting
    author guesses are rejected.  The LLM never participates in duplicate
    decisions and cannot cause source deletion.  ``difficult`` mode avoids
    treating the deliberately conservative 0.62 filename-title confidence as
    sufficient reason to send nearly the whole corpus to the model.  A first
    dedupe plan can further restrict inference to its retained representatives.
    """

    from .local_metadata import (
        CANONICAL_GENRES,
        LLM_METADATA_PROMPT_SCHEMA,
        VLLMMetadataClient,
        canonical_name_key,
    )

    resolved_run_id = run_id or f"metadata-llm-{uuid.uuid4().hex[:12]}"
    root = Path(archive_root).resolve()
    if candidate_mode not in {"difficult", "confidence", "sanity"}:
        raise ValueError("candidate_mode must be difficult, confidence, or sanity")
    if items_per_request < 1:
        raise ValueError("items_per_request must be >= 1")
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    if limit is not None and int(limit) < 1:
        raise ValueError("limit must be a positive integer")
    for option_name, option_value in (
        ("title_confidence_below", title_confidence_below),
        ("genre_confidence_below", genre_confidence_below),
        ("accept_confidence", accept_confidence),
    ):
        if not 0.0 <= float(option_value) <= 1.0:
            raise ValueError(f"{option_name} must be between 0 and 1")
    catalog.start_run(
        resolved_run_id,
        "metadata_llm",
        {
            "model": model,
            "base_url": base_url,
            "title_confidence_below": title_confidence_below,
            "genre_confidence_below": genre_confidence_below,
            "accept_confidence": accept_confidence,
            "batch_size": batch_size,
            "items_per_request": items_per_request,
            "candidate_mode": candidate_mode,
            "representative_plan_run_id": representative_plan_run_id,
            "candidate_sample_seed": candidate_sample_seed,
            "limit": limit,
            "prompt_schema": LLM_METADATA_PROMPT_SCHEMA,
        },
    )
    if candidate_mode == "confidence":
        difficulty_sql = "(title_confidence < ? OR genre_confidence < ?)"
        parameters: tuple[object, ...] = (
            title_confidence_below,
            genre_confidence_below,
        )
    elif candidate_mode == "difficult":
        # A blank author is a valid and very common rules result.  Sending all
        # such books to the model made the supposed difficult-only pass nearly
        # corpus-wide.  Escalate author gaps only when the deterministic pass
        # recorded a concrete but unresolved author clue.
        difficulty_sql = (
            "(title_confidence < ? "
            "OR title_key='' OR length(display_title)<2 OR length(display_title)>80 "
            "OR title_evidence_json LIKE '%title:conflicting-strong-candidates=%' "
            "OR title_evidence_json LIKE '%author:conflicting-strong-candidates=%' "
            "OR title_evidence_json LIKE '%author:rejected-implausible-value%' "
            "OR (author='' AND title_evidence_json LIKE "
            "'%author:ambiguous-unlabelled-separator%') "
            "OR (genre_confidence < ? AND genre_evidence_json LIKE "
            "'%genre:no-reliable-rule-match%'))"
        )
        parameters = (
            min(title_confidence_below, 0.60),
            genre_confidence_below,
        )
    else:
        # A narrow post-pass for obviously polluted locked metadata.  Valid
        # cached model results are reusable because prompt inputs are unchanged.
        difficulty_sql = (
            "(length(author)>24 "
            "OR author LIKE '%&lt;%' OR author LIKE '%<br%' "
            "OR author LIKE '%正文%' OR author LIKE '%http%' "
            "OR author LIKE '%敬请%' OR author LIKE '%点击阅读%' "
            "OR lower(author) LIKE '%soushu%' OR lower(author) LIKE '%.com%' "
            "OR lower(author) LIKE '%.org%' OR author LIKE '%搜书%' "
            "OR author LIKE '%网址%' OR author LIKE '%简介：%')"
        )
        parameters = ()
    query = "SELECT file_id FROM files WHERE scan_status='ok' AND " + difficulty_sql
    if representative_plan_run_id:
        # Read the immutable plan snapshot.  ``files.plan_run_id`` is mutable
        # and points only at the latest plan, which made an explicitly selected
        # older representative plan silently match nothing.
        query += (
            " AND EXISTS (SELECT 1 FROM plan_files AS metadata_plan "
            "WHERE metadata_plan.plan_run_id=? "
            "AND metadata_plan.file_id=files.file_id "
            "AND json_extract(metadata_plan.row_json, '$.planned_action') "
            "IN ('canonical','edition'))"
        )
        parameters = (*parameters, representative_plan_run_id)
    if candidate_sample_seed is None:
        query += " ORDER BY file_id"
    else:
        # Deterministic corpus-wide sampling is intended for smoke tests.  It
        # avoids validating a model only against one adjacent source folder or
        # filename convention while keeping the run exactly reproducible.
        query += " ORDER BY ((file_id * 1103515245 + ?) % 2147483647), file_id"
        parameters = (*parameters, int(candidate_sample_seed))
    if limit is not None:
        query += " LIMIT ?"
    if limit is not None:
        parameters = (*parameters, int(limit))
    selected_ids = [
        int(row[0]) for row in catalog.connection.execute(query, parameters)
    ]
    audit_path = root / ".state" / "runs" / resolved_run_id / "results.jsonl"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    accepted = fallback = rejected_title = rejected_author = read_failures = submitted = 0
    rejected_genre = rejected_alias = hard_failures = 0
    changed_records = accepted_no_change = guardrail_only = 0
    cache_hits = cache_misses = cache_writes = 0
    fallback_reasons: dict[str, int] = {}

    def llm_input_signature(row: Mapping[str, object], head: str) -> str:
        """Fingerprint immutable prompt inputs, not fields changed by a prior run."""

        payload = {
            "prompt_schema": LLM_METADATA_PROMPT_SCHEMA,
            "model": model,
            "base_url": base_url.rstrip("/"),
            "content_sha256": str(
                row["normalized_sha256"] or row["raw_sha256"] or ""
            ),
            "encoding": str(row["encoding"] or ""),
            "filename": str(row["source_name"] or ""),
            # The client sends at most the final 400 path characters.
            "path_tail": str(row["source_path"] or "")[-400:],
            "head_sha256": hashlib.sha256(head.encode("utf-8")).hexdigest(),
            "excerpt_bytes": 96 * 1024,
            "excerpt_chars": 900,
        }
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _normalize_evidence_text(value: object) -> str:
        return unicodedata.normalize("NFKC", str(value or "")).casefold()

    generic_author_keys = {
        canonical_name_key(value)
        for value in ("佚名", "未知", "未知作者", "作者不详", "不详", "无名氏")
    }

    def has_input_evidence(value: str, item: Mapping[str, object]) -> bool:
        needle = _normalize_evidence_text(value).strip()
        if not needle:
            return False
        haystack = "\n".join(
            _normalize_evidence_text(item.get(key))
            for key in ("filename", "head_excerpt")
        )
        return needle in haystack

    def has_author_evidence(value: str, item: Mapping[str, object]) -> bool:
        """Require filename/header grounding; generic unknown-author is allowed."""

        author_key = canonical_name_key(value)
        if author_key in generic_author_keys:
            return True
        if not author_key:
            return False
        filename = str(item.get("filename") or "")
        head = str(item.get("head_excerpt") or "")
        labelled = re.compile(
            rf"(?:作者|著者|作者名)\s*[:：=]?\s*{re.escape(value)}",
            re.IGNORECASE,
        )
        if labelled.search(filename) or labelled.search(head):
            return True
        # Avoid one-character coincidences in ordinary prose.
        return len(author_key) >= 2 and (
            author_key in canonical_name_key(filename)
            or author_key in canonical_name_key(head)
        )

    def author_has_strong_rule_evidence(before: Mapping[str, object]) -> bool:
        evidence = [str(value) for value in before.get("title_evidence", [])]
        strong_markers = (
            "author:explicit-marker=",
            "author:spaced-marker=",
            "author:filename-head-confirmed",
            "author:head-candidate-selected",
            "author:supplied-field-preferred",
            "author:standalone-field",
        )
        return any(
            value.startswith(strong_markers)
            or (value.startswith("head:line-") and ":explicit-author=" in value)
            for value in evidence
        )

    def author_is_sane_for_lock(value: str) -> bool:
        """Do not let prose or markup masquerade as an immutable pen name."""

        normalized = unicodedata.normalize("NFKC", value).strip()
        key = canonical_name_key(normalized)
        if not key or len(normalized) > 24 or len(key) > 24:
            return False
        lowered = normalized.casefold()
        return not any(
            marker in lowered
            for marker in (
                "&lt;",
                "<br",
                "</",
                "http://",
                "https://",
                "soushu",
                ".com",
                ".org",
                "搜书",
                "网址",
                "简介：",
                "正文",
                "敬请",
                "点击阅读",
            )
        )

    def metadata_snapshot(row: Mapping[str, object]) -> dict[str, object]:
        return {
            "title": str(row["display_title"] or ""),
            "title_key": str(row["title_key"] or ""),
            "author": str(row["author"] or ""),
            "aliases": json.loads(str(row["aliases_json"] or "[]")),
            "title_confidence": float(row["title_confidence"] or 0.0),
            "title_evidence": json.loads(str(row["title_evidence_json"] or "[]")),
            "genre": str(row["genre"] or DEFAULT_CATEGORY),
            "genre_confidence": float(row["genre_confidence"] or 0.0),
            "genre_tags": json.loads(str(row["genre_tags_json"] or "[]")),
            "genre_evidence": json.loads(str(row["genre_evidence_json"] or "[]")),
        }

    def write_metadata_audit(
        audit,
        row: Mapping[str, object],
        *,
        decision: str,
        before: Mapping[str, object],
        proposal: Mapping[str, object],
        after: Mapping[str, object],
        reasons: Sequence[str],
    ) -> None:
        compared_fields = (
            "title",
            "title_key",
            "author",
            "aliases",
            "title_confidence",
            "genre",
            "genre_confidence",
            "genre_tags",
        )
        changed_fields = [
            field for field in compared_fields if before.get(field) != after.get(field)
        ]
        created_at = utc_now()
        event = {
            "schema_version": "metadata_audit.v2",
            "at": created_at,
            "run_id": resolved_run_id,
            "file_id": int(row["file_id"]),
            "source_path": str(row["source_path"]),
            "decision": decision,
            "changed_fields": changed_fields,
            "reasons": list(dict.fromkeys(str(value) for value in reasons if value)),
            "before": dict(before),
            "proposal": dict(proposal),
            "after": dict(after),
        }
        catalog.record_metadata_event(
            resolved_run_id,
            int(row["file_id"]),
            decision=decision,
            changed_fields=changed_fields,
            reasons=event["reasons"],
            before=before,
            proposal=proposal,
            after=after,
            created_at=created_at,
        )
        audit.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")

    def accept_result(
        row: sqlite3.Row,
        result: Mapping[str, object],
        audit,
        *,
        input_item: Mapping[str, object] | None,
        cache_hit: bool = False,
    ) -> str:
        nonlocal accepted, fallback, rejected_title, rejected_author
        nonlocal rejected_genre, rejected_alias, hard_failures
        nonlocal changed_records, accepted_no_change, guardrail_only
        before = metadata_snapshot(row)
        current_title = str(row["display_title"])
        current_author = str(row["author"] or "")
        current_aliases = [str(value) for value in json.loads(str(row["aliases_json"]))]
        evidence = [str(value) for value in result.get("evidence", [])]
        is_model = result.get("source") == "vllm"
        confidence = float(result.get("confidence") or 0.0)
        if not is_model:
            fallback += 1
            hard_failures += 1
            reasons = [
                value.removeprefix("vllm:fallback:")
                for value in evidence
                if value.startswith("vllm:fallback:")
            ]
            if not reasons:
                reasons = ["invalid-model-result"]
            if cache_hit:
                reasons.append("llm-cache-hit")
            for reason in reasons:
                fallback_reasons[reason] = fallback_reasons.get(reason, 0) + 1
            write_metadata_audit(
                audit,
                row,
                decision="rules_fallback",
                before=before,
                proposal=result,
                after=before,
                reasons=reasons,
            )
            return "rules_fallback"

        field_confidence = result.get("field_confidence") or {}
        if not isinstance(field_confidence, Mapping):
            field_confidence = {}
        title_model_confidence = float(field_confidence.get("title") or confidence)
        author_model_confidence = float(field_confidence.get("author") or 0.0)
        genre_model_confidence = float(field_confidence.get("genre") or confidence)

        proposed_author_value = str(result.get("author") or "").strip()
        if not any(
            (
                title_model_confidence >= accept_confidence,
                bool(proposed_author_value)
                and author_model_confidence >= accept_confidence,
                genre_model_confidence >= accept_confidence,
            )
        ):
            fallback += 1
            fallback_reasons["below-field-accept-confidence"] = (
                fallback_reasons.get("below-field-accept-confidence", 0) + 1
            )
            reasons = ["below-field-accept-confidence"]
            if cache_hit:
                reasons.append("llm-cache-hit")
            write_metadata_audit(
                audit,
                row,
                decision="model_below_threshold",
                before=before,
                proposal=result,
                after=before,
                reasons=reasons,
            )
            return "model_below_threshold"

        title_locked = float(row["title_confidence"] or 0.0) >= 0.80
        genre_locked = float(row["genre_confidence"] or 0.0) >= 0.80

        proposed_title = str(result.get("title") or current_title)
        allowed_title_keys = {
            canonical_name_key(value) for value in [current_title, *current_aliases] if value
        }
        proposed_key = canonical_name_key(proposed_title)
        title_similarity = max(
            (
                SequenceMatcher(None, proposed_key, key, autojunk=False).ratio()
                for key in allowed_title_keys
                if key
            ),
            default=0.0,
        )
        if title_locked:
            if proposed_key != str(row["title_key"]):
                evidence.append("vllm:kept-high-confidence-title")
                rejected_title += 1
            proposed_title = current_title
            proposed_key = str(row["title_key"])
            title_confidence = float(row["title_confidence"] or 0.0)
            title_evidence = list(before["title_evidence"])
        elif title_model_confidence < accept_confidence:
            evidence.append("vllm:rejected-low-confidence-title-field")
            proposed_title = current_title
            proposed_key = str(row["title_key"])
            title_confidence = float(row["title_confidence"] or 0.0)
            title_evidence = list(before["title_evidence"])
            rejected_title += 1
        elif proposed_key not in allowed_title_keys and title_similarity < 0.76:
            evidence.append("vllm:rejected-invented-title")
            proposed_title = current_title
            proposed_key = str(row["title_key"])
            title_confidence = float(row["title_confidence"] or 0.0)
            title_evidence = list(before["title_evidence"])
            rejected_title += 1
        else:
            title_confidence = title_model_confidence
            title_evidence = list(dict.fromkeys([*before["title_evidence"], *evidence]))

        # The batch client preserves a rule value when the raw model returned
        # null so a normal difficult pass does not accidentally erase it.  The
        # explicit evidence marker retains that distinction for this sanity
        # pass, where an already-proven implausible current value should clear.
        model_author_is_null = result.get("author") is None or any(
            value == "vllm:author-null-kept-rule-value" for value in evidence
        )
        proposed_author = proposed_author_value
        if canonical_name_key(proposed_author) in generic_author_keys:
            proposed_author = "佚名"
        current_author_locked = (
            bool(current_author)
            and author_is_sane_for_lock(current_author)
            and author_has_strong_rule_evidence(before)
        )
        if current_author and not author_is_sane_for_lock(current_author):
            evidence.append("vllm:unlocked-implausible-author")
        if current_author_locked:
            if proposed_author != current_author:
                evidence.append("vllm:kept-high-confidence-author")
                rejected_author += 1
            proposed_author = current_author
        elif current_author and model_author_is_null:
            # Unlabelled dash/underscore parsing is intentionally only 0.58
            # confident.  A validated null lets the model remove that weak
            # filename guess; explicit/header authors never enter this branch.
            proposed_author = ""
            evidence.append("vllm:cleared-ambiguous-author")
        elif proposed_author and not author_is_sane_for_lock(proposed_author):
            # A polluted current value may also be repeated verbatim by the
            # model.  Never replace one bad locked author with the same site,
            # prose, or markup payload merely because it is input-grounded.
            evidence.append("vllm:rejected-implausible-model-author")
            proposed_author = (
                current_author if author_is_sane_for_lock(current_author) else ""
            )
            rejected_author += 1
        elif proposed_author and author_model_confidence < accept_confidence:
            evidence.append("vllm:rejected-low-confidence-author-field")
            proposed_author = (
                current_author if author_is_sane_for_lock(current_author) else ""
            )
            rejected_author += 1
        elif proposed_author and (
            input_item is None or not has_author_evidence(proposed_author, input_item)
        ):
            # A model's own prose explanation is not evidence.  A newly added
            # author must literally occur in the filename/header excerpt.
            evidence.append("vllm:rejected-author-without-input-evidence")
            proposed_author = (
                current_author if author_is_sane_for_lock(current_author) else ""
            )
            rejected_author += 1

        aliases: list[str] = []
        for value in current_aliases:
            value = str(value).strip()
            if value and canonical_name_key(value) != proposed_key and value not in aliases:
                aliases.append(value)
        for value in result.get("aliases", []):
            value = str(value).strip()
            if not value or canonical_name_key(value) == proposed_key or value in aliases:
                continue
            if input_item is not None and has_input_evidence(value, input_item):
                aliases.append(value)
            else:
                evidence.append("vllm:rejected-alias-without-input-evidence")
                rejected_alias += 1

        proposed_genre = str(result.get("genre") or row["genre"])
        if genre_locked:
            if proposed_genre != str(row["genre"]):
                evidence.append("vllm:kept-high-confidence-genre")
                rejected_genre += 1
            proposed_genre = str(row["genre"])
            genre_confidence = float(row["genre_confidence"] or 0.0)
            genre_tags = list(before["genre_tags"])
            genre_evidence = list(before["genre_evidence"])
        elif (
            genre_model_confidence < accept_confidence
            or proposed_genre not in CANONICAL_GENRES
        ):
            evidence.append("vllm:rejected-low-confidence-or-invalid-genre-field")
            proposed_genre = str(row["genre"])
            genre_confidence = float(row["genre_confidence"] or 0.0)
            genre_tags = list(before["genre_tags"])
            genre_evidence = list(before["genre_evidence"])
            rejected_genre += 1
        else:
            genre_confidence = genre_model_confidence
            genre_tags = list(result.get("tags") or [])
            genre_evidence = list(dict.fromkeys([*before["genre_evidence"], *evidence]))

        after = {
            "title": proposed_title,
            "title_key": proposed_key,
            "author": proposed_author,
            "aliases": aliases,
            "title_confidence": title_confidence,
            "title_evidence": title_evidence,
            "genre": proposed_genre,
            "genre_confidence": genre_confidence,
            "genre_tags": genre_tags,
            "genre_evidence": genre_evidence,
        }
        catalog.set_plan(
            int(row["file_id"]),
            display_title=after["title"],
            title_key=after["title_key"],
            author=after["author"],
            aliases_json=json.dumps(aliases, ensure_ascii=False),
            title_confidence=after["title_confidence"],
            title_evidence_json=json.dumps(after["title_evidence"], ensure_ascii=False),
            genre=after["genre"],
            genre_confidence=after["genre_confidence"],
            genre_tags_json=json.dumps(after["genre_tags"], ensure_ascii=False),
            genre_evidence_json=json.dumps(after["genre_evidence"], ensure_ascii=False),
        )
        accepted += 1
        rejection_reasons = [
            value.removeprefix("vllm:").replace("-", "_")
            for value in evidence
            if value.startswith("vllm:")
            and any(
                marker in value
                for marker in ("rejected-", "kept-high-confidence", "kept-existing")
            )
        ]
        compared_fields = (
            "title",
            "title_key",
            "author",
            "aliases",
            "title_confidence",
            "genre",
            "genre_confidence",
            "genre_tags",
        )
        metadata_changed = any(
            before.get(field_name) != after.get(field_name)
            for field_name in compared_fields
        )
        if metadata_changed:
            changed_records += 1
        elif rejection_reasons:
            guardrail_only += 1
        else:
            accepted_no_change += 1
        decision = (
            "accepted_with_guardrail"
            if metadata_changed and rejection_reasons
            else "accepted"
            if metadata_changed
            else "rejected_by_guardrails"
            if rejection_reasons
            else "accepted_no_change"
        )
        if cache_hit:
            rejection_reasons.append("llm-cache-hit")
        write_metadata_audit(
            audit,
            row,
            decision=decision,
            before=before,
            proposal=result,
            after=after,
            reasons=rejection_reasons,
        )
        return decision

    read_workers = min(8, max(1, batch_size), max(1, len(selected_ids)))

    def read_llm_item(row: sqlite3.Row) -> dict[str, object]:
        source_path = Path(str(row["source_path"]))
        raw_destination = str(row["raw_destination"] or "")
        archived_path = root / raw_destination if raw_destination else None
        if source_path.is_file():
            readable_path = source_path
            encoding = str(row["encoding"])
        elif archived_path is not None and archived_path.is_file():
            readable_path = archived_path
            # Published raw destinations were normalized by apply_plan.
            encoding = "utf-8"
        else:
            raise FileNotFoundError(
                f"neither source nor archived text exists for file_id={row['file_id']}"
            )
        head = read_head_text(
            readable_path,
            encoding,
            max_bytes=96 * 1024,
        )
        return {
            "id": str(row["file_id"]),
            "filename": row["source_name"],
            "path": row["source_path"],
            "head_excerpt": head,
        }

    try:
        with (
            VLLMMetadataClient(
                model,
                base_url=base_url,
                api_key=api_key,
                # Small multi-book prompts reduce repeated system-prompt overhead;
                # concurrent requests still let vLLM continuously batch on GPU.
                batch_size=items_per_request,
                request_concurrency=batch_size,
                max_excerpt_chars=900,
                max_path_chars=400,
                max_prompt_chars=12_000,
                max_tokens=1536,
            ) as client,
            audit_path.open("w", encoding="utf-8") as audit,
            ThreadPoolExecutor(
                max_workers=read_workers,
                thread_name_prefix="novel-metadata-head",
            ) as read_executor,
        ):
            dispatch_size = max(1, batch_size * items_per_request)
            for start in range(0, len(selected_ids), dispatch_size):
                pending_reads: list[
                    tuple[sqlite3.Row, Future[dict[str, object]]]
                ] = []
                for file_id in selected_ids[start : start + dispatch_size]:
                    row = catalog.get_file(file_id)
                    pending_reads.append(
                        (row, read_executor.submit(read_llm_item, row))
                    )

                batch_rows: list[sqlite3.Row] = []
                batch_items: list[dict[str, object]] = []
                batch_signatures: list[str] = []
                for row, future in pending_reads:
                    try:
                        item = future.result()
                    except (OSError, UnicodeError, LookupError) as exc:
                        read_failures += 1
                        reason = f"{type(exc).__name__}: {exc}"
                        fallback_reasons["head-read-failure"] = (
                            fallback_reasons.get("head-read-failure", 0) + 1
                        )
                        before = metadata_snapshot(row)
                        write_metadata_audit(
                            audit,
                            row,
                            decision="head_read_failure",
                            before=before,
                            proposal={},
                            after=before,
                            reasons=[reason],
                        )
                        continue
                    signature = llm_input_signature(
                        row,
                        str(item.get("head_excerpt") or ""),
                    )
                    cached = catalog.get_llm_metadata_cache(signature)
                    if (
                        cached is not None
                        and cached["model"] == model
                        and cached["prompt_schema"] == LLM_METADATA_PROMPT_SCHEMA
                        and isinstance(cached["result"], Mapping)
                    ):
                        cache_hits += 1
                        cached_result = dict(cached["result"])
                        cached_result["evidence"] = list(
                            dict.fromkeys(
                                [
                                    *cached_result.get("evidence", []),
                                    "vllm:cache-hit",
                                ]
                            )
                        )
                        accept_result(
                            row,
                            cached_result,
                            audit,
                            input_item=item,
                            cache_hit=True,
                        )
                        continue
                    cache_misses += 1
                    batch_rows.append(row)
                    batch_items.append(item)
                    batch_signatures.append(signature)

                if batch_items:
                    submitted += len(batch_items)
                    results = client.enrich_batch(batch_items)
                    if len(results) != len(batch_items):
                        hard_failures += abs(len(batch_items) - len(results))
                    for index, (row, item, signature) in enumerate(
                        zip(batch_rows, batch_items, batch_signatures)
                    ):
                        if index >= len(results):
                            fallback += 1
                            fallback_reasons["missing-client-result"] = (
                                fallback_reasons.get("missing-client-result", 0) + 1
                            )
                            before = metadata_snapshot(row)
                            write_metadata_audit(
                                audit,
                                row,
                                decision="missing_client_result",
                                before=before,
                                proposal={},
                                after=before,
                                reasons=["metadata client returned too few results"],
                            )
                            continue
                        result = results[index]
                        decision = accept_result(
                            row,
                            result,
                            audit,
                            input_item=item,
                        )
                        fallback_evidence = {
                            str(value)
                            for value in result.get("evidence", [])
                            if str(value).startswith("vllm:fallback:")
                        }
                        # Only validated model results are durable cache hits.
                        # Malformed/partial model output must remain retryable;
                        # otherwise one transient bad batch poisons every
                        # subsequent incremental run.
                        if not fallback_evidence and result.get("source") == "vllm":
                            catalog.put_llm_metadata_cache(
                                signature,
                                model=model,
                                prompt_schema=LLM_METADATA_PROMPT_SCHEMA,
                                file_id=int(row["file_id"]),
                                result=result,
                                decision=decision,
                            )
                            cache_writes += 1
                catalog.commit()
        degraded = bool(fallback or read_failures)
        status = "partial" if degraded else "complete"
        summary = {
            "run_id": resolved_run_id,
            "status": status,
            "degraded": degraded,
            "selected": len(selected_ids),
            "candidate_mode": candidate_mode,
            "representative_plan_run_id": representative_plan_run_id,
            "candidate_sample_seed": candidate_sample_seed,
            "request_concurrency": batch_size,
            "read_workers": read_workers,
            "items_per_request": items_per_request,
            "submitted": submitted,
            "accepted": accepted,
            "changed_records": changed_records,
            "accepted_no_change": accepted_no_change,
            "guardrail_only": guardrail_only,
            "fallback": fallback,
            "fallback_reasons": fallback_reasons,
            "read_failures": read_failures,
            "rejected_title": rejected_title,
            "rejected_author": rejected_author,
            "rejected_genre": rejected_genre,
            "rejected_alias": rejected_alias,
            "hard_failures": hard_failures,
            "cache_hits": cache_hits,
            "cache_misses": cache_misses,
            "cache_writes": cache_writes,
            "prompt_schema": LLM_METADATA_PROMPT_SCHEMA,
            "audit_path": str(audit_path),
            "audit_schema": "metadata_audit.v2",
        }
        _atomic_write_json(audit_path.parent / "summary.json", summary)
        catalog.finish_run(resolved_run_id, status, summary)
        return summary
    except Exception:
        catalog.connection.rollback()
        catalog.finish_run(
            resolved_run_id,
            "failed",
            {"selected": len(selected_ids), "submitted": submitted},
        )
        raise


def _atomic_write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(dict(payload), handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


_journal_lock = threading.RLock()


class _DurableJournal:
    """One open JSONL writer with explicit write-ahead durability points."""

    def __init__(self, path: Path, *, batch_size: int = 256) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        created = not self.path.exists()
        self.handle = self.path.open("a", encoding="utf-8")
        self.batch_size = max(1, int(batch_size))
        self.pending = 0
        self.closed = False
        if created:
            # Persist both the new inode and the newly-created run directory.
            # A journal that existed only in page cache cannot serve as a
            # write-ahead deletion record after power loss.
            self.handle.flush()
            os.fsync(self.handle.fileno())
            _fsync_directory(self.path.parent)
            if self.path.parent.parent.is_dir():
                _fsync_directory(self.path.parent.parent)

    def append(self, event: Mapping[str, object], *, force: bool = False) -> None:
        if self.closed:
            raise RuntimeError(f"journal is already closed: {self.path}")
        encoded = json.dumps(dict(event), ensure_ascii=False, sort_keys=True) + "\n"
        with _journal_lock:
            self.handle.write(encoded)
            self.pending += 1
            if force or self.pending >= self.batch_size:
                self.flush()

    def flush(self) -> None:
        with _journal_lock:
            if self.closed:
                return
            if not self.pending:
                return
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.pending = 0

    def close(self) -> None:
        if self.closed:
            return
        self.flush()
        self.handle.close()
        self.closed = True

    def __enter__(self) -> "_DurableJournal":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _append_journal(path: Path, event: Mapping[str, object]) -> None:
    with _DurableJournal(path, batch_size=1) as journal:
        journal.append(event, force=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _signed_identity(value: int) -> int:
    """Map an OS identity into SQLite's signed 64-bit representation."""

    number = int(value)
    if -(1 << 63) <= number < (1 << 63):
        return number
    return ((number + (1 << 63)) % (1 << 64)) - (1 << 63)


def _stat_token(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        _signed_identity(value.st_dev),
        _signed_identity(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
        int(value.st_ctime_ns),
    )


def _regular_file_stat(path: Path, *, purpose: str) -> os.stat_result:
    """Return lstat for a real regular file, refusing all symlinks."""

    value = path.lstat()
    if stat_module.S_ISLNK(value.st_mode) or not stat_module.S_ISREG(value.st_mode):
        raise RuntimeError(f"{purpose} must be a non-symlink regular file: {path}")
    return value


def _regular_file_identity_unchanged(path: Path, expected_sha256: str) -> bool:
    """Hash one stable, non-symlink inode and recheck its directory entry."""

    try:
        before = _regular_file_stat(path, purpose="source")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            if _stat_token(os.fstat(handle.fileno())) != _stat_token(before):
                return False
            while chunk := handle.read(READ_CHUNK_BYTES):
                digest.update(chunk)
            after_handle = os.fstat(handle.fileno())
        after_path = _regular_file_stat(path, purpose="source")
    except (FileNotFoundError, RuntimeError):
        return False
    return (
        _stat_token(before)
        == _stat_token(after_handle)
        == _stat_token(after_path)
        and digest.hexdigest() == expected_sha256
    )


def _strict_validate_source(
    source_path: str,
    *,
    encoding: str,
    expected_raw_sha256: str,
    expected_normalized_sha256: str,
    expected_size_bytes: int,
    expected_mtime_ns: int,
    expected_ctime_ns: int,
    expected_device_id: int,
    expected_inode: int,
    expected_non_whitespace_chars: int,
    expected_line_count: int,
    expected_replacement_chars: int,
) -> StrictSourceValidation:
    """Prove that selected-codec replacements are literal source text.

    A strict decoder cannot manufacture U+FFFD.  The raw/logical hashes and
    counters additionally prove that this is the same file fingerprinted by
    the scan, while the before/descriptor/after stat tokens close mutation
    races during the verification pass.
    """

    source = Path(source_path)
    empty_token = (0, 0, 0, 0, 0)

    def result(status: str, error: str, *, token=empty_token) -> StrictSourceValidation:
        return StrictSourceValidation(
            status=status,
            error=error,
            raw_sha256="",
            normalized_sha256="",
            non_whitespace_chars=0,
            line_count=0,
            literal_replacement_chars=0,
            stat_token=token,
        )

    try:
        before = _regular_file_stat(source, purpose="quality revalidation source")
    except (OSError, RuntimeError) as exc:
        return result("source_changed", f"{type(exc).__name__}: {exc}")
    before_token = _stat_token(before)
    planned_identity = (
        _signed_identity(expected_device_id),
        _signed_identity(expected_inode),
        int(expected_size_bytes),
        int(expected_mtime_ns),
        int(expected_ctime_ns),
    )
    if before_token[2] != planned_identity[2] or before_token[3] != planned_identity[3]:
        return result("source_changed", "source size/mtime differs from catalog", token=before_token)
    if planned_identity[0] and planned_identity[1] and before_token[:2] != planned_identity[:2]:
        return result("source_changed", "source device/inode differs from catalog", token=before_token)
    if planned_identity[4] and before_token[4] != planned_identity[4]:
        return result("source_changed", "source ctime differs from catalog", token=before_token)

    raw_digest = hashlib.sha256()
    normalized_digest = hashlib.sha256()
    decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
    non_whitespace_chars = 0
    line_count = 0
    literal_replacement_chars = 0
    saw_text = False
    ended_with_newline = False

    def consume(text: str) -> None:
        nonlocal non_whitespace_chars, line_count, literal_replacement_chars
        nonlocal saw_text, ended_with_newline
        if not text:
            return
        saw_text = True
        literal_replacement_chars += text.count("\ufffd")
        line_count += text.count("\n")
        ended_with_newline = text.endswith("\n")
        normalized = (
            unicodedata.normalize("NFKC", text)
            .replace("\ufeff", "")
            .replace("\x00", "")
        )
        logical = _LOGICAL_SPACE_RE.sub("", normalized)
        non_whitespace_chars += len(logical)
        normalized_digest.update(logical.encode("utf-8"))

    decode_error = ""
    try:
        with source.open("rb") as handle:
            if _stat_token(os.fstat(handle.fileno())) != before_token:
                return result(
                    "source_changed", "source changed before strict read", token=before_token
                )
            while chunk := handle.read(READ_CHUNK_BYTES):
                raw_digest.update(chunk)
                if not decode_error:
                    try:
                        consume(decoder.decode(chunk, final=False))
                    except UnicodeError as exc:
                        decode_error = f"{type(exc).__name__}: {exc}"
            if not decode_error:
                try:
                    consume(decoder.decode(b"", final=True))
                except UnicodeError as exc:
                    decode_error = f"{type(exc).__name__}: {exc}"
            after_handle = _stat_token(os.fstat(handle.fileno()))
        after_path = _stat_token(
            _regular_file_stat(source, purpose="quality revalidation source")
        )
    except (OSError, RuntimeError) as exc:
        return result(
            "source_changed", f"{type(exc).__name__}: {exc}", token=before_token
        )
    if not (before_token == after_handle == after_path):
        return result(
            "source_changed", "source changed during strict read", token=after_path
        )
    raw_sha256 = raw_digest.hexdigest()
    if raw_sha256 != expected_raw_sha256:
        return StrictSourceValidation(
            status="fingerprint_mismatch",
            error="fingerprint mismatch: raw_sha256",
            raw_sha256=raw_sha256,
            normalized_sha256="",
            non_whitespace_chars=non_whitespace_chars,
            line_count=line_count,
            literal_replacement_chars=literal_replacement_chars,
            stat_token=after_path,
        )
    if decode_error:
        return StrictSourceValidation(
            status="strict_decode_failed",
            error=decode_error,
            raw_sha256=raw_sha256,
            normalized_sha256="",
            non_whitespace_chars=non_whitespace_chars,
            line_count=line_count,
            literal_replacement_chars=literal_replacement_chars,
            stat_token=after_path,
        )
    if saw_text and not ended_with_newline:
        line_count += 1

    normalized_sha256 = normalized_digest.hexdigest()
    mismatches: list[str] = []
    if normalized_sha256 != expected_normalized_sha256:
        mismatches.append("normalized_sha256")
    if non_whitespace_chars != int(expected_non_whitespace_chars):
        mismatches.append("non_whitespace_chars")
    if line_count != int(expected_line_count):
        mismatches.append("line_count")
    if literal_replacement_chars != int(expected_replacement_chars):
        mismatches.append("replacement_chars")
    status = "fingerprint_mismatch" if mismatches else "verified_literal_replacements"
    return StrictSourceValidation(
        status=status,
        error=("fingerprint mismatch: " + ",".join(mismatches)) if mismatches else "",
        raw_sha256=raw_sha256,
        normalized_sha256=normalized_sha256,
        non_whitespace_chars=non_whitespace_chars,
        line_count=line_count,
        literal_replacement_chars=literal_replacement_chars,
        stat_token=after_path,
    )


def _quality_revalidation_payload(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "source_path": str(row["source_path"]),
        "encoding": str(row["encoding"]),
        "expected_raw_sha256": str(row["raw_sha256"]),
        "expected_normalized_sha256": str(row["normalized_sha256"]),
        "expected_size_bytes": int(row["size_bytes"]),
        "expected_mtime_ns": int(row["mtime_ns"]),
        "expected_ctime_ns": int(row.get("ctime_ns") or 0),
        "expected_device_id": int(row.get("device_id") or 0),
        "expected_inode": int(row.get("inode") or 0),
        "expected_non_whitespace_chars": int(row["non_whitespace_chars"]),
        "expected_line_count": int(row["line_count"]),
        "expected_replacement_chars": int(row["replacement_chars"]),
    }


def _strict_validate_quality_payload(
    payload: Mapping[str, object],
) -> StrictSourceValidation:
    values = dict(payload)
    source_path = str(values.pop("source_path"))
    return _strict_validate_source(source_path, **values)


def _stored_source_token(row: Mapping[str, object]) -> tuple[int, int, int, int, int]:
    return (
        int(row.get("device_id") or 0),
        int(row.get("inode") or 0),
        int(row.get("size_bytes") or 0),
        int(row.get("mtime_ns") or 0),
        int(row.get("ctime_ns") or 0),
    )


def _quality_policy_already_applied(row: Mapping[str, object]) -> bool:
    error = str(row.get("scan_error") or "")
    if error.startswith(f"quality_policy={QUALITY_POLICY_VERSION};"):
        marked = True
    else:
        try:
            evidence = json.loads(str(row.get("title_evidence_json") or "[]"))
        except json.JSONDecodeError:
            evidence = []
        marked = any(
            str(item).startswith(f"encoding:{QUALITY_POLICY_VERSION}=")
            for item in evidence
        )
    if not marked:
        return False
    stored = _stored_source_token(row)
    if not all((stored[0], stored[1], stored[4])):
        return False
    try:
        current = _stat_token(
            _regular_file_stat(
                Path(str(row["source_path"])), purpose="quality revalidation source"
            )
        )
    except (OSError, RuntimeError):
        return False
    return current == stored


def _revalidate_quarantined_literals_locked(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    max_literal_replacement_rate: float = MAX_LITERAL_REPLACEMENT_RATE,
    workers: int = 1,
    run_id: str | None = None,
    apply_changes: bool = False,
    limit: int | None = None,
) -> dict[str, object]:
    """Recheck legacy replacement-bearing rows without rescanning the corpus.

    Dry-run mode reads only catalog metadata.  Apply mode strictly decodes only
    high-confidence rows at or below the replacement-rate ceiling.  Existing
    ``ok`` rows can therefore be demoted before destructive publication, while
    verified quarantine rows are promoted and regain their sketch anchors.
    """

    if not 0 <= max_literal_replacement_rate <= 1:
        raise ValueError("max_literal_replacement_rate must be between 0 and 1")
    if workers < 1:
        raise ValueError("workers must be positive")
    if limit is not None and limit < 1:
        raise ValueError("limit must be positive")
    resolved_run_id = run_id or f"quality-{uuid.uuid4().hex[:12]}"
    root = Path(archive_root).resolve()
    catalog.require_new_run_id(resolved_run_id)
    options = {
        "archive_root": str(root),
        "quality_policy": QUALITY_POLICY_VERSION,
        "max_literal_replacement_rate": max_literal_replacement_rate,
        "workers": workers,
        "apply_changes": apply_changes,
        "limit": limit,
    }
    catalog.start_run(resolved_run_id, "quality_revalidation", options)
    rows = [
        dict(row)
        for row in catalog.connection.execute(
            """
            SELECT * FROM files
            WHERE (replacement_chars>0 AND scan_status IN ('ok','quarantine'))
               OR (scan_status='quarantine' AND encoding_confidence='ambiguous')
            ORDER BY file_id
            """
        )
    ]
    selected_rows = rows[:limit] if limit is not None else rows
    run_dir = root / ".state" / "runs" / resolved_run_id
    results_path = run_dir / "results.jsonl"
    counters = {
        "selected": len(selected_rows),
        "total_matching": len(rows),
        "remaining": max(0, len(rows) - len(selected_rows)),
        "strict_eligible": 0,
        "strict_eligible_bytes": 0,
        "strict_checked": 0,
        "already_validated": 0,
        "policy_rejected_without_read": 0,
        "would_demote_without_read": 0,
        "would_remain_quarantine_without_read": 0,
        "promoted": 0,
        "demoted": 0,
        "unchanged_ok": 0,
        "unchanged_quarantine": 0,
        "unresolved": 0,
        "mutations": 0,
    }

    def replacement_rate(row: Mapping[str, object]) -> float:
        return int(row["replacement_chars"]) / max(
            1, int(row["non_whitespace_chars"])
        )

    def eligible(row: Mapping[str, object]) -> bool:
        return bool(
            int(row["replacement_chars"] or 0) > 0
            and str(row["encoding_confidence"]) == "high"
            and replacement_rate(row) <= max_literal_replacement_rate
        )

    for row in selected_rows:
        if eligible(row):
            counters["strict_eligible"] += 1
            counters["strict_eligible_bytes"] += int(row["size_bytes"])

    writer = _DurableJournal(results_path, batch_size=128)

    def persist_decision(
        row: Mapping[str, object],
        validation: StrictSourceValidation | None,
        *,
        no_read_reason: str = "",
    ) -> None:
        before = str(row["scan_status"])
        rate = replacement_rate(row)
        after = before
        decision = ""
        evidence: str | None = None
        scan_error = str(row.get("scan_error") or "")
        token = _stored_source_token(row)
        proposed_after = before

        if validation is None:
            counters["policy_rejected_without_read"] += 1
            decision = no_read_reason or "policy_rejected"
            if before == "ok":
                proposed_after = "quarantine"
                if apply_changes:
                    after = proposed_after
                    counters["demoted"] += 1
                else:
                    counters["would_demote_without_read"] += 1
                scan_error = (
                    f"quality_policy={QUALITY_POLICY_VERSION};decision={decision};"
                    f"encoding={row['encoding']};confidence="
                    f"{row['encoding_confidence']};replacement_rate={rate:.8f}"
                )
            else:
                counters["would_remain_quarantine_without_read"] += int(
                    not apply_changes
                )
                counters["unchanged_quarantine"] += int(apply_changes)
        else:
            counters["strict_checked"] += 1
            token = validation.stat_token if any(validation.stat_token) else token
            if validation.status == "verified_literal_replacements":
                after = "ok"
                decision = "verified_literal_replacements"
                evidence = (
                    f"encoding:{QUALITY_POLICY_VERSION}="
                    f"{row['replacement_chars']};rate={rate:.8f};"
                    f"codec={row['encoding']}"
                )
                scan_error = ""
                if before == "quarantine":
                    counters["promoted"] += 1
                else:
                    counters["unchanged_ok"] += 1
            elif validation.status == "strict_decode_failed":
                after = "quarantine"
                decision = "strict_decode_failed"
                scan_error = (
                    f"quality_policy={QUALITY_POLICY_VERSION};decision={decision};"
                    f"encoding={row['encoding']};replacement_rate={rate:.8f};"
                    f"error={validation.error}"
                )
                if before == "ok":
                    counters["demoted"] += 1
                else:
                    counters["unchanged_quarantine"] += 1
            else:
                after = "unstable"
                decision = validation.status
                counters["unresolved"] += 1
                scan_error = (
                    f"quality_policy={QUALITY_POLICY_VERSION};decision={decision};"
                    f"error={validation.error}"
                )

        if validation is not None:
            proposed_after = after

        event = {
            "at": utc_now(),
            "schema": "local_quality_revalidation.v1",
            "run_id": resolved_run_id,
            "file_id": int(row["file_id"]),
            "source_path": str(row["source_path"]),
            "source_kind": str(row.get("source_kind") or "raw"),
            "before_status": before,
            "after_status": after,
            "proposed_status": proposed_after,
            "decision": decision,
            "encoding": str(row["encoding"]),
            "encoding_confidence": str(row["encoding_confidence"]),
            "replacement_chars": int(row["replacement_chars"]),
            "replacement_rate": rate,
            "size_bytes": int(row["size_bytes"]),
            "strict_validation": validation.to_dict() if validation else None,
            "applied": apply_changes,
        }
        writer.append(event)
        if apply_changes and (after != before or validation is not None):
            catalog.apply_quality_revalidation(
                int(row["file_id"]),
                expected_source_path=str(row["source_path"]),
                expected_raw_sha256=str(row["raw_sha256"]),
                scan_status=after,
                scan_error=scan_error,
                inspected_at=utc_now(),
                stat_token=token,
                evidence=evidence,
            )
            counters["mutations"] += 1

    try:
        strict_rows: list[dict[str, object]] = []
        for row in selected_rows:
            if _quality_policy_already_applied(row):
                counters["already_validated"] += 1
                before = str(row["scan_status"])
                counters[
                    "unchanged_ok" if before == "ok" else "unchanged_quarantine"
                ] += 1
                writer.append(
                    {
                        "at": utc_now(),
                        "schema": "local_quality_revalidation.v1",
                        "run_id": resolved_run_id,
                        "file_id": int(row["file_id"]),
                        "source_path": str(row["source_path"]),
                        "before_status": before,
                        "after_status": before,
                        "decision": "already_validated",
                        "applied": False,
                    }
                )
            elif not eligible(row):
                reason = (
                    "ambiguous_encoding"
                    if str(row["encoding_confidence"]) == "ambiguous"
                    else "replacement_rate_above_limit"
                )
                persist_decision(row, None, no_read_reason=reason)
            elif not apply_changes:
                writer.append(
                    {
                        "at": utc_now(),
                        "schema": "local_quality_revalidation.v1",
                        "run_id": resolved_run_id,
                        "file_id": int(row["file_id"]),
                        "source_path": str(row["source_path"]),
                        "before_status": str(row["scan_status"]),
                        "after_status": str(row["scan_status"]),
                        "decision": "strict_check_required",
                        "encoding": str(row["encoding"]),
                        "replacement_rate": replacement_rate(row),
                        "size_bytes": int(row["size_bytes"]),
                        "applied": False,
                    }
                )
            else:
                strict_rows.append(row)

        if apply_changes and strict_rows:
            if workers == 1:
                for row in strict_rows:
                    persist_decision(
                        row,
                        _strict_validate_quality_payload(
                            _quality_revalidation_payload(row)
                        ),
                    )
            else:
                max_pending = max(2, workers * 2)
                pending: dict[Future[StrictSourceValidation], dict[str, object]] = {}
                with ProcessPoolExecutor(max_workers=workers) as executor:
                    for row in strict_rows:
                        future = executor.submit(
                            _strict_validate_quality_payload,
                            _quality_revalidation_payload(row),
                        )
                        pending[future] = row
                        if len(pending) >= max_pending:
                            done, _ = wait(pending, return_when=FIRST_COMPLETED)
                            for completed in done:
                                persist_decision(
                                    pending.pop(completed), completed.result()
                                )
                    while pending:
                        done, _ = wait(pending, return_when=FIRST_COMPLETED)
                        for completed in done:
                            persist_decision(pending.pop(completed), completed.result())

        writer.close()
        catalog.commit()
        limited = limit is not None and len(selected_rows) < len(rows)
        status = (
            "partial"
            if counters["unresolved"] or limited
            else "complete"
        )
        summary: dict[str, object] = {
            "run_id": resolved_run_id,
            "status": status,
            "dry_run": not apply_changes,
            "quality_policy": QUALITY_POLICY_VERSION,
            "max_literal_replacement_rate": max_literal_replacement_rate,
            "workers": workers,
            "limited": limited,
            **counters,
            "results_path": str(results_path),
        }
        _atomic_write_json(run_dir / "summary.json", summary)
        catalog.finish_run(resolved_run_id, status, summary)
        return summary
    except Exception as exc:
        try:
            writer.close()
        finally:
            catalog.connection.rollback()
            catalog.finish_run(
                resolved_run_id,
                "failed",
                {**counters, "error": f"{type(exc).__name__}: {exc}"},
            )
        raise


def _archive_member_path(
    root: Path,
    value: object,
    *,
    purpose: str,
    allow_final_symlink: bool = False,
) -> Path:
    """Resolve a frozen relative plan path without permitting archive escape."""

    text_value = str(value or "")
    relative = Path(text_value)
    if not text_value or relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"invalid {purpose} path in plan: {text_value!r}")
    candidate = root / relative
    resolved_parent = candidate.parent.resolve(strict=False)
    if not _is_relative_to(resolved_parent, root):
        raise RuntimeError(f"{purpose} escapes archive root: {text_value!r}")
    if not allow_final_symlink and not _is_relative_to(
        candidate.resolve(strict=False), root
    ):
        raise RuntimeError(f"{purpose} escapes archive root: {text_value!r}")
    # A symlinked directory can create aliases and race destination collision
    # checks even when it happens to resolve back inside the archive.
    current = root
    for component in relative.parts[:-1]:
        current /= component
        if current.is_symlink():
            raise RuntimeError(f"{purpose} uses a symlinked directory: {current}")
    return candidate


class _ArchiveFileLock:
    """Cross-process shared/exclusive lock for apply and verify."""

    def __init__(self, root: Path, *, exclusive: bool) -> None:
        self.path = root / ".state" / "archive.lock"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(self.handle.fileno(), operation | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.handle.close()
            mode = "apply" if exclusive else "verify"
            raise RuntimeError(
                f"another archive apply/verify is active; cannot start {mode}: {root}"
            ) from exc

    def __enter__(self) -> "_ArchiveFileLock":
        return self

    def __exit__(self, *_: object) -> None:
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()


def revalidate_quarantined_literals(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    max_literal_replacement_rate: float = MAX_LITERAL_REPLACEMENT_RATE,
    workers: int = 1,
    run_id: str | None = None,
    apply_changes: bool = False,
    limit: int | None = None,
) -> dict[str, object]:
    """Serialize quality-state changes against archive apply and verify."""

    root = Path(archive_root).resolve()
    with _ArchiveFileLock(root, exclusive=True):
        return _revalidate_quarantined_literals_locked(
            catalog,
            root,
            max_literal_replacement_rate=max_literal_replacement_rate,
            workers=workers,
            run_id=run_id,
            apply_changes=apply_changes,
            limit=limit,
        )


def _transfer_raw(
    source: Path,
    destination: Path,
    *,
    expected_hash: str,
    mode: str,
) -> str:
    """Copy or move exact bytes, never overwriting an unrelated destination."""

    if mode not in {"copy", "move"}:
        raise ValueError("transfer mode must be copy or move")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise RuntimeError(f"destination must not be a symlink: {destination}")
    if destination.exists():
        _regular_file_stat(destination, purpose="destination")
        if _sha256_file(destination) != expected_hash:
            raise FileExistsError(f"Destination exists with different bytes: {destination}")
        _fsync_file(destination)
        _fsync_directory(destination.parent)
        if mode == "move" and source.exists():
            if not _regular_file_identity_unchanged(source, expected_hash):
                raise RuntimeError(f"Source changed after scan: {source}")
            source.unlink()
            _fsync_directory(source.parent)
        return "already_present"
    if not source.exists():
        raise FileNotFoundError(f"Neither source nor destination exists: {source}")
    _regular_file_stat(source, purpose="source")

    # Always copy into a new inode, including for ``move``.  A hardlink would
    # let a producer holding the old file open mutate the archived copy after
    # unlink.  The temporary file is fsynced and published without overwrite;
    # only then may the source be removed.
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        digest = hashlib.sha256()
        with source.open("rb") as reader, temporary.open("xb") as writer:
            while True:
                chunk = reader.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if digest.hexdigest() != expected_hash:
            raise RuntimeError(f"Hash changed during transfer: {source}")
        shutil.copystat(source, temporary, follow_symlinks=False)
        _fsync_file(temporary)
        publish_result = "copied"
        try:
            # Temporary and destination share a directory/filesystem, so this
            # creates an atomic no-overwrite publication of the copied inode.
            os.link(temporary, destination)
        except FileExistsError:
            if _sha256_file(destination) != expected_hash:
                raise FileExistsError(
                    f"Destination appeared with different bytes: {destination}"
                )
            publish_result = "already_present"
        temporary.unlink()
        _fsync_file(destination)
        _fsync_directory(destination.parent)
        if mode == "move":
            # Re-read after publication.  If the source changed during the
            # copy, retain both files and require a new scan instead of losing
            # the producer's newer bytes.
            if not _regular_file_identity_unchanged(source, expected_hash):
                raise RuntimeError(f"Source changed during transfer: {source}")
            source.unlink()
            _fsync_directory(source.parent)
            return "moved"
        return publish_result
    finally:
        temporary.unlink(missing_ok=True)


class ConversionError(RuntimeError):
    """The source cannot be represented as verified UTF-8 without a BOM."""


class StrictDecodeError(ConversionError):
    """The selected source codec cannot decode the original bytes strictly."""


class VerificationInvariantError(RuntimeError):
    """Publishing or verification disagreed with the scan invariant."""


def _verify_utf8_no_bom(path: Path, expected_normalized_hash: str) -> None:
    """Strictly decode and compute the normalized digest in one file pass."""

    _regular_file_stat(path, purpose="published destination")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        if handle.read(3) == codecs.BOM_UTF8:
            raise VerificationInvariantError(f"UTF-8 BOM remains in {path}")
        handle.seek(0)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        try:
            while chunk := handle.read(READ_CHUNK_BYTES):
                text = decoder.decode(chunk, final=False)
                if text:
                    normalized = (
                        unicodedata.normalize("NFKC", text)
                        .replace("\ufeff", "")
                        .replace("\x00", "")
                    )
                    digest.update(_LOGICAL_SPACE_RE.sub("", normalized).encode("utf-8"))
            tail = decoder.decode(b"", final=True)
            if tail:
                normalized = (
                    unicodedata.normalize("NFKC", tail)
                    .replace("\ufeff", "")
                    .replace("\x00", "")
                )
                digest.update(_LOGICAL_SPACE_RE.sub("", normalized).encode("utf-8"))
        except UnicodeError as exc:
            raise VerificationInvariantError(f"output is not strict UTF-8: {path}") from exc
    if digest.hexdigest() != expected_normalized_hash:
        raise VerificationInvariantError(
            f"normalized text changed during UTF-8 conversion: {path}"
        )


def _transcode_utf8_no_bom(
    source: Path,
    destination: Path,
    *,
    source_encoding: str,
    expected_raw_hash: str,
    expected_normalized_hash: str,
    mode: str,
) -> str:
    """Publish strict UTF-8 without BOM, then optionally delete the source."""

    if mode not in {"copy", "move"}:
        raise ValueError("transfer mode must be copy or move")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise RuntimeError(f"destination must not be a symlink: {destination}")
    if destination.exists():
        _regular_file_stat(destination, purpose="destination")
        try:
            _verify_utf8_no_bom(destination, expected_normalized_hash)
        except VerificationInvariantError as exc:
            raise FileExistsError(
                f"Destination exists but is not this converted book: {destination}"
            ) from exc
        if mode == "copy":
            if not _regular_file_identity_unchanged(source, expected_raw_hash):
                raise RuntimeError(f"Copy-mode source is missing or changed: {source}")
        elif source.exists():
            if not _regular_file_identity_unchanged(source, expected_raw_hash):
                raise RuntimeError(f"Source changed after scan: {source}")
            source.unlink()
            _fsync_directory(source.parent)
            return "moved"
        return "already_present"
    if not source.exists():
        raise FileNotFoundError(f"Neither source nor converted destination exists: {source}")
    source_before = _regular_file_stat(source, purpose="source")

    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    decoder = codecs.getincrementaldecoder(source_encoding)(errors="strict")
    first_text = True
    raw_digest = hashlib.sha256()
    normalized_digest = hashlib.sha256()
    try:
        try:
            with source.open("rb") as reader, temporary.open("xb") as writer:
                if _stat_token(os.fstat(reader.fileno())) != _stat_token(source_before):
                    raise RuntimeError(f"Source changed before conversion: {source}")
                while chunk := reader.read(READ_CHUNK_BYTES):
                    raw_digest.update(chunk)
                    text = decoder.decode(chunk, final=False)
                    normalized = (
                        unicodedata.normalize("NFKC", text)
                        .replace("\ufeff", "")
                        .replace("\x00", "")
                    )
                    normalized_digest.update(
                        _LOGICAL_SPACE_RE.sub("", normalized).encode("utf-8")
                    )
                    if first_text:
                        text = text.removeprefix("\ufeff")
                        first_text = False
                    writer.write(text.encode("utf-8"))
                tail = decoder.decode(b"", final=True)
                if tail:
                    normalized = (
                        unicodedata.normalize("NFKC", tail)
                        .replace("\ufeff", "")
                        .replace("\x00", "")
                    )
                    normalized_digest.update(
                        _LOGICAL_SPACE_RE.sub("", normalized).encode("utf-8")
                    )
                if first_text:
                    tail = tail.removeprefix("\ufeff")
                writer.write(tail.encode("utf-8"))
                source_after = os.fstat(reader.fileno())
                path_after = _regular_file_stat(source, purpose="source")
                if not (
                    _stat_token(source_before)
                    == _stat_token(source_after)
                    == _stat_token(path_after)
                ):
                    raise RuntimeError(f"Source changed during conversion: {source}")
                if raw_digest.hexdigest() != expected_raw_hash:
                    raise RuntimeError(f"Source changed after scan: {source}")
                if normalized_digest.hexdigest() != expected_normalized_hash:
                    raise VerificationInvariantError(
                        f"source normalized hash disagrees with scan: {source}"
                    )
                writer.flush()
                os.fsync(writer.fileno())
        except UnicodeError as exc:
            raise StrictDecodeError(
                f"strict decode failed for encoding {source_encoding}: {source}"
            ) from exc
        try:
            os.link(temporary, destination)
        except FileExistsError:
            try:
                _verify_utf8_no_bom(destination, expected_normalized_hash)
            except VerificationInvariantError as exc:
                raise FileExistsError(
                    f"Destination appeared with different content: {destination}"
                ) from exc
        temporary.unlink()
        _fsync_directory(destination.parent)
        if mode == "move":
            if _stat_token(_regular_file_stat(source, purpose="source")) != _stat_token(
                source_after
            ):
                raise RuntimeError(f"Source changed during conversion: {source}")
            source.unlink()
            _fsync_directory(source.parent)
            return "moved"
        return "converted"
    finally:
        temporary.unlink(missing_ok=True)


def _relocate_existing_utf8(
    previous: Path,
    destination: Path,
    *,
    expected_normalized_hash: str,
    remove_previous: bool,
) -> str:
    """Safely migrate a previously published flat-library path to a new name."""

    if previous == destination:
        _verify_utf8_no_bom(destination, expected_normalized_hash)
        return "already_present"
    _verify_utf8_no_bom(previous, expected_normalized_hash)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise RuntimeError(f"destination must not be a symlink: {destination}")
    if destination.exists():
        _regular_file_stat(destination, purpose="destination")
        _verify_utf8_no_bom(destination, expected_normalized_hash)
    else:
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            with previous.open("rb") as reader, temporary.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            _verify_utf8_no_bom(temporary, expected_normalized_hash)
            try:
                os.link(temporary, destination)
            except FileExistsError:
                _verify_utf8_no_bom(destination, expected_normalized_hash)
            temporary.unlink()
            _fsync_file(destination)
            _fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)
    if remove_previous:
        previous.unlink(missing_ok=True)
        _fsync_directory(previous.parent)
        return "migrated_existing"
    return "copied_existing"


def _remove_stale_previous_destination(
    previous: Path,
    destination: Path,
    *,
    expected_normalized_hash: str,
) -> bool:
    if previous == destination or not previous.is_file():
        return False
    _regular_file_stat(previous, purpose="previous destination")
    _regular_file_stat(destination, purpose="destination")
    _verify_utf8_no_bom(previous, expected_normalized_hash)
    _verify_utf8_no_bom(destination, expected_normalized_hash)
    previous.unlink()
    _fsync_directory(previous.parent)
    return True


def _write_flat_index(
    catalog: LocalNovelCatalog,
    root: Path,
    plan_run_id: str,
) -> Path:
    """Atomically publish the complete, line-oriented library index."""

    destination = root / "index.jsonl"
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        for row in catalog.plan_rows(plan_run_id, index_order=True):
            import_status = str(row["apply_status"] or "pending")
            # The public index is a book/edition catalog, not a source ledger.
            # Duplicate and rejected sources remain fully available in SQLite,
            # the immutable plan and the final audit artifacts.
            if row["planned_action"] not in {"canonical", "edition"}:
                continue
            if import_status != "complete":
                continue
            rejected = import_status in {
                "deleted_invalid",
                "invalid_rejected",
                "deleted_conversion_failure",
                "conversion_rejected",
            }
            library_id = int(row.get("library_id") or 0)
            category_code = str(row.get("category_code") or "99")
            visible_file = None if rejected else row["raw_destination"]
            visible_genre = str(row.get("genre") or DEFAULT_CATEGORY)
            if visible_file:
                parts = Path(str(visible_file)).parts
                if parts:
                    visible_genre = parts[0]
            payload = {
                "schema": "literary-giant-flat-index-v3",
                "file_id": row["file_id"],
                "file": visible_file,
                "library_id": library_id or None,
                "book_id": f"id{library_id:06d}" if library_id else None,
                "catalog_id": (
                    f"{category_code}_id{library_id:06d}" if library_id else None
                ),
                "category_code": category_code,
                "edition_version": int(row.get("edition_version") or 0),
                "content_id": f"id{library_id:06d}" if library_id else None,
                "edition_key": row["edition_id"],
                "title": row["display_title"],
                "author": row["author"] or "佚名",
                "aliases": json.loads(str(row["aliases_json"])),
                "genre": visible_genre,
                "tags": json.loads(str(row["genre_tags_json"])),
                "sort_initial": str(row.get("sort_initial") or "#"),
                "title_sort_key": str(row.get("title_sort_key") or ""),
                "author_sort_key": str(row.get("author_sort_key") or ""),
                "sort_method": str(row.get("sort_method") or "legacy-file-id"),
                "work_id": row["work_id"],
                "edition_id": row["edition_id"],
                "action": row["planned_action"],
                "duplicate_of_file_id": row["duplicate_of_file_id"],
                "duplicate_kind": row["duplicate_kind"],
                "source_root": row["source_root"],
                "source_priority": int(row.get("source_priority") or 0),
                "source_kind": str(row.get("source_kind") or "raw"),
                "source_relative_path": row["relative_path"],
                "raw_sha256": row["raw_sha256"],
                "normalized_sha256": row["normalized_sha256"],
                "source_encoding": row["encoding"],
                "encoding": None if rejected else "utf-8",
                "utf8_bom": False if not rejected else None,
                "import_status": import_status,
                "rejection_reason": row["scan_error"] if rejected else "",
                "characters": row["non_whitespace_chars"],
            }
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, destination)
    _fsync_directory(root)
    return destination


def _apply_plan_locked(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    plan_run_id: str | None = None,
    transfer_mode: str = "copy",
    confirm_transfer_complete: bool = False,
    stability_snapshot: SourceSnapshot | None = None,
    limit: int | None = None,
    raw_only: bool = False,
    workers: int = 1,
    preserve_existing_processed: bool = False,
) -> dict[str, object]:
    """Apply a plan after explicit transfer-complete confirmation.

    ``copy`` is useful for smoke testing; ``move`` additionally requires a
    matching source snapshot with no active upload markers.
    """

    if transfer_mode not in {"copy", "move"}:
        raise ValueError("transfer_mode must be copy or move")
    if limit is not None and limit < 1:
        raise ValueError("limit must be a positive integer")
    if workers < 1:
        raise ValueError("workers must be a positive integer")
    if preserve_existing_processed and transfer_mode != "move":
        raise ValueError("preserve_existing_processed is valid only in move mode")
    root = Path(archive_root).resolve()
    resolved_plan_id = plan_run_id or catalog.latest_plan_run_id()
    if not resolved_plan_id:
        raise RuntimeError("No completed plan is available")
    planned_count = catalog.require_plan(resolved_plan_id)
    plan_mode = catalog.connection.execute(
        "SELECT json_extract(summary_json, '$.draft') FROM runs WHERE run_id=?",
        (resolved_plan_id,),
    ).fetchone()
    if plan_mode is not None and bool(plan_mode[0]):
        raise RuntimeError(
            "Draft plans select LLM representatives only and cannot be applied; "
            "run a final non-draft plan after metadata enrichment"
        )
    if not confirm_transfer_complete:
        raise RuntimeError("Apply requires explicit confirm_transfer_complete=True")
    if transfer_mode == "move":
        if stability_snapshot is None:
            raise RuntimeError("Move apply requires a previously saved stability snapshot")
        planned_roots = {
            str(Path(value).resolve())
            for value in catalog.plan_source_roots(resolved_plan_id)
        }
        snapshot_roots = {str(Path(value).resolve()) for value in stability_snapshot.roots}
        missing_roots = sorted(planned_roots - snapshot_roots)
        if missing_roots:
            raise RuntimeError(
                "Move snapshot does not cover every planned source root: "
                + ", ".join(missing_roots)
            )
        current = snapshot_sources(stability_snapshot.roots)
        if not snapshots_match(stability_snapshot, current):
            raise RuntimeError(
                "Source tree differs from the saved stable snapshot or still has upload markers"
            )
        planned_paths: set[Path] = set()
        missing_without_archive: list[str] = []
        for row in catalog.plan_rows(resolved_plan_id):
            source_path = Path(str(row["source_path"])).resolve()
            planned_paths.add(source_path)
            # A resumed move is expected to find no source or destination for
            # rows whose only valid outcome was deletion.  Requiring those
            # paths to exist makes every completed invalid-file deletion
            # prevent a subsequent resume before the apply run can start.
            if str(row.get("raw_transfer_state") or "") in {
                "invalid_deleted",
                "conversion_failed_deleted",
            }:
                continue
            raw_value = str(row["raw_destination"] or "")
            raw_path = (
                _archive_member_path(
                    root,
                    raw_value,
                    purpose="destination",
                    allow_final_symlink=True,
                )
                if raw_value
                else None
            )
            previous_value = str(row.get("previous_destination") or "")
            previous_path = (
                _archive_member_path(
                    root,
                    previous_value,
                    purpose="previous destination",
                    allow_final_symlink=True,
                )
                if previous_value
                else None
            )
            if (
                not source_path.exists()
                and not (raw_path and raw_path.exists())
                and not (previous_path and previous_path.exists())
            ):
                if len(missing_without_archive) < 20:
                    missing_without_archive.append(str(source_path))
        current_paths = {
            entry.path
            for entry in iter_source_entries(
                stability_snapshot.roots,
                archive_root=root,
            )
        }
        extra_paths = sorted(str(path) for path in current_paths - planned_paths)
        if extra_paths:
            raise RuntimeError(
                "Stable snapshot contains TXT files absent from the plan; rescan before move: "
                + ", ".join(extra_paths[:20])
            )
        if missing_without_archive:
            raise RuntimeError(
                "Planned TXT files are missing from both source and Noise: "
                + ", ".join(missing_without_archive)
            )

    apply_run_id = f"apply-{uuid.uuid4().hex[:12]}"
    catalog.start_run(
        apply_run_id,
        "apply",
        {
            "plan_run_id": resolved_plan_id,
            "archive_root": str(root),
            "transfer_mode": transfer_mode,
            "limit": limit,
            "raw_only": raw_only,
            "workers": workers,
            "preserve_existing_processed": preserve_existing_processed,
            "planned_count": planned_count,
        },
    )
    journal = root / ".state" / "runs" / apply_run_id / "journal.jsonl"
    counters = {
        "processed": 0,
        "raw_transferred": 0,
        "duplicates_removed": 0,
        "converted_utf8": 0,
        "migrated_existing": 0,
        "preserved_existing_processed": 0,
        "invalid_deleted": 0,
        "conversion_failed_deleted": 0,
        "rejected_in_copy_mode": 0,
        "editions_written": 0,  # compatibility: flat layout has no second edition copy
        "skipped": 0,
        "failed": 0,
    }
    verified_targets: dict[
        tuple[str, str], tuple[int, int, int, int, int]
    ] = {}
    source_checks: dict[
        tuple[str, str], tuple[tuple[int, int, int, int, int], bool]
    ] = {}

    @lru_cache(maxsize=4096)
    def duplicate_target(file_id: int) -> dict[str, object]:
        return catalog.get_plan_file(resolved_plan_id, int(file_id))

    def target_identity(
        row: Mapping[str, object], *, required: bool
    ) -> tuple[Path, str] | None:
        action = str(row.get("planned_action") or "")
        if action == "delete_invalid":
            return None
        destination = _archive_member_path(
            root, row.get("raw_destination"), purpose="destination"
        )
        expected_hash = str(row.get("normalized_sha256") or "")
        if action == "source_duplicate":
            target_file_id = int(row.get("duplicate_of_file_id") or 0)
            if not target_file_id:
                if required:
                    raise RuntimeError("duplicate plan row has no target file id")
                return None
            target = duplicate_target(target_file_id)
            expected_hash = str(target.get("normalized_sha256") or "")
        if not expected_hash:
            if required:
                raise RuntimeError("publishable plan row has no normalized hash")
            return None
        return destination, expected_hash

    def target_is_verified(row: Mapping[str, object], *, required: bool = False) -> bool:
        try:
            identity = target_identity(row, required=required)
            if identity is None:
                return False
            destination, expected_hash = identity
            before = _regular_file_stat(destination, purpose="published destination")
            token = _stat_token(before)
            key = (str(destination), expected_hash)
            # A duplicate row points at the representative's destination but
            # has no destination token of its own until deletion completes.
            # Reuse the representative row's persisted publication token. An
            # exact dev/inode/size/mtime/ctime match proves this is still the
            # inode whose normalized content was verified at publication;
            # only a changed/legacy token needs another full-file hash pass.
            token_owner = row
            if str(row.get("planned_action") or "") == "source_duplicate":
                target_file_id = int(row.get("duplicate_of_file_id") or 0)
                if target_file_id:
                    token_owner = duplicate_target(target_file_id)
            stored_token = (
                int(token_owner.get("destination_device_id") or 0),
                int(token_owner.get("destination_inode") or 0),
                int(token_owner.get("destination_size_bytes") or 0),
                int(token_owner.get("destination_mtime_ns") or 0),
                int(token_owner.get("destination_ctime_ns") or 0),
            )
            # A persisted all-zero token means this state predates schema v10.
            # lstat is still mandatory (and rejects symlinks), but an exact
            # non-empty token match proves this is the inode whose content was
            # verified when apply last published it.
            if any(stored_token) and stored_token == token:
                verified_targets[key] = token
                return True
            if verified_targets.get(key) != token:
                _verify_utf8_no_bom(destination, expected_hash)
                after = _regular_file_stat(
                    destination, purpose="published destination"
                )
                if _stat_token(after) != token:
                    raise RuntimeError(
                        f"published destination changed during verification: {destination}"
                    )
                verified_targets[key] = token
            catalog.set_plan_destination_stat_token(
                resolved_plan_id,
                int(row["file_id"]),
                token,
            )
            return True
        except (FileNotFoundError, OSError, RuntimeError, VerificationInvariantError):
            if required:
                raise
            return False

    def source_matches_plan(row: Mapping[str, object]) -> bool:
        source = Path(str(row.get("source_path") or ""))
        expected_hash = str(row.get("raw_sha256") or "")
        try:
            token = _stat_token(_regular_file_stat(source, purpose="source"))
        except (FileNotFoundError, OSError, RuntimeError):
            return False
        key = (str(source), expected_hash)
        cached = source_checks.get(key)
        if cached is not None and cached[0] == token:
            return cached[1]
        planned_token = (
            int(row.get("device_id") or 0),
            int(row.get("inode") or 0),
            int(row.get("size_bytes") or 0),
            int(row.get("mtime_ns") or 0),
            int(row.get("ctime_ns") or 0),
        )
        # Only schema-v8+ snapshots with the stronger inode/ctime identity are
        # eligible.  Legacy size/mtime-only snapshots deliberately fall back
        # to hashing instead of being treated as trustworthy.
        if (
            planned_token[1] != 0
            and planned_token[4] != 0
            and planned_token == token
        ):
            source_checks[key] = (token, True)
            return True
        matches = _regular_file_identity_unchanged(source, expected_hash)
        source_checks[key] = (token, matches)
        return matches

    def preserves_source(row: Mapping[str, object]) -> bool:
        return bool(
            preserve_existing_processed
            and str(row.get("source_kind") or "") == "existing_processed"
        )

    def stale_previous_is_absent(row: Mapping[str, object]) -> bool:
        if transfer_mode != "move":
            return True
        previous_value = str(row.get("previous_destination") or "")
        if not previous_value:
            return True
        try:
            previous = _archive_member_path(
                root,
                previous_value,
                purpose="previous destination",
                allow_final_symlink=True,
            )
            identity = target_identity(row, required=False)
            if identity is not None and previous == identity[0]:
                return True
            return not os.path.lexists(previous)
        except RuntimeError:
            return False

    def row_satisfies_target(row: Mapping[str, object]) -> bool:
        raw_state = str(row.get("raw_transfer_state") or "")
        action = str(row.get("planned_action") or "")
        if action == "delete_invalid":
            if raw_state == "invalid_preserved":
                return preserves_source(row) and source_matches_plan(row)
            if raw_state == "invalid_deleted":
                return True
            return (
                transfer_mode == "copy"
                and raw_state == "invalid_rejected"
                and source_matches_plan(row)
            )
        if raw_state in {"conversion_failed_deleted", "conversion_rejected"}:
            if raw_state == "conversion_failed_deleted":
                return True
            return (
                transfer_mode == "copy"
                and raw_state == "conversion_rejected"
                and source_matches_plan(row)
            )
        duplicate = action == "source_duplicate"
        if duplicate:
            if raw_state == "source_duplicate_preserved":
                return (
                    preserves_source(row)
                    and source_matches_plan(row)
                    and target_is_verified(row)
                    and stale_previous_is_absent(row)
                )
            if raw_state == "deduplicated":
                return target_is_verified(row) and stale_previous_is_absent(row)
            return (
                transfer_mode == "copy"
                and raw_state == "indexed_duplicate"
                and source_matches_plan(row)
                and target_is_verified(row)
            )
        if raw_state == "moved":
            return target_is_verified(row) and stale_previous_is_absent(row)
        if raw_state == "source_preserved":
            return (
                preserves_source(row)
                and source_matches_plan(row)
                and target_is_verified(row)
                and stale_previous_is_absent(row)
            )
        return (
            transfer_mode == "copy"
            and raw_state == "converted"
            and source_matches_plan(row)
            and target_is_verified(row)
        )

    already_satisfied = sum(
        1 for row in catalog.plan_rows(resolved_plan_id) if row_satisfies_target(row)
    )
    try:
        journal_writer = _DurableJournal(journal, batch_size=256)
    except Exception as exc:
        catalog.finish_run(
            apply_run_id,
            "failed",
            {**counters, "journal": str(journal), "error": f"{type(exc).__name__}: {exc}"},
        )
        raise
    recorded_delete_intents: set[tuple[int, str]] = set()
    dirty_delete_directories: set[Path] = set()

    def unlink_for_batched_commit(path: Path) -> None:
        """Unlink now and persist its parent before the next DB commit.

        Syncing a remote directory after every individual duplicate makes the
        operation latency-bound.  The durable delete manifest is already
        flushed before mutation starts, so it is safe to group directory
        fsyncs as long as every group is persisted before its matching SQLite
        status transaction is committed.
        """

        path.unlink()
        dirty_delete_directories.add(path.parent)

    def sync_deleted_directories() -> None:
        for directory in sorted(dirty_delete_directories, key=str):
            _fsync_directory(directory)
        dirty_delete_directories.clear()

    def flush_apply_batch() -> None:
        # Persist filesystem mutations first, then their completion audit and
        # finally the SQLite statuses.  A crash can therefore only leave
        # uncommitted work to rediscover; it cannot commit a deletion status
        # whose directory entry was not made durable.
        sync_deleted_directories()
        journal_writer.flush()
        catalog.commit()

    def record_delete_intent(
        row: Mapping[str, object],
        path: Path,
        reason: str,
        *,
        force: bool = False,
    ) -> None:
        key = (int(row["file_id"]), str(path))
        if key in recorded_delete_intents:
            return
        journal_writer.append(
            {
                "at": utc_now(),
                "operation": "delete_intent",
                "file_id": int(row["file_id"]),
                "source": str(path),
                "raw_sha256": str(row.get("raw_sha256") or ""),
                "reason": reason,
            },
            force=force,
        )
        recorded_delete_intents.add(key)

    # One sequential, durable write-ahead manifest protects every destructive
    # operation without paying one journal fsync per file.  A completion event
    # later distinguishes performed deletions from merely scheduled ones.
    def write_delete_manifest() -> None:
        if transfer_mode != "move":
            return
        scheduled = 0
        for intent_row in catalog.plan_rows(
            resolved_plan_id, source_duplicates_last=True
        ):
            if not intent_row["planned_action"] or row_satisfies_target(intent_row):
                continue
            if limit is not None and scheduled >= limit:
                break
            scheduled += 1
            intent_source = Path(str(intent_row["source_path"]))
            previous_value = str(intent_row.get("previous_destination") or "")
            reason = {
                "delete_invalid": "scan_rejected_invalid_or_quarantined_text",
                "source_duplicate": "content_preserved_by_verified_representative",
            }.get(
                str(intent_row["planned_action"]),
                "source_removed_after_verified_utf8_publication",
            )
            # Record every *potential* path even when it is already absent.
            # This closes the race where a producer recreates it after the
            # prepass but before the destructive operation.
            if not preserves_source(intent_row):
                record_delete_intent(intent_row, intent_source, reason)
            if previous_value:
                previous_path = _archive_member_path(
                    root, previous_value, purpose="previous destination"
                )
                record_delete_intent(
                    intent_row,
                    previous_path,
                    "superseded_published_destination",
                )
        journal_writer.flush()

    parallel_attempted: set[int] = set()

    def finish_parallel_publish(
        future: Future[str], row: Mapping[str, object]
    ) -> BaseException | None:
        """Serialize status/audit updates for one worker-owned publication."""

        file_id = int(row["file_id"])
        source = Path(str(row["source_path"]))
        raw_destination = _archive_member_path(
            root, row["raw_destination"], purpose="destination"
        )
        parallel_attempted.add(file_id)
        counters["processed"] += 1
        try:
            raw_result = future.result()
            destination_stat_token = _stat_token(
                _regular_file_stat(
                    raw_destination,
                    purpose="published destination",
                )
            )
            counters["raw_transferred"] += int(raw_result != "already_present")
            counters["converted_utf8"] += int(raw_result in {"converted", "moved"})
            # These rows have no previous archive path. _transcode enforces a
            # preserved, identical source in copy mode and removes it only in
            # move mode, so no second full source hash is needed here.
            source_preserved = preserves_source(row)
            recorded_state = (
                "source_preserved"
                if source_preserved
                else ("moved" if transfer_mode == "move" else "converted")
            )
            counters["preserved_existing_processed"] += int(source_preserved)
            journal_writer.append(
                {
                    "at": utc_now(),
                    "operation": "utf8_publish_or_reject",
                    "result": raw_result,
                    "file_id": file_id,
                    "source": str(source),
                    "previous_destination": "",
                    "destination": str(raw_destination),
                    "raw_sha256": row["raw_sha256"],
                    "parallel": True,
                }
            )
            catalog.set_plan_apply_status(
                resolved_plan_id,
                file_id,
                apply_status="complete",
                raw_transfer_state=recorded_state,
                applied_at=utc_now(),
                destination_stat_token=destination_stat_token,
            )
        except StrictDecodeError as exc:
            if source.exists() and not source_matches_plan(row):
                exc = RuntimeError(
                    f"Source changed after failed conversion: {source}"
                )
            else:
                if transfer_mode == "move" and not preserves_source(row):
                    if source.exists():
                        journal_writer.append(
                            {
                                "at": utc_now(),
                                "operation": "delete_intent_update",
                                "file_id": file_id,
                                "source": str(source),
                                "raw_sha256": str(row["raw_sha256"]),
                                "reason": "strict_source_decode_failure",
                                "error": f"{type(exc).__name__}: {exc}",
                            },
                            force=True,
                        )
                        unlink_for_batched_commit(source)
                    raw_result = "conversion_failed_deleted"
                    apply_status = "deleted_conversion_failure"
                    counters["conversion_failed_deleted"] += 1
                else:
                    raw_result = "conversion_rejected"
                    apply_status = "conversion_rejected"
                    counters["rejected_in_copy_mode"] += 1
                catalog.set_plan_apply_status(
                    resolved_plan_id,
                    file_id,
                    apply_status=apply_status,
                    raw_transfer_state=raw_result,
                    applied_at=utc_now(),
                )
                journal_writer.append(
                    {
                        "at": utc_now(),
                        "operation": raw_result,
                        "file_id": file_id,
                        "source": str(source),
                        "error": f"{type(exc).__name__}: {exc}",
                        "parallel": True,
                    }
                )
                exc = None
            if exc is None:
                if counters["processed"] % 256 == 0:
                    flush_apply_batch()
                return None
            # A changed source is a normal per-file failure, handled below.
            counters["failed"] += 1
            catalog.set_plan_apply_status(
                resolved_plan_id,
                file_id,
                apply_status=f"failed:{type(exc).__name__}",
                applied_at=None,
            )
            journal_writer.append(
                {
                    "at": utc_now(),
                    "operation": "error",
                    "file_id": file_id,
                    "error": f"{type(exc).__name__}: {exc}",
                    "parallel": True,
                }
            )
            logger.error("Parallel apply failed for %s: %s", source, exc)
            return None
        except Exception as exc:
            counters["failed"] += 1
            catalog.set_plan_apply_status(
                resolved_plan_id,
                file_id,
                apply_status=f"failed:{type(exc).__name__}",
                applied_at=None,
            )
            journal_writer.append(
                {
                    "at": utc_now(),
                    "operation": "error",
                    "file_id": file_id,
                    "error": f"{type(exc).__name__}: {exc}",
                    "parallel": True,
                }
            )
            logger.exception("Parallel apply failed for %s", source, exc_info=exc)
            if isinstance(exc, OSError) and exc.errno in {
                errno.ENOSPC,
                errno.EROFS,
                errno.EIO,
            }:
                return exc
        if counters["processed"] % 256 == 0:
            flush_apply_batch()
        return None

    def publish_independent_rows_in_parallel() -> None:
        """Parallelize only independent canonical/edition first publications.

        Rows with an old destination, rejected input, or duplicate dependency
        remain on the coordinator path. This gives the large first import most
        of the throughput benefit without weakening ordering or SQLite safety.
        """

        if workers <= 1:
            return
        max_pending = max(2, workers * 2)
        pending: dict[Future[str], dict[str, object]] = {}
        selected = 0
        fatal: BaseException | None = None

        def drain(done: Iterable[Future[str]]) -> None:
            nonlocal fatal
            for future in done:
                row = pending.pop(future)
                candidate = finish_parallel_publish(future, row)
                if fatal is None and candidate is not None:
                    fatal = candidate

        # Conversion is not merely file I/O: incremental decoding, Unicode
        # NFKC normalization, whitespace canonicalization and digest updates
        # execute substantial Python/C work while holding the GIL. Threads
        # therefore collapse toward one core on large imports. Independent
        # books are process-safe, and all SQLite/journal mutations remain in
        # this coordinator, so a process pool lets the configured CPU quota
        # perform useful work without weakening publication ordering.
        with ProcessPoolExecutor(
            max_workers=workers,
        ) as executor:
            for raw_row in catalog.plan_rows(
                resolved_plan_id, source_duplicates_last=True
            ):
                if fatal is not None or (limit is not None and selected >= limit):
                    break
                action = str(raw_row.get("planned_action") or "")
                if action not in {"canonical", "edition"}:
                    continue
                if str(raw_row.get("previous_destination") or ""):
                    continue
                if row_satisfies_target(raw_row):
                    continue
                try:
                    destination = _archive_member_path(
                        root, raw_row["raw_destination"], purpose="destination"
                    )
                except RuntimeError:
                    # Let the serial coordinator record this as a normal
                    # per-file plan/path failure.
                    continue
                row = dict(raw_row)
                source = Path(str(row["source_path"]))
                source_preserved = preserves_source(row)
                if transfer_mode == "move" and not source_preserved:
                    record_delete_intent(
                        row,
                        source,
                        "source_removed_after_verified_utf8_publication",
                        force=True,
                    )
                future = executor.submit(
                    _transcode_utf8_no_bom,
                    source,
                    destination,
                    source_encoding=str(row["encoding"]),
                    expected_raw_hash=str(row["raw_sha256"]),
                    expected_normalized_hash=str(row["normalized_sha256"]),
                    mode="copy" if source_preserved else transfer_mode,
                )
                pending[future] = row
                selected += 1
                if len(pending) >= max_pending:
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    drain(done)
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                drain(done)
        if fatal is not None:
            raise fatal

    try:
        write_delete_manifest()
        publish_independent_rows_in_parallel()
        for row in catalog.plan_rows(resolved_plan_id, source_duplicates_last=True):
            file_id = int(row["file_id"])
            if file_id in parallel_attempted:
                continue
            if limit is not None and counters["processed"] >= limit:
                break
            if not row["planned_action"]:
                continue
            if row_satisfies_target(row):
                counters["skipped"] += 1
                continue
            counters["processed"] += 1
            source = Path(str(row["source_path"]))
            action = str(row["planned_action"])
            previous_value = str(row.get("previous_destination") or "")
            raw_destination: Path | None = None
            previous_destination: Path | None = None
            try:
                if preserves_source(row) and not source_matches_plan(row):
                    raise RuntimeError(
                        f"Preserved processed source is missing or changed: {source}"
                    )
                if action != "delete_invalid":
                    raw_destination = _archive_member_path(
                        root, row["raw_destination"], purpose="destination"
                    )
                if previous_value:
                    previous_destination = _archive_member_path(
                        root, previous_value, purpose="previous destination"
                    )
                if action == "delete_invalid":
                    if source.exists() and not source_matches_plan(row):
                        raise RuntimeError(f"Rejected source changed after scan: {source}")
                    if preserves_source(row):
                        if not source_matches_plan(row):
                            raise RuntimeError(
                                f"Preserved processed source is missing or changed: {source}"
                            )
                        counters["preserved_existing_processed"] += 1
                        raw_result = "invalid_preserved"
                        apply_status = "invalid_rejected"
                    elif transfer_mode == "move":
                        if source.exists():
                            record_delete_intent(
                                row,
                                source,
                                "scan_rejected_invalid_or_quarantined_text",
                                force=True,
                            )
                            unlink_for_batched_commit(source)
                        counters["invalid_deleted"] += 1
                        raw_result = "invalid_deleted"
                        apply_status = "deleted_invalid"
                    else:
                        if not source_matches_plan(row):
                            raise RuntimeError(
                                f"Copy-mode rejected source is missing or changed: {source}"
                            )
                        counters["rejected_in_copy_mode"] += 1
                        raw_result = "invalid_rejected"
                        apply_status = "invalid_rejected"
                elif action == "source_duplicate":
                    assert raw_destination is not None
                    target = duplicate_target(
                        int(row["duplicate_of_file_id"])
                    )
                    # Re-stat on every duplicate. The verification cache is
                    # reused only while inode/size/mtime/ctime stay identical.
                    target_is_verified(row, required=True)
                    source_preserved = preserves_source(row)
                    if (transfer_mode == "copy" or source_preserved) and not source_matches_plan(row):
                        raise RuntimeError(
                            f"Copy-mode duplicate source is missing or changed: {source}"
                        )
                    if transfer_mode == "move" and not source_preserved and source.exists():
                        if not source_matches_plan(row):
                            raise RuntimeError(f"Duplicate source changed after scan: {source}")
                        record_delete_intent(
                            row,
                            source,
                            "content_preserved_by_verified_representative",
                            force=True,
                        )
                        unlink_for_batched_commit(source)
                        counters["duplicates_removed"] += 1
                    if previous_destination is not None and transfer_mode == "move":
                        record_delete_intent(
                            row,
                            previous_destination,
                            "superseded_published_destination",
                            force=True,
                        )
                        counters["migrated_existing"] += int(
                            _remove_stale_previous_destination(
                                previous_destination,
                                raw_destination,
                                expected_normalized_hash=str(target["normalized_sha256"]),
                            )
                        )
                    if source_preserved:
                        raw_result = "source_duplicate_preserved"
                        counters["preserved_existing_processed"] += 1
                    else:
                        raw_result = "deduplicated" if transfer_mode == "move" else "indexed_duplicate"
                    apply_status = "complete"
                else:
                    assert raw_destination is not None
                    source_preserved = preserves_source(row)
                    if (
                        not source.exists()
                        and previous_destination is not None
                        and previous_destination.is_file()
                    ):
                        if transfer_mode == "move" and not source_preserved:
                            record_delete_intent(
                                row,
                                previous_destination,
                                "superseded_published_destination",
                                force=True,
                            )
                        raw_result = _relocate_existing_utf8(
                            previous_destination,
                            raw_destination,
                            expected_normalized_hash=str(row["normalized_sha256"]),
                            remove_previous=transfer_mode == "move",
                        )
                        counters["migrated_existing"] += int(
                            raw_result in {"migrated_existing", "copied_existing"}
                        )
                    else:
                        if transfer_mode == "move" and not source_preserved:
                            record_delete_intent(
                                row,
                                source,
                                "source_removed_after_verified_utf8_publication",
                                force=True,
                            )
                        raw_result = _transcode_utf8_no_bom(
                            source,
                            raw_destination,
                            source_encoding=str(row["encoding"]),
                            expected_raw_hash=str(row["raw_sha256"]),
                            expected_normalized_hash=str(row["normalized_sha256"]),
                            mode="copy" if source_preserved else transfer_mode,
                        )
                        if previous_destination is not None and transfer_mode == "move":
                            record_delete_intent(
                                row,
                                previous_destination,
                                "superseded_published_destination",
                                force=True,
                            )
                            counters["migrated_existing"] += int(
                                _remove_stale_previous_destination(
                                    previous_destination,
                                    raw_destination,
                                    expected_normalized_hash=str(row["normalized_sha256"]),
                                )
                            )
                    counters["raw_transferred"] += int(raw_result != "already_present")
                    counters["converted_utf8"] += int(raw_result in {"converted", "moved"})
                    apply_status = "complete"
                recorded_state = raw_result
                if action not in {"delete_invalid", "source_duplicate"}:
                    # A new plan may migrate a previously moved archive file
                    # while running in copy mode. Preserve that irreversible
                    # source-removal fact instead of claiming the source was
                    # retained merely because this invocation requested copy.
                    recorded_state = (
                        "source_preserved"
                        if source_preserved
                        else ("converted" if source_matches_plan(row) else "moved")
                    )
                    counters["preserved_existing_processed"] += int(source_preserved)
                journal_writer.append(
                    {
                        "at": utc_now(),
                        "operation": "utf8_publish_or_reject",
                        "result": raw_result,
                        "file_id": file_id,
                        "source": str(source),
                        "previous_destination": (
                            str(previous_destination) if previous_destination else ""
                        ),
                        "destination": str(raw_destination) if raw_destination else "",
                        "raw_sha256": row["raw_sha256"],
                    },
                )
                destination_stat_token = None
                if raw_destination is not None:
                    destination_stat_token = _stat_token(
                        _regular_file_stat(
                            raw_destination,
                            purpose="published destination",
                        )
                    )
                catalog.set_plan_apply_status(
                    resolved_plan_id,
                    file_id,
                    apply_status=apply_status,
                    raw_transfer_state=recorded_state,
                    applied_at=utc_now(),
                    destination_stat_token=destination_stat_token,
                )
                if counters["processed"] % 256 == 0:
                    flush_apply_batch()
            except StrictDecodeError as exc:
                if source.exists() and not source_matches_plan(row):
                    raise RuntimeError(f"Source changed after failed conversion: {source}") from exc
                if transfer_mode == "move" and not preserves_source(row):
                    if source.exists():
                        journal_writer.append(
                            {
                                "at": utc_now(),
                                "operation": "delete_intent_update",
                                "file_id": file_id,
                                "source": str(source),
                                "raw_sha256": str(row["raw_sha256"]),
                                "reason": "strict_source_decode_failure",
                                "error": f"{type(exc).__name__}: {exc}",
                            },
                            force=True,
                        )
                        unlink_for_batched_commit(source)
                    raw_result = "conversion_failed_deleted"
                    apply_status = "deleted_conversion_failure"
                    counters["conversion_failed_deleted"] += 1
                else:
                    raw_result = "conversion_rejected"
                    apply_status = "conversion_rejected"
                    counters["rejected_in_copy_mode"] += 1
                catalog.set_plan_apply_status(
                    resolved_plan_id,
                    file_id,
                    apply_status=apply_status,
                    raw_transfer_state=raw_result,
                    applied_at=utc_now(),
                )
                journal_writer.append(
                    {
                        "at": utc_now(),
                        "operation": raw_result,
                        "file_id": file_id,
                        "source": str(source),
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                )
            except Exception as exc:
                counters["failed"] += 1
                catalog.set_plan_apply_status(
                    resolved_plan_id,
                    file_id,
                    apply_status=f"failed:{type(exc).__name__}",
                    applied_at=None,
                )
                journal_writer.append(
                    {
                        "at": utc_now(),
                        "operation": "error",
                        "file_id": file_id,
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                )
                logger.exception("Apply failed for %s", row["source_path"])
                if isinstance(exc, OSError) and exc.errno in {
                    errno.ENOSPC,
                    errno.EROFS,
                    errno.EIO,
                }:
                    raise
                if counters["processed"] % 256 == 0:
                    flush_apply_batch()
        flush_apply_batch()
        after_statuses = {
            f"{str(row[0]) or 'pending'}:{str(row[1]) or 'raw_pending'}": int(row[2])
            for row in catalog.connection.execute(
                """
                SELECT apply_status, raw_transfer_state, COUNT(*) FROM plan_files
                WHERE plan_run_id=? GROUP BY apply_status, raw_transfer_state
                """,
                (resolved_plan_id,),
            )
        }
        satisfied_after = sum(
            1 for row in catalog.plan_rows(resolved_plan_id) if row_satisfies_target(row)
        )
        remaining = planned_count - satisfied_after
        status = "complete" if counters["failed"] == 0 and remaining == 0 else "partial"
        index_path = _write_flat_index(catalog, root, resolved_plan_id) if status == "complete" else None
        summary = {
            "run_id": apply_run_id,
            "plan_run_id": resolved_plan_id,
            "status": status,
            "planned": planned_count,
            "already_satisfied": already_satisfied,
            "remaining": remaining,
            "status_counts": after_statuses,
            **counters,
            "journal": str(journal),
            "index": str(index_path) if index_path else None,
        }
        _atomic_write_json(journal.parent / "summary.json", summary)
        catalog.finish_run(apply_run_id, status, summary)
        journal_writer.close()
        return summary
    except Exception as exc:
        # Failure finalization must not depend on the journal still being
        # writable: ENOSPC/EIO in the primary path commonly makes a second
        # append fail too. Preserve the original exception while independently
        # attempting each cleanup step and, most importantly, closing the run.
        cleanup_errors: list[str] = []
        filesystem_synced = True
        try:
            sync_deleted_directories()
        except Exception as cleanup_exc:
            filesystem_synced = False
            cleanup_errors.append(
                f"directory_fsync:{type(cleanup_exc).__name__}: {cleanup_exc}"
            )
        try:
            journal_writer.append(
                {
                    "at": utc_now(),
                    "operation": "run_aborted",
                    "error": f"{type(exc).__name__}: {exc}",
                },
                force=True,
            )
        except Exception as cleanup_exc:
            cleanup_errors.append(
                f"journal_append:{type(cleanup_exc).__name__}: {cleanup_exc}"
            )
        try:
            if filesystem_synced:
                catalog.commit()
            else:
                catalog.connection.rollback()
        except Exception as cleanup_exc:
            cleanup_errors.append(
                f"catalog_finalize:{type(cleanup_exc).__name__}: {cleanup_exc}"
            )
            try:
                catalog.connection.rollback()
            except Exception as rollback_exc:
                cleanup_errors.append(
                    f"catalog_rollback:{type(rollback_exc).__name__}: {rollback_exc}"
                )
        try:
            journal_writer.close()
        except Exception as cleanup_exc:
            cleanup_errors.append(
                f"journal_close:{type(cleanup_exc).__name__}: {cleanup_exc}"
            )
        failure_summary: dict[str, object] = {
            **counters,
            "journal": str(journal),
            "error": f"{type(exc).__name__}: {exc}",
        }
        if cleanup_errors:
            failure_summary["cleanup_errors"] = cleanup_errors
        try:
            catalog.finish_run(apply_run_id, "failed", failure_summary)
        except Exception:
            logger.exception("Could not finalize failed apply run %s", apply_run_id)
        raise


def apply_plan(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    plan_run_id: str | None = None,
    transfer_mode: str = "copy",
    confirm_transfer_complete: bool = False,
    stability_snapshot: SourceSnapshot | None = None,
    limit: int | None = None,
    raw_only: bool = False,
    workers: int = 1,
    preserve_existing_processed: bool = False,
) -> dict[str, object]:
    """Serialize archive mutation across processes, then apply one plan."""

    root = Path(archive_root).resolve()
    with _ArchiveFileLock(root, exclusive=True):
        return _apply_plan_locked(
            catalog,
            root,
            plan_run_id=plan_run_id,
            transfer_mode=transfer_mode,
            confirm_transfer_complete=confirm_transfer_complete,
            stability_snapshot=stability_snapshot,
            limit=limit,
            raw_only=raw_only,
            workers=workers,
            preserve_existing_processed=preserve_existing_processed,
        )


def _verify_plan_locked(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    plan_run_id: str | None = None,
    limit: int | None = None,
    run_id: str | None = None,
    workers: int = 1,
) -> dict[str, object]:
    """Verify publication bytes and the physical source-removal contract."""

    if limit is not None and limit < 1:
        raise ValueError("limit must be a positive integer")
    if workers < 1:
        raise ValueError("workers must be a positive integer")
    root = Path(archive_root).resolve()
    resolved_plan_id = plan_run_id or catalog.latest_plan_run_id()
    if not resolved_plan_id:
        raise RuntimeError("No completed plan is available")
    planned_count = catalog.require_plan(resolved_plan_id)
    resolved_run_id = run_id or f"verify-{uuid.uuid4().hex[:12]}"
    catalog.start_run(
        resolved_run_id,
        "verify",
        {
            "plan_run_id": resolved_plan_id,
            "limit": limit,
            "workers": workers,
            "planned": planned_count,
        },
    )
    journal = root / ".state" / "runs" / resolved_run_id / "journal.jsonl"
    checked = examined = errors = incomplete = 0
    source_deleted_verified = destination_verified = source_paths_reused = 0
    error_items: list[dict[str, object]] = []
    verified_destinations: set[tuple[str, str]] = set()
    parallel_destination_results: dict[tuple[str, str], str | None] = {}
    parallel_destination_file_errors: dict[int, str] = {}
    rejected_apply_statuses = {
        "deleted_invalid",
        "invalid_rejected",
        "deleted_conversion_failure",
        "conversion_rejected",
    }

    def destination_spec(row: Mapping[str, object]) -> tuple[Path, str]:
        raw_path = _archive_member_path(
            root, row["raw_destination"], purpose="destination"
        )
        expected_normalized_hash = str(row["normalized_sha256"])
        if row["planned_action"] == "source_duplicate":
            target = catalog.get_plan_file(
                resolved_plan_id, int(row["duplicate_of_file_id"])
            )
            expected_normalized_hash = str(target["normalized_sha256"])
        return raw_path, expected_normalized_hash

    def original_still_at_path(row: Mapping[str, object], source: Path) -> bool:
        try:
            current = _regular_file_stat(source, purpose="source")
        except (FileNotFoundError, RuntimeError):
            return False
        recorded_device = int(row.get("device_id") or 0)
        recorded_inode = int(row.get("inode") or 0)
        if recorded_device and recorded_inode:
            if (_signed_identity(current.st_dev), _signed_identity(current.st_ino)) != (
                recorded_device,
                recorded_inode,
            ):
                return False
        if int(current.st_size) != int(row.get("size_bytes") or 0):
            return False
        return _regular_file_identity_unchanged(source, str(row["raw_sha256"]))

    try:
        writer = _DurableJournal(journal, batch_size=512)
    except Exception as exc:
        catalog.finish_run(
            resolved_run_id,
            "failed",
            {
                "plan_run_id": resolved_plan_id,
                "journal": str(journal),
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        raise
    try:
        if workers > 1:
            pending: dict[Future[None], tuple[str, str]] = {}
            seen_keys: set[tuple[str, str]] = set()
            max_pending = max(2, workers * 2)

            def drain_destinations(done: Iterable[Future[None]]) -> None:
                for future in done:
                    key = pending.pop(future)
                    try:
                        future.result()
                    except Exception as exc:
                        parallel_destination_results[key] = (
                            f"{type(exc).__name__}: {exc}"
                        )
                    else:
                        parallel_destination_results[key] = None

            # UTF-8 decoding, normalization and digesting are GIL-heavy just
            # like publication. Use processes so full verification can consume
            # the configured CPU quota instead of serializing in threads.
            with ProcessPoolExecutor(
                max_workers=workers,
            ) as executor:
                prepared = 0
                for row in catalog.plan_rows(resolved_plan_id):
                    if limit is not None and prepared >= limit:
                        break
                    prepared += 1
                    apply_status = str(row["apply_status"] or "")
                    if (
                        apply_status != "complete"
                        or apply_status in rejected_apply_statuses
                    ):
                        continue
                    try:
                        raw_path, expected_hash = destination_spec(row)
                    except Exception as exc:
                        parallel_destination_file_errors[int(row["file_id"])] = (
                            f"{type(exc).__name__}: {exc}"
                        )
                        continue
                    key = (str(raw_path), expected_hash)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    future = executor.submit(
                        _verify_utf8_no_bom, raw_path, expected_hash
                    )
                    pending[future] = key
                    if len(pending) >= max_pending:
                        done, _ = wait(pending, return_when=FIRST_COMPLETED)
                        drain_destinations(done)
                while pending:
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    drain_destinations(done)
            destination_verified = sum(
                error is None for error in parallel_destination_results.values()
            )

        for row in catalog.plan_rows(resolved_plan_id):
            if limit is not None and examined >= limit:
                break
            examined += 1
            file_id = int(row["file_id"])
            event: dict[str, object] = {
                "at": utc_now(),
                "operation": "verify_file",
                "run_id": resolved_run_id,
                "plan_run_id": resolved_plan_id,
                "file_id": file_id,
                "source_deleted_verified": False,
                "destination_verified": False,
            }
            if row["apply_status"] not in {
                "complete",
                "deleted_invalid",
                "invalid_rejected",
                "deleted_conversion_failure",
                "conversion_rejected",
            }:
                incomplete += 1
                errors += 1
                message = f"plan item is not applied: {row['apply_status'] or 'pending'}"
                event.update(status="incomplete", error=message)
                writer.append(event)
                if len(error_items) < 1000:
                    error_items.append({"file_id": file_id, "error": message})
                continue
            checked += 1
            try:
                apply_status = str(row["apply_status"])
                transfer_state = str(row.get("raw_transfer_state") or "")
                source = Path(str(row["source_path"]))
                must_be_removed = transfer_state in {
                    "moved",
                    "deduplicated",
                    "invalid_deleted",
                    "conversion_failed_deleted",
                }
                must_remain = transfer_state in {
                    "converted",
                    "indexed_duplicate",
                    "invalid_rejected",
                    "conversion_rejected",
                    "source_preserved",
                    "source_duplicate_preserved",
                    "invalid_preserved",
                }
                if must_be_removed:
                    if original_still_at_path(row, source):
                        raise RuntimeError("original source identity still exists after move/delete")
                    if os.path.lexists(source):
                        event["source_path_reused"] = True
                        source_paths_reused += 1
                    event["source_deleted_verified"] = True
                    source_deleted_verified += 1
                elif must_remain:
                    if not original_still_at_path(row, source):
                        raise RuntimeError("copy-mode source is missing or changed")
                    event["source_preserved_verified"] = True
                else:
                    raise RuntimeError(
                        f"unknown or missing raw transfer state: {transfer_state or '(empty)'}"
                    )

                if apply_status not in rejected_apply_statuses:
                    preflight_error = parallel_destination_file_errors.get(file_id)
                    if preflight_error is not None:
                        raise RuntimeError(preflight_error)
                    raw_path, expected_normalized_hash = destination_spec(row)
                    key = (str(raw_path), expected_normalized_hash)
                    if workers > 1:
                        destination_error = parallel_destination_results.get(key)
                        if destination_error is not None:
                            raise RuntimeError(destination_error)
                        if key not in parallel_destination_results:
                            raise RuntimeError(
                                "destination was omitted from parallel verification"
                            )
                    elif key not in verified_destinations:
                        _verify_utf8_no_bom(raw_path, expected_normalized_hash)
                        verified_destinations.add(key)
                        destination_verified += 1
                    event["destination_verified"] = True
                    event["destination"] = str(raw_path)
                event["status"] = "ok"
            except Exception as exc:
                errors += 1
                event.update(status="error", error=f"{type(exc).__name__}: {exc}")
                if len(error_items) < 1000:
                    error_items.append({"file_id": file_id, "error": str(exc)})
            writer.append(event)

        writer.close()
        limited = limit is not None and examined < planned_count
        status = "complete" if not errors and not limited else "partial"
        summary = {
            "run_id": resolved_run_id,
            "plan_run_id": resolved_plan_id,
            "status": status,
            "planned": planned_count,
            "examined": examined,
            "checked": checked,
            "incomplete": incomplete,
            "limited": limited,
            "errors": errors,
            "source_deleted_verified": source_deleted_verified,
            "source_paths_reused": source_paths_reused,
            "unique_destinations_verified": destination_verified,
            "workers": workers,
            "journal": str(journal),
            "omitted_error_items": max(0, errors - len(error_items)),
            "error_items": error_items,
        }
        _atomic_write_json(journal.parent / "summary.json", summary)
        catalog.finish_run(resolved_run_id, status, summary)
        return summary
    except Exception as exc:
        writer.close()
        catalog.finish_run(
            resolved_run_id,
            "failed",
            {
                "plan_run_id": resolved_plan_id,
                "journal": str(journal),
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        raise


def verify_plan(
    catalog: LocalNovelCatalog,
    archive_root: str | Path,
    *,
    plan_run_id: str | None = None,
    limit: int | None = None,
    run_id: str | None = None,
    workers: int = 1,
) -> dict[str, object]:
    """Run verification under a cross-process shared archive lock."""

    root = Path(archive_root).resolve()
    with _ArchiveFileLock(root, exclusive=False):
        return _verify_plan_locked(
            catalog,
            root,
            plan_run_id=plan_run_id,
            limit=limit,
            run_id=run_id,
            workers=workers,
        )
