from __future__ import annotations

from datetime import datetime, timezone

from .merger import PlotSegmentMerger, _BoundaryStats
from .schemas import ChapterSynopsis
from .summarizer import PlotWindowAnalyzer
from .windowing import SlidingWindowPlanner


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

    def process_book(self, feature_book: dict) -> dict:
        book_index = feature_book.get("index") or {}
        chapter_payloads = feature_book.get("chapters") or []
        chapters = [ChapterSynopsis.from_feature_payload(chapter_payload) for chapter_payload in chapter_payloads]
        chapters = sorted(chapters, key=lambda item: item.order)
        order_to_chapter = {chapter.order: chapter for chapter in chapters}
        windows = self.window_planner.build_windows(chapters)
        window_results = [self.window_analyzer.analyze_window(window, mode="initial") for window in windows]
        plots, boundary_debug = self.merger.merge(
            chapters,
            window_results,
            analyzer=self.window_analyzer,
        )
        plots, refinement_debug = self._refine_long_plots(plots, order_to_chapter)
        self._renumber_plots(plots)
        self._annotate_plot_quality(plots, order_to_chapter)

        plot_manifest = [
            {
                "plot_id": plot.plot_id,
                "plot_index": plot.plot_index,
                "start_order": plot.start_order,
                "end_order": plot.end_order,
                "chapter_count": len(plot.chapter_orders),
                "boundary_quality": plot.boundary_quality,
                "summary_coverage_quality": plot.summary_coverage_quality,
                "chapter_ids": plot.chapter_ids,
                "chapter_titles": plot.chapter_titles,
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
            "plot_extraction_config": {
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
                "max_plot_chapters": self.max_plot_chapters,
                "max_refinement_rounds": self.max_refinement_rounds,
                "refinement_window_size": self.refinement_window_planner.window_size,
                "refinement_window_overlap": self.refinement_window_planner.window_overlap,
                "refinement_min_window_size": self.refinement_window_planner.min_window_size,
                "boundary_debug": boundary_debug,
                "refinement_debug": refinement_debug,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
            "cluster_config": {
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
                "max_plot_chapters": self.max_plot_chapters,
                "max_refinement_rounds": self.max_refinement_rounds,
                "refinement_window_size": self.refinement_window_planner.window_size,
                "refinement_window_overlap": self.refinement_window_planner.window_overlap,
                "refinement_min_window_size": self.refinement_window_planner.min_window_size,
                "boundary_debug": boundary_debug,
                "refinement_debug": refinement_debug,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
        }

    def _refine_long_plots(self, plots, order_to_chapter: dict[int, ChapterSynopsis], *, depth: int = 1):
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
            refinement_results = [
                self.window_analyzer.analyze_window(window, mode="refine")
                for window in refinement_windows
            ]
            candidate_plots, candidate_boundary_debug = self.merger.merge(
                plot_chapters,
                refinement_results,
                analyzer=self.window_analyzer,
            )

            if len(candidate_plots) <= 1:
                forced_plots, forced_debug = self._force_split_long_plot(
                    plot,
                    plot_chapters,
                    refinement_results,
                    candidate_boundary_debug,
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
            nested_plots, nested_debug = self._refine_long_plots(refined_plots, order_to_chapter, depth=depth + 1)
            return nested_plots, refinement_debug + nested_debug
        return refined_plots, refinement_debug

    def _force_split_long_plot(
        self,
        plot,
        plot_chapters: list[ChapterSynopsis],
        refinement_results,
        candidate_boundary_debug: dict[int, dict[str, float]],
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

            best_choice = None
            for boundary_index in candidate_indexes:
                boundary_order = chapter_orders[boundary_index]
                left_slice = plot_chapters[max(start_index, boundary_index - 3):boundary_index + 1]
                right_slice = plot_chapters[boundary_index + 1:min(len(plot_chapters), boundary_index + 5)]
                assessment = self.window_analyzer.assess_boundary(left_slice, right_slice)
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
                candidate_info = {
                    "boundary_order": boundary_order,
                    "boundary_index": boundary_index,
                    "score": round(score, 6),
                    "support": round(support, 6),
                    "hard_votes": hard_votes,
                    "strong_votes": strong_votes,
                    "forbid_votes": forbid_votes,
                    "assessment": assessment,
                }
                boundary_details.append(candidate_info)
                if best_choice is None or candidate_info["score"] > best_choice["score"]:
                    best_choice = candidate_info

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
        forced_plots = []
        current_orders: list[int] = []
        for order in chapter_orders:
            current_orders.append(order)
            if order in selected_boundary_set:
                forced_plots.append(
                    self.merger._build_plot(
                        len(forced_plots) + 1,
                        current_orders,
                        order_to_chapter,
                        boundary_stats,
                        refinement_results,
                        self.window_analyzer,
                    )
                )
                current_orders = []
        if current_orders:
            forced_plots.append(
                self.merger._build_plot(
                    len(forced_plots) + 1,
                    current_orders,
                    order_to_chapter,
                    boundary_stats,
                    refinement_results,
                    self.window_analyzer,
                )
            )

        return forced_plots, {
            "selected_boundaries": selected_boundaries,
            "candidate_checks": boundary_details,
        }

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
