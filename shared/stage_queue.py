from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import INDEXES_ROOT, LIBRARY_ROOT
from .utils import canonical_book_slug, load_json


CURATED_BOOKS_PATH = INDEXES_ROOT / "priority_books.txt"
MIN_AUTO_TOTAL_CHARS = 50_000
MIN_AUTO_AVG_CHAPTER_CHARS = 300


@dataclass(frozen=True)
class RegistryQueueStats:
    source: str
    total_registry_books: int
    queued: int
    skipped_done: int
    skipped_missing_source: int
    skipped_incomplete: int
    curated: int


def stage_done_marker_path(output_dir: str | Path, stage_name: str) -> Path:
    return Path(output_dir) / f".{stage_name}.done"


def stage_is_done(output_dir: str | Path, stage_name: str) -> bool:
    return stage_done_marker_path(output_dir, stage_name).exists()


def mark_stage_done(output_dir: str | Path, stage_name: str, *, metadata: dict[str, Any] | None = None) -> Path:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    marker_path = stage_done_marker_path(output_path, stage_name)
    payload = {
        "stage": stage_name,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "metadata": metadata or {},
    }
    tmp_path = marker_path.with_name(f".{marker_path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(marker_path)
    return marker_path


def load_curated_book_keys(path: str | Path = CURATED_BOOKS_PATH) -> list[str]:
    curated_path = Path(path)
    if not curated_path.exists():
        return []
    keys: list[str] = []
    seen: set[str] = set()
    for raw_line in curated_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or line in seen:
            continue
        keys.append(line)
        seen.add(line)
    return keys


def _library_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return LIBRARY_ROOT / path


def _book_sort_values(entry: dict[str, Any]) -> tuple[int, int]:
    last_cleaned = entry.get("last_cleaned") if isinstance(entry.get("last_cleaned"), dict) else {}
    total_chars = int((last_cleaned or {}).get("total_chars") or 0)
    chapter_count = int((last_cleaned or {}).get("chapter_count") or 0)
    return total_chars, chapter_count


def _is_complete_cleaned_entry(entry: dict[str, Any]) -> bool:
    if entry.get("status") != "active":
        return False
    if entry.get("content_type") not in ("book", "", None):
        return False
    raw = entry.get("raw") if isinstance(entry.get("raw"), dict) else {}
    last_cleaned = entry.get("last_cleaned") if isinstance(entry.get("last_cleaned"), dict) else {}
    cleaned_count = int((last_cleaned or {}).get("chapter_count") or 0)
    raw_count = int((raw or {}).get("chapter_count") or 0)
    if cleaned_count <= 0:
        return False
    return raw_count <= 0 or cleaned_count == raw_count


def _is_structurally_usable_entry(entry: dict[str, Any]) -> bool:
    last_cleaned = entry.get("last_cleaned") if isinstance(entry.get("last_cleaned"), dict) else {}
    chapter_count = int((last_cleaned or {}).get("chapter_count") or 0)
    total_chars = int((last_cleaned or {}).get("total_chars") or 0)
    if total_chars < MIN_AUTO_TOTAL_CHARS:
        return False
    if chapter_count > 0 and total_chars / chapter_count < MIN_AUTO_AVG_CHAPTER_CHARS:
        return False
    return True


def _curated_rank_for(entry: dict[str, Any], curated_ranks: dict[str, int]) -> int | None:
    raw = entry.get("raw") if isinstance(entry.get("raw"), dict) else {}
    keys = {
        str(entry.get("clean_id") or "").strip(),
        str(entry.get("clean_slug") or "").strip(),
        str(entry.get("title") or "").strip(),
        str((raw or {}).get("raw_book_id") or "").strip(),
        str((raw or {}).get("raw_book_slug") or "").strip(),
        str((raw or {}).get("identity_key") or "").strip(),
        str((raw or {}).get("source_url") or "").strip(),
    }
    ranks = [curated_ranks[key] for key in keys if key and key in curated_ranks]
    return min(ranks) if ranks else None


def _registry_entries(registry_path: str | Path) -> list[dict[str, Any]]:
    payload = load_json(registry_path)
    books = payload.get("books") if isinstance(payload, dict) else None
    if isinstance(books, dict):
        return [entry for entry in books.values() if isinstance(entry, dict)]
    if isinstance(books, list):
        return [entry for entry in books if isinstance(entry, dict)]
    return []


def registry_ordered_book_dirs(
    input_path: str | Path,
    *,
    registry_path: str | Path = INDEXES_ROOT / "cleaned_books.json",
    priority_path: str | Path = CURATED_BOOKS_PATH,
    source_stage: str,
    output_root: str | Path,
    output_stage: str,
    skip_done: bool = True,
) -> tuple[list[Path], RegistryQueueStats] | None:
    root = Path(input_path)
    if not root.is_dir() or (root / "index.json").exists():
        return None
    registry = Path(registry_path)
    if not registry.exists():
        return None

    curated_keys = load_curated_book_keys(priority_path)
    curated_ranks = {key: rank for rank, key in enumerate(curated_keys)}
    output_root_path = Path(output_root)
    entries = _registry_entries(registry)
    queued: list[tuple[tuple[int, int, int, str], Path]] = []
    skipped_done = 0
    skipped_missing_source = 0
    skipped_incomplete = 0
    curated_count = 0
    input_root_resolved = root.resolve()

    for entry in entries:
        curated_rank = _curated_rank_for(entry, curated_ranks)
        if not _is_complete_cleaned_entry(entry):
            skipped_incomplete += 1
            continue
        if curated_rank is None and not _is_structurally_usable_entry(entry):
            skipped_incomplete += 1
            continue

        clean_slug = str(entry.get("clean_slug") or "").strip()
        if not clean_slug:
            clean_slug = canonical_book_slug(str(entry.get("clean_id") or ""))
        paths = entry.get("paths") if isinstance(entry.get("paths"), dict) else {}
        if source_stage == "cleaned_chapters":
            raw_source_path = str((paths or {}).get("cleaned_chapters") or "")
            source_dir = _library_path(raw_source_path) if raw_source_path else root / clean_slug
        else:
            source_dir = root / clean_slug

        if not source_dir.is_dir() or not (source_dir / "index.json").exists():
            skipped_missing_source += 1
            continue
        if source_stage == "chapter_features" and not stage_is_done(source_dir, "softmodel"):
            skipped_incomplete += 1
            continue
        try:
            source_dir.resolve().relative_to(input_root_resolved)
        except ValueError:
            continue

        output_dir = output_root_path / clean_slug
        if skip_done and stage_is_done(output_dir, output_stage):
            skipped_done += 1
            continue

        total_chars, chapter_count = _book_sort_values(entry)
        if curated_rank is None:
            sort_key = (1, total_chars, chapter_count, clean_slug)
        else:
            curated_count += 1
            sort_key = (0, curated_rank, total_chars, clean_slug)
        queued.append((sort_key, source_dir))

    queued.sort(key=lambda item: item[0])
    stats = RegistryQueueStats(
        source=str(registry),
        total_registry_books=len(entries),
        queued=len(queued),
        skipped_done=skipped_done,
        skipped_missing_source=skipped_missing_source,
        skipped_incomplete=skipped_incomplete,
        curated=curated_count,
    )
    return [source_dir for _sort_key, source_dir in queued], stats
