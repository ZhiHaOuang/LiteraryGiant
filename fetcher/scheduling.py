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
from pathlib import Path

from .adapters import ADAPTER_REGISTRY, get_adapter_for_url
from .engine import FetcherEngine
from .registry import BookRegistry

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser for ``fetcher-run``."""
    parser = argparse.ArgumentParser(
        prog="fetcher-run",
        description=(
            "Site-agnostic web novel fetcher.  Adapters auto-detected from "
            "URL domain.  Chapters are staged in runs/fetch/<run_id>/ and "
            "promoted to Yggdrasil/sources/raw_text/<book_id>/ after validation."
        ),
    )
    parser.add_argument(
        "urls",
        nargs="*",
        metavar="URL",
        help="Novel index/chapter-list URLs to scrape.  "
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
        help="Stop after fetching N chapters (useful for testing).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="How many chapters to fetch in parallel. Default: 3",
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
            "Treat URL(s) as book listing pages and print discovered "
            "book URLs.  Books already in the registry are marked [known] "
            "and counted separately.  Use --show-known to include them."
        ),
    )
    parser.add_argument(
        "--show-known",
        action="store_true",
        help="When --discover is used, also list books already in the registry.",
    )
    parser.add_argument(
        "--import",
        dest="import_file",
        default=None,
        metavar="FILE.txt",
        help="Import a whole-book .txt file into the canonical layout "
             "(Yggdrasil/sources/raw_text/<book_slug>/source.txt + index.json). "
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
        help="Print a summary of all registered books and their on-disk state.",
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

    # -- fetch mode
    run_id = args.run_id or uuid.uuid4().hex[:12]
    logger.info("Run ID: %s", run_id)

    written: list[Path] = []
    failed: list[tuple[str, str]] = []

    for url in args.urls:
        try:
            adapter_cls = _resolve_adapter(args, url)
            adapter = adapter_cls()
            logger.info("Adapter: %s (%s)", adapter_cls.__name__, adapter.domain)

            engine = FetcherEngine(
                adapter,
                min_delay=args.delay,
                max_chapters=args.max_chapters,
                run_id=run_id,
                concurrency=args.concurrency,
            )
            output_path = engine.fetch_novel(url)
            written.append(output_path)
            print(f"[OK]  {url}  →  {output_path}")

        except Exception as exc:
            logger.exception("Failed to fetch %s", url)
            failed.append((url, str(exc)))
            print(f"[FAIL]  {url}: {exc}", file=sys.stderr)

    print()
    print(
        f"Finished. {len(written)} book(s) promoted, {len(failed)} failed. "
        f"staging: runs/fetch/{run_id}/"
    )
    return 0 if not failed else 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_adapter(args, url: str):
    """Resolve the adapter class from --adapter flag or URL auto-detection."""
    if args.adapter:
        adapter_cls = ADAPTER_REGISTRY.get(args.adapter)
        if adapter_cls is None:
            print(
                f"Unknown adapter: {args.adapter}. "
                f"Available: {list(ADAPTER_REGISTRY)}",
                file=sys.stderr,
            )
            sys.exit(1)
        return adapter_cls
    return get_adapter_for_url(url)


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def _cmd_list_adapters() -> int:
    """Print registered adapters."""
    print("Supported site adapters:\n")
    for domain, cls in sorted(ADAPTER_REGISTRY.items()):
        doc = (cls.__doc__ or "").strip().split("\n")[0]
        print(f"  {domain:30s}  {cls.__name__:20s}  {doc}")
    print(f"\nAuto-detection: URL domain → adapter class.")
    print(f"Override:         fetcher-run --adapter <domain> <url>")
    return 0


def _cmd_discover(args) -> int:
    """Discover books from listing pages, filtering out registered ones."""
    import requests
    from bs4 import BeautifulSoup
    from .utils import build_session, decode_response

    urls = args.urls if args.urls else [
        "https://www.bqquge.com/paihang",
    ]

    registry = BookRegistry()
    session = build_session()
    total_new = 0
    total_known = 0

    for url in urls:
        try:
            adapter_cls = _resolve_adapter(args, url)
            adapter = adapter_cls()

            resp = session.get(url)
            resp.raise_for_status()
            text = decode_response(resp)
            soup = BeautifulSoup(text, "html.parser")

            books = adapter.extract_book_list(soup, url)

            new_books: list[dict] = []
            known_books: list[dict] = []
            for book in books:
                existing = registry.lookup_by_url(book["url"])
                if existing is not None:
                    known_books.append({**book, "book_slug": existing})
                else:
                    new_books.append(book)

            print(f"\n{'='*60}")
            print(f"{url}  —  {len(new_books)} new, {len(known_books)} known")
            print(f"       index: Yggdrasil/indexes/books.json")
            print(f"{'='*60}")

            for i, book in enumerate(new_books, 1):
                print(f"  {i:4d}.  {book['title']:30s}  {book['url']}")

            if args.show_known and known_books:
                print(f"  --- {len(known_books)} already in Yggdrasil/indexes/books.json ---")
                for book in known_books:
                    print(f"  [known]  {book['title']:30s}  → {book['book_slug']}")

            total_new += len(new_books)
            total_known += len(known_books)

        except Exception as exc:
            print(f"[FAIL] {url}: {exc}", file=sys.stderr)

    print(f"\n{total_new} new, {total_known} known (checked against Yggdrasil/indexes/books.json)")
    if total_new:
        print("To fetch: fetcher-run <url>")
    return 0


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

    print(f"Book index:  Yggdrasil/indexes/books.json")
    print(f"Total books: {summary['total_books']}")
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
        if not book.get("has_raw_text"):
            print(f"          ⚠ no raw_text on disk")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
