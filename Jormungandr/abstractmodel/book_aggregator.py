from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from shared import as_list, as_mapping, as_text, dedupe_items

from .schemas import (
    CHARACTER_ARC,
    EMOTION_RHYTHM,
    EVENTS_LIBRARY,
    PAYOFF_ANGST,
    WORLDVIEW,
)


GENERIC_ARC_TEMPLATES = {"配角状态推动局部关系变化", "关系状态重排"}


def _source_ref(item: dict[str, Any]) -> dict[str, Any]:
    ref = item.get("source_ref")
    return ref if isinstance(ref, dict) else {}


def _payload(item: dict[str, Any], key: str) -> dict[str, Any]:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _plot_index(item: dict[str, Any]) -> int:
    ref = _source_ref(item)
    try:
        return int(ref.get("plot_index") or 0)
    except (TypeError, ValueError):
        return 0


def _library_objects(processed_book: dict[str, Any], library: str) -> list[dict[str, Any]]:
    objects = processed_book.get("objects_by_library") or {}
    values = objects.get(library) or []
    return [item for item in values if isinstance(item, dict)]


def _top_counts(values: list[str], *, limit: int = 12) -> list[dict[str, Any]]:
    counts = Counter(value for value in values if value)
    return [
        {"value": value, "count": count}
        for value, count in counts.most_common(limit)
    ]


def _generalized(item: dict[str, Any]) -> dict[str, Any]:
    return _payload(item, "generalized_payload")


def _source_payload(item: dict[str, Any]) -> dict[str, Any]:
    return _payload(item, "source_payload")


def _max_plot_index(processed_book: dict[str, Any]) -> int:
    signatures = processed_book.get("signatures") or []
    indexes: list[int] = []
    for item in signatures:
        if not isinstance(item, dict):
            continue
        try:
            indexes.append(int(item.get("plot_index") or 0))
        except (TypeError, ValueError):
            continue
    return max(indexes, default=len(signatures))


def _phase_ranges(plot_count: int) -> list[dict[str, Any]]:
    if plot_count <= 0:
        return []
    ratios = [0.1, 0.35, 0.6, 0.82, 1.0]
    names = [
        "opening_pressure_setup",
        "early_relation_and_pressure_loop",
        "middle_reveal_and_crisis_expansion",
        "late_power_reversal_and_binding",
        "final_settlement",
    ]
    ranges: list[dict[str, Any]] = []
    start = 1
    previous_end = 0
    for index, ratio in enumerate(ratios, start=1):
        end = max(start, int(round(plot_count * ratio)))
        if end <= previous_end:
            end = previous_end + 1
        end = min(end, plot_count)
        ranges.append({"phase_id": f"phase_{index}", "phase_name": names[index - 1], "start": start, "end": end})
        previous_end = end
        start = end + 1
        if start > plot_count:
            break
    return ranges


def _items_in_range(items: list[dict[str, Any]], start: int, end: int) -> list[dict[str, Any]]:
    return [item for item in items if start <= _plot_index(item) <= end]


def _sample_refs(items: list[dict[str, Any]], *, limit: int = 8) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for item in items[:limit]:
        ref = _source_ref(item)
        refs.append(
            {
                "object_id": item.get("object_id", ""),
                "plot_id": ref.get("plot_id", ""),
                "plot_index": ref.get("plot_index", 0),
            }
        )
    return refs


def _dominant_values(items: list[dict[str, Any]], key: str, *, limit: int = 8) -> list[dict[str, Any]]:
    return _top_counts([as_text(_generalized(item).get(key)) for item in items], limit=limit)


def _dominant_source_values(items: list[dict[str, Any]], key: str, *, limit: int = 8) -> list[dict[str, Any]]:
    return _top_counts([as_text(_source_payload(item).get(key)) for item in items], limit=limit)


def _portable_pattern_names(items: list[dict[str, Any]], name_key: str, *, limit: int = 10) -> list[str]:
    names = [
        as_text(_generalized(item).get(name_key))
        or as_text(_generalized(item).get("micro_pattern"))
        or as_text(_generalized(item).get("macro_pattern"))
        for item in items
    ]
    return [item["value"] for item in _top_counts(names, limit=limit)]


