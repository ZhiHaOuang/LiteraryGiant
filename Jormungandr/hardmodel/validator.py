"""Validation helpers for cleaned hardmodel artifacts."""

from __future__ import annotations

from pathlib import Path
from typing import Any


class HardmodelValidationError(ValueError):
    """Raised when a cleaned hardmodel artifact is not internally consistent."""


def _require_mapping(value: Any, *, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HardmodelValidationError(f"{name} must be a JSON object")
    return value


def validate_processed_book_result(result: dict[str, Any]) -> None:
    """Validate a cleaned book payload before it is written to ``derived``."""
    payload = _require_mapping(result, name="result")
    metadata = _require_mapping(payload.get("book_metadata"), name="book_metadata")
    chapters = payload.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise HardmodelValidationError("chapters must be a non-empty list")

    book_id = str(metadata.get("book_id") or "").strip()
    if not book_id:
        raise HardmodelValidationError("book_metadata.book_id is required")

    seen_orders: set[int] = set()
    seen_chapter_ids: set[str] = set()
    for index, raw_chapter in enumerate(chapters, start=1):
        chapter = _require_mapping(raw_chapter, name=f"chapter[{index}]")
        try:
            order = int(chapter.get("order"))
        except (TypeError, ValueError) as exc:
            raise HardmodelValidationError(f"chapter[{index}].order must be an integer") from exc
        if order <= 0:
            raise HardmodelValidationError(f"chapter[{index}].order must be positive")
        if order in seen_orders:
            raise HardmodelValidationError(f"duplicate chapter order: {order}")
        seen_orders.add(order)

        chapter_id = str(chapter.get("chapter_id") or "").strip()
        if not chapter_id:
            raise HardmodelValidationError(f"chapter[{index}].chapter_id is required")
        if chapter_id in seen_chapter_ids:
            raise HardmodelValidationError(f"duplicate chapter_id: {chapter_id}")
        seen_chapter_ids.add(chapter_id)

        if not str(chapter.get("clean_title") or chapter.get("raw_title") or "").strip():
            raise HardmodelValidationError(f"chapter[{index}] must have a title")
        if not isinstance(chapter.get("content", ""), str):
            raise HardmodelValidationError(f"chapter[{index}].content must be a string")

    expected_count = int(metadata.get("chapter_count") or len(chapters))
    if expected_count != len(chapters):
        raise HardmodelValidationError(
            f"chapter_count mismatch: metadata={expected_count}, actual={len(chapters)}"
        )


def validate_written_book_dir(book_dir: str | Path) -> None:
    """Validate that a derived chapter directory has an index and listed files."""
    target = Path(book_dir)
    index_path = target / "index.json"
    if not index_path.exists():
        raise HardmodelValidationError(f"missing index.json in {target}")
    for chapter_path in target.glob("chapter_*.json"):
        if not chapter_path.is_file():
            raise HardmodelValidationError(f"invalid chapter path: {chapter_path}")
