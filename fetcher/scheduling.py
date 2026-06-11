"""CLI entry point for the web novel fetcher.  Registered as ``fetcher-run``.

Site-agnostic engine; site-specific logic lives in adapters.
Usage::

    # Discover books (filters already-registered ones)
    fetcher-run --discover https://www.bqquge.com/xuanhuan

    # Fetch a book (adapter auto-detected from URL domain)
    fetcher-run https://www.bqquge.com/507

    # List supported adapters
    fetcher-run --list-adapters
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .adapters import ADAPTER_REGISTRY, get_adapter_for_url
from .engine import FetcherEngine
from .registry import BookRegistry, _canonicalize_url, normalize_title
from .utils import RateLimiter

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser for ``fetcher-run``."""
    parser = argparse.ArgumentParser(
        prog="fetcher-run",
        description=(
            "Site-agnostic web novel fetcher.  Adapters auto-detected from "
            "URL domain.  Chapters are staged in runs/fetch/<run_id>/ and "
            "promoted to Library/rawdata/novels or Library/rawdata/stories after validation."
        ),
    )
    parser.add_argument(
        "urls",
        nargs="*",
        metavar="URL",
        help="Novel index, chapter-list, or story URLs to scrape.  "
             "Required unless --discover or --list-adapters is used.",
    )
    parser.add_argument(
        "--adapter",
        help=(
            "Force a specific adapter by domain key "
            "(e.g. 'www.bqquge.com'). Auto-detected from the URL when omitted."
        ),
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.2,
        help="Minimum seconds between requests. Default: 0.2",
    )
    parser.add_argument(
        "--max-chapters",
        type=int,
        default=None,
        help="Stop after fetching N chapters for chaptered works.",
    )
    parser.add_argument(
        "--max-stories",
        type=int,
        default=None,
        help="When expanding a story collection, fetch at most N stories.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="How many chapters to fetch in parallel. Default: 3",
    )
    parser.add_argument(
        "--site-concurrency",
        type=int,
        default=0,
        help=(
            "How many input URLs/books to fetch concurrently. "
            "Default: auto (unique domains, capped at 4)."
        ),
    )
    parser.add_argument(
        "--content-type",
        choices=("auto", "book", "story"),
        default="auto",
        help=(
            "Classification override. Default: auto, based on fetched part "
            "counts and character counts."
        ),
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help=(
            "Run identifier for staging directory. "
            "Auto-generated when omitted (12 hex chars)."
        ),
    )
    parser.add_argument(
        "--discover",
        action="store_true",
        help=(
            "Treat URL(s) as listing pages and print discovered "
            "book/story URLs.  Known items are marked [known] "
            "and counted separately.  Use --show-known to include them."
        ),
    )
    parser.add_argument(
        "--show-known",
        action="store_true",
        help="When --discover is used, also list items already in the registry.",
    )
    parser.add_argument(
        "--discover-site",
        action="append",
        default=None,
        metavar="DOMAIN",
        help=(
            "When --discover is used without URLs, limit curated discovery to "
            "one adapter domain. May be repeated."
        ),
    )
    parser.add_argument(
        "--discover-limit",
        type=int,
        default=None,
        help="When --discover is used, print at most N new items per source.",
    )
    parser.add_argument(
        "--import",
        dest="import_file",
        default=None,
        metavar="FILE.txt",
        help="Import a whole-book .txt file into the canonical layout "
             "(Library/rawdata/novels/<book_slug>/source.txt + index.json). "
             "Use --title to set the book name.",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="Book title for --import (defaults to the filename stem).",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a summary of all registered books/stories and their on-disk state.",
    )
    parser.add_argument(
        "--list-adapters",
        action="store_true",
        help="List all registered site adapters and their domains.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the fetcher CLI.

    Returns 0 on success, 1 if any URL failed.
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # --list-adapters
    if args.list_adapters:
        return _cmd_list_adapters()

    # --import
    if args.import_file:
        return _cmd_import(args)

    # --summary
    if args.summary:
        return _cmd_summary(args)

    # --discover mode
    if args.discover:
        return _cmd_discover(args)

    if not args.urls:
        parser.error("URL(s) required (or use --discover / --import / --summary / --list-adapters)")
    if args.site_concurrency < 0:
        parser.error("--site-concurrency must be >= 0")

    # -- fetch mode
    input_urls = args.urls
    if args.content_type in {"auto", "story"}:
        input_urls = _expand_story_collection_urls(args, input_urls)

    run_id = args.run_id or uuid.uuid4().hex[:12]
    urls = _dedupe_urls(input_urls)
    site_concurrency = _resolve_site_concurrency(urls, args.site_concurrency)
    rate_limiters = {
        domain: RateLimiter(min_delay=args.delay)
        for domain in {_domain_key(url) for url in urls}
    }
    logger.info(
        "Run ID: %s  (urls=%d, site_concurrency=%d, per-domain delay=%.2fs)",
        run_id,
        len(urls),
        site_concurrency,
        args.delay,
    )

    written: list[Path] = []
    failed: list[tuple[str, str]] = []

    if site_concurrency == 1:
        for url in urls:
            try:
                output_path = _fetch_one_url(args, url, run_id, rate_limiters[_domain_key(url)])
                written.append(output_path)
                print(f"[OK]  {url}  →  {output_path}")
            except Exception as exc:
                logger.exception("Failed to fetch %s", url)
                failed.append((url, str(exc)))
                print(f"[FAIL]  {url}: {exc}", file=sys.stderr)
    else:
        with ThreadPoolExecutor(max_workers=site_concurrency) as pool:
            futures = {
                pool.submit(
                    _fetch_one_url,
                    args,
                    url,
                    run_id,
                    rate_limiters[_domain_key(url)],
                ): url
                for url in urls
            }
            for future in as_completed(futures):
                url = futures[future]
                try:
                    output_path = future.result()
                except Exception as exc:
                    logger.exception("Failed to fetch %s", url)
                    failed.append((url, str(exc)))
                    print(f"[FAIL]  {url}: {exc}", file=sys.stderr)
                    continue
                written.append(output_path)
                print(f"[OK]  {url}  →  {output_path}")

    print()
    print(
        f"Finished. {len(written)} item(s) promoted, {len(failed)} failed. "
        f"staging: runs/fetch/{run_id}/"
    )
    return 0 if not failed else 1


def _fetch_one_url(
    args,
    url: str,
    run_id: str,
    rate_limiter: RateLimiter,
) -> Path:
    """Fetch one URL with its domain-shared limiter."""
    adapter_cls = _resolve_adapter(args, url)
    adapter = adapter_cls()
    logger.info("Adapter: %s (%s) for %s", adapter_cls.__name__, adapter.domain, url)

    engine = FetcherEngine(
        adapter,
        min_delay=args.delay,
        max_chapters=args.max_chapters,
        run_id=run_id,
        concurrency=args.concurrency,
        content_type=args.content_type,
        rate_limiter=rate_limiter,
    )
    return engine.fetch_novel(url)


def _dedupe_urls(urls: list[str]) -> list[str]:
    """Preserve input order while avoiding duplicate staging collisions."""
    unique: list[str] = []
    seen: set[str] = set()
    for url in urls:
        key = _canonical_url_key(url)
        if key in seen:
            continue
        seen.add(key)
        unique.append(url)
    skipped = len(urls) - len(unique)
    if skipped:
        logger.warning("Skipping %d duplicate URL(s)", skipped)
    return unique


def _canonical_url_key(url: str) -> str:
    """Canonical key for de-duping equivalent book URLs."""
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme.lower()}://{_domain_key(url)}{path}"


