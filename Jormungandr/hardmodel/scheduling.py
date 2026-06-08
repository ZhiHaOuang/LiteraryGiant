from __future__ import annotations

import argparse
import logging
from pathlib import Path
import sys

from shared import PipelineState, compute_path_signature, serialize_payload

from .source_resolver import resolve_input
from .processor import (
    materialize_source_chapters,
    process_book_source,
    resolve_output_dir,
    write_result_file,
)
from .llm_noise_classifier import QwenWeakNoiseClassifier


logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jormungandr-hard-run",
        description="Run rule-based TXT novel preprocessing for a single file or a directory of files.",
    )
    parser.add_argument("input", help="Input txt file path or directory path.")
    parser.add_argument(
        "-o",
        "--output",
        help="Output root directory. Defaults to Yggdrasil/derived/chapters.",
    )
    parser.add_argument(
        "--pattern",
        default="*.txt",
        help="Glob pattern when input is a directory. Default: *.txt",
    )
    parser.add_argument(
        "--non-recursive",
        action="store_true",
        help="Only scan the top level of the input directory.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Preferred input encoding. Fallback encodings are handled internally.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1500,
        help="Maximum characters per chunk before overlap handling.",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=200,
        help="Overlap characters kept between adjacent chunks.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write compact JSON instead of pretty JSON.",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout. Only valid for a single input file.",
    )
    parser.add_argument(
        "--materialize-source-chapters",
        action="store_true",
        help="For whole-book source.txt inputs, write source-level chapter TXT files under source_dir/chapters/.",
    )
    parser.add_argument(
        "--sync-state",
        dest="sync_state",
        action="store_true",
        default=True,
        help="Sync progress and chapter state into runs/pipeline_state/state.json. Enabled by default.",
    )
    parser.add_argument(
        "--no-sync-state",
        dest="sync_state",
        action="store_false",
        help="Do not write progress or chapter state into runs/pipeline_state/state.json for this run.",
    )
    parser.add_argument(
        "--noise-classifier-model",
        default=None,
        help="Optional local Qwen model path used to classify weak-noise windows.",
    )
    parser.add_argument(
        "--noise-classifier-batch-size",
        type=int,
        default=32,
        help="Weak-noise windows per LLM classification prompt. Default: 32.",
    )
    parser.add_argument(
        "--noise-classifier-max-new-tokens",
        type=int,
        default=128,
        help="Max new tokens for each weak-noise classification prompt.",
    )
    parser.add_argument(
        "--noise-classifier-device-map",
        default="auto",
        help="Transformers device_map for the weak-noise classifier. Default: auto.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    sources = resolve_input(input_path)
    total_books = len(sources)

    if args.stdout and total_books > 1:
        parser.error("--stdout can only be used when the input resolves to a single book.")

    pretty = not args.compact
    written_dirs: list[Path] = []
    noise_classifier = None
    if args.noise_classifier_model:
        noise_classifier = QwenWeakNoiseClassifier(
            args.noise_classifier_model,
            batch_size=args.noise_classifier_batch_size,
            max_new_tokens=args.noise_classifier_max_new_tokens,
            device_map=args.noise_classifier_device_map,
        )
    state = PipelineState() if args.sync_state else None
    if state is not None:
        state.begin_run("hardmodel", total_candidates=total_books)

    try:
        for source in sources:
            tracking_source = source.primary_source
            tracking_signature = compute_path_signature(tracking_source)
            if state is not None:
                book_record, is_new_book = state.get_or_create_book(
                    source_path=tracking_source,
                    source_signature=tracking_signature,
                )
            else:
                book_record, is_new_book = None, False

            try:
                book_result = process_book_source(
                    source,
                    output_root=args.output,
                    encoding=args.encoding,
                    chunk_size=args.chunk_size,
                    chunk_overlap=args.chunk_overlap,
                    state=state,
                    noise_classifier=noise_classifier,
                )

                if not book_result:
                    if state is not None:
                        state.increment_run_counter("hardmodel", "skipped")
                    print(f"[SKIP] {source.title} — no new chapters")
                    continue

                if args.stdout:
                    sys.stdout.write(serialize_payload(book_result, pretty=pretty))
                    if pretty:
                        sys.stdout.write("\n")
                    if state is not None and book_record is not None:
                        state.record_step(
                            step_name="hardmodel",
                            book=book_record,
                            source_signature=tracking_signature,
                            status="completed",
                            output_path=None,
                            params={"encoding": args.encoding, "stdout_only": True},
                            metadata={"book_id": source.book_id, "chapter_count": book_result["book_metadata"]["chapter_count"]},
                        )
                        state.increment_run_counter("hardmodel", "processed")
                    continue

                output_dir = resolve_output_dir(book_result, output_root=args.output)
                if args.materialize_source_chapters:
                    materialized_dir = materialize_source_chapters(source, book_result, pretty=pretty)
                    if materialized_dir is not None:
                        print(f"[SOURCE] {source.title} -> {materialized_dir}")
                write_result_file(output_dir, book_result, pretty=pretty)
                written_dirs.append(output_dir)

                if state is not None and book_record is not None:
                    state.update_raw_stats(
                        book_record,
                        {"file_size_bytes": sum(c.source_path.stat().st_size for c in source.chapters) if source.chapters else 0},
                    )
                    state.record_step(
                        step_name="hardmodel",
                        book=book_record,
                        source_signature=tracking_signature,
                        status="completed",
                        output_path=output_dir,
                        params={
                            "encoding": args.encoding,
                            "chunk_size": args.chunk_size,
                            "chunk_overlap": args.chunk_overlap,
                            "noise_classifier_model": str(args.noise_classifier_model or ""),
                        },
                        metadata=book_result["book_metadata"],
                    )
                    state.increment_run_counter("hardmodel", "processed")

                print(
                    f"[OK] {source.title} ({source.mode}) -> {output_dir} "
                    f"(index={book_record['index'] if book_record is not None else 'no-state'}, "
                    f"{'new' if is_new_book else 'updated'}, "
                    f"chapters={book_result['book_metadata']['chapter_count']}, "
                    f"chars={book_result['book_metadata']['total_chars']})"
                )
            except Exception as exc:
                if state is not None and book_record is not None:
                    state.record_step(
                        step_name="hardmodel",
                        book=book_record,
                        source_signature=tracking_signature,
                        status="failed",
                        output_path=None,
                        error=str(exc),
                    )
                    state.increment_run_counter("hardmodel", "failed")
                logger.exception("Failed to process book: %s", source.title)
                print(f"[FAIL] {source.title}: {exc}", file=sys.stderr)
    finally:
        if state is not None:
            state.finish_run("hardmodel")

    if not args.stdout:
        run_stats = state.run_stats("hardmodel") if state is not None else {}
        print(
            f"Finished. Wrote {len(written_dirs)} book folder(s). "
            f"processed={run_stats.get('processed', 0)} "
            f"skipped={run_stats.get('skipped', 0)} "
            f"failed={run_stats.get('failed', 0)} "
            f"tracker={state.path if state is not None else 'disabled'}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
