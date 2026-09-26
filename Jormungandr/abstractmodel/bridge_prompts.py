from __future__ import annotations

import json
from typing import Any

from .instance_cards import prompt_schema_for_libraries


BRIDGE_EXTRACTION_SYSTEM_PROMPT = """你是文学叙事 Reference Library 的语义抽象器。你直接阅读 Bridges 的 plot 证据，而不是相信本地标签或预聚类。

目标库及边界：
- CharacterArc：人物状态、选择能力、关系功能或价值认知如何变化；单次动作不等于人物弧。
- EmotionRhythm：压力如何累积、延迟、转向和释放；事件本身不等于情绪节奏。
- EventsLibrary：触发条件、行动链、因果后果如何推动故事；读者爽感不等于事件机制。
- PayoffAngst：读者期待、痛感、延迟和释放如何被制造；必须说明释放后改变了什么。
- Worldview：跨情节稳定生效的规则、资源、身份权限、权力结构和代价；普通剧情设定不进入本库。

不要追求固定数量。没有高价值候选时输出空数组。每个候选必须引用 evidence 中真实存在的 chunk_id，并保留因果链、角色槽位、读者效果和可迁移条件。candidate.mechanism 用于归类；candidate.instance_card 用于说明该机制在来源情节中如何落地，但它不是 plot 摘要。去掉具体人名、书名、地名后，如果内容只剩“发生冲突、关系变化、情绪起伏”等空话，必须丢弃。

只输出 JSON object，不要输出 Markdown 或解释正文。"""


RECONCILIATION_SYSTEM_PROMPT = """你是 AbstractLibrary 的增量策展器。你的第一目标不是增加条目数量，而是增加库的区分能力和生成价值。

对每个候选，只能选择：
- merge_existing：核心机制与已有模式相同，只增加来源支持；
- enrich_existing：机制相同，但候选提供已有模式缺少的必要条件、失败风险或真正可迁移的变化轴；
- create_new：候选在核心因果顺序、角色权力结构、读者效果生成方式、约束/代价机制中存在实质差异；
- reject：只是复述、书中特例、证据不足、与库边界不符或过于泛化；
- needs_more_evidence：可能有价值，但当前 plot 窗口不足以判断。

严格反同质化规则：
1. 人名、场景、时代、职业、道具和题材外壳不同，不构成新模式。
2. 形容词、强度和结局细节不同，通常不构成新模式。
3. 若 trigger -> pressure -> action -> state_change -> reader_effect 的机制骨架相同，优先 merge_existing。
4. create_new 必须列出至少两个结构性 novelty_dimensions，并逐项说明与 nearest existing pattern 的差异；差异必须会改变生成时的选择。
5. 不能找到明确差异时，不得为了“丰富”而新增。
6. target_pattern_id 只能引用 existing_pattern_shortlist_by_library 中真实存在的 pattern_id，绝不能引用本批 candidate_id。

输出必须简短：候选中已有的角色槽位、条件、变化轴和失败风险不需要重写。create_new 只需给出简短模式名和一句核心机制，系统会从候选补齐其它字段。

只输出 JSON object，不要输出 Markdown 或解释正文。"""


