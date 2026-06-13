"""Batch I/O for hardmodel: discover inputs, process per book, write outputs.

Supports both whole-book and per-chapter input modes, with incremental
processing via :class:`~shared.PipelineState`.
"""

from __future__ import annotations

import logging
import json
from pathlib import Path

from shared import PipelineState, compute_path_signature, compute_source_fingerprint

from .chapter_cleaner import RawNovelBook
from .manifest_writer import (
    chapter_json_file_name,
    materialize_source_chapters,
    resolve_book_output_dir,
    resolve_output_dir,
    write_result_file,
)
from .source_resolver import BookSource, resolve_input

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public entry point — the main function used by scheduling.py
# ---------------------------------------------------------------------------


def discover_and_process(
    input_path: str | Path,
    *,
    output_root: str | Path | None = None,
    encoding: str = "utf-8",
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
    state: PipelineState | None = None,
    noise_classifier=None,
) -> list[dict]:
    """Discover book(s) at *input_path* and process each one.

    Returns a list of result dicts (one per book).
    """
    sources = resolve_input(input_path)
    results: list[dict] = []
    for source in sources:
        result = process_book_source(
            source,
            output_root=output_root,
            encoding=encoding,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            state=state,
            noise_classifier=noise_classifier,
        )
        results.append(result)
    return results


def process_book_source(
    source: BookSource,
    *,
    output_root: str | Path | None = None,
    encoding: str = "utf-8",
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
    state: PipelineState | None = None,
    noise_classifier=None,
    book_id_override: str | None = None,
    metadata_overrides: dict | None = None,
    source_signature: str | None = None,
    chapter_incremental: bool = False,
) -> dict:
    """Process a single :class:`BookSource` — dispatches to the right mode."""
    book = RawNovelBook.from_book_source(
        source,
        book_id_override=book_id_override,
        encoding=encoding,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        noise_classifier=noise_classifier,
    )

    if source.mode == "per_chapter":
        return _process_per_chapter_incremental(
            source,
            book,
            output_root=output_root,
            state=state,
            book_id_override=book_id_override,
            metadata_overrides=metadata_overrides,
            source_signature=source_signature,
            chapter_incremental=chapter_incremental,
        )

    # Whole-book mode — existing logic
    return _process_whole_book(
        source,
        book,
        output_root=output_root,
        state=state,
        book_id_override=book_id_override,
        metadata_overrides=metadata_overrides,
        source_signature=source_signature,
    )


# ---------------------------------------------------------------------------
# Whole-book processing (legacy path — unchanged)
# ---------------------------------------------------------------------------


def _process_whole_book(
    source: BookSource,
    book: RawNovelBook,
    *,
    output_root: str | Path | None = None,
    state: PipelineState | None = None,
    book_id_override: str | None = None,
    metadata_overrides: dict | None = None,
    source_signature: str | None = None,
) -> dict:
    """Process a whole-book TXT: read → normalise → clean → split."""
    source_path = source.primary_source
    source_signature = source_signature or compute_source_fingerprint(source)
    effective_book_id = book_id_override or source.book_id
    output_dir = resolve_book_output_dir(effective_book_id, output_root=output_root)

    # Check PipelineState for skip
    if state is not None:
        should_skip, _ = state.should_skip_step(
            step_name="hardmodel",
            source_path=source_path,
            source_signature=source_signature,
            output_path=output_dir,
        )
        if should_skip:
            logger.info("Skipping unchanged book: %s", source_path)
            return {}

    # Process
    result = book.process()
    _apply_metadata_overrides(result, metadata_overrides)
    return result


# ---------------------------------------------------------------------------
# Per-chapter processing (new — incremental at chapter level)
# ---------------------------------------------------------------------------


