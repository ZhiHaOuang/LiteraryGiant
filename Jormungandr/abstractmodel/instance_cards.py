from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared import as_list, as_mapping, as_text, dedupe_items


INSTANCE_CARD_SCHEMA_VERSION = "narrative_instance_card.v1"
INSTANCE_CARD_TYPES = {
    "EventsLibrary": "event_instance_card",
    "PayoffAngst": "payoff_instance_card",
    "CharacterArc": "character_arc_instance_card",
    "EmotionRhythm": "emotion_rhythm_instance_card",
    "Worldview": "worldview_instance_card",
}

COMMON_QUALITY_PATHS = ["portable_core", "implementation_details", "fusion_hooks"]
LIBRARY_QUALITY_PATHS = {
    "EventsLibrary": [
        "scene_context.before_state",
        "scene_context.immediate_goal",
        "scene_context.active_obstacle",
        "scene_context.stakes",
        "scene_context.available_resources",
        "causal_chain",
        "turning_point.event",
        "turning_point.why_it_changes_direction",
        "turning_point.new_information_or_resource",
        "after_state.overall_change",
        "after_state.relationship_change",
        "after_state.power_change",
        "after_state.goal_change",
        "after_state.new_hook",
    ],
    "PayoffAngst": [
        "emotional_setup.pressure_evidence",
        "emotional_setup.reader_expectation",
        "emotional_setup.character_awareness",
        "emotional_setup.avoidability",
        "emotional_setup.delay_beats",
        "emotional_setup.release_beat",
        "emotional_setup.payoff_visibility",
        "emotional_setup.residual_emotion",
        "emotional_setup.failure_conditions",
    ],
    "CharacterArc": [
        "arc_path.initial_belief",
        "arc_path.initial_behavior",
        "arc_path.arc_nodes",
        "arc_path.failed_choices",
        "arc_path.turning_choice",
        "arc_path.new_behavior",
        "arc_path.relationship_confirmation",
        "arc_path.regression_risk",
    ],
    "EmotionRhythm": ["emotion_beats"],
    "Worldview": [
        "rule_application.rule_statement",
        "rule_application.enforcement",
        "rule_application.cost",
        "rule_application.exception",
        "rule_application.exploit",
        "rule_application.affected_groups",
        "rule_application.event_examples",
    ],
}


INSTANCE_CARD_PROMPT_SCHEMAS: dict[str, dict[str, Any]] = {
    "EventsLibrary": {
        "scene_context": {
            "before_state": "",
            "immediate_goal": "",
            "active_obstacle": "",
            "stakes": "",
            "available_resources": [],
        },
        "causal_chain": [
            {"step": 1, "action": "", "cause": "", "effect": "", "decision_owner": ""}
        ],
        "turning_point": {
            "event": "",
            "why_it_changes_direction": "",
            "new_information_or_resource": "",
        },
        "after_state": {
            "overall_change": "",
            "relationship_change": "",
            "power_change": "",
            "goal_change": "",
            "new_hook": "",
        },
    },
    "PayoffAngst": {
        "emotional_setup": {
            "pressure_evidence": [],
            "reader_expectation": "",
            "character_awareness": "reader_only/character_only/shared/uncertain",
            "avoidability": "",
            "delay_beats": [],
            "release_beat": "",
            "payoff_visibility": "private/public/relational/systemic/uncertain",
            "residual_emotion": "",
            "failure_conditions": [],
        },
    },
    "CharacterArc": {
        "arc_path": {
            "initial_belief": "",
            "initial_behavior": "",
            "arc_nodes": [
                {"phase": "", "pressure": "", "choice": "", "consequence": ""}
            ],
            "failed_choices": [],
            "turning_choice": "",
            "new_behavior": "",
            "relationship_confirmation": "",
            "regression_risk": "",
        },
    },
    "EmotionRhythm": {
        "emotion_beats": [
            {
                "beat_index": 1,
                "reader_emotion": "",
                "intensity": "1-5",
                "information_state": "",
                "tension_delta": "-2 to 2",
                "release_delta": "0 to 2",
                "hook_type": "",
            }
        ],
    },
    "Worldview": {
        "rule_application": {
            "rule_statement": "",
            "enforcement": "",
            "cost": "",
            "exception": "",
            "exploit": "",
            "affected_groups": [],
            "event_examples": [{"chunk_id": "", "application": ""}],
        },
    },
}


