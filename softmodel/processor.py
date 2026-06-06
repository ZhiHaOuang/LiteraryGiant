from __future__ import annotations

from pathlib import Path

from shared import (
    DATA_ROOT,
    PipelineState,
    canonical_book_slug,
    compute_path_signature,
    load_chapters_from_manifest,
    load_json,
    serialize_payload,
)

from .pipeline import ChapterFeaturePipeline


def discover_processed_books(input_path: str | Path) -> list[Path]:
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    if path.is_dir() and (path / "index.json").exists():
        return [path]
    if not path.is_dir():
        raise ValueError(f"Input path must be a derived chapters root or a processed book directory: {path}")
    books = sorted(item for item in path.iterdir() if item.is_dir() and (item / "index.json").exists())
    if not books:
        raise FileNotFoundError(f"No processed book directories found under {path}")
    return books


def load_book_bundle(book_dir: str | Path) -> dict:
    book_path = Path(book_dir)
    index = load_json(book_path / "index.json")
    chapters = [
        {"source_file": str(chapter_file), "payload": payload}
        for chapter_file, payload in load_chapters_from_manifest(
            book_path,
            index,
            stage_name="chapters",
        )
    ]
    return {
        "book_dir": str(book_path),
        "index": index,
        "chapters": chapters,
    }


