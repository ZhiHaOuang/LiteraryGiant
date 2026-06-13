#!/usr/bin/env python
"""Discover new books from all sites, targeting deep pages for fresh content."""
import json, sys
from pathlib import Path
from shared.constants import INDEXES_ROOT
from fetcher.adapters import ADAPTER_REGISTRY
from fetcher.registry import BookRegistry
from fetcher.utils import build_session, fetch_with_retry, random_user_agent
from bs4 import BeautifulSoup

registry = BookRegistry()
session = build_session()
wanted = int(sys.argv[1]) if len(sys.argv) > 1 else 20

# Per-site discovery config: (base_url, start_page, max_pages)
DISCOVERY_PLAN = [
    ("www.ibiquge.com",    "https://www.ibiquge.com/",              1,  50),
    ("www.qushucheng.com", "https://www.qushucheng.com/rank/",      1,  20),
    ("www.qushucheng.com", "https://www.qushucheng.com/",           1,  20),
    ("www.trxs.cc",        "https://www.trxs.cc/",                  1,  30),
    ("www.trxs.cc",        "https://www.trxs.cc/tongren/",          1,  20),
    ("ixdzs.tw",           "https://ixdzs.tw/",                     3,  30),
    ("ixdzs.tw",           "https://ixdzs.tw/sort/1/",              3,  20),
    ("www.kanunu8.com",    "https://www.kanunu8.com/files/sf/",     1,   5),
    ("www.dingdian365.com", "https://www.dingdian365.com/",          3,  20),
]

jobs = []
seen = set()

for domain, base_url, start, max_pages in DISCOVERY_PLAN:
    cls = ADAPTER_REGISTRY.get(domain)
    if not cls:
        continue
    inst = cls()

    for page in range(start, max_pages + 1):
        if len(jobs) >= wanted:
            break
        url = inst.paginate_discovery_url(base_url, page)
        if url is None:
            break
        try:
            session.headers.update({"User-Agent": random_user_agent()})
            resp = fetch_with_retry(session, url, timeout=12)
            soup = BeautifulSoup(resp.text, "html.parser")
            books = inst.extract_book_list(soup, resp.url)
            added = 0
            for b in books:
                if b["url"] in seen:
                    continue
                seen.add(b["url"])
                if registry.lookup_by_url(b["url"]) is not None:
                    continue
                if registry.is_failed(b["url"]):
                    continue
                jobs.append({"url": b["url"], "title": b.get("title", ""), "site": domain})
                added += 1
                if len(jobs) >= wanted:
                    break
            if added == 0 and len(books) == 0:
                break  # empty page, source exhausted
        except Exception as e:
            print(f"  ⚠ {domain} page {page}: {str(e)[:60]}", file=sys.stderr)
            continue

# Output JSON to stdout
print(json.dumps(jobs[:wanted], ensure_ascii=False))