def prompt_schema_for_libraries(libraries: list[str]) -> dict[str, dict[str, Any]]:
    common = {
        "portable_core": [],
        "implementation_details": [],
        "source_locked_details": [],
        "fusion_hooks": [],
    }
    return {
        library: {**common, **INSTANCE_CARD_PROMPT_SCHEMAS[library]}
        for library in libraries
        if library in INSTANCE_CARD_PROMPT_SCHEMAS
    }


def build_source_ref(
    *,
    book_slug: str,
    evidence_chunk_ids: object,
    existing: object = None,
) -> dict[str, Any]:
    existing_ref = as_mapping(existing)
    chunks = dedupe_items(
        [
            *as_list(existing_ref.get("bridge_chunk_ids")),
            *as_list(evidence_chunk_ids),
        ]
    )
    plot_ids = dedupe_items([_plot_id(chunk_id) for chunk_id in chunks if _plot_id(chunk_id)])
    normalized_book_slug = as_text(book_slug)
    primary_plot_id = as_text(existing_ref.get("primary_plot_id")) or (plot_ids[0] if plot_ids else "")
    supporting_plot_ids = dedupe_items(
        [
            *as_list(existing_ref.get("supporting_plot_ids")),
            *[plot_id for plot_id in plot_ids if plot_id != primary_plot_id],
        ]
    )
    return {
        "bridge_chunk_ids": chunks,
        "primary_plot_id": primary_plot_id,
        "supporting_plot_ids": supporting_plot_ids,
        "detail_level_available": "plot" if chunks else "none",
        "bridge_index_path": as_text(existing_ref.get("bridge_index_path"))
        or (f"Library/BridgeIndex/books/{normalized_book_slug}.jsonl" if normalized_book_slug else ""),
    }


def normalize_instance_card(
    raw_card: object,
    *,
    library: str,
    mechanism: object,
    role_slots: object = None,
    failure_risks: object = None,
    evidence_chunk_ids: object = None,
    library_context: object = None,
) -> dict[str, Any]:
    raw = as_mapping(raw_card)
    mechanism_map = as_mapping(mechanism)
    declared_mode = as_text(raw.get("grounding_mode"))
    grounding_mode = (
        declared_mode
        if declared_mode in {"llm_grounded", "legacy_derived"}
        else "llm_grounded" if _has_library_payload(raw, library) else "legacy_derived"
    )
    card_input = {} if grounding_mode == "legacy_derived" else raw
    common = {
        "schema_version": INSTANCE_CARD_SCHEMA_VERSION,
        "card_type": INSTANCE_CARD_TYPES.get(library, "narrative_instance_card"),
        "grounding_mode": grounding_mode,
        "derivation_warnings": (
            []
            if grounding_mode == "llm_grounded"
            else ["实例卡由旧 mechanism 兼容生成；精确因果、转折与情节纹理需按 source_ref 回查。"]
        ),
        "portable_core": _text_list(card_input.get("portable_core"), limit=4)
        or _fallback_portable_core(mechanism_map),
        "implementation_details": _text_list(card_input.get("implementation_details"), limit=4)
        or _text_list(mechanism_map.get("action_chain"), limit=4),
        "source_locked_details": _text_list(card_input.get("source_locked_details"), limit=4),
        "fusion_hooks": _text_list(card_input.get("fusion_hooks"), limit=4)
        or _fallback_fusion_hooks(library),
    }
    if library == "EventsLibrary":
        common.update(_event_card(card_input, mechanism_map, role_slots))
    elif library == "PayoffAngst":
        common.update(_payoff_card(card_input, mechanism_map, failure_risks))
    elif library == "CharacterArc":
        common.update(_arc_card(card_input, mechanism_map))
    elif library == "EmotionRhythm":
        common.update(_rhythm_card(card_input, mechanism_map))
    elif library == "Worldview":
        common.update(_worldview_card(card_input, mechanism_map, evidence_chunk_ids, library_context))
    expected, present = _coverage(common, library)
    _, directly_grounded = _coverage(raw, library)
    if grounding_mode != "llm_grounded":
        directly_grounded = 0
    common["card_quality"] = {
        "expected_field_count": expected,
        "populated_field_count": present,
        "directly_grounded_field_count": directly_grounded,
        "completeness": round(present / max(1, expected), 4),
        "direct_grounding_completeness": round(directly_grounded / max(1, expected), 4),
        "needs_source_plot_lookup": directly_grounded < expected,
    }
    return common


