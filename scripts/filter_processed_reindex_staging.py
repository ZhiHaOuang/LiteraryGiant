"""Filter processed reindex staging against the final published raw ID set."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import stat
import uuid
from typing import Any


ID_RE = re.compile(r"^id\d{6}$")
ID_BYTES_RE = re.compile(rb"id\d{6}")


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("xb") as handle:
        handle.write((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode())
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _published_ids(index_path: Path) -> set[str]:
    ids: set[str] = set()
    with index_path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            row = json.loads(line)
            canonical = str(row.get("canonical_id") or "")
            if not ID_RE.fullmatch(canonical) or canonical in ids:
                raise ValueError(f"Invalid/duplicate canonical ID at {index_path}:{line_no}")
            ids.add(canonical)
    return ids


def filter_staging(
    source_root: Path,
    raw_index: Path,
    output_root: Path,
    *,
    workers: int,
) -> dict[str, Any]:
    source_root = source_root.resolve()
    output_root = output_root.resolve()
    if workers < 1 or output_root == source_root or source_root in output_root.parents:
        raise ValueError("Invalid workers or staging roots")
    allowed = _published_ids(raw_index.resolve())
    omitted_ids: set[str] = set()
    tasks: list[tuple[Path, Path, bool]] = []
    omitted_files: list[str] = []

    for scope in ("corpus", "references"):
        root = source_root / scope
        for source in root.rglob("*"):
            if not source.is_file():
                continue
            relative = source.relative_to(source_root)
            path_ids = {part for part in relative.parts if ID_RE.fullmatch(part)}
            missing_path_ids = path_ids - allowed
            if missing_path_ids:
                omitted_ids.update(missing_path_ids)
                omitted_files.append(relative.as_posix())
                continue
            tasks.append((source, output_root / relative, scope == "references"))

    def materialize(task: tuple[Path, Path, bool]) -> tuple[str, str | None]:
        source, target, inspect_references = task
        try:
            source_stat = source.lstat()
            if not stat.S_ISREG(source_stat.st_mode):
                raise ValueError(f"Not a regular file: {source}")
            if inspect_references:
                payload = source.read_bytes()
                content_ids = {value.decode("ascii") for value in ID_BYTES_RE.findall(payload)}
                missing_content_ids = content_ids - allowed
                if missing_content_ids:
                    raise ValueError(
                        f"Retained reference points outside final raw IDs: "
                        f"{source}: {sorted(missing_content_ids)}"
                    )
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target_stat = target.stat()
                if (target_stat.st_dev, target_stat.st_ino) != (
                    source_stat.st_dev,
                    source_stat.st_ino,
                ):
                    raise ValueError(f"Existing target is not the planned hardlink: {target}")
                return "unchanged", None
            os.link(source, target)
            return "written", None
        except Exception as exc:
            return "failed", f"{type(exc).__name__}: {exc}"

    counts = {"written": 0, "unchanged": 0, "failed": 0}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for state, error in executor.map(materialize, tasks):
            counts[state] += 1
            if error is not None:
                errors.append(error)
    summary = {
        "allowed_raw_ids": len(allowed),
        "source_files": len(tasks) + len(omitted_files),
        "retained_files": len(tasks),
        "omitted_files": len(omitted_files),
        "omitted_ids": sorted(omitted_ids),
        **counts,
        "workers": workers,
        "complete": counts["failed"] == 0,
        "live_library_modified": False,
        "errors": errors[:100],
    }
    _atomic_json(output_root / "_migration" / "summary.json", summary)
    _atomic_json(
        output_root / "_migration" / "omissions.json",
        {"ids": sorted(omitted_ids), "files": sorted(omitted_files)},
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--raw-index", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--workers", type=int, default=14)
    args = parser.parse_args()
    summary = filter_staging(
        Path(args.source_root),
        Path(args.raw_index),
        Path(args.output_root),
        workers=args.workers,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
