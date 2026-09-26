from __future__ import annotations

from typing import Any

from shared import as_int, as_list, as_mapping, as_text, dedupe_items

from .generalizer import (
    character_arc_template,
    emotion_pattern,
    event_template,
    payoff_pattern,
    relationship_template,
    role_bindings,
    template_family,
    trope_surface,
    worldview_mechanism,
)
from .schemas import (
    CHARACTER_ARC,
    EMOTION_RHYTHM,
    EVENTS_LIBRARY,
    MEMES,
    PAYOFF_ANGST,
    WORLDVIEW,
    AbstractObject,
    PlotSignature,
    list_of_dicts,
    setup_questions,
)
from .template_registry import TemplateRegistry


def _object_id(signature: PlotSignature, kind: str, index: int = 1) -> str:
    return f"{signature.book_slug}__plot{signature.plot_index:04d}__{kind}{index:03d}"


def _source_ref(signature: PlotSignature, *, source_file: str = "") -> dict[str, Any]:
    source_ref = signature.source_ref()
    if source_file:
        source_ref["bridge_plot_file"] = source_file
    return source_ref


def _make_object(
    *,
    library: str,
    object_id: str,
    object_type: str,
    signature: PlotSignature,
    source_file: str,
    source_payload: dict[str, Any],
    generalized_payload: dict[str, Any],
    extraction_notes: list[str] | None = None,
    confidence: float = 1.0,
) -> AbstractObject:
    return AbstractObject(
        library=library,
        object_id=object_id,
        object_type=object_type,
        source_ref=_source_ref(signature, source_file=source_file),
        payload={
            "source_payload": source_payload,
            "generalized_payload": generalized_payload,
            "extraction_notes": extraction_notes or [],
        },
        confidence=confidence,
    )


def extract_events(
    plot: dict[str, Any],
    signature: PlotSignature,
    *,
    source_file: str = "",
    template_registry: TemplateRegistry | None = None,
) -> list[AbstractObject]:
    if EVENTS_LIBRARY not in signature.routing_targets:
        return []
    key_events = list_of_dicts(plot.get("key_events"))
    conflict_model = as_mapping(plot.get("conflict_model"))
    setup = as_mapping(plot.get("setup_and_resolution"))
    payoff = as_mapping(plot.get("payoff_and_hook"))
    abstraction_hint = as_mapping(plot.get("abstraction_hint"))
    if not key_events:
        return []
    source_payload = {
        "summary": as_text(plot.get("summary")),
        "detailed_summary": as_text(plot.get("detailed_summary")),
        "source_events": [
            {
                "event": as_text(event.get("event")),
                "event_order": as_int(event.get("event_order")) or index,
                "event_function": as_text(event.get("event_function")),
                "chapter_order": as_int(event.get("chapter_order")),
            }
            for index, event in enumerate(key_events, start=1)
            if as_text(event.get("event"))
        ],
        "plot_function": list(signature.plot_function),
        "driving_force": list(signature.driving_force),
        "conflict_model": {
            "surface_conflict": as_text(conflict_model.get("surface_conflict")),
            "deep_conflict": as_text(conflict_model.get("deep_conflict")),
            "conflict_type": list(signature.conflict_type),
            "stakes": as_text(conflict_model.get("stakes")),
        },
        "setup_context": {
            "initial_question": as_text(setup.get("initial_question")),
            "resolved_questions": as_list(setup.get("resolved_questions")),
            "new_questions_created": as_list(setup.get("new_questions_created")),
        },
        "local_consequence_hint": {
            "ending_hook": as_text(payoff.get("ending_hook")),
            "reader_payoffs": as_list(payoff.get("reader_payoffs")),
            "angst_points": as_list(payoff.get("angst_points")),
        },
        "transferable_pattern_hint": as_text(abstraction_hint.get("possible_transferable_pattern")),
        "source_role_bindings": role_bindings(plot),
    }
    generalized_payload = event_template(
        plot,
        signature,
        registry=template_registry,
        source_ref=_source_ref(signature, source_file=source_file),
    )
    if not generalized_payload.get("event_template"):
        return []
    return [
        _make_object(
            library=EVENTS_LIBRARY,
            object_id=_object_id(signature, "event_template"),
            object_type="event_template_candidate",
            signature=signature,
            source_file=source_file,
            source_payload=source_payload,
            generalized_payload=generalized_payload,
            extraction_notes=["One event template is distilled from the plot event sequence; raw key events stay in source_payload."],
        )
    ]