def _domain_key(url: str) -> str:
    """Return the hostname key used for per-domain rate limiting."""
    hostname = (urlparse(url).hostname or "").lower()
    return hostname[4:] if hostname.startswith("www.") else hostname


def _resolve_site_concurrency(urls: list[str], requested: int) -> int:
    """Resolve URL-level concurrency; auto parallelizes across distinct domains."""
    if not urls:
        return 1
    if requested > 0:
        return max(1, min(requested, len(urls)))
    unique_domains = {_domain_key(url) for url in urls}
    return max(1, min(len(urls), len(unique_domains), 4))


def _expand_story_collection_urls(args, urls: list[str]) -> list[str]:
    """Expand supported story collection pages into individual story URLs."""
    from bs4 import BeautifulSoup
    from .utils import build_session, decode_response, fetch_with_retry, random_user_agent

    session = build_session()
    rate_limiters = {
        domain: RateLimiter(min_delay=args.delay)
        for domain in {_domain_key(url) for url in urls}
    }
    expanded: list[str] = []

    for url in urls:
        adapter_cls = _resolve_adapter(args, url)
        adapter = adapter_cls()
        if not getattr(adapter, "supports_story_collections", False):
            expanded.append(url)
            continue
        if not adapter.is_index_url(url):
            expanded.append(url)
            continue

        rate_limiters[_domain_key(url)].wait()
        for header in ("Referer", "Origin", "Upgrade-Insecure-Requests"):
            session.headers.pop(header, None)
        session.headers.update({"User-Agent": random_user_agent()})
        extra_headers = adapter.get_request_headers(url)
        if extra_headers:
            session.headers.update(extra_headers)
        extra_cookies = adapter.get_cookies()
        resp = fetch_with_retry(session, url, cookies=extra_cookies if extra_cookies else None)
        if getattr(adapter, "encoding", None):
            text = resp.content.decode(adapter.encoding, errors="replace")
        else:
            text = decode_response(resp)
        text = adapter.preprocess_html(text, resp.url)
        soup = BeautifulSoup(text, "html.parser")

        stories = adapter.extract_book_list(soup, resp.url)
        if not stories:
            logger.warning("No story URLs discovered from %s; keeping original URL", url)
            expanded.append(url)
            continue

        max_stories = getattr(args, "max_stories", None)
        limit = max_stories if max_stories is not None else len(stories)
        selected = stories[:limit]
        expanded.extend(story["url"] for story in selected)
        logger.info("Expanded %s into %d story URL(s)", url, len(selected))

    return expanded


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_adapter(args, url: str):
    """Resolve the adapter class from --adapter flag or URL auto-detection."""
    if args.adapter:
        adapter_cls = ADAPTER_REGISTRY.get(args.adapter)
        if adapter_cls is None:
            raise ValueError(
                f"Unknown adapter: {args.adapter}. "
                f"Available: {list(ADAPTER_REGISTRY)}"
            )
        return adapter_cls
    return get_adapter_for_url(url)


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _ResolvedDiscoverySource:
    domain: str
    label: str
    url: str
    kind: str
    priority: int


