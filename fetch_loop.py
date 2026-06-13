#!/usr/bin/env python
"""
Continuous fetcher — pipeline mode.  No rounds, no batch limits.
Books flow through: discover → submit → complete → replace.
Fast sites spin faster; slow sites chug along independently.
"""
import json, random, shutil, signal, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeout
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────
MAX_CONCURRENT_BOOKS = 12       # max books fetching at once
MAX_PER_SITE = 3                # max concurrent books from one site
MAX_BOOK_TIMEOUT = 7200         # 2 hours per book
CHECK_INTERVAL = 1200           # 20 minutes between health reports
COOLDOWN_BASE = 60              # 1 minute base cooldown
COOLDOWN_MAX = 7200             # 2 hours max cooldown
MAX_CONSECUTIVE_FAILURES = 5    # failures before max cooldown
INTERNAL_CONCURRENCY = 3        # chapters per book
MIN_DELAY = 0.3                 # seconds between requests

# ── State ──────────────────────────────────────────────────────────
from shared.constants import INDEXES_ROOT, RAWDATA_NOVELS_ROOT
STATE_FILE = Path(__file__).parent / "fetch_state.json"

@dataclass
class AdapterState:
    domain: str
    status: str = "active"
    cooldown_until: float = 0.0
    consecutive_errors: int = 0
    total_fetched: int = 0
    total_failed: int = 0
    last_error: str = ""

@dataclass
class BookJob:
    url: str
    site: str
    started_at: float = 0.0
    title: str = ""

adapter_states: dict[str, AdapterState] = {}
_discovery_pos: dict[str, dict] = {}  # domain -> {src_idx, page, seen_urls}
shutdown = False
total_ok = 0
total_fail = 0

def save_state():
    data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "adapters": {
            d: {"status": s.status, "cooldown_until": s.cooldown_until,
                "consecutive_errors": s.consecutive_errors,
                "total_fetched": s.total_fetched, "total_failed": s.total_failed,
                "last_error": s.last_error}
            for d, s in adapter_states.items()
        }
    }
    STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))

def load_state():
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text())
            for domain, info in data.get("adapters", {}).items():
                adapter_states[domain] = AdapterState(
                    domain=domain, status=info["status"],
                    cooldown_until=info.get("cooldown_until", 0),
                    consecutive_errors=info.get("consecutive_errors", 0),
                    total_fetched=info.get("total_fetched", 0),
                    total_failed=info.get("total_failed", 0),
                    last_error=info.get("last_error", ""),
                )
            print(f"Loaded state: {len(adapter_states)} adapters")
        except Exception:
            pass

def signal_handler(sig, frame):
    global shutdown
    print("\nShutdown requested, draining...")
    shutdown = True
signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ── Imports ────────────────────────────────────────────────────────
from fetcher.adapters import ADAPTER_REGISTRY, get_adapter_for_url
from fetcher.registry import BookRegistry
from fetcher.utils import build_session, fetch_with_retry, decode_response, random_user_agent
from bs4 import BeautifulSoup

registry = BookRegistry()
session = build_session()
load_state()

def _adapter_state(domain: str) -> AdapterState:
    if domain not in adapter_states:
        adapter_states[domain] = AdapterState(domain=domain)
    return adapter_states[domain]

def _now() -> float:
    return time.monotonic()

