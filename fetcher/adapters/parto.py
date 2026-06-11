"""Adapter for m.parto.cn.

Status: **STUB** — site returns only 39 bytes. Likely dead or requires
mobile-specific headers / JavaScript.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .base import BaseAdapter, ChapterEntry

logger = logging.getLogger(__name__)


class PartoAdapter(BaseAdapter):
    """STUB — m.parto.cn (dead/minimal response)."""
    domain = "m.parto.cn"

    def extract_title(self, soup, base_url):
        raise NotImplementedError("Dead site")

    def extract_chapter_list(self, soup, base_url):
        raise NotImplementedError("Dead site")

    def extract_content(self, soup, base_url):
        raise NotImplementedError("Dead site")

    def is_index_url(self, url):
        return False

    def extract_book_list(self, soup, base_url):
        return []