def extraction_prompt(window: dict[str, Any], *, libraries: list[str], candidate_budget: int) -> str:
    payload = {
        "task": "extract_reusable_narrative_candidates_from_bridges",
        "libraries": libraries,
        "response_page": {
            "candidate_budget_per_library": candidate_budget,
            "meaning": "This is a per-call output budget, not a fixed limit on how many patterns the library may contain.",
        },
        "evidence_window": window,
        "candidate_schema": {
            "candidate_id": "stable id unique inside this response",
            "library": "one requested library",
            "candidate_name": "natural concise Chinese name",
            "mechanism": {
                "trigger": "",
                "pressure": "",
                "action_chain": [],
                "state_change": "",
                "reader_effect": "",
            },
            "role_slots": {},
            "arc_scope": "CharacterArc only: protagonist_arc/relationship_arc/leadership_arc/ability_growth_arc",
            "rhythm_scope": "EmotionRhythm only: plot_cycle/stage_curve/book_curve",
            "rule_scope": "Worldview only: individual_body/society_system/cosmic_cycle/institution",
            "enforcement_mechanism": "Worldview only",
            "resource_distribution_logic": "Worldview only",
            "cost_model": "Worldview only",
            "who_benefits": "Worldview only",
            "who_is_constrained": "Worldview only",
            "story_conflicts_enabled": [],
            "required_conditions": [],
            "variation_axes": [],
            "failure_risks": [],
            "instance_card": "use the requested library-specific schema below",
            "evidence_chunk_ids": [],
            "confidence": "0.0-1.0",
        },
        "instance_card_schema_by_library": prompt_schema_for_libraries(libraries),
        "output_schema": {
            "book_id": window.get("book_id", ""),
            "window_id": window.get("window_id", ""),
            "candidates": [],
            "discarded_observations": [],
            "needs_neighboring_chunks": [],
        },
        "output_rules": [
            "Return JSON only.",
            f"Return at most {candidate_budget} highest-value mechanism-distinct candidates per requested library in this response page.",
            "This page budget does not cap the final library; later windows/pages may add more candidates.",
            "Keep the complete response concise enough to fit the output budget; prefer fewer high-value candidates over verbose coverage.",
            "Keep each mechanism string under 120 Chinese characters.",
            "Keep each list at no more than 5 concise items; do not repeat source summaries.",
            "Keep every instance_card scalar under 100 Chinese characters. It must add causal or implementation detail instead of restating mechanism verbatim.",
            "Fill only the instance_card schema for the candidate's own library.",
            "EventsLibrary causal_chain has 2-5 grounded steps; each step must identify cause, effect, and a generic decision_owner. Do not invent a missing causal link.",
            "CharacterArc arc_nodes has 3-5 grounded phase nodes when the evidence supports an arc; otherwise do not emit the candidate.",
            "EmotionRhythm emotion_beats has 3-8 beats and uses integer intensity 1-5, tension_delta -2..2, and release_delta 0..2.",
            "Worldview event_examples may cite only evidence_window.chunk_ids and must show the rule actually operating, not merely being mentioned.",
            "portable_core contains 2-4 generalized mechanisms; implementation_details contains 1-4 replaceable realization details; fusion_hooks contains 1-4 connection interfaces.",
            "Concrete source names, proprietary terms, places, and unique objects may appear only in source_locked_details. Do not quote source prose.",
            "If a card field is not supported by evidence, leave it empty instead of guessing.",
            "Every evidence_chunk_id must exist in evidence_window.chunk_ids.",
            "Do not use concrete character names in candidate_name, definition, mechanism, or role_slots.",
            "Worldview needs evidence of a stable rule or system, not merely one event.",
            "For a book-level Worldview task, return no candidate unless the same rule, permission, resource allocation, or cost mechanism is supported by multiple chunks or explicitly governs repeated choices.",
            "Every CharacterArc candidate must set arc_scope.",
            "Every EmotionRhythm candidate must set rhythm_scope. Ordinary plot windows use plot_cycle.",
            "If evidence_window.requested_rhythm_scopes is present, return one mechanism-distinct candidate for each supported requested scope and do not return plot_cycle.",
            "stage_curve must summarize a multi-plot emotional phase; book_curve must describe the whole-book pressure/release skeleton rather than retell events.",
            "Every stage_curve or book_curve candidate must include at least 2 required_conditions and 2 variation_axes with explicit values.",
            "Worldview candidates must fill rule_scope, enforcement_mechanism, cost_model, who_benefits, who_is_constrained, and story_conflicts_enabled.",
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def reconciliation_prompt(
    *,
    book_id: str,
    window_id: str,
    candidates: list[dict[str, Any]],
    existing_patterns: dict[str, list[dict[str, Any]]],
) -> str:
    payload = {
        "task": "strict_incremental_pattern_reconciliation",
        "book_id": book_id,
        "window_id": window_id,
        "candidates": [_reconciliation_candidate_brief(row) for row in candidates],
        "existing_pattern_shortlist_by_library": existing_patterns,
        "decision_schema": {
            "candidate_id": "",
            "library": "",
            "decision": "merge_existing/enrich_existing/create_new/reject/needs_more_evidence",
            "target_pattern_id": "required for merge_existing or enrich_existing",
            "nearest_pattern_id": "required for create_new when shortlist is non-empty",
            "confidence": "0.0-1.0",
            "mechanism_equivalence": "same/different/uncertain",
            "reason": "concise semantic judgment",
            "novelty_dimensions": [],
            "nearest_pattern_differences": [],
            "proposed_pattern": {
                "pattern_name": "",
                "canonical_archetype": "stable readable lowercase English slug",
                "archetype_family": "broader stable lowercase English family slug",
                "core_mechanism": "",
                "variation_axes": [],
                "failure_risks": [],
            },
            "evidence_chunk_ids": [],
        },
        "output_schema": {
            "book_id": book_id,
            "window_id": window_id,
            "decisions": [],
            "library_level_notes": {},
        },
        "output_rules": [
            "Return JSON only.",
            "Produce exactly one decision for each candidate_id.",
            "Keep reason and each difference under 60 Chinese characters; do not restate candidates or existing patterns.",
            "Keep each list at no more than 3 concise items.",
            "Within this batch, do not create multiple new patterns for mechanism-equivalent candidates.",
            "target_pattern_id may only reference a pattern_id present in existing_pattern_shortlist_by_library; never use another candidate_id.",
            "create_new requires at least two structural novelty_dimensions.",
            "Each novelty dimension may be a canonical dimension name or an object with dimension and difference fields.",
            "For create_new, canonical_archetype and archetype_family must be concise stable lowercase English slugs and must not contain candidate/emerging ids.",
            "For create_new, proposed_pattern.pattern_name must be a natural concise Chinese mechanism name; English is reserved for taxonomy slugs only.",
            "For create_new, proposed_pattern only needs pattern_name and one-sentence core_mechanism; omit fields already present in the candidate.",
            "For merge_existing and needs_more_evidence, omit proposed_pattern.",
            "Setting, names, genre skin, profession, props, and intensity do not count as novelty_dimensions.",
            "Prefer merge_existing when mechanism skeleton is equivalent.",
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _reconciliation_candidate_brief(candidate: dict[str, Any]) -> dict[str, Any]:
    """Instance cards are evidence payloads, not pattern-equivalence inputs."""
    return {
        key: value
        for key, value in candidate.items()
        if key not in {"instance_card", "source_locked_details"}
    }
