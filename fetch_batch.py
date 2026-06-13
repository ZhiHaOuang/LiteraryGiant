#!/usr/bin/env python
"""Fetch a batch of books from stdin JSON list."""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from fetcher.engine import FetcherEngine
from fetcher.adapters import get_adapter_for_url

books = json.loads(sys.stdin.read())
if not books:
    print("No books to fetch")
    sys.exit(0)

print(f"Fetching {len(books)} books...", flush=True)
t0 = time.monotonic()
results = []

def fetch_one(b):
    t1 = time.monotonic()
    try:
        engine = FetcherEngine(get_adapter_for_url(b["url"])(), concurrency=3, min_delay=0.3)
        path = engine.fetch_novel(b["url"])
        idx = json.loads((path / "index.json").read_text("utf-8"))
        stats = idx.get("content_stats", {})
        return {
            "site": b["site"], "url": b["url"], "title": idx.get("title", "?")[:40],
            "fetched": idx.get("total_fetched", 0),
            "discovered": stats.get("discovered_parts", 0) or idx.get("total_discovered", 0),
            "chars": stats.get("total_chars", 0), "elapsed": round(time.monotonic()-t1, 1),
        }
    except Exception as e:
        return {"site": b["site"], "url": b["url"], "title": b.get("title","FAILED")[:40],
                "error": str(e)[:120], "elapsed": round(time.monotonic()-t1, 1)}

with ThreadPoolExecutor(max_workers=8) as pool:
    futs = {pool.submit(fetch_one, b): b for b in books}
    for fut in as_completed(futs):
        r = fut.result()
        results.append(r)
        s = "✓" if "error" not in r else "✗"
        ch = f'{r.get("fetched",0)}/{r.get("discovered","?")}'
        elapsed = f'{r.get("elapsed",0):.0f}s' if r.get("elapsed",0) < 3600 else f'{r.get("elapsed",0)/60:.1f}m'
        err = f'  ! {r.get("error","")[:80]}' if "error" in r else ""
        print(f'  {s} {r["site"]:20s} {r.get("title","?")[:35]:35s} {ch:>10s} {r.get("chars",0):>10,d} chars {elapsed:>8s}{err}', flush=True)

ok = sum(1 for r in results if "error" not in r)
fail = sum(1 for r in results if "error" in r)
total_chars = sum(r.get("chars",0) for r in results if "error" not in r)
elapsed = time.monotonic() - t0
print(f"\nBatch done: {ok} ok / {fail} fail | {total_chars:,d} chars | {elapsed:.0f}s", flush=True)
