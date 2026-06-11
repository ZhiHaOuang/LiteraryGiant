"""Adapter for 我的书城网 (www.qushucheng.com).

Book page:   ``/book_XXXXXXXX/``
Chapter:     ``/book_XXXXXXXX/<chapter_id>.html``
Chapter list: ``<ul class="section-list fix">``
Content:     ``<div id="content">``
Encoding:    UTF-8.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource
from .ordering import sort_chapters_by_title_number

logger = logging.getLogger(__name__)

_AD_SELECTORS: list[str] = [
    "script", "style", "ins",
    ".footer", ".copyright",
    '[class*="gg_"]', '[class*="gg "]',
]

_TITLE_SUFFIXES = [
    "最新章节免费阅读_我的书城网",
    "全文免费阅读_我的书城网",
    "免费阅读_我的书城网",
    "_我的书城网",
]


class QushuchengAdapter(BaseAdapter):
    """Adapter for 我的书城网 at ``www.qushucheng.com``."""

    domain = "www.qushucheng.com"

    _BOOK_RE = re.compile(r"^/book_(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/book_(\d+)/(\d+)\.html?$")

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("homepage_featured", "https://www.qushucheng.com/", "homepage", 75),
            DiscoverySource("rank_total", "https://www.qushucheng.com/rank/", "ranking", 85),
        ]

    # Qushucheng requires Referer on chapter pages, otherwise 403.

    def get_request_headers(self, url: str) -> dict[str, str]:
        """Add Referer header to avoid 403 on chapter pages."""
        headers = {
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
        }
        m = self._CHAPTER_RE.search(url)
        if m:
            # Derive index URL from chapter URL
            index_url = f"https://{self.domain}/book_{m.group(1)}/"
            headers["Referer"] = index_url
        else:
            headers["Referer"] = f"https://{self.domain}/"
        return headers

    # ------------------------------------------------------------------
    # Abstract methods
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract title from <title> tag (site puts h1 as site name)."""
        title_tag = soup.find("title")
        if title_tag:
            text = title_tag.get_text(strip=True)
            # Format: "书名(作者)_章节_我的书城网"
            for sep in ("_", "-", "|"):
                if sep in text:
                    text = text.split(sep)[0].strip()
            return self._clean_title(text)

        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text and text != "我的书城网":
                return self._clean_title(text)

        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Parse chapter list from ``<ul class="section-list fix">``."""
        best_container = None
        best_count = 0
        for container in soup.find_all(["ul", "div"]):
            chapter_links = []
            for link in container.find_all("a", href=True):
                full = urljoin(base_url, link["href"])
                if self._CHAPTER_RE.search(urlparse(full).path):
                    chapter_links.append(link)
            if len(chapter_links) > best_count:
                best_count = len(chapter_links)
                best_container = container

        if best_container is None:
            raise ValueError(f"Could not find chapter list on {base_url}")

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        for link in best_container.find_all("a"):
            href = link.get("href")
            if not href or href.startswith("#") or href.startswith("javascript"):
                continue

            title = link.get_text(strip=True)
            if not title or title in ("开始阅读",):
                continue
            full_url = urljoin(base_url, href)
            if not self._CHAPTER_RE.search(urlparse(full_url).path):
                continue
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            order += 1
            chapters.append(ChapterEntry(title=title, url=full_url, order=order))

        if not chapters:
            raise ValueError(f"No chapter links found on {base_url}")

        chapters = sort_chapters_by_title_number(chapters)
        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract chapter body from ``div#content``."""
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        content_div = soup.find("div", id="content")
        if content_div is None:
            content_div = soup.find("div", class_="content")
        if content_div is None:
            # Fallback: largest text block
            best, best_len = None, 0
            for div in soup.find_all("div"):
                t = div.get_text(strip=True)
                if len(t) > best_len:
                    best_len, best = len(t), div
            content_div = best

        if content_div is None:
            raise ValueError(f"Could not find content on {base_url}")

        # Remove nav/header elements
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

        # Chinese sentence split fallback
        if len(paragraphs) <= 1 and paragraphs:
            blob = paragraphs[0] if paragraphs else ""
            chunks = re.split(r"(?<=[。！？])\s*", blob)
            paragraphs = [c.strip() for c in chunks if c.strip()]

        return "\n\n".join(paragraphs)

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        """Extract next-page link if present."""
        for link in soup.find_all("a"):
            text = link.get_text(strip=True)
            if text in ("下一页", "下一頁"):
                href = link.get("href")
                if href and href != "#":
                    return urljoin(base_url, href)
        return None

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract books from listing pages."""
        books: list[dict] = []
        seen: set[str] = set()
        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href or not self._BOOK_RE.match(href):
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

    def postprocess_content(self, content: str) -> str:
        """Normalise and strip anti-copy garbage text."""
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        # Remove anti-copy junk: lines that are mostly non-Chinese
        import re as _re
        cleaned: list[str] = []
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            # Count Chinese chars vs total meaningful chars
            chinese = len(_re.findall(r"[一-鿿]", line))
            # If line has <30% Chinese and >10 chars, it's likely anti-copy garbage
            if len(line) > 10 and chinese < len(line) * 0.3:
                continue
            cleaned.append(line)
        return "\n".join(cleaned)

    def is_index_url(self, url: str) -> bool:
        path = urlparse(url).path.rstrip("/")
        if self._CHAPTER_RE.search(path):
            return False
        if self._BOOK_RE.search(path):
            return True
        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            title = title.replace(suffix, "").strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
