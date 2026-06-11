"""Copy legacy project artifacts into the canonical Library layout."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from shared import DATA_ROOT


LAYOUT_VERSION = "novel-agent-data-v1"

CHAPTER_STAGE_MAP = {
    "chapters": ("ProcessData", Path("reference/facts/cleaned_chapters")),
    "features": ("FeatureData", Path("reference/facts/chapter_features")),
}


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"JSON object expected: {path}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def book_slug(book_id: str) -> str:
    normalized = str(book_id).strip()
    if normalized.startswith("book_"):
        return normalized
    return f"book_{normalized}"


def chapter_context(payload: dict[str, Any]) -> dict[str, Any]:
    context = payload.get("chapter_context")
    return context if isinstance(context, dict) else payload


def canonical_chapter_file(order: int) -> str:
    return f"chapter_{order:04d}.json"


def copy_raw_text(project_root: Path, data_root: Path, book_id: str) -> dict[str, Any]:
    source = project_root / "RawData" / f"{book_id}.txt"
    target_dir = data_root / "rawdata" / "novels" / book_slug(book_id)
    target = target_dir / "source.txt"
    if not source.exists():
        return {"stage": "rawdata", "status": "missing", "source": str(source)}

    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    metadata = {
        "layout_version": LAYOUT_VERSION,
        "book_id": book_id,
        "book_slug": book_slug(book_id),
        "artifact_stage": "rawdata",
        "file_name": target.name,
        "legacy_source": str(source.relative_to(project_root)),
        "sha256": file_sha256(target),
        "size_bytes": target.stat().st_size,
    }
    write_json(target_dir / "metadata.json", metadata)
    return {"stage": "rawdata", "status": "copied", "target": str(target)}


def _legacy_manifest_by_file(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    manifest = index.get("chapter_manifest")
    if not isinstance(manifest, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for entry in manifest:
        if isinstance(entry, dict) and entry.get("file_name"):
            result[str(entry["file_name"])] = entry
    return result


def copy_chapter_stage(
    project_root: Path,
    data_root: Path,
    book_id: str,
    *,
    stage: str,
) -> dict[str, Any]:
    legacy_dir_name, canonical_root = CHAPTER_STAGE_MAP[stage]
    source_dir = project_root / legacy_dir_name / book_id
    target_dir = data_root / canonical_root / book_slug(book_id)
    if not source_dir.exists():
        return {"stage": stage, "status": "missing", "source": str(source_dir)}

    legacy_index = read_json(source_dir / "index.json") if (source_dir / "index.json").exists() else {}
    legacy_manifest = _legacy_manifest_by_file(legacy_index)
    source_files = sorted(source_dir.glob("[0-9][0-9][0-9][0-9].json"))
    target_dir.mkdir(parents=True, exist_ok=True)

    chapter_manifest: list[dict[str, Any]] = []
    warnings: list[str] = []
    copied = 0
    for source_file in source_files:
        payload = read_json(source_file)
        context = chapter_context(payload)
        order = as_int(context.get("order")) or as_int(source_file.stem)
        if order is None:
            warnings.append(f"skipped {source_file.name}: order not found")
            continue
        target_name = canonical_chapter_file(order)
        target_file = target_dir / target_name
        shutil.copy2(source_file, target_file)
        copied += 1

        legacy_entry = legacy_manifest.get(source_file.name, {})
        clean_title = (
            context.get("clean_title")
            or context.get("chapter_title")
            or context.get("title")
            or legacy_entry.get("clean_title")
            or legacy_entry.get("chapter_title")
            or ""
        )
        chapter_id = (
            context.get("chapter_id")
            or legacy_entry.get("chapter_id")
            or f"{book_id}C{order:04d}"
        )
        entry: dict[str, Any] = {
            "order": order,
            "chapter_id": str(chapter_id),
            "clean_title": str(clean_title),
            "file_name": target_name,
            "legacy_file_name": source_file.name,
        }
        volume = context.get("volume") or legacy_entry.get("volume")
        if volume:
            entry["volume"] = volume
        chapter_manifest.append(entry)

    for legacy_name in legacy_manifest:
        if not (source_dir / legacy_name).exists():
            warnings.append(f"legacy manifest listed missing file: {legacy_name}")

    chapter_manifest.sort(key=lambda item: int(item["order"]))
    index = dict(legacy_index)
    metadata = dict(index.get("book_metadata") or {})
    metadata.setdefault("book_id", book_id)
    metadata["book_slug"] = book_slug(book_id)
    metadata["chapter_count"] = len(chapter_manifest)
    index.update(
        {
            "layout_version": LAYOUT_VERSION,
            "artifact_stage": stage,
            "legacy_source": str(source_dir.relative_to(project_root)),
            "book_metadata": metadata,
            "chapter_manifest": chapter_manifest,
        }
    )
    if warnings:
        index["sync_warnings"] = warnings
    write_json(target_dir / "index.json", index)
    return {
        "stage": stage,
        "status": "copied",
        "target": str(target_dir),
        "file_count": copied,
        "warnings": warnings,
    }


def _plot_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"(\d+)", path.stem)
    return (int(match.group(1)) if match else 0, path.name)


def canonical_plot_file(index: int) -> str:
    return f"plot_{index:04d}.json"


def copy_plots(project_root: Path, data_root: Path, book_id: str) -> dict[str, Any]:
    source_dir = project_root / "ClusterData" / book_id
    target_dir = data_root / "reference" / "facts" / "plot_segments" / book_slug(book_id)
    if not source_dir.exists():
        return {"stage": "plots", "status": "missing", "source": str(source_dir)}

    legacy_index = read_json(source_dir / "index.json") if (source_dir / "index.json").exists() else {}
    target_dir.mkdir(parents=True, exist_ok=True)
    file_map: dict[str, str] = {}
    plot_files = sorted(source_dir.glob("plot*.json"), key=_plot_sort_key)
    for sequence, source_file in enumerate(plot_files, start=1):
        target_name = canonical_plot_file(sequence)
        shutil.copy2(source_file, target_dir / target_name)
        file_map[source_file.name] = target_name

    if (source_dir / "window_results.json").exists():
        shutil.copy2(source_dir / "window_results.json", target_dir / "window_results.json")

    index = dict(legacy_index)
    metadata = dict(index.get("book_metadata") or {})
    metadata.setdefault("book_id", book_id)
    metadata["book_slug"] = book_slug(book_id)

    def rewrite_manifest(name: str) -> list[dict[str, Any]]:
        manifest = index.get(name)
        if not isinstance(manifest, list):
            return []
        rewritten: list[dict[str, Any]] = []
        for entry in manifest:
            if not isinstance(entry, dict):
                continue
            item = dict(entry)
            old_file = str(item.get("file_name") or "")
            if old_file in file_map:
                item["legacy_file_name"] = old_file
                item["file_name"] = file_map[old_file]
            rewritten.append(item)
        return rewritten

    plot_manifest = rewrite_manifest("plot_manifest")
    if not plot_manifest:
        for sequence, source_file in enumerate(plot_files, start=1):
            payload = read_json(source_file)
            plot_manifest.append(
                {
                    "plot_id": str(payload.get("plot_id") or f"plot{sequence}"),
                    "plot_index": int(payload.get("plot_index") or sequence),
                    "start_order": payload.get("start_order"),
                    "end_order": payload.get("end_order"),
                    "chapter_count": len(payload.get("chapter_ids") or []),
                    "chapter_ids": payload.get("chapter_ids") or [],
                    "file_name": file_map[source_file.name],
                    "legacy_file_name": source_file.name,
                }
            )

    index.update(
        {
            "layout_version": LAYOUT_VERSION,
            "artifact_stage": "plots",
            "legacy_source": str(source_dir.relative_to(project_root)),
            "book_metadata": metadata,
            "plot_manifest": plot_manifest,
            "cluster_manifest": rewrite_manifest("cluster_manifest") or plot_manifest,
        }
    )
    write_json(target_dir / "index.json", index)
    return {
        "stage": "plots",
        "status": "copied",
        "target": str(target_dir),
        "file_count": len(plot_files),
    }


def update_books_index(data_root: Path, book_id: str, results: list[dict[str, Any]]) -> None:
    path = data_root / "indexes" / "books.json"
    index = read_json(path) if path.exists() else {"layout_version": LAYOUT_VERSION, "books": []}
    books = index.setdefault("books", [])
    if not isinstance(books, list):
        books = []
        index["books"] = books

    entry = None
    for item in books:
        if isinstance(item, dict) and item.get("book_id") == book_id:
            entry = item
            break
    if entry is None:
        entry = {"book_id": book_id, "book_slug": book_slug(book_id), "paths": {}}
        books.append(entry)

    paths = entry.setdefault("paths", {})
    for result in results:
        if result.get("status") != "copied":
            continue
        stage = result["stage"]
        if stage == "rawdata":
            paths[stage] = f"rawdata/novels/{book_slug(book_id)}"
        elif stage == "chapters":
            paths[stage] = f"reference/facts/cleaned_chapters/{book_slug(book_id)}"
        elif stage == "features":
            paths[stage] = f"reference/facts/chapter_features/{book_slug(book_id)}"
        elif stage == "plots":
            paths[stage] = f"reference/facts/plot_segments/{book_slug(book_id)}"
    write_json(path, index)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Copy legacy RawData/ProcessData/FeatureData/ClusterData artifacts into Library/."
    )
    parser.add_argument("--book-id", default="0001", help="Legacy book id to copy. Default: 0001.")
    parser.add_argument("--project-root", default=".", help="Project root. Default: current directory.")
    parser.add_argument("--data-root", default=str(DATA_ROOT), help="Canonical data root. Default: Library.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()
    data_root = Path(args.data_root)
    if not data_root.is_absolute():
        data_root = project_root / data_root
    data_root = data_root.resolve()
    book_id = str(args.book_id).strip()

    results = [
        copy_raw_text(project_root, data_root, book_id),
        copy_chapter_stage(project_root, data_root, book_id, stage="chapters"),
        copy_chapter_stage(project_root, data_root, book_id, stage="features"),
        copy_plots(project_root, data_root, book_id),
    ]
    update_books_index(data_root, book_id, results)

    for result in results:
        status = result.get("status")
        stage = result.get("stage")
        target = result.get("target") or result.get("source")
        count = result.get("file_count")
        suffix = f" ({count} files)" if count is not None else ""
        print(f"[{status.upper()}] {stage}: {target}{suffix}")
        for warning in result.get("warnings") or []:
            print(f"[WARN] {stage}: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