def extract_payoff_angst(
    plot: dict[str, Any],
    signature: PlotSignature,
    *,
    source_file: str = "",
    template_registry: TemplateRegistry | None = None,
) -> list[AbstractObject]:
    if PAYOFF_ANGST not in signature.routing_targets:
        return []
    payoff = as_mapping(plot.get("payoff_and_hook"))
    conflict_model = as_mapping(plot.get("conflict_model"))
    reader_payoffs = as_list(payoff.get("reader_payoffs"))
    angst_points = as_list(payoff.get("angst_points"))
    suspense_hooks = as_list(payoff.get("suspense_hooks"))
    ending_hook = as_text(payoff.get("ending_hook"))
    if not (reader_payoffs or angst_points or suspense_hooks or ending_hook):
        return []
    source_payload = {
        "reader_payoffs": reader_payoffs,
        "angst_points": angst_points,
        "suspense_hooks": suspense_hooks,
        "ending_hook": ending_hook,
        "stakes": as_text(conflict_model.get("stakes")),
        "pressure_source": as_text(conflict_model.get("surface_conflict")),
        "deep_pressure": as_text(conflict_model.get("deep_conflict")),
        "plot_function": list(signature.plot_function),
        "driving_force": list(signature.driving_force),
    }
    generalized_payload = payoff_pattern(
        plot,
        signature,
        registry=template_registry,
        source_ref=_source_ref(signature, source_file=source_file),
    )
    if not generalized_payload.get("pattern_name"):
        return []
    return [
        _make_object(
            library=PAYOFF_ANGST,
            object_id=_object_id(signature, "payoff_angst"),
            object_type="payoff_angst_pattern_candidate",
            signature=signature,
            source_file=source_file,
            source_payload=source_payload,
            generalized_payload=generalized_payload,
        )
    ]


def extract_character_arc(plot: dict[str, Any], signature: PlotSignature, *, source_file: str = "") -> list[AbstractObject]:
    if CHARACTER_ARC not in signature.routing_targets:
        return []
    objects: list[AbstractObject] = []
    characters = list_of_dicts(plot.get("characters_involved"))
    relationship_changes = list_of_dicts(plot.get("relationship_changes"))
    object_index = 1
    for character in characters:
        state_change = as_text(character.get("state_change"))
        name = as_text(character.get("name"))
        if not state_change or not name:
            continue
        generalized_payload = character_arc_template(character, plot, signature)
        if generalized_payload.get("character_slot") == "supporting_actor":
            continue
        source_payload = {
            "character_name": name,
            "role_in_plot": as_text(character.get("role_in_plot")),
            "state_change": state_change,
            "fragment_scope": "plot",
            "plot_function": list(signature.plot_function),
            "driving_force": list(signature.driving_force),
        }
        objects.append(
            _make_object(
                library=CHARACTER_ARC,
                object_id=_object_id(signature, "chararc_fragment", object_index),
                object_type="character_arc_fragment",
                signature=signature,
                source_file=source_file,
                source_payload=source_payload,
                generalized_payload=generalized_payload,
            )
        )
        object_index += 1
    for change in relationship_changes:
        characters_pair = as_list(change.get("characters"))
        if not characters_pair:
            continue
        source_payload = {
            "characters": characters_pair,
            "before": as_text(change.get("before")),
            "after": as_text(change.get("after")),
            "change_type": as_text(change.get("change_type")),
            "cause": as_text(change.get("cause")),
            "fragment_scope": "plot",
            "plot_function": list(signature.plot_function),
        }
        objects.append(
            _make_object(
                library=CHARACTER_ARC,
                object_id=_object_id(signature, "relationship_fragment", object_index),
                object_type="relationship_change_fragment",
                signature=signature,
                source_file=source_file,
                source_payload=source_payload,
                generalized_payload=relationship_template(change, plot, signature),
            )
        )
        object_index += 1
    return objects


def extract_worldview(plot: dict[str, Any], signature: PlotSignature, *, source_file: str = "") -> list[AbstractObject]:
    if WORLDVIEW not in signature.routing_targets:
        return []
    setup = as_mapping(plot.get("setup_and_resolution"))
    conflict_model = as_mapping(plot.get("conflict_model"))
    summary = as_text(plot.get("summary"))
    detailed_summary = as_text(plot.get("detailed_summary"))
    evidence = dedupe_items(
        [
            text
            for text in [
                summary,
                detailed_summary,
                as_text(conflict_model.get("surface_conflict")),
                as_text(conflict_model.get("deep_conflict")),
                as_text(setup.get("initial_question")),
            ]
            if text
        ]
    )
    if not evidence:
        return []
    source_payload = {
        "candidate_kind": "worldview_rule_or_mechanism",
        "plot_function": list(signature.plot_function),
        "driving_force": list(signature.driving_force),
        "evidence": evidence[:5],
        "questions": setup_questions(setup),
    }
    generalized_payload = worldview_mechanism(plot, signature)
    if not as_text(generalized_payload.get("rule")).startswith("围绕"):
        return []
    return [
        _make_object(
            library=WORLDVIEW,
            object_id=_object_id(signature, "worldview_candidate"),
            object_type="worldview_mechanism_candidate",
            signature=signature,
            source_file=source_file,
            source_payload=source_payload,
            generalized_payload=generalized_payload,
            extraction_notes=["Low-confidence candidate; requires cross-plot merge before stable Worldview use."],
            confidence=0.7,
        )
    ]


