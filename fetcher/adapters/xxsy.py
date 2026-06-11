"""Adapter for 潇湘书院 (www.xxsy.net).

Status: **STUB** — site times out consistently. May be geo-blocked or
require specific cookies/authentication.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry

logger = logging.getLogger(__name__)


class XxsyAdapter(BaseAdapter):
    """STUB — www.xxsy.net (timeout)."""
    domain = "www.xxsy.net"

    _INDEX_RE = re.compile(r"^/book/(\d+)/?$")

    def extract_title(self, soup, base_url):
        raise NotImplementedError("Site times out")

    def extract_chapter_list(self, soup, base_url):
        raise NotImplementedError("Site times out")

    def extract_content(self, soup, base_url):
        raise NotImplementedError("Site times out")

    def is_index_url(self, url):
        return bool(self._INDEX_RE.search(urlparse(url).path))

    def extract_book_list(self, soup, base_url):
        return []
