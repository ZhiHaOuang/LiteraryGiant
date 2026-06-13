from __future__ import annotations

import argparse
import os
from pathlib import Path

from shared import FACT_CHAPTER_FEATURES_ROOT, FACT_PLOT_SEGMENTS_ROOT, PipelineState, compute_path_signature

from .api_client import ApiConfig
from .merger import PlotSegmentMerger
from .pipeline import InferModelPipeline
from .processor import discover_feature_books, load_feature_book_bundle, process_and_write_book_dir, resolve_cluster_output_dir
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

    # -- windowing ---------------------------------------------------------------
    parser.add_argument("--window-size", type=int, default=20,
                        help="Sliding window size measured in chapters.")
    parser.add_argument("--window-overlap", type=int, default=10,
                        help="Number of overlapping chapters between adjacent windows.")
    parser.add_argument("--min-window-size", type=int, default=8,
                        help="Minimum tail window size.")

    # -- API config ---------------------------------------------------------------
    parser.add_argument("--api-key", default=os.environ.get("MIMO_API_KEY", ""),
                        help="API key. Defaults to MIMO_API_KEY env var.")
    parser.add_argument("--api-base-url", default="https://token-plan-cn.xiaomimimo.com/anthropic",
                        help="API base URL, e.g. MiMO /anthropic or OpenAI-compatible /v1.")
    parser.add_argument("--api-model", default="mimo-v2.5-pro",
                        help="Model name sent to the API.")
    parser.add_argument("--api-provider", choices=("auto", "anthropic", "openai"), default="auto",
                        help="API protocol. auto selects Anthropic for /anthropic bases and OpenAI for /v1 bases.")

    # -- prompt limits ------------------------------------------------------------
    parser.add_argument("--window-max-input-chars", type=int, default=14000,
                        help="Maximum characters passed to the plot segmentation prompt.")
    parser.add_argument("--fusion-max-input-chars", type=int, default=7000,
                        help="Maximum characters passed to the plot summary fusion prompt.")
    parser.add_argument("--max-new-tokens", type=int, default=1400,
                        help="Maximum new tokens per API call.")

    # -- merger thresholds --------------------------------------------------------
    parser.add_argument("--boundary-vote-threshold", type=float, default=0.45,
                        help="Minimum normalized boundary support for a cut point.")
    parser.add_argument("--strong-boundary-threshold", type=float, default=0.7,
                        help="High-confidence boundary support threshold.")
    parser.add_argument("--min-boundary-votes", type=int, default=1,
                        help="Minimum positive boundary votes before a cut point.")

    # -- refinement ---------------------------------------------------------------
    parser.add_argument("--max-plot-chapters", type=int, default=24,
                        help="Plots longer than this trigger refinement.")
    parser.add_argument("--max-refinement-rounds", type=int, default=2,
                        help="Maximum recursive refinement rounds.")
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
        default=True,
        help="Sync book progress into runs/pipeline_state/state.json. Enabled by default.",
    )
    parser.add_argument(
        "--no-sync-state",
        dest="sync_state",
        action="store_false",
        help="Do not write infermodel progress into runs/pipeline_state/state.json for this run.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.api_key:
        parser.error(
            "No API key provided.  Set MIMO_API_KEY environment variable "
            "or pass --api-key."
        )

    api_config = ApiConfig(
        api_key=args.api_key,
        base_url=args.api_base_url,
        model_name=args.api_model,
        provider=args.api_provider,
        max_tokens=args.max_new_tokens,
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
    )

    pretty = not args.compact
    books = discover_feature_books(args.input)
    written_dirs: list[Path] = []
    state = PipelineState() if args.sync_state else None
    if state is not None:
        state.begin_run("infermodel", total_candidates=len(books))

    try:
        for book_dir in books:
            feature_signature = compute_path_signature(book_dir)
            feature_book = load_feature_book_bundle(book_dir)
            output_dir = resolve_cluster_output_dir(feature_book, output_root=args.output)
            if state is not None:
                should_skip, matched_book = state.should_skip_step(
                    step_name="infermodel",
                    source_path=book_dir,
                    source_signature=feature_signature,
                    output_path=output_dir,
                )
            else:
                should_skip, matched_book = False, None

            if should_skip and matched_book is not None and state is not None:
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
                )
                written_dirs.append(output_dir)
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
                            "boundary_vote_threshold": args.boundary_vote_threshold,
                            "strong_boundary_threshold": args.strong_boundary_threshold,
                            "min_boundary_votes": args.min_boundary_votes,
                            "max_plot_chapters": args.max_plot_chapters,
                            "max_refinement_rounds": args.max_refinement_rounds,
                            "refinement_window_size": args.refinement_window_size,
                            "refinement_window_overlap": args.refinement_window_overlap,
                            "refinement_min_window_size": args.refinement_min_window_size,
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
                        },
                        metadata={"book_index": book_record["index"]},
                        error=str(exc),
                    )
                    state.increment_run_counter("infermodel", "failed")
                raise
    finally:
        if state is not None:
            state.finish_run("infermodel")

    run_stats = state.run_stats("infermodel") if state is not None else {}
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
