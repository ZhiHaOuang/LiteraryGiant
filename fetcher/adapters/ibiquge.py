"""Adapter for 笔趣阁小说网 (www.ibiquge.com).

Similar to bqquge but with these differences:
* Chapter URLs end with ``.html`` suffix.
* Multi-page chapters use ``_2.html``, ``_3.html`` suffix (underscore, not dash).
* Chapter list inside ``div.book_list``.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry

logger = logging.getLogger(__name__)

_AD_SELECTORS: list[str] = [
    "script",
    "style",
    "ins",
    ".footer",
    ".copyright",
    '[class*="gg_"]',
    '[class*="gg "]',
]

_TITLE_SUFFIXES = [
    "-笔趣阁小说网",
    "- 笔趣阁小说网",
    "笔趣阁小说网",
    "最新章节",
    "全文阅读",
    "txt下载",
]


class IbiqugeAdapter(BaseAdapter):
    """Adapter for 笔趣阁小说网 at ``www.ibiquge.com``.

    Site structure:

    * Book page:   ``/{book_id}/``.
      Chapter list inside ``<div class=\"book_list\">`` with ``<a>`` links.
    * Chapter page: ``/{book_id}/{chapter_id}.html``.
    * Multi-page:   ``/{book_id}/{chapter_id}_2.html``, ``_3.html``, …
    * Encoding: UTF-8.
    """

    domain = "www.ibiquge.com"

    _INDEX_RE = re.compile(r"^/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/(\d+)/(\d+)\.html?$")
    _MULTI_PAGE_RE = re.compile(r"^(.+)_(\d+)\.html?$")

    # ------------------------------------------------------------------
    # Abstract method implementations
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract novel title from the book page."""
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text:
                return self._clean_title(text)

        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title = og_title["content"].strip()
            if title:
                return self._clean_title(title)

        title_tag = soup.find("title")
        if title_tag:
            title_text = title_tag.get_text(strip=True)
            for sep in ("-", "|", "_", "——", "—"):
                if sep in title_text:
                    title_text = title_text.split(sep)[0].strip()
            return self._clean_title(title_text)

        raise ValueError(f"Could not extract novel title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Parse chapter list from ``<div class=\"book_list\">``.

        ibiquge has multiple ``book_list`` divs — the first shows recent
        updates, the last (often ``book_list book_list2``) has the full
        chapter catalog.  We pick the one with the most ``<a>`` links.
        """
        candidates = soup.find_all("div", class_="book_list")
        if not candidates:
            candidates = soup.find_all("div", id="list")
        if not candidates:
            raise ValueError(
                f"Could not find chapter list container on {base_url}."
            )

        # Pick the div with the most <a> links (full catalog)
        list_div = max(candidates, key=lambda d: len(d.find_all("a")))

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        for link in list_div.find_all("a"):
            href = link.get("href")
            if not href or href.startswith("#") or href.startswith("javascript"):
                continue

            full_url = urljoin(base_url, href)
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            title = link.get_text(strip=True)
            if not title:
                continue

            order += 1
            chapters.append(ChapterEntry(title=title, url=full_url, order=order))

        if not chapters:
            raise ValueError(f"No chapter links found on {base_url}")

        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract raw chapter body text.

        ibiquge puts content inside ``<div id=\"content\">`` or
        ``<div class=\"box single\">``, with inline navigation text
        that needs to be stripped.
        """
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Locate the content container — ibiquge uses div#content
        content_div = soup.find("div", id="content")
        if content_div is None:
            content_div = soup.find("div", class_="box single")
        if content_div is None:
            content_div = soup.find(
                "div", class_=re.compile(r"content|showtxt|booktxt", re.I)
            )
        if content_div is None:
            # Fallback: largest text block in the page
            best = None
            best_len = 0
            for div in soup.find_all("div"):
                t = div.get_text(strip=True)
                if len(t) > best_len:
                    best_len = len(t)
                    best = div
            content_div = best

        if content_div is None:
            raise ValueError(
                f"Could not find chapter content container on {base_url}."
            )

        # Remove navigation / utility text
        for tag in content_div.find_all(["h1", "h2", "h3"]):
            tag.decompose()

        # Convert <br> to newlines so paragraph structure survives get_text().
        for br in content_div.find_all("br"):
            br.replace_with("\n")

        # Remove inline nav text patterns
        _NAV_KEYWORDS = re.compile(
            r"^(字体|大中小|换手|关灯|上一章|下一章|目录|存书签|第\(\d+/\d+\)页|非法请求(-\d+)?)$"
        )
        for span in content_div.find_all(["span", "a"]):
            text = span.get_text(strip=True)
            if _NAV_KEYWORDS.match(text):
                span.decompose()

        # Extract paragraphs
        paragraphs: list[str] = []
        for p in content_div.find_all("p"):
            text = p.get_text(strip=True)
            if text and len(text) > 2 and not _NAV_KEYWORDS.match(text):
                paragraphs.append(text)

        if not paragraphs:
            text = content_div.get_text("\n")
            for line in text.splitlines():
                line = line.strip()
                if line and len(line) > 2 and not _NAV_KEYWORDS.match(line):
                    paragraphs.append(line)

        # Additional cleanup: strip page markers and junk lines
        _PAGE_MARKER_START = re.compile(r"^第\(\d+/\d+\)页\s*")
        _PAGE_MARKER_END = re.compile(r"\s*第\(\d+/\d+\)页\s*$")
        _JUNK_LINE = re.compile(r"^(非法请求(-\d+)?|请记住.*|https?://.*)$")
        cleaned: list[str] = []
        for p in paragraphs:
            p = _PAGE_MARKER_START.sub("", p)
            p = _PAGE_MARKER_END.sub("", p)
            p = p.strip()
            if p and not _JUNK_LINE.match(p) and not p.startswith("非法请求"):
                cleaned.append(p)

        return "\n\n".join(cleaned)

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        """Extract the "下一章" link when it points to a multi-page continuation.

        ibiquge uses "下一章" for both intra-chapter page turns and
        inter-chapter navigation.  We only return the URL when it matches
        the ``_N.html`` multi-page pattern (e.g. ``/167/178285_2.html``),
        meaning it is a continuation page of the *same* chapter.
        """
        for link in soup.find_all("a"):
            text = link.get_text(strip=True)
            if text in ("下一章", "下一页"):
                href = link.get("href")
                if href and href != "#":
                    full = urljoin(base_url, href)
                    # Only treat as "next page" if it matches the multi-page pattern
                    if self._MULTI_PAGE_RE.search(full):
                        return full
        return None

    def predict_page_urls(self, first_url: str, page2_url: str) -> list[str]:
        """Predict remaining page URLs for ibiquge ``_N.html`` suffix pattern.

        Pattern: ``/book_id/chap_id.html`` → ``/book_id/chap_id_2.html`` → ``_3.html`` …

        Capped at a conservative max to avoid hammering the server with
        requests for non-existent pages (most chapters have 2–3 pages).
        """
        _MAX_PREDICTED_PAGES = 0  # only fetch page 2, don't blindly predict

        m = self._MULTI_PAGE_RE.search(page2_url)
        if m is None:
            return []

        base = m.group(1)  # e.g. /167/178285
        start_num = int(m.group(2)) + 1  # e.g. 3
        if start_num <= 2:
            return []

        end_num = start_num + _MAX_PREDICTED_PAGES
        return [f"{base}_{n}.html" for n in range(start_num, end_num)]

    def discover_chapter_list_urls(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[str]:
        """Discover additional chapter-list pages (pagination).

        ibiquge paginates long chapter lists: ``index_2.html``, ``index_3.html``, …
        **Note**: ``index_1.html`` is an alias for the main page (same content),
        so we skip it and start from page 2.
        """
        urls: list[str] = []
        seen: set[str] = {urlparse(base_url).path.rstrip("/")}

        for link in soup.find_all("a", href=True):
            href = link.get("href", "").strip()
            text = link.get_text(strip=True)
            if not text.isdigit():
                continue
            page_num = int(text)
            if page_num < 2:   # skip "1" — same as main page
                continue
            if not re.search(r"index_\d+\.html?", href):
                continue
            full = urljoin(base_url, href)
            path = urlparse(full).path.rstrip("/")
            if path not in seen:
                seen.add(path)
                urls.append(full)

        if urls:
            logger.info("Chapter list pagination: %d extra pages for %s",
                        len(urls), base_url)
        return urls

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract books from listing/ranking pages."""
        books: list[dict] = []
        seen_urls: set[str] = set()

        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            test = href if href.startswith("/") else f"/{href}"
            if not self._INDEX_RE.match(test):
                continue

            title = link.get_text(strip=True)
            if not title or len(title) < 2:
                continue

            full_url = urljoin(base_url, href)
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)
            books.append({"title": title, "url": full_url})

        return books

    def is_index_url(self, url: str) -> bool:
        """Check if *url* is a book page (chapter list), not a chapter page."""
        parsed = urlparse(url)
        path = parsed.path.rstrip("/")

        if self._CHAPTER_RE.search(path) or self._MULTI_PAGE_RE.search(path):
            return False
        if self._INDEX_RE.search(path):
            return True

        parts = [p for p in path.split("/") if p]
        if parts and parts[-1].isdigit():
            return True
        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean_title(title: str) -> str:
        """Strip site suffixes and bracketed annotations from a title."""
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
