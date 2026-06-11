"""Adapter for 百书屋 (www.baishuwu.com)."""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource
from .ordering import sort_chapters_by_title_number

logger = logging.getLogger(__name__)

_NOISE_SELECTORS = [
    "script",
    "style",
    "ins",
    "iframe",
    ".footer",
    ".pc-footer",
    ".row-section",
]


class BaishuwuAdapter(BaseAdapter):
    """Adapter for public book/chapter pages on ``www.baishuwu.com``."""

    domain = "www.baishuwu.com"

    _INDEX_RE = re.compile(r"^/info/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/read/\d+/(\d+)/(\d+)(?:_\d+)?\.html?$")
    _PAGE_RE = re.compile(r"^(.*/read/\d+/\d+/\d+)(?:_(\d+))?\.html?$")

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("homepage_featured", "https://www.baishuwu.com/", "homepage", 55),
            DiscoverySource("xuanhuan_category", "https://www.baishuwu.com/list/1/1.html", "category", 40),
            DiscoverySource("kehuan_category", "https://www.baishuwu.com/list/6/1.html", "category", 35),
        ]

    def get_request_headers(self, url: str) -> dict[str, str]:
        if self._CHAPTER_RE.search(urlparse(url).path):
            parts = [p for p in urlparse(url).path.split("/") if p]
            if len(parts) >= 3:
                return {"Referer": f"https://{self.domain}/info/{parts[2]}/"}
        return {}

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text and text != "百书屋":
                return self._clean_title(text)

        title_tag = soup.find("title")
        if title_tag:
            text = title_tag.get_text(strip=True)
            for sep in ("最新章节", "_", "-", "|"):
                if sep in text:
                    text = text.split(sep)[0].strip()
            return self._clean_title(text)

        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self,
        soup: BeautifulSoup,
        base_url: str,
    ) -> list[ChapterEntry]:
        candidates = soup.select("ul.section-list")
        if not candidates:
            candidates = soup.find_all(["div", "ul", "section"])

        best_container = None
        best_count = 0
        for container in candidates:
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
            if not title or title in {"开始阅读", "章节目录"}:
                continue

            full_url = urljoin(base_url, link["href"])
            if not self._CHAPTER_RE.search(urlparse(full_url).path):
                continue
            if full_url in seen:
                continue
            seen.add(full_url)
            chapters.append(ChapterEntry(title=title, url=full_url, order=len(chapters) + 1))

        if not chapters:
            raise ValueError(f"No chapter links found on {base_url}")

        chapters = sort_chapters_by_title_number(chapters)
        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        for selector in _NOISE_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        content = soup.find("div", class_="word_read")
        if content is None:
            content = soup.find("div", id="content")
        if content is None:
            raise ValueError(f"Could not find content on {base_url}")

        for tag in content.find_all(["script", "style", "h1", "h2", "h3"]):
            tag.decompose()
        for link in content.find_all("a"):
            link.decompose()
        for br in content.find_all("br"):
            br.replace_with("\n")

        paragraphs: list[str] = []
        for line in content.get_text("\n").splitlines():
            line = line.strip()
            if not line or len(line) <= 2:
                continue
            if line in {"上一章", "下一章", "章节目录", "保存书签"}:
                continue
            if re.search(r"第\d+页|（第\d+页）", line):
                continue
            paragraphs.append(line)

        if not paragraphs:
            raise ValueError(f"Empty content after cleaning for {base_url}")
        return "\n\n".join(paragraphs)

    def extract_next_page_url(
        self,
        soup: BeautifulSoup,
        base_url: str,
    ) -> str | None:
        current_base = self._page_base(base_url)
        if current_base is None:
            return None

        for link in soup.find_all("a", href=True):
            if link.get_text(strip=True) != "下一章":
                continue
            full = urljoin(base_url, link["href"])
            if self._page_base(full) == current_base:
                return full
        return None

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
        return bool(self._INDEX_RE.search(urlparse(url).path))

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()

    def _page_base(self, url: str) -> str | None:
        match = self._PAGE_RE.search(urlparse(url).path)
        return match.group(1) if match else None
