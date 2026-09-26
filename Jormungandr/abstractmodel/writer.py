from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared import (
    ABSTRACT_CHARACTER_ARC_ROOT,
    ABSTRACT_EMOTION_RHYTHM_ROOT,
    ABSTRACT_EVENTS_LIBRARY_ROOT,
    ABSTRACT_LIBRARY_ROOT,
    ABSTRACT_MEMES_ROOT,
    ABSTRACT_PAYOFFANGST_ROOT,
    ABSTRACT_WORLDVIEW_ROOT,
    INDEXES_ROOT,
    LIBRARY_ROOT,
    canonical_book_slug,
    serialize_payload,
)

from .schemas import (
    AUTOMATED_PATTERN_LIBRARIES,
    BOOK_LOGIC_GRAPH,
    CHARACTER_ARC,
    EMOTION_RHYTHM,
    EVENTS_LIBRARY,
    FINAL_ABSTRACT_LIBRARIES,
    MANUAL_ABSTRACT_LIBRARIES,
    MEMES,
    PAYOFF_ANGST,
    PLOT_LEVEL_LIBRARIES,
    WORLDVIEW,
    canonical_library_name,
)


PATTERN_LIBRARIES = AUTOMATED_PATTERN_LIBRARIES

DEFAULT_LIBRARY_ROOTS = {
    CHARACTER_ARC: ABSTRACT_CHARACTER_ARC_ROOT,
    EMOTION_RHYTHM: ABSTRACT_EMOTION_RHYTHM_ROOT,
    EVENTS_LIBRARY: ABSTRACT_EVENTS_LIBRARY_ROOT,
    PAYOFF_ANGST: ABSTRACT_PAYOFFANGST_ROOT,
    WORLDVIEW: ABSTRACT_WORLDVIEW_ROOT,
    MEMES: ABSTRACT_MEMES_ROOT,
}


def library_roots(output_root: str | Path | None = None) -> dict[str, Path]:
    if output_root is None:
        return dict(DEFAULT_LIBRARY_ROOTS)
    root = Path(output_root)
    return {
        CHARACTER_ARC: root / CHARACTER_ARC,
        EMOTION_RHYTHM: root / EMOTION_RHYTHM,
        EVENTS_LIBRARY: root / EVENTS_LIBRARY,
        PAYOFF_ANGST: root / PAYOFF_ANGST,
        WORLDVIEW: root / WORLDVIEW,
        MEMES: root / MEMES,
    }


