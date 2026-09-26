from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from shared import (
    as_int,
    as_list,
    as_mapping,
    as_text,
    canonical_book_slug,
    dedupe_items,
)


SCHEMA_VERSION = "abstractmodel.v2"
SIGNATURE_SCHEMA_VERSION = "plot_signature.v1"
OBJECT_SCHEMA_VERSION = "abstract_object.v1"
GRAPH_SCHEMA_VERSION = "book_narrative_graph.v1"

WORLDVIEW = "Worldview"
EVENTS_LIBRARY = "EventsLibrary"
CHARACTER_ARC = "CharacterArc"
EMOTION_RHYTHM = "EmotionRhythm"
PAYOFF_ANGST = "PayoffAngst"
MEMES = "Memes"
BOOK_LOGIC_GRAPH = "BookLogicGraph"

# Plot-level extraction only produces candidate evidence for libraries whose
# reusable structure can be seen inside one plot segment. Worldview is promoted
# from book-level profiles; Memes is an explicit manual surface.
PLOT_LEVEL_LIBRARIES = (
    CHARACTER_ARC,
    EMOTION_RHYTHM,
    EVENTS_LIBRARY,
    PAYOFF_ANGST,
)

BOOK_LEVEL_LIBRARIES = (WORLDVIEW,)
MANUAL_ABSTRACT_LIBRARIES = (MEMES,)
AUTOMATED_PATTERN_LIBRARIES = PLOT_LEVEL_LIBRARIES + BOOK_LEVEL_LIBRARIES
FINAL_ABSTRACT_LIBRARIES = AUTOMATED_PATTERN_LIBRARIES + MANUAL_ABSTRACT_LIBRARIES
INTERMEDIATE_LIBRARIES = (BOOK_LOGIC_GRAPH,)
ALL_LIBRARIES = FINAL_ABSTRACT_LIBRARIES + INTERMEDIATE_LIBRARIES

LEGACY_LIBRARY_NAME_MAP = {
    "Payoff_Angst": PAYOFF_ANGST,
}


def canonical_library_name(library: str) -> str:
    text = str(library or "").strip()
    return LEGACY_LIBRARY_NAME_MAP.get(text, text)

WORLDVIEW_FUNCTIONS = {
    "世界观展示",
    "规则揭露",
    "系统机制",
    "组织结构展示",
    "副本进入",
}

WORLDVIEW_KEYWORDS = (
    "规则",
    "系统",
    "世界观",
    "法则",
    "禁制",
    "修炼",
    "副本",
    "门派",
    "宗门",
    "家族",
    "组织",
    "阶层",
    "权力结构",
    "等级",
    "权限",
    "代价",
    "惩罚",
    "奖励",
    "资源",
    "职业",
    "积分",
    "因果",
    "契约",
)

HIGH_EMOTION_FUNCTIONS = {
    "开篇钩子",
    "危机升级",
    "关系决裂",
    "秘密揭露",
    "爽点释放",
    "打脸反杀",
    "刀点爆发",
    "高潮转折",
    "阶段失败",
    "终局收束",
}

MEME_SURFACE_FUNCTIONS = {
    "开篇钩子",
    "秘密揭露",
    "身份揭露",
    "爽点释放",
    "打脸反杀",
    "终局收束",
}


def list_of_dicts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def field_texts(items: list[dict[str, Any]], *keys: str) -> list[str]:
    values: list[str] = []
    for item in items:
        for key in keys:
            text = as_text(item.get(key))
            if text:
                values.append(text)
    return dedupe_items(values)


def setup_questions(setup: dict[str, Any]) -> list[str]:
    questions: list[str] = []
    initial = as_text(setup.get("initial_question"))
    if initial:
        questions.append(initial)
    questions.extend(as_list(setup.get("resolved_questions")))
    questions.extend(as_list(setup.get("unresolved_questions")))
    questions.extend(as_list(setup.get("new_questions_created")))
    return dedupe_items(questions)


