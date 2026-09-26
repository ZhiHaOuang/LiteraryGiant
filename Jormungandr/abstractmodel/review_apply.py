from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import as_list, as_text

from .pattern_store import read_jsonl, write_jsonl_atomic


ALLOWED_REVIEW_ACTIONS = {
    "merge",
    "split",
    "merge_now",
    "keep_separate",
    "sibling_relation",
    "approve_relation",
    "reject_relation",
    "needs_review",
}
PLANNED_ACTIONS = {"merge", "split", "merge_now"}


def apply_review_results(
    *,
    review_results: str | Path,
    abstract_library_root: str | Path,
) -> dict[str, Any]:
    source_path = Path(review_results)
    root = Path(abstract_library_root)
    routing = root / "_routing"
    incoming = read_jsonl(source_path)
    known_patterns = {
        as_text(row.get("pattern_id"))
        for row in read_jsonl(root / "pattern_index.jsonl")
        if as_text(row.get("pattern_id"))
    }
    known_relations = {
        as_text(row.get("relation_id"))
        for row in read_jsonl(root / "cross_library_relations.jsonl")
        if as_text(row.get("relation_id"))
    }
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for position, raw in enumerate(incoming, start=1):
        row = dict(raw)
        action = as_text(row.get("action") or row.get("recommendation"))
        pattern_id = as_text(row.get("pattern_id") or row.get("left_pattern_id"))
        relation_id = as_text(row.get("relation_id"))
        target_ids = [
            as_text(value)
            for value in as_list(row.get("target_pattern_ids"))
            if as_text(value)
        ]
        right_id = as_text(row.get("right_pattern_id") or row.get("target_pattern_id"))
        if right_id and right_id not in target_ids:
            target_ids.append(right_id)
        errors: list[str] = []
        if action not in ALLOWED_REVIEW_ACTIONS:
            errors.append("unsupported_action")
        if relation_id:
            if relation_id not in known_relations:
                errors.append("relation_not_found")
        elif not pattern_id or pattern_id not in known_patterns:
            errors.append("pattern_not_found")
        if action in PLANNED_ACTIONS and not target_ids and action != "split":
            errors.append("merge_target_missing")
        unknown_targets = [value for value in target_ids if value not in known_patterns]
        if unknown_targets:
            errors.append(f"target_pattern_not_found:{','.join(unknown_targets)}")
        review_id = as_text(row.get("review_id")) or _review_id(row)
        normalized = {
            "schema_version": "abstractmodel_llm_review_result.v1",
            "review_id": review_id,
            "source_line": position,
            "action": action,
            "pattern_id": pattern_id,
            "target_pattern_ids": target_ids,
            "relation_id": relation_id,
            "reason": as_text(row.get("reason")),
            "confidence": row.get("confidence", 0.0),
            "reviewer": as_text(row.get("reviewer")) or "llm",
            "raw_result": row,
        }
        if errors:
            normalized["errors"] = errors
            rejected.append(normalized)
        else:
            accepted.append(normalized)

    results_path = routing / "llm_review_results.jsonl"
    log_path = routing / "applied_review_log.jsonl"
    pending_path = routing / "pending_split_merge_actions.jsonl"
    existing_results = read_jsonl(results_path)
    known_review_ids = {as_text(row.get("review_id")) for row in existing_results}
    new_results = [row for row in accepted if as_text(row.get("review_id")) not in known_review_ids]
    write_jsonl_atomic(results_path, [*existing_results, *new_results])

    applied_at = datetime.now(timezone.utc).isoformat()
    existing_log = read_jsonl(log_path)
    existing_logged = {as_text(row.get("review_id")) for row in existing_log}
    log_rows = [
        {
            "schema_version": "abstractmodel_applied_review_log.v1",
            "review_id": row["review_id"],
            "action": row["action"],
            "pattern_id": row["pattern_id"],
            "relation_id": row["relation_id"],
            "status": "planned" if row["action"] in PLANNED_ACTIONS else "recorded",
            "applied_at": applied_at,
            "note": "Split and merge actions are plans only; no pattern content was changed.",
        }
        for row in new_results
        if row["review_id"] not in existing_logged
    ]
    write_jsonl_atomic(log_path, [*existing_log, *log_rows])

    existing_pending = read_jsonl(pending_path)
    existing_pending_ids = {as_text(row.get("review_id")) for row in existing_pending}
    pending_rows = [
        {
            "schema_version": "abstractmodel_pending_split_merge.v1",
            "review_id": row["review_id"],
            "action": row["action"],
            "pattern_id": row["pattern_id"],
            "target_pattern_ids": row["target_pattern_ids"],
            "reason": row["reason"],
            "execution_status": "pending_manual_orchestrated_apply",
        }
        for row in new_results
        if row["action"] in PLANNED_ACTIONS and row["review_id"] not in existing_pending_ids
    ]
    write_jsonl_atomic(pending_path, [*existing_pending, *pending_rows])
    return {
        "input_count": len(incoming),
        "accepted_count": len(accepted),
        "newly_recorded_count": len(new_results),
        "rejected_count": len(rejected),
        "pending_action_count": len(pending_rows),
        "rejected_results": rejected,
        "paths": {
            "llm_review_results": str(results_path),
            "applied_review_log": str(log_path),
            "pending_split_merge_actions": str(pending_path),
        },
    }


def _review_id(row: dict[str, Any]) -> str:
    payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"review_{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:16]}"
