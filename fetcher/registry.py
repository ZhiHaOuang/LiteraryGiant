"""Book registry — maps numeric book IDs to metadata.

Uses the canonical ``Yggdrasil/indexes/books.json`` file defined in the
project data layout (:file:`docs/data_layout.md`).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from shared.constants import YGGDRASIL_ROOT

logger = logging.getLogger(__name__)

REGISTRY_PATH = YGGDRASIL_ROOT / "indexes" / "books.json"
SOURCES_RAW_TEXT = YGGDRASIL_ROOT / "sources" / "raw_text"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonicalize_url(url: str) -> str:
    """Normalise a URL for consistent comparison.

    * Strip trailing slash from path.
    * Strip fragment.
    * Lowercase scheme and host.
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme}://{parsed.hostname}{path}"


class BookRegistry:
    """Persistent registry that maps ``book_XXXX`` IDs to book metadata.

    Backed by ``Yggdrasil/indexes/books.json``.
    """

    def __init__(self, path: str | Path = REGISTRY_PATH) -> None:
        self.path = Path(path)
        self.payload: dict = self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def register(
        self,
        title: str,
        *,
        source_url: str = "",
        adapter_domain: str = "",
        content_type: str = "book",
    ) -> str:
        """Register a new book or story and return its ID.

        Returns ``book_XXXX`` for novels, ``story_XXXX`` for short stories.

        If *source_url* (canonicalised) matches an existing entry, its
        existing ID is returned.
        """
        from .utils import FileLock

        canonical_url = _canonicalize_url(source_url) if source_url else ""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = str(self.path) + ".lock"
        with FileLock(lock_path):
            self.payload = self._load()

            if canonical_url:
                existing_id = self.lookup_by_url(canonical_url)
                if existing_id is not None:
                    logger.info("Book already registered: %s → %s", source_url, existing_id)
                    self._touch(existing_id, persist=False)
                    self._write_payload_unlocked()
                    return existing_id

            for bid, info in self.payload.get("books", {}).items():
                if info.get("title") == title and info.get("source_url") == canonical_url:
                    slug = info.get("story_slug") or info.get("book_slug", bid)
                    logger.info("Book already registered by title+url: %s → %s", title, slug)
                    self._touch(slug, persist=False)
                    self._write_payload_unlocked()
                    return slug

            # Cross-site dedup: same title from different URL → skip, log source
            existing = self._lookup_by_title(title, content_type=content_type)
            if existing is not None:
                slug = existing.get("story_slug") or existing.get("book_slug", "")
                logger.info(
                    "Duplicate title — skipping: %r already registered as %s (%s)",
                    title, slug, existing.get("source_url", "?"),
                )
                # Record the alternate URL for reference
                alternate_urls = existing.setdefault("alternate_urls", [])
                if canonical_url and canonical_url not in alternate_urls:
                    alternate_urls.append(canonical_url)
                self._write_payload_unlocked()
                return slug

            content_id = self._next_id()
            prefix = "story" if content_type == "story" else "book"
            slug = f"{prefix}_{int(content_id):04d}"

            entry = {
                "book_id": content_id,
                "book_slug": slug,
                "content_type": content_type,
                "title": title,
                "source_url": canonical_url,
                "adapter_domain": adapter_domain,
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
                "paths": {
                    "raw_text": f"sources/raw_text/{slug}",
                },
            }
            if content_type == "story":
                entry["story_slug"] = slug
            self.payload.setdefault("books", {})[content_id] = entry
            self.payload["last_id"] = int(content_id)
            self._write_payload_unlocked()
            logger.info("Registered %s → %s (%s)", slug, title, canonical_url)
            return slug

    def lookup(self, book_id: str) -> dict | None:
        """Return metadata for *book_id* (or *book_slug*)."""
        books = self.payload.get("books", {})
        # Try book_id first
        if book_id in books:
            return books[book_id]
        # Try matching by book_slug
        for info in books.values():
            if info.get("book_slug") == book_id or info.get("story_slug") == book_id:
                return info
        return None

    def lookup_by_url(self, canonical_url: str) -> str | None:
        """Return the book_id for *canonical_url*, or ``None``."""
        url = _canonicalize_url(canonical_url)
        for bid, info in self.payload.get("books", {}).items():
            known_urls = [info.get("source_url", "")]
            known_urls.extend(info.get("alternate_urls", []))
            if any(_canonicalize_url(known_url) == url for known_url in known_urls if known_url):
                return info.get("story_slug") or info.get("book_slug", bid)
        return None

    def _lookup_by_title(self, title: str, *, content_type: str = "book") -> dict | None:
        """Return the first book/story whose title matches *title*.

        Comparison is done after normalising whitespace and stripping common
        decorative wrappers (e.g. ``《…》``) so that the same work listed on
        different sites still matches. Books and stories are kept separate so
        a short story title cannot suppress a novel with the same title.
        """
        import re

        def _normalize(t: str) -> str:
            t = t.strip()
            if t.startswith("《") and t.endswith("》"):
                t = t[1:-1]
            # Collapse all whitespace to a single space
            t = re.sub(r"\s+", " ", t)
            return t.strip().lower()

        needle = _normalize(title)
        if not needle:
            return None

        for info in self.payload.get("books", {}).values():
            if info.get("content_type", "book") != content_type:
                continue
            if _normalize(info.get("title", "")) == needle:
                return info
        return None

    def update(self, book_id: str, **kwargs) -> None:
        """Update metadata fields for *book_id*."""
        from .utils import FileLock

        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = str(self.path) + ".lock"
        with FileLock(lock_path):
            self.payload = self._load()
            info = self.lookup(book_id)
            if info is None:
                raise KeyError(f"Unknown book_id: {book_id}")
            info.update(kwargs)
            info["updated_at"] = _utc_now()
            self._write_payload_unlocked()

    def list_books(self) -> list[tuple[str, dict]]:
        """Return all registered books as ``(book_id, info)`` tuples."""
        return sorted(self.payload.get("books", {}).items())

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    @property
    def source_root(self) -> Path:
        return SOURCES_RAW_TEXT

    def source_dir(self, book_id: str) -> Path:
        info = self.lookup(book_id)
        slug = (
            (info.get("story_slug") or info.get("book_slug", book_id))
            if info
            else book_id
        )
        return self.source_root / slug

    # ------------------------------------------------------------------
    # Import — normalise a whole-book txt into canonical structure
    # ------------------------------------------------------------------

    def import_whole_book(
        self,
        title: str,
        txt_path: str | Path,
        *,
        source_url: str = "",
    ) -> str:
        """Import a whole-book ``.txt`` file into the canonical layout.

        Creates ``Yggdrasil/sources/raw_text/<book_slug>/source.txt`` and an
        accompanying ``index.json`` manifest.

        Args:
            title: Human-readable book title.
            txt_path: Path to the source ``.txt`` file.
            source_url: Optional URL the book was obtained from.

        Returns:
            The ``book_slug`` (e.g. ``book_0001``).
        """
        import shutil

        txt_path = Path(txt_path).resolve()
        if not txt_path.exists():
            raise FileNotFoundError(f"Source file not found: {txt_path}")

        book_slug = self.register(title, source_url=source_url)
        canonical_dir = self.source_dir(book_slug)
        canonical_dir.mkdir(parents=True, exist_ok=True)

        # Copy the source.txt
        dest = canonical_dir / "source.txt"
        shutil.copy2(txt_path, dest)

        # Build index.json
        import time as _time
        stat = dest.stat()
        index = {
            "title": title,
            "book_slug": book_slug,
            "source_url": source_url,
            "source_type": "whole_book",
            "imported_at": _utc_now(),
            "source_file": txt_path.name,
            "file_size": stat.st_size,
        }
        index_path = canonical_dir / "index.json"
        index_path.write_text(
            json.dumps(index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        self.update(book_slug, last_imported={
            "source_file": str(txt_path),
            "file_size": stat.st_size,
            "at": _utc_now(),
        })

        logger.info("Imported %s → %s/source.txt  (%d bytes)", title, canonical_dir, stat.st_size)
        return book_slug

    # ------------------------------------------------------------------
    # Summary — aggregated view of all books
    # ------------------------------------------------------------------

    def summary(self) -> dict:
        """Build an aggregated summary of all registered books.

        Inspects on-disk state (chapter counts, file sizes) and merges
        with registry metadata.
        """
        books_summary: list[dict] = []
        for book_id, info in self.list_books():
            slug = info.get("story_slug") or info.get("book_slug", book_id)
            source_dir = self.source_dir(slug)
            entry: dict = {
                "book_id": book_id,
                "book_slug": slug,
                "content_type": info.get("content_type", "book"),
                "processing_profile": info.get("processing_profile", ""),
                "structure_type": info.get("structure_type", ""),
                "story_form": info.get("story_form", ""),
                "title": info.get("title", ""),
                "source_url": info.get("source_url", ""),
                "adapter_domain": info.get("adapter_domain", ""),
                "created_at": info.get("created_at", ""),
                "updated_at": info.get("updated_at", ""),
            }
            if info.get("story_slug"):
                entry["story_slug"] = info["story_slug"]

            # Inspect on-disk state
            if source_dir.exists():
                index_path = source_dir / "index.json"
                source_txt = source_dir / "source.txt"
                story_txt = source_dir / "story.txt"
                part_files = sorted((source_dir / "parts").glob("part_*.txt"))
                chapter_files = sorted(source_dir.glob("chapter_*.txt"))

                if story_txt.exists():
                    entry["source_type"] = "story"
                elif source_txt.exists():
                    entry["source_type"] = "whole_book"
                else:
                    entry["source_type"] = "per_chapter"
                entry["chapter_count"] = len(chapter_files)
                entry["part_count"] = len(part_files)

                if index_path.exists():
                    try:
                        idx = json.loads(index_path.read_text(encoding="utf-8"))
                        entry["total_expected"] = idx.get("total_expected")
                        entry["total_fetched"] = idx.get("total_fetched")
                        entry["total_failed"] = idx.get("total_failed")
                        entry["fetcher_run_id"] = idx.get("fetcher_run_id")
                        entry["content_stats"] = idx.get("content_stats")
                    except json.JSONDecodeError:
                        pass

                total_size = sum(
                    f.stat().st_size for f in chapter_files if f.is_file()
                )
                total_size += source_txt.stat().st_size if source_txt.exists() else 0
                total_size += story_txt.stat().st_size if story_txt.exists() else 0
                entry["total_size_bytes"] = total_size
                entry["has_raw_text"] = True
            else:
                entry["has_raw_text"] = False
                entry["chapter_count"] = 0
                entry["part_count"] = 0

            books_summary.append(entry)

        return {
            "layout_version": "novel-agent-data-v1",
            "total_books": len(books_summary),
            "books": books_summary,
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _next_id(self) -> str:
        last = self.payload.get("last_id", 0)
        return str(last + 1)

    def _touch(self, book_id: str, *, persist: bool = True) -> None:
        info = self.lookup(book_id)
        if info:
            info["updated_at"] = _utc_now()
            if persist:
                self.save()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
                payload.setdefault("last_id", len(payload.get("books", {})))
                return payload
            except json.JSONDecodeError:
                logger.warning("Could not parse %s, starting fresh", self.path)
        return {
            "layout_version": "novel-agent-data-v1",
            "last_id": 0,
            "books": {},
        }

    def save(self) -> None:
        """Persist the registry atomically with file locking.

        Uses ``fcntl.flock`` to serialise concurrent writers (threads or
        processes) and writes to a ``.tmp`` file that is atomically renamed
        over the target path (POSIX ``os.replace``).
        """
        from .utils import FileLock

        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = str(self.path) + ".lock"
        with FileLock(lock_path):
            self._write_payload_unlocked()

    def _write_payload_unlocked(self) -> None:
        """Write the current payload assuming the caller already holds the lock."""
        tmp_path = str(self.path) + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(self.payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.path)
