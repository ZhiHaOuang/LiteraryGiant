from __future__ import annotations

from pathlib import Path

from shared import (
    FACT_CHAPTER_FEATURES_ROOT,
    PipelineState,
    canonical_book_slug,
    compute_path_signature,
    load_chapters_from_manifest,
    load_json,
    serialize_payload,
)

from .pipeline import ChapterFeaturePipeline
from .unitizer import UnitizerConfig, build_book_units


def discover_processed_books(input_path: str | Path) -> list[Path]:
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    if path.is_dir() and (path / "index.json").exists():
        return [path]
    if not path.is_dir():
        raise ValueError(f"Input path must be a TaciturnRaw novels_cleaned root or a processed book directory: {path}")
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
    root = Path(output_root) if output_root is not None else FACT_CHAPTER_FEATURES_ROOT
    if "index" in book_bundle:
        book_id = book_bundle["index"]["book_metadata"]["book_id"]
    else:
        book_id = book_bundle["book_metadata"]["book_id"]
    return root / canonical_book_slug(book_id)


def chapter_feature_file_name(order: int) -> str:
    return f"chapter_{int(order):04d}.json"


def _write_payload_atomic(path: Path, payload: dict, *, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(serialize_payload(payload, pretty=pretty), encoding="utf-8")
    tmp_path.replace(path)


def _chapter_manifest_entry(chapter_payload: dict, chapter_path: Path) -> dict:
    entry = {
        "order": int(chapter_payload["order"]),
        "chapter_id": str(chapter_payload["chapter_id"]),
        "clean_title": chapter_payload.get("clean_title"),
        "file_name": chapter_path.name,
    }
    for key in (
        "unit_id",
        "global_unit_order",
        "unit_order_in_chapter",
        "unit_count_in_chapter",
        "source_chapter_id",
        "source_chapter_order",
        "source_chapter_title",
        "source_chapter_char_count",
        "source_char_start",
        "source_char_end",
        "split_reason",
        "book_shape",
        "unitizer_version",
    ):
        if key in chapter_payload:
            entry[key] = chapter_payload.get(key)
    return entry


def _feature_chapter_matches(
    chapter_path: Path,
    *,
    book_id: str,
    chapter_payload: dict,
    source_file: str | Path,
) -> bool:
    if not chapter_path.exists():
        return False
    try:
        payload = load_json(chapter_path)
    except Exception:
        return False

    context = payload.get("chapter_context")
    if not isinstance(context, dict):
        return False
    if str(context.get("book_id")) != str(book_id):
        return False
    if str(context.get("chapter_id")) != str(chapter_payload.get("chapter_id")):
        return False
    try:
        if int(context.get("order", -1)) != int(chapter_payload.get("order", -2)):
            return False
    except (TypeError, ValueError):
        return False

    source_ref = payload.get("source_ref") if isinstance(payload.get("source_ref"), dict) else {}
    recorded_source = source_ref.get("chapter_file") or context.get("source_file")
    if recorded_source:
        try:
            if Path(recorded_source).expanduser().resolve() != Path(source_file).expanduser().resolve():
                return False
        except OSError:
            return False

    semantic_features = payload.get("semantic_features")
    return isinstance(semantic_features, dict) and bool(semantic_features)


def feature_book_index_complete(book_dir: str | Path, output_dir: str | Path) -> bool:
    """Fast path for resuming: trust the atomically flushed feature index."""
    book_path = Path(book_dir)
    feature_dir = Path(output_dir)
    feature_index_path = feature_dir / "index.json"
    if not feature_index_path.exists():
        return False

    try:
        source_index = load_json(book_path / "index.json")
        feature_index = load_json(feature_index_path)
    except Exception:
        return False

    source_metadata = source_index.get("book_metadata") if isinstance(source_index, dict) else {}
    feature_metadata = feature_index.get("book_metadata") if isinstance(feature_index, dict) else {}
    if not isinstance(source_metadata, dict) or not isinstance(feature_metadata, dict):
        return False
    if str(source_metadata.get("book_id")) != str(feature_metadata.get("book_id")):
        return False

    source_manifest = source_index.get("chapter_manifest") or []
    feature_manifest = feature_index.get("chapter_manifest") or []
    if not isinstance(source_manifest, list) or not isinstance(feature_manifest, list):
        return False
    unitization = feature_metadata.get("unitization") if isinstance(feature_metadata.get("unitization"), dict) else {}
    if not unitization.get("enabled") and _source_metadata_is_long_chapter_shape(source_metadata):
        return False
    if unitization.get("enabled") and int(feature_metadata.get("unit_count") or unitization.get("unit_count") or 0) > 0:
        expected_count = int(feature_metadata.get("unit_count") or unitization.get("unit_count") or 0)
        if len(feature_manifest) != expected_count:
            return False
        for expected_order, feature_entry in enumerate(feature_manifest, start=1):
            if not isinstance(feature_entry, dict):
                return False
            try:
                feature_order = int(feature_entry.get("order"))
            except (TypeError, ValueError):
                return False
            if feature_order != expected_order:
                return False
            file_name = str(feature_entry.get("file_name") or chapter_feature_file_name(feature_order))
            chapter_path = feature_dir / file_name
            if not chapter_path.is_file() or chapter_path.stat().st_size <= 0:
                return False
        return True
    if len(source_manifest) == 0 or len(feature_manifest) != len(source_manifest):
        return False

    for source_entry, feature_entry in zip(source_manifest, feature_manifest, strict=True):
        if not isinstance(source_entry, dict) or not isinstance(feature_entry, dict):
            return False
        try:
            source_order = int(source_entry.get("order"))
            feature_order = int(feature_entry.get("order"))
        except (TypeError, ValueError):
            return False
        if source_order != feature_order:
            return False
        if str(source_entry.get("chapter_id")) != str(feature_entry.get("chapter_id")):
            return False
        file_name = str(feature_entry.get("file_name") or chapter_feature_file_name(feature_order))
        chapter_path = feature_dir / file_name
        if not chapter_path.is_file() or chapter_path.stat().st_size <= 0:
            return False

    return True


def _source_metadata_is_long_chapter_shape(source_metadata: dict) -> bool:
    try:
        total_chars = int(source_metadata.get("total_chars") or 0)
        chapter_count = int(source_metadata.get("chapter_count") or 0)
    except (TypeError, ValueError):
        return False
    if chapter_count <= 0:
        return False
    avg_chars = total_chars / chapter_count
    config = UnitizerConfig()
    if avg_chars > config.book_avg_chars_threshold:
        return True
    return chapter_count < config.book_short_chapter_count_threshold and total_chars >= config.book_high_total_chars_threshold


def _load_existing_feature_manifest(output_dir: str | Path, *, book_id: str) -> list[dict]:
    index_path = Path(output_dir) / "index.json"
    if not index_path.exists():
        return []
    try:
        index_payload = load_json(index_path)
    except Exception:
        return []
    metadata = index_payload.get("book_metadata") if isinstance(index_payload, dict) else {}
    if not isinstance(metadata, dict) or str(metadata.get("book_id")) != str(book_id):
        return []
    manifest = index_payload.get("chapter_manifest") if isinstance(index_payload, dict) else []
    if not isinstance(manifest, list):
        return []
    return [entry for entry in manifest if isinstance(entry, dict)]


def _feature_index_entry_matches(
    feature_manifest: list[dict],
    *,
    index: int,
    chapter_payload: dict,
    output_dir: Path,
    fallback_chapter_path: Path,
) -> bool:
    if index < 1 or index > len(feature_manifest):
        return False
    entry = feature_manifest[index - 1]
    try:
        entry_order = int(entry.get("order"))
        chapter_order = int(chapter_payload.get("order"))
    except (TypeError, ValueError):
        return False
    if entry_order != chapter_order:
        return False
    if str(entry.get("chapter_id")) != str(chapter_payload.get("chapter_id")):
        return False
    file_name = str(entry.get("file_name") or fallback_chapter_path.name)
    chapter_path = output_dir / file_name
    return chapter_path.is_file() and chapter_path.stat().st_size > 0


def _unit_input_signature(chapter_file: Path, chapter_payload: dict, *, enabled: bool) -> str:
    if not enabled:
        return ""
    source_signature = compute_path_signature(chapter_file)
    return ":".join(
        [
            source_signature,
            str(chapter_payload.get("unitizer_version") or ""),
            str(chapter_payload.get("unit_id") or chapter_payload.get("chapter_id") or ""),
            str(chapter_payload.get("source_char_start") or 0),
            str(chapter_payload.get("source_char_end") or 0),
            str(chapter_payload.get("char_count") or 0),
        ]
    )


def build_feature_book_metadata(source_book_metadata: dict, *, unitization_report) -> dict:
    metadata = dict(source_book_metadata)
    source_chapter_count = int(source_book_metadata.get("chapter_count") or unitization_report.chapter_count or 0)
    metadata.setdefault("source_chapter_count", source_chapter_count)
    metadata["unit_count"] = unitization_report.unit_count
    metadata["book_shape"] = unitization_report.book_shape
    metadata["unitization"] = unitization_report.to_dict()
    return metadata


def process_book_dir(
    book_dir: str | Path,
    *,
    pipeline: ChapterFeaturePipeline,
    unitizer_config: UnitizerConfig | None = None,
) -> dict:
    book_bundle = load_book_bundle(book_dir)
    source_book_metadata = book_bundle["index"]["book_metadata"]
    book_id = source_book_metadata["book_id"]
    unit_items, unitization_report = build_book_units(
        [(Path(chapter["source_file"]), chapter["payload"]) for chapter in book_bundle["chapters"]],
        book_id=book_id,
        config=unitizer_config,
    )
    processed_chapters = []
    for start in range(0, len(unit_items), pipeline.chapter_batch_size):
        batch = unit_items[start:start + pipeline.chapter_batch_size]
        processed_chapters.extend(
            pipeline.process_chapters(
                [chapter_payload for _chapter_file, chapter_payload in batch],
                source_files=[str(chapter_file) for chapter_file, _chapter_payload in batch],
                book_id=book_id,
            )
        )
    book_metadata = build_feature_book_metadata(source_book_metadata, unitization_report=unitization_report)
    return {
        "book_metadata": book_metadata,
        "chapter_manifest": [
            _chapter_manifest_entry(
                chapter["chapter_context"],
                Path(chapter_feature_file_name(chapter["chapter_context"]["order"])),
            )
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
            "inference_backend": pipeline.nuextract_extractor.inference_backend,
            "vllm_tensor_parallel_size": pipeline.nuextract_extractor.vllm_tensor_parallel_size,
            "vllm_gpu_memory_utilization": pipeline.nuextract_extractor.vllm_gpu_memory_utilization,
            "vllm_max_model_len": pipeline.nuextract_extractor.vllm_max_model_len,
            "vllm_max_num_seqs": pipeline.nuextract_extractor.vllm_max_num_seqs,
            "vllm_generate_batch_size": pipeline.nuextract_extractor.vllm_generate_batch_size,
            "vllm_enforce_eager": pipeline.nuextract_extractor.vllm_enforce_eager,
            "unitizer": unitization_report.to_dict(),
        },
    }


def build_extractor_config(pipeline: ChapterFeaturePipeline) -> dict:
    return {
        "nuextract_model": pipeline.nuextract_extractor.requested_model_name,
        "nuextract_size": pipeline.nuextract_extractor.model_variant,
        "nuextract_model_source": pipeline.nuextract_extractor.resolved_model_source or pipeline.nuextract_extractor.requested_model_name,
        "nuextract_max_input_chars": pipeline.nuextract_extractor.max_input_chars,
        "nuextract_max_new_tokens": pipeline.nuextract_extractor.max_new_tokens,
        "inference_backend": pipeline.nuextract_extractor.inference_backend,
        "vllm_tensor_parallel_size": pipeline.nuextract_extractor.vllm_tensor_parallel_size,
        "vllm_gpu_memory_utilization": pipeline.nuextract_extractor.vllm_gpu_memory_utilization,
        "vllm_max_model_len": pipeline.nuextract_extractor.vllm_max_model_len,
        "vllm_max_num_seqs": pipeline.nuextract_extractor.vllm_max_num_seqs,
        "vllm_generate_batch_size": pipeline.nuextract_extractor.vllm_generate_batch_size,
        "vllm_enforce_eager": pipeline.nuextract_extractor.vllm_enforce_eager,
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
    _write_payload_atomic(book_dir / "index.json", index_payload, pretty=pretty)

    for chapter in processed_book["chapters"]:
        order = int(chapter["chapter_context"]["order"])
        chapter_path = book_dir / chapter_feature_file_name(order)
        _write_payload_atomic(chapter_path, chapter, pretty=pretty)

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
    _write_payload_atomic(index_path, index_payload, pretty=pretty)
    return index_path


def process_and_write_book_dir(
    book_dir: str | Path,
    *,
    pipeline: ChapterFeaturePipeline,
    output_root: str | Path | None = None,
    pretty: bool = True,
    state: PipelineState | None = None,
    book_record: dict | None = None,
    state_save_interval: int = 100,
    index_flush_interval: int | None = None,
    unitizer_config: UnitizerConfig | None = None,
) -> Path:
    book_path = Path(book_dir)
    index_payload = load_json(book_path / "index.json")
    book_bundle = {
        "index": index_payload,
        "book_metadata": index_payload["book_metadata"],
    }
    output_dir = resolve_feature_output_dir(book_bundle, output_root=output_root)
    output_dir.mkdir(parents=True, exist_ok=True)

    source_book_metadata = index_payload["book_metadata"]
    book_id = source_book_metadata["book_id"]
    source_book_dir = str(book_path)
    extractor_config = build_extractor_config(pipeline)
    existing_feature_manifest = _load_existing_feature_manifest(output_dir, book_id=book_id)
    chapter_manifest: list[dict] = []
    source_chapter_items = load_chapters_from_manifest(
        book_path,
        index_payload,
        stage_name="chapters",
    )
    unit_items, unitization_report = build_book_units(
        source_chapter_items,
        book_id=book_id,
        config=unitizer_config,
    )
    book_metadata = build_feature_book_metadata(source_book_metadata, unitization_report=unitization_report)
    extractor_config["unitizer"] = unitization_report.to_dict()
    valid_chapter_ids: set[str] = set()

    total = len(unit_items)
    pending_items: list[tuple[int, Path, dict, Path, dict | None, str, str]] = []
    since_state_save = 0
    since_index_flush = 0
    index_flush_every = max(1, int(index_flush_interval or pipeline.chapter_batch_size))
    state_save_every = max(0, int(state_save_interval))

    def write_checkpoint(*, force_state: bool = False, force_index: bool = False) -> None:
        nonlocal since_state_save, since_index_flush
        if chapter_manifest and (force_index or since_index_flush >= index_flush_every):
            write_feature_index(
                output_dir,
                book_metadata=book_metadata,
                source_book_dir=source_book_dir,
                extractor_config=extractor_config,
                chapter_manifest=chapter_manifest,
                pretty=pretty,
            )
            since_index_flush = 0
        if state is not None and (force_state or (state_save_every > 0 and since_state_save >= state_save_every)):
            state.save()
            since_state_save = 0

    def note_checkpoint_progress(count: int = 1) -> None:
        nonlocal since_state_save, since_index_flush
        since_state_save += count
        since_index_flush += count

    def flush_pending() -> None:
        nonlocal chapter_manifest
        if not pending_items:
            return
        processed_batch = pipeline.process_chapters(
            [chapter_payload for _index, _chapter_file, chapter_payload, _chapter_path, _chapter_record, _chapter_id, _chapter_signature in pending_items],
            source_files=[str(chapter_file) for _index, chapter_file, _chapter_payload, _chapter_path, _chapter_record, _chapter_id, _chapter_signature in pending_items],
            book_id=book_id,
        )
        for (
            (index, _chapter_file, chapter_payload, chapter_path, chapter_record, chapter_id, chapter_signature),
            processed,
        ) in zip(pending_items, processed_batch, strict=True):
            order = int(chapter_payload["order"])
            _write_payload_atomic(chapter_path, processed, pretty=pretty)

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

            chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
            note_checkpoint_progress()
            print(f"[CHAPTER] {book_id} {index}/{total} -> {chapter_path.name}")
        pending_items.clear()
        write_checkpoint()

    if unitization_report.split_chapter_count:
        print(
            f"[UNITIZER] {book_id} shape={unitization_report.book_shape} "
            f"chapters={unitization_report.chapter_count} units={unitization_report.unit_count} "
            f"split_chapters={unitization_report.split_chapter_count} "
            f"avg={unitization_report.avg_chars_per_chapter} p90={unitization_report.p90_chapter_chars}"
        )

    for index, (chapter_file, chapter_payload) in enumerate(unit_items, start=1):
        order = int(chapter_payload["order"])
        chapter_id = str(chapter_payload["chapter_id"])
        chapter_path = output_dir / chapter_feature_file_name(order)
        chapter_signature = _unit_input_signature(chapter_file, chapter_payload, enabled=state is not None)
        valid_chapter_ids.add(chapter_id)
        indexed_output_current = _feature_index_entry_matches(
            existing_feature_manifest,
            index=index,
            chapter_payload=chapter_payload,
            output_dir=output_dir,
            fallback_chapter_path=chapter_path,
        )
        existing_output_current = indexed_output_current or _feature_chapter_matches(
            chapter_path,
            book_id=book_id,
            chapter_payload=chapter_payload,
            source_file=chapter_file,
        )

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
                    "source_chapter_id": chapter_payload.get("source_chapter_id"),
                    "source_chapter_order": chapter_payload.get("source_chapter_order"),
                    "unit_order_in_chapter": chapter_payload.get("unit_order_in_chapter"),
                    "unit_count_in_chapter": chapter_payload.get("unit_count_in_chapter"),
                    "split_reason": chapter_payload.get("split_reason"),
                },
            )
            state_skip = state.should_skip_chapter(
                step_name="softmodel",
                chapter=chapter_record,
                input_signature=chapter_signature,
                output_path=chapter_path,
            )
            if state_skip or existing_output_current:
                if indexed_output_current and state is None:
                    chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
                    indexed_limit = min(len(existing_feature_manifest), total)
                    if index == 1 or index % 500 == 0 or index == indexed_limit:
                        print(f"[CHAPTER-SKIP] {book_id} {index}/{total} -> {chapter_path.name} (index)")
                    continue
                if existing_output_current and not state_skip:
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
                            "recovered_from_output": True,
                        },
                    )
                chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
                note_checkpoint_progress()
                reason = "state" if state_skip else ("index" if indexed_output_current else "output")
                print(f"[CHAPTER-SKIP] {book_id} {index}/{total} -> {chapter_path.name} ({reason})")
                write_checkpoint()
                continue
        else:
            chapter_record = None
            if existing_output_current:
                if indexed_output_current:
                    chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
                    indexed_limit = min(len(existing_feature_manifest), total)
                    if index == 1 or index % 500 == 0 or index == indexed_limit:
                        print(f"[CHAPTER-SKIP] {book_id} {index}/{total} -> {chapter_path.name} (index)")
                    continue
                chapter_manifest.append(_chapter_manifest_entry(chapter_payload, chapter_path))
                note_checkpoint_progress()
                print(f"[CHAPTER-SKIP] {book_id} {index}/{total} -> {chapter_path.name} (output)")
                write_checkpoint()
                continue

        pending_items.append((index, chapter_file, chapter_payload, chapter_path, chapter_record, chapter_id, chapter_signature))
        if len(pending_items) >= pipeline.chapter_batch_size:
            flush_pending()

    flush_pending()

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
    if state is not None:
        state.save()

    return output_dir
