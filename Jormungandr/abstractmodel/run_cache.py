from __future__ import annotations

from pathlib import Path
from typing import Any

from .pattern_store import read_jsonl, write_jsonl_atomic


def compact_completed_book_cache(book_root: str | Path) -> dict[str, Any]:
    """Drop replay-only payloads after a complete book has been committed.

    Parsed extraction candidates and validated reconciliation decisions remain
    available for evidence review. Raw provider text and derivable task files
    are cold data and can be regenerated from Bridges when needed.
    """
    root = Path(book_root)
    extraction_path = root / "extractions.jsonl"
    reconciliation_path = root / "reconciliations.jsonl"
    task_path = root / "tasks.jsonl"

    extractions = read_jsonl(extraction_path)
    stripped_extraction_raw = 0
    compact_extractions: list[dict[str, Any]] = []
    for row in extractions:
        compact = dict(row)
        if compact.get("status") == "ok" and "raw_response" in compact:
            compact.pop("raw_response", None)
            stripped_extraction_raw += 1
        compact_extractions.append(compact)
    if extractions:
        write_jsonl_atomic(extraction_path, compact_extractions)

    reconciliations = read_jsonl(reconciliation_path)
    stripped_reconciliation_raw = 0
    stripped_reconciliation_parsed = 0
    compact_reconciliations: list[dict[str, Any]] = []
    for row in reconciliations:
        compact = dict(row)
        if compact.get("status") == "ok" and "raw_response" in compact:
            compact.pop("raw_response", None)
            stripped_reconciliation_raw += 1
        if compact.get("status") == "ok" and "parsed_response" in compact:
            compact.pop("parsed_response", None)
            stripped_reconciliation_parsed += 1
        compact.pop("existing_pattern_shortlist", None)
        compact_reconciliations.append(compact)
    if reconciliations:
        write_jsonl_atomic(reconciliation_path, compact_reconciliations)

    removed_task_file = False
    if task_path.exists():
        task_path.unlink()
        removed_task_file = True
    return {
        "policy": "retain_parsed_extractions_and_validated_decisions",
        "extraction_rows": len(compact_extractions),
        "reconciliation_rows": len(compact_reconciliations),
        "stripped_extraction_raw_responses": stripped_extraction_raw,
        "stripped_reconciliation_raw_responses": stripped_reconciliation_raw,
        "stripped_reconciliation_parsed_responses": stripped_reconciliation_parsed,
        "removed_task_file": removed_task_file,
    }