def resolve_feature_output_dir(book_bundle: dict, *, output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else DATA_ROOT / "derived" / "features"
    if "index" in book_bundle:
        book_id = book_bundle["index"]["book_metadata"]["book_id"]
    else:
        book_id = book_bundle["book_metadata"]["book_id"]
    return root / canonical_book_slug(book_id)


def chapter_feature_file_name(order: int) -> str:
    return f"chapter_{int(order):04d}.json"


def process_book_dir(book_dir: str | Path, *, pipeline: ChapterFeaturePipeline) -> dict:
    book_bundle = load_book_bundle(book_dir)
    book_id = book_bundle["index"]["book_metadata"]["book_id"]
    processed_chapters = []
    for chapter in book_bundle["chapters"]:
        processed_chapters.append(
            pipeline.process_chapter(
                chapter["payload"],
                source_file=chapter["source_file"],
                book_id=book_id,
            )
        )
    return {
        "book_metadata": book_bundle["index"]["book_metadata"],
        "chapter_manifest": [
            {
                "order": chapter["chapter_context"]["order"],
                "chapter_id": chapter["chapter_context"]["chapter_id"],
                "clean_title": chapter["chapter_context"]["clean_title"],
                "file_name": chapter_feature_file_name(chapter["chapter_context"]["order"]),
            }
            for chapter in processed_chapters
        ],
        "chapters": processed_chapters,
        "source_book_dir": book_bundle["book_dir"],
        "extractor_config": {
            "nuextract_model": pipeline.nuextract_extractor.requested_model_name,
            "nuextract_size": pipeline.nuextract_extractor.model_variant,
            "nuextract_model_source": pipeline.nuextract_extractor.resolved_model_source or pipeline.nuextract_extractor.requested_model_name,
            "nuextract_max_input_chars": pipeline.nuextract_extractor.max_input_chars,
            "nuextract_max_new_tokens": pipeline.nuextract_extractor.max_new_tokens,
        },
    }


def build_extractor_config(pipeline: ChapterFeaturePipeline) -> dict:
    return {
        "nuextract_model": pipeline.nuextract_extractor.requested_model_name,
        "nuextract_size": pipeline.nuextract_extractor.model_variant,
        "nuextract_model_source": pipeline.nuextract_extractor.resolved_model_source or pipeline.nuextract_extractor.requested_model_name,
        "nuextract_max_input_chars": pipeline.nuextract_extractor.max_input_chars,
        "nuextract_max_new_tokens": pipeline.nuextract_extractor.max_new_tokens,
    }


def write_feature_book(output_dir: str | Path, processed_book: dict, *, pretty: bool = True) -> Path:
    book_dir = Path(output_dir)
    book_dir.mkdir(parents=True, exist_ok=True)

    index_payload = {
        "book_metadata": processed_book["book_metadata"],
        "source_book_dir": processed_book["source_book_dir"],
        "extractor_config": processed_book["extractor_config"],
        "chapter_manifest": processed_book["chapter_manifest"],
    }
    (book_dir / "index.json").write_text(serialize_payload(index_payload, pretty=pretty), encoding="utf-8")

    for chapter in processed_book["chapters"]:
        order = int(chapter["chapter_context"]["order"])
        chapter_path = book_dir / chapter_feature_file_name(order)
        chapter_path.write_text(serialize_payload(chapter, pretty=pretty), encoding="utf-8")

    return book_dir


def write_feature_index(
    output_dir: str | Path,
    *,
    book_metadata: dict,
    source_book_dir: str,
    extractor_config: dict,
    chapter_manifest: list[dict],
    pretty: bool = True,
) -> Path:
    book_dir = Path(output_dir)
    book_dir.mkdir(parents=True, exist_ok=True)
    index_payload = {
        "book_metadata": book_metadata,
        "source_book_dir": source_book_dir,
        "extractor_config": extractor_config,
        "chapter_manifest": chapter_manifest,
    }
    index_path = book_dir / "index.json"
    index_path.write_text(serialize_payload(index_payload, pretty=pretty), encoding="utf-8")
    return index_path


def process_and_write_book_dir(
    book_dir: str | Path,
    *,
    pipeline: ChapterFeaturePipeline,
    output_root: str | Path | None = None,
    pretty: bool = True,
    state: PipelineState | None = None,
    book_record: dict | None = None,
) -> Path:
    book_path = Path(book_dir)
    index_payload = load_json(book_path / "index.json")
    book_bundle = {
        "index": index_payload,
        "book_metadata": index_payload["book_metadata"],
    }
    output_dir = resolve_feature_output_dir(book_bundle, output_root=output_root)
    output_dir.mkdir(parents=True, exist_ok=True)

    book_metadata = index_payload["book_metadata"]
    book_id = book_metadata["book_id"]
    source_book_dir = str(book_path)
    extractor_config = build_extractor_config(pipeline)
    chapter_manifest: list[dict] = []
    chapter_items = load_chapters_from_manifest(
        book_path,
        index_payload,
        stage_name="chapters",
    )
    valid_chapter_ids: set[str] = set()

    total = len(chapter_items)
    for index, (chapter_file, chapter_payload) in enumerate(chapter_items, start=1):
        order = int(chapter_payload["order"])
        chapter_id = str(chapter_payload["chapter_id"])
        chapter_path = output_dir / chapter_feature_file_name(order)
        chapter_signature = compute_path_signature(chapter_file)
        valid_chapter_ids.add(chapter_id)

        if state is not None and book_record is not None:
            chapter_record, _ = state.get_or_create_chapter(
                book_record,
                chapter_id=chapter_id,
                order=order,
                clean_title=str(chapter_payload.get("clean_title", "")),
                source_path=chapter_file,
                source_signature=chapter_signature,
                metadata={
                    "chapter_no": chapter_payload.get("chapter_no"),
                    "volume_title": chapter_payload.get("volume_title", ""),
                    "char_count": chapter_payload.get("char_count", 0),
                    "paragraph_count": chapter_payload.get("paragraph_count", 0),
                    "dialogue_ratio": chapter_payload.get("dialogue_ratio"),
                },
            )
            if state.should_skip_chapter(
                step_name="softmodel",
                chapter=chapter_record,
                input_signature=chapter_signature,
                output_path=chapter_path,
            ):
                chapter_manifest.append(
                    {
                        "order": order,
                        "chapter_id": chapter_id,
                        "clean_title": chapter_payload.get("clean_title"),
                        "file_name": chapter_path.name,
                    }
                )
                print(f"[CHAPTER-SKIP] {book_id} {index}/{total} -> {chapter_path.name}")
                continue
        else:
            chapter_record = None

        processed = pipeline.process_chapter(
            chapter_payload,
            source_file=str(chapter_file),
            book_id=book_id,
        )
        chapter_path.write_text(serialize_payload(processed, pretty=pretty), encoding="utf-8")

        if state is not None and book_record is not None and chapter_record is not None:
            state.record_chapter_step(
                step_name="softmodel",
                chapter=chapter_record,
                input_signature=chapter_signature,
                status="completed",
                output_path=chapter_path,
                params=extractor_config,
                metadata={
                    "book_index": book_record["index"],
                    "order": order,
                    "chapter_id": chapter_id,
                },
            )

        chapter_manifest.append(
            {
                "order": order,
                "chapter_id": chapter_id,
                "clean_title": chapter_payload.get("clean_title"),
                "file_name": chapter_path.name,
            }
        )
        print(f"[CHAPTER] {book_id} {index}/{total} -> {chapter_path.name}")

    if state is not None and book_record is not None:
        state.prune_book_chapters(book_record, valid_chapter_ids=valid_chapter_ids)

    write_feature_index(
        output_dir,
        book_metadata=book_metadata,
        source_book_dir=source_book_dir,
        extractor_config=extractor_config,
        chapter_manifest=chapter_manifest,
        pretty=pretty,
    )

    return output_dir
