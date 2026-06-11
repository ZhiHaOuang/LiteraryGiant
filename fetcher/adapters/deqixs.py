"""Adapters for 得奇小说网 (www.deqixs.org / www.deqixs.co)."""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry
from .ordering import sort_chapters_by_title_number

logger = logging.getLogger(__name__)

_NOISE_SELECTORS = [
    "script",
    "style",
    "ins",
    ".footer",
    ".copyright",
    ".breadcrumb",
]


class _DeqixsBaseAdapter(BaseAdapter):
    _INDEX_RE: re.Pattern[str]
    _CHAPTER_RE: re.Pattern[str]

    def get_request_headers(self, url: str) -> dict[str, str]:
        if self._CHAPTER_RE.search(urlparse(url).path):
            parts = [p for p in urlparse(url).path.split("/") if p]
            if parts:
                return {"Referer": f"https://{self.domain}/{parts[0]}/"}
        return {}

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text:
                return self._clean_title(text)

        title_tag = soup.find("title")
        if title_tag:
            text = title_tag.get_text(strip=True)
            for sep in ("-", "_", "|", "—", "——"):
                if sep in text:
                    text = text.split(sep)[0].strip()
            return self._clean_title(text)

        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self,
        soup: BeautifulSoup,
        base_url: str,
    ) -> list[ChapterEntry]:
        best_container = None
        best_count = 0
        for container in soup.find_all(["div", "ul", "section"]):
            links = [
                a for a in container.find_all("a", href=True)
                if self._CHAPTER_RE.search(urlparse(urljoin(base_url, a["href"])).path)
            ]
            if len(links) > best_count:
                best_count = len(links)
                best_container = container

        if best_container is None:
            raise ValueError(f"Could not find chapter list on {base_url}")

        chapters: list[ChapterEntry] = []
        seen: set[str] = set()
        for link in best_container.find_all("a", href=True):
            title = link.get_text(strip=True)
            if not title or title in {"开始阅读", "全文目录", "查看全部章节 ↓"}:
                continue
            full = urljoin(base_url, link["href"])
            if not self._CHAPTER_RE.search(urlparse(full).path):
                continue
            if full in seen:
                continue
            seen.add(full)
            chapters.append(ChapterEntry(title=title, url=full, order=len(chapters) + 1))

        if not chapters:
            raise ValueError(f"No chapter links found on {base_url}")

        chapters = sort_chapters_by_title_number(chapters)
        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_book_list(self, soup: BeautifulSoup, base_url: str) -> list[dict]:
        books: list[dict] = []
        seen: set[str] = set()
        for link in soup.find_all("a", href=True):
            full = urljoin(base_url, link["href"])
            if not self._INDEX_RE.search(urlparse(full).path):
                continue
            title = link.get_text(strip=True)
            if not title or len(title) < 2:
                continue
            if full in seen:
                continue
            seen.add(full)
            books.append({"title": title, "url": full})
        return books

    def is_index_url(self, url: str) -> bool:
        path = urlparse(url).path.rstrip("/")
        if self._CHAPTER_RE.search(path):
            return False
        return bool(self._INDEX_RE.search(path))

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in ("最新章节", "无错字手打最新章节", "无错精校版"):
            title = title.replace(suffix, "").strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()


class DeqixsOrgAdapter(_DeqixsBaseAdapter):
    """Adapter for the readable ``www.deqixs.org`` mirror."""

    domain = "www.deqixs.org"

    _INDEX_RE = re.compile(r"^/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/(\d+)/(\d+)\.html?$")

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        for selector in _NOISE_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        content = soup.find("div", class_="con")
        if content is None:
            content = soup.find("div", id="content")
        if content is None:
            raise ValueError(f"Could not find content on {base_url}")

        for tag in content.find_all(["h1", "h2", "h3", "a"]):
            tag.decompose()
        for br in content.find_all("br"):
            br.replace_with("\n")

        paragraphs: list[str] = []
        for line in content.get_text("\n").splitlines():
            line = line.strip()
            if line and len(line) > 2:
                paragraphs.append(line)

        if not paragraphs:
            raise ValueError(f"Empty content after cleaning for {base_url}")
        return "\n\n".join(paragraphs)


class DeqixsCoAdapter(_DeqixsBaseAdapter):
    """Discover/directory adapter for ``www.deqixs.co``.

    Chapter pages currently expose an empty ``#chapter-content`` container in
    this environment, so full fetching is intentionally blocked.
    """

    domain = "www.deqixs.co"

    _INDEX_RE = re.compile(r"^/books/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/books/(\d+)/(\d+)\.html?$")

    def get_request_headers(self, url: str) -> dict[str, str]:
        if self._CHAPTER_RE.search(urlparse(url).path):
            parts = [p for p in urlparse(url).path.split("/") if p]
            if len(parts) >= 2:
                return {"Referer": f"https://{self.domain}/books/{parts[1]}/"}
        return {}

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        content = soup.find("div", id="chapter-content")
        text = content.get_text("\n", strip=True) if content else ""
        if not text:
            raise NotImplementedError(
                "deqixs.co chapter content is empty in static HTML; "
                "likely loaded by JS/API or gated by reading mode"
            )
        return text
