from __future__ import annotations

from pathlib import Path
from typing import Any

from .type_helpers import as_int, as_text
from .utils import load_json, normalize_fs_name


class ArtifactManifestError(ValueError):
    """Raised when a stage manifest does not match its data files."""


def resolve_book_id(index: dict[str, Any], *, fallback: str = "") -> str:
    metadata = index.get("book_metadata") if isinstance(index, dict) else {}
    book_id = as_text((metadata or {}).get("book_id"))
    return book_id or normalize_fs_name(fallback) or "unknown_book"


def chapter_context(payload: dict[str, Any]) -> dict[str, Any]:
    context = payload.get("chapter_context")
    if isinstance(context, dict):
        return context
    return payload


def _chapter_json_files(book_path: Path) -> list[Path]:
    files: list[Path] = []
    for path in book_path.glob("*.json"):
        if path.name == "index.json":
            continue
        if path.name == "window_results.json":
            continue
        if path.name.startswith("plot"):
            continue
        files.append(path)
    return sorted(files)


def load_chapters_from_manifest(
    book_dir: str | Path,
    index: dict[str, Any],
    *,
    stage_name: str,
    strict: bool = True,
) -> list[tuple[Path, dict[str, Any]]]:
    """Load chapter JSON files in manifest order and validate identities.

    The manifest is the authority for stage-to-stage correspondence. In
    strict mode, missing files, stale extra files, duplicate IDs, and order or
    chapter-id mismatches fail early instead of silently feeding mixed data to
    downstream stages.
    """
    book_path = Path(book_dir)
    book_id = resolve_book_id(index, fallback=book_path.name)
    manifest = index.get("chapter_manifest") or []
    if not isinstance(manifest, list):
        raise ArtifactManifestError(f"{stage_name}: chapter_manifest must be a list in {book_path}")

    actual_files = _chapter_json_files(book_path)
    if not manifest:
        return [(path, load_json(path)) for path in actual_files]

    errors: list[str] = []
    loaded: list[tuple[Path, dict[str, Any]]] = []
    expected_files: set[str] = set()
    seen_orders: set[int] = set()
    seen_chapter_ids: set[str] = set()

    for entry_index, raw_entry in enumerate(manifest, start=1):
        if not isinstance(raw_entry, dict):
            errors.append(f"manifest entry {entry_index} is not an object")
            continue
        file_name = as_text(raw_entry.get("file_name"))
        order = as_int(raw_entry.get("order"))
        chapter_id = as_text(raw_entry.get("chapter_id"))

        if not file_name:
            errors.append(f"manifest entry {entry_index} has no file_name")
            continue
        if order is None:
            errors.append(f"manifest entry {entry_index} ({file_name}) has no valid order")
        elif order in seen_orders:
            errors.append(f"duplicate chapter order {order} in manifest")
        else:
            seen_orders.add(order)
        if chapter_id:
            if chapter_id in seen_chapter_ids:
                errors.append(f"duplicate chapter_id {chapter_id} in manifest")
            seen_chapter_ids.add(chapter_id)

        expected_files.add(file_name)
        chapter_path = book_path / file_name
        if not chapter_path.exists():
            errors.append(f"missing chapter file listed in manifest: {file_name}")
            continue

        payload = load_json(chapter_path)
        context = chapter_context(payload)
        observed_book_id = as_text(context.get("book_id"))
        observed_order = as_int(context.get("order"))
        observed_chapter_id = as_text(context.get("chapter_id"))

        if observed_book_id and observed_book_id != book_id:
            errors.append(
                f"{file_name}: book_id mismatch, expected {book_id!r}, got {observed_book_id!r}"
            )
        if order is not None and observed_order is not None and observed_order != order:
            errors.append(
                f"{file_name}: order mismatch, expected {order}, got {observed_order}"
            )
        if chapter_id and observed_chapter_id and observed_chapter_id != chapter_id:
            errors.append(
                f"{file_name}: chapter_id mismatch, expected {chapter_id!r}, got {observed_chapter_id!r}"
            )
        loaded.append((chapter_path, payload))

    extra_files = [path.name for path in actual_files if path.name not in expected_files]
    if extra_files:
        errors.append(f"extra chapter files not listed in manifest: {', '.join(extra_files[:20])}")

    if errors and strict:
        details = "\n- ".join(errors)
        raise ArtifactManifestError(f"{stage_name}: invalid chapter manifest for {book_path}\n- {details}")
    return loaded


def validate_plot_payload(
    plot_payload: dict[str, Any],
    *,
    book_id: str,
    valid_chapter_ids: set[str],
    file_name: str,
) -> None:
    chapter_ids = plot_payload.get("chapter_ids") or []
    if not isinstance(chapter_ids, list):
        raise ArtifactManifestError(f"{file_name}: plot chapter_ids must be a list")
    missing = [str(chapter_id) for chapter_id in chapter_ids if str(chapter_id) not in valid_chapter_ids]
    if missing:
        raise ArtifactManifestError(
            f"{file_name}: plot references chapter_ids not present in chapter_features/{book_id}: "
            + ", ".join(missing[:20])
        )