def _process_per_chapter_incremental(
    source: BookSource,
    book: RawNovelBook,
    *,
    output_root: str | Path | None = None,
    state: PipelineState | None = None,
    book_id_override: str | None = None,
    metadata_overrides: dict | None = None,
    source_signature: str | None = None,
    chapter_incremental: bool = False,
) -> dict:
    """Process a per-chapter book incrementally.

    - The scheduler is expected to skip unchanged books before this function.
    - By default changed/new books are processed at book granularity, avoiding
      per-chapter hashing and old JSON cache reads.
    - ``chapter_incremental=True`` preserves the older per-chapter skip path.
    """
    chapter_sources = source.chapters
    if not chapter_sources:
        raise ValueError(f"No chapters found for book: {source.title}")

    effective_book_id = book_id_override or source.book_id
    output_dir = resolve_book_output_dir(effective_book_id, output_root=output_root)

    # Ensure book is tracked in PipelineState
    if state is not None:
        book_signature = source_signature or compute_source_fingerprint(source)
        book_record, is_new_book = state.get_or_create_book(
            source_path=source.source_dir,
            source_signature=book_signature,
        )
    else:
        book_signature = ""
        book_record, is_new_book = None, False

    new_records: list[dict] = []
    prepared_items: list[dict] = []
    skipped_count = 0
    processed_count = 0
    book._line_frequency_counts = book._build_frequency_counts_for_sources(chapter_sources)

    for ch_src in chapter_sources:
        ch_signature = ""

        # The legacy chapter-incremental mode is intentionally opt-in because
        # it reads every source chapter and old JSON cache before skipping.
        if chapter_incremental and state is not None and book_record is not None:
            ch_signature = compute_path_signature(ch_src.source_path)
            chapter_record, _ = state.get_or_create_chapter(
                book_record,
                chapter_id=f"{effective_book_id}C{ch_src.order:04d}",
                order=ch_src.order,
                clean_title=ch_src.title,
                source_path=ch_src.source_path,
                source_signature=ch_signature,
            )
            chapter_path = output_dir / chapter_json_file_name(ch_src.order)
            if state.should_skip_chapter(
                step_name="hardmodel",
                chapter=chapter_record,
                input_signature=ch_signature,
                output_path=chapter_path,
            ):
                # Reuse the existing chapter data from the previous output
                if chapter_path.exists():
                    existing = json.loads(chapter_path.read_text(encoding="utf-8"))
                    new_records.append(existing)
                    skipped_count += 1
                    continue
        elif state is not None and book_record is not None:
            ch_signature = f"{book_signature}:chapter:{ch_src.order}:{ch_src.source_path.name}"

        # Rule-clean this chapter first; weak-noise LLM decisions are resolved
        # once per book below so vLLM sees large, parallelizable batches.
        try:
            draft = book.prepare_chapter_cleaning(ch_src)
            prepared_items.append(
                {
                    "chapter_source": ch_src,
                    "chapter_signature": ch_signature,
                    "draft": draft,
                }
            )
        except Exception:
            logger.exception("Failed to process chapter %s: %s", ch_src.order, ch_src.source_path)
            if state is not None and book_record is not None:
                chapter_record, _ = state.get_or_create_chapter(
                    book_record,
                    chapter_id=f"{effective_book_id}C{ch_src.order:04d}",
                    order=ch_src.order,
                    clean_title=ch_src.title,
                    source_path=ch_src.source_path,
                    source_signature=ch_signature,
                )
                state.record_chapter_step(
                    step_name="hardmodel",
                    chapter=chapter_record,
                    input_signature=ch_signature,
                    status="failed",
                    output_path=None,
                )
            continue

    if prepared_items and book.noise_classifier is not None:
        _apply_book_level_weak_noise(book, prepared_items)

    for item in prepared_items:
        ch_src = item["chapter_source"]
        ch_signature = item["chapter_signature"]
        try:
            record = book.finalize_chapter_cleaning(item["draft"])
            record_dict = record.to_dict()
            new_records.append(record_dict)
            processed_count += 1

            if state is not None and book_record is not None:
                chapter_record, _ = state.get_or_create_chapter(
                    book_record,
                    chapter_id=record.chapter_id,
                    order=record.order,
                    clean_title=record.clean_title,
                    source_path=ch_src.source_path,
                    source_signature=ch_signature,
                    metadata={
                        "chapter_no": record.chapter_no,
                        "char_count": record.char_count,
                        "paragraph_count": record.paragraph_count,
                        "dialogue_ratio": record.dialogue_ratio,
                    },
                )
                state.record_chapter_step(
                    step_name="hardmodel",
                    chapter=chapter_record,
                    input_signature=ch_signature,
                    status="completed",
                    output_path=output_dir / chapter_json_file_name(ch_src.order),
                    metadata={
                        "char_count": record.char_count,
                        "paragraph_count": record.paragraph_count,
                    },
                )
        except Exception:
            logger.exception("Failed to finalize chapter %s: %s", ch_src.order, ch_src.source_path)
            if state is not None and book_record is not None:
                chapter_record, _ = state.get_or_create_chapter(
                    book_record,
                    chapter_id=f"{effective_book_id}C{ch_src.order:04d}",
                    order=ch_src.order,
                    clean_title=ch_src.title,
                    source_path=ch_src.source_path,
                    source_signature=ch_signature,
                )
                state.record_chapter_step(
                    step_name="hardmodel",
                    chapter=chapter_record,
                    input_signature=ch_signature,
                    status="failed",
                    output_path=None,
                )

    if not new_records:
        raise RuntimeError(f"No chapters could be processed for {source.title}")

    # Sort by order
    new_records.sort(key=lambda r: r["order"])

    # Compute book-level metadata
    total_chars = sum(r["char_count"] for r in new_records)
    total_paragraphs = sum(r["paragraph_count"] for r in new_records)
    cleaning_summary = _build_cleaning_summary(
        book.cleaning_stats,
        book.discarded_line_examples,
        book.trimmed_line_examples,
    )

    result = {
        "book_metadata": {
            "book_id": effective_book_id,
            "content_type": source.content_type,
            "processing_profile": source.processing_profile,
            "source_path": str(source.source_dir),
            "chapter_count": len(new_records),
            "volume_count": len({r.get("volume_title") for r in new_records if r.get("volume_title")}),
            "total_chars": total_chars,
            "total_paragraphs": total_paragraphs,
            "avg_chapter_chars": round(total_chars / len(new_records), 2) if new_records else 0,
            "cleaning_stats": dict(book.cleaning_stats),
            "cleaning_summary": cleaning_summary,
            "chapter_anomalies": _detect_chapter_anomalies(new_records),
        },
        "chapters": new_records,
    }
    _apply_metadata_overrides(result, metadata_overrides)

    # Update book-level state
    if state is not None and book_record is not None:
        valid_ids = {r["chapter_id"] for r in new_records}
        state.prune_book_chapters(book_record, valid_chapter_ids=valid_ids)
        state.update_raw_stats(
            book_record,
            {"chapter_count": len(chapter_sources)},
        )
        state.record_step(
            step_name="hardmodel",
            book=book_record,
            source_signature=book_signature,
            status="completed",
            output_path=output_dir,
            metadata={
                "book_id": effective_book_id,
                "content_type": source.content_type,
                "processing_profile": source.processing_profile,
                "chapter_count": len(new_records),
                "total_chars": total_chars,
                "total_paragraphs": total_paragraphs,
            },
        )

    logger.info(
        "Per-chapter book '%s': %d processed, %d skipped, %d total",
        source.title, processed_count, skipped_count, len(new_records),
    )
    return result


