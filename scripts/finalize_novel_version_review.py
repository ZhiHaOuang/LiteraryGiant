"""Finalize guarded version-review decisions without deleting corpus files."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
from typing import Any

from scripts.review_novel_versions_vllm import guard_result


def _rows(path: Path, key: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            value = str(row.get(key) or "")
            if not value or value in result:
                raise ValueError(f"Missing/duplicate {key} at {path}:{line_no}")
            result[value] = row
    return result


def finalize(queue_path: Path, results_path: Path, output_dir: Path) -> dict[str, Any]:
    queue = _rows(queue_path, "review_id")
    results = _rows(results_path, "review_id")
    if set(queue) != set(results):
        raise ValueError(
            f"Queue/results mismatch: queue={len(queue)} results={len(results)} "
            f"missing={len(set(queue) - set(results))} extra={len(set(results) - set(queue))}"
        )
    decisions: list[dict[str, Any]] = []
    actions: Counter[str] = Counter()
    contradictions: Counter[str] = Counter()
    for review_id, queue_row in queue.items():
        result = results[review_id]
        if result.get("status") != "complete" or not isinstance(result.get("model_result"), dict):
            guarded = {
                "guarded_action": "retain_pending_review",
                "guard_reason": "model_result_unavailable",
                "automatic_delete": False,
            }
            model_result = result.get("model_result")
        else:
            model_result = dict(result["model_result"])
            guarded = guard_result(queue_row, model_result)
            if (
                model_result.get("decision") == "candidate_incomplete"
                and model_result.get("preferred_has_additional_chapters") is not True
            ):
                contradictions["incomplete_without_confirmed_additional_chapters"] += 1
            if (
                model_result.get("decision") == "candidate_incomplete"
                and model_result.get("candidate_has_ending") is True
            ):
                contradictions["incomplete_while_candidate_has_ending"] += 1
        action = str(guarded["guarded_action"])
        actions[action] += 1
        decisions.append(
            {
                "review_id": review_id,
                "work_id": queue_row["work_id"],
                "candidate_id": queue_row["candidate"]["canonical_id"],
                "preferred_id": queue_row["preferred"]["canonical_id"],
                "candidate_source": queue_row["candidate"]["source_file"],
                "preferred_source": queue_row["preferred"]["source_file"],
                "deterministic_disposition": queue_row["disposition"],
                "model_result": model_result,
                **guarded,
                "publication_action": (
                    "exclude_incomplete_candidate_from_final_raw"
                    if action == "recommend_remove_after_audit"
                    else "retain_in_final_raw"
                ),
            }
        )
    summary = {
        "queue": len(queue),
        "results": len(results),
        "guarded_actions": dict(sorted(actions.items())),
        "publication_exclusions": sum(
            row["publication_action"] == "exclude_incomplete_candidate_from_final_raw"
            for row in decisions
        ),
        "automatic_deletions": 0,
        "contradictions": dict(sorted(contradictions.items())),
        "status": "prepared_not_applied",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = output_dir / "decision_manifest.jsonl"
    temp_manifest = output_dir / f".{manifest.name}.{os.getpid()}.tmp"
    with temp_manifest.open("x", encoding="utf-8") as handle:
        for row in decisions:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_manifest, manifest)
    temp_summary = output_dir / f".summary.{os.getpid()}.tmp"
    temp_summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp_summary, output_dir / "summary.json")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    summary = finalize(
        Path(args.queue).resolve(),
        Path(args.results).resolve(),
        Path(args.output_dir).resolve(),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
