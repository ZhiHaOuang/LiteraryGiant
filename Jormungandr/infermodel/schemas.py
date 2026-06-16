from __future__ import annotations

from dataclasses import asdict, dataclass, field

from shared import (
    _as_bool,
    _as_float,
    _as_int,
    _as_list,
    _as_mapping,
    _as_text,
    _dedupe_items,
    EMPTY_LIKE_STRINGS,
)


@dataclass(slots=True)
class ChapterSynopsis:
    chapter_id: str = ""
    order: int = 0
    title: str = ""
    summary: str = ""
    detailed_summary: str = ""
    detailed_summary_points: list[str] = field(default_factory=list)
    source_file: str = ""

    @classmethod
    def from_feature_payload(cls, payload: dict) -> "ChapterSynopsis":
        payload = _as_mapping(payload)
        chapter_context = _as_mapping(payload.get("chapter_context"))
        semantic = _as_mapping(payload.get("semantic_features"))
        source_ref = _as_mapping(payload.get("source_ref"))
        summary = _as_text(semantic.get("summary"))
        detailed_points = _as_list(semantic.get("detailed_summary"))
        detailed_summary = "；".join(detailed_points) if detailed_points else summary
        return cls(
            chapter_id=_as_text(chapter_context.get("chapter_id")),
            order=_as_int(chapter_context.get("order")) or 0,
            title=_as_text(chapter_context.get("clean_title") or chapter_context.get("raw_title")),
            summary=summary,
            detailed_summary=detailed_summary,
            detailed_summary_points=detailed_points,
            source_file=_as_text(source_ref.get("chapter_file") or chapter_context.get("source_file")),
        )

    def to_window_block(self, *, max_detail_points: int = 6, include_detailed: bool = True) -> str:
        lines = [
            f"章节序号: {self.order}",
            f"标题: {self.title or '未知标题'}",
            f"摘要: {self.summary or '无'}",
        ]
        if include_detailed:
            detail_points = self.detailed_summary_points[:max_detail_points]
            detail_text = "；".join(detail_points) if detail_points else (self.detailed_summary or "无")
            lines.append(f"详细摘要: {detail_text or '无'}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class PlotWindow:
    window_id: str = ""
    window_index: int = 0
    start_order: int = 0
    end_order: int = 0
    chapter_orders: list[int] = field(default_factory=list)
    chapters: list[ChapterSynopsis] = field(default_factory=list)

    def to_prompt_text(self, *, max_detail_points: int = 6, include_detailed: bool = True) -> str:
        return "\n\n".join(
            chapter.to_window_block(max_detail_points=max_detail_points, include_detailed=include_detailed)
            for chapter in self.chapters
        )

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["chapters"] = [chapter.to_dict() for chapter in self.chapters]
        return payload


@dataclass(slots=True)
class LocalPlotSegment:
    local_segment_id: str = ""
    start_order: int = 0
    end_order: int = 0
    chapter_orders: list[int] = field(default_factory=list)
    summary: str = ""
    detailed_summary: str = ""
    segment_level: str = ""
    uncertain_boundary_before: bool = False
    uncertain_boundary_after: bool = False
    uncertainty_notes: list[str] = field(default_factory=list)
    source_window_ids: list[str] = field(default_factory=list)
    confidence: float | None = None

    @classmethod
    def from_dict(cls, payload: dict, *, fallback_id: str = "") -> "LocalPlotSegment":
        payload = _as_mapping(payload)
        chapter_orders = sorted({_as_int(item) or 0 for item in payload.get("chapter_orders", []) if _as_int(item) is not None})
        start_order = _as_int(payload.get("start_order")) or (chapter_orders[0] if chapter_orders else 0)
        end_order = _as_int(payload.get("end_order")) or (chapter_orders[-1] if chapter_orders else start_order)
        return cls(
            local_segment_id=_as_text(payload.get("local_segment_id")) or fallback_id,
            start_order=start_order,
            end_order=end_order,
            chapter_orders=chapter_orders,
            summary=_as_text(payload.get("summary")),
            detailed_summary=_as_text(payload.get("detailed_summary")),
            segment_level=_as_text(payload.get("segment_level")).lower(),
            uncertain_boundary_before=_as_bool(payload.get("uncertain_boundary_before")),
            uncertain_boundary_after=_as_bool(payload.get("uncertain_boundary_after")),
            uncertainty_notes=_as_list(payload.get("uncertainty_notes")),
            source_window_ids=_as_list(payload.get("source_window_ids")),
            confidence=_as_float(payload.get("confidence")),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class WindowAnalysis:
    window_id: str = ""
    window_index: int = 0
    start_order: int = 0
    end_order: int = 0
    chapter_orders: list[int] = field(default_factory=list)
    segments: list[LocalPlotSegment] = field(default_factory=list)
    uncertain_boundaries: list[dict] = field(default_factory=list)
    candidate_boundaries: list[dict] = field(default_factory=list)
    analysis_status: str = "api"
    analysis_error: str = ""

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["segments"] = [segment.to_dict() for segment in self.segments]
        return payload


@dataclass(slots=True)
class GlobalPlot:
    plot_id: str = ""
    plot_index: int = 0
    start_order: int = 0
    end_order: int = 0
    chapter_orders: list[int] = field(default_factory=list)
    chapter_ids: list[str] = field(default_factory=list)
    chapter_titles: list[str] = field(default_factory=list)
    chapter_summaries: list[dict] = field(default_factory=list)
    summary: str = ""
    detailed_summary: str = ""
    boundary_quality: float | None = None
    summary_coverage_quality: float | None = None
    source_window_ids: list[str] = field(default_factory=list)
    supporting_local_segments: list[dict] = field(default_factory=list)
    plot_function: list[str] = field(default_factory=list)
    driving_force: list[str] = field(default_factory=list)
    key_events: list[dict] = field(default_factory=list)
    characters_involved: list[dict] = field(default_factory=list)
    relationship_changes: list[dict] = field(default_factory=list)
    conflict_model: dict = field(default_factory=dict)
    payoff_and_hook: dict = field(default_factory=dict)
    setup_and_resolution: dict = field(default_factory=dict)
    abstraction_hint: dict = field(default_factory=dict)
    boundary_vote_before: float | None = None
    boundary_vote_after: float | None = None
    confidence: float | None = None

    def to_dict(self) -> dict:
        chapter_count = len(self.chapter_orders)
        return {
            "plot_id": self.plot_id,
            "plot_index": self.plot_index,
            "start_order": self.start_order,
            "end_order": self.end_order,
            "chapter_count": chapter_count,
            "chapter_orders": list(self.chapter_orders),
            "summary": self.summary,
            "detailed_summary": self.detailed_summary,
            "plot_function": list(self.plot_function),
            "driving_force": list(self.driving_force),
            "key_events": list(self.key_events),
            "characters_involved": list(self.characters_involved),
            "relationship_changes": list(self.relationship_changes),
            "conflict_model": dict(self.conflict_model),
            "payoff_and_hook": dict(self.payoff_and_hook),
            "setup_and_resolution": dict(self.setup_and_resolution),
            "abstraction_hint": dict(self.abstraction_hint),
            "plot_synopsis": {
                "what_happens": self.summary,
                "detailed_progression": self.detailed_summary,
                "plot_function": list(self.plot_function),
                "driving_force": list(self.driving_force),
                "key_events": list(self.key_events),
                "characters_involved": list(self.characters_involved),
                "relationship_changes": list(self.relationship_changes),
                "conflict_model": dict(self.conflict_model),
                "payoff_and_hook": dict(self.payoff_and_hook),
                "setup_and_resolution": dict(self.setup_and_resolution),
                "abstraction_hint": dict(self.abstraction_hint),
                "start_order": self.start_order,
                "end_order": self.end_order,
                "chapter_count": chapter_count,
            },
            "cluster": {
                "cluster_id": self.plot_id,
                "cluster_index": self.plot_index,
                "method": "overlapping_window_boundary_vote",
                "start_order": self.start_order,
                "end_order": self.end_order,
                "chapter_count": chapter_count,
                "chapter_orders": list(self.chapter_orders),
                "chapter_ids": list(self.chapter_ids),
                "chapter_titles": list(self.chapter_titles),
                "source_window_ids": list(self.source_window_ids),
                "supporting_local_segments": list(self.supporting_local_segments),
                "boundary_vote_before": self.boundary_vote_before,
                "boundary_vote_after": self.boundary_vote_after,
                "boundary_quality": self.boundary_quality,
                "summary_coverage_quality": self.summary_coverage_quality,
                "confidence": self.confidence,
            },
            "boundary_quality": self.boundary_quality,
            "summary_coverage_quality": self.summary_coverage_quality,
            "chapter_ids": list(self.chapter_ids),
            "chapter_titles": list(self.chapter_titles),
            "chapter_summaries": list(self.chapter_summaries),
            "source_window_ids": list(self.source_window_ids),
            "supporting_local_segments": list(self.supporting_local_segments),
            "boundary_vote_before": self.boundary_vote_before,
            "boundary_vote_after": self.boundary_vote_after,
            "confidence": self.confidence,
        }
