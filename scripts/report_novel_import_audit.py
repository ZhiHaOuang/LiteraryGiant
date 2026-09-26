#!/usr/bin/env python3
"""Export a complete, machine-readable local novel import audit report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from fetcher.local_audit import export_local_novel_audit


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True, help="Local import SQLite catalog")
    parser.add_argument("--output-dir", type=Path, required=True, help="Report output directory")
    parser.add_argument(
        "--plan-run-id",
        help="Completed plan to report; defaults to the latest completed frozen plan",
    )
    parser.add_argument(
        "--metadata-audit",
        type=Path,
        action="append",
        default=[],
        help="Additional/legacy vLLM results.jsonl; repeatable",
    )
    parser.add_argument(
        "--supplemental-jsonl",
        type=Path,
        action="append",
        default=[],
        help="EPUB or archive-extraction audit JSONL; repeatable",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    summary = export_local_novel_audit(
        args.catalog,
        args.output_dir,
        plan_run_id=args.plan_run_id,
        metadata_audit_paths=args.metadata_audit,
        supplemental_jsonl_paths=args.supplemental_jsonl,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
