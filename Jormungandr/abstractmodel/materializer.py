from __future__ import annotations

import json
import re
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import as_list, as_mapping, as_text

from .audit_reports import build_worldview_threshold_report, write_json_report
from .instance_cards import upgrade_reference_instance
from .pattern_refinement import LIBRARY_SPECS, refine_pattern, taxonomy_for_pattern
from .pattern_store import read_jsonl, write_jsonl_atomic
from .schemas import AUTOMATED_PATTERN_LIBRARIES


MATERIALIZE_SCHEMA_VERSION = "abstractlibrary_materialized.v4"
RELATION_TYPES = {
    ("EventsLibrary", "PayoffAngst"): "event_can_trigger_payoff",
    ("EventsLibrary", "CharacterArc"): "event_can_drive_arc",
    ("EventsLibrary", "EmotionRhythm"): "event_can_create_rhythm_beat",
    ("PayoffAngst", "EmotionRhythm"): "payoff_can_be_scheduled_by_rhythm",
    ("CharacterArc", "PayoffAngst"): "arc_can_amplify_payoff",
    ("Worldview", "EventsLibrary"): "worldview_can_enable_event",
    ("Worldview", "CharacterArc"): "worldview_can_constrain_arc",
    ("Worldview", "PayoffAngst"): "worldview_can_shape_payoff",
}
def materialize_abstract_library(
    *,
    source_root: str | Path,
    output_root: str | Path,
) -> dict[str, Any]:
    source_root = Path(source_root)
    output_root = Path(output_root)
    generated_at = datetime.now(timezone.utc).isoformat()
    previous_index = read_jsonl(output_root / "pattern_index.jsonl")
    previous_by_source = {
        as_text(row.get("source_pattern_id")): row
        for row in previous_index
        if as_text(row.get("source_pattern_id"))
    }
    legacy_map_path = output_root / "_routing" / "legacy_path_map.jsonl"
    persistent_legacy_by_source = {
        as_text(row.get("source_pattern_id")): as_text(row.get("legacy_path"))
        for row in read_jsonl(legacy_map_path)
        if as_text(row.get("source_pattern_id")) and as_text(row.get("legacy_path"))
    }
    source_rows = _source_patterns(source_root)
    source_instances: dict[str, list[dict[str, Any]]] = {}
    migrate_canonical_instances = source_root.resolve() == output_root.resolve()
    for library in AUTOMATED_PATTERN_LIBRARIES:
        path = source_root / library / "instances.jsonl"
        stored = read_jsonl(path)
        upgraded = [upgrade_reference_instance(row, library=library) for row in stored]
        source_instances[library] = upgraded
        if migrate_canonical_instances and upgraded != stored:
            write_jsonl_atomic(path, upgraded)
    materialized_rows: list[dict[str, Any]] = []
    pattern_payloads: dict[str, dict[str, Any]] = {}
    reviews: dict[str, dict[str, Any]] = {}
    all_instances: list[dict[str, Any]] = []
    library_indexes: dict[str, list[dict[str, Any]]] = {library: [] for library in AUTOMATED_PATTERN_LIBRARIES}
    expected_folders: set[Path] = set()

    for library in AUTOMATED_PATTERN_LIBRARIES:
        rows = source_rows.get(library) or []
        prefix = LIBRARY_SPECS[library]["prefix"]
        for index, source in enumerate(rows, start=1):
            instances = [
                row
                for row in source_instances.get(library) or []
                if as_text(row.get("pattern_id")) == as_text(source.get("pattern_id"))
            ]
            _, canonical_archetype, _, _ = taxonomy_for_pattern(
                library,
                as_text(source.get("pattern_name")),
                source=source,
                instances=instances,
            )
            materialized_id = f"{prefix}_{index:04d}_{canonical_archetype}"
            pattern, normalized_instances, variants, counterexamples, review = refine_pattern(
                source,
                materialized_id=materialized_id,
                instances=instances,
            )
            pattern["example_variants"] = [row["description"] for row in variants]
            pattern["variant_source_refs"] = _dedupe_dicts(
                [
                    ref
                    for row in variants
                    for ref in row.get("variant_source_refs") or []
                    if isinstance(ref, dict)
                ]
            )
            folder = output_root / library / "patterns" / materialized_id
            relative_folder = str(folder.relative_to(output_root))
            previous = previous_by_source.get(as_text(source.get("pattern_id"))) or {}
            previous_folder = as_text(previous.get("folder"))
            legacy_path = (
                persistent_legacy_by_source.get(as_text(source.get("pattern_id")))
                or as_text(previous.get("legacy_path"))
                or (previous_folder if previous_folder and previous_folder != relative_folder else "")
            )
            pattern["legacy_path"] = legacy_path
            review["legacy_path"] = legacy_path
            expected_folders.add(folder)
            _write_json(folder / "pattern.json", pattern)
            write_jsonl_atomic(folder / "instances.jsonl", normalized_instances)
            write_jsonl_atomic(folder / "variants.jsonl", variants)
            write_jsonl_atomic(folder / "counterexamples.jsonl", counterexamples)
            _write_json(folder / "review.json", review)
            index_row = _index_row(pattern, review=review, folder=relative_folder)
            library_indexes[library].append(index_row)
            materialized_rows.append(index_row)
            pattern_payloads[materialized_id] = pattern
            reviews[materialized_id] = review
            all_instances.extend(normalized_instances)

    merge_candidates = _add_neighbor_reviews(pattern_payloads, reviews, output_root=output_root)
    _remove_stale_pattern_folders(output_root, expected_folders)
    for library, rows in library_indexes.items():
        write_jsonl_atomic(output_root / library / "index.jsonl", rows)
    write_jsonl_atomic(output_root / "pattern_index.jsonl", materialized_rows)
    write_jsonl_atomic(output_root / "instance_index.jsonl", all_instances)
    relations = _cross_library_relations(pattern_payloads, instances=all_instances)
    write_jsonl_atomic(output_root / "cross_library_relations.jsonl", relations)
    quality_paths = _write_quality_reports(
        output_root=output_root,
        patterns=pattern_payloads,
        reviews=reviews,
        relations=relations,
        merge_candidates=merge_candidates,
        previous_index=previous_index,
        generated_at=generated_at,
    )
    worldview_report_path = output_root / "quality_reports" / "worldview_threshold_report.json"
    write_json_report(
        worldview_report_path,
        build_worldview_threshold_report(abstract_library_root=output_root),
    )
    quality_paths["worldview_threshold_report"] = str(worldview_report_path)
    routing_paths = _write_routing_indexes(
        output_root=output_root,
        patterns=pattern_payloads,
        reviews=reviews,
        instances=all_instances,
        relations=relations,
        generated_at=generated_at,
    )
    _write_json(output_root / "library_index.json", _library_index(library_indexes, generated_at=generated_at))
    legacy_rows = [
        {
            "source_pattern_id": row.get("source_pattern_id", ""),
            "pattern_id": row.get("pattern_id", ""),
            "legacy_path": row.get("legacy_path", ""),
            "current_path": row.get("folder", ""),
        }
        for row in materialized_rows
        if row.get("legacy_path")
    ]
    write_jsonl_atomic(legacy_map_path, legacy_rows)

    return {
        "schema_version": MATERIALIZE_SCHEMA_VERSION,
        "source_root": str(source_root),
        "output_root": str(output_root),
        "generated_at": generated_at,
        "pattern_count": len(materialized_rows),
        "instance_count": len(all_instances),
        "relation_count": len(relations),
        "merge_candidate_count": len(merge_candidates),
        "library_counts": {library: len(rows) for library, rows in library_indexes.items()},
        "index_paths": {
            "pattern_index": str(output_root / "pattern_index.jsonl"),
            "instance_index": str(output_root / "instance_index.jsonl"),
            "library_index": str(output_root / "library_index.json"),
            "cross_library_relations": str(output_root / "cross_library_relations.jsonl"),
            "quality_reports": quality_paths,
            "routing": routing_paths,
        },
    }


