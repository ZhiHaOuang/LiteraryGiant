"""Adapter for 无忧书城 (www.51shucheng.net).

This site is useful for short-story collections.  A collection page lists many
single-page stories, while each story page stores the body in ``div#neirong``.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urldefrag, urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry, DiscoverySource

logger = logging.getLogger(__name__)

_NOISE_SELECTORS: list[str] = [
    "script",
    "style",
    "ins",
    "iframe",
    "form",
    ".comments-wrapper",
    ".post-navigation",
    ".sidebar",
    ".footer",
]

_TITLE_SUFFIXES = [
    "_无忧书城",
    "- 无忧书城",
    "免费在线阅读",
    "在线阅读",
]


class WuyouShuchengAdapter(BaseAdapter):
    """Adapter for story pages and collections on ``www.51shucheng.net``."""

    domain = "www.51shucheng.net"
    supports_story_collections = True

    _STORY_RE = re.compile(r"^/[^/]+/[^/]+/\d+\.html?$")

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource(
                "liu_cixin_short_stories",
                "https://www.51shucheng.net/kehuan/liucixinduanpian/",
                "story_collection",
                90,
            ),
        ]

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text(strip=True)
            for sep in ("_", "-", "|", "—", "——"):
                if sep in title:
                    title = title.split(sep)[0].strip()
                    break
            return self._clean_title(title)

        heading = soup.find(["h1", "h2"])
        if heading:
            title = heading.get_text(strip=True)
            if title:
                return self._clean_title(title)

        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Treat collection pages as ordered story lists.

        Only expands on listing pages (e.g. ``/kehuan/liucixinduanpian/``).
        On single-story pages (``…/18513.html``) raises because the sidebar
        "recommended reading" links are NOT chapters of the same work.
        """
        # Don't expand on individual story pages — sidebar links are not chapters
        if self._STORY_RE.match(urlparse(base_url).path):
            raise ValueError("Single story page — use extract_content, not chapter list")

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()

        for link in soup.find_all("a", href=True):
            href = link["href"].strip()
            full_url, _fragment = urldefrag(urljoin(base_url, href))
            path = urlparse(full_url).path
            if not self._STORY_RE.match(path):
                continue

            title = link.get_text(strip=True)
            if not title or title in {"开始阅读", "开始阅读 ›"}:
                continue
            if full_url in seen_urls:
                continue

            seen_urls.add(full_url)
            chapters.append(
                ChapterEntry(title=title, url=full_url, order=len(chapters) + 1)
            )

        if not chapters:
            raise ValueError(f"No story links found on {base_url}")

        logger.info("Found %d stories for %s", len(chapters), base_url)
        return chapters

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        return [
            {"title": entry.title, "url": entry.url}
            for entry in self.extract_chapter_list(soup, base_url)
        ]

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        for selector in _NOISE_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        content = soup.find("div", id="neirong")
        if content is None:
            content = soup.find("div", class_="neirong")
        if content is None:
            content = soup.find("div", class_="reading-container")
        if content is None:
            content = self._largest_text_block(soup)
        if content is None:
            raise ValueError(f"Could not find story content on {base_url}")

        paragraphs: list[str] = []
        for p in content.find_all("p"):
            text = p.get_text("\n").strip()
            if text:
                for line in text.splitlines():
                    line = line.strip()
                    if line:
                        paragraphs.append(line)

        if not paragraphs:
            text = content.get_text("\n", strip=True)
            for line in text.splitlines():
                line = line.strip()
                if line:
                    paragraphs.append(line)

        # If the result is still one blob, split on Chinese sentence endings
        if len(paragraphs) <= 1 and paragraphs:
            import re
            blob = paragraphs[0] if paragraphs else ""
            chunks = re.split(r"(?<=[。！？])\s*", blob)
            paragraphs = [c.strip() for c in chunks if c.strip()]

        return "\n\n".join(paragraphs)

    def is_index_url(self, url: str) -> bool:
        path = urlparse(url).path.rstrip("/")
        return not self._STORY_RE.match(path)

    @staticmethod
    def _largest_text_block(soup: BeautifulSoup):
        best = None
        best_len = 0
        for tag in soup.find_all(["article", "main", "section", "div"]):
            text = tag.get_text("", strip=True)
            if len(text) > best_len:
                best = tag
                best_len = len(text)
        return best if best_len >= 500 else None

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            title = title.replace(suffix, "").strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
