from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Callable, TypeVar

from .merger import PlotSegmentMerger, _BoundaryStats
from .schemas import ChapterSynopsis
from .summarizer import PlotWindowAnalyzer
from .windowing import SlidingWindowPlanner

T = TypeVar("T")
R = TypeVar("R")


class InferModelPipeline:
    def __init__(
        self,
        *,
        window_planner: SlidingWindowPlanner | None = None,
        window_analyzer: PlotWindowAnalyzer | None = None,
        merger: PlotSegmentMerger | None = None,
        refinement_window_planner: SlidingWindowPlanner | None = None,
        max_plot_chapters: int = 24,
        max_refinement_rounds: int = 2,
        max_workers: int = 6,
        fallback_retry_rounds: int = 1,
    ) -> None:
        self.window_planner = window_planner or SlidingWindowPlanner()
        self.window_analyzer = window_analyzer or PlotWindowAnalyzer()
        self.merger = merger or PlotSegmentMerger()
        self.refinement_window_planner = refinement_window_planner or SlidingWindowPlanner(
            window_size=32,
            window_overlap=12,
            min_window_size=10,
        )
        self.max_plot_chapters = max(12, int(max_plot_chapters))
        self.max_refinement_rounds = max(1, int(max_refinement_rounds))
        self.max_workers = max(1, int(max_workers))
        self.fallback_retry_rounds = max(0, int(fallback_retry_rounds))

    def process_book(self, feature_book: dict, *, checkpoint=None) -> dict:
        book_index = feature_book.get("index") or {}
        chapter_payloads = feature_book.get("chapters") or []
        chapters = [ChapterSynopsis.from_feature_payload(chapter_payload) for chapter_payload in chapter_payloads]
        chapters = sorted(chapters, key=lambda item: item.order)
        order_to_chapter = {chapter.order: chapter for chapter in chapters}
        inference_metadata = self._inference_metadata()
        if checkpoint is not None:
            checkpoint.configure(self._checkpoint_context(feature_book, chapters, inference_metadata))
            checkpoint.update_state(status="started", stage="window_analysis")
        windows = self.window_planner.build_windows(chapters)
        window_results = self._analyze_windows(windows, mode="initial", checkpoint=checkpoint)
        if checkpoint is not None:
            checkpoint.update_state(
                status="running",
                stage="plot_merge",
                window_count=len(windows),
                completed_windows=len(window_results),
            )
        plots, boundary_debug = self.merger.merge(
            chapters,
            window_results,
            analyzer=self.window_analyzer,
            max_workers=self.max_workers,
            checkpoint=checkpoint,
        )
        plots, refinement_debug = self._refine_long_plots(plots, order_to_chapter, checkpoint=checkpoint)
        self._renumber_plots(plots)
        self._annotate_plot_quality(plots, order_to_chapter)
        for plot in plots:
            plot.inference_metadata = dict(inference_metadata)
            if checkpoint is not None:
                checkpoint.write_plot_for_orders(plot)
        if checkpoint is not None:
            checkpoint.update_state(
                status="running",
                stage="finalize",
                plot_count=len(plots),
                completed_plots=len(plots),
            )

        plot_manifest = [
            {
                "plot_id": plot.plot_id,
                "plot_index": plot.plot_index,
                "start_order": plot.start_order,
                "end_order": plot.end_order,
                "start_ref": dict(plot.start_ref),
                "end_ref": dict(plot.end_ref),
                "chapter_count": len(plot.chapter_orders),
                "cluster_id": plot.plot_id,
                "chapter_orders": list(plot.chapter_orders),
                "boundary_quality": plot.boundary_quality,
                "summary_coverage_quality": plot.summary_coverage_quality,
                "chapter_ids": plot.chapter_ids,
                "chapter_titles": plot.chapter_titles,
                "source_window_ids": plot.source_window_ids,
                "inference_model": inference_metadata["model_name"],
                "inference_provider": inference_metadata["provider"],
                "file_name": f"{plot.plot_id}.json",
            }
            for plot in plots
        ]

        return {
            "book_metadata": book_index.get("book_metadata", {}),
            "source_feature_dir": feature_book.get("book_dir", ""),
            "chapter_manifest": book_index.get("chapter_manifest", []),
            "window_manifest": [
                {
                    "window_id": window.window_id,
                    "window_index": window.window_index,
                    "start_order": window.start_order,
                    "end_order": window.end_order,
                    "chapter_orders": window.chapter_orders,
                }
                for window in windows
            ],
            "window_results": [window_result.to_dict() for window_result in window_results],
            "plot_manifest": plot_manifest,
            "plots": [plot.to_dict() for plot in plots],
            "cluster_manifest": plot_manifest,
            "inference_metadata": inference_metadata,
            "plot_extraction_config": {
                "inference_metadata": inference_metadata,
                "strategy": "overlapping sliding windows + LLM API segmentation + boundary voting merge",
                "window_size": self.window_planner.window_size,
                "window_overlap": self.window_planner.window_overlap,
                "min_window_size": self.window_planner.min_window_size,
                "api_model": self.window_analyzer.model_name,
                "api_base_url": self.window_analyzer.resolved_model_source or self.window_analyzer.model_name,
                "max_window_input_chars": self.window_analyzer.max_window_input_chars,
                "max_fusion_input_chars": self.window_analyzer.max_fusion_input_chars,
                "max_new_tokens": self.window_analyzer.max_new_tokens,
                "boundary_vote_threshold": self.merger.boundary_vote_threshold,
                "strong_boundary_threshold": self.merger.strong_boundary_threshold,
                "min_boundary_votes": self.merger.min_boundary_votes,
                "boundary_validation_mode": self.merger.boundary_validation_mode,
                "max_plot_chapters": self.max_plot_chapters,
                "max_refinement_rounds": self.max_refinement_rounds,
                "max_workers": self.max_workers,
                "fallback_retry_rounds": self.fallback_retry_rounds,
                "refinement_window_size": self.refinement_window_planner.window_size,
                "refinement_window_overlap": self.refinement_window_planner.window_overlap,
                "refinement_min_window_size": self.refinement_window_planner.min_window_size,
                "boundary_debug": boundary_debug,
                "refinement_debug": refinement_debug,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "checkpoint": self._checkpoint_metadata(checkpoint),
            },
            "cluster_config": {
                "inference_metadata": inference_metadata,
                "strategy": "overlapping sliding windows + LLM API segmentation + boundary voting merge",
                "window_size": self.window_planner.window_size,
                "window_overlap": self.window_planner.window_overlap,
                "min_window_size": self.window_planner.min_window_size,
                "api_model": self.window_analyzer.model_name,
                "api_base_url": self.window_analyzer.resolved_model_source or self.window_analyzer.model_name,
                "max_window_input_chars": self.window_analyzer.max_window_input_chars,
                "max_fusion_input_chars": self.window_analyzer.max_fusion_input_chars,
                "max_new_tokens": self.window_analyzer.max_new_tokens,
                "boundary_vote_threshold": self.merger.boundary_vote_threshold,
                "strong_boundary_threshold": self.merger.strong_boundary_threshold,
                "min_boundary_votes": self.merger.min_boundary_votes,
                "boundary_validation_mode": self.merger.boundary_validation_mode,
                "max_plot_chapters": self.max_plot_chapters,
                "max_refinement_rounds": self.max_refinement_rounds,
                "max_workers": self.max_workers,
                "fallback_retry_rounds": self.fallback_retry_rounds,
                "refinement_window_size": self.refinement_window_planner.window_size,
                "refinement_window_overlap": self.refinement_window_planner.window_overlap,
                "refinement_min_window_size": self.refinement_window_planner.min_window_size,
                "boundary_debug": boundary_debug,
                "refinement_debug": refinement_debug,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "checkpoint": self._checkpoint_metadata(checkpoint),
            },
        }

    def _inference_metadata(self) -> dict:
        return {
            "stage": "infermodel",
            "model_name": self.window_analyzer.model_name,
            "provider": self.window_analyzer.resolved_provider,
            "requested_provider": self.window_analyzer.requested_provider,
            "base_url": self.window_analyzer.resolved_model_source,
            "max_new_tokens": self.window_analyzer.max_new_tokens,
            "temperature": self.window_analyzer.temperature,
            "api_timeout": self.window_analyzer.api_timeout,
            "api_max_retries": self.window_analyzer.api_max_retries,
            "api_user_id": self.window_analyzer.api_user_id,
            "prompt_profile": "plot_segments_v2_structured_json_only",
            "schema_version": "plot_segments.v2",
        }

    def _checkpoint_context(self, feature_book: dict, chapters: list[ChapterSynopsis], inference_metadata: dict) -> dict:
        book_index = feature_book.get("index") or {}
        book_metadata = book_index.get("book_metadata") or {}
        chapter_orders = [chapter.order for chapter in chapters]
        checkpoint_inference_metadata = dict(inference_metadata)
        checkpoint_inference_metadata.pop("api_max_retries", None)
        checkpoint_inference_metadata.pop("api_user_id", None)
        return {
            "stage": "infermodel",
            "schema_version": "plot_segments.v2",
            "source_feature_dir": feature_book.get("book_dir", ""),
            "book_id": book_metadata.get("book_id", ""),
            "chapter_count": len(chapters),
            "first_order": chapter_orders[0] if chapter_orders else 0,
            "last_order": chapter_orders[-1] if chapter_orders else 0,
            "inference_metadata": checkpoint_inference_metadata,
            "window_size": self.window_planner.window_size,
            "window_overlap": self.window_planner.window_overlap,
            "min_window_size": self.window_planner.min_window_size,
            "max_window_input_chars": self.window_analyzer.max_window_input_chars,
            "max_fusion_input_chars": self.window_analyzer.max_fusion_input_chars,
            "boundary_vote_threshold": self.merger.boundary_vote_threshold,
            "strong_boundary_threshold": self.merger.strong_boundary_threshold,
            "min_boundary_votes": self.merger.min_boundary_votes,
            "max_plot_chapters": self.max_plot_chapters,
            "max_refinement_rounds": self.max_refinement_rounds,
            "refinement_window_size": self.refinement_window_planner.window_size,
            "refinement_window_overlap": self.refinement_window_planner.window_overlap,
            "refinement_min_window_size": self.refinement_window_planner.min_window_size,
        }

    @staticmethod
    def _checkpoint_metadata(checkpoint) -> dict:
        if checkpoint is None:
            return {"enabled": False}
        return {
            "enabled": True,
            "path": str(checkpoint.root),
            "context_hash": checkpoint.context_hash,
        }

    def _refine_long_plots(self, plots, order_to_chapter: dict[int, ChapterSynopsis], *, depth: int = 1, checkpoint=None):
        if depth > self.max_refinement_rounds:
            return plots, []

        refined_plots = []
        refinement_debug: list[dict] = []
        changed = False

        for plot in plots:
            chapter_count = len(plot.chapter_orders)
            if chapter_count <= self.max_plot_chapters:
                refined_plots.append(plot)
                continue

            plot_chapters = [order_to_chapter[order] for order in plot.chapter_orders if order in order_to_chapter]
            refinement_windows = self.refinement_window_planner.build_windows(plot_chapters)
            refinement_results = self._analyze_windows(refinement_windows, mode="refine", checkpoint=checkpoint)
            candidate_plots, candidate_boundary_debug = self.merger.merge(
                plot_chapters,
                refinement_results,
                analyzer=self.window_analyzer,
                max_workers=self.max_workers,
                checkpoint=checkpoint,
            )

            if len(candidate_plots) <= 1:
                forced_plots, forced_debug = self._force_split_long_plot(
                    plot,
                    plot_chapters,
                    refinement_results,
                    candidate_boundary_debug,
                    checkpoint=checkpoint,
                )
                if len(forced_plots) > 1:
                    changed = True
                    refined_plots.extend(forced_plots)
                    refinement_debug.append(
                        {
                            "plot_id": plot.plot_id,
                            "depth": depth,
                            "chapter_count": chapter_count,
                            "refined": True,
                            "reason": "forced_boundary_split",
                            "refined_plot_count": len(forced_plots),
                            "refined_ranges": [
                                [candidate.start_order, candidate.end_order]
                                for candidate in forced_plots
                            ],
                            "boundary_debug": candidate_boundary_debug,
                            "forced_debug": forced_debug,
                        }
                    )
                    continue

                refined_plots.append(plot)
                refinement_debug.append(
                    {
                        "plot_id": plot.plot_id,
                        "depth": depth,
                        "chapter_count": chapter_count,
                        "refined": False,
                        "reason": "refinement_kept_single_plot",
                        "forced_debug": forced_debug,
                    }
                )
                continue

            changed = True
            refined_plots.extend(candidate_plots)
            refinement_debug.append(
                {
                    "plot_id": plot.plot_id,
                    "depth": depth,
                    "chapter_count": chapter_count,
                    "refined": True,
                    "refined_plot_count": len(candidate_plots),
                    "refined_ranges": [
                        [candidate.start_order, candidate.end_order]
                        for candidate in candidate_plots
                    ],
                    "boundary_debug": candidate_boundary_debug,
                }
            )

        if changed and depth < self.max_refinement_rounds:
            nested_plots, nested_debug = self._refine_long_plots(refined_plots, order_to_chapter, depth=depth + 1, checkpoint=checkpoint)
            return nested_plots, refinement_debug + nested_debug
        return refined_plots, refinement_debug

    def _force_split_long_plot(
        self,
        plot,
        plot_chapters: list[ChapterSynopsis],
        refinement_results,
        candidate_boundary_debug: dict[int, dict[str, float]],
        *,
        checkpoint=None,
    ):
        if len(plot_chapters) <= self.max_plot_chapters:
            return [plot], {"reason": "plot_not_oversized"}

        chapter_orders = [chapter.order for chapter in plot_chapters]
        order_to_chapter = {chapter.order: chapter for chapter in plot_chapters}
        order_to_index = {order: index for index, order in enumerate(chapter_orders)}
        selected_boundaries: list[int] = []
        boundary_details: list[dict] = []
        start_index = 0

        while len(chapter_orders) - start_index > self.max_plot_chapters:
            target_index = min(len(chapter_orders) - 2, start_index + self.max_plot_chapters - 1)
            min_index = min(len(chapter_orders) - 2, start_index + max(5, self.max_plot_chapters // 2) - 1)
            candidate_indexes = list(range(max(start_index + 2, target_index - 4), min(len(chapter_orders) - 2, target_index + 4) + 1))
            candidate_indexes = [index for index in candidate_indexes if index >= min_index]
            if not candidate_indexes:
                candidate_indexes = [target_index]

            def assess_candidate(boundary_index: int) -> dict:
                boundary_order = chapter_orders[boundary_index]
                left_slice = plot_chapters[max(start_index, boundary_index - 3):boundary_index + 1]
                right_slice = plot_chapters[boundary_index + 1:min(len(plot_chapters), boundary_index + 5)]
                left_orders = [chapter.order for chapter in left_slice]
                right_orders = [chapter.order for chapter in right_slice]
                assessment = None
                if checkpoint is not None:
                    assessment = checkpoint.load_boundary_assessment(left_orders, right_orders)
                if assessment is None:
                    assessment = self.window_analyzer.assess_boundary(left_slice, right_slice)
                    if checkpoint is not None:
                        checkpoint.write_boundary_assessment(left_orders, right_orders, assessment)
                debug_info = candidate_boundary_debug.get(boundary_order) or {}
                support = float(debug_info.get("support", 0.0) or 0.0)
                hard_votes = int(debug_info.get("hard_votes", 0) or 0)
                strong_votes = int(debug_info.get("strong_votes", 0) or 0)
                forbid_votes = int(debug_info.get("forbid_votes", 0) or 0)
                score = float(assessment.get("confidence", 0.0) or 0.0) + support
                score += hard_votes * 1.2
                score += strong_votes * 0.5
                score -= forbid_votes * 0.9
                if assessment.get("should_split"):
                    score += 1.0
                score -= abs(boundary_index - target_index) * 0.03
                return {
                    "boundary_order": boundary_order,
                    "boundary_index": boundary_index,
                    "score": round(score, 6),
                    "support": round(support, 6),
                    "hard_votes": hard_votes,
                    "strong_votes": strong_votes,
                    "forbid_votes": forbid_votes,
                    "assessment": assessment,
                }

            candidate_infos = self._parallel_map(assess_candidate, candidate_indexes)
            boundary_details.extend(candidate_infos)
            best_choice = max(candidate_infos, key=lambda item: item["score"], default=None)

            assert best_choice is not None
            selected_boundaries.append(int(best_choice["boundary_order"]))
            start_index = order_to_index[int(best_choice["boundary_order"])] + 1

        boundary_stats: dict[int, _BoundaryStats] = {}
        for order in chapter_orders[:-1]:
            support = float((candidate_boundary_debug.get(order) or {}).get("support", 0.0) or 0.0)
            opportunities = 1
            positive_votes = support
            if order in selected_boundaries:
                opportunities = 1
                positive_votes = 1.0
            boundary_stats[order] = _BoundaryStats(opportunities=opportunities, positive_votes=positive_votes)

        selected_boundary_set = set(selected_boundaries)
        plot_order_groups: list[list[int]] = []
        current_orders: list[int] = []
        for order in chapter_orders:
            current_orders.append(order)
            if order in selected_boundary_set:
                plot_order_groups.append(current_orders)
                current_orders = []
        if current_orders:
            plot_order_groups.append(current_orders)

        def build_forced_plot(item: tuple[int, list[int]]):
            plot_index, orders = item
            if checkpoint is not None:
                cached_plot = checkpoint.load_plot_for_orders(orders)
                if cached_plot is not None:
                    cached_plot.plot_index = plot_index
                    cached_plot.plot_id = f"plot{plot_index}"
                    return cached_plot
            built_plot = self.merger._build_plot(
                plot_index,
                orders,
                order_to_chapter,
                boundary_stats,
                refinement_results,
                None,
                self.window_analyzer,
            )
            if checkpoint is not None:
                checkpoint.write_plot_for_orders(built_plot)
            return built_plot

        forced_plots = self._parallel_map(
            build_forced_plot,
            [(index, orders) for index, orders in enumerate(plot_order_groups, start=1)],
        )

        return forced_plots, {
            "selected_boundaries": selected_boundaries,
            "candidate_checks": boundary_details,
        }

    def _analyze_windows(self, windows, *, mode: str, checkpoint=None):
        results = [None] * len(windows)
        pending = []
        for index, window in enumerate(windows):
            cached_result = checkpoint.load_window(window, mode=mode) if checkpoint is not None else None
            if cached_result is not None:
                results[index] = cached_result
            else:
                pending.append((index, window))

        def analyze(item):
            index, window = item
            return index, self.window_analyzer.analyze_window(window, mode=mode)

        completed = len(windows) - len(pending)
        if checkpoint is not None:
            checkpoint.update_state(
                status="running",
                stage=f"{mode}_window_analysis",
                completed_windows=completed,
                total_windows=len(windows),
            )

        if self.max_workers <= 1 or len(pending) <= 1:
            for item in pending:
                index, result = analyze(item)
                results[index] = result
                if checkpoint is not None:
                    checkpoint.write_window(result, mode=mode)
                    completed += 1
                    checkpoint.update_state(completed_windows=completed, total_windows=len(windows))
        elif pending:
            with ThreadPoolExecutor(max_workers=min(self.max_workers, len(pending))) as executor:
                future_to_item = {executor.submit(analyze, item): item for item in pending}
                for future in as_completed(future_to_item):
                    index, result = future.result()
                    results[index] = result
                    if checkpoint is not None:
                        checkpoint.write_window(result, mode=mode)
                        completed += 1
                        checkpoint.update_state(completed_windows=completed, total_windows=len(windows))

        self._retry_fallback_windows(windows, results, mode=mode, checkpoint=checkpoint)
        return [result for result in results if result is not None]

    def _retry_fallback_windows(self, windows, results, *, mode: str, checkpoint=None) -> None:
        if self.fallback_retry_rounds <= 0:
            return

        def retry(item):
            index, window = item
            return index, self.window_analyzer.analyze_window(window, mode=mode)

        for retry_round in range(1, self.fallback_retry_rounds + 1):
            fallback_items = [
                (index, windows[index])
                for index, result in enumerate(results)
                if result is not None and getattr(result, "analysis_status", "") == "fallback"
            ]
            if not fallback_items:
                return
            if checkpoint is not None:
                checkpoint.update_state(
                    status="running",
                    stage=f"{mode}_fallback_retry",
                    fallback_retry_round=retry_round,
                    fallback_retry_rounds=self.fallback_retry_rounds,
                    fallback_windows=len(fallback_items),
                    completed_fallback_retries=0,
                )

            completed_retries = 0
            if self.max_workers <= 1 or len(fallback_items) <= 1:
                for item in fallback_items:
                    index, result = retry(item)
                    results[index] = result
                    if checkpoint is not None:
                        checkpoint.write_window(result, mode=mode)
                        completed_retries += 1
                        checkpoint.update_state(
                            completed_fallback_retries=completed_retries,
                            fallback_windows=len(fallback_items),
                        )
            else:
                with ThreadPoolExecutor(max_workers=min(self.max_workers, len(fallback_items))) as executor:
                    future_to_item = {executor.submit(retry, item): item for item in fallback_items}
                    for future in as_completed(future_to_item):
                        index, result = future.result()
                        results[index] = result
                        if checkpoint is not None:
                            checkpoint.write_window(result, mode=mode)
                            completed_retries += 1
                            checkpoint.update_state(
                                completed_fallback_retries=completed_retries,
                                fallback_windows=len(fallback_items),
                            )

    def _parallel_map(self, func: Callable[[T], R], items: list[T]) -> list[R]:
        if self.max_workers <= 1 or len(items) <= 1:
            return [func(item) for item in items]
        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(items))) as executor:
            return list(executor.map(func, items))

    @staticmethod
    def _renumber_plots(plots) -> None:
        for index, plot in enumerate(plots, start=1):
            plot.plot_index = index
            plot.plot_id = f"plot{index}"

    def _annotate_plot_quality(self, plots, order_to_chapter: dict[int, ChapterSynopsis]) -> None:
        for plot in plots:
            chapters = [order_to_chapter[order] for order in plot.chapter_orders if order in order_to_chapter]
            plot.boundary_quality = self._estimate_boundary_quality(plot)
            plot.summary_coverage_quality = self.window_analyzer.assess_summary_coverage(
                chapters,
                plot.summary,
                plot.detailed_summary,
            )
            qualities = [value for value in [plot.boundary_quality, plot.summary_coverage_quality] if value is not None]
            if qualities:
                plot.confidence = round(sum(qualities) / len(qualities), 6)

    def _estimate_boundary_quality(self, plot) -> float:
        chapter_count = len(plot.chapter_orders)
        edge_votes = [value for value in [plot.boundary_vote_before, plot.boundary_vote_after] if value is not None]
        base = (sum(edge_votes) / len(edge_votes)) if edge_votes else 0.35

        if chapter_count == 1:
            base -= 0.1
        elif chapter_count >= 24:
            base -= 0.16
        elif chapter_count >= 16:
            base -= 0.08
        if chapter_count > self.max_plot_chapters:
            base -= 0.22

        if len(edge_votes) == 2 and min(edge_votes) >= 0.75:
            base += 0.1
        elif len(edge_votes) == 1 and edge_votes[0] >= 0.75:
            base += 0.04

        return round(max(0.0, min(1.0, base)), 6)
