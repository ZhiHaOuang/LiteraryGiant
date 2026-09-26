#!/usr/bin/env python3
"""CLI for inventorying and organizing the transferred local TXT corpus.

The command defaults to dry, non-mutating phases.  ``apply`` is the only phase
that writes corpus files, and it requires an explicit transfer-complete flag.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetcher.local_archive import (
    CATALOG_RELATIVE_PATH,
    DedupeThresholds,
    apply_plan,
    default_archive_root,
    enrich_low_confidence_metadata,
    plan_catalog,
    revalidate_quarantined_literals,
    scan_sources,
    snapshot_sources,
    source_snapshot_from_dict,
    verify_plan,
)
from fetcher.local_catalog import LocalNovelCatalog
from fetcher.local_resources import available_cpu_count
from shared.constants import PROJECT_ROOT


DEFAULT_SOURCE_BASE = Path("/public/home/actueuo6co")
KNOWN_SOURCE_NAMES = (
    "txt",
    "其他",
    "其它",
    "晋江",
    "武侠修真",
    "玄幻魔法",
    "科幻小说",
    "网游竞技",
    "笔趣阁全站网络小说合集 31w本",
    "小说合集2",
)


def _known_sources(base: Path = DEFAULT_SOURCE_BASE) -> list[Path]:
    selected = [base / name for name in KNOWN_SOURCE_NAMES if (base / name).is_dir()]
    selected_set = {path.resolve() for path in selected}
    # Transfers can add new Chinese-named corpus roots while this tool is
    # being developed.  Include such top-level directories automatically,
    # while excluding unrelated Latin-named projects and hidden folders.
    if base.is_dir():
        for candidate in sorted(base.iterdir(), key=lambda path: path.name):
            if (
                candidate.is_dir()
                and candidate.resolve() not in selected_set
                and re.search(r"[\u3400-\u9fff]", candidate.name)
            ):
                selected.append(candidate)
                selected_set.add(candidate.resolve())
    return selected


def _sources(args: argparse.Namespace) -> list[Path]:
    selected = [Path(value).expanduser().resolve() for value in (args.source or [])]
    if selected:
        return selected
    source_base = Path(args.source_base or DEFAULT_SOURCE_BASE).expanduser().resolve()
    discovered = _known_sources(source_base)
    if not discovered:
        raise RuntimeError("No known source roots exist; pass --source DIR explicitly")
    return discovered


def _archive_root(args: argparse.Namespace) -> Path:
    return Path(args.archive_root).expanduser().resolve()


def _catalog(args: argparse.Namespace) -> LocalNovelCatalog:
    path = (
        Path(args.catalog_path).expanduser().resolve()
        if args.catalog_path
        else _archive_root(args) / CATALOG_RELATIVE_PATH
    )
    return LocalNovelCatalog(path)


def _print_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="novel-organize",
        description=(
            "Inventory, deduplicate, classify and safely organize messy local TXT novels "
            "under Library/Noise. No source mutation occurs before apply."
        ),
    )
    parser.add_argument(
        "--archive-root",
        default=str(default_archive_root(PROJECT_ROOT)),
        help="Isolated archive root. Default: PROJECT_ROOT/Library/Noise",
    )
    parser.add_argument(
        "--catalog-path",
        help=(
            "Optional SQLite working catalog path. Put this on local scratch for "
            "large scans, then make a consistent backup to Library/Noise at phase boundaries."
        ),
    )
    parser.add_argument(
        "--source-base",
        default=None,
        help=(
            "Base used for known Chinese source folders when --source is omitted "
            f"(default: {DEFAULT_SOURCE_BASE}); valid only for snapshot/scan."
        ),
    )
    parser.add_argument(
        "--source",
        action="append",
        help="Source root; repeat for multiple roots. Defaults to known folders under --source-base.",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser(
        "snapshot",
        help="Record path/size/mtime stability metadata; reads no novel contents.",
    )
    snapshot.add_argument("--output", help="Snapshot JSON path; defaults under Library/Noise/.state/runs.")

    scan = subparsers.add_parser(
        "scan",
        help="Recursively fingerprint each TXT as one book candidate; source files stay untouched.",
    )
    scan.add_argument("--workers", type=int, default=available_cpu_count())
    scan.add_argument("--stable-age-seconds", type=float, default=600.0)
    scan.add_argument("--limit", type=_positive_int)
    scan.add_argument("--force", action="store_true")
    scan.add_argument("--run-id")

    revalidate = subparsers.add_parser(
        "revalidate-quarantine",
        help=(
            "Strictly recheck legacy replacement-bearing ok/quarantine rows; "
            "defaults to a catalog-only dry run."
        ),
    )
    revalidate.add_argument(
        "--max-literal-replacement-rate", type=float, default=0.0002
    )
    revalidate.add_argument("--workers", type=_positive_int, default=available_cpu_count())
    revalidate.add_argument("--limit", type=_positive_int)
    revalidate.add_argument("--run-id")
    revalidate.add_argument(
        "--apply",
        action="store_true",
        help="Persist audited promotions/demotions; source TXT files remain untouched.",
    )

    plan = subparsers.add_parser(
        "plan",
        help="Build content-first work/edition groups and a review queue; no files move.",
    )
    plan.add_argument("--run-id")
    plan.add_argument("--minimum-fuzzy-chars", type=int, default=50_000)
    plan.add_argument("--same-edition-containment", type=float, default=0.96)
    plan.add_argument("--same-work-containment", type=float, default=0.92)
    plan.add_argument(
        "--draft",
        action="store_true",
        help="Build representatives for LLM review without allocating permanent IDs.",
    )
    plan.add_argument(
        "--max-candidate-pair-rows",
        type=int,
        default=25_000_000,
        help="Fail before the near-candidate join exceeds this posting-pair budget.",
    )
    plan.add_argument(
        "--delete-high-confidence-incomplete",
        action="store_true",
        help=(
            "Opt in to planning very high-confidence truncated versions as source "
            "duplicates. Without this flag they remain _v2/_v3 editions and are "
            "listed in review.jsonl. Actual deletion still requires apply --transfer-mode move."
        ),
    )

    enrich = subparsers.add_parser(
        "enrich-metadata",
        help="Use an optional local OpenAI-compatible vLLM only for low-confidence metadata.",
    )
    enrich.add_argument("--model", required=True, help="Served vLLM model name.")
    enrich.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    enrich.add_argument("--api-key", default=None)
    enrich.add_argument("--title-confidence-below", type=float, default=0.80)
    enrich.add_argument("--genre-confidence-below", type=float, default=0.55)
    enrich.add_argument("--accept-confidence", type=float, default=0.72)
    enrich.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Concurrent vLLM requests (vLLM performs continuous batching).",
    )
    enrich.add_argument(
        "--items-per-request",
        type=int,
        default=2,
        help="Books packed into each bounded JSON request (default: 2).",
    )
    enrich.add_argument(
        "--candidate-mode",
        choices=("difficult", "confidence", "sanity"),
        default="difficult",
        help=(
            "Select genuine hard cases, the legacy confidence filter, or only "
            "obviously polluted locked fields."
        ),
    )
    enrich.add_argument(
        "--representative-plan-run-id",
        help="Only enrich canonical/edition representatives retained by this initial plan.",
    )
    enrich.add_argument(
        "--candidate-sample-seed",
        type=int,
        help="Deterministically spread a limited smoke sample across the corpus.",
    )
    enrich.add_argument("--limit", type=_positive_int)
    enrich.add_argument("--run-id")

    apply = subparsers.add_parser(
        "apply",
        help="Apply a completed plan. Explicit confirmation is mandatory.",
    )
    apply.add_argument("--plan-run-id")
    apply.add_argument("--transfer-mode", choices=("copy", "move"), default="copy")
    apply.add_argument(
        "--confirm-transfer-complete",
        action="store_true",
        help="Required even for copy smoke tests; records an intentional state change.",
    )
    apply.add_argument(
        "--stability-snapshot",
        help="Required for move: a saved snapshot that must still exactly match the source tree.",
    )
    apply.add_argument("--limit", type=_positive_int)
    apply.add_argument(
        "--workers",
        type=_positive_int,
        default=available_cpu_count(),
        help="Parallel UTF-8 publishers; metadata/journal commits remain serialized.",
    )
    apply.add_argument(
        "--raw-only",
        action="store_true",
        help="Deprecated compatibility flag; the flat layout always stores one selected original.",
    )
    apply.add_argument(
        "--preserve-existing-processed",
        action="store_true",
        help=(
            "Move raw inputs but retain source_kind=existing_processed files as a "
            "verified provenance copy. Valid only with --transfer-mode move."
        ),
    )

    verify = subparsers.add_parser("verify", help="Re-hash applied originals and UTF-8 editions.")
    verify.add_argument("--plan-run-id")
    verify.add_argument("--limit", type=_positive_int)
    verify.add_argument("--run-id")
    verify.add_argument(
        "--workers",
        type=_positive_int,
        default=available_cpu_count(),
        help="Parallel destination hash verifiers (default: detected CPU quota).",
    )

    subparsers.add_parser("report", help="Print catalog counts, bytes, genres and plan actions.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command not in {"snapshot", "scan"} and (args.source or args.source_base):
        parser.error("--source/--source-base are valid only for snapshot and scan")
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    archive_root = _archive_root(args)

    try:
        if args.command == "snapshot":
            payload = snapshot_sources(_sources(args))
            output = (
                Path(args.output).expanduser().resolve()
                if args.output
                else archive_root
                / ".state"
                / "runs"
                / f"source-snapshot-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(payload.to_dict(), ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            _print_json({**payload.to_dict(), "snapshot_path": str(output)})
            return 0

        with _catalog(args) as catalog:
            if args.command == "scan":
                result = scan_sources(
                    catalog,
                    _sources(args),
                    archive_root=archive_root,
                    workers=max(1, args.workers),
                    stable_age_seconds=max(0.0, args.stable_age_seconds),
                    limit=args.limit,
                    force=args.force,
                    run_id=args.run_id,
                )
            elif args.command == "revalidate-quarantine":
                result = revalidate_quarantined_literals(
                    catalog,
                    archive_root,
                    max_literal_replacement_rate=args.max_literal_replacement_rate,
                    workers=args.workers,
                    run_id=args.run_id,
                    apply_changes=args.apply,
                    limit=args.limit,
                )
            elif args.command == "enrich-metadata":
                result = enrich_low_confidence_metadata(
                    catalog,
                    archive_root,
                    model=args.model,
                    base_url=args.base_url,
                    api_key=args.api_key,
                    title_confidence_below=args.title_confidence_below,
                    genre_confidence_below=args.genre_confidence_below,
                    accept_confidence=args.accept_confidence,
                    batch_size=max(1, args.batch_size),
                    items_per_request=max(1, args.items_per_request),
                    candidate_mode=args.candidate_mode,
                    representative_plan_run_id=args.representative_plan_run_id,
                    candidate_sample_seed=args.candidate_sample_seed,
                    limit=args.limit,
                    run_id=args.run_id,
                )
            elif args.command == "plan":
                thresholds = DedupeThresholds(
                    minimum_fuzzy_chars=max(1, args.minimum_fuzzy_chars),
                    same_edition_containment=args.same_edition_containment,
                    same_work_containment=args.same_work_containment,
                )
                result = plan_catalog(
                    catalog,
                    archive_root,
                    thresholds=thresholds,
                    run_id=args.run_id,
                    draft=args.draft,
                    max_candidate_pair_rows=max(1, args.max_candidate_pair_rows),
                    delete_high_confidence_incomplete=(
                        args.delete_high_confidence_incomplete
                    ),
                )
            elif args.command == "apply":
                snapshot = None
                if args.stability_snapshot:
                    snapshot_payload = json.loads(
                        Path(args.stability_snapshot).read_text(encoding="utf-8")
                    )
                    snapshot = source_snapshot_from_dict(snapshot_payload)
                result = apply_plan(
                    catalog,
                    archive_root,
                    plan_run_id=args.plan_run_id,
                    transfer_mode=args.transfer_mode,
                    confirm_transfer_complete=args.confirm_transfer_complete,
                    stability_snapshot=snapshot,
                    limit=args.limit,
                    raw_only=args.raw_only,
                    workers=args.workers,
                    preserve_existing_processed=args.preserve_existing_processed,
                )
            elif args.command == "verify":
                result = verify_plan(
                    catalog,
                    archive_root,
                    plan_run_id=args.plan_run_id,
                    limit=args.limit,
                    run_id=args.run_id,
                    workers=args.workers,
                )
            else:
                result = catalog.stats()
        _print_json(result)
        if args.command == "verify" and result.get("errors"):
            return 1
        if args.command == "scan" and result.get("unresolved"):
            return 1
        if args.command == "apply" and (result.get("failed") or result.get("remaining")):
            return 1
        if args.command == "enrich-metadata" and result.get("degraded"):
            return 1
        if (
            args.command == "revalidate-quarantine"
            and args.apply
            and (result.get("unresolved") or result.get("remaining"))
        ):
            return 1
        return 0
    except Exception as exc:
        logging.getLogger(__name__).exception("%s failed", args.command)
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