def upgrade_reference_instance(row: dict[str, Any], *, library: str = "") -> dict[str, Any]:
    """Idempotently add the instance-card and source-reference contract to stored evidence."""
    upgraded = dict(row)
    resolved_library = as_text(library) or as_text(row.get("library"))
    evidence_chunk_ids = as_list(row.get("evidence_chunk_ids"))
    upgraded["schema_version"] = "reference_pattern_instance.v2"
    upgraded["instance_card"] = normalize_instance_card(
        row.get("instance_card"),
        library=resolved_library,
        mechanism=row.get("mechanism"),
        role_slots=row.get("role_slots"),
        failure_risks=row.get("failure_risks"),
        evidence_chunk_ids=evidence_chunk_ids,
        library_context=row,
    )
    upgraded["source_ref"] = build_source_ref(
        book_slug=as_text(row.get("book_slug")),
        evidence_chunk_ids=evidence_chunk_ids,
        existing=row.get("source_ref"),
    )
    return upgraded


def resolve_source_chunks(source_ref: object, *, bridge_index_root: str | Path) -> list[dict[str, Any]]:
    """Resolve only the selected Bridge chunks; callers opt into deep evidence lookup."""
    ref = as_mapping(source_ref)
    wanted = set(as_list(ref.get("bridge_chunk_ids")))
    if not wanted:
        return []
    by_book: dict[str, set[str]] = {}
    for chunk_id in wanted:
        book_slug = chunk_id.split(":", 1)[0]
        by_book.setdefault(book_slug, set()).add(chunk_id)
    rows: list[dict[str, Any]] = []
    for book_slug, chunk_ids in sorted(by_book.items()):
        path = Path(bridge_index_root) / "books" / f"{book_slug}.jsonl"
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict) and as_text(row.get("chunk_id")) in chunk_ids:
                rows.append(row)
    return sorted(rows, key=lambda row: as_text(row.get("chunk_id")))


def _event_card(raw: dict[str, Any], mechanism: dict[str, Any], role_slots: object) -> dict[str, Any]:
    scene = as_mapping(raw.get("scene_context"))
    turning = as_mapping(raw.get("turning_point"))
    after = as_mapping(raw.get("after_state"))
    actions = _text_list(mechanism.get("action_chain"), limit=5)
    raw_chain = raw.get("causal_chain") if isinstance(raw.get("causal_chain"), list) else []
    chain: list[dict[str, Any]] = []
    for index, item in enumerate(raw_chain[:5], start=1):
        if not isinstance(item, dict):
            continue
        action = _short(item.get("action"))
        if not action:
            continue
        chain.append(
            {
                "step": _bounded_int(item.get("step"), default=index, minimum=1, maximum=5),
                "action": action,
                "cause": _short(item.get("cause")),
                "effect": _short(item.get("effect")),
                "decision_owner": _short(item.get("decision_owner"), limit=80),
            }
        )
    if not chain:
        for index, action in enumerate(actions, start=1):
            chain.append(
                {
                    "step": index,
                    "action": action,
                    "cause": _short(mechanism.get("pressure")) if index == 1 else actions[index - 2],
                    "effect": actions[index] if index < len(actions) else _short(mechanism.get("state_change")),
                    "decision_owner": _fallback_decision_owner(action, role_slots),
                }
            )
    state_change = _short(mechanism.get("state_change"))
    return {
        "scene_context": {
            "before_state": _short(scene.get("before_state")),
            "immediate_goal": _short(scene.get("immediate_goal")),
            "active_obstacle": _short(scene.get("active_obstacle")) or _short(mechanism.get("pressure")),
            "stakes": _short(scene.get("stakes")),
            "available_resources": _text_list(scene.get("available_resources"), limit=5),
        },
        "causal_chain": chain,
        "turning_point": {
            "event": _short(turning.get("event")) or (actions[-1] if actions else ""),
            "why_it_changes_direction": _short(turning.get("why_it_changes_direction")) or state_change,
            "new_information_or_resource": _short(turning.get("new_information_or_resource")),
        },
        "after_state": {
            "overall_change": _short(after.get("overall_change")) or state_change,
            "relationship_change": _short(after.get("relationship_change")),
            "power_change": _short(after.get("power_change")),
            "goal_change": _short(after.get("goal_change")),
            "new_hook": _short(after.get("new_hook")),
        },
    }


