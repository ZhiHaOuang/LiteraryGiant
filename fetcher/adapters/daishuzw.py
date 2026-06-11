"""Adapter for 袋鼠小说 (www.daishuzw.com).

Status: **STUB** — site returns Cloudflare challenge page ("Just a moment...").
Cannot bypass without JavaScript execution.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry

logger = logging.getLogger(__name__)


class DaishuzwAdapter(BaseAdapter):
    """STUB — www.daishuzw.com (Cloudflare challenge)."""
    domain = "www.daishuzw.com"

    _INDEX_RE = re.compile(r"^/daishu/(\d+)\.html?$")

    def extract_title(self, soup, base_url):
        raise NotImplementedError("Cloudflare challenge page")

    def extract_chapter_list(self, soup, base_url):
        raise NotImplementedError("Cloudflare challenge page")

    def extract_content(self, soup, base_url):
        raise NotImplementedError("Cloudflare challenge page")

    def is_index_url(self, url):
        return bool(self._INDEX_RE.search(urlparse(url).path))

    def extract_book_list(self, soup, base_url):
        return []
