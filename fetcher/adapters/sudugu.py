"""Adapter for 速读谷 (www.sudugu.org).

Same template as 笔趣阁 (ibiquge).  Reuses ``IbiqugeAdapter`` with
only the domain changed and a different clean-title suffix set.
"""

from __future__ import annotations

import logging
import re

from .base import DiscoverySource
from .ibiquge import IbiqugeAdapter

logger = logging.getLogger(__name__)

_TITLE_SUFFIXES = [
    "-速读谷",
    "- 速读谷",
    "速读谷",
    "最新章节",
    "全文阅读",
    "txt下载",
]


class SuduguAdapter(IbiqugeAdapter):
    """Adapter for 速读谷 at ``www.sudugu.org``.

    Same DOM structure as ibiquge:

    * Book page:   ``/{book_id}/`` → ``div.book_list`` contains chapters.
    * Chapter page: ``/{book_id}/{chapter_id}.html``.
    * Multi-page:   ``/{book_id}/{chapter_id}_2.html``, ``_3.html``, …
    * Encoding: UTF-8.
    """

    domain = "www.sudugu.org"

    def discovery_sources(self) -> list[DiscoverySource]:
        return [
            DiscoverySource("homepage_hot", "https://www.sudugu.org/", "homepage", 80),
            DiscoverySource("xuanhuan_category", "https://www.sudugu.org/xuanhuan/", "category", 70),
            DiscoverySource("kehuan_category", "https://www.sudugu.org/kehuan/", "category", 70),
        ]

    def get_cookies(self) -> dict[str, str]:
        """Bypass Google consent interstitial."""
        return {"CONSENT": "YES+cb"}

    # -- Title cleaning uses different suffixes --------------------------------

    @staticmethod
    def _clean_title(title: str) -> str:
        title = re.sub(r"[（(][^)）]*[)）]$", "", title).strip()
        for suffix in _TITLE_SUFFIXES:
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
        if title.startswith("《") and title.endswith("》"):
            title = title[1:-1]
        return title.strip()
