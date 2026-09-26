from __future__ import annotations

from collections import Counter
from typing import Any

from .schemas import ALL_LIBRARIES, BOOK_LOGIC_GRAPH


class AbstractModelValidationError(ValueError):
    """Raised when abstractmodel output cannot be safely indexed."""


def validate_processed_book(processed_book: dict[str, Any], *, strict: bool = True) -> dict[str, Any]:
    objects_by_library = processed_book.get("objects_by_library") or {}
    signatures = processed_book.get("signatures") or []
    object_ids: list[str] = []
    errors: list[str] = []
    counts: Counter[str] = Counter()

    for library, objects in objects_by_library.items():
        if library not in ALL_LIBRARIES:
            errors.append(f"unknown library: {library}")
            continue
        if not isinstance(objects, list):
            errors.append(f"{library}: objects must be a list")
            continue
        for item in objects:
            if not isinstance(item, dict):
                errors.append(f"{library}: object is not a dict")
                continue
            object_id = str(item.get("object_id") or "").strip()
            source_ref = item.get("source_ref") if isinstance(item.get("source_ref"), dict) else {}
            if not object_id:
                errors.append(f"{library}: object missing object_id")
            if not source_ref.get("book_id"):
                errors.append(f"{library}:{object_id}: object missing source_ref.book_id")
            if library != BOOK_LOGIC_GRAPH and not source_ref.get("plot_id"):
                errors.append(f"{library}:{object_id}: plot-level object missing source_ref.plot_id")
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            generalized_payload = payload.get("generalized_payload") if isinstance(payload.get("generalized_payload"), dict) else {}
            if library != BOOK_LOGIC_GRAPH and not generalized_payload:
                errors.append(f"{library}:{object_id}: plot-level object missing payload.generalized_payload")
            object_ids.append(object_id)
            counts[library] += 1

    duplicate_ids = [object_id for object_id, count in Counter(object_ids).items() if object_id and count > 1]
    if duplicate_ids:
        errors.append("duplicate object_id(s): " + ", ".join(duplicate_ids[:20]))

    graph = processed_book.get("book_graph") if isinstance(processed_book.get("book_graph"), dict) else {}
    if graph and not graph.get("graph_id"):
        errors.append("BookLogicGraph missing graph_id")

    routed_plot_count = sum(1 for signature in signatures if signature.get("routing_targets"))
    extracted_plot_ids = {
        str(item.get("source_ref", {}).get("plot_id"))
        for objects in objects_by_library.values()
        if isinstance(objects, list)
        for item in objects
        if isinstance(item, dict) and item.get("source_ref", {}).get("plot_id")
    }
    summary = {
        "valid": not errors,
        "errors": errors,
        "plot_count": len(signatures),
        "routed_plot_count": routed_plot_count,
        "plot_level_extracted_plot_count": len(extracted_plot_ids),
        "low_abstraction_plot_count": sum(
            1 for signature in signatures if not signature.get("routing_targets")
        ),
        "object_counts": dict(counts),
        "duplicate_object_count": len(duplicate_ids),
    }
    if errors and strict:
        raise AbstractModelValidationError("\n- ".join(errors))
    return summary