# ── Discovery (incremental, picks up where left off) ───────────────
def discover_some(wanted: int = 3) -> list[BookJob]:
    """Discover a batch of new books, round-robin across available sites."""
    jobs = []
    domains = sorted(ADAPTER_REGISTRY.keys())
    random.shuffle(domains)

    for domain in domains:
        if len(jobs) >= wanted:
            break
        st = _adapter_state(domain)
        if st.status == "cooldown" and _now() < st.cooldown_until:
            continue
        if st.status == "cooldown" and _now() >= st.cooldown_until:
            st.status = "active"
            st.consecutive_errors = 0
            print(f"  [{domain}] Cooldown ended, resuming")

        cls = ADAPTER_REGISTRY[domain]
        inst = cls()
        if not hasattr(inst, 'discovery_sources'):
            continue
        try:
            sources = inst.discovery_sources()
        except Exception:
            continue
        if not sources:
            continue

        pos = _discovery_pos.setdefault(domain, {"src": 0, "page": 1, "seen": []})
        for offset in range(len(sources)):
            si = (pos["src"] + offset) % len(sources)
            src = sources[si]
            page_start = pos["page"] if si == pos["src"] else 1
            for p in range(page_start, 100):
                if len(jobs) >= wanted:
                    break
                url = inst.paginate_discovery_url(src.url, p)
                if url is None:
                    break
                try:
                    session.headers.update({"User-Agent": random_user_agent()})
                    resp = fetch_with_retry(session, url, timeout=15)
                    if getattr(inst, "encoding", None):
                        text = resp.content.decode(inst.encoding, errors="replace")
                    else:
                        text = decode_response(resp)
                    text = inst.preprocess_html(text, resp.url)
                    soup = BeautifulSoup(text, "html.parser")
                    found = inst.extract_book_list(soup, resp.url)
                    for b in found:
                        if b["url"] in pos["seen"]:
                            continue
                        pos["seen"].append(b["url"])
                        if registry.lookup_by_url(b["url"]) is not None:
                            continue
                        if registry.is_failed(b["url"]):
                            continue
                        jobs.append(BookJob(url=b["url"], site=domain, title=b.get("title", "")))
                        if len(jobs) >= wanted:
                            break
                    pos["src"] = si
                    pos["page"] = p + 1
                    if len(found) == 0 or len(jobs) >= wanted:
                        break
                except Exception:
                    break  # source failed, move to next
        # Prevent unbounded growth
        if len(pos["seen"]) > 5000:
            pos["seen"] = pos["seen"][-2000:]
    return jobs

# ── Fetch ──────────────────────────────────────────────────────────
def fetch_book(job: BookJob) -> dict:
    t0 = _now()
    st = _adapter_state(job.site)
    try:
        from fetcher.engine import FetcherEngine
        engine = FetcherEngine(
            get_adapter_for_url(job.url)(),
            concurrency=INTERNAL_CONCURRENCY, min_delay=MIN_DELAY,
        )
        path = engine.fetch_novel(job.url)
        idx = json.loads((path / "index.json").read_text("utf-8"))
        stats = idx.get("content_stats", {})
        elapsed = _now() - t0

        st.consecutive_errors = 0
        st.total_fetched += 1
        return {
            "site": job.site, "url": job.url,
            "title": idx.get("title", "?")[:40],
            "discovered": stats.get("discovered_parts", 0) or idx.get("total_discovered", 0),
            "fetched": idx.get("total_fetched", 0),
            "failed": idx.get("total_failed", 0),
            "chars": stats.get("total_chars", 0),
            "elapsed": round(elapsed, 1),
        }
    except Exception as e:
        elapsed = _now() - t0
        msg = str(e)[:200]
        rate_limited = any(code in msg for code in ["403", "429", "503", "ProxyError"])
        if rate_limited:
            st.consecutive_errors += 1
            backoff = min(COOLDOWN_BASE * (2 ** (st.consecutive_errors - 1)), COOLDOWN_MAX)
            st.status = "cooldown"
            st.cooldown_until = _now() + backoff
            st.last_error = msg[:100]
            print(f"  ⚠ [{job.site}] Rate-limited ({st.consecutive_errors}x), pausing {backoff:.0f}s")
            save_state()
        else:
            st.consecutive_errors += 1
            st.last_error = msg[:100]
            if st.consecutive_errors >= MAX_CONSECUTIVE_FAILURES:
                st.status = "cooldown"
                st.cooldown_until = _now() + COOLDOWN_MAX
                print(f"  ⚠ [{job.site}] {MAX_CONSECUTIVE_FAILURES}+ failures, cooling {COOLDOWN_MAX//60}min")
                save_state()
        st.total_failed += 1
        return {"site": job.site, "url": job.url, "title": "FAILED",
                "error": msg[:120], "elapsed": round(elapsed, 1)}

