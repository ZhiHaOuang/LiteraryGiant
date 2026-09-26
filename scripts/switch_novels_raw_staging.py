"""Transactionally switch an accepted novels_raw staging tree into Library."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import uuid


def _atomic_json(path: Path, payload: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("xb") as handle:
        handle.write((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode())
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _manifest_rows(path: Path) -> int:
    with path.open("rb") as handle:
        return sum(1 for line in handle if line.strip())


def switch(staging: Path, live: Path, backup_root: Path, *, apply: bool) -> dict:
    staging = staging.resolve()
    live = live.resolve()
    backup_root = backup_root.resolve()
    if not staging.is_dir() or not live.is_dir():
        raise ValueError("Both staging and current live novels_raw must be directories")
    summary_path = staging / "_migration" / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    manifest_rows = _manifest_rows(staging / "index.jsonl")
    if (
        summary.get("complete") is not True
        or int(summary.get("failed") or 0) != 0
        or manifest_rows != int(summary.get("planned") or -1)
    ):
        raise ValueError(f"Staging acceptance mismatch: rows={manifest_rows}, summary={summary}")
    if staging.stat().st_dev != live.parent.stat().st_dev:
        raise ValueError("Staging and live parent are on different filesystems")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_root / f"novels_raw-pre-{timestamp}"
    result = {
        "staging": str(staging),
        "live": str(live),
        "backup": str(backup),
        "manifest_rows": manifest_rows,
        "dry_run": not apply,
        "downstream_switched": False,
        "noise_modified": False,
    }
    if not apply:
        return result
    backup_root.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        raise FileExistsError(backup)
    moved_live = False
    try:
        os.rename(live, backup)
        moved_live = True
        os.rename(staging, live)
    except Exception:
        if moved_live and not live.exists() and backup.exists():
            os.rename(backup, live)
        raise
    result["dry_run"] = False
    result["switched"] = True
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    _atomic_json(live / "_migration" / "cutover.json", result)
    for directory in (live.parent, backup_root):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", required=True)
    parser.add_argument("--live", default="Library/TaciturnRaw/01_RawData")
    parser.add_argument(
        "--backup-root",
        default="Library/TaciturnRaw/_migration_backups",
    )
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = switch(
        Path(args.staging),
        Path(args.live),
        Path(args.backup_root),
        apply=args.apply,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