def _book_specific_character_names(items: list[dict[str, Any]], *, limit: int = 12) -> list[str]:
    names: list[str] = []
    for item in items:
        sp = _source_payload(item)
        names.append(as_text(sp.get("character_name")))
        names.extend(as_list(sp.get("characters")))
    return [item["value"] for item in _top_counts(names, limit=limit)]


def _core_narrative_mechanism(
    event_macros: list[str],
    payoff_macros: list[str],
    emotion_rhythm_types: list[str],
) -> str:
    event_text = "、".join(item["value"] for item in _top_counts(event_macros, limit=3))
    payoff_text = "、".join(item["value"] for item in _top_counts(payoff_macros, limit=3))
    emotion_text = "、".join(item["value"] for item in _top_counts(emotion_rhythm_types, limit=2))
    return (
        "本书以旧关系/外部权力持续制造价值压低和关系不确定为推进压力，"
        f"反复使用{event_text or '阶段转折事件'}推动局势变化，"
        f"再通过{payoff_text or '阶段压力释放机制'}完成读者奖赏或疼痛释放；"
        f"主情绪循环表现为{emotion_text or '压迫-释放'}，每轮释放后继续保留关系选择或秘密钩子。"
    )


def build_book_profile(processed_book: dict[str, Any]) -> dict[str, Any]:
    book_metadata = processed_book.get("book_metadata") or {}
    signatures = processed_book.get("signatures") or []
    events = _library_objects(processed_book, EVENTS_LIBRARY)
    payoffs = _library_objects(processed_book, PAYOFF_ANGST)
    emotions = _library_objects(processed_book, EMOTION_RHYTHM)
    character_fragments = _library_objects(processed_book, CHARACTER_ARC)

    plot_functions: list[str] = []
    driving_forces: list[str] = []
    for signature in signatures:
        if not isinstance(signature, dict):
            continue
        plot_functions.extend(as_list(signature.get("plot_function")))
        driving_forces.extend(as_list(signature.get("driving_force")))

    event_macros = [
        as_text(_payload(item, "generalized_payload").get("macro_pattern"))
        for item in events
    ]
    payoff_macros = [
        as_text(_payload(item, "generalized_payload").get("macro_pattern"))
        for item in payoffs
    ]
    emotion_rhythm_types = [
        as_text(_payload(item, "generalized_payload").get("rhythm_type"))
        for item in emotions
    ]
    dominant_event_patterns = _top_counts(event_macros)
    dominant_payoff_patterns = _top_counts(payoff_macros)
    dominant_emotion_rhythms = _top_counts(emotion_rhythm_types)
    return {
        "schema_version": "book_profile.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "title": as_text(book_metadata.get("title") or (book_metadata.get("source_lineage") or {}).get("title")),
        "source_plot_dir": processed_book.get("source_plot_dir", ""),
        "plot_count": len(signatures),
        "dominant_plot_functions": _top_counts(plot_functions),
        "dominant_driving_forces": _top_counts(driving_forces),
        "core_narrative_mechanism": _core_narrative_mechanism(event_macros, payoff_macros, emotion_rhythm_types),
        "main_emotion_loop": "压迫/误读/关系危险感被持续堆叠，到阶段末通过反击、救场、揭露或关系确认释放，同时留下新的秘密、选择或权力压力。",
        "relationship_axis_summary": "主关系轴围绕被压低价值的一方如何从旧关系评价权中脱身，并在新关系/新资源介入中重建主体性与选择权。",
        "payoff_escalation_summary": "爽点从局部公开反击逐步升级到证据、身份、资源和权力结构层面的评价权反转。",
        "portable_structures": dedupe_items(
            [
                "旧关系压迫后新关系介入改写评价权",
                "公开羞辱后的证据/资源翻盘",
                "秘密揭露后关系秩序重排",
                "短周期压迫-释放并用尾钩延续下一轮期待",
            ]
        ),
        "book_specific_elements": _book_specific_character_names(character_fragments),
        "dominant_event_patterns": dominant_event_patterns,
        "dominant_payoff_patterns": dominant_payoff_patterns,
        "dominant_emotion_rhythms": dominant_emotion_rhythms,
        "candidate_counts": {
            EVENTS_LIBRARY: len(events),
            PAYOFF_ANGST: len(payoffs),
            CHARACTER_ARC: len(_library_objects(processed_book, CHARACTER_ARC)),
            EMOTION_RHYTHM: len(emotions),
            WORLDVIEW: sum(
                1
                for signature in signatures
                if isinstance(signature, dict) and signature.get("has_worldview_signal")
            ),
        },
        "reference_status": "book_level_profile_candidate",
        "reference_note": "这是单书 BookSpecificAbstract，不是跨书 UniversalReferencePattern。",
    }


