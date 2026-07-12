from __future__ import annotations

import argparse
import os
from pathlib import Path

from shared import FACT_CHAPTER_FEATURES_ROOT, FACT_PLOT_SEGMENTS_ROOT, PipelineState, compute_path_signature, load_json
from shared.stage_queue import (
    NEGATIVE_BOOKS_PATH,
    load_curated_book_keys,
    load_negative_book_keys,
    mark_stage_done,
    registry_ordered_book_dirs,
    stage_is_done,
)

from .api_client import ApiConfig
from .merger import PlotSegmentMerger
from .pipeline import InferModelPipeline
from .processor import discover_feature_books, load_feature_book_bundle, order_feature_books_by_size, process_and_write_book_dir, resolve_cluster_output_dir
from .summarizer import DEFAULT_API_MODEL, PlotWindowAnalyzer
from .windowing import SlidingWindowPlanner


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="infermodel-run",
        description="Extract global plot segments from chapter summaries using overlapping windows, LLM API segmentation, and window voting merge.",
    )
    parser.add_argument(
        "input",
        help=f"Input {FACT_CHAPTER_FEATURES_ROOT} root or one feature book directory.",
    )
    parser.add_argument(
        "-o",
        "--output",
        help=f"Output root directory. Defaults to {FACT_PLOT_SEGMENTS_ROOT}.",
    )
    parser.add_argument(
        "--priority-book",
        action="append",
        default=[],
        help=(
            "Book key to run before size-sorted auto queue. May be repeated. "
            "Accepted keys include clean slug/book_XXXX, clean id, title, raw slug, identity key, or source URL."
        ),
    )
    parser.add_argument(
        "--priority-file",
        help=(
            "Optional priority book list. Defaults to Library/indexes/priority_books.txt. "
            "Use an empty/nonexistent path to rely only on --priority-book."
        ),
    )
    parser.add_argument(
        "--negative-book",
        action="append",
        default=[],
        help=(
            "Book key to skip for this infermodel run. May be repeated. "
            "Accepted keys match --priority-book."
        ),
    )
    parser.add_argument(
        "--negative-file",
        default=str(NEGATIVE_BOOKS_PATH),
        help="Optional negative book list. Defaults to Library/indexes/negative_books.txt.",
    )
    parser.add_argument(
        "--min-auto-chapters",
        type=int,
        default=21,
        help="Minimum chapter count for the automatic size-sorted infermodel queue. Explicit priority books bypass this.",
    )
    parser.add_argument(
        "--max-auto-chapters",
        type=int,
        default=1500,
        help="Maximum chapter count for the automatic size-sorted infermodel queue. Explicit priority books bypass this.",
    )

    # -- windowing ---------------------------------------------------------------
    parser.add_argument("--window-size", type=int, default=20,
                        help="Sliding window size measured in chapters.")
    parser.add_argument("--window-overlap", type=int, default=10,
                        help="Number of overlapping chapters between adjacent windows.")
    parser.add_argument("--min-window-size", type=int, default=8,
                        help="Minimum tail window size.")

    # -- API config ---------------------------------------------------------------
    parser.add_argument("--api-key", default=os.environ.get("INFERMODEL_API_KEY") or os.environ.get("MIMO_API_KEY", ""),
                        help="API key. Defaults to INFERMODEL_API_KEY, then MIMO_API_KEY.")
    parser.add_argument("--api-base-url", default=os.environ.get("INFERMODEL_API_BASE_URL", "https://token-plan-cn.xiaomimimo.com/anthropic"),
                        help="API base URL, e.g. MiMO /anthropic or OpenAI-compatible /v1.")
    parser.add_argument("--api-model", default=os.environ.get("INFERMODEL_API_MODEL", "mimo-v2.5-pro"),
                        help="Model name sent to the API.")
    parser.add_argument("--api-provider", choices=("auto", "anthropic", "openai"), default=os.environ.get("INFERMODEL_API_PROVIDER", "auto"),
                        help="API protocol. auto selects Anthropic for /anthropic bases and OpenAI for /v1 bases.")
    parser.add_argument("--api-user-id", default=os.environ.get("INFERMODEL_API_USER_ID", ""),
                        help="Optional provider user_id for DeepSeek KVCache/scheduling/content-safety isolation.")

    # -- prompt limits ------------------------------------------------------------
    parser.add_argument("--window-max-input-chars", type=int, default=14000,
                        help="Maximum characters passed to the plot segmentation prompt.")
    parser.add_argument("--fusion-max-input-chars", type=int, default=7000,
                        help="Maximum characters passed to the plot summary fusion prompt.")
    parser.add_argument("--max-new-tokens", type=int, default=6144,
                        help="Maximum new tokens per API call.")
    parser.add_argument("--api-timeout", type=float, default=90.0,
                        help="HTTP timeout in seconds per API call before falling back.")
    parser.add_argument("--api-retries", type=int, default=2,
                        help="Maximum HTTP attempts per API call before using deterministic fallback.")
    parser.add_argument("--max-workers", type=int, default=6,
                        help="Maximum parallel API calls for window analysis, boundary validation, and plot fusion.")
    parser.add_argument(
        "--max-books",
        type=int,
        default=0,
        help="Maximum number of queued books to process in this run. 0 means no limit.",
    )

    # -- merger thresholds --------------------------------------------------------
    parser.add_argument("--boundary-vote-threshold", type=float, default=0.45,
                        help="Minimum normalized boundary support for a cut point.")
    parser.add_argument("--strong-boundary-threshold", type=float, default=0.7,
                        help="High-confidence boundary support threshold.")
    parser.add_argument("--min-boundary-votes", type=int, default=1,
                        help="Minimum positive boundary votes before a cut point.")
    parser.add_argument(
        "--boundary-validation-mode",
        choices=("off", "gray", "full"),
        default="off",
        help=(
            "How often to call the LLM for boundary validation. "
            "off trusts window votes, gray validates only ambiguous boundaries, full validates broadly."
        ),
    )

    # -- refinement ---------------------------------------------------------------
    parser.add_argument("--max-plot-chapters", type=int, default=24,
                        help="Plots longer than this trigger refinement.")
    parser.add_argument("--max-refinement-rounds", type=int, default=2,
                        help="Maximum recursive refinement rounds.")
    parser.add_argument("--fallback-retry-rounds", type=int, default=1,
                        help="Retry window checkpoints whose analysis_status is fallback before merging. 0 reuses fallback checkpoints.")
    parser.add_argument("--refinement-window-size", type=int, default=32)
    parser.add_argument("--refinement-window-overlap", type=int, default=12)
    parser.add_argument("--refinement-min-window-size", type=int, default=10)

    # -- output ------------------------------------------------------------------
    parser.add_argument("--compact", action="store_true",
                        help="Write compact JSON instead of pretty JSON.")
    parser.add_argument(
        "--sync-state",
        dest="sync_state",
        action="store_true",
        default=False,
        help="Sync book progress into runs/pipeline_state/state.json. Disabled by default for long infermodel runs.",
    )
    parser.add_argument(
        "--no-sync-state",
        dest="sync_state",
        action="store_false",
        help="Do not write infermodel progress into runs/pipeline_state/state.json for this run. This is the default.",
    )
    parser.add_argument(
        "--checkpoint",
        dest="checkpoint",
        action="store_true",
        default=True,
        help="Write and reuse per-window/per-plot checkpoints under each output book directory. Enabled by default.",
    )
    parser.add_argument(
        "--no-checkpoint",
        dest="checkpoint",
        action="store_false",
        help="Disable infermodel checkpoint/resume files for this run.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.api_key:
        parser.error(
            "No API key provided.  Set INFERMODEL_API_KEY or MIMO_API_KEY "
            "environment variable, or pass --api-key."
        )

    api_config = ApiConfig(
        api_key=args.api_key,
        base_url=args.api_base_url,
        model_name=args.api_model,
        provider=args.api_provider,
        max_tokens=args.max_new_tokens,
        timeout=args.api_timeout,
        max_retries=args.api_retries,
        user_id=args.api_user_id,
    )

    window_planner = SlidingWindowPlanner(
        window_size=args.window_size,
        window_overlap=args.window_overlap,
        min_window_size=args.min_window_size,
    )
    window_analyzer = PlotWindowAnalyzer(
        config=api_config,
        max_window_input_chars=args.window_max_input_chars,
        max_fusion_input_chars=args.fusion_max_input_chars,
        max_new_tokens=args.max_new_tokens,
    )
    merger = PlotSegmentMerger(
        boundary_vote_threshold=args.boundary_vote_threshold,
        strong_boundary_threshold=args.strong_boundary_threshold,
        min_boundary_votes=args.min_boundary_votes,
        boundary_validation_mode=args.boundary_validation_mode,
    )
    refinement_window_planner = SlidingWindowPlanner(
        window_size=args.refinement_window_size,
        window_overlap=args.refinement_window_overlap,
        min_window_size=args.refinement_min_window_size,
    )
    pipeline = InferModelPipeline(
        window_planner=window_planner,
        window_analyzer=window_analyzer,
        merger=merger,
        refinement_window_planner=refinement_window_planner,
        max_plot_chapters=args.max_plot_chapters,
        max_refinement_rounds=args.max_refinement_rounds,
        max_workers=args.max_workers,
        fallback_retry_rounds=args.fallback_retry_rounds,
    )

    pretty = not args.compact
    queue_result = registry_ordered_book_dirs(
        args.input,
        source_stage="chapter_features",
        output_root=args.output or FACT_PLOT_SEGMENTS_ROOT,
        output_stage="infermodel",
        priority_path=args.priority_file,
        priority_keys=args.priority_book,
        negative_path=args.negative_file,
        negative_keys=args.negative_book,
        min_auto_chapters=args.min_auto_chapters,
        max_auto_chapters=args.max_auto_chapters,
    )
    if queue_result is None:
        fallback_priority_keys = (
            load_curated_book_keys(args.priority_file, extra_keys=args.priority_book)
            if args.priority_file is not None
            else load_curated_book_keys(extra_keys=args.priority_book)
        )
        fallback_negative_keys = (
            load_negative_book_keys(args.negative_file, extra_keys=args.negative_book)
            if args.negative_file is not None
            else load_negative_book_keys(extra_keys=args.negative_book)
        )
        books = order_feature_books_by_size(
            discover_feature_books(args.input),
            priority_keys=fallback_priority_keys,
            negative_keys=fallback_negative_keys,
            min_auto_chapters=args.min_auto_chapters,
            max_auto_chapters=args.max_auto_chapters,
        )
    else:
        books, queue_stats = queue_result
        print(
            f"[QUEUE] registry={queue_stats.source} queued={queue_stats.queued} "
            f"curated={queue_stats.curated} done={queue_stats.skipped_done} "
            f"missing_source={queue_stats.skipped_missing_source} "
            f"incomplete={queue_stats.skipped_incomplete} "
            f"negative={queue_stats.skipped_negative} "
            f"chapter_range={queue_stats.skipped_chapter_range}"
        )
    if args.max_books > 0 and len(books) > args.max_books:
        print(f"[QUEUE] limiting run to first {args.max_books} of {len(books)} queued book(s)")
        books = books[:args.max_books]
    written_dirs: list[Path] = []
    local_stats = {"processed": 0, "skipped": 0, "failed": 0}
    state = PipelineState() if args.sync_state else None
    if state is not None:
        state.begin_run("infermodel", total_candidates=len(books))

    try:
        for book_dir in books:
            feature_index = {"book_metadata": {"book_id": Path(book_dir).name}}
            feature_index_path = Path(book_dir) / "index.json"
            if feature_index_path.exists():
                feature_index = {"index": load_json(feature_index_path)}
            output_dir = resolve_cluster_output_dir(feature_index, output_root=args.output)
            if stage_is_done(output_dir, "infermodel") or (output_dir / "index.json").exists():
                if not stage_is_done(output_dir, "infermodel"):
                    mark_stage_done(
                        output_dir,
                        "infermodel",
                        metadata={"source": "plot-index", "source_feature_dir": str(book_dir)},
                    )
                local_stats["skipped"] += 1
                if state is not None:
                    state.increment_run_counter("infermodel", "skipped")
                print(f"[SKIP] {book_dir} -> {output_dir} (done-file)")
                continue

            if state is not None:
                feature_signature = compute_path_signature(book_dir)
                should_skip, matched_book = state.should_skip_step(
                    step_name="infermodel",
                    source_path=book_dir,
                    source_signature=feature_signature,
                    output_path=output_dir,
                )
            else:
                should_skip, matched_book = False, None
                feature_signature = ""

            if should_skip and matched_book is not None and state is not None:
                local_stats["skipped"] += 1
                state.increment_run_counter("infermodel", "skipped")
                print(f"[SKIP] {book_dir} -> {output_dir} (index={matched_book.get('index', 'unknown')})")
                continue

            if state is not None:
                book_record, is_new_book = state.get_or_create_book(
                    source_path=book_dir,
                    source_signature=feature_signature,
                )
            else:
                book_record, is_new_book = None, False

            try:
                output_dir = process_and_write_book_dir(
                    book_dir,
                    pipeline=pipeline,
                    output_root=args.output,
                    pretty=pretty,
                    state=state,
                    book_record=book_record,
                    checkpoint_enabled=args.checkpoint,
                )
                written_dirs.append(output_dir)
                mark_stage_done(
                    output_dir,
                    "infermodel",
                    metadata={"source_feature_dir": str(book_dir)},
                )
                local_stats["processed"] += 1
                if state is not None and book_record is not None:
                    state.record_step(
                        step_name="infermodel",
                        book=book_record,
                        source_signature=feature_signature,
                        status="completed",
                        output_path=output_dir,
                        params={
                            "window_size": args.window_size,
                            "window_overlap": args.window_overlap,
                            "min_window_size": args.min_window_size,
                            "api_model": args.api_model,
                            "api_base_url": args.api_base_url,
                            "api_provider": args.api_provider,
                            "window_max_input_chars": args.window_max_input_chars,
                            "fusion_max_input_chars": args.fusion_max_input_chars,
                            "max_new_tokens": args.max_new_tokens,
                            "api_timeout": args.api_timeout,
                            "api_retries": args.api_retries,
                            "max_workers": args.max_workers,
                            "max_books": args.max_books,
                            "boundary_vote_threshold": args.boundary_vote_threshold,
                            "strong_boundary_threshold": args.strong_boundary_threshold,
                            "min_boundary_votes": args.min_boundary_votes,
                            "boundary_validation_mode": args.boundary_validation_mode,
                            "max_plot_chapters": args.max_plot_chapters,
                            "max_refinement_rounds": args.max_refinement_rounds,
                            "fallback_retry_rounds": args.fallback_retry_rounds,
                            "refinement_window_size": args.refinement_window_size,
                            "refinement_window_overlap": args.refinement_window_overlap,
                            "refinement_min_window_size": args.refinement_min_window_size,
                            "checkpoint": args.checkpoint,
                            "negative_file": args.negative_file,
                            "negative_books": args.negative_book,
                            "min_auto_chapters": args.min_auto_chapters,
                            "max_auto_chapters": args.max_auto_chapters,
                        },
                        metadata={
                            "book_index": book_record["index"],
                            "source_feature_dir": str(book_dir),
                        },
                    )
                    state.increment_run_counter("infermodel", "processed")
                print(
                    f"[OK] {book_dir} -> {output_dir} "
                    f"(index={book_record['index'] if book_record is not None else 'no-state'}, {'new' if is_new_book else 'updated'})"
                )
            except Exception as exc:
                if state is not None and book_record is not None:
                    state.record_step(
                        step_name="infermodel",
                        book=book_record,
                        source_signature=feature_signature,
                        status="failed",
                        output_path=output_dir,
                        params={
                            "window_size": args.window_size,
                            "window_overlap": args.window_overlap,
                            "min_window_size": args.min_window_size,
                            "api_model": args.api_model,
                            "api_base_url": args.api_base_url,
                            "api_provider": args.api_provider,
                            "window_max_input_chars": args.window_max_input_chars,
                            "fusion_max_input_chars": args.fusion_max_input_chars,
                            "max_new_tokens": args.max_new_tokens,
                            "api_timeout": args.api_timeout,
                            "api_retries": args.api_retries,
                            "boundary_validation_mode": args.boundary_validation_mode,
                        },
                        metadata={"book_index": book_record["index"]},
                        error=str(exc),
                    )
                    state.increment_run_counter("infermodel", "failed")
                local_stats["failed"] += 1
                raise
    finally:
        if state is not None:
            state.finish_run("infermodel")

    run_stats = state.run_stats("infermodel") if state is not None else local_stats
    print(
        f"Finished. Wrote {len(written_dirs)} plot cluster folder(s). "
        f"processed={run_stats.get('processed', 0)} "
        f"skipped={run_stats.get('skipped', 0)} "
        f"failed={run_stats.get('failed', 0)} "
        f"tracker={state.path if state is not None else 'disabled'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
