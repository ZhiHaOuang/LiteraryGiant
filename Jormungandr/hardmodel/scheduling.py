from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import sys

from shared import (
    CLEANED_BOOKS_REGISTRY_PATH,
    FACT_CLEANED_CHAPTERS_ROOT,
    RUNS_ROOT,
    CleanedBookRegistry,
    PipelineState,
    serialize_payload,
)

from .source_resolver import resolve_input
from .processor import (
    materialize_source_chapters,
    process_book_source,
    resolve_output_dir,
    write_result_file,
)
from .llm_noise_classifier import QwenWeakNoiseClassifier, VLLMWeakNoiseClassifier


logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jormungandr-hard-run",
        description="Run rule-based TXT novel preprocessing for a single file or a directory of files.",
    )
    parser.add_argument("input", help="Input txt file path or directory path.")
    parser.add_argument(
        "-o",
        "--output",
        help=f"Output root directory. Defaults to {FACT_CLEANED_CHAPTERS_ROOT}.",
    )
    parser.add_argument(
        "--pattern",
        default="*.txt",
        help="Glob pattern when input is a directory. Default: *.txt",
    )
    parser.add_argument(
        "--non-recursive",
        action="store_true",
        help="Only scan the top level of the input directory.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Preferred input encoding. Fallback encodings are handled internally.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1500,
        help="Maximum characters per chunk before overlap handling.",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=200,
        help="Overlap characters kept between adjacent chunks.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write compact JSON instead of pretty JSON.",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout. Only valid for a single input file.",
    )
    parser.add_argument(
        "--materialize-source-chapters",
        action="store_true",
        help="For whole-book source.txt inputs, write source-level chapter TXT files under source_dir/chapters/.",
    )
    parser.add_argument(
        "--sync-state",
        dest="sync_state",
        action="store_true",
        default=True,
        help="Sync progress and chapter state into runs/pipeline_state/state.json. Enabled by default.",
    )
    parser.add_argument(
        "--no-sync-state",
        dest="sync_state",
        action="store_false",
        help="Do not write progress or chapter state into runs/pipeline_state/state.json for this run.",
    )
    parser.add_argument(
        "--use-clean-registry",
        action="store_true",
        help=(
            "Assign cleaned book ids through Library/indexes/cleaned_books.json "
            "instead of reusing TaciturnRaw book ids."
        ),
    )
    parser.add_argument(
        "--clean-registry-path",
        default=str(CLEANED_BOOKS_REGISTRY_PATH),
        help=f"Cleaned corpus registry path. Default: {CLEANED_BOOKS_REGISTRY_PATH}.",
    )
    parser.add_argument(
        "--clean-registry-replace",
        default="",
        help=(
            "Replace the raw source mapped to an existing cleaned slug, e.g. book_0005. "
            "Only valid when the input resolves to one book."
        ),
    )
    parser.add_argument(
        "--pending-fetches",
        action="store_true",
        help=(
            "Read runs/fetch/run_index.json and process only successful fetch outputs "
            "that are not current in the clean registry."
        ),
    )
    parser.add_argument(
        "--fetch-index",
        default=str(RUNS_ROOT / "fetch" / "run_index.json"),
        help="Fetch run index used by --pending-fetches.",
    )
    parser.add_argument(
        "--fetch-run-id",
        action="append",
        default=[],
        help="Limit --pending-fetches to one fetch run id. Can be repeated.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore clean-registry freshness checks and process selected sources.",
    )
    parser.add_argument(
        "--strict-resume-check",
        action="store_true",
        help=(
            "Resolve every source and verify chapter counts before registry skips. "
            "Default resume mode only checks registry id/output presence."
        ),
    )
    parser.add_argument(
        "--chapter-incremental",
        action="store_true",
        help="Use the old per-chapter hashing/cache skip path inside changed books.",
    )
    parser.add_argument(
        "--noise-classifier-model",
        default=None,
        help="Optional local model path for backend=local, or served model name for backend=vllm.",
    )
    parser.add_argument(
        "--noise-classifier-backend",
        choices=("local", "vllm"),
        default="local",
        help="Weak-noise classifier backend. Default: local transformers.",
    )
    parser.add_argument(
        "--noise-classifier-url",
        default="http://127.0.0.1:8000/v1",
        help="OpenAI-compatible vLLM base URL when backend=vllm. Default: http://127.0.0.1:8000/v1.",
    )
    parser.add_argument(
        "--noise-classifier-batch-size",
        type=int,
        default=16,
        help="Weak-noise windows per LLM classification prompt. Default: 16.",
    )
    parser.add_argument(
        "--noise-classifier-max-new-tokens",
        type=int,
        default=128,
        help="Max new tokens for each weak-noise classification prompt.",
    )
    parser.add_argument(
        "--noise-classifier-temperature",
        type=float,
        default=0.0,
        help="Sampling temperature for weak-noise classifier. Default: 0.",
    )
    parser.add_argument(
        "--noise-classifier-timeout",
        type=float,
        default=120.0,
        help="HTTP timeout in seconds for backend=vllm. Default: 120.",
    )
    parser.add_argument(
        "--noise-classifier-concurrency",
        type=int,
        default=16,
        help="Concurrent vLLM classifier requests. Only used with backend=vllm. Default: 16.",
    )
    parser.add_argument(
        "--noise-classifier-device-map",
        default="auto",
        help="Transformers device_map for the weak-noise classifier. Default: auto.",
    )
    return parser


