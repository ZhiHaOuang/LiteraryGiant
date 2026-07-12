from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from shared import (
    FACT_CHAPTER_FEATURES_ROOT,
    FACT_CLEANED_CHAPTERS_ROOT,
    FACT_PLOT_SEGMENTS_ROOT,
    INDEXES_ROOT,
    LIBRARY_ROOT,
    load_json,
)
from shared.stage_queue import registry_ordered_book_dirs
from shared.stage_queue import NEGATIVE_BOOKS_PATH


def _entry_by_slug() -> dict[str, dict[str, Any]]:
    payload = load_json(INDEXES_ROOT / "cleaned_books.json")
    books = payload.get("books") if isinstance(payload, dict) else {}
    entries = books.values() if isinstance(books, dict) else books
    return {
        str(entry.get("clean_slug") or ""): entry
        for entry in entries
        if isinstance(entry, dict) and str(entry.get("clean_slug") or "")
    }


def _default_paths(stage: str) -> tuple[Path, Path, str, str]:
    if stage == "softmodel":
        return FACT_CLEANED_CHAPTERS_ROOT, FACT_CHAPTER_FEATURES_ROOT, "cleaned_chapters", "softmodel"
    return FACT_CHAPTER_FEATURES_ROOT, FACT_PLOT_SEGMENTS_ROOT, "chapter_features", "infermodel"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Preview the fast registry-driven stage queue.")
    parser.add_argument("stage", choices=("softmodel", "infermodel"))
    parser.add_argument("--input", help="Stage input root. Defaults to the canonical facts root.")
    parser.add_argument("--output", help="Stage output root. Defaults to the canonical facts root.")
    parser.add_argument("--limit", type=int, default=30, help="Number of queued books to print.")
    parser.add_argument("--all", action="store_true", help="Print all queued books.")
    parser.add_argument(
        "--priority-book",
        action="append",
        default=[],
        help="Book key to place before the size-sorted automatic queue. May be repeated.",
    )
    parser.add_argument(
        "--priority-file",
        help="Optional priority book list. Defaults to Library/indexes/priority_books.txt.",
    )
    parser.add_argument(
        "--negative-book",
        action="append",
        default=[],
        help="Book key to skip. May be repeated.",
    )
    parser.add_argument(
        "--negative-file",
        help="Optional negative book list. Defaults to Library/indexes/negative_books.txt.",
    )
    parser.add_argument(
        "--min-auto-chapters",
        type=int,
        default=None,
        help="Minimum chapter count for automatic queue entries. Defaults to 21 for infermodel.",
    )
    parser.add_argument(
        "--max-auto-chapters",
        type=int,
        default=None,
        help="Maximum chapter count for automatic queue entries. Defaults to 1500 for infermodel.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    default_input, default_output, source_stage, output_stage = _default_paths(args.stage)
    input_root = Path(args.input) if args.input else default_input
    output_root = Path(args.output) if args.output else default_output
    min_auto_chapters = args.min_auto_chapters
    max_auto_chapters = args.max_auto_chapters
    if args.stage == "infermodel":
        min_auto_chapters = 21 if min_auto_chapters is None else min_auto_chapters
        max_auto_chapters = 1500 if max_auto_chapters is None else max_auto_chapters
    negative_path = args.negative_file or str(NEGATIVE_BOOKS_PATH)
    result = registry_ordered_book_dirs(
        input_root,
        source_stage=source_stage,
        output_root=output_root,
        output_stage=output_stage,
        priority_path=args.priority_file,
        priority_keys=args.priority_book,
        negative_path=negative_path,
        negative_keys=args.negative_book,
        min_auto_chapters=min_auto_chapters,
        max_auto_chapters=max_auto_chapters,
    )
    if result is None:
        raise SystemExit(f"Registry queue is unavailable for input: {input_root}")

    books, stats = result
    print(
        f"stage={args.stage} queued={stats.queued} curated={stats.curated} "
        f"done={stats.skipped_done} missing_source={stats.skipped_missing_source} "
        f"incomplete={stats.skipped_incomplete} negative={stats.skipped_negative} "
        f"chapter_range={stats.skipped_chapter_range}"
    )
    entries = _entry_by_slug()
    limit = len(books) if args.all else max(0, args.limit)
    for index, book_dir in enumerate(books[:limit], start=1):
        entry = entries.get(book_dir.name, {})
        last_cleaned = entry.get("last_cleaned") if isinstance(entry.get("last_cleaned"), dict) else {}
        title = str(entry.get("title") or "")
        chapter_count = int((last_cleaned or {}).get("chapter_count") or 0)
        total_chars = int((last_cleaned or {}).get("total_chars") or 0)
        rel_path = book_dir
        try:
            rel_path = book_dir.resolve().relative_to(LIBRARY_ROOT.resolve())
        except ValueError:
            pass
        print(f"{index:04d} {book_dir.name} chars={total_chars} chapters={chapter_count} title={title} path={rel_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
