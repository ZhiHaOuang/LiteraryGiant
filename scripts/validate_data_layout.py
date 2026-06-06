"""Validate canonical Yggdrasil novel-agent data layout."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from shared import DATA_ROOT
from shared.artifact_manifest import (
    ArtifactManifestError,
    load_chapters_from_manifest,
    validate_plot_payload,
)
from shared.type_helpers import as_text


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"JSON object expected: {path}")
    return payload


def book_slug(book_id: str) -> str:
    value = str(book_id).strip()
    if value.startswith("book_"):
        return value
    return f"book_{value}"


def iter_book_dirs(root: Path, book_id: str | None) -> list[Path]:
    if book_id:
        target = root / book_slug(book_id)
        return [target] if target.exists() else []
    return sorted(path for path in root.glob("book_*") if path.is_dir())


def collect_chapter_ids(book_dir: Path, stage_name: str, errors: list[str]) -> set[str]:
    index_path = book_dir / "index.json"
    if not index_path.exists():
        errors.append(f"{stage_name}: missing index.json in {book_dir}")
        return set()
    try:
        index = read_json(index_path)
        loaded = load_chapters_from_manifest(book_dir, index, stage_name=stage_name, strict=True)
    except (ArtifactManifestError, ValueError) as exc:
        errors.append(str(exc))
        return set()

    chapter_ids: set[str] = set()
    for _path, payload in loaded:
        context = payload.get("chapter_context") if isinstance(payload.get("chapter_context"), dict) else payload
        chapter_id = as_text(context.get("chapter_id"))
        if chapter_id:
            chapter_ids.add(chapter_id)
    print(f"[OK] {stage_name}: {book_dir} ({len(loaded)} chapters)")
    return chapter_ids


def validate_raw_text(data_root: Path, book_id: str | None, errors: list[str]) -> None:
    raw_root = data_root / "sources" / "raw_text"
    for book_dir in iter_book_dirs(raw_root, book_id):
        source = book_dir / "source.txt"
        metadata = book_dir / "metadata.json"
        index = book_dir / "index.json"
        chapter_files = sorted(book_dir.glob("chapter_*.txt"))
        if source.exists():
            if not metadata.exists() and not index.exists():
                errors.append(f"raw_text: missing metadata.json or index.json in {book_dir}")
                continue
            print(f"[OK] raw_text: {book_dir}")
            continue
        if index.exists() and chapter_files:
            try:
                payload = read_json(index)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            manifest = payload.get("chapters") or []
            if not isinstance(manifest, list):
                errors.append(f"raw_text: chapters must be a list in {index}")
                continue
            indexed_files = {
                as_text(entry.get("file_name"))
                for entry in manifest
                if isinstance(entry, dict) and as_text(entry.get("file_name"))
            }
            actual_files = {path.name for path in chapter_files}
            missing = sorted(indexed_files - actual_files)
            if missing:
                errors.append(f"raw_text: {book_dir} misses indexed chapter files: {missing[:5]}")
                continue
            if not indexed_files:
                errors.append(f"raw_text: no chapter files listed in {index}")
                continue
            print(f"[OK] raw_text: {book_dir} ({len(indexed_files)} indexed chapters)")
            continue
        errors.append(f"raw_text: missing source.txt or indexed chapter_*.txt files in {book_dir}")


def validate_plots(
    data_root: Path,
    book_id: str | None,
    feature_ids_by_book: dict[str, set[str]],
    errors: list[str],
) -> None:
    plots_root = data_root / "derived" / "plots"
    for book_dir in iter_book_dirs(plots_root, book_id):
        index_path = book_dir / "index.json"
        if not index_path.exists():
            errors.append(f"plots: missing index.json in {book_dir}")
            continue
        index = read_json(index_path)
        metadata = index.get("book_metadata") if isinstance(index.get("book_metadata"), dict) else {}
        resolved_book_id = as_text(metadata.get("book_id")) or book_dir.name.removeprefix("book_")
        valid_chapter_ids = feature_ids_by_book.get(resolved_book_id, set())
        manifest = index.get("plot_manifest") or index.get("cluster_manifest") or []
        if not isinstance(manifest, list):
            errors.append(f"plots: plot_manifest must be a list in {book_dir}")
            continue

        seen_plot_ids: set[str] = set()
        checked = 0
        for entry_index, entry in enumerate(manifest, start=1):
            if not isinstance(entry, dict):
                errors.append(f"plots: manifest entry {entry_index} is not an object in {book_dir}")
                continue
            file_name = as_text(entry.get("file_name"))
            plot_id = as_text(entry.get("plot_id"))
            if not file_name:
                errors.append(f"plots: manifest entry {entry_index} has no file_name in {book_dir}")
                continue
            if plot_id in seen_plot_ids:
                errors.append(f"plots: duplicate plot_id {plot_id} in {book_dir}")
            if plot_id:
                seen_plot_ids.add(plot_id)
            plot_path = book_dir / file_name
            if not plot_path.exists():
                errors.append(f"plots: missing plot file listed in manifest: {plot_path}")
                continue
            payload = read_json(plot_path)
            if valid_chapter_ids:
                try:
                    validate_plot_payload(
                        payload,
                        book_id=resolved_book_id,
                        valid_chapter_ids=valid_chapter_ids,
                        file_name=file_name,
                    )
                except ArtifactManifestError as exc:
                    errors.append(str(exc))
            checked += 1
        print(f"[OK] plots: {book_dir} ({checked} plots)")


def validate_layout(data_root: Path, book_id: str | None) -> int:
    errors: list[str] = []
    warnings: list[str] = []

    validate_raw_text(data_root, book_id, errors)

    chapter_ids_by_book: dict[str, set[str]] = {}
    for book_dir in iter_book_dirs(data_root / "derived" / "chapters", book_id):
        ids = collect_chapter_ids(book_dir, "chapters", errors)
        if ids:
            chapter_ids_by_book[book_dir.name.removeprefix("book_")] = ids

    feature_ids_by_book: dict[str, set[str]] = {}
    for book_dir in iter_book_dirs(data_root / "derived" / "features", book_id):
        ids = collect_chapter_ids(book_dir, "features", errors)
        resolved_book_id = book_dir.name.removeprefix("book_")
        feature_ids_by_book[resolved_book_id] = ids
        missing_features = sorted(chapter_ids_by_book.get(resolved_book_id, set()) - ids)
        if missing_features:
            warnings.append(
                f"features: {book_dir} misses {len(missing_features)} chapter ids present in chapters"
            )

    validate_plots(data_root, book_id, feature_ids_by_book, errors)

    for warning in warnings:
        print(f"[WARN] {warning}")
    for error in errors:
        print(f"[ERROR] {error}")
    if errors:
        return 1
    print("[OK] canonical data layout validation passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate canonical Yggdrasil layout.")
    parser.add_argument(
        "--data-root",
        default=str(DATA_ROOT),
        help="Canonical data root. Default: Yggdrasil.",
    )
    parser.add_argument("--book-id", default=None, help="Optional book id to validate, e.g. 0001.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return validate_layout(Path(args.data_root).resolve(), args.book_id)


if __name__ == "__main__":
    raise SystemExit(main())
