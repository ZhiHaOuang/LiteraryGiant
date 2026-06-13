"""Write cleaned hardmodel artifacts into the canonical facts layout."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared import FACT_CLEANED_CHAPTERS_ROOT, canonical_book_slug, serialize_payload

from .source_resolver import BookSource
from .validator import validate_processed_book_result, validate_written_book_dir


def resolve_output_dir(result: dict, *, output_root: str | Path | None = None) -> Path:
    validate_processed_book_result(result)
    book_id = result["book_metadata"]["book_id"]
    return resolve_book_output_dir(book_id, output_root=output_root)


def resolve_book_output_dir(book_id: str, *, output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else FACT_CLEANED_CHAPTERS_ROOT
    return root / canonical_book_slug(book_id)


def chapter_json_file_name(order: int) -> str:
    return f"chapter_{int(order):04d}.json"


def source_chapter_file_name(order: int) -> str:
    return f"chapter_{int(order):04d}.txt"


def build_index_payload(result: dict) -> dict:
    validate_processed_book_result(result)
    chapter_manifest = [
        {
            "order": chapter["order"],
            "chapter_id": chapter["chapter_id"],
            "chapter_no": chapter["chapter_no"],
            "clean_title": chapter["clean_title"],
            "file_name": chapter_json_file_name(chapter["order"]),
        }
        for chapter in result["chapters"]
    ]
    return {
        "book_metadata": result["book_metadata"],
        "chapter_manifest": chapter_manifest,
    }


def write_result_file(
    output_dir: str | Path, result: dict, *, pretty: bool = True
) -> Path:
    validate_processed_book_result(result)
    book_dir = Path(output_dir)
    book_dir.mkdir(parents=True, exist_ok=True)

    index_path = book_dir / "index.json"
    index_payload = build_index_payload(result)
    index_path.write_text(serialize_payload(index_payload, pretty=pretty), encoding="utf-8")

    for chapter in result["chapters"]:
        chapter_path = book_dir / chapter_json_file_name(chapter["order"])
        chapter_path.write_text(serialize_payload(chapter, pretty=pretty), encoding="utf-8")

    expected_chapter_files = {
        chapter_json_file_name(chapter["order"])
        for chapter in result["chapters"]
    }
    for stale_path in book_dir.glob("chapter_*.json"):
        if stale_path.name not in expected_chapter_files:
            stale_path.unlink()

    validate_written_book_dir(book_dir)
    return book_dir


def materialize_source_chapters(
    source: BookSource,
    result: dict,
    *,
    pretty: bool = True,
    overwrite: bool = True,
) -> Path | None:
    """Write source-level chapter TXT files next to a canonical whole-book source."""
    validate_processed_book_result(result)
    if source.mode != "whole":
        return None
    chapters = result.get("chapters") or []
    if not chapters:
        return None

    target_dir = Path(source.source_dir) / "chapters"
    target_dir.mkdir(parents=True, exist_ok=True)

    manifest_chapters: list[dict[str, Any]] = []
    for chapter in chapters:
        order = int(chapter["order"])
        file_name = source_chapter_file_name(order)
        chapter_path = target_dir / file_name
        if overwrite or not chapter_path.exists():
            title = str(chapter.get("clean_title") or chapter.get("raw_title") or file_name)
            content = str(chapter.get("content") or "").strip()
            text = f"{title}\n\n{content}\n" if content else f"{title}\n"
            chapter_path.write_text(text, encoding="utf-8")
        manifest_chapters.append(
            {
                "order": order,
                "chapter_id": chapter.get("chapter_id", ""),
                "title": chapter.get("clean_title") or chapter.get("raw_title") or "",
                "file_name": file_name,
            }
        )

    index_payload = {
        "title": source.title,
        "book_id": result.get("book_metadata", {}).get("book_id", source.book_id),
        "source_file": str(source.primary_source),
        "stage": "source_chapters",
        "chapter_count": len(manifest_chapters),
        "chapters": manifest_chapters,
    }
    (target_dir / "index.json").write_text(
        json.dumps(index_payload, ensure_ascii=False, indent=2 if pretty else None),
        encoding="utf-8",
    )
    return target_dir