def _apply_book_level_weak_noise(book: RawNovelBook, prepared_items: list[dict]) -> None:
    """Resolve weak-noise candidates across a whole book in one classifier pass.

    The cleaner builds candidate ids locally per chapter.  For vLLM efficiency
    we remap them to book-unique ids, classify all windows with the classifier's
    own batching/concurrency, then map actions back to each chapter draft.
    """
    noise_classifier = book.noise_classifier
    if noise_classifier is None:
        return

    global_candidates: list[dict] = []
    route_by_global_id: dict[int, tuple[object, int, int]] = {}
    next_candidate_id = 0
    for item in prepared_items:
        chapter_source = item["chapter_source"]
        draft = item["draft"].text
        for candidate in draft.uncertain_windows:
            local_candidate_id = int(candidate["candidate_id"])
            local_kept_index = int(candidate["kept_index"])
            global_candidate = dict(candidate)
            global_candidate["candidate_id"] = next_candidate_id
            global_candidate["chapter_order"] = chapter_source.order
            global_candidate["chapter_title"] = chapter_source.title
            global_candidate["local_candidate_id"] = local_candidate_id
            global_candidate["local_kept_index"] = local_kept_index
            route_by_global_id[next_candidate_id] = (
                draft,
                local_candidate_id,
                local_kept_index,
            )
            global_candidates.append(global_candidate)
            next_candidate_id += 1

    if not global_candidates:
        return

    book.cleaning_stats["weak_classifier_calls"] += 1
    book.cleaning_stats["weak_classifier_windows"] += len(global_candidates)
    try:
        classifier_results = noise_classifier(global_candidates)
    except Exception:
        book.cleaning_stats["weak_classifier_failures"] += 1
        logger.exception("Book-level weak-noise classifier failed for %s", book.source_path)
        return

    local_results_by_draft_id: dict[int, list] = {}
    draft_by_id: dict[int, object] = {}
    for result in classifier_results:
        if isinstance(result, dict):
            global_candidate_id = RawNovelBook._optional_int(result.get("candidate_id"))
            if global_candidate_id is None:
                continue
            route = route_by_global_id.get(global_candidate_id)
            if route is None:
                continue
            draft, local_candidate_id, local_kept_index = route
            local_result = dict(result)
            local_result["candidate_id"] = local_candidate_id
            local_result["kept_index"] = local_kept_index
        else:
            global_candidate_id = RawNovelBook._optional_int(result)
            if global_candidate_id is None:
                continue
            route = route_by_global_id.get(global_candidate_id)
            if route is None:
                continue
            draft, local_candidate_id, local_kept_index = route
            local_result = {
                "candidate_id": local_candidate_id,
                "kept_index": local_kept_index,
                "action": "drop",
            }

        draft_id = id(draft)
        draft_by_id[draft_id] = draft
        local_results_by_draft_id.setdefault(draft_id, []).append(local_result)

    for draft_id, local_results in local_results_by_draft_id.items():
        book.apply_weak_noise_results(draft_by_id[draft_id], local_results)