def _emotion_beats(plot: dict[str, Any], signature: PlotSignature) -> list[str]:
    payoff = as_mapping(plot.get("payoff_and_hook"))
    beats: list[str] = []
    functions = set(signature.plot_function)
    if functions & {"开篇钩子"}:
        beats.append("hook_open")
    if functions & {"冲突铺垫", "误会制造"}:
        beats.append("tension_setup")
    if functions & {"冲突引爆", "危机升级", "关系决裂", "阶段失败", "刀点爆发"}:
        beats.append("pressure_escalation")
    if as_list(payoff.get("angst_points")):
        beats.append("angst_pressure")
    if functions & {"关系升温"}:
        beats.append("relationship_warmup")
    if functions & {"关系降温"}:
        beats.append("relationship_cooldown")
    if as_list(payoff.get("reader_payoffs")) or functions & {"爽点释放", "打脸反杀", "阶段胜利"}:
        beats.append("payoff_release")
    if as_list(payoff.get("suspense_hooks")) or as_text(payoff.get("ending_hook")):
        beats.append("suspense_hook")
    if functions & {"过渡"} and not beats:
        beats.append("transition_buffer")
    return dedupe_items(beats)


def extract_emotion_rhythm(
    plot: dict[str, Any],
    signature: PlotSignature,
    *,
    source_file: str = "",
    template_registry: TemplateRegistry | None = None,
) -> list[AbstractObject]:
    if EMOTION_RHYTHM not in signature.routing_targets:
        return []
    beats = _emotion_beats(plot, signature)
    if not beats:
        return []
    intense_functions = {
        "开篇钩子",
        "危机升级",
        "关系决裂",
        "秘密揭露",
        "打脸反杀",
        "刀点爆发",
        "阶段失败",
        "终局收束",
        "高潮转折",
    }
    family = template_family(plot, signature)
    has_full_pressure_release = {
        "pressure_escalation",
        "payoff_release",
        "suspense_hook",
    }.issubset(set(beats))
    if not (set(signature.plot_function) & intense_functions) and not (
        has_full_pressure_release and family != "plot_turning_pattern"
    ):
        return []
    payoff = as_mapping(plot.get("payoff_and_hook"))
    source_payload = {
        "fragment_scope": "plot",
        "beat_sequence": beats,
        "plot_function": list(signature.plot_function),
        "reader_payoffs": as_list(payoff.get("reader_payoffs")),
        "angst_points": as_list(payoff.get("angst_points")),
        "suspense_hooks": as_list(payoff.get("suspense_hooks")),
        "ending_hook": as_text(payoff.get("ending_hook")),
    }
    return [
        _make_object(
            library=EMOTION_RHYTHM,
            object_id=_object_id(signature, "emotion_beat"),
            object_type="emotion_beat_fragment",
            signature=signature,
            source_file=source_file,
            source_payload=source_payload,
            generalized_payload=emotion_pattern(
                plot,
                signature,
                beats,
                registry=template_registry,
                source_ref=_source_ref(signature, source_file=source_file),
            ),
        )
    ]


def extract_memes(plot: dict[str, Any], signature: PlotSignature, *, source_file: str = "") -> list[AbstractObject]:
    if MEMES not in signature.routing_targets:
        return []
    abstraction_hint = as_mapping(plot.get("abstraction_hint"))
    possible_tropes = as_list(abstraction_hint.get("possible_tropes"))
    emotional_core = as_list(abstraction_hint.get("possible_emotional_core"))
    transferable_pattern = as_text(abstraction_hint.get("possible_transferable_pattern"))
    if not (possible_tropes or emotional_core or transferable_pattern):
        return []
    source_payload = {
        "possible_tropes": possible_tropes,
        "possible_emotional_core": emotional_core,
        "possible_transferable_pattern": transferable_pattern,
        "plot_function": list(signature.plot_function),
        "driving_force": list(signature.driving_force),
    }
    return [
        _make_object(
            library=MEMES,
            object_id=_object_id(signature, "trope_candidate"),
            object_type="trope_surface_candidate",
            signature=signature,
            source_file=source_file,
            source_payload=source_payload,
            generalized_payload=trope_surface(plot, signature),
            extraction_notes=["This is a trope surface hint, not a true meme object."],
            confidence=0.75,
        )
    ]


class PlotLevelExtractor:
    def __init__(self, *, template_registry: TemplateRegistry | None = None) -> None:
        self.template_registry = template_registry or TemplateRegistry()

    def extract(self, plot: dict[str, Any], signature: PlotSignature, *, source_file: str = "") -> dict[str, list[dict[str, Any]]]:
        # Active plot-level extraction is limited to the four automatic
        # candidate libraries. Worldview is book-level; Memes is manual-only.
        raw_objects = {
            EVENTS_LIBRARY: extract_events(
                plot,
                signature,
                source_file=source_file,
                template_registry=self.template_registry,
            ),
            CHARACTER_ARC: extract_character_arc(plot, signature, source_file=source_file),
            EMOTION_RHYTHM: extract_emotion_rhythm(
                plot,
                signature,
                source_file=source_file,
                template_registry=self.template_registry,
            ),
            PAYOFF_ANGST: extract_payoff_angst(
                plot,
                signature,
                source_file=source_file,
                template_registry=self.template_registry,
            ),
        }
        return {
            library: [item.to_dict() for item in objects]
            for library, objects in raw_objects.items()
            if objects
        }