def _payoff_card(raw: dict[str, Any], mechanism: dict[str, Any], failure_risks: object) -> dict[str, Any]:
    setup = as_mapping(raw.get("emotional_setup"))
    actions = _text_list(mechanism.get("action_chain"), limit=5)
    return {
        "emotional_setup": {
            "pressure_evidence": _text_list(setup.get("pressure_evidence"), limit=4)
            or _text_list(mechanism.get("pressure"), limit=1),
            "reader_expectation": _short(setup.get("reader_expectation")),
            "character_awareness": _enum(
                setup.get("character_awareness"),
                {"reader_only", "character_only", "shared", "uncertain"},
                "uncertain",
            ),
            "avoidability": _short(setup.get("avoidability")),
            "delay_beats": _text_list(setup.get("delay_beats"), limit=4) or actions[:-1],
            "release_beat": _short(setup.get("release_beat")) or (actions[-1] if actions else ""),
            "payoff_visibility": _enum(
                setup.get("payoff_visibility"),
                {"private", "public", "relational", "systemic", "uncertain"},
                "uncertain",
            ),
            "residual_emotion": _short(setup.get("residual_emotion")) or _short(mechanism.get("reader_effect")),
            "failure_conditions": _text_list(setup.get("failure_conditions"), limit=4)
            or _text_list(failure_risks, limit=4),
        }
    }


def _arc_card(raw: dict[str, Any], mechanism: dict[str, Any]) -> dict[str, Any]:
    path = as_mapping(raw.get("arc_path"))
    actions = _text_list(mechanism.get("action_chain"), limit=5)
    raw_nodes = path.get("arc_nodes") if isinstance(path.get("arc_nodes"), list) else []
    nodes: list[dict[str, str]] = []
    for index, item in enumerate(raw_nodes[:5], start=1):
        if not isinstance(item, dict):
            continue
        node = {
            "phase": _short(item.get("phase"), limit=60) or f"stage_{index}",
            "pressure": _short(item.get("pressure")),
            "choice": _short(item.get("choice")),
            "consequence": _short(item.get("consequence")),
        }
        if any(node.values()):
            nodes.append(node)
    if not nodes:
        for index, action in enumerate(actions, start=1):
            choice = action if _choice_like(action) else ""
            nodes.append(
                {
                    "phase": f"stage_{index}",
                    "pressure": (
                        _short(mechanism.get("pressure"))
                        if index == 1
                        else action if not choice else ""
                    ),
                    "choice": choice,
                    "consequence": actions[index] if index < len(actions) else _short(mechanism.get("state_change")),
                }
            )
    fallback_turning_choice = next((action for action in reversed(actions) if _choice_like(action)), "")
    return {
        "arc_path": {
            "initial_belief": _short(path.get("initial_belief")),
            "initial_behavior": _short(path.get("initial_behavior")) or (actions[0] if actions else ""),
            "arc_nodes": nodes,
            "failed_choices": _text_list(path.get("failed_choices"), limit=3),
            "turning_choice": _short(path.get("turning_choice")) or fallback_turning_choice,
            "new_behavior": _short(path.get("new_behavior")) or _short(mechanism.get("state_change")),
            "relationship_confirmation": _short(path.get("relationship_confirmation")),
            "regression_risk": _short(path.get("regression_risk")),
        }
    }