# ---------------------------------------------------------------------------
# Legacy functions — kept for backward compatibility
# ---------------------------------------------------------------------------


def _apply_metadata_overrides(result: dict, metadata_overrides: dict | None) -> None:
    if not metadata_overrides:
        return
    metadata = result.setdefault("book_metadata", {})
    for key, value in metadata_overrides.items():
        metadata[key] = value


def discover_txt_files(
    input_path: str | Path,
    *,
    pattern: str = "*.txt",
    recursive: bool = True,
) -> list[Path]:
    """Discover ``.txt`` files (legacy compatibility wrapper)."""
    sources = resolve_input(input_path)
    paths: list[Path] = []
    for src in sources:
        for ch in src.chapters:
            paths.append(ch.source_path)
    return paths


def process_txt_file(
    source_path: str | Path,
    *,
    encoding: str = "utf-8",
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
) -> dict:
    """Process a single ``.txt`` file (legacy compatibility wrapper)."""
    sources = resolve_input(source_path)
    if not sources:
        raise FileNotFoundError(f"No book source found at: {source_path}")
    return process_book_source(
        sources[0],
        encoding=encoding,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )


def _detect_chapter_anomalies(records: list[dict]) -> list[dict[str, object]]:
    if not records:
        return []
    anomalies: list[dict[str, object]] = []
    lengths = [int(record.get("char_count") or 0) for record in records if int(record.get("char_count") or 0) > 0]
    avg_chars = sum(lengths) / len(lengths) if lengths else 0
    expected_order = 1
    for record in records:
        order = int(record.get("order") or 0)
        char_count = int(record.get("char_count") or 0)
        paragraph_count = int(record.get("paragraph_count") or 0)
        reasons: list[str] = []
        if order != expected_order:
            reasons.append(f"non_contiguous_order_expected_{expected_order}")
            expected_order = order
        expected_order += 1
        if char_count == 0:
            reasons.append("empty_content")
        elif char_count < 80:
            reasons.append("very_short_content")
        elif avg_chars and char_count < avg_chars * 0.12:
            reasons.append("short_length_outlier")
        elif avg_chars and char_count > avg_chars * 4:
            reasons.append("long_length_outlier")
        if paragraph_count <= 1 and char_count > 300:
            reasons.append("single_paragraph_long_chapter")
        if reasons:
            anomalies.append(
                {
                    "order": order,
                    "chapter_id": str(record.get("chapter_id") or ""),
                    "clean_title": str(record.get("clean_title") or record.get("raw_title") or ""),
                    "char_count": char_count,
                    "paragraph_count": paragraph_count,
                    "reasons": reasons,
                }
            )
    return anomalies


def _build_cleaning_summary(stats: dict[str, int], examples: list[dict], trim_examples: list[dict]) -> dict:
    lines_seen = int(stats.get("lines_seen") or 0)
    strong_dropped = int(stats.get("strong_dropped") or 0)
    weak_dropped = int(stats.get("weak_dropped") or 0)
    discarded_total = strong_dropped + weak_dropped
    weak_candidates = int(stats.get("weak_candidates") or 0)
    trimmed_lines = int(stats.get("trimmed_lines") or 0)
    return {
        "lines_seen": lines_seen,
        "discarded_lines": discarded_total,
        "strong_dropped": strong_dropped,
        "weak_candidates": weak_candidates,
        "weak_dropped": weak_dropped,
        "discard_rate": round(discarded_total / lines_seen, 4) if lines_seen else 0.0,
        "weak_candidate_rate": round(weak_candidates / lines_seen, 4) if lines_seen else 0.0,
        "typical_discarded_lines": _dedupe_discarded_line_examples(examples, limit=10),
        "trimmed_lines": trimmed_lines,
        "rule_trimmed": int(stats.get("rule_trimmed") or 0),
        "llm_trimmed": int(stats.get("llm_trimmed") or 0),
        "trim_rate": round(trimmed_lines / lines_seen, 4) if lines_seen else 0.0,
        "typical_trimmed_lines": _dedupe_trimmed_line_examples(trim_examples, limit=10),
    }


def _dedupe_discarded_line_examples(examples: list[dict], *, limit: int = 10) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    result: list[dict] = []
    for item in examples:
        key = (str(item.get("line") or ""), str(item.get("reason") or ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _dedupe_trimmed_line_examples(examples: list[dict], *, limit: int = 10) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    result: list[dict] = []
    for item in examples:
        key = (str(item.get("original_line") or ""), str(item.get("cleaned_line") or ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= limit:
            break
    return result
