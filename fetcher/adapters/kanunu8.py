"""Adapter for 努努书坊 (www.kanunu8.com).

Classic Chinese literature and web-novel archive with static HTML pages.
* **Encoding**: GB18030.
* **Book pages**: ``/book5/<slug>/``, ``/101/<slug>/``, etc.
* **Chapters**: ``<div class=\"mulu-list\"> <ul> <li><a href=\"NNNNN.htm\">``
* **Content**: ``<div class=\"content\">``
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource

logger = logging.getLogger(__name__)

_AD_SELECTORS: list[str] = [
    "script",
    "style",
    "ins",
    ".footer",
    ".comment",
    ".copyright",
    '[class*="gg_"]',
    '[class*="gg "]',
]

_TITLE_SUFFIXES = [
    "- 努努书坊",
    "-努努书坊",
    "努努书坊",
    "最新章节",
    "全文阅读",
]


class Kanunu8Adapter(BaseAdapter):
    """Adapter for 努努书坊 at ``www.kanunu8.com``.

    Site structure:

    * Book page: ``/<section>/<slug>/`` (e.g. ``/book5/wt781/``).
      Chapter list inside ``<div class=\"mulu-list\"> <ul> <li><a>``.
    * Chapter: ``<number>.htm`` / ``<number>.html`` (relative to book dir).
    * Content: ``<div class=\"content\">``.
    * Encoding: **GB18030**.
    """

    domain = "www.kanunu8.com"
    encoding = "gb18030"

    _INDEX_RE = re.compile(
        r"^/(book\d+|10[0-9]|files|zt|author)/([^/]+)/(?:index\.html?)?$"
    )
    _CHAPTER_RE = re.compile(
        r"^/(book\d+|10[0-9]|files|zt|author)/([^/]+)/(\d+\w*)\.html?$"
    )
    _CATEGORY_RE = re.compile(r"^/files/([a-z]{2,10}|\d+\.html?)$")
    # Category pages under /files/ have short slugs (e.g. "sf", "dushi", "world").
    # Real books under /files/ have longer identifiers (e.g. "2025/somebook").
    _CATEGORY_SLUG = re.compile(r"^[a-z]{2,10}$")     # /files/sf/
    _CATEGORY_FILE = re.compile(r"^\d+\.html?$")       # /files/7.html

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("science_fiction", "https://www.kanunu8.com/files/sf/", "category", 90),
            DiscoverySource("world_literature", "https://www.kanunu8.com/files/world/", "category", 85),
            DiscoverySource("chinese_literature", "https://www.kanunu8.com/files/chinese/", "category", 80),
            DiscoverySource("overseas_chinese", "https://www.kanunu8.com/files/7.html", "category", 60),
        ]

    # ------------------------------------------------------------------
    # Abstract methods
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract novel title.  kanunu8 puts it in ``div.catalog > h1``."""
        catalog = soup.find("div", class_="catalog")
        if catalog:
            h1 = catalog.find("h1")
            if h1:
                text = h1.get_text(strip=True)
                if text:
                    return self._clean_title(text)

        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text:
                return self._clean_title(text)

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
        """Parse chapter list from ALL ``<div class=\"mulu-list\">`` blocks.

        Multi-volume books (common on kanunu8) have one ``mulu-list`` per
        volume.  We merge them all, skipping ``pchidden`` recommendation
        blocks.
        """
        list_divs = soup.find_all("div", class_="mulu-list")
        if not list_divs:
            list_divs = soup.find_all("div", class_="catalog")
        if not list_divs:
            best_container = None
            best_count = 0
            for container in soup.find_all(["table", "div", "ul"]):
                links = [
                    a for a in container.find_all("a", href=True)
                    if self._CHAPTER_RE.search(urlparse(urljoin(base_url, a["href"])).path)
                ]
                if len(links) > best_count:
                    best_count = len(links)
                    best_container = container
            if best_container is not None:
                list_divs = [best_container]
        if not list_divs:
            raise ValueError(
                f"Could not find mulu-list container on {base_url}."
            )

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0
        volume_count = 0
        base_path = urlparse(base_url).path
        book_prefix = (
            base_path.rsplit("/", 1)[0] + "/"
            if base_path.endswith((".html", ".htm"))
            else base_path.rstrip("/") + "/"
        )

        for list_div in list_divs:
            # Skip recommendation blocks
            if "pchidden" in list_div.get("class", []):
                continue
            volume_count += 1

            for link in list_div.find_all("a"):
                href = link.get("href")
                if not href or href.startswith("#") or href.startswith("javascript"):
                    continue

                full_url = urljoin(base_url, href)
                full_path = urlparse(full_url).path
                if not full_path.startswith(book_prefix):
                    continue
                if not self._CHAPTER_RE.search(full_path):
                    continue
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

        logger.info("Found %d chapters (%d volumes) for %s",
                     len(chapters), volume_count, base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract raw chapter body from ``div.content``."""
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        content_div = soup.find("div", class_="content")
        if content_div is None:
            content_div = soup.find("div", id="content")
        if content_div is None:
            content_div = soup.find("div", class_="article")
        if content_div is None:
            # Fallback: largest text block
            best, best_len = None, 0
            for div in soup.find_all("div"):
                t = div.get_text(strip=True)
                if len(t) > best_len:
                    best_len, best = len(t), div
            content_div = best

        if content_div is None:
            raise ValueError(f"Could not find content container on {base_url}.")

        # Convert <br> to newlines so paragraph structure survives get_text().
        for br in content_div.find_all("br"):
            br.replace_with("\n")

        # Remove nav / breadcrumb / author info
        for tag in content_div.find_all(["h1", "h2", "h3"]):
            tag.decompose()
        # Strip "所属书籍：XXX" / "正文 第X章" breadcrumb lines
        for em in content_div.find_all(["em", "strong", "b"]):
            text = em.get_text(strip=True)
            if "所属书籍" in text or "努努书坊" in text:
                em.decompose()

        paragraphs: list[str] = []
        for p in content_div.find_all("p"):
            # Use \n separator so <br>-based paragraphs stay separate
            text = p.get_text("\n").replace("\xa0", " ").strip()
            if not text:
                continue
            for line in text.splitlines():
                line = line.strip()
                if line and len(line) > 2:
                    paragraphs.append(line)

        if not paragraphs:
            text = content_div.get_text("\n").replace("\xa0", " ")
            for line in text.splitlines():
                line = line.strip()
                if line and len(line) > 2:
                    paragraphs.append(line)

        return "\n\n".join(paragraphs)

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        """Extract the "下一页" link within chapter content."""
        content = soup.find("div", class_="content")
        area = content if content else soup
        for link in area.find_all("a"):
            text = link.get_text(strip=True)
            if text in ("下一页", "下一頁"):
                href = link.get("href")
                if href and href != "#":
                    return urljoin(base_url, href)
        return None

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract books from listing/author pages.

        Filters out category-level pages (e.g. ``/files/sf/``) that don't
        contain actual books, keeping only concrete book/author entries.
        """
        books: list[dict] = []
        seen_urls: set[str] = set()

        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            full_url = urljoin(base_url, href)
            m = self._INDEX_RE.match(urlparse(full_url).path)
            if not m:
                continue
            section, slug = m.group(1), m.group(2)

            # /files/<short-slug>/ and /files/<N>.html are category indices, not books
            if section == "files" and (
                self._CATEGORY_SLUG.match(slug) or self._CATEGORY_FILE.match(slug)
            ):
                continue

            title = link.get_text(strip=True)
            if not title or len(title) < 2:
                continue
            for sep in ("：", ":"):
                if sep in title:
                    prefix, rest = title.split(sep, 1)
                    if 1 < len(prefix) <= 12 and rest.strip():
                        title = rest.strip()
                    break

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
        if self._CATEGORY_RE.search(path):
            return False
        if self._INDEX_RE.search(path):
            return True
        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean_title(title: str) -> str:
        """Strip site suffixes and annotations."""
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