def _cmd_list_adapters() -> int:
    """Print registered adapters.  Book vs story is auto-detected at fetch time."""
    print("Supported site adapters (book/story auto-detected from content):\n")
    for domain, cls in sorted(ADAPTER_REGISTRY.items()):
        doc = (cls.__doc__ or "").strip().split("\n")[0]
        print(f"  {domain:30s}  {cls.__name__:20s}  {doc}")
    print(f"\nAuto-detection: URL domain → adapter class.")
    print(f"Override:         fetcher-run --adapter <domain> <url>")
    return 0


def _resolve_discovery_sources(args) -> list[_ResolvedDiscoverySource]:
    """Resolve curated or explicit discovery sources for ``--discover``."""
    if args.urls:
        sources: list[_ResolvedDiscoverySource] = []
        for url in args.urls:
            adapter_cls = _resolve_adapter(args, url)
            sources.append(
                _ResolvedDiscoverySource(
                    domain=adapter_cls.domain,
                    label="explicit",
                    url=url,
                    kind="listing",
                    priority=50,
                )
            )
        return sources

    selected_domains = set(args.discover_site or [])
    if args.adapter:
        selected_domains.add(args.adapter)

    sources: list[_ResolvedDiscoverySource] = []
    seen_urls: set[str] = set()
    for domain, adapter_cls in sorted(ADAPTER_REGISTRY.items()):
        if selected_domains and domain not in selected_domains and _domain_key(f"https://{domain}") not in selected_domains:
            continue
        adapter = adapter_cls()
        for source in adapter.discovery_sources():
            key = _canonicalize_url(source.url)
            if key in seen_urls:
                continue
            seen_urls.add(key)
            sources.append(
                _ResolvedDiscoverySource(
                    domain=domain,
                    label=f"{domain}:{source.label}",
                    url=source.url,
                    kind=source.kind,
                    priority=source.priority,
                )
            )

    sources.sort(key=lambda source: (-source.priority, source.domain, source.label))
    if selected_domains and not sources:
        available = ", ".join(sorted(ADAPTER_REGISTRY))
        raise ValueError(f"No discovery sources for {sorted(selected_domains)}. Available: {available}")
    return sources


