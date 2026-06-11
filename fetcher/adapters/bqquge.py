"""Adapter for 笔趣阁 (www.bqquge.com).

DOM-structure extraction only — no text-level cleaning.
All ad-line filtering and text normalisation is the responsibility of
:mod:`Jormungandr.hardmodel`.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# HTML elements to remove before text extraction
# ---------------------------------------------------------------------------

_AD_SELECTORS: list[str] = [
    "script",
    "style",
    "ins",
    ".footer",
    ".prenext",
    ".copyright",
    '[class*="gg_"]',
    '[class*="gg "]',
]

#: Suffixes to strip from ``<title>``-based title extraction.
_TITLE_SUFFIXES = [
    "-笔趣阁",
    "- 笔趣阁",
    "笔趣阁",
    "最新章节",
    "全文阅读",
    "txt下载",
]


class BqqugeAdapter(BaseAdapter):
    """Adapter for the 笔趣阁 novel site at ``www.bqquge.com``.

    Site structure (as of 2025–2026):

    * Book page:   ``/{book_id}`` (e.g. ``/444``).
      Chapter list inside ``<div id="list" class="dir clear">``
      with ``<li><a>`` entries.
    * Chapter page: ``/{book_id}/{chapter_id}`` (e.g. ``/444/3675221``).
      Content inside ``<div class="con">``, paragraphs in ``<p>`` tags.
    * Encoding: UTF-8.
    """

    domain = "www.bqquge.com"

    _INDEX_RE = re.compile(r"^/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/(\d+)/(\d+)/?$")

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("ranking", "https://www.bqquge.com/paihang", "ranking", 80),
        ]

    # ------------------------------------------------------------------
    # Abstract method implementations
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract novel title from the book page.

        Tries, in order: ``<h1>``, ``<meta property="og:title">``, ``<title>``.
        """
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
        """Parse chapter list from ``<div id=\"list\">``.

        Handles both ``<li><a>`` (main format) and ``<dd><a>`` (fallback).
        """
        list_div = soup.find("div", id="list")
        if list_div is None:
            list_div = soup.find("div", class_=re.compile(r"list", re.I))
        if list_div is None:
            raise ValueError(
                f"Could not find chapter list container on {base_url}."
            )

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        link_items = list_div.find_all("li")
        if not link_items:
            link_items = list_div.find_all("dd")  # type: ignore[assignment]

        for item in link_items:
            link = item.find("a")
            if link is None:
                continue
            href = link.get("href")
            if not href or href.startswith("#"):
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
        """Extract raw chapter body text from the DOM.

        Removes HTML-level noise (scripts, styles, nav, ad divs) then
        returns plain text.  **No text-level cleaning** is performed —
        that is the responsibility of :mod:`Jormungandr.hardmodel`.
        """
        # Remove structural noise elements in-place
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Locate the content container
        content_div = soup.find("div", class_="con")
        if content_div is None:
            content_div = soup.find("div", id="content")
        if content_div is None:
            content_div = soup.find(
                "div", class_=re.compile(r"content|showtxt", re.I)
            )
        if content_div is None:
            raise ValueError(
                f"Could not find chapter content container on {base_url}."
            )

        # Remove duplicate headings from content
        for heading in content_div.find_all(["h1", "h2", "h3"]):
            heading.decompose()

        # Convert <br> to newlines so paragraph structure survives get_text().
        for br in content_div.find_all("br"):
            br.replace_with("\n")

        # Extract text from <p> tags (natural paragraph separation)
        paragraphs: list[str] = []
        for p in content_div.find_all("p"):
            text = p.get_text(strip=True)
            if text:
                paragraphs.append(text)

        if not paragraphs:
            text = content_div.get_text("\n")
            paragraphs = [l.strip() for l in text.splitlines() if l.strip()]

        # Join with double newlines; Jormungandr hardmodel will normalise further.
        return "\n\n".join(paragraphs)

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract a list of books from a listing page.

        Supports bqquge's 排行榜, 分类 pages, and search results.
        Each entry is ``{title, url}``.
        """
        books: list[dict] = []
        seen_urls: set[str] = set()

        # bqquge listing pages use <li> items with book links.
        # The layout is: <li><a href="/22">从水猴子开始成神</a> ...</li>
        # We look for <a> links whose href looks like a book ID (/\d+).
        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue

            # Book URLs are /\d+ (not /\d+/\d+ which are chapters)
            # Normalise: ensure leading slash for regex match
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

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        """Extract the "下一页" link from a multi-page chapter.

        On bqquge, the pagination lives in ``<div class=\"prenext\">``.
        Subsequent pages follow the pattern ``/{book_id}/{chap_id}-2``,
        ``/{book_id}/{chap_id}-3``, etc.
        """
        prenext = soup.find("div", class_="prenext")
        if prenext is None:
            return None

        # Find the <a> whose visible text is "下一页"
        for link in prenext.find_all("a"):
            if link.get_text(strip=True) == "下一页":
                href = link.get("href")
                if href:
                    return urljoin(base_url, href)
        return None

    def predict_page_urls(self, first_url: str, page2_url: str) -> list[str]:
        """Predict remaining page URLs for the bqquge ``-N`` suffix pattern.

        On bqquge, multi-page chapters follow the pattern::

            /{book_id}/{chap_id}      (page 1)
            /{book_id}/{chap_id}-2    (page 2)
            /{book_id}/{chap_id}-3    (page 3)
            ...

        Pages are predicted up to ``MAX_CHAPTER_PAGES`` (20).  URLs that don't
        exist will 404 — the engine handles that gracefully.
        """
        MAX_CHAPTER_PAGES = 20
        if not (page2_url.endswith("-2") and not first_url.endswith("-2")):
            return []

        base = page2_url[:-2]
        return [f"{base}-{n}" for n in range(3, MAX_CHAPTER_PAGES + 1)]

    def is_index_url(self, url: str) -> bool:
        """Check if *url* is a book page (chapter list), not a chapter page."""
        parsed = urlparse(url)
        path = parsed.path.rstrip("/")

        if self._CHAPTER_RE.search(path):
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
