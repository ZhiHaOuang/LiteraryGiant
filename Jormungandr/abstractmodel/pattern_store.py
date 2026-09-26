from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import as_list, as_mapping, as_text, canonical_book_slug, dedupe_items

from .instance_cards import build_source_ref, normalize_instance_card, upgrade_reference_instance
from .schemas import AUTOMATED_PATTERN_LIBRARIES


ALLOWED_DECISIONS = {"merge_existing", "enrich_existing", "create_new", "reject", "needs_more_evidence"}
STRUCTURAL_NOVELTY_DIMENSIONS = {
    "causal_order",
    "core_mechanism",
    "role_power_structure",
    "reader_effect_mechanism",
    "constraint_or_cost",
    "state_change_type",
    "narrative_scope",
}
NON_STRUCTURAL_NOVELTY_TERMS = {"setting", "genre", "name", "profession", "prop", "intensity", "场景", "题材", "人名", "职业", "道具", "强度"}
WORLDVIEW_SYSTEM_TERMS = (
    "规则",
    "法则",
    "制度",
    "准入",
    "资格",
    "权限",
    "身份限制",
    "契约",
    "资源分配",
    "奖励机制",
    "惩罚机制",
    "法律程序",
    "组织层级",
    "周期",
    "筛选",
    "强制更替",
)
WORLDVIEW_DIMENSION_TERMS = {
    "rule_or_institution": ("规则", "法则", "制度", "周期", "筛选", "契约", "法律程序"),
    "permission_or_resource": ("准入", "资格", "权限", "资源分配", "身份限制"),
    "hierarchy_or_evaluation": ("组织层级", "阶层", "评价系统", "神权", "高位操控者"),
    "enforcement_or_cost": ("惩罚", "强制", "代价", "牺牲", "消亡", "淘汰"),
}


def load_existing_patterns(root: str | Path) -> dict[str, list[dict[str, Any]]]:
    root = Path(root)
    result = {library: [] for library in AUTOMATED_PATTERN_LIBRARIES}
    for library in AUTOMATED_PATTERN_LIBRARIES:
        seen: set[str] = set()
        for filename in ("universal_patterns.jsonl", "emerging_patterns.jsonl"):
            for row in read_jsonl(root / library / filename):
                pattern_id = as_text(row.get("pattern_id"))
                stable_key = pattern_id or _semantic_key(row)
                if stable_key and stable_key not in seen:
                    result[library].append(row)
                    seen.add(stable_key)
    return result


def shortlist_patterns(
    candidates: list[dict[str, Any]],
    existing: dict[str, list[dict[str, Any]]],
    *,
    top_k: int = 6,
) -> dict[str, list[dict[str, Any]]]:
    by_library: dict[str, list[dict[str, Any]]] = {}
    for library in sorted({as_text(item.get("library")) for item in candidates if as_text(item.get("library"))}):
        library_candidates = [item for item in candidates if as_text(item.get("library")) == library]
        query_terms = _terms(library_candidates)
        scored = [(_jaccard(query_terms, _terms(row)), row) for row in existing.get(library) or []]
        scored.sort(key=lambda pair: (-pair[0], as_text(pair[1].get("pattern_id"))))
        rows = [row for _, row in scored[:top_k]]
        by_library[library] = [_pattern_brief(row) for row in rows]
    return by_library


