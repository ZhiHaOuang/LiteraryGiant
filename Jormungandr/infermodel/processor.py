from __future__ import annotations

from pathlib import Path

from shared import (
    FACT_PLOT_SEGMENTS_ROOT,
    PipelineState,
    canonical_book_slug,
    compute_path_signature,
    load_chapters_from_manifest,
    load_json,
    serialize_payload,
)

from .checkpoint import InferModelCheckpoint
from .pipeline import InferModelPipeline


def _looks_like_feature_book_dir(path: Path) -> bool:
    return path.is_dir() and (
        (path / "index.json").exists()
        or any(path.glob("[0-9][0-9][0-9][0-9].json"))
        or any(path.glob("chapter_*.json"))
    )


def discover_feature_books(input_path: str | Path) -> list[Path]:
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    if _looks_like_feature_book_dir(path):
        return [path]
    if not path.is_dir():
        raise ValueError(f"Input path must be a TaciturnRaw novels_chapter root or one feature book directory: {path}")
    books = sorted(item for item in path.iterdir() if _looks_like_feature_book_dir(item))
    if not books:
        raise FileNotFoundError(f"No feature book directories found under {path}")
    return books


def feature_book_priority_keys(book_dir: str | Path) -> set[str]:
    book_path = Path(book_dir)
    keys = {book_path.name}
    index_path = book_path / "index.json"
    if not index_path.exists():
        return {key for key in keys if key}
    try:
        index = load_json(index_path)
    except Exception:
        return {key for key in keys if key}
    metadata = index.get("book_metadata") if isinstance(index, dict) else {}
    lineage = (metadata or {}).get("source_lineage") if isinstance(metadata, dict) else {}
    for value in [
        (metadata or {}).get("book_id") if isinstance(metadata, dict) else "",
        (metadata or {}).get("title") if isinstance(metadata, dict) else "",
        ((metadata or {}).get("clean_registry") or {}).get("clean_id") if isinstance((metadata or {}).get("clean_registry"), dict) else "",
        ((metadata or {}).get("clean_registry") or {}).get("clean_slug") if isinstance((metadata or {}).get("clean_registry"), dict) else "",
        (lineage or {}).get("raw_book_id") if isinstance(lineage, dict) else "",
        (lineage or {}).get("raw_book_slug") if isinstance(lineage, dict) else "",
        (lineage or {}).get("identity_key") if isinstance(lineage, dict) else "",
        (lineage or {}).get("source_url") if isinstance(lineage, dict) else "",
    ]:
        text = str(value or "").strip()
        if text:
            keys.add(text)
    return keys


def estimate_feature_book_size(book_dir: str | Path) -> tuple[int, int]:
    book_path = Path(book_dir)
    index_path = book_path / "index.json"
    if index_path.exists():
        try:
            index = load_json(index_path)
            metadata = index.get("book_metadata") if isinstance(index, dict) else {}
            total_chars = int((metadata or {}).get("total_chars") or 0)
            chapter_count = int(
                (metadata or {}).get("unit_count")
                or len(index.get("chapter_manifest") or [])
                or (metadata or {}).get("chapter_count")
                or 0
            )
            if total_chars > 0:
                return total_chars, chapter_count
        except Exception:
            pass

    total_chars = 0
    chapter_count = 0
    for chapter_file in sorted(book_path.glob("chapter_*.json")):
        try:
            payload = load_json(chapter_file)
        except Exception:
            continue
        context = payload.get("chapter_context") if isinstance(payload, dict) else {}
        total_chars += int((context or {}).get("char_count") or payload.get("char_count") or 0)
        chapter_count += 1
    return total_chars, chapter_count


