"""Book registry — maps numeric book IDs to metadata.

Uses the canonical ``Library/indexes/books.json`` file defined in the
project data layout (:file:`docs/data_layout.md`).
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from shared.constants import (
    INDEXES_ROOT,
    TACITURN_NOVELS_CLEANED_ROOT,
    TACITURN_NOVELS_RAW_ROOT,
    TACITURN_STORIES_RAW_ROOT,
)
from shared.utils import canonical_content_id, content_id_number

logger = logging.getLogger(__name__)

REGISTRY_PATH = INDEXES_ROOT / "books.json"
STORIES_PATH = INDEXES_ROOT / "stories.json"
RAWDATA_BOOKS_ROOT = TACITURN_NOVELS_RAW_ROOT
CONTENT_IDS_FILENAME = "content_ids.json"
DEFAULT_NOVEL_CATEGORY_DIR = "20_qita"

def _registry_path(content_type: str = "book") -> Path:
    return STORIES_PATH if content_type == "story" else REGISTRY_PATH


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


def normalize_title(title: str) -> str:
    """Normalise a title for duplicate detection across sites."""
    import re

    title = title.strip()
    title = re.sub(r"^\s*\d+\s*[.、]\s*", "", title)
    title = re.sub(r"[（(](?:全本|完本|连载中|已完结)[)）]\s*$", "", title)
    for suffix in ("最新章节", "全文阅读", "免费阅读", "txt下载", "TXT下载"):
        title = title.replace(suffix, "")
    if title.startswith("《") and title.endswith("》"):
        title = title[1:-1]
    title = re.sub(r"\s+", " ", title)
    return title.strip().lower()


class BookRegistry:
    """Persistent registry that maps unified ``idNNNNNN`` IDs to metadata.

    Backed by ``Library/indexes/books.json``.
    """

    def __init__(self, path: str | Path = REGISTRY_PATH) -> None:
        self.path = Path(path)
        self._stories_path = self.path.parent / "stories.json"
        self._content_ids_path = self.path.parent / CONTENT_IDS_FILENAME
        self._failed_path = self.path.parent / "failed_urls.json"
        self.payload: dict = self._load()
        self._failed_urls: set[str] = self._load_failed()
        # A complete registry/on-disk scan is needed to recover safely from
        # legacy ``last_id`` values that lag behind existing content, but doing
        # that for every registration makes a bulk import quadratic.  Cache the
        # recovered high-water mark independently for books and stories.  The
        # registry file is still reloaded while holding its lock in
        # :meth:`register`, so later allocations also observe IDs issued by
        # other processes.
        self._id_high_watermarks: dict[str, int] = {}

    def _path_for(self, content_type: str = "book") -> Path:
        """Return the registry file path for *content_type*."""
        return self._stories_path if content_type == "story" else self.path

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
        dedupe_by_title: bool = True,
        fail_if_exists: bool = False,
    ) -> str:
        """Register a new book or story and return its ID.

        Returns one type-neutral ``idNNNNNN`` for novels and short stories.

        If *source_url* (canonicalised) matches an existing entry, its
        existing ID is returned unless ``fail_if_exists`` is enabled. Local
        file import uses that stricter mode to avoid concurrent overwrites.
        """
        from .utils import FileLock

        canonical_url = _canonicalize_url(source_url) if source_url else ""
        path = self._path_for(content_type)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Clean up stale registrations (previous run killed mid-download)
        if canonical_url:
            existing_id = self.lookup_by_url(canonical_url, content_type=content_type)
            if existing_id is not None:
                source_dir = self.source_dir(existing_id)
                if not source_dir.exists() or not any(source_dir.iterdir()):
                    logger.warning("Stale registration (no content), removing: %s", existing_id)
                    self.deregister(existing_id)

        lock_path = str(path) + ".lock"
        with FileLock(lock_path):
            self.payload = self._load_path(path)

            if canonical_url:
                existing_id = self.lookup_by_url(
                    canonical_url,
                    content_type=content_type,
                )
                if existing_id is not None:
                    if fail_if_exists:
                        raise FileExistsError(
                            f"Source URL is already registered as {existing_id}: {source_url}"
                        )
                    logger.info("Book already registered: %s → %s", source_url, existing_id)
                    self._touch(existing_id, persist=False)
                    self._write_payload_unlocked(path)
                    return existing_id

            for bid, info in self.payload.get("books", {}).items():
                if (
                    dedupe_by_title
                    and info.get("content_type", "book") == content_type
                    and info.get("title") == title
                    and info.get("source_url") == canonical_url
                ):
                    slug = info.get("story_slug") or info.get("book_slug", bid)
                    if fail_if_exists:
                        raise FileExistsError(f"Book is already registered as {slug}: {title}")
                    logger.info("Book already registered by title+url: %s → %s", title, slug)
                    self._touch(slug, persist=False)
                    self._write_payload_unlocked(path)
                    return slug

            # Cross-site dedup: same title from different URL → skip, log source
            existing = (
                self._lookup_by_title(title, content_type=content_type)
                if dedupe_by_title
                else None
            )
            if existing is not None:
                slug = existing.get("story_slug") or existing.get("book_slug", "")
                if fail_if_exists:
                    raise FileExistsError(f"Book title is already registered as {slug}: {title}")
                logger.info(
                    "Duplicate title — skipping: %r already registered as %s (%s)",
                    title, slug, existing.get("source_url", "?"),
                )
                # Record the alternate URL for reference
                alternate_urls = existing.setdefault("alternate_urls", [])
                if canonical_url and canonical_url not in alternate_urls:
                    alternate_urls.append(canonical_url)
                self._write_payload_unlocked(path)
                return slug

            slug = self._next_id(content_type=content_type)
            content_number = content_id_number(slug)

            entry = {
                "book_id": slug,
                "book_slug": slug,
                "content_id": slug,
                "content_type": content_type,
                "title": title,
                "source_url": canonical_url,
                "adapter_domain": adapter_domain,
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
                "paths": {
                    "rawdata": (
                        f"TaciturnRaw/00_Stories/{slug}"
                        if content_type == "story"
                        else f"TaciturnRaw/01_RawData/{DEFAULT_NOVEL_CATEGORY_DIR}/{slug}"
                    ),
                },
            }
            if content_type == "story":
                entry["story_slug"] = slug
            self.payload.setdefault("books", {})[slug] = entry
            self.payload["last_id"] = content_number
            self._write_payload_unlocked(path)
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

    def lookup_by_url(
        self,
        canonical_url: str,
        *,
        content_type: str | None = None,
    ) -> str | None:
        """Return the book_id for *canonical_url*, or ``None``."""
        url = _canonicalize_url(canonical_url)
        paths = (
            [self._path_for(content_type)]
            if content_type is not None
            else [self.path, self._stories_path]
        )
        for path in paths:
            payload = self._load_path(path)
            for bid, info in payload.get("books", {}).items():
                if content_type is not None and info.get("content_type", "book") != content_type:
                    continue
                known_urls = [info.get("source_url", "")]
                known_urls.extend(info.get("alternate_urls", []))
                if any(_canonicalize_url(known_url) == url for known_url in known_urls if known_url):
                    return info.get("story_slug") or info.get("book_slug", bid)
        return None

    def lookup_by_title(self, title: str, *, content_type: str = "book") -> str | None:
        """Return an existing slug whose normalised title matches *title*."""
        payload = self._load_path(self._path_for(content_type))
        needle = normalize_title(title)
        if not needle:
            return None
        for bid, info in payload.get("books", {}).items():
            if info.get("content_type", "book") != content_type:
                continue
            if normalize_title(info.get("title", "")) == needle:
                return info.get("story_slug") or info.get("book_slug", bid)
        return None

    def _lookup_by_title(self, title: str, *, content_type: str = "book") -> dict | None:
        """Return the first book/story whose title matches *title*.

        Comparison is done after normalising whitespace and stripping common
        decorative wrappers (e.g. ``《…》``) so that the same work listed on
        different sites still matches. Books and stories are kept separate so
        a short story title cannot suppress a novel with the same title.
        """
        needle = normalize_title(title)
        if not needle:
            return None

        for info in self.payload.get("books", {}).values():
            if info.get("content_type", "book") != content_type:
                continue
            if normalize_title(info.get("title", "")) == needle:
                return info
        return None

    def update(self, book_id: str, **kwargs) -> None:
        """Update metadata fields for *book_id*.

        Searches both ``books.json`` and ``stories.json`` so that updates
        work regardless of which registry the entry was originally written to.
        """
        from .utils import FileLock

        # Determine which registry file contains this entry
        found_in: Path | None = None
        for candidate_path in (self.path, self._stories_path):
            self.payload = self._load_path(candidate_path)
            info = self.lookup(book_id)
            if info is not None:
                found_in = candidate_path
                break

        if found_in is None:
            raise KeyError(f"Unknown book_id: {book_id}")

        found_in.parent.mkdir(parents=True, exist_ok=True)
        lock_path = str(found_in) + ".lock"
        with FileLock(lock_path):
            self.payload = self._load_path(found_in)
            info = self.lookup(book_id)
            if info is None:
                raise KeyError(f"Unknown book_id: {book_id}")
            info.update(kwargs)
            info["updated_at"] = _utc_now()
            self._write_payload_unlocked(found_in)

    def deregister(self, book_id: str) -> None:
        """Remove a book/story entry from the registry.

        Used to clean up after a failed download.  The global numeric ID stays
        reserved and the next successful registration advances beyond it.
        """
        from .utils import FileLock

        found_in: Path | None = None
        for candidate_path in (self.path, self._stories_path):
            self.payload = self._load_path(candidate_path)
            info = self.lookup(book_id)
            if info is not None:
                found_in = candidate_path
                break

        if found_in is None:
            return  # already gone, nothing to do

        lock_path = str(found_in) + ".lock"
        with FileLock(lock_path):
            self.payload = self._load_path(found_in)
            books = self.payload.get("books", {})
            keys_to_remove = [
                bid for bid, info in books.items()
                if (info.get("story_slug") or info.get("book_slug") or bid) == book_id
            ]
            for key in keys_to_remove:
                del books[key]
                logger.info("Deregistered %s (%s)", book_id, key)
            self._write_payload_unlocked(found_in)

    def list_books(self) -> list[tuple[str, dict]]:
        """Return all registered books/stories as ``(book_id, info)`` tuples."""
        items: list[tuple[str, dict]] = []
        for path in (self.path, self._stories_path):
            payload = self._load_path(path)
            items.extend(payload.get("books", {}).items())
        return sorted(
            items,
            key=lambda item: (
                item[1].get("content_type", "book"),
                item[1].get("story_slug") or item[1].get("book_slug") or item[0],
            ),
        )

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    @property
    def source_root(self) -> Path:
        return RAWDATA_BOOKS_ROOT

    def source_dir(self, book_id: str) -> Path:
        info = self.lookup(book_id)
        slug = (
            (info.get("story_slug") or info.get("book_slug", book_id))
            if info
            else book_id
        )
        content_type = (info or {}).get(
            "content_type",
            "story" if str(slug).startswith("story_") else "book",
        )
        rawdata = str((info or {}).get("paths", {}).get("rawdata") or "").strip()
        if rawdata:
            path = Path(rawdata)
            return path if path.is_absolute() else INDEXES_ROOT.parent / path
        if content_type == "story":
            return TACITURN_STORIES_RAW_ROOT / slug
        return RAWDATA_BOOKS_ROOT / DEFAULT_NOVEL_CATEGORY_DIR / slug

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

        Creates ``Library/TaciturnRaw/01_RawData/20_qita/<content_id>/source.txt`` and an
        accompanying ``index.json`` manifest.

        Args:
            title: Human-readable book title.
            txt_path: Path to the source ``.txt`` file.
            source_url: Optional URL the book was obtained from.

        Returns:
            The unified content ID (e.g. ``id000001``).
        """
        import hashlib
        import shutil
        import uuid

        txt_path = Path(txt_path).resolve()
        if not txt_path.exists():
            raise FileNotFoundError(f"Source file not found: {txt_path}")

        def sha256_file(path: Path) -> str:
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            return digest.hexdigest()

        source_hash = sha256_file(txt_path)
        preexisting_slug = (
            self.lookup_by_url(source_url, content_type="book") if source_url else None
        )
        if preexisting_slug:
            existing_source = self.source_dir(preexisting_slug) / "source.txt"
            if existing_source.exists() and sha256_file(existing_source) == source_hash:
                logger.info("Whole-book import already present: %s", preexisting_slug)
                return preexisting_slug
            raise FileExistsError(
                f"Source URL is already registered as {preexisting_slug}; refusing to overwrite it"
            )

        # Local imports must not merge on title: two unrelated works can share
        # a name. Bulk imports use the content-first Library/Noise pipeline.
        book_slug = self.register(
            title,
            source_url=source_url,
            dedupe_by_title=False,
            fail_if_exists=True,
        )
        canonical_dir = self.source_dir(book_slug)
        if canonical_dir.exists():
            self.deregister(book_slug)
            raise FileExistsError(f"Allocated destination already exists: {canonical_dir}")

        canonical_dir.parent.mkdir(parents=True, exist_ok=True)
        staging_dir = canonical_dir.parent / f".{book_slug}.import-{uuid.uuid4().hex}.tmp"
        promoted = False
        try:
            staging_dir.mkdir(parents=False, exist_ok=False)
            dest = staging_dir / "source.txt"
            shutil.copy2(txt_path, dest)
            if sha256_file(dest) != source_hash:
                raise RuntimeError(f"Hash mismatch after copying {txt_path}")

            stat = dest.stat()
            index = {
                "title": title,
                "canonical_id": book_slug,
                "content_id": book_slug,
                "book_slug": book_slug,
                "content_type": "book",
                "processing_profile": "longform_book",
                "structure_type": "whole",
                "source_url": source_url,
                "source_type": "whole_book",
                "imported_at": _utc_now(),
                "source_file": txt_path.name,
                "file_size": stat.st_size,
                "raw_sha256": source_hash,
            }
            (staging_dir / "index.json").write_text(
                json.dumps(index, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            staging_dir.rename(canonical_dir)
            promoted = True
            self.update(
                book_slug,
                raw_sha256=source_hash,
                last_imported={
                    "source_file": str(txt_path),
                    "file_size": stat.st_size,
                    "at": _utc_now(),
                },
            )
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            # Once promoted, preserve the verified content and its base
            # registration even if a later metadata update fails. Removing a
            # canonical directory here could destroy another process's work.
            if not promoted:
                self.deregister(book_slug)
            raise

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
                entry["has_rawdata"] = True
                entry["has_raw_text"] = True
            else:
                entry["has_rawdata"] = False
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

    def _next_id(self, *, content_type: str = "book") -> str:
        """Allocate one monotonic ID shared by books and stories.

        ``content_ids.json`` is the only allocation high-water mark.  It stores
        no old->new mapping and is advanced atomically before an ID is exposed,
        so failed imports leave harmless gaps instead of reusing identities.
        """
        from .utils import FileLock

        lock_path = str(self._content_ids_path) + ".lock"
        with FileLock(lock_path):
            state = self._load_path(self._content_ids_path)
            try:
                persisted = int(state.get("last_id", 0))
            except (TypeError, ValueError):
                persisted = 0
            cached = self._id_high_watermarks.get("global")
            if cached is None:
                cached = self._initial_global_id_high_watermark()
            registry_high = 0
            for registry_path in (self.path, self._stories_path):
                try:
                    registry_high = max(
                        registry_high,
                        int(self._load_path(registry_path).get("last_id", 0)),
                    )
                except (TypeError, ValueError):
                    pass
            candidate = max(persisted, cached, registry_high) + 1
            while self._global_id_candidate_exists(candidate):
                candidate += 1
            canonical = canonical_content_id(candidate)
            state = {
                "layout_version": "literary-giant-content-id-high-watermark-v1",
                "id_format": "idNNNNNN",
                "last_id": candidate,
                "updated_at": _utc_now(),
                "source": "BookRegistry",
            }
            temporary = Path(str(self._content_ids_path) + ".tmp")
            temporary.write_text(
                json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(temporary, self._content_ids_path)
            self._id_high_watermarks["global"] = candidate
            return canonical

    def _initial_global_id_high_watermark(self) -> int:
        occupied: set[int] = set()
        for path in (self.path, self._stories_path, self._content_ids_path):
            payload = self._load_path(path)
            try:
                occupied.add(int(payload.get("last_id", 0)))
            except (TypeError, ValueError):
                pass
            for key, entry in payload.get("books", {}).items():
                for value in (
                    key,
                    entry.get("content_id"),
                    entry.get("book_id"),
                    entry.get("book_slug"),
                    entry.get("story_slug"),
                ):
                    try:
                        occupied.add(content_id_number(str(value or "")))
                    except ValueError:
                        continue
        # The migration publishes this file, so the large raw index is only a
        # compatibility fallback for a workspace that has not yet created it.
        raw_index = TACITURN_NOVELS_RAW_ROOT / "index.jsonl"
        if not self._content_ids_path.exists() and raw_index.is_file():
            pattern = re.compile(r'"(?:canonical_id|content_id)"\s*:\s*"id(\d{6})"')
            with raw_index.open("r", encoding="utf-8") as handle:
                for line in handle:
                    match = pattern.search(line)
                    if match:
                        occupied.add(int(match.group(1)))
        if not self._content_ids_path.exists():
            # Legacy-safe fallback.  It is used only before the v2 migration
            # creates content_ids.json; normal allocations never rescan the
            # collection.
            for root in (
                TACITURN_NOVELS_RAW_ROOT,
                TACITURN_NOVELS_CLEANED_ROOT,
                TACITURN_STORIES_RAW_ROOT,
            ):
                if not root.is_dir():
                    continue
                for path in root.iterdir():
                    if not path.is_dir():
                        continue
                    try:
                        occupied.add(content_id_number(path.name))
                    except ValueError:
                        continue
        return max(occupied, default=0)

    def _global_id_candidate_exists(self, candidate: int) -> bool:
        canonical = canonical_content_id(candidate)
        for registry_path in (self.path, self._stories_path):
            payload = self._load_path(registry_path)
            if canonical in payload.get("books", {}):
                return True
            for key, entry in payload.get("books", {}).items():
                values = {
                    str(key),
                    str(entry.get("content_id") or ""),
                    str(entry.get("book_id") or ""),
                    str(entry.get("book_slug") or ""),
                    str(entry.get("story_slug") or ""),
                }
                if canonical in values:
                    return True
        if any(
            (root / canonical).exists()
            for root in (
                TACITURN_NOVELS_RAW_ROOT,
                TACITURN_NOVELS_CLEANED_ROOT,
                TACITURN_STORIES_RAW_ROOT,
            )
        ):
            return True
        raw_root = TACITURN_NOVELS_RAW_ROOT
        if raw_root.is_dir():
            for category in raw_root.iterdir():
                if category.is_dir() and (category / canonical).exists():
                    return True
        return False

    def _initial_id_high_watermark(
        self,
        *,
        content_type: str,
        roots: tuple[Path, Path],
        prefix: str,
    ) -> int:
        """Return the legacy-safe registry/disk high-water mark.

        This deliberately performs the expensive scan only when the matching
        entry in ``_id_high_watermarks`` is absent.
        """

        occupied: set[int] = set()
        try:
            occupied.add(int(self.payload.get("last_id", 0)))
        except (TypeError, ValueError):
            pass
        for key, info in self.payload.get("books", {}).items():
            if info.get("content_type", "book") != content_type:
                continue
            candidates = (
                key,
                info.get("book_id"),
                info.get("story_slug"),
                info.get("book_slug"),
            )
            for candidate in candidates:
                match = re.search(r"(?:^|_)(\d+)$", str(candidate or ""))
                if match:
                    occupied.add(int(match.group(1)))

        for root in roots:
            if not root.exists():
                continue
            for path in root.glob(f"{prefix}*"):
                if not path.is_dir():
                    continue
                suffix = path.name.removeprefix(prefix)
                if suffix.isdigit():
                    occupied.add(int(suffix))
        return max(occupied, default=0)

    @staticmethod
    def _id_candidate_exists(
        candidate: int,
        *,
        prefix: str,
        roots: tuple[Path, Path],
        books: dict,
    ) -> bool:
        """Check a candidate with O(1) registry/path lookups."""

        if str(candidate) in books:
            return True

        # Canonical IDs are zero-padded to four places, but also protect old
        # unpadded directories that may be created after the initial scan.
        directory_names = {f"{prefix}{candidate:04d}", f"{prefix}{candidate}"}
        return any((root / name).exists() for root in roots for name in directory_names)

    def _touch(self, book_id: str, *, persist: bool = True) -> None:
        info = self.lookup(book_id)
        if info:
            info["updated_at"] = _utc_now()
            if persist:
                self.save()

    def _load_path(self, path: Path) -> dict:
        if path.exists():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                payload.setdefault("last_id", len(payload.get("books", {})))
                return payload
            except json.JSONDecodeError:
                logger.warning("Could not parse %s, starting fresh", path)
        return {
            "layout_version": "novel-agent-data-v1",
            "last_id": 0,
            "books": {},
        }

    def _load(self) -> dict:
        return self._load_path(self.path)

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

    def _write_payload_unlocked(self, target: Path | None = None) -> None:
        """Write the current payload assuming the caller already holds the lock."""
        dest = target or self.path
        tmp_path = str(dest) + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(self.payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, dest)

    # ------------------------------------------------------------------
    # Failed-URL tracking — prevents retrying permanently broken pages
    # ------------------------------------------------------------------

    def _load_failed(self) -> set[str]:
        if self._failed_path.exists():
            try:
                data = json.loads(self._failed_path.read_text(encoding="utf-8"))
                return set(data.get("urls", []))
            except json.JSONDecodeError:
                pass
        return set()

    def _save_failed(self) -> None:
        self._failed_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(self._failed_path) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"urls": sorted(self._failed_urls)}, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self._failed_path)

    def mark_failed(self, url: str) -> None:
        """Record *url* as permanently failed — skip on future runs."""
        canonical = _canonicalize_url(url)
        if canonical not in self._failed_urls:
            self._failed_urls.add(canonical)
            self._save_failed()
            logger.info("Marked as failed: %s", canonical)

    def is_failed(self, url: str) -> bool:
        """Check if *url* was previously marked as failed."""
        return _canonicalize_url(url) in self._failed_urls