def _source_patterns(root: Path) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for library in AUTOMATED_PATTERN_LIBRARIES:
        rows: list[dict[str, Any]] = []
        for filename in ("universal_patterns.jsonl", "emerging_patterns.jsonl"):
            rows.extend(read_jsonl(root / library / filename))
        result[library] = sorted(rows, key=lambda row: as_text(row.get("pattern_id")))
    return result


def _index_row(pattern: dict[str, Any], *, review: dict[str, Any], folder: str) -> dict[str, Any]:
    return {
        "schema_version": "pattern_index_row.v1",
        "pattern_id": pattern["pattern_id"],
        "source_pattern_id": pattern["source_pattern_id"],
        "pattern_name": pattern["pattern_name"],
        "library": pattern["library"],
        "source_archetype": pattern.get("source_archetype", pattern.get("archetype", "")),
        "archetype": pattern["archetype"],
        "canonical_archetype": pattern.get("canonical_archetype", ""),
        "archetype_family": pattern.get("archetype_family", ""),
        "generalized_pattern_name": pattern.get("generalized_pattern_name", ""),
        "arc_scope": pattern.get("arc_scope", ""),
        "rhythm_scope": pattern.get("rhythm_scope", ""),
        "rule_scope": pattern.get("rule_scope", ""),
        "pattern_status": pattern["pattern_status"],
        "evidence_tier": pattern.get("evidence_tier", "book_evidence"),
        "cross_book_candidate": bool(pattern.get("cross_book_candidate")),
        "supported_book_count": pattern["supported_book_count"],
        "registered_instance_count": pattern["registered_instance_count"],
        "generality_level": review["generality_level"],
        "overgeneralization_risk": review["overgeneralization_risk"],
        "review_status": review["review_status"],
        "library_boundary_status": review.get("library_boundary_status", "needs_review"),
        "source_quality_score": pattern.get("source_quality_score", 0.0),
        "source_ref_count": len(pattern.get("source_refs") or []),
        "variant_count": len(pattern.get("example_variants") or []),
        "signature_terms": pattern["signature_terms"],
        "folder": folder,
        "legacy_path": pattern.get("legacy_path", ""),
        "pattern_path": f"{folder}/pattern.json",
        "instances_path": f"{folder}/instances.jsonl",
        "review_path": f"{folder}/review.json",
    }


def _library_index(rows: dict[str, list[dict[str, Any]]], *, generated_at: str) -> dict[str, Any]:
    return {
        "schema_version": "abstractlibrary_index.v2",
        "generated_at": generated_at,
        "global_indexes": {
            "patterns": "pattern_index.jsonl",
            "instances": "instance_index.jsonl",
            "cross_library_relations": "cross_library_relations.jsonl",
            "quality_reports": "quality_reports/",
            "routing_manifest": "_routing/abstractmodel_manifest.json",
        },
        "evidence_contract": {
            "layers": ["pattern", "instance_card", "source_plot"],
            "default_generation_input": ["pattern", "instance_card"],
            "default_excluded_fields": ["instance_card.source_locked_details"],
            "source_plot_policy": "lookup_on_demand_for_causal_detail_or_source_collision_review",
            "source_plot_resolver": "source_ref.bridge_index_path + source_ref.bridge_chunk_ids",
        },
        "libraries": {
            library: {
                "library": library,
                "perspective": spec["perspective"],
                "excluded_perspectives": spec["excluded"],
                "focus_fields": spec["focus_fields"],
                "pattern_count": len(rows.get(library) or []),
                "index_path": f"{library}/index.jsonl",
                "patterns_root": f"{library}/patterns",
            }
            for library, spec in LIBRARY_SPECS.items()
        },
    }


