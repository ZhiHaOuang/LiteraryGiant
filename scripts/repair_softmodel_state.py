from __future__ import annotations

import argparse
from pathlib import Path

from shared import (
    FACT_CHAPTER_FEATURES_ROOT,
    FACT_CLEANED_CHAPTERS_ROOT,
    PipelineState,
    compute_path_signature,
    load_chapters_from_manifest,
    load_json,
)
from Jormungandr.softmodel.processor import (
    _chapter_manifest_entry,
    _feature_chapter_matches,
    chapter_feature_file_name,
    discover_processed_books,
    resolve_feature_output_dir,
    write_feature_index,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Recover softmodel chapter state from existing novels_chapter files "
            "without loading NuExtract/vLLM."
        ),
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        default=[str(FACT_CLEANED_CHAPTERS_ROOT)],
        help="Cleaned book dirs or novels_cleaned root. Defaults to the full novels_cleaned root.",
    )
    parser.add_argument(
        "-o",
        "--output-root",
        default=str(FACT_CHAPTER_FEATURES_ROOT),
        help="novels_chapter root.",
    )
    parser.add_argument(
        "--state-root",
        default="runs/pipeline_state",
        help="PipelineState root containing state.json.",
    )
    parser.add_argument(
        "--state-save-interval",
        type=int,
        default=200,
        help="Save state.json after this many recovered chapters.",
    )
    parser.add_argument(
        "--max-books",
        type=int,
        default=None,
        help="Recover at most this many books.",
    )
    return parser


def resolve_input_books(inputs: list[str]) -> list[Path]:
    books: list[Path] = []
    seen: set[Path] = set()
    for item in inputs:
        for book_dir in discover_processed_books(item):
            resolved = book_dir.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            books.append(book_dir)
    return sorted(books)


def recover_book(
    book_dir: Path,
    *,
    output_root: Path,
    state: PipelineState,
    state_save_interval: int,
    recovered_since_save: int,
) -> tuple[int, int, int]:
    index_payload = load_json(book_dir / "index.json")
    book_metadata = index_payload["book_metadata"]
    book_id = str(book_metadata["book_id"])
    source_book_path = book_metadata["source_path"]
    raw_source_signature = compute_path_signature(source_book_path) if Path(source_book_path).exists() else ""
    processdata_signature = compute_path_signature(book_dir)
    output_dir = resolve_feature_output_dir({"index": index_payload}, output_root=output_root)

    existing_index = {}
    if (output_dir / "index.json").exists():
        try:
            existing_index = load_json(output_dir / "index.json")
        except Exception:
            existing_index = {}
    extractor_config = existing_index.get("extractor_config") if isinstance(existing_index, dict) else {}
    if not isinstance(extractor_config, dict) or not extractor_config:
        extractor_config = {"recovered_from_existing_chapter_features": True}

    book_record, _ = state.get_or_create_book(
        source_path=source_book_path,
        source_signature=raw_source_signature or processdata_signature,
        update_source_signature=bool(raw_source_signature),
    )

    chapter_manifest: list[dict] = []
    total = 0
    recovered = 0
    missing = 0
    saves_due = recovered_since_save
    for chapter_file, chapter_payload in load_chapters_from_manifest(book_dir, index_payload, stage_name="chapters"):
        total += 1
        order = int(chapter_payload["order"])
        chapter_id = str(chapter_payload["chapter_id"])
        chapter_path = output_dir / chapter_feature_file_name(order)
        if not _feature_chapter_matches(
            chapter_path,
            book_id=book_id,
            chapter_payload=chapter_payload,
            source_file=chapter_file,
        ):
            missing += 1
            continue

        chapter_signature = compute_path_signature(chapter_file)
        chapter_record, _ = state.get_or_create_chapter(
            book_record,
            chapter_id=chapter_id,
            order=order,
            clean_title=str(chapter_payload.get("clean_title", "")),
            source_path=chapter_file,
            source_signature=chapter_signature,
            metadata={
                "chapter_no": chapter_payload.get("chapter_no"),
                "volume_title": chapter_payload.get("volume_title", ""),
                "char_count": chapter_payload.get("char_count", 0),
                "paragraph_count": chapter_payload.get("paragraph_count", 0),
                "dialogue_ratio": chapter_payload.get("dialogue_ratio"),
            },
        )
        state.record_chapter_step(
            step_name="softmodel",
            chapter=chapter_record,
            input_signature=chapter_signature,
            status="completed",
            output_path=chapter_path,
            params=extractor_config,
            metadata={
                "book_index": book_record["index"],
                "order": order,
                "chapter_id": chapter_id,
                "recovered_from_output": True,
            },
        )
        chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
        recovered += 1
        saves_due += 1
        if saves_due >= max(1, state_save_interval):
            state.save()
            saves_due = 0

    if chapter_manifest:
        write_feature_index(
            output_dir,
            book_metadata=book_metadata,
            source_book_dir=str(book_dir),
            extractor_config=extractor_config,
            chapter_manifest=chapter_manifest,
            pretty=True,
        )

    if recovered == total and total > 0:
        state.record_step(
            step_name="softmodel",
            book=book_record,
            source_signature=processdata_signature,
            status="completed",
            output_path=output_dir,
            params=extractor_config,
            metadata={
                "book_id": book_id,
                "book_index": book_record["index"],
                "chapter_count": total,
                "recovered_from_output": True,
            },
        )
    state.save()
    return total, recovered, missing


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    books = resolve_input_books(args.inputs)
    if args.max_books is not None:
        books = books[: args.max_books]

    state = PipelineState(retrieval_root=args.state_root)
    totals = {"books": 0, "chapters": 0, "recovered": 0, "missing": 0}
    recovered_since_save = 0
    for book_dir in books:
        total, recovered, missing = recover_book(
            book_dir,
            output_root=Path(args.output_root),
            state=state,
            state_save_interval=args.state_save_interval,
            recovered_since_save=recovered_since_save,
        )
        recovered_since_save = (recovered_since_save + recovered) % max(1, args.state_save_interval)
        if recovered:
            totals["books"] += 1
        totals["chapters"] += total
        totals["recovered"] += recovered
        totals["missing"] += missing
        print(f"[RECOVER] {book_dir.name}: recovered={recovered}/{total}, missing={missing}")

    state.save()
    print(
        "softmodel state repair done: "
        f"books_with_outputs={totals['books']} "
        f"recovered_chapters={totals['recovered']} "
        f"missing_chapters={totals['missing']} "
        f"state={state.path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