def build_worldview_profile(processed_book: dict[str, Any]) -> dict[str, Any]:
    signatures = [item for item in processed_book.get("signatures") or [] if isinstance(item, dict)]
    worldview_signatures = [item for item in signatures if item.get("has_worldview_signal")]
    plot_functions: list[str] = []
    driving_forces: list[str] = []
    conflict_types: list[str] = []
    for signature in worldview_signatures:
        plot_functions.extend(as_list(signature.get("plot_function")))
        driving_forces.extend(as_list(signature.get("driving_force")))
        conflict_types.extend(as_list(signature.get("conflict_type")))

    signal_count = len(worldview_signatures)
    plot_count = len(signatures)
    stability_level = "none"
    if signal_count >= max(3, int(plot_count * 0.08)):
        stability_level = "medium"
    elif signal_count:
        stability_level = "weak"

    return {
        "schema_version": "book_worldview_profile.v1",
        "library": WORLDVIEW,
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "extraction_scope": "book",
        "reference_status": "book_level_worldview_candidate",
        "worldview_signal_plot_count": signal_count,
        "plot_count": plot_count,
        "stability_level": stability_level,
        "worldview_mechanism_summary": _worldview_mechanism_summary(
            plot_functions,
            driving_forces,
            conflict_types,
            stability_level,
        ),
        "dominant_worldview_functions": _top_counts(plot_functions),
        "dominant_driving_forces": _top_counts(driving_forces),
        "dominant_conflict_types": _top_counts(conflict_types),
        "candidate_mechanisms": _candidate_worldview_mechanisms(plot_functions, driving_forces, conflict_types),
        "role_slots": {
            "rule_system": "限制行动边界、身份权限、资源流动或代价结算的稳定规则系统",
            "power_holder": "掌握规则解释权、资源分配权或身份认证权的一方",
            "participant": "在规则内争取资源、权限或生存空间的角色",
        },
        "required_conditions": [
            "规则必须跨多个 plot 保持一致",
            "规则要改变角色可做什么、必须付出什么、能获得什么",
            "世界观机制不能只是一次普通剧情事件",
        ],
        "variation_axes": [
            "规则类型：身份权限/资源分配/组织层级/代价限制/契约约束",
            "执行方式：明示规则/默认秩序/惩罚系统/奖励系统/权力解释",
            "叙事功能：制造限制/提供反制路径/改变评价权/扩大冲突尺度",
        ],
        "evidence_plot_refs": [
            {
                "plot_id": as_text(signature.get("plot_id")),
                "plot_index": signature.get("plot_index", 0),
                "plot_function": as_list(signature.get("plot_function")),
                "driving_force": as_list(signature.get("driving_force")),
            }
            for signature in worldview_signatures[:24]
        ],
        "reference_note": "Worldview 在本系统中是书级候选资产，必须经过跨 plot 稳定性和跨书合并后才进入通用库。",
    }


