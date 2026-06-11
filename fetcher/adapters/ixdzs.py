"""Adapter for 愛下電子書 (ixdzs.tw).

Book page:   ``/read/<id>/``
Chapter:     ``/read/<id>/p<num>.html``
Chapter list: ``<ul class="chapter-list">`` or links matching ``/read/<id>/p``
Content:     largest ``<div>`` block (no dedicated content div)
Encoding:    UTF-8 (Traditional Chinese).
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource

logger = logging.getLogger(__name__)

_AD_SELECTORS: list[str] = [
    "script", "style", "ins",
    "iframe", "form",
    ".footer", ".copyright",
    ".ads",
    "#page-toolbar",
    ".page-opt",
]


class IxdzsAdapter(BaseAdapter):
    """Adapter for 愛下電子書 at ``ixdzs.tw``."""

    domain = "ixdzs.tw"

    _INDEX_RE = re.compile(r"^/read/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/read/(\d+)/p(\d+)\.html?$")
    # Multi-page chapters use p1.html, p2.html — but those are separate chapters
    # on ixdzs, so we don't do multi-page merging here.

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("homepage_latest", "https://ixdzs.tw/", "homepage", 70),
            DiscoverySource("xuanhuan_category", "https://ixdzs.tw/sort/1/", "category", 60),
        ]

    # ------------------------------------------------------------------
    # Abstract methods
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract novel title from <h1> tag."""
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text:
                return self._clean_title(text)

        title_tag = soup.find("title")
        if title_tag:
            text = title_tag.get_text(strip=True)
            for sep in ("-", "|", "_", "—", "——"):
                if sep in text:
                    text = text.split(sep)[0].strip()
            return self._clean_title(text)

        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Parse chapter list from links matching ``/read/<id>/p`` pattern."""
        # Extract book id from base_url path
        path = urlparse(base_url).path
        m = self._INDEX_RE.search(path)
        if not m:
            raise ValueError(f"Not an index URL: {base_url}")
        book_id = m.group(1)
        pfx = f"/read/{book_id}/p"

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            full = urljoin(base_url, href)
            # Must contain /read/<id>/p and end with .html
            if pfx not in full or not full.endswith(".html"):
                continue
            if full in seen_urls:
                continue
            seen_urls.add(full)

            title = link.get_text(strip=True)
            if not title or title in ("立即閱讀", "开始阅读"):
                # Try to use chapter number as title
                ch_m = self._CHAPTER_RE.search(urlparse(full).path)
                if ch_m:
                    title = f"第{ch_m.group(2)}章"
                else:
                    continue

            order += 1
            chapters.append(ChapterEntry(title=title, url=full, order=order))

        if not chapters:
            raise ValueError(f"No chapter links found on {base_url}")

        by_num: dict[int, ChapterEntry] = {}
        for ch in chapters:
            num = self._chapter_page_number(ch.url)
            if num is not None:
                by_num[num] = ch

        if 1 in by_num and by_num:
            max_num = max(by_num)
            chapters = [
                by_num.get(n)
                or ChapterEntry(
                    title=f"第{n}章",
                    url=urljoin(base_url, f"p{n}.html"),
                    order=n,
                )
                for n in range(1, max_num + 1)
            ]
        else:
            chapters.sort(key=lambda ch: self._chapter_page_number(ch.url) or ch.order)

        chapters = [
            ChapterEntry(title=ch.title, url=ch.url, order=i)
            for i, ch in enumerate(chapters, 1)
        ]

        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract chapter body — ixdzs has no dedicated content div.

        Strategy: remove ads, find the largest text block.
        """
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Try common content containers
        content_div = None
        for sel in ["article.page-content", "#content", ".content",
                     "#chapter-content", ".article-content",
                     ".chapter-content", ".post-content", "section"]:
            content_div = soup.select_one(sel)
            if content_div and len(content_div.get_text(strip=True)) > 100:
                break
            content_div = None

        if content_div is None:
            # Find the largest text block
            best, best_len = None, 0
            for div in soup.find_all(["div", "article", "section"]):
                t = div.get_text(strip=True)
                if len(t) > best_len:
                    best_len, best = len(t), div
            content_div = best

        if content_div is None:
            raise ValueError(f"Could not find content on {base_url}")

        # Remove h1-h3
        for tag in content_div.find_all(["h1", "h2", "h3"]):
            tag.decompose()

        # Convert <br> to newlines
        for br in content_div.find_all("br"):
            br.replace_with("\n")

        paragraphs: list[str] = []
        for p in content_div.find_all("p"):
            text = p.get_text("\n").strip()
            if text and len(text) > 2:
                for line in text.splitlines():
                    line = line.strip()
                    if line and len(line) > 2:
                        paragraphs.append(line)

        if not paragraphs:
            text = content_div.get_text("\n")
            for line in text.splitlines():
                line = line.strip()
                if line and len(line) > 2:
                    paragraphs.append(line)

        # Chinese sentence split
        if len(paragraphs) <= 1 and paragraphs:
            blob = paragraphs[0] if paragraphs else ""
            chunks = re.split(r"(?<=[。！？])\s*", blob)
            paragraphs = [c.strip() for c in chunks if c.strip()]

        return "\n\n".join(paragraphs)

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract books from listing pages."""
        books: list[dict] = []
        seen: set[str] = set()
        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            m = self._INDEX_RE.search(href)
            if not m:
                # Also try full URLs
                full = urljoin(base_url, href)
                parsed = urlparse(full)
                m = self._INDEX_RE.search(parsed.path)
                if not m:
                    continue
            title = link.get_text(strip=True)
            if not title or len(title) < 2:
                continue
            full = urljoin(base_url, href)
            if full in seen:
                continue
            seen.add(full)
            books.append({"title": title, "url": full})
        return books

    def is_index_url(self, url: str) -> bool:
        path = urlparse(url).path.rstrip("/")
        if self._CHAPTER_RE.search(path):
            return False
        if self._INDEX_RE.search(path):
            return True
        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()

    def _chapter_page_number(self, url: str) -> int | None:
        m = self._CHAPTER_RE.search(urlparse(url).path)
        return int(m.group(2)) if m else None
