"""Adapter registry — maps domain strings to adapter classes."""

from __future__ import annotations

from urllib.parse import urlparse

from .base import BaseAdapter, ChapterEntry, DiscoverySource
from .baishuwu import BaishuwuAdapter
from .daishuzw import DaishuzwAdapter
from .deqixs import DeqixsCoAdapter, DeqixsOrgAdapter
from .dingdian365 import Dingdian365Adapter
from .ibiquge import IbiqugeAdapter
from .ixdzs import IxdzsAdapter
from .kanunu8 import Kanunu8Adapter
from .parto import PartoAdapter
from .qushucheng import QushuchengAdapter
from .sudugu import SuduguAdapter
from .trxs import TrxsAdapter
from .wuyou import WuyouShuchengAdapter
from .xxsy import XxsyAdapter

#: Mapping from hostname (as it appears in the URL) to adapter class.
ADAPTER_REGISTRY: dict[str, type[BaseAdapter]] = {
    # ── Working adapters ──────────────────────────────────────────
    "www.dingdian365.com": Dingdian365Adapter,
    "www.ibiquge.com": IbiqugeAdapter,
    "ixdzs.tw": IxdzsAdapter,
    "ixdzs8.com": IxdzsAdapter,  # mirror, same structure
    "www.kanunu8.com": Kanunu8Adapter,
    "www.qushucheng.com": QushuchengAdapter,
    "www.sudugu.org": SuduguAdapter,
    "www.trxs.cc": TrxsAdapter,
    "www.51shucheng.net": WuyouShuchengAdapter,

    # ── Limited / blocked adapters ─────────────────────────────────
    "www.baishuwu.com": BaishuwuAdapter,          # public pages work
    "www.daishuzw.com": DaishuzwAdapter,          # Cloudflare challenge
    "www.deqixs.co": DeqixsCoAdapter,             # discover only; chapter body empty
    "www.deqixs.org": DeqixsOrgAdapter,            # readable mirror
    "m.parto.cn": PartoAdapter,                    # dead site
    "www.xxsy.net": XxsyAdapter,                   # timeout
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
    "DiscoverySource",
    "ADAPTER_REGISTRY",
    "get_adapter_for_url",
    "BaishuwuAdapter",
    "DaishuzwAdapter",
    "DeqixsCoAdapter",
    "DeqixsOrgAdapter",
    "Dingdian365Adapter",
    "IbiqugeAdapter",
    "IxdzsAdapter",
    "Kanunu8Adapter",
    "PartoAdapter",
    "QushuchengAdapter",
    "SuduguAdapter",
    "TrxsAdapter",
    "WuyouShuchengAdapter",
    "XxsyAdapter",
]
