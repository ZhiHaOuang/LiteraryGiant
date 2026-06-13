from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import (
    CLEANED_BOOKS_REGISTRY_PATH,
    FACT_CLEANED_CHAPTERS_ROOT,
    LIBRARY_ROOT,
    RAWDATA_ROOT,
    CleanedBookRegistry,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _library_path(path_value: str | Path) -> Path:
    path = Path(path_value)
    return path if path.is_absolute() else LIBRARY_ROOT / path


def _looks_like_raw_item(path: Path) -> bool:
    if not path.is_dir():
        return False
    if (path / "source.txt").exists() or (path / "story.txt").exists():
        return True
    if (path / "chapters").is_dir():
        return True
    payload = _read_json(path / "index.json")
    if payload.get("book_slug") or payload.get("story_slug"):
        return True
    return isinstance(payload.get("chapters"), list)


def _iter_raw_items(root: Path, *, max_depth: int) -> list[Path]:
    root = root.expanduser().resolve()
    if not root.exists():
        return []
    if _looks_like_raw_item(root):
        return [root]

    items: list[Path] = []
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        if current != root and _looks_like_raw_item(current):
            items.append(current)
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
    return items


def _raw_slug(path: Path) -> str:
    payload = _read_json(path / "index.json")
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


def _raw_chapter_info(path: Path, *, deep: bool) -> tuple[int, list[str]]:
    payload = _read_json(path / "index.json")
    chapters = payload.get("chapters")
    missing: list[str] = []
    if isinstance(chapters, list):
        if deep:
            for item in chapters:
                if not isinstance(item, dict):
                    continue
                file_name = str(item.get("file_name") or "").strip()
                if file_name and not (path / file_name).exists() and not (path / "chapters" / file_name).exists():
                    missing.append(file_name)
        return len(chapters), missing

    chapter_dir = path / "chapters"
    search_dir = chapter_dir if chapter_dir.is_dir() else path
    txt_count = len([item for item in search_dir.glob("*.txt") if item.name != "index.json"])
    return txt_count, missing


def _cleaned_chapter_info(output_dir: Path, *, deep: bool) -> tuple[int, int, int]:
    index_payload = _read_json(output_dir / "index.json")
    metadata = index_payload.get("book_metadata") if isinstance(index_payload, dict) else {}
    manifest = index_payload.get("chapter_manifest") if isinstance(index_payload, dict) else []
    metadata_count = 0
    if isinstance(metadata, dict):
        try:
            metadata_count = int(metadata.get("chapter_count") or 0)
        except (TypeError, ValueError):
            metadata_count = 0
    manifest_count = len(manifest) if isinstance(manifest, list) else 0
    file_count = len(list(output_dir.glob("chapter_*.json"))) if deep and output_dir.exists() else 0
    return metadata_count, manifest_count, file_count


def _issue(
    issues: list[dict[str, Any]],
    *,
    severity: str,
    code: str,
    subject: str,
    message: str,
) -> None:
    issues.append(
        {
            "severity": severity,
            "code": code,
            "subject": subject,
            "message": message,
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="check-cleaned-state",
        description="Audit raw library items, cleaned registry entries, and cleaned chapter outputs.",
    )
    parser.add_argument(
        "raw_roots",
        nargs="*",
        default=[str(RAWDATA_ROOT)],
        help="Raw library root(s) to scan. Default: Library/rawdata.",
    )
    parser.add_argument(
        "--registry",
        default=str(CLEANED_BOOKS_REGISTRY_PATH),
        help=f"Cleaned registry path. Default: {CLEANED_BOOKS_REGISTRY_PATH}.",
    )
    parser.add_argument(
        "--output-root",
        default=str(FACT_CLEANED_CHAPTERS_ROOT),
        help=f"Cleaned chapter output root. Default: {FACT_CLEANED_CHAPTERS_ROOT}.",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="Also check listed raw chapter files and cleaned chapter JSON file counts.",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=3,
        help="Directory depth to scan under each raw root. Default: 3.",
    )
    parser.add_argument(
        "--json-output",
        help="Optional path to write the full audit report as JSON.",
    )
    parser.add_argument(
        "--max-issues",
        type=int,
        default=80,
        help="Maximum issues to print to stdout. Default: 80.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    registry = CleanedBookRegistry(args.registry)
    output_root = Path(args.output_root)
    entries = registry.active_entries()
    raw_items: dict[str, Path] = {}
    issues: list[dict[str, Any]] = []

    for raw_root in args.raw_roots:
        root = Path(raw_root)
        if not root.exists():
            _issue(
                issues,
                severity="error",
                code="raw_root_missing",
                subject=str(root),
                message="Raw root does not exist.",
            )
            continue
        for item in _iter_raw_items(root, max_depth=args.max_depth):
            slug = _raw_slug(item)
            if slug in raw_items and raw_items[slug] != item:
                _issue(
                    issues,
                    severity="error",
                    code="duplicate_raw_slug",
                    subject=slug,
                    message=f"{raw_items[slug]} and {item} use the same raw slug.",
                )
            raw_items[slug] = item

    entry_by_raw: dict[str, dict[str, Any]] = {}
    for entry in entries:
        raw = entry.get("raw", {})
        raw_slug = str(raw.get("raw_book_slug") or "")
        if not raw_slug:
            _issue(
                issues,
                severity="error",
                code="entry_missing_raw_slug",
                subject=str(entry.get("clean_slug") or entry.get("clean_id") or ""),
                message="Registry entry has no raw_book_slug.",
            )
            continue
        if raw_slug in entry_by_raw:
            _issue(
                issues,
                severity="error",
                code="duplicate_registry_raw_slug",
                subject=raw_slug,
                message="More than one active registry entry points at this raw slug.",
            )
        entry_by_raw[raw_slug] = entry

        clean_id = str(entry.get("clean_id") or "")
        if clean_id != _slug_numeric_id(raw_slug):
            _issue(
                issues,
                severity="error",
                code="id_mismatch",
                subject=raw_slug,
                message=f"clean_id={clean_id!r} does not match raw slug.",
            )

        raw_path_value = str(raw.get("raw_path") or "")
        raw_path = raw_items.get(raw_slug) or (_library_path(raw_path_value) if raw_path_value else Path())
        if not raw_path_value and raw_slug not in raw_items:
            _issue(
                issues,
                severity="error",
                code="entry_missing_raw_path",
                subject=raw_slug,
                message="Registry entry has no raw_path and no matching raw item was scanned.",
            )
        elif not raw_path.exists():
            _issue(
                issues,
                severity="error",
                code="raw_path_missing",
                subject=raw_slug,
                message=f"Raw path is missing: {raw_path}",
            )

        output_dir = registry.output_dir_for_entry(entry, output_root=output_root)
        has_output, output_reason = registry.entry_has_clean_output(entry, output_root=output_root)
        if not has_output:
            _issue(
                issues,
                severity="error",
                code=output_reason,
                subject=raw_slug,
                message=f"Cleaned output is not ready: {output_dir}",
            )

        last_cleaned = entry.get("last_cleaned") or {}
        try:
            last_count = int(last_cleaned.get("chapter_count") or 0)
        except (TypeError, ValueError):
            last_count = 0

        raw_count = 0
        missing_raw_files: list[str] = []
        if raw_path.exists():
            raw_count, missing_raw_files = _raw_chapter_info(raw_path, deep=args.deep)
            if raw_count and last_count and raw_count != last_count:
                _issue(
                    issues,
                    severity="error",
                    code="raw_cleaned_chapter_count_mismatch",
                    subject=raw_slug,
                    message=f"raw chapters={raw_count}, last_cleaned chapters={last_count}.",
                )
            if missing_raw_files:
                preview = ", ".join(missing_raw_files[:8])
                _issue(
                    issues,
                    severity="error",
                    code="raw_chapter_files_missing",
                    subject=raw_slug,
                    message=f"{len(missing_raw_files)} listed raw chapter file(s) missing: {preview}",
                )

        if output_dir.exists():
            metadata_count, manifest_count, file_count = _cleaned_chapter_info(output_dir, deep=args.deep)
            if last_count and metadata_count and last_count != metadata_count:
                _issue(
                    issues,
                    severity="error",
                    code="registry_output_count_mismatch",
                    subject=raw_slug,
                    message=f"last_cleaned chapters={last_count}, output metadata chapters={metadata_count}.",
                )
            if metadata_count and manifest_count and metadata_count != manifest_count:
                _issue(
                    issues,
                    severity="error",
                    code="output_manifest_count_mismatch",
                    subject=raw_slug,
                    message=f"output metadata chapters={metadata_count}, manifest chapters={manifest_count}.",
                )
            if args.deep and metadata_count and file_count and metadata_count != file_count:
                _issue(
                    issues,
                    severity="error",
                    code="output_file_count_mismatch",
                    subject=raw_slug,
                    message=f"output metadata chapters={metadata_count}, chapter JSON files={file_count}.",
                )

    for raw_slug, raw_path in sorted(raw_items.items()):
        if raw_slug not in entry_by_raw:
            _issue(
                issues,
                severity="warning",
                code="raw_not_registered",
                subject=raw_slug,
                message=f"Raw item has no active cleaned registry entry: {raw_path}",
            )

    errors = [item for item in issues if item["severity"] == "error"]
    warnings = [item for item in issues if item["severity"] == "warning"]
    report = {
        "checked_at": _utc_now(),
        "registry": str(Path(args.registry)),
        "raw_roots": [str(Path(item)) for item in args.raw_roots],
        "output_root": str(output_root),
        "deep": bool(args.deep),
        "summary": {
            "registry_entries": len(entries),
            "raw_items": len(raw_items),
            "errors": len(errors),
            "warnings": len(warnings),
        },
        "issues": issues,
    }

    if args.json_output:
        path = Path(args.json_output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        "Checked cleaned state: "
        f"registry_entries={len(entries)} raw_items={len(raw_items)} "
        f"errors={len(errors)} warnings={len(warnings)}"
    )
    for item in issues[: args.max_issues]:
        print(f"[{item['severity'].upper()}] {item['code']} {item['subject']}: {item['message']}")
    if len(issues) > args.max_issues:
        print(f"... {len(issues) - args.max_issues} more issue(s) omitted")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
