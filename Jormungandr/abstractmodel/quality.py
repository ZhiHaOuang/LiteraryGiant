from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from shared import as_list, as_mapping, as_text, dedupe_items

from .schemas import CHARACTER_ARC, EMOTION_RHYTHM, EVENTS_LIBRARY, PAYOFF_ANGST


QUALITY_SCHEMA_VERSION = "abstract_candidate_quality.v1"

RAW = "raw"
CANDIDATE = "candidate"
LOCAL_PATTERN_SEED = "local_pattern_seed"
REJECTED = "rejected"
QUALITY_TIERS = (RAW, CANDIDATE, LOCAL_PATTERN_SEED, REJECTED)

LLM_REVIEW_LOW = 0.55
LLM_REVIEW_HIGH = 0.75


def apply_quality_gate(item: dict[str, Any]) -> dict[str, Any]:
    """Attach quality metadata to a candidate object.

    The gate is intentionally deterministic. LLM review can later adjust a
    borderline candidate, but this function decides what can flow into the
    first candidate layer without spending tokens.
    """
    enriched = dict(item)
    quality = score_candidate(enriched)
    enriched.update(
        {
            "abstraction_value_score": quality["abstraction_value_score"],
            "reuse_value_score": quality["reuse_value_score"],
            "source_dependency_score": quality["source_dependency_score"],
            "specificity_score": quality["specificity_score"],
            "quality_tier": quality["quality_tier"],
            "quality_reasons": quality["quality_reasons"],
            "llm_review_status": quality["llm_review_status"],
        }
    )
    enriched["confidence"] = quality["confidence"]
    payload = as_mapping(enriched.get("payload"))
    payload["quality"] = quality
    enriched["payload"] = payload
    return enriched


def score_candidate(item: dict[str, Any]) -> dict[str, Any]:
    library = as_text(item.get("library"))
    payload = as_mapping(item.get("payload"))
    source_payload = as_mapping(payload.get("source_payload"))
    generalized_payload = as_mapping(payload.get("generalized_payload"))

    if library == EVENTS_LIBRARY:
        scores, missing = _score_event(source_payload, generalized_payload)
    elif library == PAYOFF_ANGST:
        scores, missing = _score_payoff(source_payload, generalized_payload)
    elif library == CHARACTER_ARC:
        scores, missing = _score_character_arc(source_payload, generalized_payload)
    elif library == EMOTION_RHYTHM:
        scores, missing = _score_emotion(source_payload, generalized_payload)
    else:
        scores, missing = _score_generic(source_payload, generalized_payload)

    abstraction = scores["abstraction_value_score"]
    reuse = scores["reuse_value_score"]
    source_dependency = scores["source_dependency_score"]
    specificity = scores["specificity_score"]
    confidence = _clamp(
        (abstraction * 0.42)
        + (reuse * 0.33)
        + (specificity * 0.15)
        + ((1.0 - source_dependency) * 0.10)
    )
    cap, cap_reasons = _confidence_cap(library, item, source_payload, generalized_payload, scores)
    confidence = min(confidence, cap)
    hard_rejected = bool(missing)
    if hard_rejected:
        tier = REJECTED
    elif confidence >= LLM_REVIEW_HIGH:
        tier = LOCAL_PATTERN_SEED
    elif confidence >= LLM_REVIEW_LOW:
        tier = CANDIDATE
    else:
        tier = RAW

    return {
        "schema_version": QUALITY_SCHEMA_VERSION,
        **{key: round(value, 4) for key, value in scores.items()},
        "confidence": round(0.0 if hard_rejected else confidence, 4),
        "quality_tier": tier,
        "quality_reasons": _quality_reasons(tier, missing, scores, cap_reasons),
        "missing_required_fields": missing,
        "llm_review_status": _llm_review_status(tier, confidence),
    }


def is_candidate_tier(item: dict[str, Any]) -> bool:
    tier = _quality_tier(item)
    return tier in {CANDIDATE, LOCAL_PATTERN_SEED}


def is_pattern_seed(item: dict[str, Any]) -> bool:
    return _quality_tier(item) == LOCAL_PATTERN_SEED


def _quality_tier(item: dict[str, Any]) -> str:
    tier = as_text(item.get("quality_tier"))
    if tier:
        return tier
    payload = as_mapping(item.get("payload"))
    quality = as_mapping(payload.get("quality"))
    return as_text(quality.get("quality_tier"))