def validate_reconciliation(
    response: dict[str, Any],
    *,
    candidates: list[dict[str, Any]],
    existing: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    candidate_by_id = {as_text(row.get("candidate_id")): row for row in candidates if as_text(row.get("candidate_id"))}
    existing_by_id = {
        as_text(row.get("pattern_id")): row
        for rows in existing.values()
        for row in rows
        if as_text(row.get("pattern_id"))
    }
    validated: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in response.get("decisions") or []:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        candidate_id = as_text(row.get("candidate_id"))
        candidate = candidate_by_id.get(candidate_id)
        if not candidate or candidate_id in seen:
            continue
        seen.add(candidate_id)
        decision = as_text(row.get("decision"))
        reasons: list[str] = []
        if decision not in ALLOWED_DECISIONS:
            decision = "reject"
            reasons.append("invalid_decision")
        target_id = as_text(row.get("target_pattern_id"))
        if decision in {"merge_existing", "enrich_existing"} and target_id not in existing_by_id:
            decision = "needs_more_evidence"
            reasons.append("target_pattern_not_found")
        if decision == "create_new":
            dimensions = _structural_dimensions(row.get("novelty_dimensions"))
            differences = [as_text(value) for value in as_list(row.get("nearest_pattern_differences")) if as_text(value)]
            proposed = _complete_proposed_pattern(as_mapping(row.get("proposed_pattern")), candidate)
            row["proposed_pattern"] = proposed
            if len(dimensions) < 2:
                decision = "needs_more_evidence"
                reasons.append("fewer_than_two_structural_novelty_dimensions")
            if existing.get(as_text(candidate.get("library"))) and not differences:
                decision = "needs_more_evidence"
                reasons.append("missing_nearest_pattern_differences")
            if not as_text(proposed.get("pattern_name")) or not as_text(proposed.get("core_mechanism")):
                decision = "needs_more_evidence"
                reasons.append("incomplete_proposed_pattern")
            near_duplicate = _nearest_local_duplicate(proposed, existing.get(as_text(candidate.get("library"))) or [])
            if near_duplicate and near_duplicate[0] >= 0.72:
                decision = "needs_more_evidence"
                reasons.append(f"local_near_duplicate:{as_text(near_duplicate[1].get('pattern_id'))}")
        worldview_reason = _worldview_evidence_reason(candidate)
        if worldview_reason and decision in {"merge_existing", "enrich_existing", "create_new"}:
            decision = "needs_more_evidence"
            reasons.append(worldview_reason)
        evidence_ids = set(as_list(candidate.get("evidence_chunk_ids")))
        decision_evidence = set(as_list(row.get("evidence_chunk_ids")))
        if decision_evidence and not decision_evidence.issubset(evidence_ids):
            row["evidence_chunk_ids"] = sorted(evidence_ids)
            reasons.append("invalid_decision_evidence_trimmed")
        row["decision"] = decision
        row["validation_reasons"] = reasons
        row["candidate"] = candidate
        validated.append(row)

    for candidate_id, candidate in candidate_by_id.items():
        if candidate_id in seen:
            continue
        validated.append(
            {
                "candidate_id": candidate_id,
                "library": candidate.get("library", ""),
                "decision": "needs_more_evidence",
                "reason": "LLM response omitted this candidate",
                "validation_reasons": ["missing_llm_decision"],
                "candidate": candidate,
            }
        )
    return {
        "schema_version": "bridge_reconciliation_validated.v3",
        "book_id": response.get("book_id", ""),
        "window_id": response.get("window_id", ""),
        "decisions": validated,
        "decision_counts": _counts(validated, "decision"),
    }


def commit_validated_decisions(
    validated_rows: list[dict[str, Any]],
    *,
    abstract_library_root: str | Path,
    book_id: str,
) -> dict[str, int]:
    """Commit one book as deduplicated instances plus strictly gated patterns."""
    root = Path(abstract_library_root)
    counts = {
        "merged": 0,
        "enriched": 0,
        "created": 0,
        "instances_added": 0,
        "instances_duplicate": 0,
        "instances_reassigned": 0,
        "instances_enriched": 0,
        "patterns_pruned": 0,
        "held": 0,
    }
    pattern_layers: dict[str, dict[str, list[dict[str, Any]]]] = {}
    instances_by_library: dict[str, list[dict[str, Any]]] = {}
    for library in AUTOMATED_PATTERN_LIBRARIES:
        pattern_layers[library] = {
            "emerging": read_jsonl(root / library / "emerging_patterns.jsonl"),
            "universal": read_jsonl(root / library / "universal_patterns.jsonl"),
        }
        instances_by_library[library] = [
            upgrade_reference_instance(row, library=library)
            for row in read_jsonl(root / library / "instances.jsonl")
        ]
    instance_ids = {
        library: {as_text(row.get("instance_id")) for row in rows if as_text(row.get("instance_id"))}
        for library, rows in instances_by_library.items()
    }
    changed_libraries: set[str] = set()
    for row in validated_rows:
        decision = as_text(row.get("decision"))
        library = as_text(row.get("library")) or as_text(as_mapping(row.get("candidate")).get("library"))
        if library not in pattern_layers:
            continue
        pattern_id = ""
        if decision in {"merge_existing", "enrich_existing"}:
            pattern_id = as_text(row.get("target_pattern_id"))
            target, layer = _find_pattern(pattern_id, pattern_layers[library])
            if target is None:
                counts["held"] += 1
                continue
            if decision == "enrich_existing" and layer == "emerging":
                proposed = as_mapping(row.get("proposed_pattern"))
                target["variation_axes"] = dedupe_items([*as_list(target.get("variation_axes")), *as_list(proposed.get("variation_axes"))])[:24]
                target["failure_risks"] = dedupe_items([*as_list(target.get("failure_risks")), *as_list(proposed.get("failure_risks"))])[:20]
                counts["enriched"] += 1
            else:
                counts["merged"] += 1
        elif decision == "create_new":
            proposed = _complete_proposed_pattern(
                as_mapping(row.get("proposed_pattern")),
                as_mapping(row.get("candidate")),
            )
            if not proposed:
                counts["held"] += 1
                continue
            all_rows = [
                *pattern_layers[library]["emerging"],
                *pattern_layers[library]["universal"],
            ]
            near_duplicate = _nearest_local_duplicate(proposed, all_rows)
            if near_duplicate and near_duplicate[0] >= 0.72:
                pattern_id = as_text(near_duplicate[1].get("pattern_id"))
                row = dict(row)
                row["decision"] = "merge_existing"
                row["reason"] = (
                    f"new_pattern_deduplicated_to:{pattern_id}; "
                    f"local_similarity={near_duplicate[0]:.4f}"
                )
                counts["merged"] += 1
            else:
                pattern_id = _next_pattern_id(library, all_rows)
                proposed.update(
                    {
                        "schema_version": "reference_pattern_cluster.v2",
                        "pattern_id": pattern_id,
                        "library": library,
                        "pattern_scope": "EmergingPatterns",
                        "pattern_status": "book_evidence",
                        "supported_books": [canonical_book_slug(book_id)],
                        "supported_book_count": 1,
                        "registered_instance_count": 0,
                        "evidence_refs": _evidence_refs(row),
                        "curation": {
                            "source": "bridge_first_llm",
                            "novelty_dimensions": as_list(row.get("novelty_dimensions")),
                            "nearest_pattern_id": as_text(row.get("nearest_pattern_id")),
                            "nearest_pattern_differences": as_list(row.get("nearest_pattern_differences")),
                        },
                    }
                )
                pattern_layers[library]["emerging"].append(proposed)
                counts["created"] += 1
        else:
            counts["held"] += 1
            continue

        instance = _build_instance(row, library=library, pattern_id=pattern_id, book_id=book_id)
        instance_id = as_text(instance.get("instance_id"))
        source_key = _instance_source_key(instance)
        source_matches = [
            existing_instance
            for existing_instance in instances_by_library[library]
            if source_key and _instance_source_key(existing_instance) == source_key
        ]
        id_matches = [
            existing_instance
            for existing_instance in instances_by_library[library]
            if instance_id and as_text(existing_instance.get("instance_id")) == instance_id
        ]
        if source_matches and (
            len(source_matches) > 1
            or any(as_text(existing_instance.get("pattern_id")) != pattern_id for existing_instance in source_matches)
        ):
            instances_by_library[library] = [
                existing_instance
                for existing_instance in instances_by_library[library]
                if _instance_source_key(existing_instance) != source_key
            ]
            instance_ids[library].difference_update(
                as_text(existing_instance.get("instance_id"))
                for existing_instance in source_matches
            )
            instances_by_library[library].append(instance)
            instance_ids[library].add(instance_id)
            counts["instances_reassigned"] += 1
        elif source_matches:
            existing_instance = source_matches[0]
            if _instance_card_rank(instance) > _instance_card_rank(existing_instance):
                instances_by_library[library] = [
                    instance if existing is existing_instance else existing
                    for existing in instances_by_library[library]
                ]
                counts["instances_enriched"] += 1
            else:
                counts["instances_duplicate"] += 1
        elif id_matches:
            existing_instance = id_matches[0]
            if _instance_card_rank(instance) > _instance_card_rank(existing_instance):
                instances_by_library[library] = [
                    instance if existing is existing_instance else existing
                    for existing in instances_by_library[library]
                ]
                counts["instances_enriched"] += 1
            else:
                counts["instances_duplicate"] += 1
        else:
            instances_by_library[library].append(instance)
            instance_ids[library].add(instance_id)
            counts["instances_added"] += 1
        changed_libraries.add(library)

    for library in sorted(changed_libraries):
        _refresh_pattern_support(pattern_layers[library], instances_by_library[library])
        active_pattern_ids = {
            as_text(instance.get("pattern_id"))
            for instance in instances_by_library[library]
            if as_text(instance.get("pattern_id"))
        }
        before = len(pattern_layers[library]["emerging"])
        pattern_layers[library]["emerging"] = [
            pattern
            for pattern in pattern_layers[library]["emerging"]
            if (
                as_text(pattern.get("pattern_id")) in active_pattern_ids
                or as_text(as_mapping(pattern.get("curation")).get("source")) != "bridge_first_llm"
            )
        ]
        counts["patterns_pruned"] += before - len(pattern_layers[library]["emerging"])
        write_jsonl_atomic(root / library / "emerging_patterns.jsonl", pattern_layers[library]["emerging"])
        write_jsonl_atomic(root / library / "universal_patterns.jsonl", pattern_layers[library]["universal"])
        write_jsonl_atomic(root / library / "instances.jsonl", instances_by_library[library])
    return counts


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def write_jsonl_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    text = "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows)
    temp.write_text(text + ("\n" if text else ""), encoding="utf-8")
    temp.replace(path)


def _pattern_brief(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "pattern_id": row.get("pattern_id", ""),
        "pattern_name": row.get("pattern_name", ""),
        "definition": row.get("definition", ""),
        "core_mechanism": row.get("core_mechanism", ""),
        "required_conditions": as_list(row.get("required_conditions"))[:8],
        "variation_axes": as_list(row.get("variation_axes"))[:8],
        "failure_risks": as_list(row.get("failure_risks"))[:6],
        "supported_book_count": row.get("supported_book_count", 0),
        "arc_scope": row.get("arc_scope", ""),
        "rhythm_scope": row.get("rhythm_scope", ""),
        "rule_scope": row.get("rule_scope", ""),
    }


def _terms(value: object) -> set[str]:
    text = "".join(_flatten_text(value))
    result = {token.lower() for token in re.findall(r"[A-Za-z0-9_]{2,}", text)}
    chinese = "".join(char for char in text if "\u4e00" <= char <= "\u9fff")
    for size in (2, 3):
        result.update(chinese[index:index + size] for index in range(max(0, len(chinese) - size + 1)))
    return result


def _flatten_text(value: object) -> list[str]:
    if isinstance(value, dict):
        return [text for child in value.values() for text in _flatten_text(child)]
    if isinstance(value, list):
        return [text for child in value for text in _flatten_text(child)]
    text = as_text(value)
    return [text] if text else []


def _jaccard(left: set[str], right: set[str]) -> float:
    return len(left & right) / len(left | right) if left and right else 0.0


def _structural_dimensions(value: object) -> list[str]:
    result: list[str] = []
    raw_values = value if isinstance(value, list) else as_list(value)
    for raw in raw_values:
        if isinstance(raw, dict):
            dimension_name = as_text(raw.get("dimension")).strip().lower()
            difference = as_text(raw.get("difference") or raw.get("description"))
            text = dimension_name
        else:
            text = as_text(raw).strip().lower()
        if not text or text in NON_STRUCTURAL_NOVELTY_TERMS:
            continue
        normalized = {
            "因果顺序": "causal_order",
            "核心机制": "core_mechanism",
            "角色权力结构": "role_power_structure",
            "读者效果机制": "reader_effect_mechanism",
            "约束或代价": "constraint_or_cost",
            "状态变化类型": "state_change_type",
        }.get(text, _dimension_from_description(text))
        if isinstance(raw, dict) and normalized not in STRUCTURAL_NOVELTY_DIMENSIONS:
            normalized = _dimension_from_description(f"{dimension_name} {difference}".strip().lower())
        if normalized in STRUCTURAL_NOVELTY_DIMENSIONS and normalized not in result:
            result.append(normalized)
    return result


def _worldview_evidence_reason(candidate: dict[str, Any]) -> str:
    if as_text(candidate.get("library")) != "Worldview":
        return ""
    evidence_ids = {as_text(value) for value in as_list(candidate.get("evidence_chunk_ids")) if as_text(value)}
    if len(evidence_ids) < 2:
        return "worldview_requires_two_distinct_plot_evidence"
    mechanism = candidate.get("mechanism") if isinstance(candidate.get("mechanism"), dict) else {}
    source_text = " ".join(
        _flatten_text(
            {
                "candidate_name": candidate.get("candidate_name"),
                "mechanism": mechanism,
                "role_slots": candidate.get("role_slots"),
                "required_conditions": candidate.get("required_conditions"),
            }
        )
    )
    if not any(term in source_text for term in WORLDVIEW_SYSTEM_TERMS):
        return "worldview_missing_stable_rule_permission_or_resource_mechanism"
    dimensions = [
        name
        for name, terms in WORLDVIEW_DIMENSION_TERMS.items()
        if any(term in source_text for term in terms)
    ]
    if len(dimensions) < 2:
        return "worldview_requires_two_structural_system_dimensions"
    if len(evidence_ids) == 2 and _score(candidate.get("confidence")) < 0.85:
        return "worldview_two_plot_evidence_requires_high_confidence"
    return ""


def _dimension_from_description(text: str) -> str:
    if any(term in text for term in ("scope", "阶段", "全书", "全局", "宏观", "书级", "stage_curve", "book_curve")):
        return "narrative_scope"
    if any(term in text for term in ("规则", "法则", "周期", "筛选", "操控", "更替", "干预", "控制", "系统")):
        return "core_mechanism"
    if "因果" in text or "顺序" in text:
        return "causal_order"
    if any(term in text for term in ("角色", "权力", "三方", "评价权", "组织", "集体", "掌控者", "参与者")):
        return "role_power_structure"
    if any(term in text for term in ("读者", "情绪", "爽感", "痛感", "悬念", "reader_effect", "emotional_focus")):
        return "reader_effect_mechanism"
    if "代价" in text or "约束" in text or "成本" in text or "限制" in text or "牺牲" in text:
        return "constraint_or_cost"
    if "状态" in text or "转变" in text or "从被动" in text or "主动" in text:
        return "state_change_type"
    if any(term in text for term in ("机制", "结构", "耦合", "信任", "情感", "关系", "推力", "驱动", "回路")):
        return "core_mechanism"
    return text


def _score(value: object) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _nearest_local_duplicate(proposed: dict[str, Any], rows: list[dict[str, Any]]) -> tuple[float, dict[str, Any]] | None:
    if not rows:
        return None
    proposed_name = _normalized_pattern_name(proposed.get("pattern_name"))
    if proposed_name:
        same_name = [row for row in rows if _normalized_pattern_name(row.get("pattern_name")) == proposed_name]
        if same_name:
            return 1.0, same_name[0]
    proposed_terms = _terms(
        {
            "name": proposed.get("pattern_name"),
            "definition": proposed.get("definition"),
            "mechanism": proposed.get("core_mechanism"),
        }
    )
    scored = [(_jaccard(proposed_terms, _terms(_pattern_brief(row))), row) for row in rows]
    return max(scored, key=lambda pair: pair[0])


def _normalized_pattern_name(value: object) -> str:
    return re.sub(r"\s+", "", as_text(value)).lower()


def _semantic_key(row: dict[str, Any]) -> str:
    return "|".join([as_text(row.get("library")), as_text(row.get("pattern_name")), as_text(row.get("core_mechanism"))])


def _instance_source_key(row: dict[str, Any]) -> str:
    candidate_id = as_text(row.get("candidate_id"))
    if not candidate_id:
        return ""
    book_slug = canonical_book_slug(
        as_text(row.get("book_slug")) or as_text(row.get("book_id"))
    )
    return f"{book_slug}|{candidate_id}"


def _instance_card_rank(row: dict[str, Any]) -> tuple[int, float]:
    card = as_mapping(row.get("instance_card"))
    mode = as_text(card.get("grounding_mode"))
    quality = as_mapping(card.get("card_quality"))
    try:
        completeness = float(quality.get("completeness") or 0.0)
    except (TypeError, ValueError):
        completeness = 0.0
    return (1 if mode == "llm_grounded" else 0, completeness)


def _complete_proposed_pattern(
    proposed: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    result = dict(proposed)
    mechanism = as_mapping(candidate.get("mechanism"))
    trigger = as_text(mechanism.get("trigger"))
    pressure = as_text(mechanism.get("pressure"))
    actions = [as_text(value) for value in as_list(mechanism.get("action_chain")) if as_text(value)]
    state_change = as_text(mechanism.get("state_change"))
    reader_effect = as_text(mechanism.get("reader_effect"))
    mechanism_parts = [
        f"触发：{trigger}" if trigger else "",
        f"压力：{pressure}" if pressure else "",
        f"行动：{' -> '.join(actions)}" if actions else "",
        f"变化：{state_change}" if state_change else "",
    ]
    candidate_mechanism = "；".join(part for part in mechanism_parts if part)
    defaults = {
        "pattern_name": as_text(candidate.get("candidate_name")),
        "core_mechanism": candidate_mechanism,
        "definition": result.get("core_mechanism") or candidate_mechanism,
        "role_slots": as_mapping(candidate.get("role_slots")),
        "required_conditions": as_list(candidate.get("required_conditions")),
        "variation_axes": as_list(candidate.get("variation_axes")),
        "failure_risks": as_list(candidate.get("failure_risks")),
        "reader_effect": reader_effect,
        "arc_scope": candidate.get("arc_scope", ""),
        "rhythm_scope": candidate.get("rhythm_scope", ""),
        "rule_scope": candidate.get("rule_scope", ""),
        "enforcement_mechanism": candidate.get("enforcement_mechanism", ""),
        "resource_distribution_logic": candidate.get("resource_distribution_logic", ""),
        "cost_model": candidate.get("cost_model", ""),
        "who_benefits": candidate.get("who_benefits", ""),
        "who_is_constrained": candidate.get("who_is_constrained", ""),
        "story_conflicts_enabled": as_list(candidate.get("story_conflicts_enabled")),
    }
    for key, value in defaults.items():
        if result.get(key) in (None, "", [], {}):
            result[key] = value
    proposed_name = as_text(result.get("pattern_name"))
    candidate_name = as_text(candidate.get("candidate_name"))
    if proposed_name and not re.search(r"[\u4e00-\u9fff]", proposed_name) and re.search(r"[\u4e00-\u9fff]", candidate_name):
        result["pattern_name"] = candidate_name
    for key in ("canonical_archetype", "archetype_family"):
        value = _canonical_slug(result.get(key))
        if value:
            result[key] = value
        else:
            result.pop(key, None)
    return result


def _canonical_slug(value: object) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", as_text(value).lower()).strip("_")
    if not text or text.startswith(("candidate_", "emerging_")):
        return ""
    return text[:80]


def _counts(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        value = as_text(row.get(key)) or "unknown"
        counts[value] = counts.get(value, 0) + 1
    return counts


def _find_pattern(
    pattern_id: str,
    layers: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any] | None, str]:
    for layer in ("emerging", "universal"):
        for row in layers.get(layer) or []:
            if as_text(row.get("pattern_id")) == pattern_id:
                return row, layer
    return None, ""


def _build_instance(
    decision: dict[str, Any],
    *,
    library: str,
    pattern_id: str,
    book_id: str,
) -> dict[str, Any]:
    candidate = as_mapping(decision.get("candidate"))
    evidence_chunk_ids = sorted(as_list(candidate.get("evidence_chunk_ids")))
    source_key = "+".join(_id_part(value) for value in evidence_chunk_ids) or _id_part(candidate.get("candidate_id"))
    book_slug = canonical_book_slug(book_id)
    mechanism = candidate.get("mechanism") if isinstance(candidate.get("mechanism"), dict) else {}
    role_slots = candidate.get("role_slots") if isinstance(candidate.get("role_slots"), dict) else {}
    return {
        "schema_version": "reference_pattern_instance.v2",
        "instance_id": f"{library}:{book_slug}:{pattern_id}:{source_key}",
        "library": library,
        "pattern_id": pattern_id,
        "book_id": book_slug,
        "book_slug": book_slug,
        "candidate_id": candidate.get("candidate_id", ""),
        "candidate_name": candidate.get("candidate_name", ""),
        "mechanism": mechanism,
        "role_slots": role_slots,
        "required_conditions": as_list(candidate.get("required_conditions")),
        "variation_axes": as_list(candidate.get("variation_axes")),
        "failure_risks": as_list(candidate.get("failure_risks")),
        "arc_scope": candidate.get("arc_scope", ""),
        "rhythm_scope": candidate.get("rhythm_scope", ""),
        "rule_scope": candidate.get("rule_scope", ""),
        "enforcement_mechanism": candidate.get("enforcement_mechanism", ""),
        "resource_distribution_logic": candidate.get("resource_distribution_logic", ""),
        "cost_model": candidate.get("cost_model", ""),
        "who_benefits": candidate.get("who_benefits", ""),
        "who_is_constrained": candidate.get("who_is_constrained", ""),
        "story_conflicts_enabled": as_list(candidate.get("story_conflicts_enabled")),
        "instance_card": normalize_instance_card(
            candidate.get("instance_card"),
            library=library,
            mechanism=mechanism,
            role_slots=role_slots,
            failure_risks=candidate.get("failure_risks"),
            evidence_chunk_ids=evidence_chunk_ids,
            library_context=candidate,
        ),
        "evidence_chunk_ids": evidence_chunk_ids,
        "source_ref": build_source_ref(
            book_slug=book_slug,
            evidence_chunk_ids=evidence_chunk_ids,
        ),
        "confidence": candidate.get("confidence", decision.get("confidence", 0.0)),
        "assignment_decision": decision.get("decision", ""),
        "assignment_reason": decision.get("reason", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _refresh_pattern_support(
    layers: dict[str, list[dict[str, Any]]],
    instances: list[dict[str, Any]],
) -> None:
    by_pattern: dict[str, list[dict[str, Any]]] = {}
    for instance in instances:
        pattern_id = as_text(instance.get("pattern_id"))
        if pattern_id:
            by_pattern.setdefault(pattern_id, []).append(instance)
    for rows in layers.values():
        for pattern in rows:
            pattern_id = as_text(pattern.get("pattern_id"))
            registered = by_pattern.get(pattern_id) or []
            books = dedupe_items(
                [
                    *as_list(pattern.get("supported_books")),
                    *[as_text(row.get("book_slug")) for row in registered if as_text(row.get("book_slug"))],
                ]
            )
            pattern["supported_books"] = books
            pattern["supported_book_count"] = len(books)
            pattern["registered_instance_count"] = len(registered)
            existing_refs = [row for row in pattern.get("evidence_refs") or [] if isinstance(row, dict)]
            new_refs = [
                {"instance_id": row.get("instance_id", ""), "evidence_chunk_ids": row.get("evidence_chunk_ids", [])}
                for row in registered
            ]
            pattern["evidence_refs"] = _dedupe_evidence_refs([*existing_refs, *new_refs])[-80:]


def _dedupe_evidence_refs(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for row in rows:
        key = as_text(row.get("instance_id")) or json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            result.append(row)
            seen.add(key)
    return result


def _id_part(value: object) -> str:
    return re.sub(r"[^A-Za-z0-9_.+-]+", "_", as_text(value)).strip("_") or "unknown"


def _evidence_refs(row: dict[str, Any]) -> list[dict[str, Any]]:
    candidate = as_mapping(row.get("candidate"))
    return [
        {"chunk_id": chunk_id, "candidate_id": candidate.get("candidate_id", "")}
        for chunk_id in as_list(candidate.get("evidence_chunk_ids"))
        if as_text(chunk_id)
    ]


def _next_pattern_id(library: str, rows: list[dict[str, Any]]) -> str:
    prefix = {
        "CharacterArc": "arc",
        "EmotionRhythm": "emotion",
        "EventsLibrary": "event",
        "PayoffAngst": "payoff",
        "Worldview": "worldview",
    }.get(library, "pattern")
    numbers: list[int] = []
    for row in rows:
        match = re.search(r"(\d+)$", as_text(row.get("pattern_id")))
        if match:
            numbers.append(int(match.group(1)))
    return f"emerging_{prefix}_{max(numbers, default=0) + 1:04d}"
