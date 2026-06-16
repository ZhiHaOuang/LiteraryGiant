from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .schemas import ChapterSynopsis, GlobalPlot, LocalPlotSegment, WindowAnalysis


@dataclass(slots=True)
class _BoundaryStats:
    opportunities: int = 0
    positive_votes: float = 0.0
    hard_votes: int = 0
    strong_votes: int = 0
    weak_votes: int = 0
    forbid_votes: int = 0
    boundary_types: set[str] = None

    @property
    def support(self) -> float:
        if self.opportunities <= 0:
            return 0.0
        return self.positive_votes / self.opportunities

    def __post_init__(self) -> None:
        if self.boundary_types is None:
            self.boundary_types = set()


class PlotSegmentMerger:
    def __init__(
        self,
        *,
        boundary_vote_threshold: float = 0.55,
        strong_boundary_threshold: float = 0.8,
        min_boundary_votes: int = 2,
    ) -> None:
        self.boundary_vote_threshold = float(boundary_vote_threshold)
        self.strong_boundary_threshold = float(strong_boundary_threshold)
        self.min_boundary_votes = max(1, int(min_boundary_votes))

    def merge(
        self,
        chapters: list[ChapterSynopsis],
        window_results: list[WindowAnalysis],
        *,
        analyzer=None,
        max_workers: int = 1,
    ) -> tuple[list[GlobalPlot], dict[int, dict[str, float]]]:
        ordered_chapters = sorted(chapters, key=lambda item: item.order)
        if not ordered_chapters:
            return [], {}

        chapter_orders = [chapter.order for chapter in ordered_chapters]
        order_to_chapter = {chapter.order: chapter for chapter in ordered_chapters}
        boundary_stats = self._collect_boundary_votes(window_results)
        selected_boundaries, validation_debug = self._select_boundaries(
            boundary_stats,
            ordered_chapters,
            analyzer=analyzer,
            max_workers=max_workers,
        )

        plot_order_groups: list[list[int]] = []
        current_orders: list[int] = []
        for order in chapter_orders:
            current_orders.append(order)
            if order in selected_boundaries:
                plot_order_groups.append(current_orders)
                current_orders = []
        if current_orders:
            plot_order_groups.append(current_orders)

        build_args = [
            (index, orders)
            for index, orders in enumerate(plot_order_groups, start=1)
        ]
        if max_workers > 1 and len(build_args) > 1:
            with ThreadPoolExecutor(max_workers=min(max_workers, len(build_args))) as executor:
                plots = list(
                    executor.map(
                        lambda item: self._build_plot(
                            item[0],
                            item[1],
                            order_to_chapter,
                            boundary_stats,
                            window_results,
                            analyzer,
                        ),
                        build_args,
                    )
                )
        else:
            plots = [
                self._build_plot(
                    index,
                    orders,
                    order_to_chapter,
                    boundary_stats,
                    window_results,
                    analyzer,
                )
                for index, orders in build_args
            ]

        boundary_debug = {
            boundary: {
                "opportunities": stats.opportunities,
                "positive_votes": round(stats.positive_votes, 6),
                "support": round(stats.support, 6),
                "hard_votes": stats.hard_votes,
                "strong_votes": stats.strong_votes,
                "weak_votes": stats.weak_votes,
                "forbid_votes": stats.forbid_votes,
                "boundary_types": sorted(stats.boundary_types),
                "selected": boundary in selected_boundaries,
                "validation": validation_debug.get(boundary),
            }
            for boundary, stats in sorted(boundary_stats.items())
        }
        return plots, boundary_debug

    def _collect_boundary_votes(self, window_results: list[WindowAnalysis]) -> dict[int, _BoundaryStats]:
        stats: dict[int, _BoundaryStats] = {}
        for window in window_results:
            for left, _right in zip(window.chapter_orders, window.chapter_orders[1:]):
                stats.setdefault(left, _BoundaryStats()).opportunities += 1

            segments = sorted(window.segments, key=lambda item: (item.start_order, item.end_order))
            for index, segment in enumerate(segments[:-1]):
                boundary = segment.end_order
                weight = 0.5 if segment.uncertain_boundary_after else 0.75
                if segment.segment_level in {"setup", "transition"}:
                    weight *= 0.65
                next_segment = segments[index + 1]
                if next_segment.uncertain_boundary_before:
                    weight *= 0.5
                stats.setdefault(boundary, _BoundaryStats()).positive_votes += weight

            for candidate in window.candidate_boundaries:
                boundary = int(candidate["boundary_after"])
                strength = str(candidate.get("strength") or "weak")
                should_split = bool(candidate.get("should_split", True))
                boundary_type = str(candidate.get("boundary_type") or "other")
                current = stats.setdefault(boundary, _BoundaryStats())
                current.boundary_types.add(boundary_type)
                if strength == "hard":
                    current.hard_votes += 1
                    if should_split:
                        current.positive_votes += 1.5
                elif strength == "strong":
                    current.strong_votes += 1
                    if should_split:
                        current.positive_votes += 1.0
                elif strength == "forbid":
                    current.forbid_votes += 1
                else:
                    current.weak_votes += 1
                    if should_split:
                        current.positive_votes += 0.5

            for item in window.uncertain_boundaries:
                left_order = int(item["left_order"])
                stats.setdefault(left_order, _BoundaryStats()).positive_votes += 0.25
        return stats

    def _select_boundaries(
        self,
        boundary_stats: dict[int, _BoundaryStats],
        ordered_chapters: list[ChapterSynopsis],
        *,
        analyzer=None,
        max_workers: int = 1,
    ) -> tuple[set[int], dict[int, dict]]:
        selected: set[int] = set()
        validation_debug: dict[int, dict] = {}
        order_to_index = {chapter.order: index for index, chapter in enumerate(ordered_chapters)}

        if analyzer is not None:
            candidate_boundaries = [
                boundary
                for boundary, stats in boundary_stats.items()
                if (
                    boundary in order_to_index
                    and boundary + 1 in order_to_index
                    and self._should_validate_boundary(stats)
                )
            ]

            def validate(boundary: int) -> tuple[int, dict]:
                return boundary, self._validate_boundary(boundary, ordered_chapters, order_to_index, analyzer)

            if max_workers > 1 and len(candidate_boundaries) > 1:
                with ThreadPoolExecutor(max_workers=min(max_workers, len(candidate_boundaries))) as executor:
                    for boundary, validation in executor.map(validate, candidate_boundaries):
                        validation_debug[boundary] = validation
            else:
                for boundary in candidate_boundaries:
                    validation_debug[boundary] = validate(boundary)[1]

        for boundary, stats in boundary_stats.items():
            validation = validation_debug.get(boundary)

            if stats.forbid_votes > max(stats.hard_votes, stats.strong_votes) and (
                validation is None or not validation.get("should_split")
            ):
                continue
            if stats.hard_votes > 0 and stats.forbid_votes == 0:
                selected.add(boundary)
                continue
            if stats.strong_votes > 0 and validation is not None and validation.get("should_split") and validation.get("confidence", 0.0) >= 0.55:
                selected.add(boundary)
                continue
            if stats.positive_votes >= self.min_boundary_votes and stats.support >= self.boundary_vote_threshold:
                if validation is None or validation.get("should_split") or validation.get("confidence", 0.0) >= 0.6:
                    selected.add(boundary)
                    continue
            if stats.support >= self.strong_boundary_threshold and stats.positive_votes >= 1.0:
                if validation is None or validation.get("should_split") or validation.get("confidence", 0.0) >= 0.5:
                    selected.add(boundary)
        return selected, validation_debug

    def _should_validate_boundary(self, stats: _BoundaryStats) -> bool:
        if stats.hard_votes or stats.strong_votes or stats.forbid_votes:
            return True
        if stats.positive_votes >= self.min_boundary_votes:
            return True
        if stats.support >= self.strong_boundary_threshold and stats.positive_votes >= 1.0:
            return True
        if stats.weak_votes and stats.support >= max(0.2, self.boundary_vote_threshold * 0.5):
            return True
        return False

    def _validate_boundary(
        self,
        boundary: int,
        ordered_chapters: list[ChapterSynopsis],
        order_to_index: dict[int, int],
        analyzer,
    ) -> dict:
        boundary_index = order_to_index[boundary]
        left_start = max(0, boundary_index - 4)
        right_end = min(len(ordered_chapters), boundary_index + 1 + 5)
        left_chapters = ordered_chapters[left_start:boundary_index + 1]
        right_chapters = ordered_chapters[boundary_index + 1:right_end]
        if not left_chapters or not right_chapters:
            return {
                "should_split": False,
                "confidence": 0.0,
                "reason": "insufficient_context",
            }
        return analyzer.assess_boundary(left_chapters, right_chapters)

    def _build_plot(
        self,
        plot_index: int,
        chapter_orders: list[int],
        order_to_chapter: dict[int, ChapterSynopsis],
        boundary_stats: dict[int, _BoundaryStats],
        window_results: list[WindowAnalysis],
        analyzer,
    ) -> GlobalPlot:
        chapters = [order_to_chapter[order] for order in chapter_orders]
        plot = GlobalPlot(
            plot_id=f"plot{plot_index}",
            plot_index=plot_index,
            start_order=chapter_orders[0],
            end_order=chapter_orders[-1],
            chapter_orders=chapter_orders,
            chapter_ids=[chapter.chapter_id for chapter in chapters if chapter.chapter_id],
            chapter_titles=[chapter.title for chapter in chapters if chapter.title],
            chapter_summaries=[
                {
                    "chapter_id": chapter.chapter_id,
                    "title": chapter.title,
                    "summary": chapter.summary,
                }
                for chapter in chapters
            ],
        )

        supporting_segments = self._collect_supporting_segments(plot, window_results)
        plot.source_window_ids = sorted({window_id for segment in supporting_segments for window_id in segment.source_window_ids})
        plot.supporting_local_segments = [
            {
                "local_segment_id": segment.local_segment_id,
                "start_order": segment.start_order,
                "end_order": segment.end_order,
                "source_window_ids": segment.source_window_ids,
            }
            for segment in supporting_segments
        ]
        before_stats = boundary_stats.get(plot.start_order - 1)
        after_stats = boundary_stats.get(plot.end_order)
        plot.boundary_vote_before = round(before_stats.support, 6) if before_stats is not None else None
        plot.boundary_vote_after = round(after_stats.support, 6) if after_stats is not None else None

        if analyzer is not None:
            plot_payload = analyzer.fuse_plot_summaries(
                plot,
                chapters,
                supporting_segments=supporting_segments,
            )
            summary = plot_payload.get("summary", "")
            detailed_summary = plot_payload.get("detailed_summary", "")
            plot.plot_function = list(plot_payload.get("plot_function") or [])
            plot.driving_force = list(plot_payload.get("driving_force") or [])
            plot.key_events = list(plot_payload.get("key_events") or [])
            plot.characters_involved = list(plot_payload.get("characters_involved") or [])
            plot.relationship_changes = list(plot_payload.get("relationship_changes") or [])
            plot.conflict_model = dict(plot_payload.get("conflict_model") or {})
            plot.payoff_and_hook = dict(plot_payload.get("payoff_and_hook") or {})
            plot.setup_and_resolution = dict(plot_payload.get("setup_and_resolution") or {})
            plot.abstraction_hint = dict(plot_payload.get("abstraction_hint") or {})
        else:
            summary, detailed_summary = self._fallback_plot_text(chapters)
        plot.summary = summary
        plot.detailed_summary = detailed_summary

        confidences = [segment.confidence for segment in supporting_segments if segment.confidence is not None]
        if confidences:
            plot.confidence = round(sum(confidences) / len(confidences), 6)
        elif plot.boundary_vote_before is not None or plot.boundary_vote_after is not None:
            values = [value for value in [plot.boundary_vote_before, plot.boundary_vote_after] if value is not None]
            plot.confidence = round(sum(values) / len(values), 6) if values else None
        return plot

    def _collect_supporting_segments(self, plot: GlobalPlot, window_results: list[WindowAnalysis]) -> list[LocalPlotSegment]:
        supporting: list[tuple[tuple[int, int, str], LocalPlotSegment]] = []
        plot_set = set(plot.chapter_orders)
        for window in window_results:
            best_segment = None
            best_score = -1.0
            for segment in window.segments:
                overlap = plot_set & set(segment.chapter_orders)
                if not overlap:
                    continue
                overlap_ratio = len(overlap) / max(len(plot_set | set(segment.chapter_orders)), 1)
                if overlap_ratio > best_score:
                    best_score = overlap_ratio
                    best_segment = segment
            if best_segment is not None:
                key = (best_segment.start_order, best_segment.end_order, best_segment.local_segment_id)
                supporting.append((key, best_segment))
        supporting.sort(key=lambda item: item[0])
        return [segment for _key, segment in supporting]

    @staticmethod
    def _fallback_plot_text(chapters: list[ChapterSynopsis]) -> tuple[str, str]:
        summary = " ".join(chapter.summary for chapter in chapters if chapter.summary)[:200].strip()
        detailed = " ".join(chapter.detailed_summary for chapter in chapters if chapter.detailed_summary)[:500].strip()
        return summary, detailed or summary
