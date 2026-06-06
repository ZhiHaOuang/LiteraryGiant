"""Book registry — maps numeric book IDs to metadata.

Uses the canonical ``Yggdrasil/indexes/books.json`` file defined in the
project data layout (:file:`docs/data_layout.md`).
"""

from __future__ import annotations

import json
import logging
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
    ) -> str:
        """Register a new book and return its ``book_XXXX`` ID.

        If *source_url* (canonicalised) matches an existing entry, its
        existing ID is returned.
        """
        canonical_url = _canonicalize_url(source_url) if source_url else ""

        # Check for duplicate by canonical URL
        if canonical_url:
            existing_id = self.lookup_by_url(canonical_url)
            if existing_id is not None:
                logger.info("Book already registered: %s → %s", source_url, existing_id)
                self._touch(existing_id)
                return existing_id

        # Check by title as secondary dedup
        for bid, info in self.payload.get("books", {}).items():
            if info.get("title") == title and info.get("source_url") == canonical_url:
                logger.info("Book already registered by title+url: %s → %s", title, bid)
                self._touch(bid)
                return bid

        book_id = self._next_id()
        book_slug = f"book_{int(book_id):04d}"

        self.payload.setdefault("books", {})[book_id] = {
            "book_id": book_id,
            "book_slug": book_slug,
            "title": title,
            "source_url": canonical_url,
            "adapter_domain": adapter_domain,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            "paths": {
                "raw_text": f"sources/raw_text/{book_slug}",
                "chapters": f"derived/chapters/{book_slug}",
                "features": f"derived/features/{book_slug}",
                "plots": f"derived/plots/{book_slug}",
            },
        }
        self.payload["last_id"] = int(book_id)
        self.save()
        logger.info("Registered %s → %s (%s)", book_slug, title, canonical_url)
        return book_slug

    def lookup(self, book_id: str) -> dict | None:
        """Return metadata for *book_id* (or *book_slug*)."""
        books = self.payload.get("books", {})
        # Try book_id first
        if book_id in books:
            return books[book_id]
        # Try matching by book_slug
        for info in books.values():
            if info.get("book_slug") == book_id:
                return info
        return None

    def lookup_by_url(self, canonical_url: str) -> str | None:
        """Return the book_id for *canonical_url*, or ``None``."""
        url = _canonicalize_url(canonical_url)
        for bid, info in self.payload.get("books", {}).items():
            if _canonicalize_url(info.get("source_url", "")) == url:
                return info.get("book_slug", bid)
        return None

    def update(self, book_id: str, **kwargs) -> None:
        """Update metadata fields for *book_id*."""
        info = self.lookup(book_id)
        if info is None:
            raise KeyError(f"Unknown book_id: {book_id}")
        info.update(kwargs)
        info["updated_at"] = _utc_now()
        self.save()

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
        slug = info.get("book_slug", book_id) if info else book_id
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
            slug = info.get("book_slug", book_id)
            source_dir = self.source_dir(slug)
            entry: dict = {
                "book_id": book_id,
                "book_slug": slug,
                "title": info.get("title", ""),
                "source_url": info.get("source_url", ""),
                "adapter_domain": info.get("adapter_domain", ""),
                "created_at": info.get("created_at", ""),
                "updated_at": info.get("updated_at", ""),
            }

            # Inspect on-disk state
            if source_dir.exists():
                index_path = source_dir / "index.json"
                source_txt = source_dir / "source.txt"
                chapter_files = sorted(source_dir.glob("chapter_*.txt"))

                entry["source_type"] = "whole_book" if source_txt.exists() else "per_chapter"
                entry["chapter_count"] = len(chapter_files)

                if index_path.exists():
                    try:
                        idx = json.loads(index_path.read_text(encoding="utf-8"))
                        entry["total_expected"] = idx.get("total_expected")
                        entry["total_fetched"] = idx.get("total_fetched")
                        entry["total_failed"] = idx.get("total_failed")
                        entry["fetcher_run_id"] = idx.get("fetcher_run_id")
                    except json.JSONDecodeError:
                        pass

                total_size = sum(
                    f.stat().st_size for f in chapter_files if f.is_file()
                ) + (source_txt.stat().st_size if source_txt.exists() else 0)
                entry["total_size_bytes"] = total_size
                entry["has_raw_text"] = True
            else:
                entry["has_raw_text"] = False
                entry["chapter_count"] = 0

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

    def _touch(self, book_id: str) -> None:
        info = self.lookup(book_id)
        if info:
            info["updated_at"] = _utc_now()
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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