def _source_content_type(args, adapter, source: _ResolvedDiscoverySource) -> str:
    if args.content_type in {"book", "story"}:
        return args.content_type
    if source.kind == "story_collection" or getattr(adapter, "supports_story_collections", False):
        return "story"
    return "book"


def _clean_discovered_title(title: str) -> str:
    """Clean noisy listing-card text before dedupe/output."""
    import re

    title = re.sub(r"\s+", " ", title or "").strip()
    title = re.sub(r"^\d+\s*[.、]\s*", "", title)
    title = re.split(r"\d+个评分[:：]|作者[:：]|[0-9.]+\s*MB\s*\d{4}-\d{2}-\d{2}", title)[0]
    title = re.sub(r"[（(](?:全本|完本|连载中|已完结)[)）]\s*$", "", title).strip()
    return title[:120].strip()


def _cmd_discover(args) -> int:
    """Discover books from listing pages, filtering out registered ones."""
    from bs4 import BeautifulSoup
    from .utils import build_session, decode_response, fetch_with_retry, random_user_agent

    sources = _resolve_discovery_sources(args)
    if not sources:
        print("No discovery sources configured for the selected adapter(s).", file=sys.stderr)
        return 1

    registry = BookRegistry()
    session = build_session()
    rate_limiters = {
        domain: RateLimiter(min_delay=args.delay)
        for domain in {_domain_key(source.url) for source in sources}
    }
    total_new = 0
    total_known = 0
    total_duplicates = 0
    seen_urls: set[str] = set()
    seen_titles: dict[tuple[str, str], str] = {}

    for source in sources:
        url = source.url
        try:
            adapter_cls = (
                ADAPTER_REGISTRY.get(source.domain)
                if isinstance(source, _ResolvedDiscoverySource)
                else None
            )
            adapter_cls = adapter_cls or _resolve_adapter(args, url)
            adapter = adapter_cls()
            source_content_type = _source_content_type(args, adapter, source)

            rate_limiters[_domain_key(url)].wait()
            for header in ("Referer", "Origin", "Upgrade-Insecure-Requests"):
                session.headers.pop(header, None)
            session.headers.update({"User-Agent": random_user_agent()})
            extra_headers = adapter.get_request_headers(url)
            if extra_headers:
                session.headers.update(extra_headers)
            extra_cookies = adapter.get_cookies()
            resp = fetch_with_retry(session, url, cookies=extra_cookies if extra_cookies else None)
            if getattr(adapter, "encoding", None):
                text = resp.content.decode(adapter.encoding, errors="replace")
            else:
                text = decode_response(resp)
            text = adapter.preprocess_html(text, resp.url)
            soup = BeautifulSoup(text, "html.parser")

            books = adapter.extract_book_list(soup, resp.url)

            new_books: list[dict] = []
            known_books: list[dict] = []
            duplicate_books: list[dict] = []
            for book in books:
                title = _clean_discovered_title(book.get("title", ""))
                book_url = book.get("url", "")
                if not title or not book_url:
                    continue

                url_key = _canonicalize_url(book_url)
                title_key = (source_content_type, normalize_title(title))
                existing = (
                    registry.lookup_by_url(book_url, content_type=source_content_type)
                    or registry.lookup_by_title(title, content_type=source_content_type)
                )
                if existing is not None:
                    known_books.append({**book, "title": title, "book_slug": existing})
                elif url_key in seen_urls or title_key in seen_titles:
                    duplicate_books.append({
                        **book,
                        "title": title,
                        "duplicate_of": seen_titles.get(title_key, url_key),
                    })
                else:
                    seen_urls.add(url_key)
                    seen_titles[title_key] = book_url
                    new_books.append({**book, "title": title})

            item_label = _item_label(source_content_type)
            print(f"\n{'='*60}")
            print(
                f"{source.label} [{source.kind}, p{source.priority}]  {url}\n"
                f"  —  {len(new_books)} new {item_label}, "
                f"{len(known_books)} known, {len(duplicate_books)} duplicate-in-run"
            )
            index_name = "stories.json" if source_content_type == "story" else "books.json"
            print(f"       index: Library/indexes/{index_name}")
            print(f"{'='*60}")

            limit = args.discover_limit if args.discover_limit is not None else len(new_books)
            for i, book in enumerate(new_books[:limit], 1):
                print(f"  {i:4d}.  {book['title']:30s}  {book['url']}")
            if len(new_books) > limit:
                print(f"  ... {len(new_books) - limit} more new {item_label} hidden by --discover-limit")

            if args.show_known and known_books:
                print(f"  --- {len(known_books)} already in Library/indexes/books.json ---")
                for book in known_books:
                    print(f"  [known]  {book['title']:30s}  → {book['book_slug']}")
            if args.show_known and duplicate_books:
                print(f"  --- {len(duplicate_books)} duplicate(s) already seen in this discover run ---")
                for book in duplicate_books[:limit]:
                    print(f"  [dupe]   {book['title']:30s}  → {book['duplicate_of']}")

            total_new += len(new_books)
            total_known += len(known_books)
            total_duplicates += len(duplicate_books)

        except Exception as exc:
            print(f"[FAIL] {url}: {exc}", file=sys.stderr)

    item_label = _item_label(args.content_type)
    print(
        f"\n{total_new} new {item_label}, {total_known} known, "
        f"{total_duplicates} duplicate-in-run "
        "(checked against Library/indexes/books.json)"
    )
    if total_new:
        content_flag = "" if args.content_type == "auto" else f" --content-type {args.content_type}"
        print(f"To fetch: fetcher-run{content_flag} <url>")
    return 0


