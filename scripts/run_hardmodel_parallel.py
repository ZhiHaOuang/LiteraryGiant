"""Parallel, resumable raw-to-cleaned hardmodel runner for the unified corpus."""

from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from typing import Any

from Jormungandr.hardmodel.llm_noise_classifier import VLLMWeakNoiseClassifier
from Jormungandr.hardmodel.manifest_writer import (
    resolve_output_dir,
    write_result_file,
)
from Jormungandr.hardmodel.processor import process_book_source
from Jormungandr.hardmodel.source_resolver import resolve_input
from Jormungandr.hardmodel.validator import validate_written_book_dir


_CONFIG: dict[str, Any] = {}
_CLASSIFIER: VLLMWeakNoiseClassifier | None = None
_LIVE_CLEANED_ROOT = Path("Library/TaciturnRaw/02_CleanedData")
_RAW_PROVENANCE_KEYS = (
    "layout_version",
    "canonical_id",
    "content_id",
    "edition_id",
    "normalized_sha256",
    "work_id",
    "category_code",
    "version_label",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def discover_books(raw_root: Path) -> list[Path]:
    """Read the frozen raw catalogue before falling back to metadata-heavy scan.

    On the remote filesystem, calling ``stat`` on each of 276k directories is
    materially slower than reading the already-published ``总目录.txt`` once.
    The catalogue is written by the raw cutover and therefore represents the
    same final ID set as the directory tree.
    """
    catalogue = raw_root / "总目录.txt"
    if catalogue.is_file():
        category: str | None = None
        books: list[Path] = []
        category_pattern = re.compile(r"\[(?P<category>\d{2}_[^\]]+)\]")
        book_pattern = re.compile(r"(?P<code>\d{2})_(?P<content_id>id\d{6})(?:_|\.txt\b)")
        with catalogue.open("r", encoding="utf-8") as handle:
            for line in handle:
                category_match = category_pattern.search(line)
                if category_match:
                    category = category_match.group("category")
                    continue
                book_match = book_pattern.search(line)
                if book_match:
                    if category is None or not category.startswith(book_match.group("code") + "_"):
                        raise ValueError(f"Malformed raw catalogue line: {line.rstrip()!r}")
                    books.append(raw_root / category / book_match.group("content_id"))
        if books:
            books.sort(key=lambda item: item.name)
            seen = {book.name for book in books}
            if len(seen) != len(books):
                raise ValueError("Duplicate canonical raw ID in 总目录.txt")
            return books

    books: list[Path] = []
    for category in sorted(raw_root.iterdir(), key=lambda item: item.name):
        if not category.is_dir() or category.name.startswith("_"):
            continue
        for candidate in category.iterdir():
            if (
                candidate.is_dir()
                and candidate.name.startswith("id")
                and (candidate / "source.txt").is_file()
                and (candidate / "index.json").is_file()
            ):
                books.append(candidate)
    books.sort(key=lambda item: item.name)
    seen: set[str] = set()
    for book in books:
        if book.name in seen:
            raise ValueError(f"Duplicate canonical raw ID: {book.name}")
        seen.add(book.name)
    return books


def _load_completed(path: Path) -> set[str]:
    completed: set[str] = set()
    if not path.exists():
        return completed
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("status") in {"written", "preexisting"} and row.get("content_id"):
                completed.add(str(row["content_id"]))
    return completed


def _load_mapping_gate(
    path: Path,
    *,
    raw_root: Path,
) -> tuple[dict[str, Any], str]:
    """Load a signed-off mapping gate before any canonical full run.

    A raw directory merely named ``idNNNNNN`` is not enough evidence that the
    legacy-to-canonical transition is complete.  The gate is emitted only by
    the ID-lineage validation phase and records the frozen raw root it covers.
    """

    try:
        raw_bytes = path.read_bytes()
        payload = json.loads(raw_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid --mapping-manifest: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Mapping manifest must be a JSON object: {path}")
    if payload.get("status") != "ready_for_hardmodel":
        raise ValueError(
            "Mapping manifest is not approved for hardmodel; expected "
            "status=ready_for_hardmodel"
        )
    manifest_raw_root = str(payload.get("raw_root") or "").strip()
    if manifest_raw_root and Path(manifest_raw_root).resolve() != raw_root:
        raise ValueError(
            "Mapping manifest raw_root does not match --raw-root: "
            f"{manifest_raw_root!r} != {str(raw_root)!r}"
        )
    return payload, hashlib.sha256(raw_bytes).hexdigest()


def _raw_provenance(raw_path: Path, content_id: str) -> dict[str, Any]:
    """Read the frozen raw identity fields that make a cleaned result reusable."""

    index_path = raw_path / "index.json"
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Raw index must be an object: {index_path}")
    canonical_id = str(payload.get("canonical_id") or payload.get("content_id") or "")
    if canonical_id != content_id or str(payload.get("content_id") or "") != content_id:
        raise ValueError(
            f"Raw index identity mismatch for {raw_path}: "
            f"canonical_id={canonical_id!r}, content_id={payload.get('content_id')!r}"
        )
    # ``version_label`` is intentionally empty for the preferred first
    # edition; every other provenance field is required to be non-empty.
    missing = [
        key
        for key in _RAW_PROVENANCE_KEYS
        if key not in payload or (key != "version_label" and not payload.get(key))
    ]
    if missing:
        raise ValueError(f"Raw index lacks provenance fields for {content_id}: {missing}")
    return {key: payload[key] for key in _RAW_PROVENANCE_KEYS}


def _existing_output_matches_provenance(target: Path, expected: dict[str, Any]) -> bool:
    payload = json.loads((target / "index.json").read_text(encoding="utf-8"))
    metadata = payload.get("book_metadata")
    if not isinstance(metadata, dict):
        return False
    return metadata.get("canonical_raw_provenance") == expected


def _init_worker(config: dict[str, Any]) -> None:
    global _CONFIG, _CLASSIFIER
    _CONFIG = config
    _CLASSIFIER = None
    if config.get("model"):
        _CLASSIFIER = VLLMWeakNoiseClassifier(
            api_base_url=config["base_url"],
            model_name=config["model"],
            batch_size=config["batch_size"],
            max_new_tokens=config["max_new_tokens"],
            temperature=0.0,
            timeout=config["timeout"],
            max_concurrency=config["llm_concurrency"],
            max_batch_characters=config["max_batch_characters"],
        )


def _process_one(raw_dir: str) -> dict[str, Any]:
    started = time.monotonic()
    raw_path = Path(raw_dir)
    content_id = raw_path.name
    output_root = Path(_CONFIG["output_root"])
    staging_root = output_root / ".hardmodel_staging"
    staged = staging_root / content_id
    target = output_root / content_id
    try:
        raw_provenance = _raw_provenance(raw_path, content_id)
        raw_provenance["mapping_manifest_sha256"] = _CONFIG.get(
            "mapping_manifest_sha256", ""
        )
        if target.exists():
            validate_written_book_dir(target)
            payload = json.loads((target / "index.json").read_text(encoding="utf-8"))
            actual_id = str(payload.get("book_metadata", {}).get("book_id") or "")
            if actual_id != content_id:
                raise ValueError(f"existing output ID mismatch: {actual_id!r}")
            if not _existing_output_matches_provenance(target, raw_provenance):
                raise ValueError(
                    "existing output raw provenance does not match; use a fresh "
                    "canonical cleaned staging root instead of reusing this directory"
                )
            return {
                "content_id": content_id,
                "status": "preexisting",
                "elapsed_seconds": round(time.monotonic() - started, 3),
            }

        # A killed worker can leave its atomic staging directory behind.  It
        # is never a reusable result: only the final target has passed the
        # provenance and directory checks.  Remove it before retrying the same
        # canonical ID.
        if staged.exists():
            shutil.rmtree(staged)
        sources = resolve_input(raw_path)
        if len(sources) != 1 or sources[0].book_id != content_id:
            raise ValueError(
                f"raw source identity mismatch: expected {content_id}, "
                f"got {[source.book_id for source in sources]}"
            )
        result = process_book_source(
            sources[0],
            output_root=staging_root,
            noise_classifier=_CLASSIFIER,
            noise_classifier_min_windows=_CONFIG["llm_min_windows"],
            metadata_overrides={"canonical_raw_provenance": raw_provenance},
        )
        output_dir = resolve_output_dir(result, output_root=staging_root)
        if output_dir != staged:
            raise ValueError(f"unexpected staging output: {output_dir}")
        metadata = result["book_metadata"]
        classifier_failures = int(
            metadata.get("cleaning_stats", {}).get("weak_classifier_failures") or 0
        )
        if _CONFIG.get("model") and classifier_failures:
            # The cleaner deliberately keeps text when its optional classifier
            # is unavailable.  That is appropriate for interactive use, but a
            # canonical full run must retry instead of publishing an
            # incompletely classified book as final.
            raise RuntimeError(
                "weak-noise classifier failed; refusing canonical publish so "
                "the resumable runner can retry this book"
            )
        write_result_file(output_dir, result, pretty=False)
        os.rename(output_dir, target)
        return {
            "content_id": content_id,
            "status": "written",
            "chapters": int(metadata.get("chapter_count") or 0),
            "characters": int(metadata.get("total_chars") or 0),
            "llm_calls": int(metadata.get("cleaning_stats", {}).get("weak_classifier_calls") or 0),
            "llm_failures": int(metadata.get("cleaning_stats", {}).get("weak_classifier_failures") or 0),
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    except Exception as exc:
        if staged.exists():
            shutil.rmtree(staged, ignore_errors=True)
        return {
            "content_id": content_id,
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-root", default="Library/TaciturnRaw/01_RawData")
    parser.add_argument("--output-root", default="Library/TaciturnRaw/02_CleanedData")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument(
        "--mapping-manifest",
        help=(
            "Approved canonical-ID mapping gate with "
            "status=ready_for_hardmodel. Required unless explicitly bypassed "
            "for a disposable smoke test."
        ),
    )
    parser.add_argument(
        "--allow-unverified-mapping",
        action="store_true",
        help="Allow only a disposable smoke run without an approved mapping manifest.",
    )
    parser.add_argument(
        "--allow-live-output",
        action="store_true",
        help=(
            "Permit writing into Library/TaciturnRaw/02_CleanedData. Canonical "
            "full runs should normally target an independent staging root."
        ),
    )
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 8) - 8))
    parser.add_argument("--model", default="novel-metadata")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument(
        "--max-batch-characters",
        type=int,
        default=12_000,
        help=(
            "Approximate serialized character budget per vLLM request; "
            "prevents fixed-size batches from overflowing the model context."
        ),
    )
    parser.add_argument("--max-new-tokens", type=int, default=384)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--llm-concurrency", type=int, default=1)
    parser.add_argument(
        "--llm-min-windows",
        type=int,
        default=1,
        help="Use Qwen only when a book has at least this many weak-noise windows.",
    )
    parser.add_argument(
        "--minimum-free-gib",
        type=float,
        default=256.0,
        help="Pause scheduling before the output filesystem drops below this free-space reserve.",
    )
    parser.add_argument(
        "--content-id",
        action="append",
        default=[],
        help="Run only a canonical idNNNNNN; repeatable and useful for audited retries.",
    )
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    if args.workers < 1:
        parser.error("--workers must be positive")
    if args.minimum_free_gib < 0:
        parser.error("--minimum-free-gib cannot be negative")
    if args.llm_min_windows < 1:
        parser.error("--llm-min-windows must be positive")
    if args.max_batch_characters < 1_000:
        parser.error("--max-batch-characters must be at least 1000")
    raw_root = Path(args.raw_root).resolve()
    output_root = Path(args.output_root).resolve()
    run_dir = Path(args.run_dir).resolve()
    live_cleaned_root = _LIVE_CLEANED_ROOT.resolve()
    if output_root == live_cleaned_root and not args.allow_live_output:
        parser.error(
            "Refusing to write a hardmodel run into the live cleaned root; use an "
            "independent --output-root or pass --allow-live-output after cutover approval"
        )
    mapping_manifest: dict[str, Any] | None = None
    mapping_manifest_sha256 = ""
    if args.mapping_manifest:
        try:
            mapping_manifest, mapping_manifest_sha256 = _load_mapping_gate(
                Path(args.mapping_manifest).resolve(), raw_root=raw_root
            )
        except ValueError as exc:
            parser.error(str(exc))
    elif not args.allow_unverified_mapping:
        parser.error(
            "--mapping-manifest is required before a canonical hardmodel run; "
            "use --allow-unverified-mapping only for disposable smoke tests"
        )
    run_dir.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    minimum_free_bytes = int(args.minimum_free_gib * 1024**3)
    if shutil.disk_usage(output_root).free < minimum_free_bytes:
        parser.error("output filesystem is below --minimum-free-gib before start")
    completed_path = run_dir / "completed.jsonl"
    completed = _load_completed(completed_path)

    discovered = discover_books(raw_root)
    requested_ids = set(args.content_id)
    if requested_ids:
        by_id = {path.name: path for path in discovered}
        missing = sorted(requested_ids - set(by_id))
        if missing:
            parser.error(f"Unknown canonical IDs: {', '.join(missing[:10])}")
        pending = [by_id[content_id] for content_id in sorted(requested_ids)]
    else:
        pending = [path for path in discovered if path.name not in completed]
    if args.limit is not None:
        pending = pending[: max(0, args.limit)]
    started_at = _utc_now()
    counters = {"written": 0, "preexisting": 0, "failed": 0}
    total_chapters = total_characters = llm_calls = llm_failures = 0
    config = {
        "output_root": str(output_root),
        "mapping_manifest_sha256": mapping_manifest_sha256,
        "model": args.model,
        "llm_min_windows": args.llm_min_windows,
        "base_url": args.base_url,
        "batch_size": args.batch_size,
        "max_batch_characters": args.max_batch_characters,
        "max_new_tokens": args.max_new_tokens,
        "timeout": args.timeout,
        "llm_concurrency": args.llm_concurrency,
    }
    summary = {
        "started_at": started_at,
        "status": "running",
        "raw_root": str(raw_root),
        "output_root": str(output_root),
        "discovered": len(discovered),
        "already_completed": len(completed),
        "scheduled": len(pending),
        "workers": args.workers,
        "minimum_free_gib": args.minimum_free_gib,
        "model": args.model,
        "batch_size": args.batch_size,
        "max_batch_characters": args.max_batch_characters,
        "max_new_tokens": args.max_new_tokens,
        "llm_concurrency": args.llm_concurrency,
        "mapping_manifest": str(Path(args.mapping_manifest).resolve())
        if args.mapping_manifest
        else None,
        "mapping_manifest_sha256": mapping_manifest_sha256 or None,
        "mapping_status": mapping_manifest.get("status") if mapping_manifest else "unverified_smoke",
        "counters": counters,
    }
    _atomic_json(run_dir / "summary.json", summary)

    max_in_flight = max(args.workers * 3, args.workers)
    iterator = iter(pending)
    in_flight: dict[Any, Path] = {}
    last_summary = time.monotonic()
    paused_low_space = False

    def has_space_reserve() -> bool:
        return shutil.disk_usage(output_root).free >= minimum_free_bytes

    with completed_path.open("a", encoding="utf-8", buffering=1) as journal:
        with ProcessPoolExecutor(
            max_workers=args.workers,
            initializer=_init_worker,
            initargs=(config,),
        ) as executor:
            while len(in_flight) < max_in_flight:
                if not has_space_reserve():
                    paused_low_space = True
                    break
                try:
                    path = next(iterator)
                except StopIteration:
                    break
                in_flight[executor.submit(_process_one, str(path))] = path

            while in_flight:
                done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in done:
                    path = in_flight.pop(future)
                    try:
                        row = future.result()
                    except Exception as exc:
                        row = {
                            "content_id": path.name,
                            "status": "failed",
                            "error": f"worker_crash: {type(exc).__name__}: {exc}",
                        }
                    row["recorded_at"] = _utc_now()
                    journal.write(json.dumps(row, ensure_ascii=False) + "\n")
                    status = str(row.get("status") or "failed")
                    counters[status if status in counters else "failed"] += 1
                    total_chapters += int(row.get("chapters") or 0)
                    total_characters += int(row.get("characters") or 0)
                    llm_calls += int(row.get("llm_calls") or 0)
                    llm_failures += int(row.get("llm_failures") or 0)
                    try:
                        next_path = next(iterator)
                    except StopIteration:
                        next_path = None
                    if next_path is not None and has_space_reserve():
                        in_flight[executor.submit(_process_one, str(next_path))] = next_path
                    elif next_path is not None:
                        paused_low_space = True

                if time.monotonic() - last_summary >= 15 or not in_flight:
                    finished = sum(counters.values())
                    summary.update(
                        {
                            "updated_at": _utc_now(),
                            "finished": finished,
                            "remaining": max(0, len(pending) - finished),
                            "counters": dict(counters),
                            "chapters": total_chapters,
                            "characters": total_characters,
                            "llm_calls": llm_calls,
                            "llm_failures": llm_failures,
                            "free_gib": round(shutil.disk_usage(output_root).free / 1024**3, 2),
                            "paused_low_space": paused_low_space,
                        }
                    )
                    _atomic_json(run_dir / "summary.json", summary)
                    print(json.dumps(summary, ensure_ascii=False), flush=True)
                    last_summary = time.monotonic()

    summary.update(
        {
            "finished_at": _utc_now(),
            "status": (
                "paused_low_space"
                if paused_low_space
                else "complete"
                if counters["failed"] == 0
                else "complete_with_failures"
            ),
            "finished": sum(counters.values()),
            "remaining": max(0, len(pending) - sum(counters.values())),
            "free_gib": round(shutil.disk_usage(output_root).free / 1024**3, 2),
            "paused_low_space": paused_low_space,
        }
    )
    _atomic_json(run_dir / "summary.json", summary)
    if paused_low_space:
        return 3
    return 0 if counters["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