def _load_fetch_run_entries(fetch_index: str | Path) -> list[dict]:
    path = Path(fetch_index)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("Could not parse fetch index: %s", path)
        return []
    runs = payload.get("runs", []) if isinstance(payload, dict) else payload
    return [item for item in runs if isinstance(item, dict)]


def _path_is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _fetch_entry_chapter_count(entry: dict) -> int:
    content_stats = entry.get("content_stats") or {}
    for value in (
        content_stats.get("fetched_parts"),
        entry.get("total_fetched"),
        entry.get("total_expected"),
    ):
        try:
            count = int(value)
        except (TypeError, ValueError):
            continue
        if count > 0:
            return count
    return 0


def _source_chapter_marker(source) -> str:
    return f"chapters:{len(getattr(source, 'chapters', []) or [])}"


def _load_json_object(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _looks_like_book_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    if (path / "source.txt").exists() or (path / "story.txt").exists():
        return True
    if (path / "chapters").is_dir():
        return True
    index_payload = _load_json_object(path / "index.json")
    if index_payload.get("book_slug") or index_payload.get("story_slug"):
        return True
    if isinstance(index_payload.get("chapters"), list):
        return True
    return any(item.is_file() and item.suffix.lower() == ".txt" for item in path.iterdir())


def _raw_slug_from_dir(path: Path) -> str:
    payload = _load_json_object(path / "index.json")
    return str(
        payload.get("book_slug")
        or payload.get("story_slug")
        or payload.get("book_id")
        or path.name
    )


def _slug_numeric_id(slug: str) -> str:
    raw = str(slug).strip()
    if "_" in raw:
        raw = raw.split("_", 1)[1]
    if raw.isdigit():
        return f"{int(raw):04d}"
    return raw


def _entry_id_matches_raw(entry: dict, raw_slug: str) -> bool:
    clean_id = str(entry.get("clean_id") or "")
    return bool(clean_id) and clean_id == _slug_numeric_id(raw_slug)


def _entry_is_fast_current(
    registry: CleanedBookRegistry,
    entry: dict | None,
    *,
    raw_slug: str,
    output_root: str | Path | None,
) -> tuple[bool, str]:
    if entry is None:
        return False, "not_registered"
    if not _entry_id_matches_raw(entry, raw_slug):
        return False, "id_mismatch"
    return registry.entry_has_clean_output(entry, output_root=output_root)


def _iter_book_candidate_dirs(root: Path, *, max_depth: int = 3) -> list[Path]:
    if not root.is_dir():
        return []
    candidates: list[Path] = []
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        if current != root and _looks_like_book_dir(current):
            candidates.append(current)
            continue
        if depth >= max_depth:
            continue
        try:
            children = sorted(
                child
                for child in current.iterdir()
                if child.is_dir()
                and not child.name.startswith(".")
                and child.name not in {"chapters", "__pycache__"}
            )
        except OSError:
            continue
        stack.extend((child, depth + 1) for child in reversed(children))
    return candidates


def _clean_entry_count_current(
    registry: CleanedBookRegistry,
    entry: dict,
    *,
    expected_count: int,
    output_root: str | Path | None,
) -> bool:
    if expected_count <= 0:
        return False
    last_cleaned = entry.get("last_cleaned") or {}
    try:
        cleaned_count = int(last_cleaned.get("chapter_count") or -1)
    except (TypeError, ValueError):
        cleaned_count = -1
    if cleaned_count != expected_count:
        return False
    output_dir = registry.output_dir_for_entry(entry, output_root=output_root)
    return output_dir.exists() and (output_dir / "index.json").exists()


def _resolve_fast_resume_sources(
    input_path: Path,
    *,
    clean_registry: CleanedBookRegistry,
    output_root: str | Path | None,
) -> tuple[list, list[dict]]:
    raw_to_clean = clean_registry.active_entries_by_raw_slug()
    skipped: list[dict] = []

    def should_skip(path: Path) -> tuple[bool, dict]:
        raw_slug = _raw_slug_from_dir(path)
        entry = raw_to_clean.get(raw_slug)
        is_current, reason = _entry_is_fast_current(
            clean_registry,
            entry,
            raw_slug=raw_slug,
            output_root=output_root,
        )
        if not is_current:
            return False, {"path": str(path), "raw_slug": raw_slug, "reason": reason}
        return True, {
            "path": str(path),
            "raw_slug": raw_slug,
            "clean_slug": entry.get("clean_slug", "") if entry else "",
            "reason": reason,
        }

    if input_path.is_dir() and _looks_like_book_dir(input_path):
        is_current, summary = should_skip(input_path)
        if is_current:
            return [], [summary]
        return resolve_input(input_path), []

    if not input_path.is_dir():
        return resolve_input(input_path), []

    candidate_dirs = _iter_book_candidate_dirs(input_path)
    if not candidate_dirs:
        return resolve_input(input_path), []

    sources = []
    unresolved_paths: list[Path] = []
    for candidate in candidate_dirs:
        is_current, summary = should_skip(candidate)
        if is_current:
            skipped.append(summary)
        else:
            unresolved_paths.append(candidate)

    for path in unresolved_paths:
        try:
            sources.extend(resolve_input(path))
        except FileNotFoundError:
            logger.warning("Skipping empty or unrecognised directory: %s", path)
    return sources, skipped


def _resolve_pending_fetch_sources(
    input_path: Path,
    *,
    fetch_index: str | Path,
    fetch_run_ids: list[str],
    clean_registry: CleanedBookRegistry | None,
    output_root: str | Path | None,
    force: bool,
) -> list:
    run_filter = set(fetch_run_ids or [])
    by_slug: dict[str, Path] = {}
    raw_to_clean = {}
    if clean_registry is not None and not force:
        raw_to_clean = {
            str(entry.get("raw", {}).get("raw_book_slug") or ""): entry
            for entry in clean_registry.active_entries()
        }
    input_root = input_path.resolve() if input_path.exists() else input_path
    for entry in _load_fetch_run_entries(fetch_index):
        if entry.get("status") != "ok":
            continue
        if entry.get("content_type", "book") != "book":
            continue
        if run_filter and entry.get("run_id") not in run_filter:
            continue
        raw_path = entry.get("canonical_path")
        if not raw_path:
            continue
        path = Path(raw_path)
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            continue
        if input_path.exists() and input_path.is_dir() and not _path_is_under(path, input_root):
            continue
        slug = str(entry.get("book_slug") or path.name)
        if clean_registry is not None and not force:
            clean_entry = raw_to_clean.get(slug)
            if clean_entry is not None and _clean_entry_count_current(
                clean_registry,
                clean_entry,
                expected_count=_fetch_entry_chapter_count(entry),
                output_root=output_root,
            ):
                continue
        by_slug[slug] = path

    sources = []
    for slug, path in sorted(by_slug.items()):
        try:
            for source in resolve_input(path):
                if clean_registry is not None and not force:
                    is_current, _, _ = clean_registry.source_is_current(
                        source,
                        source_signature=_source_chapter_marker(source),
                        output_root=output_root,
                    )
                    if is_current:
                        continue
                sources.append(source)
        except Exception as exc:
            logger.warning("Skipping fetched source %s at %s: %s", slug, path, exc)
    return sources


def _resolve_sources(
    input_path: Path,
    args: argparse.Namespace,
    clean_registry: CleanedBookRegistry | None,
) -> tuple[list, list[dict]]:
    if args.pending_fetches:
        return (
            _resolve_pending_fetch_sources(
                input_path,
                fetch_index=args.fetch_index,
                fetch_run_ids=args.fetch_run_id,
                clean_registry=clean_registry,
                output_root=args.output,
                force=args.force,
            ),
            [],
        )
    if (
        clean_registry is not None
        and not args.force
        and not args.clean_registry_replace
        and not args.strict_resume_check
        and not args.stdout
    ):
        return _resolve_fast_resume_sources(
            input_path,
            clean_registry=clean_registry,
            output_root=args.output,
        )
    return resolve_input(input_path), []


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    pretty = not args.compact
    written_dirs: list[Path] = []
    noise_classifier = None
    if args.clean_registry_replace:
        args.use_clean_registry = True
    if args.noise_classifier_model:
        if args.noise_classifier_backend == "vllm":
            noise_classifier = VLLMWeakNoiseClassifier(
                api_base_url=args.noise_classifier_url,
                model_name=args.noise_classifier_model,
                batch_size=args.noise_classifier_batch_size,
                max_new_tokens=args.noise_classifier_max_new_tokens,
                temperature=args.noise_classifier_temperature,
                timeout=args.noise_classifier_timeout,
                max_concurrency=args.noise_classifier_concurrency,
            )
        else:
            noise_classifier = QwenWeakNoiseClassifier(
                args.noise_classifier_model,
                batch_size=args.noise_classifier_batch_size,
                max_new_tokens=args.noise_classifier_max_new_tokens,
                device_map=args.noise_classifier_device_map,
            )
    state = PipelineState() if args.sync_state else None
    clean_registry = (
        CleanedBookRegistry(args.clean_registry_path)
        if args.use_clean_registry
        else None
    )
    sources, fast_skipped = _resolve_sources(input_path, args, clean_registry)
    total_books = len(sources)
    fast_skipped_count = len(fast_skipped)

    if args.stdout and total_books > 1:
        parser.error("--stdout can only be used when the input resolves to a single book.")
    if args.clean_registry_replace:
        if total_books != 1:
            parser.error("--clean-registry-replace can only be used when the input resolves to one book.")

    if fast_skipped_count:
        print(
            f"[FAST-SKIP] {fast_skipped_count} current cleaned book(s) "
            "skipped before source resolution."
        )

    if state is not None:
        state.begin_run("hardmodel", total_candidates=total_books + fast_skipped_count)

    try:
        for source in sources:
            tracking_source = source.source_dir if source.mode == "per_chapter" else source.primary_source
            source_dir_signature = _source_chapter_marker(source)
            if state is not None:
                tracking_signature = source_dir_signature
                book_record, is_new_book = state.get_or_create_book(
                    source_path=tracking_source,
                    source_signature=tracking_signature,
                )
            else:
                tracking_signature = ""
                book_record, is_new_book = None, False
            registry_entry = None
            book_id_override = None
            metadata_overrides = None
            if clean_registry is not None:
                if not args.force and not args.clean_registry_replace:
                    is_current, existing_entry, reason = clean_registry.source_is_current(
                        source,
                        source_signature=source_dir_signature,
                        output_root=args.output,
                    )
                    if is_current:
                        if state is not None and book_record is not None:
                            state.record_step(
                                step_name="hardmodel",
                                book=book_record,
                                source_signature=tracking_signature,
                                status="skipped",
                                output_path=clean_registry.output_dir_for_entry(
                                    existing_entry or {},
                                    output_root=args.output,
                                ),
                                metadata={
                                    "reason": reason,
                                    "book_id": source.book_id,
                                    "chapter_count": len(source.chapters),
                                },
                            )
                            state.increment_run_counter("hardmodel", "skipped")
                            state.save()
                        clean_slug = (existing_entry or {}).get("clean_slug", "")
                        raw_slug = (existing_entry or {}).get("raw", {}).get("raw_book_slug", "")
                        print(
                            f"[SKIP] {source.title} — clean current "
                            f"({reason}, clean={clean_slug}, raw={raw_slug})"
                        )
                        continue
                registry_entry = clean_registry.register_source(
                    source,
                    source_signature=source_dir_signature,
                    output_root=args.output,
                    replace_clean_slug=args.clean_registry_replace or None,
                )
                book_id_override = registry_entry["clean_id"]
                metadata_overrides = clean_registry.metadata_for(registry_entry)

            try:
                book_result = process_book_source(
                    source,
                    output_root=args.output,
                    encoding=args.encoding,
                    chunk_size=args.chunk_size,
                    chunk_overlap=args.chunk_overlap,
                    state=state,
                    noise_classifier=noise_classifier,
                    book_id_override=book_id_override,
                    metadata_overrides=metadata_overrides,
                    source_signature=source_dir_signature,
                    chapter_incremental=args.chapter_incremental,
                )

                if not book_result:
                    if state is not None:
                        state.increment_run_counter("hardmodel", "skipped")
                        state.save()
                    print(f"[SKIP] {source.title} — no new chapters")
                    continue

                if args.stdout:
                    sys.stdout.write(serialize_payload(book_result, pretty=pretty))
                    if pretty:
                        sys.stdout.write("\n")
                    if state is not None and book_record is not None:
                        state.record_step(
                            step_name="hardmodel",
                            book=book_record,
                            source_signature=tracking_signature,
                            status="completed",
                            output_path=None,
                            params={"encoding": args.encoding, "stdout_only": True},
                            metadata={"book_id": source.book_id, "chapter_count": book_result["book_metadata"]["chapter_count"]},
                        )
                        state.increment_run_counter("hardmodel", "processed")
                        state.save()
                    continue

                output_dir = resolve_output_dir(book_result, output_root=args.output)
                if args.materialize_source_chapters:
                    materialized_dir = materialize_source_chapters(source, book_result, pretty=pretty)
                    if materialized_dir is not None:
                        print(f"[SOURCE] {source.title} -> {materialized_dir}")
                write_result_file(output_dir, book_result, pretty=pretty)
                written_dirs.append(output_dir)
                if clean_registry is not None and registry_entry is not None:
                    registry_entry = clean_registry.record_cleaned(
                        registry_entry["clean_slug"],
                        book_metadata=book_result["book_metadata"],
                        output_dir=output_dir,
                        source_signature=source_dir_signature,
                    )

                if state is not None and book_record is not None:
                    state.update_raw_stats(
                        book_record,
                        {"chapter_count": len(source.chapters) if source.chapters else 0},
                    )
                    state.record_step(
                        step_name="hardmodel",
                        book=book_record,
                        source_signature=tracking_signature,
                        status="completed",
                        output_path=output_dir,
                        params={
                            "encoding": args.encoding,
                            "chunk_size": args.chunk_size,
                            "chunk_overlap": args.chunk_overlap,
                            "noise_classifier_backend": args.noise_classifier_backend,
                            "noise_classifier_model": str(args.noise_classifier_model or ""),
                        },
                        metadata=book_result["book_metadata"],
                    )
                    state.increment_run_counter("hardmodel", "processed")
                    state.save()

                registry_note = ""
                if registry_entry is not None:
                    raw_slug = registry_entry.get("raw", {}).get("raw_book_slug", "")
                    registry_note = f", clean={registry_entry['clean_slug']}, raw={raw_slug}"
                print(
                    f"[OK] {source.title} ({source.mode}) -> {output_dir} "
                    f"(index={book_record['index'] if book_record is not None else 'no-state'}, "
                    f"{'new' if is_new_book else 'updated'}, "
                    f"chapters={book_result['book_metadata']['chapter_count']}, "
                    f"chars={book_result['book_metadata']['total_chars']}"
                    f"{registry_note})"
                )
            except Exception as exc:
                if state is not None and book_record is not None:
                    state.record_step(
                        step_name="hardmodel",
                        book=book_record,
                        source_signature=tracking_signature,
                        status="failed",
                        output_path=None,
                        error=str(exc),
                    )
                    state.increment_run_counter("hardmodel", "failed")
                    state.save()
                logger.exception("Failed to process book: %s", source.title)
                print(f"[FAIL] {source.title}: {exc}", file=sys.stderr)
    finally:
        if state is not None:
            state.finish_run("hardmodel")

    if not args.stdout:
        run_stats = state.run_stats("hardmodel") if state is not None else {}
        print(
            f"Finished. Wrote {len(written_dirs)} book folder(s). "
            f"processed={run_stats.get('processed', 0)} "
            f"skipped={run_stats.get('skipped', 0)} "
            f"fast_skipped={fast_skipped_count} "
            f"failed={run_stats.get('failed', 0)} "
            f"tracker={state.path if state is not None else 'disabled'}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
