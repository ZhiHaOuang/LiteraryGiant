"""Web novel fetcher — crawl novels from supported sites.

Chapters are staged to ``runs/fetch/<run_id>/`` and promoted to
``Yggdrasil/sources/raw_text/<book_id>/`` after validation.  All text
cleaning is deferred to :mod:`Jormungandr.hardmodel`.

Public API::

    from fetcher import FetcherEngine, BookRegistry, get_adapter_for_url

    adapter_cls = get_adapter_for_url("https://www.bqquge.com/444")
    engine = FetcherEngine(adapter_cls(), max_chapters=10)
    canonical_path = engine.fetch_novel("https://www.bqquge.com/444")
"""

from __future__ import annotations

from .adapters import (
    ADAPTER_REGISTRY,
    BaseAdapter,
    BqqugeAdapter,
    ChapterEntry,
    get_adapter_for_url,
)
from .engine import FetcherEngine
from .registry import BookRegistry

__version__ = "0.1.0"

__all__ = [
    "ADAPTER_REGISTRY",
    "BaseAdapter",
    "BookRegistry",
    "BqqugeAdapter",
    "ChapterEntry",
    "FetcherEngine",
    "get_adapter_for_url",
]
