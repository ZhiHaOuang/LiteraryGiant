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
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from shared.constants import RUNS_ROOT

from .adapters.base import BaseAdapter, ChapterEntry
from .registry import BookRegistry
from .utils import RateLimiter, build_session, decode_response, random_user_agent

logger = logging.getLogger(__name__)

RUNS_FETCH_DIR = RUNS_ROOT / "fetch"
MAX_CHAPTER_PAGES = 20  # safety cap for multi-page chapters


class FetcherEngine:
    """Orchestrate the download of a complete web novel.

    Parameters:
        adapter: Site-specific adapter for DOM parsing.
        min_delay: Minimum seconds between chapter batches.
        max_chapters: Stop after N chapters (for testing).
        concurrency: How many chapters to fetch in parallel (1 = serial).
        min_completion: Fraction of chapters that must succeed (0.0–1.0).
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
    ) -> None:
        self.adapter = adapter
        self.rate_limiter = RateLimiter(min_delay=min_delay)
        self.max_chapters = max_chapters
        self.output_encoding = output_encoding
        self.run_id = run_id or uuid.uuid4().hex[:12]
        self.concurrency = max(1, concurrency)
        self.min_completion = min_completion
        self.session = build_session()
        self.registry = BookRegistry()

        # Thread-safe manifest lock
        self._manifest_lock = Lock()

        # Run-level stats
        self._started_at: float = 0.0
        self._total_chapters: int = 0
        self._fetched_chapters: int = 0
        self._failed_chapter_urls: list[str] = []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fetch_novel(self, url: str) -> Path:
        """Fetch a complete novel: stage, validate, promote."""
        self._started_at = time.monotonic()

        # 1. Fetch index page
        index_html, index_url = self._fetch_page(url)
        index_soup = BeautifulSoup(index_html, "html.parser")

        # 2. Extract metadata
        title = self.adapter.extract_title(index_soup, index_url)
        chapters = self.adapter.extract_chapter_list(index_soup, index_url)
        if self.max_chapters is not None:
            chapters = chapters[: self.max_chapters]
        self._total_chapters = len(chapters)

        # 3. Register book → numeric ID
        book_slug = self.registry.register(
            title, source_url=url, adapter_domain=self.adapter.domain,
        )
        logger.info("Book: %s → %s  (%d chapters, concurrency=%d)",
                     title, book_slug, self._total_chapters, self.concurrency)

        # 4. Fetch chapters → staging (parallel)
        staging_dir = RUNS_FETCH_DIR / self.run_id / book_slug
        staging_dir.mkdir(parents=True, exist_ok=True)

        manifest = self._build_manifest(title, url, book_slug, chapters)
        self._fetched_chapters = self._fetch_all_chapters_parallel(
            chapters, staging_dir, manifest,
        )

        # 5. Write index.json
        index_path = staging_dir / "index.json"
        index_path.write_text(
            _json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # 6. Validate → promote
        self._validate_or_raise(staging_dir, manifest)
        canonical_dir = self._promote(staging_dir, book_slug)
        self._write_run_summary(book_slug, canonical_dir, manifest, success=True)

        elapsed = time.monotonic() - self._started_at
        logger.info("Done: %s → %s  (%d chapters, %.1fs)", url, canonical_dir, self._fetched_chapters, elapsed)
        return canonical_dir

    # ------------------------------------------------------------------
    # Manifest
    # ------------------------------------------------------------------

    def _build_manifest(self, title: str, url: str, book_slug: str,
                        chapters: list[ChapterEntry]) -> dict:
        return {
            "title": title, "source_url": url, "book_slug": book_slug,
            "fetcher_run_id": self.run_id,
            "fetched_at": _json.dumps(int(time.time())),
            "adapter_domain": self.adapter.domain,
            "total_expected": len(chapters), "total_fetched": 0,
            "total_failed": 0, "chapters": [],
        }

    # ------------------------------------------------------------------
    # Parallel chapter fetching
    # ------------------------------------------------------------------

    def _fetch_all_chapters_parallel(
        self,
        chapters: list[ChapterEntry],
        staging_dir: Path,
        manifest: dict,
    ) -> int:
        """Fetch chapters concurrently with bounded parallelism."""
        total = len(chapters)
        written = 0
        failed = 0

        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            # Submit all chapter-fetch tasks
            futures: dict = {}
            for idx, chapter in enumerate(chapters, 1):
                file_name = f"chapter_{idx:04d}.txt"
                chapter_path = staging_dir / file_name

                # Skip cached
                if chapter_path.exists() and chapter_path.stat().st_size > 0:
                    manifest["chapters"].append({
                        "order": idx, "title": chapter.title,
                        "file_name": file_name, "url": chapter.url,
                        "status": "cached",
                        "file_size": chapter_path.stat().st_size,
                    })
                    written += 1
                    continue

                future = pool.submit(
                    self._fetch_chapter_with_index, idx, chapter, chapter_path,
                )
                futures[future] = (idx, chapter, file_name)

            # Collect results as they complete
            for future in as_completed(futures):
                idx, chapter, file_name = futures[future]
                try:
                    content = future.result()
                    self._manifest_lock.acquire()
                    try:
                        manifest["chapters"].append({
                            "order": idx, "title": chapter.title,
                            "file_name": file_name, "url": chapter.url,
                            "status": "ok",
                            "char_count": len(content),
                        })
                    finally:
                        self._manifest_lock.release()
                    written += 1
                except Exception as exc:
                    self._manifest_lock.acquire()
                    try:
                        manifest["chapters"].append({
                            "order": idx, "title": chapter.title,
                            "file_name": file_name, "url": chapter.url,
                            "status": "failed",
                            "error": str(exc)[:200],
                        })
                    finally:
                        self._manifest_lock.release()
                    self._failed_chapter_urls.append(chapter.url)
                    failed += 1
                    logger.error("Failed chapter %d/%d: %s — %s",
                                 idx, total, chapter.title, exc)

                if (written + failed) % 50 == 0 or (written + failed) == total:
                    logger.info("Progress: %d/%d chapters (%d failed)",
                                written + failed, total, failed)

        manifest["total_fetched"] = written
        manifest["total_failed"] = failed
        return written

    def _fetch_chapter_with_index(
        self, idx: int, chapter: ChapterEntry, chapter_path: Path,
    ) -> str:
        """Fetch one chapter and write to disk.  Thread-safe."""
        content = self._fetch_chapter(chapter)
        chapter_path.write_text(content, encoding=self.output_encoding)
        return content

    # ------------------------------------------------------------------
    # Single-chapter fetch (with intra-chapter page parallelism)
    # ------------------------------------------------------------------

    def _fetch_chapter(self, chapter: ChapterEntry) -> str:
        """Fetch one chapter — pages in parallel, ordered on assembly.

        1. Fetch page 1 serially to discover the pagination pattern.
        2. Predict page-2 … page-N URLs and fetch them in parallel.
        3. Assemble all pages in order.
        """
        self.rate_limiter.wait()

        # --- Page 1 (serial — to discover multi-page structure) ---
        html_text, final_url = self._fetch_page(chapter.url)
        html_text = self.adapter.preprocess_html(html_text, final_url)
        soup = BeautifulSoup(html_text, "html.parser")

        next_url = self.adapter.extract_next_page_url(soup, final_url)
        part1 = self._extract_page_content(soup, final_url)

        if not next_url:
            # Single-page chapter — done
            return part1

        # --- Predict remaining page URLs ---
        # bqquge pattern: /book_id/chap_id → /book_id/chap_id-2 → chap_id-3 …
        # We fetch pages 2..N in parallel, then check if page N+1 exists.
        page_urls = self._discover_page_urls(chapter.url, next_url)
        all_parts: list[str] = [part1] if part1 else []

        # Fetch extra pages in parallel
        if page_urls:
            with ThreadPoolExecutor(max_workers=min(len(page_urls), 8)) as pool:
                page_futures = {
                    pool.submit(self._fetch_single_page, url): (i, url)
                    for i, url in enumerate(page_urls, 2)
                }
                page_results: dict[int, str] = {}
                for future in as_completed(page_futures):
                    pg, url = page_futures[future]
                    try:
                        page_results[pg] = future.result()
                    except Exception as exc:
                        logger.warning("Page %d failed for %s: %s", pg, chapter.url, exc)

                # Assemble in page order
                for pg in sorted(page_results):
                    if page_results[pg]:
                        all_parts.append(page_results[pg])

        logger.debug("Chapter: %d pages", len(all_parts))
        return "\n\n".join(all_parts)

    def _discover_page_urls(
        self, first_url: str, next_url: str,
    ) -> list[str]:
        """Given page 1 URL and page 2 URL, predict page 3…N URLs.

        Fetches pages speculatively — stops when a predicted URL 404s.
        """
        urls = [next_url]
        # Try to predict the pattern: if next_url ends with "-2",
        # page 3 is "-3", etc.
        if next_url.endswith("-2") and not first_url.endswith("-2"):
            base = next_url[:-2]  # strip "-2"
            # Try up to MAX_CHAPTER_PAGES
            for n in range(3, MAX_CHAPTER_PAGES + 1):
                urls.append(f"{base}-{n}")
        return urls

    def _fetch_single_page(self, url: str) -> str:
        """Fetch a single page → extract content.  Used for parallel page fetches."""
        # Each thread needs its own session
        sess = build_session()
        sess.headers.update({"User-Agent": random_user_agent()})
        resp = sess.get(url)
        resp.raise_for_status()
        text = decode_response(resp)
        text = self.adapter.preprocess_html(text, url)
        soup = BeautifulSoup(text, "html.parser")
        return self._extract_page_content(soup, url)

    def _extract_page_content(self, soup: BeautifulSoup, url: str) -> str:
        """Extract and minimally normalise text from one page."""
        part = self.adapter.extract_content(soup, url)
        part = part.replace("\r\n", "\n").replace("\r", "\n")
        return part.strip()

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
        if canonical_dir.exists():
            logger.info("Replacing existing: %s", canonical_dir)
            shutil.rmtree(canonical_dir)
        canonical_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging_dir), str(canonical_dir))
        logger.info("Promoted: %s → %s", staging_dir.name, canonical_dir)

        chapter_count = len(list(canonical_dir.glob("chapter_*.txt")))
        self.registry.update(book_slug, last_fetched={
            "run_id": self.run_id, "chapters": chapter_count,
            "at": _json.dumps(int(time.time())),
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
        if run_index_path.exists():
            run_index = _json.loads(run_index_path.read_text(encoding="utf-8"))
        else:
            run_index = {"runs": []}

        elapsed = time.monotonic() - self._started_at
        entry = {
            "run_id": self.run_id, "book_slug": book_slug,
            "title": manifest.get("title", ""),
            "source_url": manifest.get("source_url", ""),
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
        run_index["runs"].append(entry)
        run_index_path.write_text(
            _json.dumps(run_index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_page(self, url: str, encoding: str | None = None) -> tuple[str, str]:
        """Fetch a page, detect encoding, return (html_text, final_url)."""
        self.session.headers.update({"User-Agent": random_user_agent()})
        response = self.session.get(url)
        response.raise_for_status()

        if encoding:
            text = response.content.decode(encoding, errors="replace")
        else:
            text = decode_response(response)

        if not text or len(text.strip()) < 50:
            raise RuntimeError(
                f"Fetched page at {url} is too short ({len(text)} chars)"
            )
        return text, response.url