def _worldview_mechanism_summary(
    plot_functions: list[str],
    driving_forces: list[str],
    conflict_types: list[str],
    stability_level: str,
) -> str:
    if stability_level == "none":
        return "本书暂未检测到足够稳定的世界观机制信号。"
    function_text = "、".join(item["value"] for item in _top_counts(plot_functions, limit=3))
    force_text = "、".join(item["value"] for item in _top_counts(driving_forces, limit=3))
    conflict_text = "、".join(item["value"] for item in _top_counts(conflict_types, limit=3))
    return (
        f"本书存在{stability_level}强度的世界观机制候选："
        f"主要通过{function_text or '规则/组织/资源展示'}呈现，"
        f"以{force_text or '身份、资源或权力结构'}驱动角色行动，"
        f"并在{conflict_text or '规则限制与选择代价'}中形成长期约束。"
    )


def _candidate_worldview_mechanisms(
    plot_functions: list[str],
    driving_forces: list[str],
    conflict_types: list[str],
) -> list[str]:
    text = "\n".join([*plot_functions, *driving_forces, *conflict_types])
    mechanisms: list[str] = []
    if any(term in text for term in ["系统", "规则", "法则", "契约", "权限"]):
        mechanisms.append("稳定规则/权限系统限制角色行动边界")
    if any(term in text for term in ["资源", "奖励", "积分", "代价", "惩罚"]):
        mechanisms.append("资源分配与代价结算机制推动选择")
    if any(term in text for term in ["家族", "组织", "宗门", "门派", "阶层", "权力"]):
        mechanisms.append("组织层级或权力结构决定评价权与资源入口")
    if any(term in text for term in ["副本", "职业", "修炼", "等级"]):
        mechanisms.append("成长/挑战体系提供阶段目标和升级路径")
    return dedupe_items(mechanisms)


def build_event_sequence(processed_book: dict[str, Any]) -> dict[str, Any]:
    events = sorted(_library_objects(processed_book, EVENTS_LIBRARY), key=_plot_index)
    sequence: list[dict[str, Any]] = []
    for item in events:
        gp = _payload(item, "generalized_payload")
        sp = _payload(item, "source_payload")
        sequence.append(
            {
                "plot_index": _plot_index(item),
                "plot_id": _source_ref(item).get("plot_id", ""),
                "template_id": gp.get("template_id", ""),
                "template_name": gp.get("template_name", ""),
                "macro_pattern": gp.get("macro_pattern", ""),
                "micro_pattern": gp.get("micro_pattern", ""),
                "event_template": gp.get("event_template", ""),
                "trigger_condition": gp.get("trigger_condition", ""),
                "consequence": gp.get("consequence", ""),
                "source_event_count": len(sp.get("source_events") or []),
            }
        )
    return {
        "schema_version": "book_event_sequence.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "event_mechanism_summary": "本书事件推进以压力显形、信息变化、新关系/资源介入和关系后果重排为主；逐 plot 事件序列保留为候选证据，不直接等同通用桥段库。",
        "portable_event_patterns": _portable_pattern_names(events, "event_template"),
        "book_specific_elements": _book_specific_character_names(events),
        "events": sequence,
    }


