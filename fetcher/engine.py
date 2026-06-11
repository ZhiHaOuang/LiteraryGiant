"""Site-agnostic novel fetcher — orchestrates HTTP + staging + promotion.

All site-specific logic lives in :class:`~fetcher.adapters.base.BaseAdapter`.
This engine is reusable across any site by swapping adapters.

Supports two-level concurrency:
* **Intra-chapter**: pages of a multi-page chapter are fetched in parallel.
* **Inter-chapter**: multiple chapters are fetched concurrently (configurable).

The fetcher does **not** clean text — noise filtering is the responsibility of
:mod:`Jormungandr.hardmodel`.
"""

from __future__ import annotations

import json as _json
import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup
from shared.constants import RUNS_ROOT

from .adapters.base import BaseAdapter, ChapterEntry
from .registry import BookRegistry, _canonicalize_url
from .utils import (
    FileLock,
    RateLimiter,
    build_session,
    decode_response,
    fetch_with_retry,
    random_user_agent,
)

logger = logging.getLogger(__name__)

RUNS_FETCH_DIR = RUNS_ROOT / "fetch"
CHECKPOINT_INTERVAL = 10  # flush manifest to disk every N completed chapters
BOOK_MIN_DISCOVERED_PARTS = 20
BOOK_MIN_TOTAL_CHARS = 100_000
BOOK_STRONG_TOTAL_CHARS = 180_000
STORY_MIN_CHARS = 50


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write *payload* as JSON to *path* atomically (tmp + rename)."""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(
        _json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _chapter_file_name(order: int) -> str:
    """Return the canonical chapter filename for a 1-based chapter order."""
    return f"chapter_{order:04d}.txt"


class FetcherEngine:
    """Orchestrate the download of a complete web novel or short story.

    Parameters:
        adapter: Site-specific adapter for DOM parsing.
        min_delay: Minimum seconds between chapter batches.
        max_chapters: Stop after N chapters (for testing). Ignored for stories.
        concurrency: How many chapters to fetch in parallel (1 = serial).
        min_completion: Fraction of chapters that must succeed (0.0–1.0).
        content_type: ``"book"`` (multi-chapter novel) or ``"story"`` (single page).
        rate_limiter: Optional shared rate limiter for cross-site coordination.
    """

    def __init__(
        self,
        adapter: BaseAdapter,
        *,
        min_delay: float = 0.2,
        max_chapters: int | None = None,
        output_encoding: str = "utf-8",
        run_id: str | None = None,
        concurrency: int = 3,
        min_completion: float = 0.8,
        content_type: str = "auto",
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        if content_type not in {"auto", "book", "story"}:
            raise ValueError("content_type must be one of: auto, book, story")
        self.adapter = adapter
        self.rate_limiter = rate_limiter or RateLimiter(min_delay=min_delay)
        self.max_chapters = max_chapters
        self.output_encoding = output_encoding
        self.run_id = run_id or uuid.uuid4().hex[:12]
        self.concurrency = max(1, concurrency)
        self.min_completion = min_completion
        self.content_type = content_type
        self.registry = BookRegistry()

        # Thread-safe sessions: each thread gets its own Session via _get_session()
        self._local = threading.local()

        # Thread-safe manifest lock
        self._manifest_lock = threading.Lock()

        # Run-level stats
        self._started_at: float = 0.0
        self._total_chapters: int = 0
        self._fetched_chapters: int = 0
        self._failed_chapter_urls: list[str] = []

    # ------------------------------------------------------------------
    # Thread-safe session factory
    # ------------------------------------------------------------------

    def _get_session(self):
        """Return a thread-local ``requests.Session`` (lazy, thread-safe)."""
        if not hasattr(self._local, "session"):
            self._local.session = build_session()
        return self._local.session

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fetch_novel(self, url: str) -> Path:
        """Fetch a novel or story — auto-detects book vs story from content.

        Classification is based on fetched content statistics, not just whether
        the page exposes multiple links. A multi-part short story still becomes
        a ``story_XXXX`` idea seed unless it looks like a long-form book.
        """
        self._started_at = time.monotonic()

        # 1. Fetch page
        html_text, final_url = self._fetch_page(url)
        html_text = self.adapter.preprocess_html(html_text, final_url)
        soup = BeautifulSoup(html_text, "html.parser")

        title = self.adapter.extract_title(soup, final_url)

        # 2. Try to extract chapter list → auto-detect book vs story
        try:
            chapters = self.adapter.extract_chapter_list(soup, final_url)
        except Exception:
            chapters = []

        # 2b. Merge chapters from additional chapter-list pages (pagination)
        seen_chapter_urls = {_canonicalize_url(ch.url) for ch in chapters}
        seen_list_urls: set[str] = {_canonicalize_url(final_url)}
        pending: list[str] = []
        try:
            pending = self.adapter.discover_chapter_list_urls(soup, final_url)
        except Exception:
            pass

        while pending:
            page_url = pending.pop(0)
            page_key = _canonicalize_url(page_url)
            if page_key in seen_list_urls:
                continue
            seen_list_urls.add(page_key)

            try:
                page_html, _ = self._fetch_page(page_url)
                page_soup = BeautifulSoup(page_html, "html.parser")
                page_chapters = self.adapter.extract_chapter_list(page_soup, page_url)

                for ch in page_chapters:
                    url_key = _canonicalize_url(ch.url)
                    if url_key in seen_chapter_urls:
                        continue
                    seen_chapter_urls.add(url_key)
                    chapters.append(ChapterEntry(
                        title=ch.title, url=ch.url, order=len(chapters) + 1,
                    ))

                # Recursively discover further pages from THIS page
                try:
                    more = self.adapter.discover_chapter_list_urls(page_soup, page_url)
                    for u in more:
                        if _canonicalize_url(u) not in seen_list_urls:
                            pending.append(u)
                except Exception:
                    pass
            except Exception as exc:
                logger.warning("Failed to fetch chapter-list page %s: %s", page_url, exc)

        if chapters and len(chapters) >= 2:
            return self._fetch_as_book(url, final_url, soup, title, chapters)

        if self.content_type == "book":
            raise RuntimeError(
                f"Forced book classification but no chapter list was found for {url}"
            )

        # 3. No chapter list → treat as single-page story
        return self._fetch_as_story(url, final_url, soup, title)

    # ------------------------------------------------------------------
    # Book path (multi-chapter)
    # ------------------------------------------------------------------

    def _fetch_as_book(
        self, url: str, final_url: str, soup, title: str, chapters: list[ChapterEntry],
    ) -> Path:
        discovered_chapter_count = len(chapters)
        if self.max_chapters is not None:
            chapters = chapters[: self.max_chapters]
        self._total_chapters = len(chapters)

        # ── Register FIRST (3 ms) to prevent duplicate concurrent downloads ──
        # Provisional guess: many chapters → book, few chapters → story.
        # If the final classification disagrees, we fix the registration below.
        provisional_type = "book" if len(chapters) >= BOOK_MIN_DISCOVERED_PARTS else "story"
        slug = self.registry.register(
            title,
            source_url=url,
            adapter_domain=self.adapter.domain,
            content_type=provisional_type,
        )

        candidate_slug = slug  # use the canonical slug directly
        staging_dir = RUNS_FETCH_DIR / self.run_id / candidate_slug
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

        manifest = self._build_manifest(
            title, url, candidate_slug, chapters,
            discovered_chapter_count=discovered_chapter_count,
        )
        manifest["book_slug"] = slug

        try:
            # ── Download ──────────────────────────────────────────────
            self._fetched_chapters = self._fetch_all_chapters_parallel(
                chapters, staging_dir, manifest,
            )
            self._tidy_manifest(manifest)
            _atomic_write_json(staging_dir / "index.json", manifest)
            self._validate_or_raise(staging_dir, manifest)

            classification = self._classify_chaptered_work(
                manifest, staging_dir, discovered_chapter_count=discovered_chapter_count,
            )
            manifest.update(classification)

            content_type = classification["content_type"]
            # Fix registration if provisional guess was wrong
            if content_type != provisional_type:
                logger.info("Reclassifying: provisional=%s final=%s, re-registering", provisional_type, content_type)
                self.registry.deregister(slug)
                slug = self.registry.register(
                    title, source_url=url,
                    adapter_domain=self.adapter.domain,
                    content_type=content_type,
                )
                manifest["book_slug"] = slug

            if content_type == "story":
                manifest["story_slug"] = slug

            logger.info(
                "%s: %s → %s  (parts=%d/%d, chars=%d, profile=%s)",
                content_type.title(), title, slug,
                classification["content_stats"]["fetched_parts"],
                discovered_chapter_count,
                classification["content_stats"]["total_chars"],
                classification["processing_profile"],
            )

            with self._slug_lock(slug):
                if content_type == "story":
                    self._convert_chaptered_staging_to_story(staging_dir, manifest)
                    self._validate_or_raise_story(staging_dir, manifest)
                _atomic_write_json(staging_dir / "index.json", manifest)
                canonical_dir = self._promote(staging_dir, slug)
                self._update_registry_profile(slug, manifest)
                self._write_run_summary(slug, canonical_dir, manifest, success=True)

            elapsed = time.monotonic() - self._started_at
            logger.info("Done: %s → %s  (%d parts, %.1fs)", url, canonical_dir, self._fetched_chapters, elapsed)
            return canonical_dir

        except Exception:
            # ── Clean up failed download ──────────────────────────────
            logger.warning("Download failed for %s, deregistering %s", url, slug)
            shutil.rmtree(staging_dir, ignore_errors=True)
            self.registry.deregister(slug)
            raise

    # ------------------------------------------------------------------
    # Story path (single page)
    # ------------------------------------------------------------------

    def _fetch_as_story(
        self, url: str, final_url: str, soup, title: str,
    ) -> Path:
        if self.content_type == "book":
            raise RuntimeError(
                f"Forced book classification but {url} looks like a single-page story"
            )

        content = self._extract_page_content(soup, final_url)
        char_count = len(content)

        if char_count < STORY_MIN_CHARS:
            manifest = {
                "title": title, "source_url": url,
                "content_type": "story", "char_count": char_count,
                "fetcher_run_id": self.run_id, "fetched_at": _utc_now(),
                "adapter_domain": self.adapter.domain,
            }
            self._write_run_summary("unregistered_story", None, manifest,
                                     success=False, errors=[f"Story content too short ({char_count} chars)"])
            raise RuntimeError(f"Story content too short ({char_count} chars) for {url}")

        story_slug = self.registry.register(
            title, source_url=url, adapter_domain=self.adapter.domain, content_type="story",
        )
        classification = self._single_story_classification(char_count)

        manifest = {
            "title": title, "source_url": url,
            "story_slug": story_slug, "content_type": "story",
            "fetcher_run_id": self.run_id, "fetched_at": _utc_now(),
            "adapter_domain": self.adapter.domain, "char_count": char_count,
            **classification,
        }

        staging_dir = RUNS_FETCH_DIR / self.run_id / story_slug
        try:
            with self._slug_lock(story_slug):
                existing_dir = self._existing_alternate_content_dir(story_slug, url)
                if existing_dir is not None:
                    manifest["skipped_reason"] = "duplicate_title_alternate_source"
                    self._write_run_summary(story_slug, existing_dir, manifest, success=True)
                    logger.info("Skipping duplicate alternate source for %s: %s", story_slug, url)
                    return existing_dir

                staging_dir.mkdir(parents=True, exist_ok=True)
                story_path = staging_dir / "story.txt"
                story_path.write_text(content, encoding=self.output_encoding)

                _atomic_write_json(staging_dir / "index.json", manifest)
                self._validate_or_raise_story(staging_dir, manifest)
                canonical_dir = self._promote(staging_dir, story_slug)
                self._update_registry_profile(story_slug, manifest)
                self._write_run_summary(story_slug, canonical_dir, manifest, success=True)

            elapsed = time.monotonic() - self._started_at
            logger.info("Story: %s → %s  (%d chars, %.1fs)", title, story_slug, char_count, elapsed)
            return canonical_dir
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            self.registry.deregister(story_slug)
            raise

    def _validate_or_raise_story(self, staging_dir: Path, manifest: dict) -> None:
        """Minimal validation for a single story."""
        story_path = staging_dir / "story.txt"
        if not story_path.exists():
            raise RuntimeError(f"Missing story.txt in {staging_dir}")
        if story_path.stat().st_size == 0:
            raise RuntimeError(f"Empty story.txt in {staging_dir}")

    # ------------------------------------------------------------------
    # Classification
    # ------------------------------------------------------------------

    def _single_story_classification(self, char_count: int) -> dict:
        return {
            "processing_profile": "idea_seed",
            "structure_type": "single_part",
            "story_form": self._story_form(char_count),
            "content_stats": {
                "discovered_parts": 1,
                "fetched_parts": 1,
                "total_chars": char_count,
                "avg_part_chars": char_count,
            },
            "classification": {
                "mode": self.content_type,
                "decision": "story",
                "reasons": ["single_content_page"],
            },
        }

    def _classify_chaptered_work(
        self,
        manifest: dict,
        staging_dir: Path,
        *,
        discovered_chapter_count: int,
    ) -> dict:
        stats = self._chaptered_content_stats(manifest, staging_dir, discovered_chapter_count)
        reasons: list[str] = []

        if self.content_type == "book":
            content_type = "book"
            reasons.append("forced_book")
        elif self.content_type == "story":
            content_type = "story"
            reasons.append("forced_story")
        elif stats["total_chars"] >= BOOK_STRONG_TOTAL_CHARS:
            content_type = "book"
            reasons.append(f"total_chars>={BOOK_STRONG_TOTAL_CHARS}")
        elif stats["total_chars"] >= BOOK_MIN_TOTAL_CHARS and stats["fetched_parts"] >= 8:
            content_type = "book"
            reasons.append(f"total_chars>={BOOK_MIN_TOTAL_CHARS}_and_fetched_parts>=8")
        elif stats["discovered_parts"] >= BOOK_MIN_DISCOVERED_PARTS:
            content_type = "book"
            reasons.append(f"discovered_parts>={BOOK_MIN_DISCOVERED_PARTS}")
        else:
            content_type = "story"
            reasons.append("below_longform_thresholds")

        if content_type == "book":
            structure_type = "chaptered"
            processing_profile = "longform_book"
            story_form = None
        else:
            structure_type = "multi_part"
            processing_profile = "idea_seed"
            story_form = self._story_form(stats["total_chars"])

        payload = {
            "content_type": content_type,
            "processing_profile": processing_profile,
            "structure_type": structure_type,
            "content_stats": stats,
            "classification": {
                "mode": self.content_type,
                "decision": content_type,
                "reasons": reasons,
                "thresholds": {
                    "book_min_discovered_parts": BOOK_MIN_DISCOVERED_PARTS,
                    "book_min_total_chars": BOOK_MIN_TOTAL_CHARS,
                    "book_strong_total_chars": BOOK_STRONG_TOTAL_CHARS,
                },
            },
        }
        if story_form:
            payload["story_form"] = story_form
        return payload

    def _chaptered_content_stats(
        self,
        manifest: dict,
        staging_dir: Path,
        discovered_chapter_count: int,
    ) -> dict:
        successful_entries = [
            entry for entry in manifest.get("chapters", [])
            if entry.get("status") in ("ok", "cached")
        ]
        total_chars = 0
        char_counts: list[int] = []

        for entry in successful_entries:
            chapter_path = staging_dir / entry.get("file_name", "")
            if chapter_path.exists():
                char_count = len(chapter_path.read_text(encoding=self.output_encoding))
                entry["char_count"] = char_count
            else:
                char_count = int(entry.get("char_count") or 0)
            char_counts.append(char_count)
            total_chars += char_count

        fetched_parts = len(successful_entries)
        return {
            "discovered_parts": discovered_chapter_count,
            "fetched_parts": fetched_parts,
            "total_chars": total_chars,
            "avg_part_chars": round(total_chars / fetched_parts, 2) if fetched_parts else 0,
            "min_part_chars": min(char_counts) if char_counts else 0,
            "max_part_chars": max(char_counts) if char_counts else 0,
        }

    @staticmethod
    def _story_form(total_chars: int) -> str:
        if total_chars < 30_000:
            return "short_story"
        if total_chars < 80_000:
            return "novelette"
        return "novella"

    def _convert_chaptered_staging_to_story(self, staging_dir: Path, manifest: dict) -> None:
        """Convert fetched chapter files into a multi-part story layout."""
        successful_entries = [
            entry for entry in manifest.get("chapters", [])
            if entry.get("status") in ("ok", "cached")
        ]
        successful_entries.sort(key=lambda entry: int(entry["order"]))
        if not successful_entries:
            raise RuntimeError(f"No fetched parts available to build story.txt in {staging_dir}")

        parts_dir = staging_dir / "parts"
        parts_dir.mkdir(parents=True, exist_ok=True)
        story_sections: list[str] = []
        parts: list[dict] = []

        for part_order, entry in enumerate(successful_entries, start=1):
            source_name = entry.get("file_name", _chapter_file_name(int(entry["order"])))
            source_path = staging_dir / source_name
            if not source_path.exists():
                raise RuntimeError(f"Missing fetched part file: {source_path}")

            title = str(entry.get("title") or f"part_{part_order:04d}").strip()
            content = source_path.read_text(encoding=self.output_encoding).strip()
            part_name = f"part_{part_order:04d}.txt"
            part_text = f"{title}\n\n{content}\n" if content else f"{title}\n"
            (parts_dir / part_name).write_text(part_text, encoding=self.output_encoding)
            story_sections.append(part_text.strip())
            parts.append(
                {
                    "order": part_order,
                    "title": title,
                    "file_name": f"parts/{part_name}",
                    "source_url": entry.get("url", ""),
                    "char_count": len(content),
                }
            )
            source_path.unlink()

        story_text = "\n\n".join(section for section in story_sections if section).strip()
        if len(story_text) < STORY_MIN_CHARS:
            raise RuntimeError(
                f"Combined story content too short ({len(story_text)} chars) in {staging_dir}"
            )
        (staging_dir / "story.txt").write_text(story_text + "\n", encoding=self.output_encoding)

        manifest.pop("chapters", None)
        manifest["parts"] = parts
        manifest["source_type"] = "multi_part_story"
        manifest["char_count"] = len(story_text)
        manifest["total_expected"] = len(parts)
        manifest["total_fetched"] = len(parts)

    def _update_registry_profile(self, slug: str, manifest: dict) -> None:
        updates = {
            key: manifest[key]
            for key in (
                "content_type",
                "processing_profile",
                "structure_type",
                "story_form",
                "content_stats",
                "classification",
            )
            if key in manifest
        }
        if updates:
            self.registry.update(slug, **updates)

    # ------------------------------------------------------------------
    # Manifest
    # ------------------------------------------------------------------

    def _build_manifest(
        self,
        title: str,
        url: str,
        book_slug: str,
        chapters: list[ChapterEntry],
        *,
        discovered_chapter_count: int | None = None,
    ) -> dict:
        return {
            "title": title, "source_url": url, "book_slug": book_slug,
            "content_type": "unclassified",
            "fetcher_run_id": self.run_id,
            "fetched_at": _utc_now(),
            "adapter_domain": self.adapter.domain,
            "total_discovered": discovered_chapter_count or len(chapters),
            "total_expected": len(chapters), "total_fetched": 0,
            "total_failed": 0, "chapters": [],
        }

    @staticmethod
    def _tidy_manifest(manifest: dict) -> None:
        """Sort chapter entries by order and deduplicate.

        Called after all chapters are fetched to produce a clean, ordered
        ``index.json`` regardless of the parallel fetch completion order.
        """
        entries = manifest.get("chapters", [])
        if not entries:
            return

        # Dedup by order — keep last occurrence (most recent status)
        seen: dict[int, dict] = {}
        for entry in entries:
            try:
                order = int(entry["order"])
            except (KeyError, ValueError):
                continue
            seen[order] = entry

        # Sort by order
        deduped = [seen[order] for order in sorted(seen)]
        ok_count = sum(1 for e in deduped if e.get("status") in ("ok", "cached"))
        failed_count = sum(1 for e in deduped if e.get("status") == "failed")

        manifest["chapters"] = deduped
        manifest["total_fetched"] = ok_count
        manifest["total_failed"] = failed_count
    # ------------------------------------------------------------------

    def _fetch_all_chapters_parallel(
        self,
        chapters: list[ChapterEntry],
        staging_dir: Path,
        manifest: dict,
    ) -> int:
        """Fetch chapters concurrently with bounded parallelism.

        Supports **resume**: if a previous run left chapters on disk (and a
        partial ``index.json``), those chapters are skipped and counted as
        cached.  The manifest is checkpointed to disk every
        ``CHECKPOINT_INTERVAL`` completed chapters so that a crash loses at
        most one batch of work.
        """
        total = len(chapters)

        # --- Resume: load existing manifest if present ---
        checkpoint_path = staging_dir / "index.json"
        completed_orders: set[int] = set()
        if checkpoint_path.exists():
            try:
                prev = _json.loads(checkpoint_path.read_text(encoding="utf-8"))
                for entry in prev.get("chapters", []):
                    if entry.get("status") not in ("ok", "cached"):
                        continue
                    order = int(entry["order"])
                    chapter_path = staging_dir / _chapter_file_name(order)
                    if chapter_path.exists() and chapter_path.stat().st_size > 0:
                        completed_orders.add(order)
                    else:
                        logger.warning(
                            "Ignoring stale checkpoint entry for missing chapter file: %s",
                            chapter_path.name,
                        )
                if completed_orders:
                    logger.info("Resuming: %d chapters already on disk", len(completed_orders))
            except (_json.JSONDecodeError, KeyError, ValueError):
                pass

        # Seed manifest with cached chapters
        written = 0
        failed = 0
        for chapter in chapters:
            order = chapter.order
            if order in completed_orders:
                file_name = _chapter_file_name(order)
                chapter_path = staging_dir / file_name
                file_size = chapter_path.stat().st_size if chapter_path.exists() else 0
                manifest["chapters"].append({
                    "order": order, "title": chapter.title,
                    "file_name": file_name, "url": chapter.url,
                    "status": "cached",
                    "file_size": file_size,
                })
                written += 1

        # --- Submit remaining chapters ---
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            futures: dict = {}
            for chapter in chapters:
                order = chapter.order
                if order in completed_orders:
                    continue

                file_name = _chapter_file_name(order)
                chapter_path = staging_dir / file_name

                # Check for on-disk cache (from an earlier run without manifest)
                if chapter_path.exists() and chapter_path.stat().st_size > 0:
                    with self._manifest_lock:
                        manifest["chapters"].append({
                            "order": order, "title": chapter.title,
                            "file_name": file_name, "url": chapter.url,
                            "status": "cached",
                            "file_size": chapter_path.stat().st_size,
                        })
                    written += 1
                    completed_orders.add(order)
                    continue

                future = pool.submit(
                    self._fetch_chapter_with_index, order, chapter, chapter_path,
                )
                futures[future] = (order, chapter, file_name)

            # --- Collect results as they complete ---
            for future in as_completed(futures):
                idx, chapter, file_name = futures[future]
                try:
                    char_count, error = future.result()
                    if error:
                        raise RuntimeError(error)

                    with self._manifest_lock:
                        manifest["chapters"].append({
                            "order": idx, "title": chapter.title,
                            "file_name": file_name, "url": chapter.url,
                            "status": "ok",
                            "char_count": char_count,
                        })
                    written += 1

                except Exception as exc:
                    with self._manifest_lock:
                        manifest["chapters"].append({
                            "order": idx, "title": chapter.title,
                            "file_name": file_name, "url": chapter.url,
                            "status": "failed",
                            "error": str(exc)[:200],
                        })
                    self._failed_chapter_urls.append(chapter.url)
                    failed += 1
                    logger.error("Failed chapter %d/%d: %s — %s",
                                 idx, total, chapter.title, exc)

                completed = written + failed
                if completed % CHECKPOINT_INTERVAL == 0:
                    with self._manifest_lock:
                        manifest["total_fetched"] = written
                        manifest["total_failed"] = failed
                        _atomic_write_json(checkpoint_path, manifest)
                    logger.info("Checkpoint: %d/%d chapters (%d failed)",
                                completed, total, failed)

                if completed % 50 == 0 or completed == total:
                    logger.info("Progress: %d/%d chapters (%d failed)",
                                completed, total, failed)

        manifest["chapters"].sort(key=lambda entry: int(entry["order"]))
        manifest["total_fetched"] = written
        manifest["total_failed"] = failed
        return written

    def _fetch_chapter_with_index(
        self, idx: int, chapter: ChapterEntry, chapter_path: Path,
    ) -> tuple[int, str | None]:
        """Fetch one chapter and write to disk.

        Returns:
            ``(char_count, None)`` on success, ``(0, error_msg)`` on failure.
            The content is never returned — only written to disk — to keep
            memory usage bounded.
        """
        content = self._fetch_chapter(chapter)
        chapter_path.write_text(content, encoding=self.output_encoding)
        return len(content), None

    # ------------------------------------------------------------------
    # Single-chapter fetch (with intra-chapter page parallelism)
    # ------------------------------------------------------------------

    def _fetch_chapter(self, chapter: ChapterEntry) -> str:
        """Fetch one chapter, following next-page links until none remain.

        1. Fetch current page, extract content.
        2. Ask adapter for an explicit "next page" link.
        3. If none found, try speculative ``_N.html`` suffix for sites like ibiquge
           that don't always render visible pagination links.
        """
        _MAX_PAGES = 10

        all_parts: list[str] = []
        seen_page_urls: set[str] = set()
        current_url = chapter.url
        base_url = chapter.url  # original page-1 URL

        for page_num in range(1, _MAX_PAGES + 1):
            current_key = _canonicalize_url(current_url)
            if current_key in seen_page_urls:
                break
            seen_page_urls.add(current_key)

            try:
                html_text, final_url = self._fetch_page(current_url)
            except Exception:
                if page_num > 1:
                    break  # speculative page doesn't exist — stop
                raise
            html_text = self.adapter.preprocess_html(html_text, final_url)
            soup = BeautifulSoup(html_text, "html.parser")

            # 1. Explicit "next page" link in the DOM — must be called BEFORE
            #    _extract_page_content because extract_content() may decompose
            #    navigation links (e.g. "下一章" <a> tags).
            explicit_next = self.adapter.extract_next_page_url(soup, final_url)

            page_content = self._extract_page_content(soup, final_url)
            all_parts.append(page_content)

            next_url: str | None = explicit_next

            # 2. Fallback: speculative _N.html pattern (invisible pagination)
            if not next_url:
                # Only try speculative when the current page actually had content
                if not page_content:
                    break
                import re
                next_page = page_num + 1
                speculative = re.sub(r"(\.html?)$", f"_{next_page}\\1", base_url)
                if (speculative != current_url
                        and _canonicalize_url(speculative) not in seen_page_urls):
                    next_url = speculative

            if not next_url:
                break
            if _canonicalize_url(next_url) in seen_page_urls:
                break
            current_url = next_url

        if len(all_parts) > 1:
            logger.debug("Chapter: %d pages", len(all_parts))
        return "\n\n".join(all_parts)

    def _extract_page_content(self, soup: BeautifulSoup, url: str) -> str:
        """Extract and minimally normalise text from one page."""
        part = self.adapter.extract_content(soup, url)
        return self.adapter.postprocess_content(part)

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def _validate_or_raise(self, staging_dir: Path, manifest: dict) -> None:
        expected = manifest.get("total_expected", 0)
        fetched = manifest.get("total_fetched", 0)
        failed = manifest.get("total_failed", 0)
        completion = fetched / max(expected, 1)

        failures: list[str] = []
        if completion < self.min_completion:
            failures.append(
                f"Completion {completion:.1%} below threshold {self.min_completion:.0%} "
                f"({fetched}/{expected} chapters, {failed} failed)"
            )
        for txt_file in sorted(staging_dir.glob("chapter_*.txt")):
            if txt_file.stat().st_size == 0:
                failures.append(f"Empty file: {txt_file.name}")
        actual_files = {
            txt_file.name for txt_file in staging_dir.glob("chapter_*.txt")
            if txt_file.is_file() and txt_file.stat().st_size > 0
        }
        successful_entries = [
            entry for entry in manifest.get("chapters", [])
            if entry.get("status") in ("ok", "cached")
        ]
        expected_files = {
            entry.get("file_name", _chapter_file_name(int(entry["order"])))
            for entry in successful_entries
        }
        missing_files = sorted(expected_files - actual_files)
        if missing_files:
            failures.append(
                "Missing chapter files referenced by manifest: "
                + ", ".join(missing_files[:5])
            )
        if len(actual_files) != len(successful_entries):
            failures.append(
                f"Manifest/file mismatch: {len(successful_entries)} successful entries "
                f"but {len(actual_files)} non-empty chapter files"
            )
        if not (staging_dir / "index.json").exists():
            failures.append("Missing index.json")
        if fetched == 0:
            failures.append("No chapters were fetched")

        if failures:
            msg = "Validation FAILED — promotion blocked:\n  " + "\n  ".join(failures)
            logger.error(msg)
            self._write_run_summary(
                manifest.get("book_slug", "unknown"),
                None, manifest, success=False, errors=failures,
            )
            raise RuntimeError(msg)

        logger.info("Validation passed: %d/%d chapters (%.0f%%)",
                     fetched, expected, completion * 100)

    # ------------------------------------------------------------------
    # Promotion
    # ------------------------------------------------------------------

    def _promote(self, staging_dir: Path, book_slug: str) -> Path:
        canonical_dir = self.registry.source_dir(book_slug)
        backup_dir = canonical_dir.with_name(
            f"{canonical_dir.name}.backup_{self.run_id}"
        )
        if canonical_dir.exists():
            logger.info("Replacing existing: %s", canonical_dir)
            if backup_dir.exists():
                shutil.rmtree(backup_dir)
            shutil.move(str(canonical_dir), str(backup_dir))
        canonical_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(staging_dir), str(canonical_dir))
        except Exception:
            if backup_dir.exists() and not canonical_dir.exists():
                shutil.move(str(backup_dir), str(canonical_dir))
            raise
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        logger.info("Promoted: %s → %s", staging_dir.name, canonical_dir)

        story_file = canonical_dir / "story.txt"
        if story_file.exists():
            part_count = len(list((canonical_dir / "parts").glob("part_*.txt")))
            self.registry.update(book_slug, last_fetched={
                "run_id": self.run_id,
                "source_type": "story",
                "bytes": story_file.stat().st_size,
                "parts": part_count,
                "at": _utc_now(),
            })
        else:
            chapter_count = len(list(canonical_dir.glob("chapter_*.txt")))
            self.registry.update(book_slug, last_fetched={
                "run_id": self.run_id, "source_type": "per_chapter",
                "chapters": chapter_count,
                "at": _utc_now(),
            })
        return canonical_dir

    # ------------------------------------------------------------------
    # Run summary
    # ------------------------------------------------------------------

    def _write_run_summary(self, book_slug: str, canonical_dir: Path | None,
                           manifest: dict, *, success: bool,
                           errors: list[str] | None = None) -> None:
        run_index_path = RUNS_FETCH_DIR / "run_index.json"
        run_index_path.parent.mkdir(parents=True, exist_ok=True)
        elapsed = time.monotonic() - self._started_at
        entry = {
            "run_id": self.run_id, "book_slug": book_slug,
            "title": manifest.get("title", ""),
            "source_url": manifest.get("source_url", ""),
            "content_type": manifest.get("content_type", "book"),
            "status": "ok" if success else "failed",
            "elapsed_sec": round(elapsed, 1),
            "concurrency": self.concurrency,
            "total_expected": manifest.get("total_expected", 0),
            "total_fetched": manifest.get("total_fetched", 0),
            "total_failed": manifest.get("total_failed", 0),
            "canonical_path": str(canonical_dir) if canonical_dir else None,
        }
        if errors:
            entry["errors"] = errors
        if "story_slug" in manifest:
            entry["story_slug"] = manifest["story_slug"]
        for key in (
            "processing_profile",
            "structure_type",
            "story_form",
            "content_stats",
            "classification",
        ):
            if key in manifest:
                entry[key] = manifest[key]
        if "skipped_reason" in manifest:
            entry["skipped_reason"] = manifest["skipped_reason"]
        with FileLock(str(run_index_path) + ".lock"):
            if run_index_path.exists():
                try:
                    run_index = _json.loads(run_index_path.read_text(encoding="utf-8"))
                except _json.JSONDecodeError:
                    logger.warning("Could not parse %s, starting a fresh run index", run_index_path)
                    run_index = {"runs": []}
            else:
                run_index = {"runs": []}
            run_index.setdefault("runs", []).append(entry)
            _atomic_write_json(run_index_path, run_index)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_page(self, url: str, encoding: str | None = None) -> tuple[str, str]:
        """Fetch a page, detect encoding, return (html_text, final_url)."""
        self.rate_limiter.wait()
        session = self._get_session()
        # Keep a stable UA per Session. Some sites compare index/chapter
        # requests and redirect when the UA changes mid-session.
        if "User-Agent" not in session.headers:
            session.headers.update({"User-Agent": random_user_agent()})
        # Apply adapter-specific headers (e.g. Referer for anti-bot sites)
        extra_headers = self.adapter.get_request_headers(url)
        if extra_headers:
            session.headers.update(extra_headers)
        # Apply adapter-specific cookies (e.g. consent cookies)
        extra_cookies = self.adapter.get_cookies()
        response = fetch_with_retry(session, url, cookies=extra_cookies if extra_cookies else None)

        if encoding:
            text = response.content.decode(encoding, errors="replace")
        elif getattr(self.adapter, "encoding", None):
            text = response.content.decode(self.adapter.encoding, errors="replace")
        else:
            text = decode_response(response)

        if not text or len(text.strip()) < 50:
            raise RuntimeError(
                f"Fetched page at {url} is too short ({len(text)} chars)"
            )
        return text, response.url

    def _slug_lock(self, slug: str) -> FileLock:
        """Return a cross-process lock for fetches that target the same slug."""
        lock_dir = RUNS_FETCH_DIR / "locks"
        lock_dir.mkdir(parents=True, exist_ok=True)
        return FileLock(str(lock_dir / f"{slug}.lock"))

    def _existing_alternate_content_dir(self, slug: str, source_url: str) -> Path | None:
        """Return existing content for duplicate alternate sources, if present."""
        info = self.registry.lookup(slug)
        if not info:
            return None

        primary_url = info.get("source_url", "")
        if not primary_url:
            return None
        if _canonicalize_url(primary_url) == _canonicalize_url(source_url):
            return None

        canonical_dir = self.registry.source_dir(slug)
        if self._has_content(canonical_dir):
            return canonical_dir
        return None

    @staticmethod
    def _has_content(path: Path) -> bool:
        if not path.exists():
            return False
        if (path / "story.txt").is_file() and (path / "story.txt").stat().st_size > 0:
            return True
        if (path / "source.txt").is_file() and (path / "source.txt").stat().st_size > 0:
            return True
        return any(
            chapter.is_file() and chapter.stat().st_size > 0
            for chapter in path.glob("chapter_*.txt")
        )
