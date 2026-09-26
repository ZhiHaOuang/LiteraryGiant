from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from shared import (
    ABSTRACT_LIBRARY_ROOT,
    LIBRARY_ROOT,
    as_list,
    as_text,
    canonical_book_slug,
    dedupe_items,
)

from .schemas import (
    AUTOMATED_PATTERN_LIBRARIES,
    CHARACTER_ARC,
    EMOTION_RHYTHM,
    EVENTS_LIBRARY,
    LEGACY_LIBRARY_NAME_MAP,
    PAYOFF_ANGST,
    WORLDVIEW,
    canonical_library_name,
)


PATTERN_LIBRARIES = AUTOMATED_PATTERN_LIBRARIES
GENERIC_ARC_TEMPLATES = {"配角状态推动局部关系变化", "关系状态重排"}
GENERIC_PATTERN_NAMES = {
    "阶段事件改变局势",
    "阶段压力释放机制",
    "人物关系功能变化",
    "阶段情绪推进曲线",
    "书级世界观机制",
}
TAG_JOIN_MARKERS = (" + ", "+", "＋", "、")
DEFAULT_MIN_PATTERN_QUALITY_SCORE = 0.72
DEFAULT_MIN_EMERGING_INSTANCES = 3
DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD = 0.88


def _library_root(output_root: str | Path | None = None) -> Path:
    return Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT


def _work_root(work_root: str | Path | None = None, *, output_root: str | Path | None = None) -> Path:
    if work_root is not None:
        return Path(work_root)
    if output_root is not None:
        return Path(output_root).parent / "BookSpecificAbstracts"
    return LIBRARY_ROOT / "BookSpecificAbstracts"