def split_by_quality(objects_by_library: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, list[dict[str, Any]]]]:
    layers: dict[str, dict[str, list[dict[str, Any]]]] = {
        "raw": {},
        "candidates": {},
        "local_pattern_seeds": {},
        "rejected": {},
    }
    for library, rows in objects_by_library.items():
        raw_rows: list[dict[str, Any]] = []
        candidate_rows: list[dict[str, Any]] = []
        seed_rows: list[dict[str, Any]] = []
        rejected_rows: list[dict[str, Any]] = []
        for row in rows:
            raw_rows.append(row)
            tier = _quality_tier(row)
            if tier == LOCAL_PATTERN_SEED:
                candidate_rows.append(row)
                seed_rows.append(row)
            elif tier == CANDIDATE:
                candidate_rows.append(row)
            elif tier == REJECTED:
                rejected_rows.append(row)
        layers["raw"][library] = raw_rows
        layers["candidates"][library] = candidate_rows
        layers["local_pattern_seeds"][library] = seed_rows
        layers["rejected"][library] = rejected_rows
    return layers


def build_quality_report(processed_book: dict[str, Any]) -> dict[str, Any]:
    layers = processed_book.get("quality_layers") if isinstance(processed_book.get("quality_layers"), dict) else {}
    raw = layers.get("raw") if isinstance(layers.get("raw"), dict) else {}
    accepted = layers.get("candidates") if isinstance(layers.get("candidates"), dict) else {}
    seeds = layers.get("local_pattern_seeds") if isinstance(layers.get("local_pattern_seeds"), dict) else {}
    rejected = layers.get("rejected") if isinstance(layers.get("rejected"), dict) else {}

    tier_counts: Counter[str] = Counter()
    library_counts: dict[str, dict[str, int]] = {}
    review_counts: Counter[str] = Counter()
    score_sums: dict[str, Counter[str]] = defaultdict(Counter)
    score_counts: Counter[str] = Counter()
    for library, rows in raw.items():
        lib_counts: Counter[str] = Counter()
        for row in rows or []:
            tier = _quality_tier(row) or RAW
            tier_counts[tier] += 1
            lib_counts[tier] += 1
            review_counts[as_text(row.get("llm_review_status")) or "not_required"] += 1
            for score_key in [
                "abstraction_value_score",
                "reuse_value_score",
                "source_dependency_score",
                "specificity_score",
                "confidence",
            ]:
                value = row.get(score_key)
                if isinstance(value, (int, float)):
                    score_sums[library][score_key] += float(value)
            score_counts[library] += 1
        library_counts[library] = {
            "raw_total": len(rows or []),
            "candidate_count": len(accepted.get(library) or []),
            "local_pattern_seed_count": len(seeds.get(library) or []),
            "rejected_count": len(rejected.get(library) or []),
            "tier_counts": dict(lib_counts),
        }

    average_scores: dict[str, dict[str, float]] = {}
    for library, sums in score_sums.items():
        count = max(1, score_counts[library])
        average_scores[library] = {key: round(value / count, 4) for key, value in sums.items()}

    raw_total = sum(len(rows or []) for rows in raw.values())
    accepted_total = sum(len(rows or []) for rows in accepted.values())
    rejected_total = sum(len(rows or []) for rows in rejected.values())
    return {
        "schema_version": "abstract_quality_report.v1",
        "book_id": processed_book.get("book_id", ""),
        "book_slug": processed_book.get("book_slug", ""),
        "raw_candidate_count": raw_total,
        "candidate_count": accepted_total,
        "local_pattern_seed_count": sum(len(rows or []) for rows in seeds.values()),
        "rejected_count": rejected_total,
        "candidate_pass_rate": round(accepted_total / raw_total, 4) if raw_total else 0.0,
        "rejected_rate": round(rejected_total / raw_total, 4) if raw_total else 0.0,
        "tier_counts": {tier: tier_counts.get(tier, 0) for tier in QUALITY_TIERS},
        "llm_review_counts": dict(review_counts),
        "library_counts": library_counts,
        "average_scores": average_scores,
    }


