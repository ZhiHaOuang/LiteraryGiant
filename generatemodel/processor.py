from __future__ import annotations

from pathlib import Path
from typing import Any

from shared import (
    PROJECTS_ROOT,
    canonical_book_slug,
    load_chapters_from_manifest,
    load_json,
    serialize_payload,
    validate_plot_payload,
)

from .pipeline import GenerateModelPipeline
from .schemas import SeedPlot


def _looks_like_cluster_book_dir(path: Path) -> bool:
    return path.is_dir() and (path / "index.json").exists() and any(path.glob("plot*.json"))


def discover_cluster_books(input_path: str | Path) -> list[Path]:
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    if _looks_like_cluster_book_dir(path):
        return [path]
    if not path.is_dir():
        raise ValueError(f"Input path must be a plot_segments facts root or one cluster book directory: {path}")
    books = sorted(item for item in path.iterdir() if _looks_like_cluster_book_dir(item))
    if not books:
        raise FileNotFoundError(f"No cluster book directories found under {path}")
    return books


def _resolve_feature_dir(cluster_dir: Path, cluster_index: dict[str, Any], feature_root: str | Path | None) -> Path | None:
    source_feature_dir = cluster_index.get("source_feature_dir")
    if source_feature_dir and Path(source_feature_dir).exists():
        return Path(source_feature_dir)
    if feature_root is not None:
        feature_root_path = Path(feature_root)
        book_id = str((cluster_index.get("book_metadata") or {}).get("book_id") or cluster_dir.name)
        candidate = feature_root_path / canonical_book_slug(book_id)
        if candidate.exists():
            return candidate
    return None


def _synthetic_feature_chapters_from_plot(plot_payload: dict[str, Any]) -> list[dict[str, Any]]:
    chapter_payloads: list[dict[str, Any]] = []
    chapter_summaries = plot_payload.get("chapter_summaries") or []
    for index, chapter_summary in enumerate(chapter_summaries, start=1):
        if not isinstance(chapter_summary, dict):
            continue
        chapter_id = str(chapter_summary.get("chapter_id") or f"SYNTHC{index:04d}")
        title = str(chapter_summary.get("title") or f"第{index}章 合成样本")
        summary = str(chapter_summary.get("summary") or "")
        chapter_payloads.append(
            {
                "chapter_context": {
                    "chapter_id": chapter_id,
                    "order": index,
                    "clean_title": title,
                    "raw_title": title,
                },
                "source_ref": {
                    "chapter_file": f"synthetic://{plot_payload.get('plot_id')}/{index:04d}.json",
                },
                "semantic_features": {
                    "summary": summary,
                    "detailed_summary": [summary] if summary else [],
                    "protagonist": [],
                    "current_scene": [],
                    "current_goal_or_task": [],
                    "supporting_characters": [],
                    "items_and_props": [],
                    "protagonist_current_state": [],
                    "chapter_function": [],
                    "key_scenes": [summary] if summary else [],
                    "important_dialogue_topics": [],
                    "conflicts": [],
                    "foreshadowing": [],
                    "clues": [],
                    "ending_hook": "",
                    "state_changes": [],
                    "relationship_changes": [],
                    "world_rules_or_system_changes": [],
                    "tone": "",
                    "open_questions": [],
                },
            }
        )
    return chapter_payloads


def load_library_bundle(cluster_book_dir: str | Path, *, feature_root: str | Path | None = None, target_book_id: str | None = None) -> dict[str, Any]:
    cluster_dir = Path(cluster_book_dir)
    cluster_index = load_json(cluster_dir / "index.json")
    feature_dir = _resolve_feature_dir(cluster_dir, cluster_index, feature_root)
    feature_index = load_json(feature_dir / "index.json") if feature_dir is not None else {}

    feature_chapters = {}
    if feature_dir is not None:
        feature_chapters = {
            str((payload.get("chapter_context") or {}).get("chapter_id")): payload
            for _chapter_file, payload in load_chapters_from_manifest(
                feature_dir,
                feature_index,
                stage_name="features",
            )
        }

    plots: list[SeedPlot] = []
    book_id = str((cluster_index.get("book_metadata") or {}).get("book_id") or cluster_dir.name)
    valid_chapter_ids = set(feature_chapters)
    for plot_file in sorted(cluster_dir.glob("plot*.json")):
        plot_payload = load_json(plot_file)
        if valid_chapter_ids:
            validate_plot_payload(
                plot_payload,
                book_id=book_id,
                valid_chapter_ids=valid_chapter_ids,
                file_name=plot_file.name,
            )
        chapter_payloads = [
            feature_chapters[chapter_id]
            for chapter_id in plot_payload.get("chapter_ids", [])
            if chapter_id in feature_chapters
        ]
        if not chapter_payloads:
            chapter_payloads = _synthetic_feature_chapters_from_plot(plot_payload)
        plots.append(SeedPlot.from_bundle(plot_payload, chapter_payloads))

    return {
        "source_cluster_dir": str(cluster_dir),
        "source_feature_dir": str(feature_dir) if feature_dir is not None else "",
        "book_metadata": cluster_index.get("book_metadata") or feature_index.get("book_metadata") or {},
        "chapter_manifest": feature_index.get("chapter_manifest", []),
        "plots": plots,
        "target_book_id": target_book_id,
    }


