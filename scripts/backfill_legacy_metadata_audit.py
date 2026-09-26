#!/usr/bin/env python3
"""Backfill exact before/after events for accepted legacy vLLM audit rows."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from fetcher.local_audit import backfill_legacy_metadata_events


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument(
        "--metadata-audit",
        type=Path,
        action="append",
        default=[],
        help="Additional legacy results.jsonl; otherwise catalog run summaries are used",
    )
    args = parser.parse_args()
    result = backfill_legacy_metadata_events(args.catalog, args.metadata_audit)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if result["counts"].get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
