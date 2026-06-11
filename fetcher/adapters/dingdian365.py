"""Adapter for 顶点小说 (www.dingdian365.com).

Book page:   ``/newbook/<id>/``
Chapter:     ``/chapter/<id>/<chapter_id>.html``
Content:     Largest ``<div>`` (class ``yanse1``), nav text stripped.
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

_NAV_KEYWORDS = re.compile(
    r"(关灯|字体|大中小|字号|换手|上一章|下一章|目录|存书签|书签"
    r"|第\(\d+/\d+\)页|非法请求|一秒记住|最快更新|章节报错"
    r"|顶(点|点)小说|dingdian|请选择|验证码|错误类型|缺少章节|更新太慢)"
)
# Garbage lines to skip entirely
_GARBAGE_PATTERNS = re.compile(
    r"(^[大小中]$"                              # standalone size labels
    r"|^(关灯|字体|字号|换手|上一章|下一章|目录|存书签)$"
    r"|一秒记住|最快更新|章节报错"
    r"|顶(点|点)小说"
    r"|dingdian"
    r"|请选择错误类型|缺少章节|更新太慢|验证码"
    r"|www\.|https?://"
    r"|^\d{2}-\d{2}$"                           # date-like: 07-20
    r"|^[《].+[》]$"                              # other book titles in 《》
    r")"
)


class Dingdian365Adapter(BaseAdapter):
    """Adapter for 顶点小说 at ``www.dingdian365.com``."""

    domain = "www.dingdian365.com"

    _INDEX_RE = re.compile(r"^/newbook/(\d+)/?$")
    _CHAPTER_RE = re.compile(r"^/chapter/(\d+)/(\d+)\.html?$")

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("homepage_ranked", "https://www.dingdian365.com/", "homepage", 75),
        ]

    # ------------------------------------------------------------------
    # Abstract methods
    # ------------------------------------------------------------------

    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        h1 = soup.find("h1")
        if h1:
            text = h1.get_text(strip=True)
            if text and len(text) > 1:
                return self._clean_title(text)
        title_tag = soup.find("title")
        if title_tag:
            text = title_tag.get_text(strip=True)
            for sep in ("-", "|", "_", "——", "—"):
                if sep in text:
                    text = text.split(sep)[0].strip()
            return self._clean_title(text)
        raise ValueError(f"Could not extract title from {base_url}")

    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        # Find the ul/div with most chapter links (links containing /chapter/)
        best_container = None
        best_count = 0
        for container in soup.find_all(["ul", "div"]):
            ch_links = [
                a for a in container.find_all("a", href=True)
                if "/chapter/" in a.get("href", "")
            ]
            if len(ch_links) > best_count:
                best_count = len(ch_links)
                best_container = container

        if best_container is None:
            raise ValueError(f"No chapter list found on {base_url}")

        chapters: list[ChapterEntry] = []
        seen_urls: set[str] = set()
        order = 0

        for link in best_container.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            # Only accept chapter URLs, not /book/ links
            if not self._CHAPTER_RE.search(href):
                full = urljoin(base_url, href)
                if not self._CHAPTER_RE.search(urlparse(full).path):
                    continue
            title = link.get_text(strip=True)
            if not title or title in ("开始阅读",):
                continue
            full = urljoin(base_url, href)
            if full in seen_urls:
                continue
            seen_urls.add(full)
            order += 1
            chapters.append(ChapterEntry(title=title, url=full, order=order))

        if not chapters:
            raise ValueError(f"No chapter links on {base_url}")
        chapters = sort_chapters_by_title_number(chapters)
        logger.info("Found %d chapters for %s", len(chapters), base_url)
        return chapters

    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        for selector in _AD_SELECTORS:
            for element in soup.select(selector):
                element.decompose()

        # Body text is in div#txt nested inside div#neirong
        content_div = soup.find("div", id="txt")
        if content_div is None:
            content_div = soup.find("div", id="neirong")
        if content_div is None:
            raise ValueError(f"No content div on {base_url}")

        # Remove script/style/form
        for tag in content_div.find_all(["script", "style", "form", "select", "input", "button"]):
            tag.decompose()

        # Convert <br> to newlines (use insert_before to avoid destroying sibling text)
        for br in content_div.find_all("br"):
            br.insert_before("\n")

        raw = content_div.get_text("\n")
        paragraphs: list[str] = []
        content_started = False

        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue

            # Stop at nav/error/recommendation sections
            if re.search(r"(猜你喜欢|推荐|热门小说|相关推荐|请选择错误类型|验证码|一秒记住|dingdian)", line):
                continue

            # Skip standalone nav words
            if _GARBAGE_PATTERNS.search(line):
                continue

            chinese = len(re.findall(r"[一-鿿]", line))
            # Skip page markers like "第1497章...(第1/2页)"
            if re.search(r"第\d+章.*第\d+/\d+页", line):
                continue
            # Skip "（本章未完，请点击下一页继续阅读）"
            if "本章未完" in line or "点击下一页" in line:
                continue

            # Content lines — even short ones like "法界。" are valid
            if chinese >= 1 or len(line) > 20:
                content_started = True

            if content_started:
                paragraphs.append(line)

        if not paragraphs:
            raise ValueError(f"Empty content after cleaning for {base_url}")

        return "\n\n".join(paragraphs)

    def extract_next_page_url(
        self, soup: BeautifulSoup, base_url: str
    ) -> str | None:
        for link in soup.find_all("a"):
            text = link.get_text(strip=True)
            if text in ("下一页", "下一頁"):
                href = link.get("href")
                if href and href != "#":
                    full = urljoin(base_url, href)
                    # Only return if it's actually a chapter page (not /book/ index)
                    if self._CHAPTER_RE.search(urlparse(full).path):
                        return full
        return None

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        books: list[dict] = []
        seen: set[str] = set()
        for link in soup.find_all("a"):
            href = link.get("href", "").strip()
            if not href:
                continue
            m = self._INDEX_RE.search(href)
            if not m:
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

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        suffixes = ["最新章节", "全文阅读", "顶点小说", "-顶点小说", "txt下载"]
        for s in suffixes:
            title = title.replace(s, "").strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
