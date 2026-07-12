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
    source_chapter_id: str = ""
    source_chapter_order: int = 0
    unit_id: str = ""
    global_unit_order: int = 0
    unit_order_in_chapter: int = 1
    unit_count_in_chapter: int = 1

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
            source_chapter_id=_as_text(chapter_context.get("source_chapter_id") or chapter_context.get("chapter_id")),
            source_chapter_order=(
                _as_int(chapter_context.get("source_chapter_order"))
                or _as_int(chapter_context.get("order"))
                or 0
            ),
            unit_id=_as_text(chapter_context.get("unit_id") or chapter_context.get("chapter_id")),
            global_unit_order=_as_int(chapter_context.get("global_unit_order") or chapter_context.get("order")) or 0,
            unit_order_in_chapter=_as_int(chapter_context.get("unit_order_in_chapter")) or 1,
            unit_count_in_chapter=_as_int(chapter_context.get("unit_count_in_chapter")) or 1,
        )

    def to_window_block(self, *, max_detail_points: int = 6, include_detailed: bool = True) -> str:
        source_label = f"第{self.source_chapter_order or self.order}章"
        if self.unit_count_in_chapter > 1:
            source_label = f"{source_label} / 单元{self.unit_order_in_chapter}/{self.unit_count_in_chapter}"
        lines = [
            f"单元序号: {self.order}",
            f"来源章节: {source_label}",
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

    def source_ref(self) -> dict:
        return {
            "unit_order": self.order,
            "unit_id": self.unit_id or self.chapter_id,
            "chapter_order": self.source_chapter_order or self.order,
            "chapter_id": self.source_chapter_id or self.chapter_id,
            "unit_order_in_chapter": self.unit_order_in_chapter,
        }


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

    @classmethod
    def from_dict(cls, payload: dict) -> "WindowAnalysis":
        payload = _as_mapping(payload)
        raw_orders = payload.get("chapter_orders") or []
        chapter_orders = [
            value
            for value in (_as_int(item) for item in raw_orders)
            if value is not None
        ]
        segments = [
            LocalPlotSegment.from_dict(item, fallback_id=f"{_as_text(payload.get('window_id'))}_segment_{index:02d}")
            for index, item in enumerate(payload.get("segments") or [], start=1)
            if isinstance(item, dict)
        ]
        return cls(
            window_id=_as_text(payload.get("window_id")),
            window_index=_as_int(payload.get("window_index")) or 0,
            start_order=_as_int(payload.get("start_order")) or (chapter_orders[0] if chapter_orders else 0),
            end_order=_as_int(payload.get("end_order")) or (chapter_orders[-1] if chapter_orders else 0),
            chapter_orders=chapter_orders,
            segments=segments,
            uncertain_boundaries=[
                item for item in payload.get("uncertain_boundaries") or [] if isinstance(item, dict)
            ],
            candidate_boundaries=[
                item for item in payload.get("candidate_boundaries") or [] if isinstance(item, dict)
            ],
            analysis_status=_as_text(payload.get("analysis_status")) or "api",
            analysis_error=_as_text(payload.get("analysis_error")),
        )

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
    inference_metadata: dict = field(default_factory=dict)
    boundary_vote_before: float | None = None
    boundary_vote_after: float | None = None
    confidence: float | None = None
    start_ref: dict = field(default_factory=dict)
    end_ref: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: dict) -> "GlobalPlot":
        payload = _as_mapping(payload)
        cluster = _as_mapping(payload.get("cluster"))
        synopsis = _as_mapping(payload.get("plot_synopsis"))

        def first_present(*values):
            for value in values:
                if value is not None:
                    return value
            return None

        raw_orders = payload.get("chapter_orders") or cluster.get("chapter_orders") or synopsis.get("chapter_orders") or []
        chapter_orders = [
            value
            for value in (_as_int(item) for item in raw_orders)
            if value is not None
        ]
        start_order = (
            _as_int(payload.get("start_order"))
            or _as_int(cluster.get("start_order"))
            or _as_int(synopsis.get("start_order"))
            or (chapter_orders[0] if chapter_orders else 0)
        )
        end_order = (
            _as_int(payload.get("end_order"))
            or _as_int(cluster.get("end_order"))
            or _as_int(synopsis.get("end_order"))
            or (chapter_orders[-1] if chapter_orders else start_order)
        )
        return cls(
            plot_id=_as_text(payload.get("plot_id") or cluster.get("cluster_id")),
            plot_index=_as_int(payload.get("plot_index") or cluster.get("cluster_index")) or 0,
            start_order=start_order,
            end_order=end_order,
            chapter_orders=chapter_orders,
            chapter_ids=_as_list(payload.get("chapter_ids") or cluster.get("chapter_ids")),
            chapter_titles=_as_list(payload.get("chapter_titles") or cluster.get("chapter_titles")),
            chapter_summaries=[
                item for item in payload.get("chapter_summaries") or [] if isinstance(item, dict)
            ],
            summary=_as_text(payload.get("summary") or synopsis.get("what_happens")),
            detailed_summary=_as_text(payload.get("detailed_summary") or synopsis.get("detailed_progression")),
            boundary_quality=_as_float(first_present(payload.get("boundary_quality"), cluster.get("boundary_quality"))),
            summary_coverage_quality=_as_float(first_present(payload.get("summary_coverage_quality"), cluster.get("summary_coverage_quality"))),
            source_window_ids=_as_list(payload.get("source_window_ids") or cluster.get("source_window_ids")),
            supporting_local_segments=[
                item for item in (payload.get("supporting_local_segments") or cluster.get("supporting_local_segments") or []) if isinstance(item, dict)
            ],
            plot_function=_as_list(payload.get("plot_function") or synopsis.get("plot_function")),
            driving_force=_as_list(payload.get("driving_force") or synopsis.get("driving_force")),
            key_events=[
                item for item in (payload.get("key_events") or synopsis.get("key_events") or []) if isinstance(item, dict)
            ],
            characters_involved=[
                item for item in (payload.get("characters_involved") or synopsis.get("characters_involved") or []) if isinstance(item, dict)
            ],
            relationship_changes=[
                item for item in (payload.get("relationship_changes") or synopsis.get("relationship_changes") or []) if isinstance(item, dict)
            ],
            conflict_model=_as_mapping(payload.get("conflict_model") or synopsis.get("conflict_model")),
            payoff_and_hook=_as_mapping(payload.get("payoff_and_hook") or synopsis.get("payoff_and_hook")),
            setup_and_resolution=_as_mapping(payload.get("setup_and_resolution") or synopsis.get("setup_and_resolution")),
            abstraction_hint=_as_mapping(payload.get("abstraction_hint") or synopsis.get("abstraction_hint")),
            inference_metadata=_as_mapping(payload.get("inference_metadata") or cluster.get("inference_metadata")),
            boundary_vote_before=_as_float(first_present(payload.get("boundary_vote_before"), cluster.get("boundary_vote_before"))),
            boundary_vote_after=_as_float(first_present(payload.get("boundary_vote_after"), cluster.get("boundary_vote_after"))),
            confidence=_as_float(first_present(payload.get("confidence"), cluster.get("confidence"))),
            start_ref=dict(_as_mapping(payload.get("start_ref") or cluster.get("start_ref"))),
            end_ref=dict(_as_mapping(payload.get("end_ref") or cluster.get("end_ref"))),
        )

    def to_dict(self) -> dict:
        chapter_count = len(self.chapter_orders)
        return {
            "plot_id": self.plot_id,
            "plot_index": self.plot_index,
            "start_order": self.start_order,
            "end_order": self.end_order,
            "start_ref": dict(self.start_ref),
            "end_ref": dict(self.end_ref),
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
            "inference_metadata": dict(self.inference_metadata),
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
                "start_ref": dict(self.start_ref),
                "end_ref": dict(self.end_ref),
                "chapter_count": chapter_count,
            },
            "cluster": {
                "cluster_id": self.plot_id,
                "cluster_index": self.plot_index,
                "method": "overlapping_window_boundary_vote",
                "start_order": self.start_order,
                "end_order": self.end_order,
                "start_ref": dict(self.start_ref),
                "end_ref": dict(self.end_ref),
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
                "inference_metadata": dict(self.inference_metadata),
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
