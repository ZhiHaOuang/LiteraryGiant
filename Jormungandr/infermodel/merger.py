from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .schemas import ChapterSynopsis, GlobalPlot, LocalPlotSegment, WindowAnalysis


_SupportingSegmentIndex = dict[int, list[tuple[str, int, LocalPlotSegment]]]


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
        boundary_validation_mode: str = "off",
    ) -> None:
        self.boundary_vote_threshold = float(boundary_vote_threshold)
        self.strong_boundary_threshold = float(strong_boundary_threshold)
        self.min_boundary_votes = max(1, int(min_boundary_votes))
        normalized_mode = str(boundary_validation_mode or "off").strip().lower()
        if normalized_mode not in {"off", "gray", "full"}:
            raise ValueError("boundary_validation_mode must be one of: off, gray, full")
        self.boundary_validation_mode = normalized_mode

    def merge(
        self,
        chapters: list[ChapterSynopsis],
        window_results: list[WindowAnalysis],
        *,
        analyzer=None,
        max_workers: int = 1,
        checkpoint=None,
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
            checkpoint=checkpoint,
        )
        supporting_segment_index = self._build_supporting_segment_index(window_results)

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

        def build_plot(item: tuple[int, list[int]]) -> GlobalPlot:
            plot_index, orders = item
            if checkpoint is not None:
                cached_plot = checkpoint.load_plot_for_orders(orders)
                if cached_plot is not None:
                    cached_plot.plot_index = plot_index
                    cached_plot.plot_id = f"plot{plot_index}"
                    return cached_plot
            built_plot = self._build_plot(
                plot_index,
                orders,
                order_to_chapter,
                boundary_stats,
                window_results,
                supporting_segment_index,
                analyzer,
            )
            if checkpoint is not None:
                checkpoint.write_plot_for_orders(built_plot)
            return built_plot

        if max_workers > 1 and len(build_args) > 1:
            with ThreadPoolExecutor(max_workers=min(max_workers, len(build_args))) as executor:
                plots = list(executor.map(build_plot, build_args))
        else:
            plots = [build_plot(item) for item in build_args]

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
        checkpoint=None,
    ) -> tuple[set[int], dict[int, dict]]:
        selected: set[int] = set()
        validation_debug: dict[int, dict] = {}
        order_to_index = {chapter.order: index for index, chapter in enumerate(ordered_chapters)}

        if analyzer is not None and self.boundary_validation_mode != "off":
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
                return boundary, self._validate_boundary(
                    boundary,
                    ordered_chapters,
                    order_to_index,
                    analyzer,
                    checkpoint=checkpoint,
                )

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
            if validation is not None and validation.get("should_split") and validation.get("confidence", 0.0) >= 0.7:
                selected.add(boundary)
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
        if self.boundary_validation_mode == "off":
            return False
        if self.boundary_validation_mode == "full":
            return self._should_validate_boundary_full(stats)
        if self._has_boundary_vote_conflict(stats):
            return True
        if self._is_high_confidence_boundary(stats):
            return False
        if stats.forbid_votes:
            return False
        if stats.strong_votes == 1:
            return stats.support < self.boundary_vote_threshold or stats.positive_votes < self.min_boundary_votes
        if stats.weak_votes:
            gray_support = max(0.3, self.boundary_vote_threshold * 0.75)
            return stats.support >= gray_support and stats.positive_votes >= 0.75
        if stats.positive_votes >= self.min_boundary_votes:
            return stats.support < self.boundary_vote_threshold
        return False

    def _should_validate_boundary_full(self, stats: _BoundaryStats) -> bool:
        if stats.hard_votes or stats.strong_votes or stats.forbid_votes:
            return True
        if stats.positive_votes >= self.min_boundary_votes:
            return True
        if stats.support >= self.strong_boundary_threshold and stats.positive_votes >= 1.0:
            return True
        if stats.weak_votes and stats.support >= max(0.2, self.boundary_vote_threshold * 0.5):
            return True
        return False

    def _has_boundary_vote_conflict(self, stats: _BoundaryStats) -> bool:
        if stats.forbid_votes <= 0:
            return False
        if stats.hard_votes or stats.strong_votes:
            return True
        return stats.positive_votes >= self.min_boundary_votes and stats.support >= self.boundary_vote_threshold

    def _is_high_confidence_boundary(self, stats: _BoundaryStats) -> bool:
        if stats.forbid_votes:
            return False
        if stats.hard_votes > 0:
            return True
        if stats.strong_votes >= 2:
            return True
        if stats.strong_votes == 1 and stats.support >= self.boundary_vote_threshold:
            return True
        if stats.positive_votes >= self.min_boundary_votes and stats.support >= self.boundary_vote_threshold:
            return True
        return stats.support >= self.strong_boundary_threshold and stats.positive_votes >= 1.0

    def _validate_boundary(
        self,
        boundary: int,
        ordered_chapters: list[ChapterSynopsis],
        order_to_index: dict[int, int],
        analyzer,
        *,
        checkpoint=None,
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
        left_orders = [chapter.order for chapter in left_chapters]
        right_orders = [chapter.order for chapter in right_chapters]
        if checkpoint is not None:
            cached_assessment = checkpoint.load_boundary_assessment(left_orders, right_orders)
            if cached_assessment is not None:
                return cached_assessment
        assessment = analyzer.assess_boundary(left_chapters, right_chapters)
        if checkpoint is not None:
            checkpoint.write_boundary_assessment(left_orders, right_orders, assessment)
        return assessment

    def _build_plot(
        self,
        plot_index: int,
        chapter_orders: list[int],
        order_to_chapter: dict[int, ChapterSynopsis],
        boundary_stats: dict[int, _BoundaryStats],
        window_results: list[WindowAnalysis],
        supporting_segment_index: _SupportingSegmentIndex | None,
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
            start_ref=chapters[0].source_ref() if chapters else {},
            end_ref=chapters[-1].source_ref() if chapters else {},
            chapter_summaries=[
                {
                    "chapter_id": chapter.chapter_id,
                    "unit_id": chapter.unit_id or chapter.chapter_id,
                    "unit_order": chapter.order,
                    "source_chapter_id": chapter.source_chapter_id or chapter.chapter_id,
                    "source_chapter_order": chapter.source_chapter_order or chapter.order,
                    "unit_order_in_chapter": chapter.unit_order_in_chapter,
                    "title": chapter.title,
                    "summary": chapter.summary,
                }
                for chapter in chapters
            ],
        )

        supporting_segments = self._collect_supporting_segments(
            plot,
            window_results,
            supporting_segment_index=supporting_segment_index,
        )
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

    def _collect_supporting_segments(
        self,
        plot: GlobalPlot,
        window_results: list[WindowAnalysis],
        *,
        supporting_segment_index: _SupportingSegmentIndex | None = None,
    ) -> list[LocalPlotSegment]:
        if supporting_segment_index is not None:
            return self._collect_supporting_segments_from_index(plot, supporting_segment_index)

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
    def _build_supporting_segment_index(window_results: list[WindowAnalysis]) -> _SupportingSegmentIndex:
        index: _SupportingSegmentIndex = {}
        for window in window_results:
            window_id = window.window_id or f"window{window.window_index}"
            for segment_index, segment in enumerate(window.segments):
                for order in segment.chapter_orders:
                    index.setdefault(order, []).append((window_id, segment_index, segment))
        return index

    @staticmethod
    def _collect_supporting_segments_from_index(
        plot: GlobalPlot,
        supporting_segment_index: _SupportingSegmentIndex,
    ) -> list[LocalPlotSegment]:
        plot_set = set(plot.chapter_orders)
        seen_candidates: set[tuple[str, int, int, str, tuple[int, ...]]] = set()
        best_by_window: dict[str, tuple[float, int, tuple[int, int, str], LocalPlotSegment]] = {}

        for order in plot.chapter_orders:
            for window_id, segment_index, segment in supporting_segment_index.get(order, []):
                candidate_key = (
                    window_id,
                    segment.start_order,
                    segment.end_order,
                    segment.local_segment_id,
                    tuple(segment.chapter_orders),
                )
                if candidate_key in seen_candidates:
                    continue
                seen_candidates.add(candidate_key)
                segment_set = set(segment.chapter_orders)
                overlap = plot_set & segment_set
                if not overlap:
                    continue
                overlap_ratio = len(overlap) / max(len(plot_set | segment_set), 1)
                sort_key = (segment.start_order, segment.end_order, segment.local_segment_id)
                previous = best_by_window.get(window_id)
                if previous is None or overlap_ratio > previous[0] or (
                    overlap_ratio == previous[0] and segment_index < previous[1]
                ):
                    best_by_window[window_id] = (overlap_ratio, segment_index, sort_key, segment)

        supporting = [
            (sort_key, segment)
            for _score, _segment_index, sort_key, segment in best_by_window.values()
        ]
        supporting.sort(key=lambda item: item[0])
        return [segment for _key, segment in supporting]

    @staticmethod
    def _fallback_plot_text(chapters: list[ChapterSynopsis]) -> tuple[str, str]:
        summary = " ".join(chapter.summary for chapter in chapters if chapter.summary)[:200].strip()
        detailed = " ".join(chapter.detailed_summary for chapter in chapters if chapter.detailed_summary)[:500].strip()
        return summary, detailed or summary