def _item_label(content_type: str) -> str:
    if content_type == "book":
        return "books"
    if content_type == "story":
        return "stories"
    return "items"


def _cmd_import(args) -> int:
    """Import a whole-book .txt into the canonical layout."""
    txt_path = Path(args.import_file)
    if not txt_path.exists():
        print(f"File not found: {txt_path}", file=sys.stderr)
        return 1

    title = args.title or txt_path.stem
    registry = BookRegistry()
    slug = registry.import_whole_book(title, txt_path)
    canonical_dir = registry.source_dir(slug)

    print(f"[OK] {txt_path}")
    print(f"     title:  {title}")
    print(f"     slug:   {slug}")
    print(f"     layout: {canonical_dir}/")
    print(f"       source.txt   ← {txt_path.name}")
    print(f"       index.json   (whole-book manifest)")
    print(f"\nNext: jormungandr-hard-run {canonical_dir}/")
    return 0


def _cmd_summary(args) -> int:
    """Print a summary of all registered books."""
    registry = BookRegistry()
    summary = registry.summary()

    print(f"Book index:  Library/indexes/books.json")
    print(f"Total items: {summary['total_books']}")
    print()

    for book in summary["books"]:
        slug = book["book_slug"]
        n_ch = book.get("chapter_count", 0)
        size_kb = round(book.get("total_size_bytes", 0) / 1024, 1)
        source_type = book.get("source_type", "—")
        title = book["title"]
        url = book.get("source_url", "")

        print(f"  {slug}  {title}")
        print(f"          source: {source_type}  chapters: {n_ch}  size: {size_kb} KB")
        if url:
            print(f"          url:    {url}")
        if not book.get("has_rawdata", book.get("has_raw_text")):
            print(f"          no rawdata on disk")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
