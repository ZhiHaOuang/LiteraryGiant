from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
import re
from typing import Any

from shared import as_list, as_mapping, as_text

from .pattern_store import _worldview_evidence_reason, read_jsonl


def build_worldview_threshold_report(
    *,
    abstract_library_root: str | Path,
    llm_extracted_root: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(abstract_library_root)
    extracted_root = Path(llm_extracted_root) if llm_extracted_root else root.parent / "LLMExtracted"
    candidates = _worldview_candidates(extracted_root)
    reason_counts: Counter[str] = Counter()
    include: list[dict[str, Any]] = []
    reject: list[dict[str, Any]] = []
    for candidate in candidates:
        reason = _worldview_evidence_reason(candidate)
        summary = {
            "candidate_id": candidate.get("candidate_id", ""),
            "candidate_name": candidate.get("candidate_name", ""),
            "book_id": candidate.get("book_id", ""),
            "evidence_chunk_ids": as_list(candidate.get("evidence_chunk_ids")),
            "confidence": candidate.get("confidence", 0.0),
        }
        if reason:
            reason_counts[reason] += 1
            reject.append({**summary, "reason": reason})
        else:
            include.append(
                {
                    **summary,
                    "reason": "具有至少两段高置信情节证据，并覆盖稳定规则与多个制度维度；仍需 reconciliation 后才能入库。",
                }
            )
    current_worldview = read_jsonl(root / "Worldview" / "universal_patterns.jsonl") + read_jsonl(
        root / "Worldview" / "emerging_patterns.jsonl"
    )
    why_empty = []
    if not current_worldview:
        why_empty.append("Worldview 尚无通过 reconciliation 并 commit 的 source pattern。")
    if candidates:
        why_empty.append(f"历史抽取发现 {len(candidates)} 个候选，其中 {sum(reason_counts.values())} 个未通过当前质量门槛。")
    why_empty.append("Worldview 只使用 book-level repeated-rule task，不参与普通 plot window routing。")
    return {
        "current_worldview_count": len(current_worldview),
        "why_empty": why_empty,
        "current_thresholds": {
            "routing_scope": "book_level_only",
            "minimum_distinct_plot_evidence": 2,
            "two_plot_minimum_confidence": 0.85,
            "minimum_structural_system_dimensions": 2,
            "requires_stable_system_term": True,
            "single_plot_candidate_allowed": False,
        },
        "recommended_threshold_changes": [
            "已将固定三段证据改为：至少两段；只有两段时 confidence 必须不低于 0.85。",
            "两段证据还必须同时命中稳定规则词与至少两个制度维度，避免普通事件进入 Worldview。",
            "继续保留 book-level routing，不对单 plot 强抽 Worldview。",
            "novelty dimension 识别新增规则、周期、筛选、操控、牺牲等 Worldview 结构词。",
        ],
        "false_positive_risks": [
            "高权力人物单次介入可能被误判为稳定权力结构。",
            "只在结局揭露一次的设定可能缺少跨情节可验证性。",
            "能力、道具或地点设定可能伪装成资源分配规则。",
            "事件造成的关系代价不能自动等同于制度执行成本。",
        ],
        "example_candidates_to_include": include[:8],
        "example_candidates_to_reject": reject[:12],
        "historical_candidate_count": len(candidates),
        "historical_rejection_reason_counts": dict(sorted(reason_counts.items())),
    }


def _worldview_candidates(root: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    if not root.exists():
        return result
    extraction_paths = [
        path
        for path in root.glob("*/extractions.jsonl")
        if re.fullmatch(r"id\d{6}", path.parent.name)
    ]
    for path in sorted(extraction_paths):
        for extraction in read_jsonl(path):
            parsed = as_mapping(extraction.get("parsed_response"))
            raw_candidates = parsed.get("candidates") if isinstance(parsed.get("candidates"), list) else []
            for raw in raw_candidates:
                if not isinstance(raw, dict) or as_text(raw.get("library")) != "Worldview":
                    continue
                candidate = dict(raw)
                candidate["book_id"] = as_text(extraction.get("book_id"))
                key = f"{candidate['book_id']}:{as_text(candidate.get('candidate_id'))}"
                if key in seen:
                    continue
                seen.add(key)
                result.append(candidate)
    return result


def write_json_report(path: str | Path, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(target)