def _rhythm_card(raw: dict[str, Any], mechanism: dict[str, Any]) -> dict[str, Any]:
    raw_beats = raw.get("emotion_beats") if isinstance(raw.get("emotion_beats"), list) else []
    beats: list[dict[str, Any]] = []
    for index, item in enumerate(raw_beats[:8], start=1):
        if not isinstance(item, dict):
            continue
        emotion = _short(item.get("reader_emotion"), limit=80)
        information = _short(item.get("information_state"))
        if not emotion and not information:
            continue
        beats.append(
            {
                "beat_index": _bounded_int(item.get("beat_index"), default=index, minimum=1, maximum=8),
                "reader_emotion": emotion,
                "intensity": _bounded_int(item.get("intensity"), default=3, minimum=1, maximum=5),
                "information_state": information,
                "tension_delta": _bounded_int(item.get("tension_delta"), default=0, minimum=-2, maximum=2),
                "release_delta": _bounded_int(item.get("release_delta"), default=0, minimum=0, maximum=2),
                "hook_type": _short(item.get("hook_type"), limit=80),
            }
        )
    if not beats:
        actions = _text_list(mechanism.get("action_chain"), limit=8)
        for index, action in enumerate(actions, start=1):
            is_hook = any(
                term in action
                for term in ("悬念", "威胁", "危机", "代价", "却", "再次", "疯狂", "异化", "失控", "恐惧")
            )
            is_release = not is_hook and any(
                term in action for term in ("释放", "反击", "胜利", "复活", "揭露", "缓解", "获救")
            )
            beats.append(
                {
                    "beat_index": index,
                    "reader_emotion": _infer_reader_emotion(action, is_release=is_release, is_hook=is_hook),
                    "intensity": min(5, 2 + index),
                    "information_state": action,
                    "tension_delta": -1 if is_release else 1 if is_hook else 0,
                    "release_delta": 1 if is_release else 0,
                    "hook_type": "new_pressure" if is_hook else "",
                }
            )
    return {"emotion_beats": beats}


def _worldview_card(
    raw: dict[str, Any],
    mechanism: dict[str, Any],
    evidence_chunk_ids: object,
    library_context: object,
) -> dict[str, Any]:
    application = as_mapping(raw.get("rule_application"))
    context = as_mapping(library_context)
    raw_examples = application.get("event_examples") if isinstance(application.get("event_examples"), list) else []
    examples: list[dict[str, str]] = []
    ordered_chunks = as_list(evidence_chunk_ids)
    valid_chunks = set(ordered_chunks)
    for item in raw_examples[:5]:
        if not isinstance(item, dict):
            continue
        chunk_id = as_text(item.get("chunk_id"))
        if chunk_id and valid_chunks and chunk_id not in valid_chunks:
            continue
        applied = _short(item.get("application"))
        if chunk_id or applied:
            examples.append({"chunk_id": chunk_id, "application": applied})
    if not examples:
        examples = [
            {"chunk_id": chunk_id, "application": "该情节被引用为规则生效证据"}
            for chunk_id in ordered_chunks[:5]
        ]
    return {
        "rule_application": {
            "rule_statement": _short(application.get("rule_statement")) or _short(mechanism.get("trigger")),
            "enforcement": _short(application.get("enforcement"))
            or _short(context.get("enforcement_mechanism"))
            or _short(mechanism.get("pressure")),
            "cost": _short(application.get("cost"))
            or _short(context.get("cost_model")),
            "exception": _short(application.get("exception")),
            "exploit": _short(application.get("exploit")),
            "affected_groups": _text_list(application.get("affected_groups"), limit=5)
            or _text_list([context.get("who_benefits"), context.get("who_is_constrained")], limit=5),
            "event_examples": examples,
        }
    }