def _cross_library_relations(
    patterns: dict[str, dict[str, Any]],
    *,
    instances: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    instances = instances or []
    rows: list[dict[str, Any]] = []
    by_library: dict[str, list[dict[str, Any]]] = {}
    for pattern in patterns.values():
        by_library.setdefault(as_text(pattern.get("library")), []).append(pattern)
    for (source_library, target_library), relation_type in RELATION_TYPES.items():
        targets = by_library.get(target_library) or []
        for source in by_library.get(source_library) or []:
            scored = sorted(
                [(_relation_score(source, target), target) for target in targets],
                key=lambda pair: (-pair[0]["score"], as_text(pair[1].get("pattern_id"))),
            )
            for basis, target in scored[:2]:
                if basis["score"] < 0.08 and not basis["shared_bridge_chunk_ids"]:
                    continue
                shared_mechanism = _shared_mechanism(
                    source,
                    target,
                    relation_type=relation_type,
                    basis=basis,
                )
                if not shared_mechanism:
                    continue
                shared_instance_ids = _shared_instance_ids(source, target, instances)
                relation_status = _relation_status(basis, shared_mechanism=shared_mechanism)
                blocking_issues = list(basis.get("rejection_risks") or [])
                why_not_stronger = ""
                if relation_status != "strong":
                    why_not_stronger = "；".join(blocking_issues) or "机制语义与跨实例支持尚不足"
                rows.append(
                    {
                        "schema_version": "cross_library_relation.v3",
                        "relation_id": f"rel_{len(rows) + 1:04d}",
                        "source_pattern_id": source["pattern_id"],
                        "target_pattern_id": target["pattern_id"],
                        "source_library": source_library,
                        "target_library": target_library,
                        "relation_type": relation_type,
                        "relation_status": relation_status,
                        "confidence": basis["score"],
                        "relation_basis": basis,
                        "shared_mechanism": shared_mechanism,
                        "shared_instance_ids": shared_instance_ids,
                        "why_this_relation": _relation_explanation(
                            source,
                            target,
                            relation_type=relation_type,
                            shared_mechanism=shared_mechanism,
                        ),
                        "why_not_stronger": why_not_stronger,
                        "review_priority": (
                            "low" if relation_status == "strong" else ("medium" if relation_status == "weak" else "high")
                        ),
                        "blocking_issues": _dedupe_text(blocking_issues),
                        "description": f"{source['pattern_name']} 与 {target['pattern_name']} 在来源情节或机制骨架上相关；当前为 {relation_status}，等待跨书复核。",
                    }
                )
    return rows


def _relation_score(source: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    source_chunks = _bridge_chunks(source)
    target_chunks = _bridge_chunks(target)
    shared_chunks = sorted(source_chunks & target_chunks)
    shared_books = sorted(set(as_list(source.get("supported_books"))) & set(as_list(target.get("supported_books"))))
    source_terms = _semantic_terms(_relation_semantic_payload(source))
    target_terms = _semantic_terms(_relation_semantic_payload(target))
    overlap = len(source_terms & target_terms) / max(1, len(source_terms | target_terms))
    evidence_score = min(1.0, len(shared_chunks) / 2)
    book_score = 1.0 if shared_books else 0.0
    shared_evidence_only = bool(shared_chunks) and overlap < 0.08
    raw_score = min(1.0, evidence_score * 0.6 + overlap * 0.3 + book_score * 0.1)
    score = round(min(raw_score, 0.6999) if shared_evidence_only else raw_score, 4)
    rejection_risks: list[str] = []
    if shared_evidence_only:
        rejection_risks.append("只共享同一 Bridge 情节，尚无足够机制语义对应")
    if overlap < 0.04:
        rejection_risks.append("角色、行动与状态变化的语义重合过低")
    if score < 0.4 and not rejection_risks:
        rejection_risks.append("来源证据与机制语义的综合支持不足")
    if shared_books and not shared_chunks:
        rejection_risks.append("仅确认同书跨情节共存，仍需验证规则与下游机制的因果方向")
    return {
        "score": score,
        "shared_bridge_chunk_ids": shared_chunks,
        "shared_books": shared_books,
        "semantic_overlap": round(overlap, 4),
        "shared_evidence_only": shared_evidence_only,
        "role_action_alignment": overlap >= 0.08,
        "rejection_risks": rejection_risks,
    }


def _relation_semantic_payload(pattern: dict[str, Any]) -> dict[str, Any]:
    library = as_text(pattern.get("library"))
    focus_fields = LIBRARY_SPECS.get(library, {}).get("focus_fields", [])
    return {
        "core_mechanism": pattern.get("core_mechanism"),
        "required_conditions": pattern.get("required_conditions"),
        "focus": {field: pattern.get(field) for field in focus_fields},
    }


def _relation_status(basis: dict[str, Any], *, shared_mechanism: str) -> str:
    score = float(basis.get("score") or 0.0)
    semantic_overlap = float(basis.get("semantic_overlap") or 0.0)
    if score >= 0.7 and semantic_overlap >= 0.08 and not basis.get("shared_evidence_only") and shared_mechanism:
        return "strong"
    if score >= 0.4 and shared_mechanism:
        return "weak"
    if score < 0.08 and not basis.get("shared_bridge_chunk_ids"):
        return "rejected"
    return "needs_review"


def _shared_mechanism(
    source: dict[str, Any],
    target: dict[str, Any],
    *,
    relation_type: str,
    basis: dict[str, Any],
) -> str:
    grounded = (
        bool(basis.get("shared_bridge_chunk_ids"))
        or float(basis.get("semantic_overlap") or 0.0) >= 0.05
        or _worldview_relation_compatible(source, target, relation_type=relation_type)
    )
    if not grounded:
        return ""
    if relation_type == "event_can_trigger_payoff":
        event_result = _relation_field(source, "event_consequence", "state_change", "core_mechanism")
        payoff = _relation_field(target, "release_or_damage_action", "reader_reward_or_pain", "core_mechanism")
        return _relation_sentence(event_result, f"触发{payoff}")
    if relation_type == "event_can_drive_arc":
        event_result = _relation_field(source, "event_consequence", "state_change", "core_mechanism")
        arc_change = _relation_field(target, "turning_choice", "final_state", "core_mechanism")
        return _relation_sentence(event_result, f"迫使角色{arc_change}")
    if relation_type == "event_can_create_rhythm_beat":
        event_result = _relation_field(source, "event_consequence", "state_change", "core_mechanism")
        rhythm = _relation_field(target, "release_position", "post_release_hook", "core_mechanism")
        return _relation_sentence(event_result, f"形成情绪节拍：{rhythm}")
    if relation_type == "payoff_can_be_scheduled_by_rhythm":
        payoff = _relation_field(source, "release_or_damage_action", "reader_reward_or_pain", "core_mechanism")
        rhythm = _relation_field(target, "release_position", "post_release_hook", "core_mechanism")
        return _relation_sentence(f"节奏在{rhythm}", f"安排{payoff}的释放")
    if relation_type == "arc_can_amplify_payoff":
        arc_change = _relation_field(source, "turning_choice", "final_state", "core_mechanism")
        payoff = _relation_field(target, "reader_reward_or_pain", "release_or_damage_action", "core_mechanism")
        return _relation_sentence(f"角色{arc_change}", f"强化{payoff}")
    if relation_type == "worldview_can_enable_event":
        rule = _relation_field(source, "stable_rule", "enforcement_mechanism", "core_mechanism")
        event = _relation_field(target, "event_trigger", "event_action_sequence", "core_mechanism")
        return _relation_sentence(rule, f"提供或限制事件条件，使{event}能够发生")
    if relation_type == "worldview_can_constrain_arc":
        rule = _relation_field(source, "constraint", "stable_rule", "core_mechanism")
        arc_change = _relation_field(target, "turning_choice", "final_state", "core_mechanism")
        return _relation_sentence(rule, f"持续约束角色并促成{arc_change}")
    if relation_type == "worldview_can_shape_payoff":
        cost = _relation_field(source, "cost_model", "cost", "stable_rule")
        payoff = _relation_field(target, "reader_reward_or_pain", "release_or_damage_action", "core_mechanism")
        return _relation_sentence(cost, f"规定代价边界并塑造{payoff}")
    return ""


def _worldview_relation_compatible(
    source: dict[str, Any],
    target: dict[str, Any],
    *,
    relation_type: str,
) -> bool:
    if not relation_type.startswith("worldview_"):
        return False
    if not (set(as_list(source.get("supported_books"))) & set(as_list(target.get("supported_books")))):
        return False
    source_text = " ".join(_flatten_text(_relation_semantic_payload(source))).lower()
    target_text = " ".join(_flatten_text(_relation_semantic_payload(target))).lower()
    domains = (
        (("神经", "芯片", "植入", "技术", "technology", "neural"), ("科技", "能力", "激活", "植入", "technology", "ability")),
        (("轮回", "旧神", "新神", "筛选", "神权"), ("弑神", "神位", "权威", "规则制定", "authority")),
        (("控制", "权限", "操控"), ("代理权", "失控", "强制", "控制")),
    )
    return any(
        any(term in source_text for term in source_terms)
        and any(term in target_text for term in target_terms)
        for source_terms, target_terms in domains
    )


def _relation_field(pattern: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = pattern.get(key)
        if isinstance(value, list):
            text = "；".join(as_text(item) for item in value if as_text(item))
        else:
            text = as_text(value)
        if text:
            return text[:150].rstrip("。；")
    return ""


def _relation_sentence(left: str, right: str) -> str:
    if not left or not right:
        return ""
    return f"{left}，{right}"[:300].rstrip("，。；")


def _relation_explanation(
    source: dict[str, Any],
    target: dict[str, Any],
    *,
    relation_type: str,
    shared_mechanism: str,
) -> str:
    if not shared_mechanism:
        return "两条模式存在来源或局部语义重合，但尚未形成可确认的作用链。"
    labels = {
        "event_can_trigger_payoff": "EL 描述可执行事件链，PA 描述该事件造成的读者回报或痛感",
        "event_can_drive_arc": "EL 描述外部局势变化，CA 描述角色因此作出的关键选择与终态变化",
        "event_can_create_rhythm_beat": "EL 描述事件节点，ER 描述该节点在压力与释放序列中的位置",
        "payoff_can_be_scheduled_by_rhythm": "PA 描述释放内容，ER 描述释放位置及其后续钩子",
        "arc_can_amplify_payoff": "CA 描述人物状态变化，PA 描述该变化放大的读者回报或疼痛",
        "worldview_can_enable_event": "WV 描述稳定规则与执行条件，EL 描述规则允许发生的事件链",
        "worldview_can_constrain_arc": "WV 描述持续约束，CA 描述角色在约束下形成的状态转变",
        "worldview_can_shape_payoff": "WV 描述规则代价，PA 描述该代价转化出的回报或疼痛",
    }
    prefix = labels.get(relation_type, "两个库描述同一叙事机制的不同功能")
    return f"{prefix}：{shared_mechanism}。"


def _shared_instance_ids(
    source: dict[str, Any],
    target: dict[str, Any],
    instances: list[dict[str, Any]],
) -> list[str]:
    source_id = as_text(source.get("pattern_id"))
    target_id = as_text(target.get("pattern_id"))
    source_instances = [row for row in instances if as_text(row.get("pattern_id")) == source_id]
    target_instances = [row for row in instances if as_text(row.get("pattern_id")) == target_id]
    shared: list[str] = []
    for left in source_instances:
        left_chunks = set(as_list(as_mapping(left.get("source_ref")).get("bridge_chunk_ids")))
        for right in target_instances:
            right_chunks = set(as_list(as_mapping(right.get("source_ref")).get("bridge_chunk_ids")))
            if left_chunks & right_chunks:
                shared.extend([as_text(left.get("instance_id")), as_text(right.get("instance_id"))])
    return _dedupe_text([value for value in shared if value])[:12]


def _bridge_chunks(pattern: dict[str, Any]) -> set[str]:
    source_refs = pattern.get("source_refs") if isinstance(pattern.get("source_refs"), list) else []
    return {
        as_text(chunk_id)
        for ref in source_refs
        if isinstance(ref, dict)
        for chunk_id in as_list(ref.get("bridge_chunk_ids"))
        if as_text(chunk_id)
    }


def _semantic_terms(value: object) -> set[str]:
    text = "".join(_flatten_text(value))
    ascii_terms = {token.lower() for token in re.findall(r"[A-Za-z0-9_]{2,}", text)}
    chinese = "".join(char for char in text if "\u4e00" <= char <= "\u9fff")
    chinese_terms = {
        chinese[index:index + 2]
        for index in range(max(0, len(chinese) - 1))
    }
    return ascii_terms | chinese_terms


def _flatten_text(value: object) -> list[str]:
    if isinstance(value, dict):
        excluded = {"source_refs", "example_variants", "variant_source_refs"}
        return [text for key, child in value.items() if key not in excluded for text in _flatten_text(child)]
    if isinstance(value, list):
        return [text for child in value for text in _flatten_text(child)]
    text = as_text(value)
    return [text] if text else []


def _add_neighbor_reviews(
    patterns: dict[str, dict[str, Any]],
    reviews: dict[str, dict[str, Any]],
    *,
    output_root: Path,
) -> list[dict[str, Any]]:
    for pattern_id, pattern in patterns.items():
        same_library = [
            other
            for other in patterns.values()
            if other["library"] == pattern["library"] and other["pattern_id"] != pattern_id
        ]
        scored_neighbors = sorted(
            [(_neighbor_score(pattern, other), other) for other in same_library],
            key=lambda row: (-row[0]["score"], as_text(row[1].get("pattern_id"))),
        )
        neighbors = scored_neighbors[:2]
        review = reviews[pattern_id]
        review["nearest_neighbor_patterns"] = [row["pattern_id"] for _, row in neighbors]
        review["boundary_with_neighbors"] = {
            row["pattern_id"]: (
                f"本模式锚点是{'、'.join(review['specificity_anchor'])}；"
                f"邻居模式锚点是{'、'.join(reviews[row['pattern_id']]['specificity_anchor'])}。"
            )
            for _, row in neighbors
        }
        review["merge_candidates"] = [
            {
                "candidate_pattern_id": row["pattern_id"],
                "status": "review_candidate",
                "automatic_action": False,
                "similarity_score": score["score"],
                "same_canonical_archetype": score["same_canonical_archetype"],
                "same_archetype_family": score["same_archetype_family"],
                "mechanism_overlap": score["mechanism_overlap"],
                "shared_sibling_theme": score["shared_sibling_theme"],
                "reason": (
                    f"共享 {score['shared_sibling_theme']} 主题，但释放顺序、代价或状态变化不同，应复核为 sibling 而非直接合并。"
                    if score["shared_sibling_theme"]
                    else "同库模式在 taxonomy 与机制骨架上存在重合，需确认差异是核心机制还是仅为变体。"
                ),
            }
            for score, row in scored_neighbors
            if (
                _reportable_sibling(score, as_text(pattern.get("library")))
                or (
                    score["score"] >= 0.18
                    and (
                        score["same_canonical_archetype"]
                        or (score["same_archetype_family"] and score["mechanism_overlap"] >= 0.08)
                    )
                )
            )
        ][:3]
        review["should_merge"] = any(
            row.get("similarity_score", 0.0) >= 0.72 and row.get("same_canonical_archetype")
            for row in review["merge_candidates"]
        )
        review["should_split"] = bool(review.get("split_candidates"))
        readiness = as_mapping(review.get("promotion_readiness"))
        criteria = as_mapping(readiness.get("criteria"))
        criteria["review_issues_resolved"] = (
            not review["merge_candidates"]
            and not review.get("split_candidates")
            and review.get("library_boundary_status") == "clean"
        )
        readiness["criteria"] = criteria
        readiness["eligible"] = bool(criteria) and all(bool(value) for value in criteria.values())
        review["promotion_readiness"] = readiness
        folder = output_root / pattern["library"] / "patterns" / pattern_id
        _write_json(folder / "review.json", review)

    merge_rows: list[dict[str, Any]] = []
    ordered = sorted(patterns.values(), key=lambda row: as_text(row.get("pattern_id")))
    for index, left in enumerate(ordered):
        for right in ordered[index + 1:]:
            if left.get("library") != right.get("library"):
                continue
            basis = _neighbor_score(left, right)
            reportable_sibling = _reportable_sibling(basis, as_text(left.get("library")))
            if basis["score"] < 0.18 and not basis["same_archetype_family"] and not reportable_sibling:
                continue
            if basis["score"] >= 0.72 and basis["same_canonical_archetype"]:
                recommendation = "merge_now"
            elif reportable_sibling:
                recommendation = "sibling_relation"
            elif basis["same_archetype_family"] and basis["mechanism_overlap"] >= 0.08:
                recommendation = "sibling_relation"
            elif basis["score"] >= 0.28:
                recommendation = "needs_review"
            else:
                recommendation = "keep_separate"
            merge_rows.append(
                {
                    "left_pattern_id": left.get("pattern_id", ""),
                    "right_pattern_id": right.get("pattern_id", ""),
                    "library": left.get("library", ""),
                    "merge_score": basis["score"],
                    "reason": (
                        "canonical 相同且机制骨架高度重合。"
                        if basis["same_canonical_archetype"]
                        else (
                            f"共享 {basis['shared_sibling_theme']} 主题，但核心释放或状态变化机制不同。"
                            if reportable_sibling
                            else (
                                "属于同一 archetype family，但仍需保留机制边界。"
                                if basis["same_archetype_family"]
                                else "名称或机制存在局部重合，证据不足以自动合并。"
                            )
                        )
                    ),
                    "recommendation": recommendation,
                    "score_basis": basis,
                }
            )
    return merge_rows


def _neighbor_score(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left_terms = _semantic_terms(
        {
            "core_mechanism": left.get("core_mechanism"),
            "required_conditions": left.get("required_conditions"),
            "focus": {field: left.get(field) for field in LIBRARY_SPECS[left["library"]]["focus_fields"]},
        }
    )
    right_terms = _semantic_terms(
        {
            "core_mechanism": right.get("core_mechanism"),
            "required_conditions": right.get("required_conditions"),
            "focus": {field: right.get(field) for field in LIBRARY_SPECS[right["library"]]["focus_fields"]},
        }
    )
    mechanism_overlap = len(left_terms & right_terms) / max(1, len(left_terms | right_terms))
    transition_overlap = 0.0
    if left.get("library") == "CharacterArc":
        left_transition = _semantic_terms(
            {field: left.get(field) for field in ("initial_state", "external_pressure", "turning_choice", "final_state")}
        )
        right_transition = _semantic_terms(
            {field: right.get(field) for field in ("initial_state", "external_pressure", "turning_choice", "final_state")}
        )
        transition_overlap = len(left_transition & right_transition) / max(1, len(left_transition | right_transition))
    same_canonical = (
        bool(left.get("canonical_archetype"))
        and left.get("canonical_archetype") == right.get("canonical_archetype")
    )
    same_family = (
        bool(left.get("archetype_family"))
        and left.get("archetype_family") == right.get("archetype_family")
    )
    name_overlap = _name_overlap(as_text(left.get("pattern_name")), as_text(right.get("pattern_name")))
    sibling_theme = _shared_sibling_theme(left, right)
    score = min(
        1.0,
        (0.45 if same_canonical else 0.0)
        + (0.15 if same_family else 0.0)
        + mechanism_overlap * 0.3
        + transition_overlap * 0.2
        + name_overlap * 0.1,
    )
    return {
        "score": round(score, 4),
        "same_canonical_archetype": same_canonical,
        "same_archetype_family": same_family,
        "mechanism_overlap": round(mechanism_overlap, 4),
        "state_transition_overlap": round(transition_overlap, 4),
        "name_overlap": round(name_overlap, 4),
        "shared_sibling_theme": sibling_theme,
        "same_scope": (
            as_text(left.get("rhythm_scope")) == as_text(right.get("rhythm_scope"))
            if left.get("library") == "EmotionRhythm"
            else True
        ),
    }


def _shared_sibling_theme(left: dict[str, Any], right: dict[str, Any]) -> str:
    if left.get("library") != right.get("library"):
        return ""
    library = as_text(left.get("library"))
    left_text = " ".join(
        as_text(left.get(key))
        for key in ("pattern_name", "generalized_pattern_name", "canonical_archetype", "core_mechanism")
    ).lower()
    right_text = " ".join(
        as_text(right.get(key))
        for key in ("pattern_name", "generalized_pattern_name", "canonical_archetype", "core_mechanism")
    ).lower()
    themes = {
        "PayoffAngst": (
            ("sacrifice_death_legacy", ("牺牲", "死亡", "复活", "遗志", "sacrifice", "death", "revival", "legacy")),
            ("power_gain_and_cost", ("能力", "力量", "觉醒", "power", "ability")),
        ),
        "CharacterArc": (
            ("authority_and_leadership_change", ("权威", "领袖", "领导", "指挥", "authority", "leadership")),
            ("dependency_and_agency", ("依赖", "主体", "独立", "dependency", "agency")),
        ),
        "EventsLibrary": (
            ("investigation_and_exposure", ("调查", "揭露", "证据", "investigation", "exposure")),
        ),
        "EmotionRhythm": (
            ("crisis_release_reversal", ("危机", "释放", "反转", "crisis", "release", "reversal")),
        ),
    }
    for name, terms in themes.get(library, ()):
        if any(term in left_text for term in terms) and any(term in right_text for term in terms):
            return name
    return ""


def _reportable_sibling(basis: dict[str, Any], library: str) -> bool:
    if not as_text(basis.get("shared_sibling_theme")):
        return False
    if library == "PayoffAngst":
        return True
    if library == "CharacterArc":
        return bool(basis.get("same_archetype_family")) or float(basis.get("state_transition_overlap") or 0.0) >= 0.06
    if library == "EmotionRhythm":
        return bool(basis.get("same_scope")) and float(basis.get("mechanism_overlap") or 0.0) >= 0.1
    return bool(basis.get("same_archetype_family")) or float(basis.get("mechanism_overlap") or 0.0) >= 0.1


def _write_quality_reports(
    *,
    output_root: Path,
    patterns: dict[str, dict[str, Any]],
    reviews: dict[str, dict[str, Any]],
    relations: list[dict[str, Any]],
    merge_candidates: list[dict[str, Any]],
    previous_index: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, str]:
    report_root = output_root / "quality_reports"
    ordered_patterns = sorted(patterns.values(), key=lambda row: as_text(row.get("pattern_id")))
    support_buckets: Counter[str] = Counter()
    support_rows: list[dict[str, Any]] = []
    for pattern in ordered_patterns:
        instance_count = int(pattern.get("registered_instance_count") or 0)
        bucket = "0" if instance_count == 0 else ("1" if instance_count == 1 else ("2" if instance_count == 2 else "3_plus"))
        support_buckets[bucket] += 1
        readiness = as_mapping(reviews.get(as_text(pattern.get("pattern_id")), {}).get("promotion_readiness"))
        support_rows.append(
            {
                "pattern_id": pattern.get("pattern_id", ""),
                "library": pattern.get("library", ""),
                "supported_book_count": pattern.get("supported_book_count", 0),
                "registered_instance_count": instance_count,
                "concrete_variant_count": len(pattern.get("example_variants") or []),
                "promotion_eligible": bool(readiness.get("eligible")),
                "pattern_status": pattern.get("pattern_status", ""),
                "evidence_tier": pattern.get("evidence_tier", "book_evidence"),
                "cross_book_candidate": bool(pattern.get("cross_book_candidate")),
            }
        )
    pattern_support = {
        "schema_version": "pattern_support_report.v1",
        "generated_at": generated_at,
        "summary": {
            "pattern_count": len(ordered_patterns),
            "instance_support_distribution": {
                "zero_instances": support_buckets["0"],
                "one_instance": support_buckets["1"],
                "two_instances": support_buckets["2"],
                "three_or_more_instances": support_buckets["3_plus"],
            },
            "promotion_eligible_count": sum(row["promotion_eligible"] for row in support_rows),
        },
        "patterns": support_rows,
    }

    risk_counts = Counter(as_text(review.get("overgeneralization_risk")) or "unknown" for review in reviews.values())
    risk_rows = [
        {
            "pattern_id": pattern_id,
            "library": patterns[pattern_id].get("library", ""),
            "risk": review.get("overgeneralization_risk", "unknown"),
            "specificity_anchor_count": len(review.get("specificity_anchor") or []),
            "boundary_rule_count": len(review.get("must_not_generalize_beyond") or []),
            "reason": (
                "当前只有单书证据，taxonomy 与边界仍需跨书验证。"
                if int(patterns[pattern_id].get("supported_book_count") or 0) < 2
                else "需要复核来源实例是否仍共享同一核心机制。"
            ),
        }
        for pattern_id, review in sorted(reviews.items())
        if as_text(review.get("overgeneralization_risk")) != "low"
    ]
    overgeneralization = {
        "schema_version": "overgeneralization_report.v1",
        "generated_at": generated_at,
        "summary": {"risk_counts": dict(sorted(risk_counts.items())), "review_pattern_count": len(risk_rows)},
        "patterns_requiring_attention": risk_rows,
    }

    boundary_rows: list[dict[str, Any]] = []
    for pattern in ordered_patterns:
        focus_fields = LIBRARY_SPECS[as_text(pattern.get("library"))]["focus_fields"]
        missing_fields = [field for field in focus_fields if pattern.get(field) in (None, "", [], {})]
        review = reviews.get(as_text(pattern.get("pattern_id"))) or {}
        boundary_status = as_text(review.get("library_boundary_status")) or "needs_review"
        boundary_issues = review.get("boundary_issues") if isinstance(review.get("boundary_issues"), list) else []
        if missing_fields or boundary_status != "clean":
            boundary_rows.append(
                {
                    "pattern_id": pattern.get("pattern_id", ""),
                    "library": pattern.get("library", ""),
                    "missing_focus_fields": missing_fields,
                    "cross_library_pollution_risk": review.get("cross_library_pollution_risk", "unknown"),
                    "library_boundary_status": boundary_status,
                    "boundary_issues": boundary_issues,
                }
            )
    library_boundary = {
        "schema_version": "library_boundary_report.v1",
        "generated_at": generated_at,
        "summary": {
            "pattern_count": len(ordered_patterns),
            "patterns_with_boundary_issues": len(boundary_rows),
            "status_counts": dict(
                sorted(Counter(as_text(review.get("library_boundary_status")) or "needs_review" for review in reviews.values()).items())
            ),
        },
        "issues": boundary_rows,
    }

    relation_counts = Counter(as_text(row.get("relation_status")) or "needs_review" for row in relations)
    relation_status_counts = {
        status: relation_counts.get(status, 0)
        for status in ("strong", "weak", "needs_review", "rejected")
    }
    relation_quality = {
        "schema_version": "relation_quality_report.v1",
        "generated_at": generated_at,
        "summary": {
            "relation_count": len(relations),
            "status_counts": relation_status_counts,
        },
        "relations_requiring_review": [
            {
                "relation_id": row.get("relation_id", ""),
                "source_pattern_id": row.get("source_pattern_id", ""),
                "target_pattern_id": row.get("target_pattern_id", ""),
                "confidence": row.get("confidence", 0.0),
                "relation_status": row.get("relation_status", ""),
                "rejection_risks": as_mapping(row.get("relation_basis")).get("rejection_risks", []),
                "shared_mechanism": row.get("shared_mechanism", ""),
                "why_this_relation": row.get("why_this_relation", ""),
                "why_not_stronger": row.get("why_not_stronger", ""),
                "review_priority": row.get("review_priority", "high"),
                "blocking_issues": row.get("blocking_issues", []),
            }
            for row in relations
            if row.get("relation_status") != "strong"
        ],
    }

    merge_report = {
        "schema_version": "merge_candidate_report.v1",
        "generated_at": generated_at,
        "summary": {
            "candidate_count": len(merge_candidates),
            "recommendation_counts": dict(
                sorted(Counter(as_text(row.get("recommendation")) for row in merge_candidates).items())
            ),
        },
        "candidates": merge_candidates,
    }

    previous_by_source = {
        as_text(row.get("source_pattern_id")): row
        for row in previous_index
        if as_text(row.get("source_pattern_id"))
    }
    support_distribution = Counter(str(int(row.get("supported_book_count") or 0)) for row in ordered_patterns)
    newly_promoted_emerging: list[str] = []
    newly_promoted_universal: list[str] = []
    clusters_with_new_books: list[dict[str, Any]] = []
    for pattern in ordered_patterns:
        source_id = as_text(pattern.get("source_pattern_id"))
        previous = previous_by_source.get(source_id) or {}
        previous_status = as_text(previous.get("pattern_status"))
        current_status = as_text(pattern.get("pattern_status"))
        if not previous and "emerging" in current_status:
            newly_promoted_emerging.append(as_text(pattern.get("pattern_id")))
        if "universal" in current_status and "universal" not in previous_status:
            newly_promoted_universal.append(as_text(pattern.get("pattern_id")))
        previous_books = int(previous.get("supported_book_count") or 0)
        current_books = int(pattern.get("supported_book_count") or 0)
        if previous and current_books > previous_books:
            clusters_with_new_books.append(
                {
                    "pattern_id": pattern.get("pattern_id", ""),
                    "previous_supported_book_count": previous_books,
                    "supported_book_count": current_books,
                }
            )
    dirty_clusters = [
        pattern_id
        for pattern_id, review in reviews.items()
        if review.get("library_boundary_status") != "clean"
        or review.get("merge_candidates")
        or review.get("split_candidates")
    ]
    multi_book_report = {
        "schema_version": "multi_book_aggregation_report.v1",
        "generated_at": generated_at,
        "supported_book_count_distribution": dict(sorted(support_distribution.items(), key=lambda row: int(row[0]))),
        "newly_promoted_emerging": newly_promoted_emerging,
        "newly_promoted_universal": newly_promoted_universal,
        "clusters_with_new_books": clusters_with_new_books,
        "dirty_clusters": sorted(dirty_clusters),
        "book_evidence_patterns_waiting_for_support": [
            pattern.get("pattern_id", "")
            for pattern in ordered_patterns
            if int(pattern.get("supported_book_count") or 0) < 2
        ],
        "cross_book_candidates": [
            pattern.get("pattern_id", "")
            for pattern in ordered_patterns
            if bool(pattern.get("cross_book_candidate"))
        ],
    }

    reports = {
        "pattern_support_report": pattern_support,
        "overgeneralization_report": overgeneralization,
        "library_boundary_report": library_boundary,
        "relation_quality_report": relation_quality,
        "merge_candidate_report": merge_report,
        "multi_book_aggregation_report": multi_book_report,
    }
    paths: dict[str, str] = {}
    for name, payload in reports.items():
        path = report_root / f"{name}.json"
        _write_json(path, payload)
        paths[name] = str(path)
    return paths


def _write_routing_indexes(
    *,
    output_root: Path,
    patterns: dict[str, dict[str, Any]],
    reviews: dict[str, dict[str, Any]],
    instances: list[dict[str, Any]],
    relations: list[dict[str, Any]],
    generated_at: str,
) -> dict[str, str]:
    routing_root = output_root / "_routing"
    routing_root.mkdir(parents=True, exist_ok=True)
    (routing_root / "rejected_patterns").mkdir(parents=True, exist_ok=True)
    ordered_patterns = sorted(patterns.values(), key=lambda row: as_text(row.get("pattern_id")))
    cluster_registry = [
        {
            "schema_version": "cluster_registry_row.v1",
            "cluster_id": pattern.get("pattern_id", ""),
            "library": pattern.get("library", ""),
            "canonical_archetype": pattern.get("canonical_archetype", ""),
            "archetype_family": pattern.get("archetype_family", ""),
            "pattern_status": pattern.get("pattern_status", ""),
            "supported_book_count": pattern.get("supported_book_count", 0),
            "registered_instance_count": pattern.get("registered_instance_count", 0),
            "pattern_path": f"{pattern.get('library', '')}/patterns/{pattern.get('pattern_id', '')}/pattern.json",
        }
        for pattern in ordered_patterns
    ]
    compact_instance_index = [
        {
            "schema_version": "pattern_instance_route.v2",
            "instance_id": row.get("instance_id", ""),
            "pattern_id": row.get("pattern_id", ""),
            "library": row.get("library", ""),
            "book_id": row.get("book_id", ""),
            "plot_id": row.get("plot_id", ""),
            "bridge_chunk_ids": as_list(as_mapping(row.get("source_ref")).get("bridge_chunk_ids")),
            "primary_plot_id": as_text(as_mapping(row.get("source_ref")).get("primary_plot_id")),
            "instance_card_type": as_text(as_mapping(row.get("instance_card")).get("card_type")),
            "instance_card_grounding": as_text(as_mapping(row.get("instance_card")).get("grounding_mode")),
            "instance_card_completeness": as_mapping(as_mapping(row.get("instance_card")).get("card_quality")).get("completeness", 0.0),
            "instance_card_direct_grounding_completeness": as_mapping(
                as_mapping(row.get("instance_card")).get("card_quality")
            ).get("direct_grounding_completeness", 0.0),
            "fit_score": row.get("fit_score", 0.0),
        }
        for row in sorted(instances, key=lambda item: as_text(item.get("instance_id")))
    ]
    dirty_clusters: list[dict[str, Any]] = []
    review_queue: list[dict[str, Any]] = []
    for pattern in ordered_patterns:
        pattern_id = as_text(pattern.get("pattern_id"))
        review = reviews.get(pattern_id) or {}
        reasons: list[str] = []
        if int(pattern.get("supported_book_count") or 0) < 3:
            reasons.append("insufficient_cross_book_support")
        if int(pattern.get("registered_instance_count") or 0) < 8:
            reasons.append("insufficient_instance_support")
        if review.get("merge_candidates"):
            reasons.append("merge_review_pending")
            review_queue.append(
                {
                    "schema_version": "abstractmodel_review_task.v1",
                    "task_id": f"review_merge_{pattern_id}",
                    "task_type": "merge_review",
                    "pattern_id": pattern_id,
                    "candidate_pattern_ids": [row.get("candidate_pattern_id", "") for row in review["merge_candidates"]],
                    "reason": "复核相邻模式差异是否仅属于 variation。",
                }
            )
        if review.get("split_candidates"):
            reasons.append("split_review_pending")
            review_queue.append(
                {
                    "schema_version": "abstractmodel_review_task.v1",
                    "task_id": f"review_split_{pattern_id}",
                    "task_type": "split_review",
                    "pattern_id": pattern_id,
                    "candidate_ids": [row.get("candidate_id", "") for row in review["split_candidates"]],
                    "reason": "复核实例机制分歧是否需要拆分 pattern。",
                }
            )
        if reasons:
            dirty_clusters.append(
                {
                    "schema_version": "dirty_cluster_row.v1",
                    "pattern_id": pattern_id,
                    "library": pattern.get("library", ""),
                    "reasons": reasons,
                }
            )
    for relation in relations:
        if relation.get("relation_status") != "needs_review":
            continue
        review_queue.append(
            {
                "schema_version": "abstractmodel_review_task.v1",
                "task_id": f"review_{relation.get('relation_id', '')}",
                "task_type": "cross_library_relation_review",
                "relation_id": relation.get("relation_id", ""),
                "pattern_ids": [relation.get("source_pattern_id", ""), relation.get("target_pattern_id", "")],
                "reason": "关系置信度低于 0.4，不能作为自动路由依据。",
            }
        )

    manifest = {
        "schema_version": "abstractmodel_routing_manifest.v1",
        "generated_at": generated_at,
        "materializer_schema_version": MATERIALIZE_SCHEMA_VERSION,
        "data_policy": "derived_compact_indexes_only",
        "pattern_count": len(ordered_patterns),
        "instance_count": len(instances),
        "instance_card_grounding_counts": dict(
            sorted(
                Counter(
                    as_text(as_mapping(row.get("instance_card")).get("grounding_mode")) or "missing"
                    for row in instances
                ).items()
            )
        ),
        "relation_count": len(relations),
        "evidence_contract": {
            "layers": ["pattern", "instance_card", "source_plot"],
            "default_generation_input": ["pattern", "instance_card"],
            "default_excluded_fields": ["instance_card.source_locked_details"],
            "source_plot_lookup": "on_demand",
        },
        "dirty_cluster_count": len(dirty_clusters),
        "llm_review_task_count": len(review_queue),
        "files": {
            "cluster_registry": "cluster_registry.jsonl",
            "pattern_instance_index": "pattern_instance_index.jsonl",
            "dirty_clusters": "dirty_clusters.jsonl",
            "llm_cluster_review_queue": "llm_cluster_review_queue.jsonl",
            "rejected_patterns": "rejected_patterns/",
        },
    }
    manifest_path = routing_root / "abstractmodel_manifest.json"
    cluster_registry_path = routing_root / "cluster_registry.jsonl"
    instance_index_path = routing_root / "pattern_instance_index.jsonl"
    dirty_path = routing_root / "dirty_clusters.jsonl"
    review_queue_path = routing_root / "llm_cluster_review_queue.jsonl"
    _write_json(manifest_path, manifest)
    write_jsonl_atomic(cluster_registry_path, cluster_registry)
    write_jsonl_atomic(instance_index_path, compact_instance_index)
    write_jsonl_atomic(dirty_path, dirty_clusters)
    write_jsonl_atomic(review_queue_path, review_queue)
    return {
        "manifest": str(manifest_path),
        "cluster_registry": str(cluster_registry_path),
        "pattern_instance_index": str(instance_index_path),
        "dirty_clusters": str(dirty_path),
        "llm_cluster_review_queue": str(review_queue_path),
        "rejected_patterns": str(routing_root / "rejected_patterns"),
    }


def _remove_stale_pattern_folders(root: Path, expected: set[Path]) -> None:
    for library in AUTOMATED_PATTERN_LIBRARIES:
        patterns_root = root / library / "patterns"
        if not patterns_root.exists():
            continue
        for folder in patterns_root.iterdir():
            if not folder.is_dir() or folder in expected:
                continue
            marker = folder / "pattern.json"
            try:
                payload = json.loads(marker.read_text(encoding="utf-8")) if marker.exists() else {}
            except json.JSONDecodeError:
                continue
            if payload.get("schema_version") == "reference_pattern.v2":
                shutil.rmtree(folder)


def _name_overlap(left: str, right: str) -> float:
    left_chars = set(left)
    right_chars = set(right)
    return len(left_chars & right_chars) / max(1, len(left_chars | right_chars))


def _dedupe_dicts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for row in rows:
        key = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            result.append(row)
            seen.add(key)
    return result


def _dedupe_text(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
