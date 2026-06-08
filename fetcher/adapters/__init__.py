"""Adapter registry — maps domain strings to adapter classes."""

from __future__ import annotations

from urllib.parse import urlparse

from .base import BaseAdapter, ChapterEntry
from .bqquge import BqqugeAdapter
from .ibiquge import IbiqugeAdapter
from .kanunu8 import Kanunu8Adapter
from .trxs import TrxsAdapter
from .wuyou import WuyouShuchengAdapter

#: Mapping from hostname (as it appears in the URL) to adapter class.
ADAPTER_REGISTRY: dict[str, type[BaseAdapter]] = {
    "www.bqquge.com": BqqugeAdapter,
    "www.ibiquge.com": IbiqugeAdapter,
    "www.kanunu8.com": Kanunu8Adapter,
    "www.trxs.cc": TrxsAdapter,
    "www.51shucheng.net": WuyouShuchengAdapter,
}


def get_adapter_for_url(url: str) -> type[BaseAdapter]:
    """Extract the domain from *url* and return the matching adapter class.

    Args:
        url: A novel index or chapter URL.

    Returns:
        The ``BaseAdapter`` subclass registered for this domain.

    Raises:
        ValueError: If no adapter is registered for the URL's domain.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname or ""

    # Direct lookup
    adapter = ADAPTER_REGISTRY.get(hostname)
    if adapter is not None:
        return adapter

    # Try stripping leading "www."
    if hostname.startswith("www."):
        adapter = ADAPTER_REGISTRY.get(hostname[4:])
        if adapter is not None:
            return adapter
    else:
        adapter = ADAPTER_REGISTRY.get(f"www.{hostname}")
        if adapter is not None:
            return adapter

    raise ValueError(
        f"No adapter registered for domain '{hostname}'. "
        f"Supported domains: {list(ADAPTER_REGISTRY)}"
    )


__all__ = [
    "BaseAdapter",
    "ChapterEntry",
    "ADAPTER_REGISTRY",
    "get_adapter_for_url",
    "BqqugeAdapter",
    "IbiqugeAdapter",
    "Kanunu8Adapter",
    "TrxsAdapter",
    "WuyouShuchengAdapter",
]
