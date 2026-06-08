"""Adapter for 同人小说 (www.trxs.cc).

Key differences from other adapters:
* **Encoding**: GB18030 (not UTF-8).
* Chapter URLs: ``/tongren/<book_id>/<n>.html`` (numeric page, no leading zeros).
* Content inside ``div.readDetail``.
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
    ".hotlist",
    ".footer",
    ".copyright",
    '[class*="gg_"]',
    '[class*="gg "]',
]

_TITLE_SUFFIXES = [
    "_同人小说",
    "_同人小说网",
    "-同人小说",
    "同人小说",
    "最新章节",
]


class TrxsAdapter(BaseAdapter):
    """Adapter for 同人小说 at ``www.trxs.cc``.

    Site structure:

    * Book page:   ``/tongren/{book_id}.html``.
      Chapter list inside ``<div id=\"list\">`` with ``<li><a>``.
    * Chapter page: ``/tongren/{book_id}/{n}.html`` (1-based).
    * Content: ``<div class=\"readDetail\">`` or ``<div class=\"read_chapterDetail\">``.
    * Encoding: **GB18030**.
    """

    domain = "www.trxs.cc"
    encoding = "gb18030"  # override the default UTF-8 auto-detection

    _INDEX_RE = re.compile(r"^/tongren/(\d+)\.html?$")
    _CHAPTER_RE = re.compile(r"^/tongren/(\d+)/(\d+)\.html?$")

    # ------------------------------------------------------------------
    # Abstract methods
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract novel title from the book page."""
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text:
                return self._clean_title(text)

        title_tag = soup.find("title")
        if title_tag:
            title_text = title_tag.get_text(strip=True)
            # Pattern: "人在木叶，战场收尸十年(骑驴三只脚)_同人小说网"
            # Strip the author part
            title_text = re.sub(r"\([^)]*\)", "", title_text)
            for sep in ("_", "-", "|", "——", "—"):
                if sep in title_text:
                    title_text = title_text.split(sep)[0].strip()
            return self._clean_title(title_text)

        raise ValueError(f"Could not extract novel title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Parse chapter list from ``<div class=\"book_list\">`` or ``<ul class=\"clearfix\">``."""
        list_div = soup.find("div", class_="book_list")
        if list_div is None:
            list_div = soup.find("ul", class_="clearfix")
        if list_div is None:
            list_div = soup.find("div", id="list")
        if list_div is None:
            raise ValueError(
                f"Could not find chapter list container on {base_url}."
            )

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        for item in list_div.find_all("li"):
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
        """Extract raw chapter body text.

        trxs puts metadata (title, author, summary) in the first few ``<p>``
        tags inside ``div.read_chapterDetail``, followed by the actual story
        paragraphs.  We skip the metadata preamble.
        """
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Locate content container
        content_div = soup.find("div", class_="read_chapterDetail")
        if content_div is None:
            content_div = soup.find("div", class_="readDetail")
        if content_div is None:
            content_div = soup.find("div", id="readContent_set")
        if content_div is None:
            raise ValueError(
                f"Could not find chapter content container on {base_url}."
            )

        # Convert <br> to newlines so paragraph structure survives get_text().
        for br in content_div.find_all("br"):
            br.replace_with("\n")

        # Remove nav / breadcrumb elements
        for tag in content_div.find_all(["h1", "h2", "h3", "em"]):
            tag.decompose()

        # Collect <p> text, skipping the metadata preamble
        # trxs structure: p[0]=title+author, p[1]=blank, p[2]=summary,
        # p[3]+ = story body.  We identify the preamble by common prefixes.
        _META_STARTS = ("作者：", "简介：", "首页>", "上一篇：", "下一篇：")
        paragraphs: list[str] = []
        in_body = False
        for p in content_div.find_all("p"):
            text = p.get_text(strip=True)
            if not text or len(text) <= 2:
                if in_body:
                    continue  # blank line inside body is fine, just skip
                continue
            if not in_body:
                # Still in preamble — check if this looks like metadata
                if text.startswith(_META_STARTS) or (
                    len(text) < 80 and "作者" in text and "简介" not in text
                ):
                    continue
                # First non-metadata paragraph → body starts here
                in_body = True
            paragraphs.append(text)

        if not paragraphs:
            text = content_div.get_text("\n")
            for line in text.splitlines():
                line = line.strip()
                if not line or len(line) <= 2:
                    continue
                if line.startswith(_META_STARTS):
                    continue
                paragraphs.append(line)

        return "\n\n".join(paragraphs)

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        """Return ``None`` because trxs "下一章" links are inter-chapter nav."""
        return None

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
            if not self._INDEX_RE.match(href):
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
        """Check if *url* is a book page (chapter list)."""
        parsed = urlparse(url)
        path = parsed.path.rstrip("/")

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
        """Strip site suffixes and annotations from a title."""
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