def order_feature_books_by_size(
    books: list[Path],
    *,
    priority_keys: list[str] | None = None,
    negative_keys: list[str] | None = None,
    min_auto_chapters: int | None = None,
    max_auto_chapters: int | None = None,
) -> list[Path]:
    priority_rank = {
        key: index
        for index, key in enumerate(str(item).strip() for item in priority_keys or [])
        if key
    }
    negative_set = {
        str(item).strip()
        for item in negative_keys or []
        if str(item).strip()
    }

    def sort_key(book_dir: Path) -> tuple[int, int, int, str]:
        keys = feature_book_priority_keys(book_dir)
        ranks = [priority_rank[key] for key in keys if key in priority_rank]
        total_chars, chapter_count = estimate_feature_book_size(book_dir)
        if ranks:
            return 0, min(ranks), total_chars, book_dir.name
        return 1, total_chars, chapter_count, book_dir.name

    filtered_books: list[Path] = []
    for book_dir in books:
        keys = feature_book_priority_keys(book_dir)
        if keys & negative_set:
            continue
        priority_match = any(key in priority_rank for key in keys)
        _total_chars, chapter_count = estimate_feature_book_size(book_dir)
        if not priority_match:
            if min_auto_chapters is not None and chapter_count < min_auto_chapters:
                continue
            if max_auto_chapters is not None and chapter_count > max_auto_chapters:
                continue
        filtered_books.append(book_dir)

    return sorted(filtered_books, key=sort_key)


def load_feature_book_bundle(book_dir: str | Path) -> dict:
    book_path = Path(book_dir)
    index_path = book_path / "index.json"
    index = load_json(index_path) if index_path.exists() else None
    if index is None:
        chapter_files = sorted(book_path.glob("chapter_*.json"))
        if not chapter_files:
            chapter_files = sorted(book_path.glob("[0-9][0-9][0-9][0-9].json"))
        chapters = [load_json(chapter_file) for chapter_file in chapter_files]
        index = _build_synthetic_index(book_path, chapters, chapter_files)
    else:
        chapter_items = load_chapters_from_manifest(
            book_path,
            index,
            stage_name="features",
        )
        chapters = [payload for _chapter_file, payload in chapter_items]
    return {
        "book_dir": str(book_path),
        "index": index,
        "chapters": chapters,
    }


def _build_synthetic_index(book_path: Path, chapters: list[dict], chapter_files: list[Path]) -> dict:
    first_context = ((chapters[0] if chapters else {}).get("chapter_context") or {}) if chapters else {}
    book_id = str(first_context.get("book_id") or book_path.name)
    chapter_manifest: list[dict] = []
    for chapter_payload, chapter_file in zip(chapters, chapter_files, strict=True):
        chapter_context = chapter_payload.get("chapter_context") or {}
        order = chapter_context.get("order")
        chapter_manifest.append(
            {
                "order": order,
                "chapter_id": chapter_context.get("chapter_id"),
                "clean_title": chapter_context.get("clean_title") or chapter_context.get("raw_title"),
                "file_name": chapter_file.name,
            }
        )

    return {
        "book_metadata": {
            "book_id": book_id,
            "chapter_count": len(chapters),
            "source_path": str(book_path),
        },
        "chapter_manifest": chapter_manifest,
        "synthetic_index": True,
    }


def resolve_cluster_output_dir(feature_book: dict, *, output_root: str | Path | None = None) -> Path:
    root = Path(output_root) if output_root is not None else FACT_PLOT_SEGMENTS_ROOT
    if "index" in feature_book:
        book_id = feature_book["index"]["book_metadata"]["book_id"]
    else:
        book_id = feature_book["book_metadata"]["book_id"]
    return root / canonical_book_slug(book_id)


def resolve_infer_output_dir(feature_book: dict, *, output_root: str | Path | None = None) -> Path:
    return resolve_cluster_output_dir(feature_book, output_root=output_root)


def process_feature_book_dir(book_dir: str | Path, *, pipeline: InferModelPipeline) -> dict:
    feature_book = load_feature_book_bundle(book_dir)
    return pipeline.process_book(feature_book)