def build_character_arcs(processed_book: dict[str, Any]) -> list[dict[str, Any]]:
    fragments = sorted(_library_objects(processed_book, CHARACTER_ARC), key=_plot_index)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in fragments:
        gp = _payload(item, "generalized_payload")
        sp = _payload(item, "source_payload")
        slot = as_text(gp.get("character_slot") or gp.get("relationship_template") or item.get("object_type"))
        source_name = as_text(sp.get("character_name") or " / ".join(as_list(sp.get("characters"))))
        key = f"{slot}:{source_name}" if source_name else slot
        grouped[key].append(item)

    all_arcs: list[dict[str, Any]] = []
    for key, items in sorted(grouped.items(), key=lambda pair: (pair[1][0] and _plot_index(pair[1][0]), pair[0])):
        generalized = [_payload(item, "generalized_payload") for item in items]
        source_payloads = [_payload(item, "source_payload") for item in items]
        arc_templates = [as_text(item.get("arc_template") or item.get("relationship_template")) for item in generalized]
        arc_functions: list[str] = []
        for item in generalized:
            arc_functions.extend(as_list(item.get("arc_function") or item.get("relation_function")))
        plot_indexes = [_plot_index(item) for item in items]
        source_names = dedupe_items(
            [
                as_text(item.get("character_name") or " / ".join(as_list(item.get("characters"))))
                for item in source_payloads
            ]
        )
        dominant_template = _top_counts(arc_templates, limit=1)
        first_gp = generalized[0] if generalized else {}
        last_gp = generalized[-1] if generalized else {}
        slot = as_text(first_gp.get("character_slot") or first_gp.get("relationship_template") or key.split(":", 1)[0])
        preferred_template = _preferred_arc_template(generalized, slot)
        preferred_items = [
            item
            for item in items
            if as_text(_generalized(item).get("arc_template") or _generalized(item).get("relationship_template")) == preferred_template
        ] or items
        preferred_generalized = [_generalized(item) for item in preferred_items]
        first_gp = preferred_generalized[0] if preferred_generalized else first_gp
        last_gp = preferred_generalized[-1] if preferred_generalized else last_gp
        preferred_template_entry = [{"value": preferred_template, "count": len(preferred_items)}] if preferred_template else dominant_template
        all_arcs.append(
            {
                "arc_id": f"{processed_book.get('book_slug', 'book')}__arc_{len(all_arcs) + 1:04d}",
                "group_key": key,
                "character_slot": slot,
                "source_names": source_names,
                "preferred_arc_template": preferred_template,
                "dominant_arc_templates": _top_counts(arc_templates, limit=6),
                "arc_functions": dedupe_items(arc_functions),
                "fragment_count": len(items),
                "plot_span": {
                    "start_plot_index": min(plot_indexes, default=0),
                    "end_plot_index": max(plot_indexes, default=0),
                },
                "arc_summary": _arc_summary(source_names, slot, preferred_template_entry, first_gp, last_gp),
                "phase_changes": _arc_phase_changes(items),
                "portable_arc": _portable_arc(slot, preferred_template_entry, first_gp, last_gp),
                "book_specific_bindings": source_names,
                "evidence_refs": _sample_refs(items[:4] + items[-4:] if len(items) > 8 else items, limit=8),
                "reference_status": "book_character_arc_candidate",
            }
        )
    return _select_reference_arcs(all_arcs, limit=15)


def _preferred_arc_template(generalized: list[dict[str, Any]], slot: str) -> str:
    templates = [
        as_text(item.get("arc_template") or item.get("relationship_template"))
        for item in generalized
        if as_text(item.get("arc_template") or item.get("relationship_template"))
    ]
    if slot == "protagonist":
        for value, _count in Counter(templates).most_common():
            if value not in GENERIC_ARC_TEMPLATES:
                return value
    non_generic = [value for value in templates if value not in GENERIC_ARC_TEMPLATES]
    if non_generic:
        return Counter(non_generic).most_common(1)[0][0]
    return Counter(templates).most_common(1)[0][0] if templates else slot


def _arc_summary(
    source_names: list[str],
    slot: str,
    dominant_template: list[dict[str, Any]],
    first_gp: dict[str, Any],
    last_gp: dict[str, Any],
) -> str:
    name = " / ".join(source_names) or slot
    template = dominant_template[0]["value"] if dominant_template else slot
    initial = as_text(first_gp.get("initial_state") or first_gp.get("before_state"))
    final = as_text(last_gp.get("final_state") or last_gp.get("after_state"))
    if initial or final:
        return f"{name} 承担“{template}”：{initial or '初始状态'} -> {final or '最终状态'}。"
    return f"{name} 承担“{template}”的人物/关系功能。"


