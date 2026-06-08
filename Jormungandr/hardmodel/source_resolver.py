"""Detect hardmodel input mode and normalise to a uniform *book source* model.

hardmodel accepts two input layouts::

    Whole-book mode (legacy)
        TextM/平行万宙.txt              ← one file, all chapters

    Whole-book mode (canonical)
        Yggdrasil/sources/raw_text/book_0001/
            source.txt                  ← one file, all chapters

    Per-chapter mode (new)
        TextM/超武斗东京/
            index.json                   ← chapter manifest (optional)
            chapter_0001.txt
            chapter_0002.txt
            ...

    Per-chapter mode (canonical)
        Yggdrasil/sources/raw_text/book_0001/
            chapters/
                index.json               ← chapter manifest (optional)
                chapter_0001.txt
                chapter_0002.txt
                ...

Both are resolved to a :class:`BookSource` that the rest of the
pipeline can consume uniformly.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from shared import normalize_fs_name

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ChapterSource:
    """One chapter discovered from the filesystem.

    In whole-book mode chapters don't exist yet — there will be exactly one
    ``ChapterSource`` whose *source_path* points at the whole book.
    """

    source_path: Path
    order: int
    title: str = ""  # populated after splitting or from manifest
    chapter_no: int | None = None


@dataclass(slots=True)
class BookSource:
    """Uniform representation of a book regardless of input layout."""

    mode: str  # "whole" | "per_chapter"
    title: str
    source_dir: Path  # directory containing the input file(s)
    chapters: list[ChapterSource] = field(default_factory=list)
    book_id_hint: str | None = None
    content_type: str = "book"
    processing_profile: str = "longform_book"

    @property
    def book_id(self) -> str:
        normalized = normalize_fs_name(self.book_id_hint or self.title)
        if normalized.startswith("book_") and len(normalized) > 5:
            return normalized[5:]
        return normalized

    @property
    def has_chapters(self) -> bool:
        return self.mode == "per_chapter"

    @property
    def primary_source(self) -> Path:
        """The canonical source path used for PipelineState book tracking."""
        if self.mode == "whole" and self.chapters:
            return self.chapters[0].source_path
        return self.source_dir


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def resolve_input(input_path: str | Path) -> list[BookSource]:
    """Inspect *input_path* and return one or more :class:`BookSource` objects.

    Detection rules (first match wins):

    1. ``.txt`` file                → whole-book mode, one book
    2. Directory containing ``.txt`` files directly → per-chapter mode, one book
    3. Directory containing subdirectories → per-book mode, each subdirectory
       is a separate book (whole or per-chapter depending on its contents)
    4. Empty directory              → ignored with warning
    """
    path = Path(input_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")

    if path.is_file():
        if path.suffix.lower() == ".txt":
            return [_resolve_whole_book(path)]
        raise ValueError(f"Unsupported file type: {path.suffix}")

    # It's a directory — look inside
    return _resolve_directory(path)


def _resolve_whole_book(txt_path: Path) -> BookSource:
    title = txt_path.stem
    return BookSource(
        mode="whole",
        title=title,
        source_dir=txt_path.parent,
        chapters=[ChapterSource(source_path=txt_path, order=1, title=title)],
    )


def _resolve_canonical_whole_book(dir_path: Path, txt_path: Path) -> BookSource:
    payload = _index_payload(dir_path)
    title = str(payload.get("title") or dir_path.name)
    book_id_hint = _book_id_from_index(dir_path) or dir_path.name
    return BookSource(
        mode="whole",
        title=title,
        source_dir=dir_path,
        book_id_hint=book_id_hint,
        chapters=[ChapterSource(source_path=txt_path, order=1, title=title)],
        content_type=str(payload.get("content_type") or "book"),
        processing_profile=str(payload.get("processing_profile") or "longform_book"),
    )


def _resolve_canonical_story(dir_path: Path, txt_path: Path) -> BookSource:
    payload = _index_payload(dir_path)
    title = str(payload.get("title") or dir_path.name)
    story_slug = str(payload.get("story_slug") or payload.get("book_slug") or dir_path.name)
    return BookSource(
        mode="whole",
        title=title,
        source_dir=dir_path,
        book_id_hint=story_slug,
        chapters=[ChapterSource(source_path=txt_path, order=1, title=title)],
        content_type="story",
        processing_profile=str(payload.get("processing_profile") or "idea_seed"),
    )


def _infer_title_from_chapter_dir(dir_path: Path) -> str:
    if dir_path.name == "chapters" and dir_path.parent.name:
        return dir_path.parent.name
    return dir_path.name


def _resolve_per_chapter_dir(dir_path: Path, *, title: str | None = None) -> BookSource:
    """Resolve a directory that contains ``.txt`` chapter files."""
    # Try to read index.json for metadata
    index_path = dir_path / "index.json"
    manifest_entries: list[dict] | None = None
    book_title = title or _infer_title_from_chapter_dir(dir_path)
    book_id_hint = book_title

    if index_path.exists():
        try:
            payload = json.loads(index_path.read_text(encoding="utf-8"))
            book_title = payload.get("title", book_title)
            book_id_hint = str(
                payload.get("book_id")
                or payload.get("story_slug")
                or payload.get("book_slug")
                or book_id_hint
            )
            raw_entries = payload.get("chapters", [])
            if not isinstance(raw_entries, list):
                logger.warning("chapters must be a list in %s, using filename heuristics", index_path)
                raw_entries = []
            manifest_entries = []
            for entry_index, entry in enumerate(raw_entries, start=1):
                if not isinstance(entry, dict):
                    logger.warning("Skipping non-object chapter entry %s in %s", entry_index, index_path)
                    continue
                if entry.get("file_name"):
                    manifest_entries.append(entry)
                else:
                    logger.warning("Skipping chapter entry %s without file_name in %s", entry_index, index_path)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Could not parse index.json in {dir_path}") from exc

    # Discover .txt files
    txt_files = sorted(
        f for f in dir_path.iterdir()
        if f.is_file() and f.suffix.lower() == ".txt" and f.name != "index.json"
    )

    chapters: list[ChapterSource] = []
    if manifest_entries is not None:
        indexed_files: set[str] = set()
        for fallback_order, entry in enumerate(manifest_entries, start=1):
            file_name = str(entry.get("file_name") or "").strip()
            chapter_title = str(entry.get("title") or "").strip()
            try:
                order = int(entry.get("order", fallback_order))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"chapter entry {fallback_order} has invalid order in {index_path}") from exc
            if not chapter_title:
                chapter_title = f"chapter_{order:04d}"
                logger.warning(
                    "Indexed chapter %s in %s has no title; using placeholder %s",
                    file_name,
                    index_path,
                    chapter_title,
                )
            txt_file = dir_path / file_name
            if not txt_file.exists():
                logger.warning("Indexed chapter file is missing and will be skipped: %s", txt_file)
                continue
            if txt_file.suffix.lower() != ".txt":
                logger.warning("Indexed chapter file is not .txt and will be skipped: %s", txt_file)
                continue
            indexed_files.add(file_name)
            chapter_no = entry.get("chapter_no") or _extract_chapter_no(chapter_title)

            chapters.append(
                ChapterSource(
                    source_path=txt_file,
                    order=order,
                    title=chapter_title,
                    chapter_no=chapter_no,
                )
            )
        extra_files = [txt_file.name for txt_file in txt_files if txt_file.name not in indexed_files]
        if extra_files:
            preview = ", ".join(extra_files[:5])
            logger.warning("Ignoring .txt files not listed in %s: %s", index_path, preview)
    else:
        for order, txt_file in enumerate(txt_files, 1):
            chapter_title = _title_from_filename(txt_file)
            chapter_no = _extract_chapter_no(chapter_title)

            chapters.append(
                ChapterSource(
                    source_path=txt_file,
                    order=order,
                    title=chapter_title,
                    chapter_no=chapter_no,
                )
            )

    if not chapters:
        raise FileNotFoundError(f"No .txt chapter files found in {dir_path}")

    return BookSource(
        mode="per_chapter",
        title=book_title,
        source_dir=dir_path,
        chapters=chapters,
        book_id_hint=book_id_hint,
        content_type=str(_index_payload(dir_path).get("content_type") or "book"),
        processing_profile=str(_index_payload(dir_path).get("processing_profile") or "longform_book"),
    )


def _resolve_directory(dir_path: Path) -> list[BookSource]:
    """Resolve a directory — may be one book or many."""
    canonical_story = dir_path / "story.txt"
    if canonical_story.exists():
        return [_resolve_canonical_story(dir_path, canonical_story)]

    # Check if dir has .txt files directly → per-chapter mode, single book
    direct_txts = list(dir_path.glob("*.txt"))
    if direct_txts:
        canonical_source = dir_path / "source.txt"
        if canonical_source.exists() and len(direct_txts) == 1:
            return [_resolve_canonical_whole_book(dir_path, canonical_source)]
        return [_resolve_per_chapter_dir(dir_path)]

    canonical_chapter_dir = dir_path / "chapters"
    if canonical_chapter_dir.is_dir():
        return [_resolve_per_chapter_dir(canonical_chapter_dir, title=dir_path.name)]

    # Check for subdirectories → each is a book
    subdirs = sorted(d for d in dir_path.iterdir() if d.is_dir() and not d.name.startswith("."))
    if subdirs:
        books: list[BookSource] = []
        for subdir in subdirs:
            try:
                books.append(_resolve_directory_entry(subdir))
            except FileNotFoundError:
                logger.warning("Skipping empty or unrecognised directory: %s", subdir)
        if not books:
            raise FileNotFoundError(f"No valid book sources found under {dir_path}")
        return books

    raise FileNotFoundError(f"No .txt files or book subdirectories found in {dir_path}")


def _resolve_directory_entry(dir_path: Path) -> BookSource:
    """Resolve a single subdirectory that may be whole or per-chapter."""
    canonical_story = dir_path / "story.txt"
    if canonical_story.exists():
        return _resolve_canonical_story(dir_path, canonical_story)

    # Check if it contains .txt files = per-chapter book
    direct_txts = list(dir_path.glob("*.txt"))
    if direct_txts:
        canonical_source = dir_path / "source.txt"
        if canonical_source.exists() and len(direct_txts) == 1:
            return _resolve_canonical_whole_book(dir_path, canonical_source)
        return _resolve_per_chapter_dir(dir_path)

    canonical_chapter_dir = dir_path / "chapters"
    if canonical_chapter_dir.is_dir():
        return _resolve_per_chapter_dir(canonical_chapter_dir, title=dir_path.name)

    raise FileNotFoundError(f"No .txt files in {dir_path}")


# ---------------------------------------------------------------------------
# Index helpers
# ---------------------------------------------------------------------------


def _title_from_index(dir_path: Path) -> str | None:
    """Try to read the book title from ``index.json`` in *dir_path*."""
    return _index_payload(dir_path).get("title")


def _book_id_from_index(dir_path: Path) -> str | None:
    """Try to read the canonical book id/slug from ``index.json`` in *dir_path*."""
    payload = _index_payload(dir_path)
    value = payload.get("book_id") or payload.get("story_slug") or payload.get("book_slug")
    return str(value) if value else None


def _index_payload(dir_path: Path) -> dict:
    """Read ``index.json`` if present; return an empty dict on absence/error."""
    index_path = dir_path / "index.json"
    if not index_path.exists():
        return {}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        return {}


# ---------------------------------------------------------------------------
# Heuristic helpers
# ---------------------------------------------------------------------------

_CHAPTER_NO_RE = re.compile(r"第\s*([0-9零一二三四五六七八九十百千万]+)\s*[章节回]")
_ORDER_RE = re.compile(r"chapter[_-]?(\d+)", re.IGNORECASE)
_STRIP_SUFFIX_RE = re.compile(r"\.(txt|json)$", re.IGNORECASE)


def _title_from_filename(path: Path) -> str:
    """Derive a chapter title from the file name."""
    return _STRIP_SUFFIX_RE.sub("", path.stem)


def _extract_chapter_no(title: str) -> int | None:
    """Try to extract a chapter number from a title string."""
    match = _CHAPTER_NO_RE.search(title)
    if match:
        num_str = match.group(1)
        if num_str.isdigit():
            return int(num_str)
    match = _ORDER_RE.search(title)
    if match:
        return int(match.group(1))
    return None
