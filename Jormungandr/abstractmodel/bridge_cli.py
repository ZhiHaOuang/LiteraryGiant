from __future__ import annotations

import argparse
import json
from pathlib import Path

from shared import ABSTRACT_LIBRARY_ROOT, BRIDGE_NOVELS_PLOT_ROOT, LIBRARY_ROOT, canonical_book_slug

from .bridge_llm import BridgeLLMClient, BridgeLLMConfig
from .bridge_pipeline import run_bridge_first_book, validated_decisions
from .loader import discover_plot_books
from .materializer import materialize_abstract_library
from .pattern_store import commit_validated_decisions, read_jsonl
from .run_cache import compact_completed_book_cache
from .semantic_compaction import compact_emerging_patterns
from .schemas import AUTOMATED_PATTERN_LIBRARIES, canonical_library_name


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="abstractmodel-run",
        description="Incremental Bridge-first LLM abstraction with strict pattern reconciliation.",
    )
    parser.add_argument("input", nargs="?", default=str(BRIDGE_NOVELS_PLOT_ROOT))
    parser.add_argument("--book", action="append", default=[], help="Canonical idNNNNNN content ID.")
    parser.add_argument("--library", action="append", default=[])
    parser.add_argument("--bridge-index-root", default=str(LIBRARY_ROOT / "BridgeIndex"))
    parser.add_argument("--extracted-root", default=str(LIBRARY_ROOT / "LLMExtracted"))
    parser.add_argument("--abstract-library-root", default=str(ABSTRACT_LIBRARY_ROOT))
    parser.add_argument("--mode", choices=["prepare", "extract", "reconcile", "all"], default="prepare")
    parser.add_argument("--provider", choices=["off", "deepseek", "mimo", "custom"], default="off")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--api-base-url", default="")
    parser.add_argument("--api-model", default="")
    parser.add_argument("--api-protocol", choices=["anthropic", "openai"], default="anthropic")
    parser.add_argument("--api-timeout", type=float, default=180.0)
    parser.add_argument("--api-retries", type=int, default=2)
    parser.add_argument("--api-max-tokens", type=int, default=6144)
    parser.add_argument("--plots-per-window", type=int, default=1)
    parser.add_argument("--overlap", type=int, default=0)
    parser.add_argument("--max-windows", type=int, default=0)
    parser.add_argument("--shortlist-size", type=int, default=6)
    parser.add_argument(
        "--candidate-budget",
        type=int,
        default=1,
        help="Maximum candidates in one response page; this does not cap the final library size.",
    )
    parser.add_argument("--reconcile-batch-size", type=int, default=6)
    parser.add_argument("--max-in-flight", type=int, default=1, help="Concurrent extraction API requests; keep small for provider stability.")
    parser.add_argument(
        "--extraction-layout",
        choices=["joint", "paired", "per-library"],
        default="paired",
        help="paired keeps event/payoff and arc/rhythm in separate calls; joint is lowest-call; per-library is most isolated.",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--no-materialize",
        action="store_true",
        help="Do not refresh pattern-first folders and indexes after a successful commit.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Apply validated merge/enrich/new decisions to emerging_patterns.jsonl. Never promotes universal patterns.",
    )
    parser.add_argument(
        "--semantic-compact",
        action="store_true",
        help="Use the selected LLM to merge mechanism-equivalent emerging patterns after commit; preserves all instances and evidence.",
    )
    parser.add_argument(
        "--keep-raw-run-cache",
        action="store_true",
        help="Keep raw provider responses and derivable task files after a successful commit.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    books = _selected_books(discover_plot_books(args.input), args.book)
    libraries = _libraries(args.library)
    config = BridgeLLMConfig.resolved(
        provider=args.provider,
        api_key=args.api_key,
        base_url=args.api_base_url,
        model=args.api_model,
        api_protocol=args.api_protocol,
        max_tokens=args.api_max_tokens,
        timeout=args.api_timeout,
        retries=args.api_retries,
    )
    if args.candidate_budget < 1:
        raise ValueError("--candidate-budget must be at least 1")
    if args.reconcile_batch_size < 1:
        raise ValueError("--reconcile-batch-size must be at least 1")
    if args.max_in_flight < 1:
        raise ValueError("--max-in-flight must be at least 1")
    if args.mode != "prepare" and config.provider == "off":
        raise ValueError("--mode extract/reconcile/all requires a non-off --provider")
    if args.semantic_compact and args.mode not in {"reconcile", "all"}:
        raise ValueError("--semantic-compact requires --mode reconcile or all")
    client = BridgeLLMClient(config) if args.mode != "prepare" else None
    manifests: list[dict] = []
    for book_dir in books:
        book_slug = book_dir.name
        manifest_path = Path(args.extracted_root) / book_slug / "manifest.json"
        if manifest_path.exists() and not args.force:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            try:
                existing_book_id = canonical_book_slug(existing.get("book_id", ""))
            except ValueError:
                existing_book_id = ""
            already_complete = bool(existing.get("complete_book"))
            covered_libraries = set(existing.get("libraries") or [])
            requested_libraries = set(libraries)
            already_committed = bool(existing.get("committed"))
            if (
                existing_book_id == book_slug
                and existing.get("mode") == args.mode
                and requested_libraries.issubset(covered_libraries)
                and already_complete
                and (not args.commit or already_committed)
                and not args.semantic_compact
            ):
                print(f"[SKIP] {book_slug}: same book-id and mode already completed")
                continue
        manifest = run_bridge_first_book(
            book_dir,
            bridge_index_root=args.bridge_index_root,
            extracted_root=args.extracted_root,
            abstract_library_root=args.abstract_library_root,
            libraries=libraries,
            client=client,
            mode=args.mode,
            plots_per_window=args.plots_per_window,
            overlap=args.overlap,
            max_windows=args.max_windows,
            shortlist_size=args.shortlist_size,
            candidate_budget=args.candidate_budget,
            reconcile_batch_size=args.reconcile_batch_size,
            extraction_layout=args.extraction_layout,
            force=args.force,
            max_in_flight=args.max_in_flight,
        )
        manifests.append(manifest)
        changed_library = False
        if args.commit:
            if args.mode not in {"reconcile", "all"}:
                raise ValueError("--commit requires --mode reconcile or all")
            reconciliation_path = Path(args.extracted_root) / book_slug / "reconciliations.jsonl"
            decisions = [
                row
                for row in validated_decisions(read_jsonl(reconciliation_path))
                if str(row.get("library") or "") in libraries
            ]
            commit_counts = commit_validated_decisions(
                decisions,
                abstract_library_root=args.abstract_library_root,
                book_id=manifest["book_id"],
            )
            manifest["commit_counts"] = commit_counts
            manifest["committed"] = True
            changed_library = True
        if args.semantic_compact:
            if client is None:
                raise ValueError("--semantic-compact requires an LLM client")
            manifest["semantic_compaction"] = compact_emerging_patterns(
                abstract_library_root=args.abstract_library_root,
                client=client,
                libraries=libraries,
            )
            changed_library = True
        if changed_library and not args.no_materialize:
            manifest["materialize"] = materialize_abstract_library(
                source_root=args.abstract_library_root,
                output_root=args.abstract_library_root,
            )
        if changed_library and manifest.get("complete_book") and manifest.get("committed") and not args.keep_raw_run_cache:
            manifest["cache_compaction"] = compact_completed_book_cache(
                Path(args.extracted_root) / book_slug
            )
        if changed_library:
            _write_manifest(manifest_path, manifest)
        _append_run_history(Path(args.extracted_root) / book_slug / "run_history.jsonl", manifest)
        print(
            f"[OK] {book_slug}: plots={manifest['plot_count']} windows={manifest['window_count']} "
            f"tasks={manifest['scheduled_task_count']} "
            f"candidates={manifest['candidate_count']} decisions={manifest['decision_counts']}"
        )
    print(
        f"Finished bridge-first abstractmodel. books={len(manifests)} mode={args.mode} "
        f"provider={config.provider} commit={args.commit}"
    )
    return 0


def _selected_books(books: list[Path], values: list[str]) -> list[Path]:
    if not values:
        return books
    requested = {canonical_book_slug(value) for value in values}
    return [book for book in books if book.name in requested]


def _libraries(values: list[str]) -> list[str]:
    if not values:
        return list(AUTOMATED_PATTERN_LIBRARIES)
    result: list[str] = []
    for value in values:
        library = canonical_library_name(value)
        if library not in AUTOMATED_PATTERN_LIBRARIES:
            raise ValueError(f"Unsupported library: {value}")
        if library not in result:
            result.append(library)
    return result


def _write_manifest(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _append_run_history(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    rows.append(dict(payload))
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