@dataclass(slots=True)
class PlotSignature:
    book_id: str
    book_slug: str
    plot_id: str
    plot_index: int
    start_order: int
    end_order: int
    chapter_orders: list[int] = field(default_factory=list)
    plot_function: list[str] = field(default_factory=list)
    driving_force: list[str] = field(default_factory=list)
    conflict_type: list[str] = field(default_factory=list)
    has_worldview_signal: bool = False
    has_event_signal: bool = False
    has_character_arc_signal: bool = False
    has_emotion_signal: bool = False
    has_payoff_signal: bool = False
    has_angst_signal: bool = False
    has_meme_signal: bool = False
    has_book_logic_signal: bool = False
    routing_targets: list[str] = field(default_factory=list)
    abstraction_score: int = 0
    low_abstraction_reason: str = ""

    @classmethod
    def from_plot(cls, plot: dict[str, Any], *, book_metadata: dict[str, Any], fallback_index: int) -> "PlotSignature":
        book_slug = canonical_book_slug(
            as_text(book_metadata.get("book_id"))
            or as_text(book_metadata.get("clean_id"))
        )
        book_id = book_slug
        plot_id = as_text(plot.get("plot_id")) or f"plot{fallback_index}"
        plot_index = as_int(plot.get("plot_index")) or fallback_index
        chapter_orders = [
            order
            for order in (as_int(item) for item in plot.get("chapter_orders") or [])
            if order is not None
        ]
        start_order = as_int(plot.get("start_order")) or (chapter_orders[0] if chapter_orders else 0)
        end_order = as_int(plot.get("end_order")) or (chapter_orders[-1] if chapter_orders else start_order)
        plot_function = as_list(plot.get("plot_function"))
        driving_force = as_list(plot.get("driving_force"))

        conflict_model = as_mapping(plot.get("conflict_model"))
        payoff_and_hook = as_mapping(plot.get("payoff_and_hook"))
        setup_and_resolution = as_mapping(plot.get("setup_and_resolution"))
        abstraction_hint = as_mapping(plot.get("abstraction_hint"))
        key_events = list_of_dicts(plot.get("key_events"))
        characters = list_of_dicts(plot.get("characters_involved"))
        relationship_changes = list_of_dicts(plot.get("relationship_changes"))

        conflict_type = as_list(conflict_model.get("conflict_type"))
        plot_text = "\n".join(
            [
                as_text(plot.get("summary")),
                as_text(plot.get("detailed_summary")),
                as_text(conflict_model.get("surface_conflict")),
                as_text(conflict_model.get("deep_conflict")),
            ]
        )

        has_worldview_signal = bool(set(plot_function) & WORLDVIEW_FUNCTIONS) and any(
            keyword in plot_text for keyword in WORLDVIEW_KEYWORDS
        )
        has_event_signal = bool(field_texts(key_events, "event"))
        has_character_arc_signal = bool(relationship_changes) or bool(field_texts(characters, "state_change"))
        has_payoff_signal = bool(as_list(payoff_and_hook.get("reader_payoffs")))
        has_angst_signal = bool(as_list(payoff_and_hook.get("angst_points")))
        has_hook_signal = bool(
            as_list(payoff_and_hook.get("suspense_hooks")) or as_text(payoff_and_hook.get("ending_hook"))
        )
        has_emotion_signal = (
            has_payoff_signal
            or has_angst_signal
            or has_hook_signal
            or bool(set(plot_function) & HIGH_EMOTION_FUNCTIONS)
        )
        has_meme_signal = bool(
            as_list(abstraction_hint.get("possible_tropes"))
            and as_text(abstraction_hint.get("possible_transferable_pattern"))
            and bool(set(plot_function) & MEME_SURFACE_FUNCTIONS)
        )
        has_book_logic_signal = bool(
            key_events
            or relationship_changes
            or setup_questions(setup_and_resolution)
            or has_hook_signal
            or has_payoff_signal
        )

        routing_targets: list[str] = []
        if has_event_signal:
            routing_targets.append(EVENTS_LIBRARY)
        if has_character_arc_signal:
            routing_targets.append(CHARACTER_ARC)
        if has_emotion_signal:
            routing_targets.append(EMOTION_RHYTHM)
        if has_payoff_signal or has_angst_signal:
            routing_targets.append(PAYOFF_ANGST)
        if has_book_logic_signal:
            routing_targets.append(BOOK_LOGIC_GRAPH)

        abstraction_score = sum(
            [
                has_event_signal,
                has_character_arc_signal,
                has_emotion_signal,
                has_payoff_signal,
                has_angst_signal,
                has_book_logic_signal,
            ]
        )
        low_abstraction_reason = "" if abstraction_score else "low_abstraction_value"
        return cls(
            book_id=book_id,
            book_slug=book_slug,
            plot_id=plot_id,
            plot_index=plot_index,
            start_order=start_order,
            end_order=end_order,
            chapter_orders=chapter_orders,
            plot_function=plot_function,
            driving_force=driving_force,
            conflict_type=conflict_type,
            has_worldview_signal=has_worldview_signal,
            has_event_signal=has_event_signal,
            has_character_arc_signal=has_character_arc_signal,
            has_emotion_signal=has_emotion_signal,
            has_payoff_signal=has_payoff_signal,
            has_angst_signal=has_angst_signal,
            has_meme_signal=has_meme_signal,
            has_book_logic_signal=has_book_logic_signal,
            routing_targets=routing_targets,
            abstraction_score=abstraction_score,
            low_abstraction_reason=low_abstraction_reason,
        )

    def source_ref(self) -> dict[str, Any]:
        return {
            "book_id": self.book_id,
            "book_slug": self.book_slug,
            "plot_id": self.plot_id,
            "plot_index": self.plot_index,
            "start_order": self.start_order,
            "end_order": self.end_order,
            "chapter_orders": list(self.chapter_orders),
        }

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["schema_version"] = SIGNATURE_SCHEMA_VERSION
        payload["source_ref"] = self.source_ref()
        return payload


@dataclass(slots=True)
class AbstractObject:
    library: str
    object_id: str
    object_type: str
    source_ref: dict[str, Any]
    payload: dict[str, Any]
    confidence: float = 1.0
    schema_version: str = OBJECT_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