def routing_root(output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    return root / "_routing"


def default_work_root(output_root: str | Path | None = None) -> Path:
    if output_root is not None:
        return Path(output_root).parent / "BookSpecificAbstracts"
    return LIBRARY_ROOT / "BookSpecificAbstracts"


def work_root_path(work_root: str | Path | None = None, *, output_root: str | Path | None = None) -> Path:
    return Path(work_root) if work_root is not None else default_work_root(output_root)


def book_specific_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return work_root_path(work_root, output_root=output_root) / book_slug


def corpus_routing_root(work_root: str | Path | None = None, *, output_root: str | Path | None = None) -> Path:
    return work_root_path(work_root, output_root=output_root) / "_routing"


def book_routing_dir(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "_routing"


def candidates_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "candidates"


def candidates_raw_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "candidates_raw"


def candidates_rejected_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "candidates_rejected"


def local_pattern_seeds_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "local_pattern_seeds"


def candidates_path(work_root: str | Path | None, library: str, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return candidates_root(work_root, book_slug, output_root=output_root) / f"{library}.jsonl"


def candidates_raw_path(work_root: str | Path | None, library: str, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return candidates_raw_root(work_root, book_slug, output_root=output_root) / f"{library}.jsonl"


def candidates_rejected_path(work_root: str | Path | None, library: str, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return candidates_rejected_root(work_root, book_slug, output_root=output_root) / f"{library}.jsonl"


def local_pattern_seeds_path(work_root: str | Path | None, library: str, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return local_pattern_seeds_root(work_root, book_slug, output_root=output_root) / f"{library}.jsonl"


def book_profiles_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "book_profile"


def book_graph_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / BOOK_LOGIC_GRAPH


def local_patterns_root(work_root: str | Path | None, book_slug: str, *, output_root: str | Path | None = None) -> Path:
    return book_specific_root(work_root, book_slug, output_root=output_root) / "local_patterns"


def emerging_patterns_root(output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    return root


def universal_patterns_root(output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    return root


def pattern_filename(library: str) -> str:
    filenames = {
        EVENTS_LIBRARY: "event_patterns.jsonl",
        PAYOFF_ANGST: "payoff_patterns.jsonl",
        CHARACTER_ARC: "character_arc_patterns.jsonl",
        EMOTION_RHYTHM: "emotion_patterns.jsonl",
        WORLDVIEW: "worldview_patterns.jsonl",
        MEMES: "meme_patterns.jsonl",
    }
    return filenames.get(library, "patterns.jsonl")


def manual_pattern_path(output_root: str | Path | None, library: str) -> Path:
    root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    return root / library / "manual_patterns.jsonl"


def local_pattern_path(output_root: str | Path | None, book_slug: str, library: str) -> Path:
    return local_patterns_root(None, book_slug, output_root=output_root) / pattern_filename(library)


def local_pattern_path_for_work(work_root: str | Path | None, book_slug: str, library: str, *, output_root: str | Path | None = None) -> Path:
    return local_patterns_root(work_root, book_slug, output_root=output_root) / pattern_filename(library)


def emerging_pattern_path(output_root: str | Path | None, library: str) -> Path:
    return emerging_patterns_root(output_root) / library / "emerging_patterns.jsonl"


def universal_pattern_path(output_root: str | Path | None, library: str) -> Path:
    return universal_patterns_root(output_root) / library / "universal_patterns.jsonl"


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(text, encoding="utf-8")
    tmp_path.replace(path)


def _write_json(path: Path, payload: dict[str, Any], *, pretty: bool = True) -> None:
    _write_text_atomic(path, serialize_payload(payload, pretty=pretty))


def _write_jsonl(path: Path, rows: list[dict[str, Any]], *, pretty: bool = False) -> None:
    if pretty:
        text = "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows)
    else:
        text = "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows)
    if text:
        text += "\n"
    _write_text_atomic(path, text)


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _read_jsonl_dicts(path: Path) -> list[dict[str, Any]]:
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


def _llm_candidate_review_rows(processed_book: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    layers = processed_book.get("quality_layers") if isinstance(processed_book.get("quality_layers"), dict) else {}
    accepted = layers.get("candidates") if isinstance(layers.get("candidates"), dict) else {}
    for library, items in accepted.items():
        for item in items or []:
            if not isinstance(item, dict) or item.get("llm_review_status") != "needs_review":
                continue
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            rows.append(
                {
                    "schema_version": "abstractmodel_llm_candidate_review.v1",
                    "book_id": processed_book.get("book_id", ""),
                    "book_slug": processed_book.get("book_slug", ""),
                    "library": item.get("library") or library,
                    "object_id": item.get("object_id", ""),
                    "object_type": item.get("object_type", ""),
                    "confidence": item.get("confidence"),
                    "quality_tier": item.get("quality_tier", ""),
                    "quality_reasons": item.get("quality_reasons", []),
                    "source_ref": item.get("source_ref", {}),
                    "source_payload": payload.get("source_payload", {}),
                    "generalized_payload": payload.get("generalized_payload", {}),
                    "expected_output_schema": {
                        "keep": True,
                        "correct_library": item.get("library") or library,
                        "revised_pattern_name": "",
                        "missing_fields": [],
                        "generalization_quality": "good/weak/over_specific",
                        "reason": "",
                        "quality_delta": 0.0,
                    },
                }
            )
    return rows


def write_processed_book(
    processed_book: dict[str, Any],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    pretty: bool = True,
) -> Path:
    book_slug = canonical_book_slug(processed_book["book_slug"])
    if processed_book.get("book_id") != book_slug:
        raise ValueError(
            "Abstract output requires identical canonical book_id/book_slug: "
            f"{processed_book.get('book_id')!r} / {book_slug!r}"
        )
    book_route_dir = book_routing_dir(work_root, book_slug, output_root=output_root)
    objects_by_library = processed_book.get("objects_by_library") or {}
    quality_layers = processed_book.get("quality_layers") if isinstance(processed_book.get("quality_layers"), dict) else {}
    raw_by_library = quality_layers.get("raw") if isinstance(quality_layers.get("raw"), dict) else processed_book.get("raw_objects_by_library") or {}
    seeds_by_library = quality_layers.get("local_pattern_seeds") if isinstance(quality_layers.get("local_pattern_seeds"), dict) else {}
    rejected_by_library = quality_layers.get("rejected") if isinstance(quality_layers.get("rejected"), dict) else {}

    for library in PLOT_LEVEL_LIBRARIES:
        accepted_rows = objects_by_library.get(library) or []
        _write_jsonl(candidates_raw_path(work_root, library, book_slug, output_root=output_root), raw_by_library.get(library) or [])
        _write_jsonl(candidates_path(work_root, library, book_slug, output_root=output_root), accepted_rows)
        _write_jsonl(local_pattern_seeds_path(work_root, library, book_slug, output_root=output_root), seeds_by_library.get(library) or [])
        _write_jsonl(candidates_rejected_path(work_root, library, book_slug, output_root=output_root), rejected_by_library.get(library) or [])

    _write_json(book_graph_root(work_root, book_slug, output_root=output_root) / f"{book_slug}.graph.json", processed_book["book_graph"], pretty=pretty)
    write_book_level_reference(processed_book, output_root=output_root, work_root=work_root, pretty=pretty)
    _write_json(book_route_dir / "quality_report.json", processed_book.get("quality_report") or {}, pretty=pretty)
    _write_jsonl(book_route_dir / "llm_candidate_review_queue.jsonl", _llm_candidate_review_rows(processed_book))

    _write_jsonl(book_route_dir / "signatures.jsonl", processed_book.get("signatures") or [])
    _write_jsonl(book_route_dir / "plot_results.jsonl", processed_book.get("plot_results") or [])
    _write_json(book_route_dir / "template_registry.json", processed_book.get("template_registry") or {}, pretty=pretty)
    _write_json(
        book_route_dir / "index.json",
        {
            "schema_version": processed_book["schema_version"],
            "book_id": processed_book["book_id"],
            "book_slug": book_slug,
            "source_plot_dir": processed_book.get("source_plot_dir", ""),
            "abstractmodel_config": processed_book.get("abstractmodel_config", {}),
            "validation": processed_book.get("validation", {}),
            "object_counts": {
                library: len(objects_by_library.get(library) or [])
                for library in [*PLOT_LEVEL_LIBRARIES, BOOK_LOGIC_GRAPH]
            },
            "quality_counts": {
                "raw": {
                    library: len((raw_by_library.get(library) or []))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "candidates": {
                    library: len((objects_by_library.get(library) or []))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "local_pattern_seeds": {
                    library: len((seeds_by_library.get(library) or []))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "rejected": {
                    library: len((rejected_by_library.get(library) or []))
                    for library in PLOT_LEVEL_LIBRARIES
                },
            },
            "outputs": {
                **{
                    library: str(candidates_path(work_root, library, book_slug, output_root=output_root))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "candidates_raw": {
                    library: str(candidates_raw_path(work_root, library, book_slug, output_root=output_root))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "local_pattern_seeds": {
                    library: str(local_pattern_seeds_path(work_root, library, book_slug, output_root=output_root))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                "candidates_rejected": {
                    library: str(candidates_rejected_path(work_root, library, book_slug, output_root=output_root))
                    for library in PLOT_LEVEL_LIBRARIES
                },
                BOOK_LOGIC_GRAPH: str(book_graph_root(work_root, book_slug, output_root=output_root) / f"{book_slug}.graph.json"),
                "book_profile": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "book_profile.json"),
                "character_arcs": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "character_arcs.jsonl"),
                "emotion_curve": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "emotion_curve.json"),
                "payoff_structure": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "payoff_structure.json"),
                "worldview_profile": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "worldview_profile.json"),
                "event_sequence": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "event_sequence.json"),
                "logic_graph_summary": str(book_profiles_root(work_root, book_slug, output_root=output_root) / "logic_graph_summary.json"),
                "signatures": str(book_route_dir / "signatures.jsonl"),
                "plot_results": str(book_route_dir / "plot_results.jsonl"),
                "quality_report": str(book_route_dir / "quality_report.json"),
                "llm_candidate_review_queue": str(book_route_dir / "llm_candidate_review_queue.jsonl"),
                "template_registry": str(book_route_dir / "template_registry.json"),
            },
        },
        pretty=pretty,
    )
    return book_route_dir


def write_book_level_reference(
    processed_book: dict[str, Any],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    pretty: bool = True,
) -> Path:
    book_slug = processed_book["book_slug"]
    root = book_profiles_root(work_root, book_slug, output_root=output_root)
    reference = processed_book.get("book_level_reference") or {}
    _write_json(root / "book_profile.json", reference.get("book_profile") or {}, pretty=pretty)
    _write_json(root / "event_sequence.json", reference.get("event_sequence") or {}, pretty=pretty)
    _write_jsonl(root / "character_arcs.jsonl", reference.get("character_arcs") or [])
    _write_json(root / "payoff_structure.json", reference.get("payoff_structure") or {}, pretty=pretty)
    _write_json(root / "emotion_curve.json", reference.get("emotion_curve") or {}, pretty=pretty)
    _write_json(root / "worldview_profile.json", reference.get("worldview_profile") or {}, pretty=pretty)
    _write_json(root / "logic_graph_summary.json", reference.get("logic_graph_summary") or {}, pretty=pretty)
    return root


def write_template_registry(
    template_registry: dict[str, list[dict[str, Any]]],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    pretty: bool = True,
) -> Path:
    path = corpus_routing_root(work_root, output_root=output_root) / "template_registry.json"
    _write_json(path, template_registry, pretty=pretty)
    return path


def write_corpus_manifest(
    manifest: dict[str, Any],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    pretty: bool = True,
) -> Path:
    path = corpus_routing_root(work_root, output_root=output_root) / "corpus_manifest.json"
    _write_json(path, manifest, pretty=pretty)
    return path


def write_abstract_manifest(
    manifest: dict[str, Any],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    pretty: bool = True,
) -> Path:
    path = corpus_routing_root(work_root, output_root=output_root) / "abstract_manifest.json"
    _write_json(path, manifest, pretty=pretty)
    return path


def rebuild_candidate_index(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> Path:
    working_root = work_root_path(work_root, output_root=output_root)
    target = corpus_routing_root(work_root, output_root=output_root) / "candidate_index.jsonl"
    rows: list[dict[str, Any]] = []
    layer_dirs = [
        ("raw", "candidates_raw"),
        ("candidate", "candidates"),
        ("local_pattern_seed", "local_pattern_seeds"),
        ("rejected", "candidates_rejected"),
    ]
    for book_dir in sorted(working_root.glob("id[0-9]*")):
        if not book_dir.is_dir():
            continue
        for layer_name, dir_name in layer_dirs:
            for path in sorted((book_dir / dir_name).glob("*.jsonl")):
                path_library = canonical_library_name(path.stem)
                if path_library not in PLOT_LEVEL_LIBRARIES:
                    continue
                for item in _read_jsonl_dicts(path):
                    item_library = canonical_library_name(str(item.get("library") or path_library))
                    if item_library not in PLOT_LEVEL_LIBRARIES:
                        continue
                    source_ref = item.get("source_ref") if isinstance(item.get("source_ref"), dict) else {}
                    rows.append(
                        {
                            "book_slug": book_dir.name,
                            "library": item_library,
                            "object_id": item.get("object_id", ""),
                            "object_type": item.get("object_type", ""),
                            "quality_layer": layer_name,
                            "quality_tier": item.get("quality_tier", ""),
                            "confidence": item.get("confidence"),
                            "abstraction_value_score": item.get("abstraction_value_score"),
                            "reuse_value_score": item.get("reuse_value_score"),
                            "source_dependency_score": item.get("source_dependency_score"),
                            "specificity_score": item.get("specificity_score"),
                            "llm_review_status": item.get("llm_review_status", ""),
                            "source_ref": source_ref,
                            "path": str(path),
                        }
                    )
    rows.sort(key=lambda row: (str(row.get("book_slug")), str(row.get("library")), str(row.get("object_id")), str(row.get("quality_layer"))))
    _write_jsonl(target, rows)
    return target


def rebuild_book_status(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> Path:
    working_root = work_root_path(work_root, output_root=output_root)
    target = corpus_routing_root(work_root, output_root=output_root) / "book_status.jsonl"
    rows: list[dict[str, Any]] = []
    for book_dir in sorted(working_root.glob("id[0-9]*")):
        if not book_dir.is_dir():
            continue
        routing = book_dir / "_routing"
        index = _read_json_dict(routing / "index.json")
        quality = _read_json_dict(routing / "quality_report.json")
        validation = index.get("validation") if isinstance(index.get("validation"), dict) else {}
        rows.append(
            {
                "book_slug": book_dir.name,
                "book_id": index.get("book_id", ""),
                "abstract_status": "done" if index else "missing",
                "pattern_status": "pending",
                "schema_version": index.get("schema_version", ""),
                "plot_count": validation.get("plot_count", 0),
                "candidate_count": quality.get("candidate_count", 0),
                "raw_candidate_count": quality.get("raw_candidate_count", 0),
                "local_pattern_seed_count": quality.get("local_pattern_seed_count", 0),
                "rejected_count": quality.get("rejected_count", 0),
                "candidate_pass_rate": quality.get("candidate_pass_rate", 0.0),
                "llm_review_counts": quality.get("llm_review_counts", {}),
            }
        )
    _write_jsonl(target, rows)
    return target


def rebuild_llm_candidate_review_queue(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> Path:
    working_root = work_root_path(work_root, output_root=output_root)
    target = corpus_routing_root(work_root, output_root=output_root) / "llm_candidate_review_queue.jsonl"
    rows: list[dict[str, Any]] = []
    for path in sorted(working_root.glob("id[0-9]*/_routing/llm_candidate_review_queue.jsonl")):
        rows.extend(_read_jsonl_dicts(path))
    _write_jsonl(target, rows)
    return target


def write_pattern_layers(
    pattern_layers: dict[str, Any],
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
) -> dict[str, Path]:
    paths: dict[str, Path] = {}
    public_root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    for library in FINAL_ABSTRACT_LIBRARIES:
        (public_root / library).mkdir(parents=True, exist_ok=True)

    local_patterns = pattern_layers.get("local_patterns") if isinstance(pattern_layers.get("local_patterns"), dict) else {}
    for book_slug, rows_by_library in local_patterns.items():
        if not isinstance(rows_by_library, dict):
            continue
        for library in PATTERN_LIBRARIES:
            path = local_pattern_path_for_work(work_root, str(book_slug), library, output_root=output_root)
            _write_jsonl(path, rows_by_library.get(library) or [])
            paths[f"local:{book_slug}:{library}"] = path

    emerging_patterns = pattern_layers.get("emerging_patterns") if isinstance(pattern_layers.get("emerging_patterns"), dict) else {}
    universal_patterns = pattern_layers.get("universal_patterns") if isinstance(pattern_layers.get("universal_patterns"), dict) else {}
    for library in PATTERN_LIBRARIES:
        emerging_path = emerging_pattern_path(output_root, library)
        _write_jsonl(emerging_path, emerging_patterns.get(library) or [])
        paths[f"emerging:{library}"] = emerging_path

        universal_path = universal_pattern_path(output_root, library)
        _write_jsonl(universal_path, universal_patterns.get(library) or [])
        paths[f"universal:{library}"] = universal_path
    return paths


def write_global_patterns(
    patterns_by_library: dict[str, list[dict[str, Any]]],
    *,
    output_root: str | Path | None = None,
) -> dict[str, Path]:
    return write_pattern_layers(
        {
            "local_patterns": {},
            "emerging_patterns": {},
            "universal_patterns": patterns_by_library,
        },
        output_root=output_root,
        work_root=None,
    )


def _index_row_from_object(path: Path, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "library": item.get("library", ""),
        "object_id": item.get("object_id", ""),
        "object_type": item.get("object_type", ""),
        "source_ref": item.get("source_ref", {}),
        "confidence": item.get("confidence"),
        "quality_tier": item.get("quality_tier", ""),
        "abstraction_value_score": item.get("abstraction_value_score"),
        "reuse_value_score": item.get("reuse_value_score"),
        "source_dependency_score": item.get("source_dependency_score"),
        "specificity_score": item.get("specificity_score"),
        "llm_review_status": item.get("llm_review_status", ""),
        "path": str(path),
    }


def _index_row_from_pattern(path: Path, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "library": item.get("library", ""),
        "object_id": item.get("pattern_id", ""),
        "object_type": item.get("pattern_scope", "reference_pattern"),
        "source_ref": {
            "book_slug": item.get("book_slug", ""),
            "supported_books": item.get("supported_books", []),
        },
        "confidence": None,
        "pattern_status": item.get("pattern_status", ""),
        "support_count": item.get("source_instance_count") or item.get("within_book_support_count") or item.get("support_count", 0),
        "path": str(path),
    }


def rebuild_abstract_index(
    *,
    output_root: str | Path | None = None,
    work_root: str | Path | None = None,
    index_path: str | Path | None = None,
) -> Path:
    public_root = Path(output_root) if output_root is not None else ABSTRACT_LIBRARY_ROOT
    working_root = work_root_path(work_root, output_root=output_root)
    target = Path(index_path) if index_path is not None else INDEXES_ROOT / "abstract_index.jsonl"
    rows: list[dict[str, Any]] = []
    for book_dir in sorted(working_root.glob("id[0-9]*")):
        if not book_dir.is_dir():
            continue
        for path in sorted((book_dir / "candidates").glob("*.jsonl")):
            path_library = canonical_library_name(path.stem)
            if path_library not in PLOT_LEVEL_LIBRARIES:
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    item_library = canonical_library_name(str(item.get("library") or path_library))
                    if item_library not in PLOT_LEVEL_LIBRARIES:
                        continue
                    item = dict(item)
                    item["library"] = item_library
                    rows.append(_index_row_from_object(path, item))
    for path in sorted(working_root.glob("id[0-9]*/BookLogicGraph/id[0-9]*.graph.json")):
        try:
            graph = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(graph, dict):
            continue
        rows.append(
            {
                "library": BOOK_LOGIC_GRAPH,
                "object_id": graph.get("graph_id", ""),
                "object_type": "book_narrative_graph",
                "source_ref": graph.get("source_ref", {}),
                "confidence": 1.0,
                "path": str(path),
            }
        )
    pattern_files: list[Path] = []
    allowed_local_pattern_names = {pattern_filename(library) for library in PATTERN_LIBRARIES}
    for book_dir in sorted(working_root.glob("id[0-9]*")):
        if book_dir.is_dir():
            pattern_files.extend(
                path
                for path in sorted((book_dir / "local_patterns").glob("*.jsonl"))
                if path.name in allowed_local_pattern_names
            )
    for library in PATTERN_LIBRARIES:
        pattern_files.extend(sorted((public_root / library).glob("emerging_patterns.jsonl")))
        pattern_files.extend(sorted((public_root / library).glob("universal_patterns.jsonl")))
    for library in MANUAL_ABSTRACT_LIBRARIES:
        manual_path = manual_pattern_path(output_root, library)
        if manual_path.exists():
            pattern_files.append(manual_path)
    for path in pattern_files:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                item_library = canonical_library_name(str(item.get("library") or ""))
                if item_library not in FINAL_ABSTRACT_LIBRARIES:
                    continue
                item = dict(item)
                item["library"] = item_library
                rows.append(_index_row_from_pattern(path, item))
    rows.sort(key=lambda row: (str(row.get("library")), str(row.get("object_id"))))
    _write_jsonl(target, rows)
    return target