def _arc_phase_changes(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not items:
        return []
    sorted_items = sorted(items, key=_plot_index)
    chunks = [
        ("early", sorted_items[: max(1, len(sorted_items) // 3)]),
        ("middle", sorted_items[max(1, len(sorted_items) // 3): max(2, (len(sorted_items) * 2) // 3)]),
        ("late", sorted_items[max(2, (len(sorted_items) * 2) // 3):]),
    ]
    phases: list[dict[str, Any]] = []
    for phase_name, chunk in chunks:
        if not chunk:
            continue
        phases.append(
            {
                "phase": phase_name,
                "plot_span": {
                    "start_plot_index": min((_plot_index(item) for item in chunk), default=0),
                    "end_plot_index": max((_plot_index(item) for item in chunk), default=0),
                },
                "dominant_turning_actions": _top_counts(
                    [as_text(_generalized(item).get("turning_action") or _generalized(item).get("change_driver")) for item in chunk],
                    limit=3,
                ),
                "state_direction": _most_common_pair(chunk),
            }
        )
    return phases


def _most_common_pair(items: list[dict[str, Any]]) -> str:
    pairs = [
        " -> ".join(
            value
            for value in [
                as_text(_generalized(item).get("initial_state") or _generalized(item).get("before_state")),
                as_text(_generalized(item).get("final_state") or _generalized(item).get("after_state")),
            ]
            if value
        )
        for item in items
    ]
    values = [item for item in pairs if item]
    return Counter(values).most_common(1)[0][0] if values else ""


def _portable_arc(
    slot: str,
    dominant_template: list[dict[str, Any]],
    first_gp: dict[str, Any],
    last_gp: dict[str, Any],
) -> str:
    template = dominant_template[0]["value"] if dominant_template else slot
    initial = as_text(first_gp.get("initial_state") or first_gp.get("before_state"))
    final = as_text(last_gp.get("final_state") or last_gp.get("after_state"))
    return f"{template}：{initial or '初始关系功能'} -> {final or '终局关系功能'}。迁移时保留角色槽位、压力方向和选择结果，不保留具体人名。"


def _select_reference_arcs(arcs: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    priorities = {
        "protagonist": 1000,
        "new_relation_intervener": 900,
        "old_relation_oppressor": 920,
        "relationship_axis_character": 800,
        "antagonist_or_oppressor": 700,
        "ally_or_supporter": 600,
    }

    def score(arc: dict[str, Any]) -> tuple[int, int, str]:
        slot = as_text(arc.get("character_slot"))
        fragment_count = int(arc.get("fragment_count") or 0)
        span = arc.get("plot_span") if isinstance(arc.get("plot_span"), dict) else {}
        span_length = int(span.get("end_plot_index") or 0) - int(span.get("start_plot_index") or 0)
        template = as_text(arc.get("preferred_arc_template"))
        generic_penalty = 500 if template in GENERIC_ARC_TEMPLATES else 0
        start_index = int(span.get("start_plot_index") or 0)
        early_old_relation_bonus = max(0, 220 - start_index * 6) if slot == "old_relation_oppressor" else 0
        return (
            priorities.get(slot, 100) + fragment_count * 8 + span_length + early_old_relation_bonus - generic_penalty,
            fragment_count,
            as_text(arc.get("group_key")),
        )

    selected: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    protagonist_selected = False
    for arc in sorted(arcs, key=score, reverse=True):
        fragment_count = int(arc.get("fragment_count") or 0)
        slot = as_text(arc.get("character_slot"))
        template = as_text(arc.get("preferred_arc_template"))
        span = arc.get("plot_span") if isinstance(arc.get("plot_span"), dict) else {}
        start_index = int(span.get("start_plot_index") or 0)
        if slot == "protagonist" and protagonist_selected:
            continue
        if template in GENERIC_ARC_TEMPLATES and fragment_count < 5:
            continue
        if fragment_count < 2 and not (slot == "old_relation_oppressor" and 0 < start_index <= 3):
            continue
        names = [as_text(name) for name in as_list(arc.get("source_names")) if as_text(name)]
        primary_name = names[0] if len(names) == 1 else ""
        if primary_name and primary_name in seen_names:
            continue
        selected.append(arc)
        if slot == "protagonist":
            protagonist_selected = True
        if primary_name:
            seen_names.add(primary_name)
        if len(selected) >= limit:
            break
    return selected


def build_payoff_structure(processed_book: dict[str, Any]) -> dict[str, Any]:
    items = sorted(_library_objects(processed_book, PAYOFF_ANGST), key=_plot_index)
    beats: list[dict[str, Any]] = []
    for item in items:
        gp = _payload(item, "generalized_payload")
        beats.append(
            {
                "plot_index": _plot_index(item),
                "plot_id": _source_ref(item).get("plot_id", ""),
                "template_id": gp.get("template_id", ""),
                "pattern_name": gp.get("pattern_name", ""),
                "macro_pattern": gp.get("macro_pattern", ""),
                "micro_pattern": gp.get("micro_pattern", ""),
                "polarity": gp.get("polarity", ""),
                "pressure_setup": gp.get("pressure_setup", ""),
                "release_or_damage_action": gp.get("release_or_damage_action", ""),
                "reader_reward_or_pain": gp.get("reader_reward_or_pain", []),
            }
        )
    return {
        "schema_version": "book_payoff_structure.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "overall_payoff_mechanism": _overall_payoff_mechanism(items),
        "major_pressure_sources": _dominant_source_values(items, "pressure_source"),
        "recurring_release_methods": _dominant_values(items, "release_or_damage_action"),
        "payoff_escalation_stages": _payoff_escalation_stages(items, _max_plot_index(processed_book)),
        "long_term_reader_reward": "读者长期获得的奖赏来自主角价值被反复压低后又反复确认，新关系/新资源的正当性逐步增强，旧评价体系不断失效。",
        "portable_payoff_patterns": _portable_pattern_names(items, "transferable_form"),
        "book_specific_elements": _book_specific_character_names(items),
        "dominant_patterns": _top_counts([as_text(item.get("macro_pattern")) for item in beats]),
        "beats": beats,
    }


def _overall_payoff_mechanism(items: list[dict[str, Any]]) -> str:
    top_release = "、".join(item["value"] for item in _dominant_values(items, "release_or_damage_action", limit=3))
    top_patterns = "、".join(item["value"] for item in _dominant_values(items, "macro_pattern", limit=3))
    return (
        "主要爽虐机制是：旧关系/外部评价体系先制造可见损伤，主角阶段性承压，"
        f"再通过{top_release or '反击、救场、揭露或资源介入'}释放；"
        f"反复服务于{top_patterns or '评价权反转、安全感确认和认知反转'}。"
    )


def _payoff_escalation_stages(items: list[dict[str, Any]], plot_count: int) -> list[dict[str, Any]]:
    stages: list[dict[str, Any]] = []
    stage_summaries = {
        "opening_pressure_setup": "建立初始背叛/压迫和读者替主角不值的情绪底盘。",
        "early_relation_and_pressure_loop": "反复使用局部公开压迫与局部释放，巩固新关系/新资源的介入价值。",
        "middle_reveal_and_crisis_expansion": "增加秘密揭露、危机救场和权力压力，让爽点从局部打脸转向认知反转。",
        "late_power_reversal_and_binding": "把评价权反转升级为资源、身份或关系绑定层面的格局变化。",
        "final_settlement": "完成旧秩序清算、关系确认或长线情绪补偿。",
    }
    for phase in _phase_ranges(plot_count):
        phase_items = _items_in_range(items, phase["start"], phase["end"])
        stages.append(
            {
                "phase_id": phase["phase_id"],
                "phase_name": phase["phase_name"],
                "plot_span": {"start_plot_index": phase["start"], "end_plot_index": phase["end"]},
                "stage_summary": stage_summaries.get(phase["phase_name"], "阶段性压力与释放循环。"),
                "dominant_payoff_patterns": _dominant_values(phase_items, "macro_pattern"),
                "dominant_micro_patterns": _dominant_values(phase_items, "micro_pattern", limit=5),
                "pressure_sources": _dominant_source_values(phase_items, "pressure_source", limit=5),
                "release_methods": _dominant_values(phase_items, "release_or_damage_action", limit=5),
                "support_count": len(phase_items),
            }
        )
    return stages


def build_emotion_curve(processed_book: dict[str, Any]) -> dict[str, Any]:
    items = sorted(_library_objects(processed_book, EMOTION_RHYTHM), key=_plot_index)
    curve: list[dict[str, Any]] = []
    for item in items:
        gp = _payload(item, "generalized_payload")
        curve.append(
            {
                "plot_index": _plot_index(item),
                "plot_id": _source_ref(item).get("plot_id", ""),
                "template_id": gp.get("template_id", ""),
                "emotion_pattern_name": gp.get("emotion_pattern_name", ""),
                "rhythm_type": gp.get("rhythm_type", ""),
                "tension_accumulation": gp.get("tension_accumulation", ""),
                "release_position": gp.get("release_position", ""),
                "reader_state_change": gp.get("reader_state_change", ""),
                "emotional_core": gp.get("emotional_core", ""),
            }
        )
    return {
        "schema_version": "book_emotion_curve.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "overall_emotion_mechanism": "本书以短周期压迫-释放为基础节奏，用关系升温、秘密揭露和尾钩把单轮爽感连接成长线期待。",
        "phase_curve": _emotion_phase_curve(items, _max_plot_index(processed_book)),
        "portable_emotion_patterns": _portable_pattern_names(items, "emotion_pattern_name"),
        "book_specific_elements": _book_specific_character_names(items),
        "dominant_rhythm_types": _top_counts([as_text(item.get("rhythm_type")) for item in curve]),
        "curve": curve,
    }


def _emotion_phase_curve(items: list[dict[str, Any]], plot_count: int) -> list[dict[str, Any]]:
    phase_summaries = {
        "opening_pressure_setup": "开篇通过背叛、压迫或危险关系建立羞辱感/危险感，并给出第一轮反击或保护确认。",
        "early_relation_and_pressure_loop": "多线压力循环出现，读者在压抑、期待反击和关系安全感之间往复。",
        "middle_reveal_and_crisis_expansion": "秘密、误读和危机增加，情绪从单点爽感扩展到认知反转与关系不确定。",
        "late_power_reversal_and_binding": "权力结构反制和关系绑定加深，情绪重心从局部释放转向稳定补偿。",
        "final_settlement": "终局阶段完成旧秩序清算和关系确认，提供长线情绪补偿。",
    }
    phases: list[dict[str, Any]] = []
    for phase in _phase_ranges(plot_count):
        phase_items = _items_in_range(items, phase["start"], phase["end"])
        phases.append(
            {
                "phase_id": phase["phase_id"],
                "phase_name": phase["phase_name"],
                "plot_span": {"start_plot_index": phase["start"], "end_plot_index": phase["end"]},
                "emotion_summary": phase_summaries.get(phase["phase_name"], "阶段性情绪推进。"),
                "dominant_rhythm_types": _dominant_values(phase_items, "rhythm_type"),
                "dominant_reader_state_changes": _dominant_values(phase_items, "reader_state_change", limit=5),
                "dominant_emotional_cores": _dominant_values(phase_items, "emotional_core", limit=5),
                "support_count": len(phase_items),
            }
        )
    return phases


def build_logic_graph_summary(processed_book: dict[str, Any]) -> dict[str, Any]:
    graph = processed_book.get("book_graph") if isinstance(processed_book.get("book_graph"), dict) else {}
    edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    return {
        "schema_version": "book_logic_graph_summary.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "graph_id": graph.get("graph_id", ""),
        "graph_schema_version": graph.get("schema_version", ""),
        "node_types": _top_counts([as_text(node.get("node_type")) for node in nodes if isinstance(node, dict)], limit=20),
        "edge_types": _top_counts([as_text(edge.get("edge_type")) for edge in edges if isinstance(edge, dict)], limit=20),
        "logic_status": "narrative_index_graph_v1",
        "next_logic_edges": ["causes", "foreshadows", "pays_off", "reframes", "motivates", "resolves"],
    }


def build_book_level_reference(processed_book: dict[str, Any]) -> dict[str, Any]:
    return {
        "book_profile": build_book_profile(processed_book),
        "event_sequence": build_event_sequence(processed_book),
        "character_arcs": build_character_arcs(processed_book),
        "payoff_structure": build_payoff_structure(processed_book),
        "emotion_curve": build_emotion_curve(processed_book),
        "worldview_profile": build_worldview_profile(processed_book),
        "logic_graph_summary": build_logic_graph_summary(processed_book),
    }