def _score_event(source_payload: dict[str, Any], gp: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    action_sequence = as_list(gp.get("action_sequence"))
    role_slots = as_mapping(gp.get("role_slots"))
    source_events = as_list(source_payload.get("source_events"))
    missing = _missing(
        {
            "trigger_condition": as_text(gp.get("trigger_condition")),
            "action_sequence": len(action_sequence) >= 3,
            "consequence": as_text(gp.get("consequence")),
            "role_slots": len(role_slots) >= 2,
            "event_template": as_text(gp.get("event_template")),
        }
    )
    abstraction = _ratio(
        [
            gp.get("trigger_condition"),
            len(action_sequence) >= 3,
            gp.get("consequence"),
            gp.get("event_template"),
            source_events,
        ]
    )
    reuse = _ratio([len(role_slots) >= 2, gp.get("transferable_genres"), gp.get("failure_risks")])
    specificity = _ratio([source_events, source_payload.get("conflict_model"), source_payload.get("setup_context")])
    return _scores(abstraction, reuse, specificity, _source_dependency(source_payload, gp)), missing


def _score_payoff(source_payload: dict[str, Any], gp: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    reward = as_list(gp.get("reader_reward_or_pain"))
    required = as_list(gp.get("required_conditions"))
    risks = as_list(gp.get("failure_risks"))
    missing = _missing(
        {
            "pressure_setup": as_text(gp.get("pressure_setup")),
            "release_or_damage_action": as_text(gp.get("release_or_damage_action")),
            "reader_reward_or_pain": reward,
            "required_conditions": required,
            "failure_risks": risks,
        }
    )
    abstraction = _ratio(
        [
            gp.get("pressure_setup"),
            gp.get("delay_mechanism"),
            gp.get("release_or_damage_action"),
            gp.get("state_change_after"),
            reward,
        ]
    )
    reuse = _ratio([gp.get("transferable_form"), required, risks])
    specificity = _ratio([source_payload.get("pressure_source"), source_payload.get("reader_payoffs"), source_payload.get("angst_points")])
    return _scores(abstraction, reuse, specificity, _source_dependency(source_payload, gp)), missing


def _score_character_arc(source_payload: dict[str, Any], gp: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    initial = as_text(gp.get("initial_state") or gp.get("before_state"))
    final = as_text(gp.get("final_state") or gp.get("after_state"))
    pressure = as_text(gp.get("external_pressure") or gp.get("change_driver"))
    action = as_text(gp.get("turning_action") or gp.get("change_driver"))
    arc_function = as_list(gp.get("arc_function") or gp.get("relation_function"))
    missing = _missing(
        {
            "initial_or_before_state": initial,
            "final_or_after_state": final,
            "external_pressure_or_key_choice": pressure or action,
            "arc_function": arc_function,
        }
    )
    abstraction = _ratio([initial, final, pressure or action, arc_function])
    reuse = _ratio([gp.get("character_slot") or gp.get("relationship_template"), gp.get("failure_risk") or gp.get("reuse_note")])
    specificity = _ratio([source_payload.get("state_change") or source_payload.get("after"), source_payload.get("role_in_plot") or source_payload.get("before")])
    return _scores(abstraction, reuse, specificity, _source_dependency(source_payload, gp)), missing


def _score_emotion(source_payload: dict[str, Any], gp: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    curve = as_list(gp.get("emotion_curve") or source_payload.get("beat_sequence"))
    reader_state = as_text(gp.get("reader_state_change"))
    missing = _missing(
        {
            "emotion_curve_or_beat_sequence": curve,
            "rhythm_type": as_text(gp.get("rhythm_type")),
            "reader_state_change": reader_state,
            "release_position": as_text(gp.get("release_position")),
        }
    )
    has_tension_or_release = any(
        marker in "\n".join(as_text(item) for item in [curve, reader_state, gp.get("tension_accumulation")])
        for marker in ["压迫", "释放", "悬念", "tension", "release", "hook"]
    )
    abstraction = _ratio([curve, gp.get("rhythm_type"), reader_state, has_tension_or_release])
    reuse = _ratio([gp.get("reuse_note"), gp.get("emotional_core"), gp.get("reader_effect")])
    specificity = _ratio([source_payload.get("reader_payoffs"), source_payload.get("angst_points"), source_payload.get("suspense_hooks")])
    return _scores(abstraction, reuse, specificity, _source_dependency(source_payload, gp)), missing


def _score_generic(source_payload: dict[str, Any], gp: dict[str, Any]) -> tuple[dict[str, float], list[str]]:
    missing = [] if gp else ["generalized_payload"]
    abstraction = _ratio(gp.values()) if gp else 0.0
    specificity = _ratio(source_payload.values()) if source_payload else 0.0
    return _scores(abstraction, abstraction, specificity, _source_dependency(source_payload, gp)), missing


def _scores(abstraction: float, reuse: float, specificity: float, source_dependency: float) -> dict[str, float]:
    return {
        "abstraction_value_score": _clamp(abstraction),
        "reuse_value_score": _clamp(reuse),
        "source_dependency_score": _clamp(source_dependency),
        "specificity_score": _clamp(specificity),
    }


def _missing(requirements: dict[str, object]) -> list[str]:
    return [key for key, value in requirements.items() if not _truthy(value)]


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return bool(as_text(value))


def _ratio(values: object) -> float:
    items = list(values) if not isinstance(values, dict) else list(values.values())
    if not items:
        return 0.0
    return sum(1 for item in items if _truthy(item)) / len(items)


def _source_dependency(source_payload: dict[str, Any], gp: dict[str, Any]) -> float:
    source_text = "\n".join(_flatten_text(source_payload))
    generalized_text = "\n".join(_flatten_text(gp))
    if not generalized_text:
        return 1.0
    source_terms = set(_term_candidates(source_text))
    generalized_terms = set(_term_candidates(generalized_text))
    if not source_terms:
        return 0.2
    overlap = len(source_terms & generalized_terms) / max(1, len(generalized_terms))
    # High overlap usually means the candidate still carries too much source
    # surface, but cap it so Chinese role labels do not over-penalize.
    return min(0.85, overlap)


def _flatten_text(value: object) -> list[str]:
    texts: list[str] = []
    if isinstance(value, dict):
        for item in value.values():
            texts.extend(_flatten_text(item))
    elif isinstance(value, list):
        for item in value:
            texts.extend(_flatten_text(item))
    else:
        text = as_text(value)
        if text:
            texts.append(text)
    return texts


def _term_candidates(text: str) -> list[str]:
    tokens: list[str] = []
    buffer = []
    for char in text:
        if char.isalnum() or "\u4e00" <= char <= "\u9fff":
            buffer.append(char)
        else:
            if len(buffer) >= 2:
                tokens.append("".join(buffer))
            buffer = []
    if len(buffer) >= 2:
        tokens.append("".join(buffer))
    # Short Chinese strings often have no separators; add coarse 2-4 char grams.
    compact = "".join(ch for ch in text if "\u4e00" <= ch <= "\u9fff")
    for size in (2, 3, 4):
        for index in range(0, max(0, len(compact) - size + 1), size):
            tokens.append(compact[index:index + size])
    return dedupe_items(tokens)


def _confidence_cap(
    library: str,
    item: dict[str, Any],
    source_payload: dict[str, Any],
    gp: dict[str, Any],
    scores: dict[str, float],
) -> tuple[float, list[str]]:
    cap = 1.0
    reasons: list[str] = []
    name = _pattern_name(library, gp)
    object_type = as_text(item.get("object_type"))
    if _looks_like_tag_join(name):
        cap = min(cap, 0.74)
        reasons.append("pattern_name_is_tag_join")
    if library == CHARACTER_ARC:
        template = as_text(gp.get("arc_template") or gp.get("relationship_template"))
        if template in {"配角状态推动局部关系变化", "关系状态重排"}:
            cap = min(cap, 0.54)
            reasons.append("generic_character_arc_template")
        if object_type == "relationship_change_fragment" and template != "旧关系评价权崩塌":
            cap = min(cap, 0.68)
            reasons.append("relationship_fragment_needs_book_merge")
    if library == EMOTION_RHYTHM:
        rhythm = as_text(gp.get("rhythm_type"))
        if rhythm in {"情绪转场", "悬念延迟"} and not as_list(source_payload.get("reader_payoffs")):
            cap = min(cap, 0.66)
            reasons.append("emotion_fragment_needs_book_curve")
    if library == EVENTS_LIBRARY and as_text(gp.get("event_template")) == "一组行动改变角色关系、问题状态或冲突方向":
        cap = min(cap, 0.66)
        reasons.append("generic_event_template")
    if library == PAYOFF_ANGST and as_text(gp.get("macro_pattern")) == "阶段压力释放机制":
        cap = min(cap, 0.72)
        reasons.append("generic_payoff_stage_mechanism")
    if scores["source_dependency_score"] > 0.4:
        cap = min(cap, 0.74)
        reasons.append("source_dependency_above_pattern_seed_threshold")
    return cap, reasons


def _pattern_name(library: str, gp: dict[str, Any]) -> str:
    for key in [
        "pattern_name",
        "template_name",
        "emotion_pattern_name",
        "event_template",
        "arc_template",
        "relationship_template",
        "macro_pattern",
    ]:
        text = as_text(gp.get(key))
        if text:
            return text
    return library


def _looks_like_tag_join(value: str) -> bool:
    return any(marker in value for marker in (" + ", "+", "＋")) or value.count("、") >= 3


def _quality_reasons(tier: str, missing: list[str], scores: dict[str, float], cap_reasons: list[str]) -> list[str]:
    if tier == REJECTED:
        return [f"missing_required:{field}" for field in missing]
    reasons = [f"tier:{tier}"]
    reasons.extend(cap_reasons)
    if scores["reuse_value_score"] >= 0.75:
        reasons.append("high_reuse_value")
    if scores["source_dependency_score"] > 0.4:
        reasons.append("source_dependency_needs_review")
    if scores["abstraction_value_score"] < 0.6:
        reasons.append("weak_abstraction_value")
    return reasons


def _llm_review_status(tier: str, confidence: float) -> str:
    if tier == CANDIDATE and LLM_REVIEW_LOW <= confidence < LLM_REVIEW_HIGH:
        return "needs_review"
    if tier == LOCAL_PATTERN_SEED:
        return "rule_passed"
    if tier == REJECTED:
        return "not_eligible"
    return "not_required"


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))
