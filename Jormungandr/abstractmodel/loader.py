from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from shared import is_unified_content_id, load_json


def looks_like_plot_book_dir(path: Path) -> bool:
    return path.is_dir() and is_unified_content_id(path.name) and (path / "index.json").exists() and (
        any(path.glob("plot*.json")) or (path / "window_results.json").exists()
    )


def discover_plot_books(input_path: str | Path) -> list[Path]:
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    if looks_like_plot_book_dir(path):
        return [path]
    if not path.is_dir():
        raise ValueError(f"Input path must be a Bridges novels_plot root or one plot book directory: {path}")
    books = sorted(item for item in path.iterdir() if looks_like_plot_book_dir(item))
    if not books:
        raise FileNotFoundError(f"No plot book directories found under {path}")
    return books


def _plot_sort_key(item: tuple[Path, dict[str, Any]]) -> tuple[int, int, str]:
    path, payload = item
    plot_index = payload.get("plot_index")
    try:
        return 0, int(plot_index), path.name
    except (TypeError, ValueError):
        match = re.search(r"(\d+)", path.stem)
        return 1, int(match.group(1)) if match else 0, path.name


def _manifest_plot_files(book_path: Path, index: dict[str, Any]) -> list[Path]:
    files: list[Path] = []
    manifest = index.get("plot_manifest") or index.get("cluster_manifest") or []
    if isinstance(manifest, list):
        for item in manifest:
            if not isinstance(item, dict):
                continue
            file_name = str(item.get("file_name") or "").strip()
            if not file_name:
                plot_id = str(item.get("plot_id") or "").strip()
                file_name = f"{plot_id}.json" if plot_id else ""
            if file_name:
                files.append(book_path / file_name)
    if files:
        return files
    return sorted(
        path for path in book_path.glob("plot*.json")
        if path.name not in {"window_results.json", "index.json"}
    )


def load_plot_book_bundle(book_dir: str | Path) -> dict[str, Any]:
    book_path = Path(book_dir)
    index = load_json(book_path / "index.json")
    plot_items: list[tuple[Path, dict[str, Any]]] = []
    for plot_path in _manifest_plot_files(book_path, index):
        if not plot_path.exists():
            continue
        payload = load_json(plot_path)
        if isinstance(payload, dict):
            plot_items.append((plot_path, payload))
    plot_items = sorted(plot_items, key=_plot_sort_key)
    return {
        "book_dir": str(book_path),
        "index": index,
        "book_metadata": index.get("book_metadata") if isinstance(index.get("book_metadata"), dict) else {},
        "plots": [
            {
                "source_file": str(plot_path),
                "payload": payload,
            }
            for plot_path, payload in plot_items
        ],
    }
