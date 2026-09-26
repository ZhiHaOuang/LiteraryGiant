from __future__ import annotations

from pathlib import Path
from typing import Any

from shared import as_int, as_list, as_mapping, as_text, canonical_book_slug, load_json

from .loader import load_plot_book_bundle


BRIDGE_INDEX_SCHEMA_VERSION = "bridge_index.v1"


def build_book_bridge_index(book_dir: str | Path) -> dict[str, Any]:
    """Build a compact, source-traceable LLM evidence index for one Bridges book."""
    bundle = load_plot_book_bundle(book_dir)
    metadata = as_mapping(bundle.get("book_metadata"))
    book_slug = canonical_book_slug(as_text(metadata.get("book_id")) or Path(book_dir).name)
    book_id = book_slug
    chunks = [
        compact_plot(item.get("payload") or {}, source_file=as_text(item.get("source_file")), book_id=book_id)
        for item in bundle.get("plots") or []
    ]
    quality_counts: dict[str, int] = {}
    for chunk in chunks:
        tier = as_text(chunk.get("quality_tier")) or "partial"
        quality_counts[tier] = quality_counts.get(tier, 0) + 1
    return {
        "schema_version": BRIDGE_INDEX_SCHEMA_VERSION,
        "book_id": book_id,
        "book_slug": book_slug,
        "source_book_dir": str(Path(book_dir)),
        "book_metadata": {
            "title": as_text(metadata.get("title"))
            or as_text(as_mapping(metadata.get("source_lineage")).get("title")),
            "chapter_count": as_int(metadata.get("chapter_count")),
            "content_type": as_text(metadata.get("content_type")),
        },
        "plot_count": len(chunks),
        "quality_counts": quality_counts,
        "chunks": chunks,
    }


def compact_plot(plot: dict[str, Any], *, source_file: str, book_id: str) -> dict[str, Any]:
    key_events = [_pick(item, "event_order", "event", "chapter_order", "event_function") for item in _dicts(plot.get("key_events"))[:10]]
    characters = [_pick(item, "name", "role_in_plot", "state_change") for item in _dicts(plot.get("characters_involved"))[:10]]
    relationships = [
        _pick(item, "characters", "before", "after", "change_type", "cause")
        for item in _dicts(plot.get("relationship_changes"))[:10]
    ]
    conflict = _pick(as_mapping(plot.get("conflict_model")), "surface_conflict", "deep_conflict", "conflict_type", "stakes")
    payoff = _pick(as_mapping(plot.get("payoff_and_hook")), "reader_payoffs", "angst_points", "suspense_hooks", "ending_hook")
    setup = _pick(
        as_mapping(plot.get("setup_and_resolution")),
        "initial_question",
        "resolved_questions",
        "unresolved_questions",
        "new_questions_created",
    )
    hint = _pick(
        as_mapping(plot.get("abstraction_hint")),
        "possible_tropes",
        "possible_emotional_core",
        "possible_transferable_pattern",
    )
    score_parts = {
        "summary": bool(as_text(plot.get("summary"))),
        "detailed_summary": bool(as_text(plot.get("detailed_summary"))),
        "key_events": bool(key_events),
        "characters": bool(characters),
        "relationships": bool(relationships),
        "conflict": bool(conflict),
        "payoff": bool(payoff),
        "setup_resolution": bool(setup),
    }
    quality_score = round(sum(score_parts.values()) / len(score_parts), 4)
    quality_tier = "rich" if quality_score >= 0.75 else "usable" if quality_score >= 0.5 else "partial"
    plot_id = as_text(plot.get("plot_id")) or f"plot{as_int(plot.get('plot_index'))}"
    return {
        "schema_version": "bridge_plot_chunk.v1",
        "chunk_id": f"{canonical_book_slug(book_id)}:{plot_id}",
        "book_id": book_id,
        "book_slug": canonical_book_slug(book_id),
        "plot_id": plot_id,
        "plot_index": as_int(plot.get("plot_index")),
        "chapter_range": [as_int(plot.get("start_order")), as_int(plot.get("end_order"))],
        "chapter_orders": [as_int(value) for value in as_list(plot.get("chapter_orders")) if as_int(value)],
        "chapter_titles": as_list(plot.get("chapter_titles"))[:20],
        "plot_functions": as_list(plot.get("plot_function")),
        "driving_forces": as_list(plot.get("driving_force")),
        "summary": _limit_text(as_text(plot.get("summary")), 1200),
        "detailed_summary": _limit_text(as_text(plot.get("detailed_summary")), 2200),
        "key_events": key_events,
        "characters": characters,
        "relationship_changes": relationships,
        "conflict": conflict,
        "payoff_and_hook": payoff,
        "setup_and_resolution": setup,
        "abstraction_hint": hint,
        "quality_score": quality_score,
        "quality_tier": quality_tier,
        "quality_signals": score_parts,
        "source_ref": {
            "bridge_plot_file": source_file,
            "book_id": book_id,
            "plot_id": plot_id,
            "plot_index": as_int(plot.get("plot_index")),
            "chapter_orders": [as_int(value) for value in as_list(plot.get("chapter_orders")) if as_int(value)],
        },
    }


def build_evidence_windows(
    chunks: list[dict[str, Any]],
    *,
    plots_per_window: int = 4,
    overlap: int = 1,
    max_windows: int = 0,
) -> list[dict[str, Any]]:
    if plots_per_window < 1:
        raise ValueError("plots_per_window must be at least 1")
    if overlap < 0 or overlap >= plots_per_window:
        raise ValueError("overlap must be >= 0 and smaller than plots_per_window")
    step = plots_per_window - overlap
    windows: list[dict[str, Any]] = []
    for start in range(0, len(chunks), step):
        selected = chunks[start:start + plots_per_window]
        if not selected:
            continue
        windows.append(
            {
                "schema_version": "bridge_evidence_window.v1",
                "window_id": f"{selected[0]['book_slug']}:w{len(windows) + 1:04d}",
                "book_id": selected[0]["book_id"],
                "book_slug": selected[0]["book_slug"],
                "plot_range": [selected[0]["plot_index"], selected[-1]["plot_index"]],
                "chunk_ids": [item["chunk_id"] for item in selected],
                "quality_tiers": [item["quality_tier"] for item in selected],
                "evidence": selected,
            }
        )
        if max_windows and len(windows) >= max_windows:
            break
    return windows


def _dicts(value: object) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _pick(source: dict[str, Any], *keys: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in keys:
        value = source.get(key)
        if isinstance(value, str):
            value = _limit_text(value.strip(), 900)
        if value not in (None, "", [], {}):
            result[key] = value
    return result


def _limit_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[:limit].rstrip() + "..."