def resolve_generation_output_dir(processed_book: dict[str, Any], *, output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else PROJECTS_ROOT / "_generated"
    book_id = str((processed_book.get("book_metadata") or {}).get("book_id") or "generated_book")
    return root / canonical_book_slug(book_id)


def process_cluster_book_dir(
    cluster_book_dir: str | Path,
    *,
    pipeline: GenerateModelPipeline,
    feature_root: str | Path | None = None,
    target_book_id: str | None = None,
) -> dict[str, Any]:
    bundle = load_library_bundle(cluster_book_dir, feature_root=feature_root, target_book_id=target_book_id)
    return pipeline.process_library(bundle)


def process_cluster_book_dir_multiple(
    cluster_book_dir: str | Path,
    *,
    pipeline: GenerateModelPipeline,
    generation_count: int,
    feature_root: str | Path | None = None,
    target_book_id: str | None = None,
) -> list[dict[str, Any]]:
    bundle = load_library_bundle(cluster_book_dir, feature_root=feature_root, target_book_id=target_book_id)
    outputs: list[dict[str, Any]] = []
    total = max(1, int(generation_count))
    source_book_id = str((bundle.get("book_metadata") or {}).get("book_id") or "generated_book")
    base_book_id = str(bundle.get("target_book_id") or f"{source_book_id}_generated")
    for generation_index in range(1, total + 1):
        generation_bundle = dict(bundle)
        generation_bundle["runtime_seed"] = (
            pipeline.random_seed + generation_index - 1
            if pipeline.random_seed is not None
            else None
        )
        generation_bundle["generation_index"] = generation_index
        generation_bundle["generation_count"] = total
        generation_bundle["target_book_id"] = (
            base_book_id
            if total == 1
            else f"{base_book_id}_gen{generation_index:03d}"
        )
        outputs.append(pipeline.process_library(generation_bundle))
    return outputs


def write_generated_book(output_dir: str | Path, processed_book: dict[str, Any], *, pretty: bool = True) -> Path:
    book_dir = Path(output_dir)
    book_dir.mkdir(parents=True, exist_ok=True)

    index_payload = {
        "book_metadata": processed_book["book_metadata"],
        "source_feature_dir": processed_book["source_feature_dir"],
        "source_cluster_dir": processed_book["source_cluster_dir"],
        "generation_config": processed_book["generation_config"],
        "chapter_manifest": processed_book["chapter_manifest"],
        "plot_manifest": processed_book["plot_manifest"],
    }
    (book_dir / "index.json").write_text(serialize_payload(index_payload, pretty=pretty), encoding="utf-8")

    for plot in processed_book["plots"]:
        (book_dir / f"{plot['plot_id']}.json").write_text(serialize_payload(plot, pretty=pretty), encoding="utf-8")

    for chapter in processed_book["chapters"]:
        order = int(chapter["chapter_context"]["order"])
        (book_dir / f"{order:04d}.json").write_text(serialize_payload(chapter, pretty=pretty), encoding="utf-8")

    return book_dir


def process_and_write_cluster_book_dir(
    cluster_book_dir: str | Path,
    *,
    pipeline: GenerateModelPipeline,
    feature_root: str | Path | None = None,
    output_root: str | Path | None = None,
    target_book_id: str | None = None,
    pretty: bool = True,
) -> Path:
    processed = process_cluster_book_dir(
        cluster_book_dir,
        pipeline=pipeline,
        feature_root=feature_root,
        target_book_id=target_book_id,
    )
    output_dir = resolve_generation_output_dir(processed, output_root=output_root)
    return write_generated_book(output_dir, processed, pretty=pretty)


def process_and_write_cluster_book_dir_multiple(
    cluster_book_dir: str | Path,
    *,
    pipeline: GenerateModelPipeline,
    generation_count: int,
    feature_root: str | Path | None = None,
    output_root: str | Path | None = None,
    target_book_id: str | None = None,
    pretty: bool = True,
) -> list[Path]:
    processed_books = process_cluster_book_dir_multiple(
        cluster_book_dir,
        pipeline=pipeline,
        generation_count=generation_count,
        feature_root=feature_root,
        target_book_id=target_book_id,
    )
    written_dirs: list[Path] = []
    for processed_book in processed_books:
        output_dir = resolve_generation_output_dir(processed_book, output_root=output_root)
        written_dirs.append(write_generated_book(output_dir, processed_book, pretty=pretty))
    return written_dirs