def _has_library_payload(raw: dict[str, Any], library: str) -> bool:
    key = {
        "EventsLibrary": "causal_chain",
        "PayoffAngst": "emotional_setup",
        "CharacterArc": "arc_path",
        "EmotionRhythm": "emotion_beats",
        "Worldview": "rule_application",
    }.get(library, "")
    payload = raw.get(key)
    if library == "EventsLibrary" and isinstance(payload, list):
        return any(
            isinstance(item, dict)
            and any(as_text(item.get(field)) for field in ("action", "cause", "effect"))
            for item in payload
        )
    if library == "EmotionRhythm" and isinstance(payload, list):
        return any(
            isinstance(item, dict)
            and any(as_text(item.get(field)) for field in ("reader_emotion", "information_state", "hook_type"))
            for item in payload
        )
    return bool(key and _meaningful(payload))


def _coverage(card: dict[str, Any], library: str) -> tuple[int, int]:
    paths = [*COMMON_QUALITY_PATHS, *LIBRARY_QUALITY_PATHS.get(library, [])]
    return len(paths), sum(_meaningful(_path_value(card, path)) for path in paths)


def _path_value(payload: dict[str, Any], path: str) -> object:
    value: object = payload
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _meaningful(value: object) -> bool:
    if isinstance(value, dict):
        return any(_meaningful(child) for child in value.values())
    if isinstance(value, list):
        return any(_meaningful(child) for child in value)
    if isinstance(value, (int, float)):
        return bool(value)
    text = as_text(value)
    return bool(text and text.lower() != "uncertain")


def _fallback_portable_core(mechanism: dict[str, Any]) -> list[str]:
    return _text_list(
        [mechanism.get("trigger"), mechanism.get("pressure"), mechanism.get("state_change")],
        limit=3,
    )


def _fallback_fusion_hooks(library: str) -> list[str]:
    return {
        "EventsLibrary": ["可替换触发来源", "可连接前置压力", "可把后果连接到下一事件"],
        "PayoffAngst": ["可替换压力来源", "可调整延迟长度", "可连接后续余波"],
        "CharacterArc": ["可替换转折催化剂", "可连接关系确认", "可设置回退测试"],
        "EmotionRhythm": ["可调整压力节拍", "可移动释放位置", "可替换释放后钩子"],
        "Worldview": ["可替换规则执行者", "可改变资源准入", "可由角色发现规则漏洞"],
    }.get(library, [])


def _fallback_decision_owner(action: str, role_slots: object) -> str:
    roles = list(as_mapping(role_slots))
    for role in roles:
        if role and role in action:
            return role
    if any(term in action for term in ("被", "遭", "死亡", "伤重", "失去", "暴露")):
        return ""
    return roles[0] if roles else ""


def _choice_like(value: str) -> bool:
    return any(
        term in value
        for term in ("选择", "决定", "主动", "拒绝", "接受", "放弃", "承担", "保护", "反击", "离开", "承诺", "加入", "呼救")
    )


def _infer_reader_emotion(action: str, *, is_release: bool, is_hook: bool) -> str:
    if is_release:
        return "希望或释然"
    if is_hook:
        return "紧张与不安"
    if any(term in action for term in ("死亡", "牺牲", "失去", "毁灭", "绝望")):
        return "悲痛与绝望"
    if any(term in action for term in ("疯狂", "异化", "失控", "恐惧", "威胁", "危机")):
        return "紧张与不安"
    if any(term in action for term in ("复活", "获救", "胜利", "释放", "反击", "揭露")):
        return "希望或释然"
    if any(term in action for term in ("悬念", "未知", "谜", "疑问")):
        return "好奇与焦虑"
    return ""


def _text_list(value: object, *, limit: int, item_limit: int = 180) -> list[str]:
    raw = value if isinstance(value, list) else as_list(value)
    result: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            continue
        text = _short(item, limit=item_limit)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _short(value: object, *, limit: int = 240) -> str:
    text = as_text(value)
    return text if len(text) <= limit else f"{text[:limit].rstrip()}..."


def _enum(value: object, allowed: set[str], default: str) -> str:
    text = as_text(value).lower()
    return text if text in allowed else default


def _bounded_int(value: object, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def _plot_id(chunk_id: str) -> str:
    return chunk_id.split(":", 1)[1] if ":" in chunk_id else ""