def _candidate_files(
    library: str,
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> list[Path]:
    working_root = _work_root(work_root, output_root=output_root)
    candidate_names = [library]
    candidate_names.extend(
        legacy_name
        for legacy_name, canonical_name in LEGACY_LIBRARY_NAME_MAP.items()
        if canonical_name == library
    )
    files: list[Path] = []
    for candidate_name in candidate_names:
        files.extend(sorted(working_root.glob(f"id[0-9]*/candidates/{candidate_name}.jsonl")))
    if files:
        return files
    root = _library_root(output_root)
    for candidate_name in candidate_names:
        files.extend(sorted((root / "candidates" / candidate_name).glob("id[0-9]*.jsonl")))
    if files:
        return files
    for candidate_name in candidate_names:
        files.extend(sorted((root / candidate_name / "candidates").glob("id[0-9]*.jsonl")))
    return files


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
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


def load_candidate_objects(
    library: str,
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in _candidate_files(library, output_root=output_root, work_root=work_root):
        for row in _read_jsonl(path):
            row = dict(row)
            row["library"] = canonical_library_name(as_text(row.get("library") or library))
            row["_source_layer"] = "plot_level_candidate"
            row["_candidate_path"] = str(path)
            rows.append(row)
    return rows


def load_book_profile_contexts(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> dict[str, dict[str, Any]]:
    contexts: dict[str, dict[str, Any]] = {}
    working_root = _work_root(work_root, output_root=output_root)
    for book_dir in sorted(working_root.glob("id[0-9]*")):
        if not book_dir.is_dir():
            continue
        book_slug = book_dir.name
        profile_dir = book_dir / "book_profile"
        if not profile_dir.exists():
            profile_dir = _library_root(output_root) / "book_profiles" / book_slug
        contexts[book_slug] = {
            "book_profile": _read_json(profile_dir / "book_profile.json"),
            "event_sequence": _read_json(profile_dir / "event_sequence.json"),
            "payoff_structure": _read_json(profile_dir / "payoff_structure.json"),
            "emotion_curve": _read_json(profile_dir / "emotion_curve.json"),
            "worldview_profile": _read_json(profile_dir / "worldview_profile.json"),
            "character_arcs": _read_jsonl(profile_dir / "character_arcs.jsonl"),
        }
    return contexts


def build_pattern_layers(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    min_supported_books: int = 3,
    min_source_instances: int = 8,
    min_emerging_instances: int = DEFAULT_MIN_EMERGING_INSTANCES,
    min_pattern_quality_score: float = DEFAULT_MIN_PATTERN_QUALITY_SCORE,
    duplicate_similarity_threshold: float = DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD,
) -> dict[str, Any]:
    contexts = load_book_profile_contexts(output_root=output_root, work_root=work_root)
    local_patterns = build_local_patterns(output_root=output_root, work_root=work_root, contexts=contexts)
    emerging_patterns, universal_patterns, rejected_patterns = build_cross_book_patterns(
        local_patterns,
        min_supported_books=min_supported_books,
        min_source_instances=min_source_instances,
        min_emerging_instances=min_emerging_instances,
        min_pattern_quality_score=min_pattern_quality_score,
        duplicate_similarity_threshold=duplicate_similarity_threshold,
    )
    return {
        "local_patterns": local_patterns,
        "emerging_patterns": emerging_patterns,
        "universal_patterns": universal_patterns,
        "rejected_patterns": rejected_patterns,
        "thresholds": {
            "min_supported_books": min_supported_books,
            "min_source_instances": min_source_instances,
            "min_emerging_instances": min_emerging_instances,
            "min_pattern_quality_score": min_pattern_quality_score,
            "duplicate_similarity_threshold": duplicate_similarity_threshold,
        },
    }


def build_global_patterns(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    min_supported_books: int = 3,
) -> dict[str, list[dict[str, Any]]]:
    """Compatibility shim: returns only threshold-qualified universal patterns."""
    return build_pattern_layers(
        output_root=output_root,
        work_root=work_root,
        min_supported_books=min_supported_books,
    )["universal_patterns"]


def build_local_patterns(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    contexts: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    contexts = contexts or load_book_profile_contexts(output_root=output_root, work_root=work_root)
    by_book: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for library in PATTERN_LIBRARIES:
        for row in _rows_for_local_build(library, output_root=output_root, work_root=work_root, contexts=contexts):
            book_slug = _book_slug(row)
            if book_slug:
                by_book[book_slug][library].append(row)

    local_patterns: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for book_slug, rows_by_library in sorted(by_book.items()):
        local_patterns[book_slug] = {}
        for library in PATTERN_LIBRARIES:
            rows = rows_by_library.get(library) or []
            local_patterns[book_slug][library] = _build_book_local_patterns(
                book_slug,
                library,
                rows,
                contexts,
            )
    return local_patterns


def build_cross_book_patterns(
    local_patterns: dict[str, dict[str, list[dict[str, Any]]]],
    *,
    min_supported_books: int,
    min_source_instances: int,
    min_emerging_instances: int,
    min_pattern_quality_score: float,
    duplicate_similarity_threshold: float,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    emerging: dict[str, list[dict[str, Any]]] = {library: [] for library in PATTERN_LIBRARIES}
    universal: dict[str, list[dict[str, Any]]] = {library: [] for library in PATTERN_LIBRARIES}
    rejected: dict[str, list[dict[str, Any]]] = {library: [] for library in PATTERN_LIBRARIES}
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = {
        library: defaultdict(list) for library in PATTERN_LIBRARIES
    }

    for book_patterns in local_patterns.values():
        for library, rows in book_patterns.items():
            for row in rows:
                key = as_text(row.get("pattern_name"))
                if key:
                    grouped[library][key].append(row)

    for library in PATTERN_LIBRARIES:
        universal_index = 1
        emerging_index = 1
        accepted_clusters: list[dict[str, Any]] = []
        for key, rows in sorted(grouped[library].items(), key=lambda pair: (-_source_instance_count(pair[1]), pair[0])):
            supported_books = sorted({as_text(row.get("book_slug")) for row in rows if as_text(row.get("book_slug"))})
            source_instances = _source_instance_count(rows)
            quality = _pattern_quality(library, key, rows, supported_books, source_instances)
            duplicate = _find_near_duplicate_cluster(
                library,
                key,
                rows,
                accepted_clusters,
                threshold=duplicate_similarity_threshold,
            )
            hard_rejection = _hard_rejection_reason(library, key, source_instances)
            if hard_rejection:
                rejected[library].append(
                    _rejected_pattern_payload(library, key, rows, supported_books, quality, hard_rejection)
                )
                continue
            if duplicate:
                rejected[library].append(
                    _rejected_pattern_payload(
                        library,
                        key,
                        rows,
                        supported_books,
                        quality,
                        f"near_duplicate_of:{duplicate['pattern_name']}",
                    )
                )
                continue
            if quality["quality_score"] < min_pattern_quality_score:
                rejected[library].append(
                    _rejected_pattern_payload(library, key, rows, supported_books, quality, "low_pattern_quality")
                )
                continue

            qualified = len(supported_books) >= min_supported_books and source_instances >= min_source_instances
            if qualified:
                pattern = _cross_book_pattern_payload(
                    library,
                    key,
                    rows,
                    pattern_id=f"universal_{_pattern_prefix(library)}_{universal_index:03d}",
                    pattern_scope="UniversalReferencePatterns",
                    pattern_status="universal_reference_pattern",
                    supported_books=supported_books,
                )
                pattern.update(quality)
                universal[library].append(pattern)
                accepted_clusters.append(_accepted_cluster_record(library, key, rows, pattern["pattern_id"]))
                universal_index += 1
            elif source_instances >= min_emerging_instances:
                pattern = _cross_book_pattern_payload(
                    library,
                    key,
                    rows,
                    pattern_id=f"emerging_{_pattern_prefix(library)}_{emerging_index:03d}",
                    pattern_scope="EmergingPatterns",
                    pattern_status="emerging_pattern_candidate",
                    supported_books=supported_books,
                )
                pattern.update(quality)
                emerging[library].append(pattern)
                accepted_clusters.append(_accepted_cluster_record(library, key, rows, pattern["pattern_id"]))
                emerging_index += 1
            else:
                rejected[library].append(
                    _rejected_pattern_payload(library, key, rows, supported_books, quality, "insufficient_emerging_support")
                )
    return emerging, universal, rejected


def _rows_for_local_build(
    library: str,
    *,
    output_root: str | Path | None,
    work_root: str | Path | None,
    contexts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    candidate_rows = load_candidate_objects(library, output_root=output_root, work_root=work_root)
    if library == CHARACTER_ARC:
        profile_rows = _character_arc_rows_from_profiles(contexts)
        return profile_rows or candidate_rows
    if library == EMOTION_RHYTHM:
        return [*candidate_rows, *_emotion_phase_rows_from_profiles(contexts)]
    if library == WORLDVIEW:
        return _worldview_rows_from_profiles(contexts)
    return candidate_rows


def _character_arc_rows_from_profiles(contexts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for book_slug, context in contexts.items():
        for arc in context.get("character_arcs") or []:
            if not isinstance(arc, dict):
                continue
            template = as_text(arc.get("preferred_arc_template"))
            if not template or template in GENERIC_ARC_TEMPLATES:
                continue
            rows.append(
                {
                    "library": CHARACTER_ARC,
                    "object_id": arc.get("arc_id", ""),
                    "object_type": "book_character_arc_reference_candidate",
                    "source_ref": {"book_slug": book_slug, "plot_span": arc.get("plot_span", {})},
                    "payload": {
                        "source_payload": {
                            "book_specific_bindings": as_list(arc.get("book_specific_bindings")),
                            "source_names": as_list(arc.get("source_names")),
                            "fragment_count": arc.get("fragment_count", 0),
                        },
                        "generalized_payload": {
                            "character_slot": arc.get("character_slot", ""),
                            "arc_template": template,
                            "arc_function": arc.get("arc_functions", []),
                            "portable_arc": arc.get("portable_arc", ""),
                            "phase_changes": arc.get("phase_changes", []),
                            "initial_state": _arc_state_edge(arc, "initial"),
                            "final_state": _arc_state_edge(arc, "final"),
                        },
                    },
                    "_source_layer": "book_profile_character_arc",
                }
            )
    return rows


def _arc_state_edge(arc: dict[str, Any], edge: str) -> str:
    portable = as_text(arc.get("portable_arc"))
    if "：" in portable:
        portable = portable.split("：", 1)[1]
    if "。" in portable:
        portable = portable.split("。", 1)[0]
    if "->" not in portable:
        return ""
    left, right = [item.strip() for item in portable.split("->", 1)]
    return left if edge == "initial" else right


def _emotion_phase_rows_from_profiles(contexts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for book_slug, context in contexts.items():
        curve = context.get("emotion_curve") if isinstance(context.get("emotion_curve"), dict) else {}
        for phase in curve.get("phase_curve") or []:
            if not isinstance(phase, dict) or not phase.get("support_count"):
                continue
            dominant = phase.get("dominant_rhythm_types") or []
            rhythm_type = as_text(dominant[0].get("value")) if dominant and isinstance(dominant[0], dict) else ""
            rows.append(
                {
                    "library": EMOTION_RHYTHM,
                    "object_id": f"{book_slug}__{phase.get('phase_id', 'phase')}",
                    "object_type": "book_emotion_phase_candidate",
                    "source_ref": {"book_slug": book_slug, "plot_span": phase.get("plot_span", {})},
                    "payload": {
                        "source_payload": {"support_count": phase.get("support_count", 0)},
                        "generalized_payload": {
                            "emotion_pattern_name": phase.get("emotion_summary", ""),
                            "macro_pattern": phase.get("phase_name", ""),
                            "micro_pattern": phase.get("emotion_summary", ""),
                            "rhythm_type": rhythm_type,
                            "reader_state_change": phase.get("emotion_summary", ""),
                            "emotional_core": phase.get("emotion_summary", ""),
                        },
                    },
                    "_source_layer": "book_profile_emotion_phase",
                }
            )
    return rows


def _worldview_rows_from_profiles(contexts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for book_slug, context in contexts.items():
        profile = context.get("worldview_profile") if isinstance(context.get("worldview_profile"), dict) else {}
        if not profile or profile.get("stability_level") == "none":
            continue
        mechanisms = as_list(profile.get("candidate_mechanisms")) or [profile.get("worldview_mechanism_summary", "")]
        for index, mechanism in enumerate(mechanisms, start=1):
            mechanism_text = as_text(mechanism)
            if not mechanism_text:
                continue
            rows.append(
                {
                    "library": WORLDVIEW,
                    "object_id": f"{book_slug}__worldview_{index:03d}",
                    "object_type": "book_worldview_mechanism_candidate",
                    "source_ref": {
                        "book_slug": book_slug,
                        "evidence_plot_refs": profile.get("evidence_plot_refs", []),
                    },
                    "payload": {
                        "source_payload": {
                            "worldview_signal_plot_count": profile.get("worldview_signal_plot_count", 0),
                            "stability_level": profile.get("stability_level", ""),
                            "dominant_worldview_functions": profile.get("dominant_worldview_functions", []),
                            "dominant_driving_forces": profile.get("dominant_driving_forces", []),
                        },
                        "generalized_payload": {
                            "worldview_mechanism": mechanism_text,
                            "mechanism_name": _worldview_mechanism_name_from_text(mechanism_text),
                            "core_rule": profile.get("worldview_mechanism_summary", ""),
                            "role_slots": profile.get("role_slots", {}),
                            "required_conditions": profile.get("required_conditions", []),
                            "variation_axes": profile.get("variation_axes", []),
                        },
                    },
                    "_source_layer": "book_profile_worldview",
                }
            )
    return rows


def _build_book_local_patterns(
    book_slug: str,
    library: str,
    rows: list[dict[str, Any]],
    contexts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        key = _pattern_group_key(library, row)
        if key:
            groups[key].append(row)

    patterns: list[dict[str, Any]] = []
    for index, (key, items) in enumerate(sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0])), start=1):
        generalized = [_generalized(item) for item in items]
        features = _feature_set_from_many(generalized)
        patterns.append(
            {
                "schema_version": "book_local_pattern.v1",
                "pattern_id": f"{book_slug}__local_{_pattern_prefix(library)}_{index:03d}",
                "pattern_name": key,
                "library": library,
                "pattern_scope": "BookLocalPatterns",
                "pattern_status": "single_book_pattern_candidate",
                "book_slug": book_slug,
                "within_book_support_count": len(items),
                "source_layers": _top_values(item.get("_source_layer") for item in items),
                "definition": _definition(library, key),
                "core_mechanism": _core_mechanism(library),
                "role_slots": _role_slots(library, features, generalized),
                "required_conditions": _required_conditions(library, features, generalized),
                "variation_axes": _variation_axes(library, features, generalized),
                "instances": _instances_from_items(book_slug, items),
                "book_profile_support": _book_profile_support(library, book_slug, contexts),
                "common_candidate_forms": _common_candidate_forms(library, generalized),
                "book_specific_elements": _book_specific_elements([book_slug], contexts),
                "failure_risks": _failure_risks(library, generalized),
                "generation_usage": _generation_usage(library),
            }
        )
    return patterns


def _cross_book_pattern_payload(
    library: str,
    key: str,
    rows: list[dict[str, Any]],
    *,
    pattern_id: str,
    pattern_scope: str,
    pattern_status: str,
    supported_books: list[str],
) -> dict[str, Any]:
    return {
        "schema_version": "reference_pattern_cluster.v1",
        "pattern_id": pattern_id,
        "pattern_name": key,
        "library": library,
        "pattern_scope": pattern_scope,
        "pattern_status": pattern_status,
        "definition": _first_text(rows, "definition") or _definition(library, key),
        "core_mechanism": _first_text(rows, "core_mechanism") or _core_mechanism(library),
        "role_slots": _merged_role_slots(rows),
        "required_conditions": _merged_field_lists(rows, "required_conditions"),
        "variation_axes": _merged_field_lists(rows, "variation_axes"),
        "failure_risks": _merged_field_lists(rows, "failure_risks"),
        "generation_usage": _first_text(rows, "generation_usage") or _generation_usage(library),
        "supported_books": supported_books,
        "supported_book_count": len(supported_books),
        "local_pattern_count": len(rows),
        "source_instance_count": _source_instance_count(rows),
        "instances": _merged_instances(rows),
        "local_pattern_refs": [
            {
                "book_slug": row.get("book_slug", ""),
                "pattern_id": row.get("pattern_id", ""),
                "within_book_support_count": row.get("within_book_support_count", 0),
            }
            for row in rows
        ],
    }


def _rejected_pattern_payload(
    library: str,
    key: str,
    rows: list[dict[str, Any]],
    supported_books: list[str],
    quality: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    return {
        "schema_version": "reference_pattern_rejection.v1",
        "pattern_name": key,
        "library": library,
        "pattern_scope": "RejectedPatterns",
        "pattern_status": "rejected_pattern_candidate",
        "rejection_reason": reason,
        "supported_books": supported_books,
        "supported_book_count": len(supported_books),
        "local_pattern_count": len(rows),
        "source_instance_count": _source_instance_count(rows),
        "quality_score": quality.get("quality_score", 0.0),
        "quality_reasons": quality.get("quality_reasons", []),
        "local_pattern_refs": [
            {
                "book_slug": row.get("book_slug", ""),
                "pattern_id": row.get("pattern_id", ""),
                "within_book_support_count": row.get("within_book_support_count", 0),
            }
            for row in rows
        ],
    }


def _hard_rejection_reason(library: str, key: str, source_instances: int) -> str:
    if _is_generic_pattern_name(key):
        return "generic_pattern_name"
    if _is_tag_joined_pattern_name(key):
        return "tag_joined_pattern_name"
    if library == WORLDVIEW and source_instances < 1:
        return "no_worldview_support"
    return ""


def _pattern_quality(
    library: str,
    key: str,
    rows: list[dict[str, Any]],
    supported_books: list[str],
    source_instances: int,
) -> dict[str, Any]:
    score = 0.0
    reasons: list[str] = []
    role_slots = _merged_role_slots(rows)
    required_conditions = _merged_field_lists(rows, "required_conditions")
    variation_axes = _merged_field_lists(rows, "variation_axes")
    failure_risks = _merged_field_lists(rows, "failure_risks")
    instances = _merged_instances(rows)

    if not _is_generic_pattern_name(key) and not _is_tag_joined_pattern_name(key) and len(key) >= 6:
        score += 0.24
        reasons.append("mechanism_name")

    if source_instances >= 8:
        score += 0.20
        reasons.append("strong_instance_support")
    elif source_instances >= 3:
        score += 0.12
        reasons.append("emerging_instance_support")
    elif source_instances >= 1:
        score += 0.04
        reasons.append("weak_instance_support")

    if len(supported_books) >= 3:
        score += 0.16
        reasons.append("cross_book_support")
    elif len(supported_books) >= 2:
        score += 0.10
        reasons.append("multi_book_hint")
    elif supported_books:
        score += 0.04
        reasons.append("single_book_only")

    if len(role_slots) >= 2:
        score += 0.14
        reasons.append("role_slots")
    elif role_slots:
        score += 0.06

    if len(required_conditions) >= 2 and len(variation_axes) >= 2:
        score += 0.14
        reasons.append("conditions_and_variations")
    elif required_conditions or variation_axes:
        score += 0.06

    if failure_risks and _first_text(rows, "generation_usage"):
        score += 0.08
        reasons.append("usage_and_failure_risks")

    if len(instances) >= 3:
        score += 0.04
        reasons.append("example_instances")

    return {
        "quality_score": round(min(score, 1.0), 4),
        "quality_reasons": reasons,
    }


def _is_generic_pattern_name(key: str) -> bool:
    text = as_text(key)
    return text in GENERIC_PATTERN_NAMES or text.endswith("模板")


def _is_tag_joined_pattern_name(key: str) -> bool:
    text = as_text(key)
    if not text:
        return True
    if "+" in text or "＋" in text:
        return True
    return text.count("、") >= 2


def _accepted_cluster_record(library: str, key: str, rows: list[dict[str, Any]], pattern_id: str) -> dict[str, Any]:
    return {
        "library": library,
        "pattern_id": pattern_id,
        "pattern_name": key,
        "signature_terms": _cluster_signature_terms(library, key, rows),
        "source_instance_count": _source_instance_count(rows),
    }


def _find_near_duplicate_cluster(
    library: str,
    key: str,
    rows: list[dict[str, Any]],
    accepted_clusters: list[dict[str, Any]],
    *,
    threshold: float,
) -> dict[str, Any] | None:
    terms = _cluster_signature_terms(library, key, rows)
    if not terms:
        return None
    for candidate in accepted_clusters:
        if candidate.get("library") != library:
            continue
        similarity = _jaccard(terms, set(candidate.get("signature_terms") or []))
        if similarity >= threshold:
            return {
                "pattern_id": candidate.get("pattern_id", ""),
                "pattern_name": candidate.get("pattern_name", ""),
                "similarity": round(similarity, 4),
            }
    return None


def _cluster_signature_terms(library: str, key: str, rows: list[dict[str, Any]]) -> set[str]:
    terms = {library}
    terms.update(_semantic_terms(key))
    for row in rows:
        terms.update(_semantic_terms(row.get("pattern_name")))
        for item in as_list(row.get("common_candidate_forms")):
            if isinstance(item, dict):
                terms.update(_semantic_terms(item.get("value")))
            else:
                terms.update(_semantic_terms(item))
        terms.update(as_list(row.get("required_conditions")))
        terms.update(as_list(row.get("variation_axes")))
    return {term for term in terms if term}


def _semantic_terms(value: object) -> set[str]:
    text = as_text(value)
    terms: set[str] = set()
    ascii_token = ""
    chinese_chars: list[str] = []
    for char in text:
        if char.isascii() and (char.isalnum() or char == "_"):
            ascii_token += char.lower()
        else:
            if ascii_token:
                terms.add(ascii_token)
                ascii_token = ""
            if "\u4e00" <= char <= "\u9fff":
                chinese_chars.append(char)
    if ascii_token:
        terms.add(ascii_token)
    for size in (2, 3):
        for index in range(0, max(0, len(chinese_chars) - size + 1)):
            terms.add("".join(chinese_chars[index : index + size]))
    return terms


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _pattern_group_key(library: str, row: dict[str, Any]) -> str:
    gp = _generalized(row)
    features = _feature_set(gp)
    if library == EVENTS_LIBRARY:
        return _event_mechanism_name(features, gp)
    if library == PAYOFF_ANGST:
        return _payoff_mechanism_name(features, gp)
    if library == CHARACTER_ARC:
        return _character_arc_mechanism_name(gp)
    if library == EMOTION_RHYTHM:
        return _emotion_mechanism_name(features, gp)
    if library == WORLDVIEW:
        return _worldview_mechanism_name(gp)
    return as_text(gp.get("template_name") or gp.get("pattern_name") or gp.get("arc_template"))


def _pattern_prefix(library: str) -> str:
    prefixes = {
        EVENTS_LIBRARY: "event",
        PAYOFF_ANGST: "payoff",
        CHARACTER_ARC: "character_arc",
        EMOTION_RHYTHM: "emotion",
        WORLDVIEW: "worldview",
    }
    return prefixes.get(library, "reference")


def _source_ref(row: dict[str, Any]) -> dict[str, Any]:
    ref = row.get("source_ref")
    return ref if isinstance(ref, dict) else {}


def _book_slug(row: dict[str, Any]) -> str:
    ref = _source_ref(row)
    value = as_text(ref.get("book_slug") or ref.get("book_id"))
    return canonical_book_slug(value) if value else ""


def _payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload")
    return payload if isinstance(payload, dict) else {}


def _generalized(row: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(row)
    value = payload.get("generalized_payload")
    return value if isinstance(value, dict) else {}


def _source_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(row)
    value = payload.get("source_payload")
    return value if isinstance(value, dict) else {}


def _feature_text(gp: dict[str, Any]) -> str:
    parts: list[str] = []
    keys = [
        "template_name",
        "pattern_name",
        "emotion_pattern_name",
        "macro_pattern",
        "micro_pattern",
        "event_template",
        "trigger_condition",
        "consequence",
        "pressure_setup",
        "delay_mechanism",
        "release_or_damage_action",
        "reader_state_change",
        "emotional_core",
        "arc_template",
        "relationship_template",
        "portable_arc",
        "character_slot",
        "worldview_mechanism",
        "mechanism_name",
        "core_rule",
    ]
    for key in keys:
        parts.append(as_text(gp.get(key)))
    parts.extend(as_list(gp.get("action_sequence")))
    parts.extend(as_list(gp.get("reader_effect")))
    role_slots = gp.get("role_slots") if isinstance(gp.get("role_slots"), dict) else {}
    parts.extend(as_text(key) for key in role_slots.keys())
    parts.extend(as_text(value) for value in role_slots.values())
    return "\n".join(part for part in parts if part)


def _feature_set(gp: dict[str, Any]) -> set[str]:
    text = _feature_text(gp)
    features: set[str] = set()
    rules = [
        ("public_pressure", ("公开", "当众", "羞辱", "评价权", "压低价值", "打脸")),
        ("betrayal_pressure", ("背叛", "旧关系", "旧爱", "前任", "出轨", "退婚")),
        ("new_relation_intervention", ("新关系", "介入", "保护", "强势关系", "关系轴心")),
        ("crisis_rescue", ("危机", "救场", "脱困", "保护者", "救援")),
        ("secret_reveal", ("秘密", "真相", "揭露", "隐藏信息")),
        ("identity_reveal", ("身份", "身份揭露")),
        ("power_structure", ("权力", "资源", "资本", "家族", "组织", "阶层", "规则")),
        ("evidence_flip", ("证据", "澄清", "翻盘")),
        ("relationship_warmup", ("关系升温", "情感绑定", "保护确认")),
        ("relationship_break", ("关系降温", "决裂", "旧关系评价权崩塌")),
        ("payoff_release", ("释放", "爽感", "价值确认", "反击")),
        ("angst_pressure", ("压迫", "疼痛", "担忧", "受损")),
    ]
    for feature, terms in rules:
        if any(term in text for term in terms):
            features.add(feature)
    return features


def _feature_set_from_many(generalized: list[dict[str, Any]]) -> set[str]:
    features: set[str] = set()
    for gp in generalized:
        features.update(_feature_set(gp))
    return features


def _event_mechanism_name(features: set[str], gp: dict[str, Any]) -> str:
    if {"public_pressure", "evidence_flip"} <= features:
        return "证据翻盘后主角夺回话语权"
    if "crisis_rescue" in features:
        return "危机袭击后保护者救场并建立依赖关系"
    if "public_pressure" in features and (features & {"betrayal_pressure", "new_relation_intervention"}):
        return "旧关系压迫后新关系介入改写评价权"
    if "identity_reveal" in features:
        return "秘密身份揭露后原有关系秩序重排"
    if "power_structure" in features and "secret_reveal" not in features:
        return "被权力结构压制后主角借更高层规则反制"
    if "secret_reveal" in features:
        return "秘密揭露后角色认知与关系秩序重排"
    if "relationship_break" in features or "betrayal_pressure" in features:
        return "旧关系失序后新关系获得正当化"
    if "new_relation_intervention" in features:
        return "新关系介入后局势和关系功能重排"
    return as_text(gp.get("macro_pattern") or gp.get("template_name") or "阶段事件改变局势")


def _payoff_mechanism_name(features: set[str], gp: dict[str, Any]) -> str:
    if {"public_pressure", "evidence_flip"} <= features:
        return "公开压迫后的证据翻盘爽点"
    if "public_pressure" in features:
        return "公开压迫后的评价权反转"
    if "crisis_rescue" in features:
        return "危机救场带来的安全感确认"
    if "identity_reveal" in features or "secret_reveal" in features:
        return "秘密揭露后的认知反转爽点"
    if "power_structure" in features:
        return "权力结构压制后的规则反制爽点"
    if "betrayal_pressure" in features and "new_relation_intervention" in features:
        return "旧关系背叛后的新关系正当化爽点"
    return as_text(gp.get("macro_pattern") or gp.get("pattern_name") or "阶段压力释放机制")


def _character_arc_mechanism_name(gp: dict[str, Any]) -> str:
    template = as_text(gp.get("arc_template") or gp.get("relationship_template"))
    slot = as_text(gp.get("character_slot"))
    if "被背叛者" in template:
        return "被背叛者从防御性反击到主体性恢复"
    if "强势介入者" in template:
        return "强势介入者从外部资源到关系轴心"
    if "评价权掌握者" in template:
        return "旧关系压迫者从评价权持有到失控追悔"
    if "旧关系评价权崩塌" in template:
        return "旧关系从控制主角到评价权崩塌"
    return template or slot or "人物关系功能变化"


def _emotion_mechanism_name(features: set[str], gp: dict[str, Any]) -> str:
    phase = as_text(gp.get("macro_pattern"))
    if phase in {
        "opening_pressure_setup",
        "early_relation_and_pressure_loop",
        "middle_reveal_and_crisis_expansion",
        "late_power_reversal_and_binding",
        "final_settlement",
    }:
        return f"全书阶段情绪曲线：{phase}"
    if "crisis_rescue" in features:
        return "危机失控到保护依赖情绪曲线"
    if "secret_reveal" in features or "identity_reveal" in features:
        return "秘密积累到认知反转情绪曲线"
    if "public_pressure" in features and "payoff_release" in features:
        return "短周期公开压迫-释放情绪曲线"
    if "relationship_break" in features:
        return "关系降温/决裂后的追悔情绪曲线"
    return as_text(gp.get("rhythm_type") or gp.get("emotion_pattern_name") or "阶段情绪推进曲线")


def _worldview_mechanism_name(gp: dict[str, Any]) -> str:
    return _worldview_mechanism_name_from_text(
        as_text(gp.get("mechanism_name") or gp.get("worldview_mechanism") or gp.get("core_rule"))
    )


def _worldview_mechanism_name_from_text(text: str) -> str:
    if any(term in text for term in ["权限", "规则", "系统", "法则", "契约"]):
        return "稳定规则系统限制角色行动边界"
    if any(term in text for term in ["资源", "奖励", "积分", "代价", "惩罚"]):
        return "资源分配与代价结算推动选择"
    if any(term in text for term in ["组织", "家族", "宗门", "门派", "阶层", "权力"]):
        return "组织层级决定评价权与资源入口"
    if any(term in text for term in ["副本", "职业", "修炼", "等级"]):
        return "成长挑战体系提供阶段目标"
    return text or "书级世界观机制"


def _definition(library: str, key: str) -> str:
    if library == EVENTS_LIBRARY:
        return f"{key}：以触发压力、行动介入和关系/评价权后果为核心的可迁移桥段模块。"
    if library == PAYOFF_ANGST:
        return f"{key}：通过可见压力、延迟释放和状态改变制造读者奖赏或疼痛。"
    if library == CHARACTER_ARC:
        return f"{key}：角色在连续压力和选择中形成的可迁移人物变化模式。"
    if library == EMOTION_RHYTHM:
        return f"{key}：用于控制长篇阶段或短周期 plot 的读者情绪推进结构。"
    if library == WORLDVIEW:
        return f"{key}：在书级范围内稳定限制身份权限、资源分配、行动代价或权力解释的规则机制。"
    return key


def _core_mechanism(library: str) -> str:
    if library == EVENTS_LIBRARY:
        return "先让压力或秘密显形，再通过证据、资源、身份、保护或关系选择改变局势，最后重排评价权、关系秩序或行动权限。"
    if library == PAYOFF_ANGST:
        return "压迫必须让读者感到主角真实受损，释放必须可见地改变评价权、关系功能或资源格局。"
    if library == CHARACTER_ARC:
        return "角色槽位在多轮压力中保持功能方向一致：初始受损/介入/压迫，经过关键选择，转为主体性恢复、关系轴心或评价权失效。"
    if library == EMOTION_RHYTHM:
        return "用压力堆叠制造等待，用释放或揭露完成情绪峰值，再用尾钩把读者带入下一轮期待。"
    if library == WORLDVIEW:
        return "世界观机制必须跨 plot 稳定存在，持续改变角色可做什么、必须付出什么、能获得什么，以及谁拥有规则解释权。"
    return ""


def _role_slots(library: str, features: set[str], generalized: list[dict[str, Any]]) -> dict[str, str]:
    slots: dict[str, str] = {}
    if library in {EVENTS_LIBRARY, PAYOFF_ANGST, EMOTION_RHYTHM}:
        slots["protagonist"] = "被压低价值、承受压力并推动状态改变的一方"
        slots["oppressor"] = "制造公开压迫、旧关系伤害或权力评价的一方"
        if features & {"new_relation_intervention", "crisis_rescue"}:
            slots["intervener"] = "以新关系、新资源或保护行动介入局势的一方"
        if "public_pressure" in features:
            slots["audience"] = "见证评价反转或关系改写的人群"
        if "secret_reveal" in features or "identity_reveal" in features:
            slots["secret_holder"] = "掌握、隐瞒或揭露关键信息的一方"
        if "power_structure" in features:
            slots["power_holder"] = "掌握资源分配、规则解释或身份权限的一方"
    if library == CHARACTER_ARC:
        for gp in generalized:
            slot = as_text(gp.get("character_slot"))
            if slot:
                slots.setdefault(slot, _slot_description(slot))
    if library == WORLDVIEW:
        slots["rule_system"] = "稳定限制行动边界、身份权限、资源流动或代价结算的规则系统"
        slots["power_holder"] = "掌握规则解释权、资源分配权或身份认证权的一方"
        slots["participant"] = "在规则内争取资源、权限或生存空间的角色"
    for gp in generalized:
        role_slots = gp.get("role_slots") if isinstance(gp.get("role_slots"), dict) else {}
        for key, value in role_slots.items():
            if key == "source_role_bindings":
                continue
            slots.setdefault(str(key), as_text(value))
    return slots


def _slot_description(slot: str) -> str:
    descriptions = {
        "protagonist": "承受压力并完成主体性变化的主角位",
        "old_relation_oppressor": "旧关系、旧评价权或控制关系的一方",
        "new_relation_intervener": "以新资源/新关系介入局势的一方",
        "relationship_axis_character": "承担关系主轴变化的角色",
        "antagonist_or_oppressor": "制造外部阻碍或压迫的一方",
    }
    return descriptions.get(slot, "承担该人物弧功能的角色槽位")


def _required_conditions(library: str, features: set[str], generalized: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for gp in generalized:
        values.extend(as_list(gp.get("required_conditions")))
    if library in {EVENTS_LIBRARY, PAYOFF_ANGST}:
        if "public_pressure" in features:
            values.extend(["压迫必须可见", "主角必须真实受损", "反击必须改变评价权或资源格局"])
        if "secret_reveal" in features:
            values.append("秘密揭露后必须带来新选择、新代价或新关系判断")
        if "crisis_rescue" in features:
            values.append("救场不能完全剥夺主角后续行动权")
    if library == CHARACTER_ARC:
        values.extend(["角色槽位要稳定", "变化必须跨多个 plot 留下可追踪证据"])
    if library == EMOTION_RHYTHM:
        values.extend(["压力、释放和尾钩的相对顺序要清楚", "阶段曲线需要服务长线关系或主线问题"])
    if library == WORLDVIEW:
        values.extend(["规则必须跨多个 plot 保持一致", "规则必须改变角色行动边界、资源入口或选择代价", "不能把一次普通剧情事件误认为世界观机制"])
    return dedupe_items(values)[:12]


def _variation_axes(library: str, features: set[str], generalized: list[dict[str, Any]]) -> list[str]:
    axes: list[str] = []
    if library in {EVENTS_LIBRARY, PAYOFF_ANGST}:
        axes.extend(["压迫场景：宴会/职场会议/宗门审判/直播舆论/学院考核"])
        axes.extend(["反击方式：证据翻盘/身份揭露/强者介入/规则反制"])
        axes.extend(["关系后果：旧关系失控/新关系正当化/群体评价反转"])
    if library == CHARACTER_ARC:
        axes.extend(["角色槽位", "初始受损状态", "关键选择", "终局关系功能"])
    if library == EMOTION_RHYTHM:
        axes.extend(["压力持续长度", "释放位置", "尾钩强度", "阶段情绪主色"])
    if library == WORLDVIEW:
        axes.extend(["规则类型：身份权限/资源分配/组织层级/代价限制/契约约束"])
        axes.extend(["执行方式：明示规则/默认秩序/惩罚系统/奖励系统/权力解释"])
        axes.extend(["叙事功能：制造限制/提供反制路径/改变评价权/扩大冲突尺度"])
    micro_values = [
        as_text(gp.get("micro_pattern") or gp.get("emotion_pattern_name") or gp.get("arc_template"))
        for gp in generalized
    ]
    axes.extend(f"候选变体：{item['value']}" for item in _top_values(micro_values, limit=5))
    return dedupe_items(axes)[:14]


def _instances_from_items(book_slug: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    instances: list[dict[str, Any]] = []
    for item in items[:24]:
        gp = _generalized(item)
        sp = _source_payload(item)
        ref = _source_ref(item)
        plot_id = as_text(ref.get("plot_id"))
        plot_span = ref.get("plot_span") if isinstance(ref.get("plot_span"), dict) else {}
        surface_form = (
            as_text(gp.get("micro_pattern"))
            or as_text(gp.get("pattern_name"))
            or as_text(gp.get("emotion_pattern_name"))
            or as_text(gp.get("arc_template"))
            or as_text(sp.get("pressure_source"))
        )
        instances.append(
            {
                "book_slug": book_slug,
                "plot_ids": [plot_id] if plot_id else [],
                "plot_span": plot_span,
                "surface_form": surface_form,
                "source_ref": ref,
                "source_layer": item.get("_source_layer", ""),
            }
        )
    return instances


def _book_profile_support(library: str, book_slug: str, contexts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    context = contexts.get(book_slug) or {}
    profile = context.get("book_profile") if isinstance(context.get("book_profile"), dict) else {}
    row: dict[str, Any] = {
        "book_slug": book_slug,
        "reference_status": profile.get("reference_status", ""),
        "core_narrative_mechanism": profile.get("core_narrative_mechanism", ""),
        "portable_structures": profile.get("portable_structures", []),
    }
    if library == PAYOFF_ANGST:
        payoff = context.get("payoff_structure") if isinstance(context.get("payoff_structure"), dict) else {}
        row["overall_payoff_mechanism"] = payoff.get("overall_payoff_mechanism", "")
    if library == EMOTION_RHYTHM:
        emotion = context.get("emotion_curve") if isinstance(context.get("emotion_curve"), dict) else {}
        row["overall_emotion_mechanism"] = emotion.get("overall_emotion_mechanism", "")
    if library == CHARACTER_ARC:
        row["character_arc_count"] = len(context.get("character_arcs") or [])
    if library == WORLDVIEW:
        worldview = context.get("worldview_profile") if isinstance(context.get("worldview_profile"), dict) else {}
        row["worldview_signal_plot_count"] = worldview.get("worldview_signal_plot_count", 0)
        row["stability_level"] = worldview.get("stability_level", "")
        row["worldview_mechanism_summary"] = worldview.get("worldview_mechanism_summary", "")
    return row


def _common_candidate_forms(library: str, generalized: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = {
        EVENTS_LIBRARY: ("event_template", "micro_pattern"),
        PAYOFF_ANGST: ("transferable_form", "micro_pattern"),
        CHARACTER_ARC: ("arc_template", "portable_arc"),
        EMOTION_RHYTHM: ("emotion_pattern_name", "rhythm_type"),
        WORLDVIEW: ("worldview_mechanism", "mechanism_name"),
    }.get(library, ("micro_pattern",))
    values: list[str] = []
    for gp in generalized:
        for key in keys:
            text = as_text(gp.get(key))
            if text:
                values.append(text)
                break
    return _top_values(values, limit=8)


def _book_specific_elements(supported_books: list[str], contexts: dict[str, dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for book_slug in supported_books:
        profile = (contexts.get(book_slug) or {}).get("book_profile")
        if isinstance(profile, dict):
            values.extend(as_list(profile.get("book_specific_elements")))
    return dedupe_items(values)[:16]


def _failure_risks(library: str, generalized: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for gp in generalized:
        values.extend(as_list(gp.get("failure_risks")))
        risk = as_text(gp.get("failure_risk"))
        if risk:
            values.append(risk)
    if library in {EVENTS_LIBRARY, PAYOFF_ANGST}:
        values.extend(["反派过度降智", "反击全靠外部强者导致主角失去主动性", "压迫不够具体导致爽点无力"])
    if library == CHARACTER_ARC:
        values.append("只记录人物出现次数而没有状态方向，会退化成人物索引")
    if library == EMOTION_RHYTHM:
        values.append("只有 plot beat 列表而没有阶段情绪功能，会退化成节奏统计")
    if library == WORLDVIEW:
        values.extend(["把一次性剧情设定误当成稳定规则", "规则没有代价或权限边界，导致世界观无法复用", "只记录名词设定而没有叙事功能"])
    return dedupe_items(values)[:12]


def _generation_usage(library: str) -> str:
    if library == EVENTS_LIBRARY:
        return "用于选择桥段骨架：替换角色槽位、场景外壳和行动资源，保留触发-行动-后果结构。"
    if library == PAYOFF_ANGST:
        return "用于安排爽点/刀点：先建立可感知压力，再延迟释放，最后改变评价权、关系或资源格局。"
    if library == CHARACTER_ARC:
        return "用于规划人物线：跨多个 plot 保持初始状态、压力、关键选择和最终状态的方向一致。"
    if library == EMOTION_RHYTHM:
        return "用于控制章节和全书阶段情绪：决定压力堆叠、释放点、尾钩和读者余味。"
    if library == WORLDVIEW:
        return "用于规划书级规则：先确定身份权限、资源分配、行动代价和规则解释者，再让事件与人物选择受这些规则持续约束。"
    return "用于生成阶段的参考模式。"


def _top_values(values: Any, *, limit: int = 8) -> list[dict[str, Any]]:
    counter = Counter(as_text(value) for value in values if as_text(value))
    return [
        {"value": value, "count": count}
        for value, count in counter.most_common(limit)
    ]


def _source_instance_count(rows: list[dict[str, Any]]) -> int:
    return sum(int(row.get("within_book_support_count") or len(row.get("instances") or [])) for row in rows)


def _first_text(rows: list[dict[str, Any]], key: str) -> str:
    for row in rows:
        text = as_text(row.get(key))
        if text:
            return text
    return ""


def _merged_role_slots(rows: list[dict[str, Any]]) -> dict[str, str]:
    slots: dict[str, str] = {}
    for row in rows:
        role_slots = row.get("role_slots") if isinstance(row.get("role_slots"), dict) else {}
        for key, value in role_slots.items():
            slots.setdefault(str(key), as_text(value))
    return slots


def _merged_field_lists(rows: list[dict[str, Any]], key: str) -> list[str]:
    values: list[str] = []
    for row in rows:
        values.extend(as_list(row.get(key)))
    return dedupe_items(values)[:16]


def _merged_instances(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    instances: list[dict[str, Any]] = []
    for row in rows:
        instances.extend(item for item in as_list(row.get("instances")) if isinstance(item, dict))
    return instances[:48]