# ── Health report ──────────────────────────────────────────────────
def health_report(pool_size: int):
    print(f"\n{'='*60}")
    print(f"  HEALTH  |  {datetime.now(timezone.utc).strftime('%H:%M:%S UTC')}  |  {total_ok} ok / {total_fail} fail total")
    print(f"{'='*60}")
    for domain in sorted(adapter_states):
        s = adapter_states[domain]
        icon = {"active": "✓", "cooldown": "⏳"}.get(s.status, "?")
        extra = ""
        if s.status == "cooldown":
            rem = int(s.cooldown_until - _now())
            extra = f" ({rem//60}m{rem%60:02d}s remaining)" if rem > 0 else " (resuming...)"
        print(f"  {icon} {domain:30s} {s.total_fetched:>5d} ok  {s.total_failed:>4d} fail  [{s.status}]{extra}")
    print(f"\n  Pool: {pool_size}/{MAX_CONCURRENT_BOOKS} active")
    sys.stdout.flush()

# ── Pipeline main ──────────────────────────────────────────────────
def main():
    global total_ok, total_fail
    print("Pipeline fetcher started.")
    print(f"  Max concurrent books: {MAX_CONCURRENT_BOOKS} (max {MAX_PER_SITE}/site)")
    print(f"  Book timeout: {MAX_BOOK_TIMEOUT}s | Cooldown: {COOLDOWN_BASE}s→{COOLDOWN_MAX}s")
    print(f"  State file: {STATE_FILE}")

    pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_BOOKS)
    running: dict = {}          # Future -> (BookJob, float started_at)
    site_count: dict[str, int] = defaultdict(int)  # domain -> current running count

    def _can_submit(site: str) -> bool:
        st = _adapter_state(site)
        if st.status == "cooldown" and _now() < st.cooldown_until:
            return False
        return site_count[site] < MAX_PER_SITE

    def _submit_one(job: BookJob):
        fut = pool.submit(fetch_book, job)
        job.started_at = _now()
        running[fut] = job
        site_count[job.site] += 1

    # Pre-fill the pipeline
    initial = discover_some(MAX_CONCURRENT_BOOKS)
    for job in initial:
        if _can_submit(job.site):
            _submit_one(job)

    last_health = _now()
    count = 0

    while not shutdown:
        if not running:
            # All done, discover more
            more = discover_some(MAX_CONCURRENT_BOOKS)
            if not more:
                print("  No books available. Waiting 60s...")
                time.sleep(60)
                continue
            for job in more:
                if _can_submit(job.site):
                    _submit_one(job)

        # Wait for next completion
        for fut in as_completed(running):
            job = running.pop(fut)
            site_count[job.site] -= 1
            count += 1

            try:
                r = fut.result(timeout=0)  # already done
            except Exception as e:
                r = {"site": job.site, "title": "CRASHED", "error": str(e)[:100]}

            ok = "error" not in r
            if ok:
                total_ok += 1
            else:
                total_fail += 1
            status = "✓" if ok else "✗"
            ch = f"{r.get('fetched',0)}/{r.get('discovered','?')}"
            elapsed = f"{r.get('elapsed',0):.0f}s" if r.get('elapsed',0) < 3600 else f"{r.get('elapsed',0)/60:.1f}m"
            err = f"  ! {r.get('error','')[:80]}" if not ok else ""
            print(f"  [{count:4d}] {status} {r['site']:20s} "
                  f"{r.get('title','?')[:30]:30s} {ch:>10s} "
                  f"{r.get('chars',0):>10,d} chars {elapsed:>8s}{err}")
            sys.stdout.flush()

            # Replace with new book
            new_jobs = discover_some(1)
            for new_job in new_jobs:
                if _can_submit(new_job.site):
                    _submit_one(new_job)
                    break
            else:
                # No replacement found — try refilling later
                pass

            # Health check
            if _now() - last_health > CHECK_INTERVAL:
                health_report(len(running))
                last_health = _now()
                save_state()

    print("\nDraining remaining books...")
    pool.shutdown(wait=False)
    print("Fetcher stopped.")

if __name__ == "__main__":
    main()