def _write_payload_atomic(path: Path, payload: dict, *, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(serialize_payload(payload, pretty=pretty), encoding="utf-8")
    tmp_path.replace(path)


def write_cluster_book(output_dir: str | Path, processed_book: dict, *, pretty: bool = True) -> Path:
    book_dir = Path(output_dir)
    book_dir.mkdir(parents=True, exist_ok=True)

    plot_manifest = processed_book.get("plot_manifest") or processed_book.get("cluster_manifest", [])
    plot_config = processed_book.get("plot_extraction_config") or processed_book.get("cluster_config", {})

    index_payload = {
        "book_metadata": processed_book["book_metadata"],
        "source_feature_dir": processed_book["source_feature_dir"],
        "chapter_manifest": processed_book["chapter_manifest"],
        "window_manifest": processed_book.get("window_manifest", []),
        "plot_manifest": plot_manifest,
        "inference_metadata": processed_book.get("inference_metadata", {}),
        "plot_extraction_config": plot_config,
        "cluster_manifest": plot_manifest,
        "cluster_config": plot_config,
    }
    if "window_results" in processed_book:
        _write_payload_atomic(
            book_dir / "window_results.json",
            {"window_results": processed_book["window_results"]},
            pretty=pretty,
        )

    for plot in processed_book["plots"]:
        plot_path = book_dir / f"{plot['plot_id']}.json"
        _write_payload_atomic(plot_path, plot, pretty=pretty)

    _write_payload_atomic(book_dir / "index.json", index_payload, pretty=pretty)

    return book_dir


def write_infer_book(output_dir: str | Path, processed_book: dict, *, pretty: bool = True) -> Path:
    return write_cluster_book(output_dir, processed_book, pretty=pretty)


def process_and_write_book_dir(
    book_dir: str | Path,
    *,
    pipeline: InferModelPipeline,
    output_root: str | Path | None = None,
    pretty: bool = True,
    state: PipelineState | None = None,
    book_record: dict | None = None,
    checkpoint_enabled: bool = True,
) -> Path:
    book_path = Path(book_dir)
    feature_book = load_feature_book_bundle(book_path)
    output_dir = resolve_cluster_output_dir(feature_book, output_root=output_root)
    checkpoint = InferModelCheckpoint(output_dir, pretty=pretty) if checkpoint_enabled else None
    if checkpoint is not None:
        checkpoint.update_state(status="starting", source_feature_dir=str(book_path), output_dir=str(output_dir))
    processed_book = pipeline.process_book(feature_book, checkpoint=checkpoint)
    written_dir = write_cluster_book(output_dir, processed_book, pretty=pretty)
    if checkpoint is not None:
        checkpoint.update_state(
            status="complete",
            stage="complete",
            output_dir=str(written_dir),
            plot_count=len(processed_book.get("plots") or []),
            window_count=len(processed_book.get("window_results") or []),
        )

    if state is not None and book_record is not None:
        chapter_manifest = processed_book.get("chapter_manifest") or []
        valid_chapter_ids = {
            str(chapter.get("chapter_id"))
            for chapter in chapter_manifest
            if str(chapter.get("chapter_id") or "").strip()
        }
        if valid_chapter_ids:
            state.prune_book_chapters(book_record, valid_chapter_ids=valid_chapter_ids)

        for chapter in chapter_manifest:
            chapter_id = str(chapter.get("chapter_id") or "").strip()
            if not chapter_id:
                continue
            file_name = str(chapter.get("file_name") or "")
            chapter_file = book_path / file_name
            if not chapter_file.exists():
                continue
            chapter_signature = compute_path_signature(chapter_file)
            chapter_record, _ = state.get_or_create_chapter(
                book_record,
                chapter_id=chapter_id,
                order=int(chapter.get("order") or 0),
                clean_title=str(chapter.get("clean_title") or ""),
                source_path=chapter_file,
                source_signature=chapter_signature,
            )
            state.record_chapter_step(
                step_name="infermodel",
                chapter=chapter_record,
                input_signature=chapter_signature,
                status="completed",
                output_path=written_dir,
                metadata={
                    "book_id": processed_book.get("book_metadata", {}).get("book_id", ""),
                    "plot_output_dir": str(written_dir),
                },
            )

    return written_dir
