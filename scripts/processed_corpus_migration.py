"""Prepare the existing processed corpus for a later global merge/reindex.

This module intentionally implements three separate, non-destructive phases:

``export-existing``
    Export one UTF-8 whole-book file per legacy processed work.  Cleaned chapter
    payloads are preferred over raw inputs.  No final corpus id is assigned.

``build-id-map``
    Verify the organizer's completed ``index.jsonl`` against every retained
    processed export and its adjacent provenance sidecar.  A matching frozen
    organizer plan supplies content-derived relations for source duplicates
    intentionally omitted from the public index.  The resulting explicit map
    closes the gap between global dedupe and legacy identities without
    guessing from titles or filenames.

``reindex-staging``
    Consume an explicit old-identity -> ``idNNNNNN`` mapping produced after the
    exported works have gone through the global classify/deduplicate merge.  It
    writes a new staging tree and rewritten JSON reference copies; it never
    switches or edits the live Library tree.

The default CLI mode is a dry run.  Files are written only when ``--plan-dir``,
``build-id-map --output-id-map``, or ``--apply --staging-root`` is explicitly
supplied.
"""

from __future__ import annotations

import argparse
import codecs
from concurrent.futures import (
    FIRST_COMPLETED,
    Future,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    wait,
)
from dataclasses import dataclass, field
from functools import partial
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Iterator
import uuid

from fetcher.local_resources import available_cpu_count
from shared import chapter_id_for


EXPORT_LAYOUT_VERSION = "processed-existing-export-v1"
REINDEX_LAYOUT_VERSION = "processed-corpus-reindex-v1"
ID_MAP_LAYOUT_VERSION = "processed-corpus-id-map-v1"
ORGANIZER_INDEX_SCHEMA = "literary-giant-flat-index-v3"
EXISTING_PROCESSED_SOURCE_KIND = "existing_processed"
EXISTING_PROCESSED_SOURCE_PRIORITY = 100
CANONICAL_ID_RE = re.compile(r"^id(?P<number>\d{6})$")
IDENTITY_KEY_RE = re.compile(
    r"^(?:(?:book|story):(?:book|story)_\d+|id:id\d{6})$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EDITION_ID_RE = re.compile(r"^ed_[0-9a-f]{24}$")
WORK_ID_RE = re.compile(r"^work_\d{6}$")
LEGACY_SLUG_RE = re.compile(r"^(?P<kind>book|story)_(?P<number>\d+)$")
LEGACY_CHAPTER_RE = re.compile(
    r"^(?:(?P<kind>book|story)_)?(?P<number>\d+)[Cc](?P<chapter>\d+)$"
)
CANONICAL_CHAPTER_RE = re.compile(
    r"^(?P<content_id>id\d{6})C(?P<chapter>\d{1,6})$"
)
LAYOUT_PATH_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("TaciturnRaw/stories_raw", "TaciturnRaw/00_Stories"),
    ("TaciturnRaw/novels_raw", "TaciturnRaw/01_RawData"),
    ("TaciturnRaw/novels_cleaned", "TaciturnRaw/02_CleanedData"),
    ("TaciturnRaw/novels_chapter", "TaciturnRaw/03_ChapterAnalysis"),
    ("reference/facts/cleaned_chapters", "TaciturnRaw/02_CleanedData"),
    ("reference/facts/chapter_features", "TaciturnRaw/03_ChapterAnalysis"),
    ("rawdata/novels", "TaciturnRaw/01_RawData"),
    ("rawdata/stories", "TaciturnRaw/00_Stories"),
)


@dataclass(frozen=True, slots=True)
class StageSpec:
    name: str
    relative_root: str
    kind: str
    content_priority: int | None
    legacy_relative_roots: tuple[str, ...] = ()


STAGE_SPECS = (
    StageSpec(
        "novels_cleaned",
        "TaciturnRaw/02_CleanedData",
        "book",
        0,
        ("TaciturnRaw/novels_cleaned",),
    ),
    StageSpec("stories_cleaned", "TaciturnRaw/stories_cleaned", "story", 0),
    # novels_chapter contains semantic features and references, not authoritative
    # cleaned prose.  It is scanned for lineage/reindexing only.
    StageSpec(
        "novels_chapter",
        "TaciturnRaw/03_ChapterAnalysis",
        "book",
        None,
        ("TaciturnRaw/novels_chapter",),
    ),
    StageSpec(
        "novels_raw",
        "TaciturnRaw/01_RawData",
        "book",
        20,
        ("TaciturnRaw/novels_raw",),
    ),
    StageSpec(
        "stories_raw",
        "TaciturnRaw/00_Stories",
        "story",
        20,
        ("TaciturnRaw/stories_raw",),
    ),
    StageSpec("novels_bridge", "Bridges/novels_plot", "book", None),
    StageSpec("stories_bridge", "Bridges/stories_plot", "story", None),
)


@dataclass(slots=True)
class ExistingEntity:
    identity_key: str
    kind: str
    old_slug: str
    title: str = ""
    author: str = ""
    stages: dict[str, Path] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChapterText:
    order: int
    title: str
    content: str
    source_path: str
    old_chapter_id: str = ""


@dataclass(frozen=True, slots=True)
class Assembly:
    text: str
    chapters: tuple[dict[str, Any], ...]
    source_stage: str
    source_path: str
    segmented: bool
    omitted_chapters: tuple[dict[str, Any], ...] = ()

    @property
    def payload(self) -> bytes:
        payload = self.text.encode("utf-8")
        if payload.startswith(b"\xef\xbb\xbf"):
            raise ValueError("assembled UTF-8 payload unexpectedly contains a BOM")
        return payload

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.payload).hexdigest()


@dataclass(frozen=True, slots=True)
class VerifiedProcessedSource:
    path: str
    provenance_path: str
    identity_key: str
    source_sha256: str
    source_utf8_bytes: int


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return payload


def _try_load_json_object(path: Path) -> dict[str, Any]:
    try:
        return _load_json_object(path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        return {}


def _normalise_text(text: str) -> str:
    return text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")


def _read_text_with_fallbacks(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return _normalise_text(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    raise UnicodeError(f"could not strictly decode text input: {path}")


def _library_relative(path: Path, library_root: Path) -> str:
    try:
        return path.resolve().relative_to(library_root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def _safe_member(parent: Path, member: str) -> Path:
    candidate = (parent / member).resolve()
    try:
        candidate.relative_to(parent.resolve())
    except ValueError as exc:
        raise ValueError(f"manifest path escapes source directory: {member!r}") from exc
    return candidate


def _identity_for_slug(slug: str, kind_hint: str) -> tuple[str, str, str] | None:
    canonical = CANONICAL_ID_RE.fullmatch(slug)
    if canonical:
        return f"id:{slug}", kind_hint, slug
    legacy = LEGACY_SLUG_RE.fullmatch(slug)
    if legacy:
        kind = legacy.group("kind")
        return f"{kind}:{slug}", kind, slug
    return None


def _metadata_from_index(path: Path) -> tuple[str, str]:
    payload = _try_load_json_object(path / "index.json")
    metadata = payload.get("book_metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    lineage = metadata.get("source_lineage")
    if not isinstance(lineage, dict):
        lineage = {}
    title = str(
        payload.get("title")
        or metadata.get("title")
        or lineage.get("title")
        or ""
    ).strip()
    author = str(
        payload.get("author")
        or metadata.get("author")
        or lineage.get("author")
        or ""
    ).strip()
    return title, author


def discover_existing_entities(
    library_root: str | Path,
    *,
    legacy_only: bool = False,
) -> list[ExistingEntity]:
    """Discover entities across raw/cleaned/chapter/Bridge roots.

    During the one-time legacy migration, canonical ``idNNNNNN`` directories
    may already exist as provisional output.  They must not be accidentally
    exported alongside ``book_*``/``story_*`` records: numeric legacy slugs do
    not imply the same final canonical ID.  ``legacy_only`` provides that
    explicit safety boundary for a recovery snapshot.
    """
    root = Path(library_root).resolve()
    entities: dict[str, ExistingEntity] = {}
    for spec in STAGE_SPECS:
        relative_roots = (spec.relative_root, *spec.legacy_relative_roots)
        for relative_root in relative_roots:
            stage_root = root / relative_root
            if not stage_root.is_dir():
                continue
            for child in sorted(stage_root.iterdir(), key=lambda item: item.name):
                if not child.is_dir():
                    continue
                identity = _identity_for_slug(child.name, spec.kind)
                if identity is None:
                    continue
                identity_key, kind, old_slug = identity
                if legacy_only and identity_key.startswith("id:"):
                    continue
                entity = entities.setdefault(
                    identity_key,
                    ExistingEntity(identity_key=identity_key, kind=kind, old_slug=old_slug),
                )
                # Prefer the v2 physical root if both roots temporarily exist
                # during a resumable cutover.
                entity.stages.setdefault(spec.name, child)
                title, author = _metadata_from_index(child)
                if title and not entity.title:
                    entity.title = title
                if author and not entity.author:
                    entity.author = author
    return sorted(entities.values(), key=lambda item: (item.kind, item.old_slug))


def _manifest_entries(index: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("chapter_manifest", "chapters"):
        value = index.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _chapter_from_json(
    chapter_path: Path,
    entry: dict[str, Any],
    *,
    fallback_order: int,
) -> ChapterText:
    payload = _load_json_object(chapter_path)
    order_value = payload.get("order", entry.get("order", fallback_order))
    try:
        order = int(order_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid chapter order in {chapter_path}: {order_value!r}") from exc
    title = str(
        payload.get("clean_title")
        or entry.get("clean_title")
        or entry.get("title")
        or payload.get("raw_title")
        or f"第{order}章"
    ).strip()
    content = payload.get("content")
    if not isinstance(content, str):
        raise ValueError(f"chapter JSON has no string content: {chapter_path}")
    return ChapterText(
        order=order,
        title=_normalise_text(title).strip(),
        content=_normalise_text(content).strip(),
        source_path=str(chapter_path.resolve()),
        old_chapter_id=str(payload.get("chapter_id") or entry.get("chapter_id") or ""),
    )


def _chapter_from_text(
    chapter_path: Path,
    entry: dict[str, Any],
    *,
    fallback_order: int,
) -> ChapterText:
    try:
        order = int(entry.get("order", fallback_order))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid chapter order for {chapter_path}") from exc
    title = str(entry.get("clean_title") or entry.get("title") or chapter_path.stem).strip()
    content = _read_text_with_fallbacks(chapter_path).strip()
    # Canonical per-chapter TXT often includes the heading as its first line.
    lines = content.splitlines()
    if lines and title and lines[0].strip() == title:
        content = "\n".join(lines[1:]).lstrip()
    return ChapterText(
        order=order,
        title=_normalise_text(title).strip(),
        content=content,
        source_path=str(chapter_path.resolve()),
        old_chapter_id=str(entry.get("chapter_id") or ""),
    )


def _chapter_from_manifest_entry(
    source_dir: Path,
    index_path: Path,
    entry: dict[str, Any],
    *,
    fallback_order: int,
) -> ChapterText | None:
    """Load one manifest entry while preserving the strict legacy semantics."""

    file_name = str(entry.get("file_name") or "").strip()
    if not file_name:
        content = entry.get("content")
        if not isinstance(content, str):
            return None
        try:
            order = int(entry.get("order", fallback_order))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid inline chapter order in {index_path}") from exc
        return ChapterText(
            order=order,
            title=str(entry.get("clean_title") or entry.get("title") or f"第{order}章").strip(),
            content=_normalise_text(content).strip(),
            source_path=str(index_path.resolve()),
            old_chapter_id=str(entry.get("chapter_id") or ""),
        )
    chapter_path = _safe_member(source_dir, file_name)
    if not chapter_path.is_file():
        raise FileNotFoundError(f"manifest chapter is missing: {chapter_path}")
    if chapter_path.suffix.lower() == ".json":
        return _chapter_from_json(chapter_path, entry, fallback_order=fallback_order)
    if chapter_path.suffix.lower() == ".txt":
        return _chapter_from_text(chapter_path, entry, fallback_order=fallback_order)
    raise ValueError(f"unsupported manifest chapter type: {chapter_path}")


def _load_manifest_chapters(source_dir: Path) -> list[ChapterText]:
    index_path = source_dir / "index.json"
    if not index_path.exists():
        return []
    index = _load_json_object(index_path)
    entries = _manifest_entries(index)
    chapters: list[ChapterText] = []
    for fallback_order, entry in enumerate(entries, start=1):
        chapter = _chapter_from_manifest_entry(
            source_dir,
            index_path,
            entry,
            fallback_order=fallback_order,
        )
        if chapter is not None:
            chapters.append(chapter)
    return chapters


def _load_recoverable_manifest_chapters(
    source_dir: Path,
) -> tuple[list[ChapterText], list[dict[str, Any]], int]:
    """Load a cleaned manifest and audit explicitly unusable chapter payloads.

    Recovery is deliberately narrow: it is only used after every strict content
    stage failed, and the caller enforces a small omission ratio.  Missing,
    malformed, or empty chapters are never silently represented as prose.
    """

    index_path = source_dir / "index.json"
    if not index_path.exists():
        return [], [], 0
    index = _load_json_object(index_path)
    entries = _manifest_entries(index)
    chapters: list[ChapterText] = []
    omissions: list[dict[str, Any]] = []
    for fallback_order, entry in enumerate(entries, start=1):
        file_name = str(entry.get("file_name") or "").strip()
        try:
            chapter = _chapter_from_manifest_entry(
                source_dir,
                index_path,
                entry,
                fallback_order=fallback_order,
            )
            if chapter is None:
                raise ValueError("manifest entry has neither a file nor inline content")
            if not chapter.content.strip():
                raise ValueError("empty chapter content")
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            omissions.append(
                {
                    "manifest_order": fallback_order,
                    "order": entry.get("order", fallback_order),
                    "file_name": file_name,
                    "chapter_id": str(entry.get("chapter_id") or ""),
                    "reason": str(exc),
                }
            )
            continue
        chapters.append(chapter)
    return chapters, omissions, len(entries)


def _load_discovered_chapters(source_dir: Path) -> list[ChapterText]:
    chapters: list[ChapterText] = []
    json_files = sorted(source_dir.glob("chapter_*.json"))
    if json_files:
        for fallback_order, chapter_path in enumerate(json_files, start=1):
            chapters.append(_chapter_from_json(chapter_path, {}, fallback_order=fallback_order))
        return chapters
    txt_files = sorted(source_dir.glob("chapter_*.txt"))
    for fallback_order, chapter_path in enumerate(txt_files, start=1):
        chapters.append(_chapter_from_text(chapter_path, {}, fallback_order=fallback_order))
    return chapters


def _assemble_chapters(
    chapters: Iterable[ChapterText],
    *,
    source_stage: str,
    source_path: Path,
) -> Assembly:
    ordered = sorted(chapters, key=lambda item: (item.order, item.source_path))
    if not ordered:
        raise ValueError(f"no chapters available under {source_path}")
    orders = [item.order for item in ordered]
    if len(set(orders)) != len(orders):
        raise ValueError(f"duplicate chapter orders under {source_path}")

    output = bytearray()
    chapter_index: list[dict[str, Any]] = []
    for chapter in ordered:
        title = _normalise_text(chapter.title).strip()
        content = _normalise_text(chapter.content).strip()
        if not content:
            raise ValueError(f"empty chapter content: {chapter.source_path}")
        section = f"{title}\n\n{content}\n\n" if title else f"{content}\n\n"
        section_bytes = section.encode("utf-8")
        byte_start = len(output)
        output.extend(section_bytes)
        chapter_index.append(
            {
                "order": chapter.order,
                "title": title,
                "old_chapter_id": chapter.old_chapter_id,
                "byte_start": byte_start,
                "byte_end": len(output),
                "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "source_path": chapter.source_path,
            }
        )
    text = bytes(output).decode("utf-8").rstrip() + "\n"
    return Assembly(
        text=text,
        chapters=tuple(chapter_index),
        source_stage=source_stage,
        source_path=str(source_path.resolve()),
        segmented=True,
    )


def _assemble_whole_file(path: Path, *, source_stage: str) -> Assembly:
    text = _read_text_with_fallbacks(path).strip()
    if not text:
        raise ValueError(f"whole-book source is empty: {path}")
    text += "\n"
    payload = text.encode("utf-8")
    return Assembly(
        text=text,
        chapters=(
            {
                "order": 1,
                "title": "",
                "old_chapter_id": "",
                "byte_start": 0,
                "byte_end": len(payload),
                "content_sha256": hashlib.sha256(text.rstrip().encode("utf-8")).hexdigest(),
                "source_path": str(path.resolve()),
            },
        ),
        source_stage=source_stage,
        source_path=str(path.resolve()),
        segmented=False,
    )


def assemble_stage(stage_name: str, source_dir: str | Path) -> Assembly:
    """Assemble one stage directory into a deterministic UTF-8 whole book."""
    source = Path(source_dir)
    # Cleaned manifests are authoritative.  A manifest error must not silently
    # fall back to an unrelated file in the same stage.
    manifest_chapters = _load_manifest_chapters(source)
    if manifest_chapters:
        return _assemble_chapters(
            manifest_chapters,
            source_stage=stage_name,
            source_path=source,
        )
    nested_chapters = source / "chapters"
    if nested_chapters.is_dir():
        chapters = _load_manifest_chapters(nested_chapters) or _load_discovered_chapters(nested_chapters)
        if chapters:
            return _assemble_chapters(
                chapters,
                source_stage=stage_name,
                source_path=nested_chapters,
            )
    if stage_name.endswith("_cleaned"):
        chapters = _load_discovered_chapters(source)
        if chapters:
            return _assemble_chapters(chapters, source_stage=stage_name, source_path=source)
    for name in ("source.txt", "story.txt"):
        whole_path = source / name
        if whole_path.is_file():
            return _assemble_whole_file(whole_path, source_stage=stage_name)
    chapters = _load_discovered_chapters(source)
    if chapters:
        return _assemble_chapters(chapters, source_stage=stage_name, source_path=source)
    raise ValueError(f"stage contains no usable prose: {source}")


def _content_stage_specs(entity: ExistingEntity) -> list[StageSpec]:
    specs = [
        spec
        for spec in STAGE_SPECS
        if spec.name in entity.stages and spec.content_priority is not None
    ]
    return sorted(specs, key=lambda item: (int(item.content_priority or 0), item.name))


def assemble_entity(entity: ExistingEntity) -> Assembly:
    errors: list[str] = []
    for spec in _content_stage_specs(entity):
        try:
            return assemble_stage(spec.name, entity.stages[spec.name])
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{spec.name}: {exc}")
    # A few legacy cleaned books contain explicit empty/failed placeholder
    # chapters.  Retain the usable processed book only when the damage is both
    # small and fully auditable; this recovery runs after every strict stage.
    for spec in _content_stage_specs(entity):
        if not spec.name.endswith("_cleaned"):
            continue
        source = entity.stages[spec.name]
        try:
            chapters, omissions, manifest_count = _load_recoverable_manifest_chapters(source)
            omission_count = len(omissions)
            if not omissions:
                continue
            omission_ratio = omission_count / max(1, manifest_count)
            if omission_count > 16 or omission_ratio > 0.05:
                raise ValueError(
                    "recoverable omissions exceed guardrail: "
                    f"{omission_count}/{manifest_count} ({omission_ratio:.2%})"
                )
            assembly = _assemble_chapters(
                chapters,
                source_stage=spec.name,
                source_path=source,
            )
            return Assembly(
                text=assembly.text,
                chapters=assembly.chapters,
                source_stage=assembly.source_stage,
                source_path=assembly.source_path,
                segmented=assembly.segmented,
                omitted_chapters=tuple(omissions),
            )
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{spec.name}-recovery: {exc}")
    if errors:
        raise ValueError("; ".join(errors))
    raise ValueError("entity has no raw or cleaned prose stage")


def _export_key(entity: ExistingEntity) -> str:
    return f"{entity.kind}_{entity.old_slug}"


def _entity_from_export_record(
    record: dict[str, Any],
    library_root: Path,
) -> ExistingEntity:
    """Rebuild an entity from an already-audited plan without rescanning indexes."""

    known_stages = {spec.name for spec in STAGE_SPECS}
    stages_payload = record.get("stages")
    if not isinstance(stages_payload, dict):
        raise ValueError(f"export record has invalid stages: {record.get('identity_key')}")
    stages: dict[str, Path] = {}
    for name, relative_path in stages_payload.items():
        if name not in known_stages:
            raise ValueError(f"export record has unknown stage {name!r}")
        text_path = str(relative_path or "").strip()
        if not text_path or Path(text_path).is_absolute():
            raise ValueError(f"export record has unsafe stage path: {relative_path!r}")
        stages[name] = _safe_member(library_root, text_path)
    return ExistingEntity(
        identity_key=str(record["identity_key"]),
        kind=str(record["kind"]),
        old_slug=str(record["old_slug"]),
        title=str(record.get("title") or ""),
        author=str(record.get("author") or ""),
        stages=stages,
    )


def _bounded_process_map(
    items: Iterable[Any],
    worker,
    *,
    workers: int,
) -> Iterator[Any]:
    """Use the detected CPU quota without retaining every large result."""

    if workers < 1:
        raise ValueError("workers must be >= 1")
    if workers == 1:
        for item in items:
            yield worker(item)
        return

    iterator = iter(items)
    max_pending = max(2, workers * 2)
    with ProcessPoolExecutor(
        max_workers=workers,
    ) as executor:
        pending: set[Future[Any]] = set()

        def fill() -> None:
            while len(pending) < max_pending:
                try:
                    item = next(iterator)
                except StopIteration:
                    return
                pending.add(executor.submit(worker, item))

        fill()
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                yield future.result()
            fill()


def _build_export_record(entity: ExistingEntity, root: Path) -> dict[str, Any]:
    record: dict[str, Any] = {
        "identity_key": entity.identity_key,
        "export_key": _export_key(entity),
        "kind": entity.kind,
        "old_slug": entity.old_slug,
        "title": entity.title,
        "author": entity.author,
        "stages": {
            name: _library_relative(path, root)
            for name, path in sorted(entity.stages.items())
        },
    }
    try:
        assembly = assemble_entity(entity)
        payload = assembly.payload
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        record["status"] = "unavailable"
        record["error"] = str(exc)
    else:
        record.update(
            {
                "status": "ready",
                "selected_stage": assembly.source_stage,
                "selected_source": assembly.source_path,
                "segmented": assembly.segmented,
                "chapter_count": len(assembly.chapters),
                "omitted_chapter_count": len(assembly.omitted_chapters),
                "omitted_chapters": list(assembly.omitted_chapters),
                "utf8_bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    return record


def _summarize_export_records(
    records: list[dict[str, Any]],
    *,
    workers: int,
) -> dict[str, Any]:
    ready = sum(item.get("status") == "ready" for item in records)
    return {
        "entities": len(records),
        "ready": ready,
        "unavailable": len(records) - ready,
        "utf8_bytes": sum(int(item.get("utf8_bytes") or 0) for item in records),
        "chapters": sum(int(item.get("chapter_count") or 0) for item in records),
        "omitted_chapters": sum(
            int(item.get("omitted_chapter_count") or 0) for item in records
        ),
        "workers": workers,
        "output_scope": "whole_text_plus_provenance_import_staging",
        "final_ids_assigned": False,
        "classification_bypassed": False,
        "live_switch_ready": False,
    }


def build_export_plan(
    library_root: str | Path,
    *,
    workers: int | None = None,
    legacy_only: bool = False,
) -> dict[str, Any]:
    """Build an in-memory, read-only export plan."""
    root = Path(library_root).resolve()
    configured_workers = max(1, int(workers or available_cpu_count()))
    entities = discover_existing_entities(root, legacy_only=legacy_only)
    records = list(
        _bounded_process_map(
            entities,
            partial(_build_export_record, root=root),
            workers=configured_workers,
        )
    )
    records.sort(key=lambda item: str(item.get("identity_key") or ""))
    return {
        "layout_version": EXPORT_LAYOUT_VERSION,
        "library_root": str(root),
        "records": records,
        "summary": {
            **_summarize_export_records(records, workers=configured_workers),
            "legacy_only": legacy_only,
        },
    }


def load_export_plan(
    plan_dir: str | Path,
    *,
    library_root: str | Path,
    workers: int,
    refresh_unavailable: bool = False,
) -> dict[str, Any]:
    """Reuse a completed plan and optionally re-evaluate only failed entities."""

    directory = Path(plan_dir)
    records_path = directory / "export_plan.jsonl"
    records: list[dict[str, Any]] = []
    with records_path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            if not isinstance(record, dict) or not record.get("identity_key"):
                raise ValueError(f"invalid export plan record at line {line_no}")
            records.append(record)
    identities = [str(item["identity_key"]) for item in records]
    if len(identities) != len(set(identities)):
        raise ValueError(f"duplicate identities in export plan: {records_path}")

    root = Path(library_root).resolve()
    if refresh_unavailable:
        failed_records = [item for item in records if item.get("status") != "ready"]
        refreshed = {
            str(item["identity_key"]): item
            for item in _bounded_process_map(
                (_entity_from_export_record(item, root) for item in failed_records),
                partial(_build_export_record, root=root),
                workers=min(max(1, workers), max(1, len(failed_records))),
            )
        }
        records = [refreshed.get(str(item["identity_key"]), item) for item in records]
    records.sort(key=lambda item: str(item.get("identity_key") or ""))
    return {
        "layout_version": EXPORT_LAYOUT_VERSION,
        "library_root": str(root),
        "records": records,
        "summary": _summarize_export_records(records, workers=workers),
    }


def _atomic_write_bytes(path: Path, payload: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.is_file() and path.read_bytes() == payload:
            return "unchanged"
        raise FileExistsError(f"refusing to overwrite a different staging file: {path}")
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    with temp.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    return "written"


def _json_bytes(payload: Any) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _jsonl_bytes(rows: Iterable[dict[str, Any]]) -> bytes:
    return b"".join(
        (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        for row in rows
    )


def _validate_staging_root(staging_root: Path, library_root: Path) -> None:
    staging = staging_root.resolve()
    library = library_root.resolve()
    live_roots = (
        library / "TaciturnRaw",
        library / "Bridges",
        library / "AbstractLibrary",
    )
    for live in live_roots:
        try:
            staging.relative_to(live.resolve())
        except ValueError:
            continue
        raise ValueError(f"staging root must not be inside live corpus root: {live}")


def write_export_plan(plan: dict[str, Any], plan_dir: str | Path) -> None:
    output = Path(plan_dir)
    _atomic_write_bytes(output / "summary.json", _json_bytes(plan["summary"]))
    _atomic_write_bytes(output / "export_plan.jsonl", _jsonl_bytes(plan["records"]))


def _materialize_export_record(
    task: tuple[dict[str, Any], ExistingEntity | None, Path],
) -> tuple[str, dict[str, Any]]:
    record, entity, staging = task
    if entity is None:
        return "failed", {
            "identity_key": record["identity_key"],
            "export_key": record["export_key"],
            "status": "failed",
            "error": "entity disappeared after planning",
        }
    try:
        assembly = assemble_entity(entity)
        payload = assembly.payload
        payload_sha256 = hashlib.sha256(payload).hexdigest()
        if payload_sha256 != record["sha256"]:
            raise ValueError(f"source changed after planning: {entity.identity_key}")
        target = staging / "imports" / record["export_key"]
        state = _atomic_write_bytes(target / "source.txt", payload)
        provenance = {
            "layout_version": EXPORT_LAYOUT_VERSION,
            "identity_key": entity.identity_key,
            "export_key": record["export_key"],
            "kind": entity.kind,
            "old_slug": entity.old_slug,
            "title": entity.title,
            "author": entity.author,
            "existing_processed": True,
            "source_kind": EXISTING_PROCESSED_SOURCE_KIND,
            "source_priority": EXISTING_PROCESSED_SOURCE_PRIORITY,
            "selected_stage": assembly.source_stage,
            "selected_source": assembly.source_path,
            "stages": record["stages"],
            "segmented": assembly.segmented,
            "chapter_count": len(assembly.chapters),
            "omitted_chapter_count": len(assembly.omitted_chapters),
            "omitted_chapters": list(assembly.omitted_chapters),
            "source_sha256": payload_sha256,
            "source_utf8_bytes": len(payload),
            "chapter_index": list(assembly.chapters),
        }
        _atomic_write_bytes(target / "provenance.json", _json_bytes(provenance))
        return state, {
            key: provenance[key]
            for key in (
                "identity_key",
                "export_key",
                "kind",
                "old_slug",
                "title",
                "author",
                "existing_processed",
                "source_kind",
                "source_priority",
                "selected_stage",
                "chapter_count",
                "omitted_chapter_count",
                "source_sha256",
                "source_utf8_bytes",
            )
        }
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        return "failed", {
            "identity_key": record["identity_key"],
            "export_key": record["export_key"],
            "status": "failed",
            "error": str(exc),
        }


def apply_export_plan(
    plan: dict[str, Any],
    staging_root: str | Path,
    *,
    workers: int | None = None,
) -> dict[str, Any]:
    """Materialise exports into staging; never edit or switch the live corpus."""
    library_root = Path(plan["library_root"])
    staging = Path(staging_root)
    _validate_staging_root(staging, library_root)
    entities = {
        str(record["identity_key"]): _entity_from_export_record(record, library_root)
        for record in plan["records"]
    }
    configured_workers = max(1, int(workers or available_cpu_count()))
    manifest_rows: list[dict[str, Any]] = []
    written = unchanged = failed = 0

    ready_records = [
        record for record in plan["records"] if record.get("status") == "ready"
    ]
    tasks = [
        (record, entities.get(record["identity_key"]), staging)
        for record in ready_records
    ]
    for state, manifest_row in _bounded_process_map(
        tasks,
        _materialize_export_record,
        workers=configured_workers,
    ):
        manifest_rows.append(manifest_row)
        if state == "written":
            written += 1
        elif state == "unchanged":
            unchanged += 1
        else:
            failed += 1
    manifest_rows.sort(key=lambda item: str(item.get("identity_key") or ""))
    _atomic_write_bytes(staging / "export_manifest.jsonl", _jsonl_bytes(manifest_rows))
    _atomic_write_bytes(
        staging / "export_marker.json",
        _json_bytes(
            {
                "layout_version": EXPORT_LAYOUT_VERSION,
                "stage_kind": "existing_processed_import_staging",
                "source_kind": EXISTING_PROCESSED_SOURCE_KIND,
                "source_priority": EXISTING_PROCESSED_SOURCE_PRIORITY,
                "manifest": "export_manifest.jsonl",
                "imports_root": "imports",
                "live_switch_performed": False,
            }
        ),
    )
    write_export_plan(plan, staging / "_plan")
    return {
        "written": written,
        "unchanged": unchanged,
        "failed": failed,
        "workers": configured_workers,
        "staging_root": str(staging.resolve()),
    }


def _canonical_id(value: object, *, context: str) -> str:
    canonical = str(value)
    match = CANONICAL_ID_RE.fullmatch(canonical)
    if match is None or int(match.group("number")) == 0:
        raise ValueError(f"invalid canonical id for {context}: {value!r}")
    return canonical


def _positive_json_int(
    value: object,
    *,
    context: str,
    maximum: int | None = None,
) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{context} must be a positive JSON integer: {value!r}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{context} is out of range: {value!r}")
    return value


def _identity_key(value: object, *, context: str) -> str:
    identity = str(value)
    if not IDENTITY_KEY_RE.fullmatch(identity):
        raise ValueError(f"invalid legacy identity for {context}: {value!r}")
    namespace, slug = identity.split(":", 1)
    if namespace == "id":
        _canonical_id(slug, context=context)
    else:
        legacy = LEGACY_SLUG_RE.fullmatch(slug)
        if legacy is None or legacy.group("kind") != namespace:
            raise ValueError(f"mismatched legacy identity for {context}: {value!r}")
    return identity


def _normalise_id_map(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("layout_version") != ID_MAP_LAYOUT_VERSION:
        raise ValueError(
            "id map layout_version must be "
            f"{ID_MAP_LAYOUT_VERSION!r}, got {payload.get('layout_version')!r}"
        )
    raw_mappings = payload.get("mappings")
    if not isinstance(raw_mappings, dict):
        raise ValueError("id map must contain an object named 'mappings'")
    mappings: dict[str, str] = {}
    for identity, canonical_id in raw_mappings.items():
        legacy_identity = _identity_key(identity, context="id map mappings")
        canonical = _canonical_id(canonical_id, context=legacy_identity)
        mappings[legacy_identity] = canonical
    representatives = payload.get("representatives")
    if not isinstance(representatives, dict):
        raise ValueError("id map must contain an object named 'representatives'")
    normalised_representatives: dict[str, str] = {}
    for canonical_id, identity in representatives.items():
        canonical = _canonical_id(canonical_id, context="id map representatives")
        legacy_identity = _identity_key(identity, context=f"representative {canonical}")
        mapped = mappings.get(legacy_identity)
        if mapped != canonical:
            raise ValueError(
                f"representative {legacy_identity!r} is not mapped to {canonical}: {mapped!r}"
            )
        normalised_representatives[canonical] = legacy_identity
    occupied = payload.get("occupied_ids")
    if not isinstance(occupied, list):
        raise ValueError("id map must contain an array named 'occupied_ids'")
    normalised_occupied = {
        _canonical_id(value, context="occupied_ids") for value in occupied
    }
    normalised_occupied.update(mappings.values())
    return {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "mappings": dict(sorted(mappings.items())),
        "representatives": dict(sorted(normalised_representatives.items())),
        "occupied_ids": sorted(normalised_occupied),
    }


def load_id_map(path: str | Path) -> dict[str, Any]:
    return _normalise_id_map(_load_json_object(Path(path)))


def _merge_id_maps(
    generated: dict[str, Any],
    base: dict[str, Any] | None,
) -> dict[str, Any]:
    base_map = _normalise_id_map(base) if base is not None else {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "mappings": {},
        "representatives": {},
        "occupied_ids": [],
    }
    mappings = dict(base_map["mappings"])
    for identity, canonical in generated["mappings"].items():
        previous = mappings.get(identity)
        if previous is not None and previous != canonical:
            raise ValueError(
                f"mapping conflict for {identity}: base={previous}, organizer={canonical}"
            )
        mappings[identity] = canonical

    representatives = dict(base_map["representatives"])
    for canonical, identity in generated["representatives"].items():
        previous = representatives.get(canonical)
        if previous is not None and previous != identity:
            raise ValueError(
                f"representative conflict for {canonical}: "
                f"base={previous}, organizer={identity}"
            )
        representatives[canonical] = identity
    for canonical, identity in representatives.items():
        if mappings.get(identity) != canonical:
            raise ValueError(
                f"representative {identity!r} is not mapped to {canonical} after merge"
            )

    occupied = set(base_map["occupied_ids"])
    occupied.update(generated["occupied_ids"])
    occupied.update(mappings.values())
    return {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "mappings": dict(sorted(mappings.items())),
        "representatives": dict(sorted(representatives.items())),
        "occupied_ids": sorted(occupied),
    }


def _strict_json_line(raw_line: str, *, path: Path, line_no: int) -> dict[str, Any]:
    def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        for key, value in pairs:
            if key in payload:
                raise ValueError(
                    f"duplicate JSON key {key!r} at {path}:{line_no}"
                )
            payload[key] = value
        return payload

    try:
        payload = json.loads(raw_line, object_pairs_hook=no_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON at {path}:{line_no}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"organizer index row must be an object at {path}:{line_no}")
    return payload


def _organizer_canonical_id(row: dict[str, Any], *, line_no: int) -> str | None:
    context = f"organizer index line {line_no}"
    if row.get("schema") != ORGANIZER_INDEX_SCHEMA:
        raise ValueError(
            f"unsupported organizer schema at line {line_no}: {row.get('schema')!r}"
        )
    library_value = row.get("library_id")
    if library_value is None:
        if any(row.get(key) is not None for key in ("book_id", "content_id", "catalog_id")):
            raise ValueError(f"partial canonical id fields at {context}")
        if str(row.get("source_kind") or "") == EXISTING_PROCESSED_SOURCE_KIND:
            raise ValueError(f"processed source has no final id at {context}")
        if str(row.get("import_status") or "") not in {
            "deleted_invalid",
            "invalid_rejected",
            "deleted_conversion_failure",
            "conversion_rejected",
        }:
            raise ValueError(f"non-rejected organizer row has no final id at {context}")
        return None

    library_id = _positive_json_int(
        library_value,
        context=f"library_id at line {line_no}",
        maximum=999_999,
    )
    canonical = f"id{library_id:06d}"
    for field_name in ("book_id", "content_id"):
        if row.get(field_name) != canonical:
            raise ValueError(
                f"{field_name} disagrees with library_id at line {line_no}: "
                f"{row.get(field_name)!r} != {canonical!r}"
            )
    category_code = str(row.get("category_code") or "")
    if not re.fullmatch(r"\d{2}", category_code):
        raise ValueError(f"invalid category_code at line {line_no}: {category_code!r}")
    expected_catalog = f"{category_code}_{canonical}"
    if row.get("catalog_id") != expected_catalog:
        raise ValueError(
            f"catalog_id disagrees with final id at line {line_no}: "
            f"{row.get('catalog_id')!r} != {expected_catalog!r}"
        )
    if row.get("import_status") != "complete":
        raise ValueError(
            f"assigned organizer row is not complete at line {line_no}: "
            f"{row.get('import_status')!r}"
        )
    return canonical


def _organizer_cluster_signature(
    row: dict[str, Any],
    *,
    line_no: int,
) -> tuple[str, str, str, int]:
    edition_id = str(row.get("edition_id") or "")
    if not EDITION_ID_RE.fullmatch(edition_id):
        raise ValueError(f"invalid edition_id at line {line_no}: {edition_id!r}")
    if row.get("edition_key") != edition_id:
        raise ValueError(f"edition_key disagrees with edition_id at line {line_no}")
    work_id = str(row.get("work_id") or "")
    if not WORK_ID_RE.fullmatch(work_id):
        raise ValueError(f"invalid work_id at line {line_no}: {work_id!r}")
    visible_file = str(row.get("file") or "")
    if not visible_file:
        raise ValueError(f"completed organizer row has no visible file at line {line_no}")
    version = _positive_json_int(
        row.get("edition_version"),
        context=f"edition_version at line {line_no}",
    )
    return edition_id, work_id, visible_file, version


def _source_path_from_index(row: dict[str, Any], *, line_no: int) -> Path:
    root_value = str(row.get("source_root") or "")
    relative_value = str(row.get("source_relative_path") or "")
    root = Path(root_value)
    relative = Path(relative_value)
    if not root_value or not root.is_absolute():
        raise ValueError(f"source_root must be absolute at line {line_no}: {root_value!r}")
    if not relative_value or relative.is_absolute():
        raise ValueError(
            f"source_relative_path must be relative at line {line_no}: {relative_value!r}"
        )
    resolved_root = root.resolve()
    source = (resolved_root / relative).resolve()
    try:
        source.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError(f"source_relative_path escapes source_root at line {line_no}") from exc
    if source.name != "source.txt":
        raise ValueError(
            f"processed source must be an exported source.txt at line {line_no}: {source}"
        )
    if not source.is_file():
        raise FileNotFoundError(
            f"processed source is missing (retain/copy export staging): {source}"
        )
    return source


def _hash_strict_utf8(path: Path) -> tuple[str, int]:
    before = path.stat()
    digest = hashlib.sha256()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
    size = 0
    first = True
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                if first:
                    first = False
                    if chunk.startswith(codecs.BOM_UTF8):
                        raise ValueError(f"processed export contains a UTF-8 BOM: {path}")
                digest.update(chunk)
                size += len(chunk)
                decoder.decode(chunk, final=False)
            decoder.decode(b"", final=True)
    except UnicodeDecodeError as exc:
        raise ValueError(f"processed export is not strict UTF-8: {path}") from exc
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f"processed export changed while hashing: {path}")
    return digest.hexdigest(), size


def _verify_processed_source(
    row: dict[str, Any],
    *,
    line_no: int,
    cache: dict[Path, VerifiedProcessedSource],
) -> VerifiedProcessedSource:
    if row.get("source_priority") != EXISTING_PROCESSED_SOURCE_PRIORITY:
        raise ValueError(
            f"processed source priority mismatch at line {line_no}: "
            f"{row.get('source_priority')!r}"
        )
    source = _source_path_from_index(row, line_no=line_no)
    verified = cache.get(source)
    if verified is None:
        provenance_path = source.parent / "provenance.json"
        if not provenance_path.is_file():
            raise FileNotFoundError(f"processed export provenance is missing: {provenance_path}")
        provenance = _load_json_object(provenance_path)
        if provenance.get("layout_version") != EXPORT_LAYOUT_VERSION:
            raise ValueError(f"unsupported processed provenance: {provenance_path}")
        if provenance.get("existing_processed") is not True:
            raise ValueError(f"processed provenance lacks existing_processed=true: {provenance_path}")
        if provenance.get("source_kind") != EXISTING_PROCESSED_SOURCE_KIND:
            raise ValueError(f"processed provenance has invalid source_kind: {provenance_path}")
        if provenance.get("source_priority") != EXISTING_PROCESSED_SOURCE_PRIORITY:
            raise ValueError(f"processed provenance has invalid source_priority: {provenance_path}")
        identity = _identity_key(
            provenance.get("identity_key"),
            context=str(provenance_path),
        )
        export_key = str(provenance.get("export_key") or "")
        if not export_key or export_key != source.parent.name:
            raise ValueError(f"processed provenance export_key/path mismatch: {provenance_path}")
        kind = str(provenance.get("kind") or "")
        old_slug = str(provenance.get("old_slug") or "")
        parsed_identity = _identity_for_slug(old_slug, kind)
        if parsed_identity is None or parsed_identity[0] != identity:
            raise ValueError(f"processed provenance identity fields disagree: {provenance_path}")
        claimed_hash = str(provenance.get("source_sha256") or "")
        if not SHA256_RE.fullmatch(claimed_hash):
            raise ValueError(f"processed provenance has invalid source_sha256: {provenance_path}")
        actual_hash, actual_size = _hash_strict_utf8(source)
        if actual_hash != claimed_hash:
            raise ValueError(f"processed provenance hash mismatch: {provenance_path}")
        claimed_size = _positive_json_int(
            provenance.get("source_utf8_bytes"),
            context=f"source_utf8_bytes in {provenance_path}",
        )
        if claimed_size != actual_size:
            raise ValueError(f"processed provenance byte count mismatch: {provenance_path}")
        verified = VerifiedProcessedSource(
            path=str(source),
            provenance_path=str(provenance_path.resolve()),
            identity_key=identity,
            source_sha256=actual_hash,
            source_utf8_bytes=actual_size,
        )
        cache[source] = verified

    indexed_hash = str(row.get("raw_sha256") or "")
    if not SHA256_RE.fullmatch(indexed_hash):
        raise ValueError(f"invalid raw_sha256 at organizer index line {line_no}")
    if indexed_hash != verified.source_sha256:
        raise ValueError(
            f"organizer/source/provenance hash mismatch at line {line_no}: "
            f"{indexed_hash} != {verified.source_sha256}"
        )
    if row.get("source_encoding") != "utf-8":
        raise ValueError(
            f"processed source encoding is not utf-8 at line {line_no}: "
            f"{row.get('source_encoding')!r}"
        )
    return verified


def _load_export_inventory(import_root: str | Path) -> tuple[Path, dict[str, dict[str, Any]]]:
    root = Path(import_root).expanduser().resolve()
    marker_path = root / "export_marker.json"
    manifest_path = root / "export_manifest.jsonl"
    if not marker_path.is_file() or not manifest_path.is_file():
        raise FileNotFoundError(
            f"export staging must contain export_marker.json and export_manifest.jsonl: {root}"
        )
    marker = _load_json_object(marker_path)
    if marker.get("layout_version") != EXPORT_LAYOUT_VERSION:
        raise ValueError(f"unsupported export marker: {marker_path}")
    if marker.get("stage_kind") != "existing_processed_import_staging":
        raise ValueError(f"invalid export stage_kind: {marker_path}")
    if marker.get("source_kind") != EXISTING_PROCESSED_SOURCE_KIND:
        raise ValueError(f"invalid export marker source_kind: {marker_path}")
    if marker.get("source_priority") != EXISTING_PROCESSED_SOURCE_PRIORITY:
        raise ValueError(f"invalid export marker source_priority: {marker_path}")
    if marker.get("live_switch_performed") is not False:
        raise ValueError(f"export marker unexpectedly claims a live switch: {marker_path}")

    inventory: dict[str, dict[str, Any]] = {}
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            row = _strict_json_line(raw_line, path=manifest_path, line_no=line_no)
            if row.get("status") == "failed":
                raise ValueError(
                    f"export manifest contains a failed identity at line {line_no}: "
                    f"{row.get('identity_key')!r}"
                )
            if row.get("existing_processed") is not True:
                raise ValueError(f"invalid export manifest row at line {line_no}")
            if row.get("source_kind") != EXISTING_PROCESSED_SOURCE_KIND:
                raise ValueError(f"invalid export source_kind at manifest line {line_no}")
            if row.get("source_priority") != EXISTING_PROCESSED_SOURCE_PRIORITY:
                raise ValueError(f"invalid export source_priority at manifest line {line_no}")
            identity = _identity_key(
                row.get("identity_key"), context=f"export manifest line {line_no}"
            )
            if identity in inventory:
                raise ValueError(f"duplicate identity in export manifest: {identity}")
            export_key = str(row.get("export_key") or "")
            if not export_key or Path(export_key).name != export_key or export_key in {".", ".."}:
                raise ValueError(f"unsafe export_key at manifest line {line_no}: {export_key!r}")
            source = (root / "imports" / export_key / "source.txt").resolve()
            try:
                source.relative_to(root)
            except ValueError as exc:
                raise ValueError(f"export path escapes staging root at line {line_no}") from exc
            source_hash = str(row.get("source_sha256") or "")
            if not SHA256_RE.fullmatch(source_hash):
                raise ValueError(f"invalid source_sha256 at manifest line {line_no}")
            source_size = _positive_json_int(
                row.get("source_utf8_bytes"),
                context=f"source_utf8_bytes at manifest line {line_no}",
            )
            inventory[identity] = {
                "identity_key": identity,
                "export_key": export_key,
                "source_path": str(source),
                "source_sha256": source_hash,
                "source_utf8_bytes": source_size,
                "manifest_line": line_no,
            }
    return root, inventory


def _plan_cluster_signature(
    row: dict[str, Any],
    *,
    path: Path,
    line_no: int,
) -> tuple[str, str, str, int]:
    """Read the content-derived cluster identity from one frozen plan row."""

    edition_id = str(row.get("edition_id") or "")
    if not EDITION_ID_RE.fullmatch(edition_id):
        raise ValueError(
            f"invalid edition_id in organizer plan at {path}:{line_no}: {edition_id!r}"
        )
    work_id = str(row.get("work_id") or "")
    if not WORK_ID_RE.fullmatch(work_id):
        raise ValueError(
            f"invalid work_id in organizer plan at {path}:{line_no}: {work_id!r}"
        )
    visible_file = str(row.get("raw_destination") or "")
    if not visible_file:
        raise ValueError(
            f"organizer plan row has no raw_destination at {path}:{line_no}"
        )
    version = _positive_json_int(
        row.get("edition_version"),
        context=f"edition_version in organizer plan at {path}:{line_no}",
    )
    return edition_id, work_id, visible_file, version


def _plan_canonical_id(
    row: dict[str, Any],
    *,
    path: Path,
    line_no: int,
) -> str:
    library_id = _positive_json_int(
        row.get("library_id"),
        context=f"library_id in organizer plan at {path}:{line_no}",
        maximum=999_999,
    )
    return f"id{library_id:06d}"


def _processed_plan_source_adapter(row: dict[str, Any]) -> dict[str, Any]:
    """Adapt a frozen plan row to the strict processed-source verifier."""

    return {
        "source_priority": row.get("source_priority"),
        "source_root": row.get("source_root"),
        "source_relative_path": row.get("relative_path"),
        "raw_sha256": row.get("raw_sha256"),
        "source_encoding": row.get("encoding"),
    }


def _duplicate_metric(
    evidence: dict[str, Any],
    name: str,
    *,
    path: Path,
    line_no: int,
) -> float:
    value = evidence.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(
            f"duplicate evidence {name!r} is not numeric at {path}:{line_no}"
        )
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(
            f"duplicate evidence {name!r} is not finite at {path}:{line_no}"
        )
    return result


def _validate_supplemental_duplicate_relation(
    row: dict[str, Any],
    representative_row: dict[str, Any],
    *,
    path: Path,
    line_no: int,
) -> None:
    """Accept only explicit content-derived duplicate relations from the plan.

    Titles and authors are intentionally not consulted.  Byte/text exact rows
    must agree with the hashes published in ``index.jsonl``.  Fuzzy
    ``same_edition`` rows must carry at least the organizer's conservative
    default content-overlap evidence.
    """

    duplicate_kind = str(row.get("duplicate_kind") or "")
    if duplicate_kind not in {"byte_exact", "text_exact", "same_edition"}:
        raise ValueError(
            f"unsupported supplemental duplicate_kind at {path}:{line_no}: "
            f"{duplicate_kind!r}"
        )

    raw_hash = str(row.get("raw_sha256") or "")
    normalized_hash = str(row.get("normalized_sha256") or "")
    target_raw_hash = str(representative_row.get("raw_sha256") or "")
    target_normalized_hash = str(
        representative_row.get("normalized_sha256") or ""
    )
    for label, value in (
        ("raw_sha256", raw_hash),
        ("normalized_sha256", normalized_hash),
        ("representative raw_sha256", target_raw_hash),
        ("representative normalized_sha256", target_normalized_hash),
    ):
        if not SHA256_RE.fullmatch(value):
            raise ValueError(f"invalid {label} at {path}:{line_no}: {value!r}")

    evidence_value = row.get("duplicate_evidence_json")
    if not isinstance(evidence_value, str):
        raise ValueError(
            f"duplicate_evidence_json must be a string at {path}:{line_no}"
        )
    try:
        evidence = json.loads(evidence_value)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"invalid duplicate_evidence_json at {path}:{line_no}: {exc}"
        ) from exc
    if not isinstance(evidence, dict):
        raise ValueError(
            f"duplicate_evidence_json must contain an object at {path}:{line_no}"
        )

    if duplicate_kind == "byte_exact":
        if raw_hash != target_raw_hash or normalized_hash != target_normalized_hash:
            raise ValueError(
                f"byte_exact hashes disagree with representative at {path}:{line_no}"
            )
        if evidence.get("exact") is not True:
            raise ValueError(
                f"byte_exact row lacks exact evidence at {path}:{line_no}"
            )
        return

    if duplicate_kind == "text_exact":
        if normalized_hash != target_normalized_hash:
            raise ValueError(
                f"text_exact normalized hash disagrees with representative at "
                f"{path}:{line_no}"
            )
        if evidence.get("exact") is not True:
            raise ValueError(
                f"text_exact row lacks exact evidence at {path}:{line_no}"
            )
        return

    thresholds = {
        "length_ratio": 0.97,
        "order_ratio": 0.98,
        "shared_anchors": 10.0,
        "sketch_containment": 0.96,
        "sketch_jaccard": 0.90,
    }
    below = {
        name: (actual, minimum)
        for name, minimum in thresholds.items()
        if (actual := _duplicate_metric(
            evidence,
            name,
            path=path,
            line_no=line_no,
        ))
        < minimum
    }
    if below:
        raise ValueError(
            f"same_edition content evidence is below safety thresholds at "
            f"{path}:{line_no}: {below}"
        )


def _supplement_processed_duplicates_from_plan(
    organizer_plan: str | Path,
    *,
    missing_identities: set[str],
    export_inventory: dict[str, dict[str, Any]],
    representative_rows: dict[int, dict[str, Any]],
    canonical_by_edition_id: dict[str, str],
    verified_cache: dict[Path, VerifiedProcessedSource],
) -> tuple[list[dict[str, Any]], str]:
    """Recover public-index-omitted processed duplicates from a frozen plan.

    The public flat index intentionally contains only canonical/edition rows.
    This supplement is accepted only when the complete processed identity set,
    exact exported paths/hashes, representative file ID, final ID, cluster
    signature, and content-based duplicate evidence all agree.
    """

    plan_path = Path(organizer_plan).expanduser().resolve()
    if not plan_path.is_file():
        raise FileNotFoundError(f"organizer plan does not exist: {plan_path}")

    inventory_by_path: dict[Path, str] = {}
    for identity, item in export_inventory.items():
        source_path = Path(str(item["source_path"])).resolve()
        previous = inventory_by_path.get(source_path)
        if previous is not None and previous != identity:
            raise ValueError(
                f"export identities {previous} and {identity} share source path {source_path}"
            )
        inventory_by_path[source_path] = identity

    observations: list[dict[str, Any]] = []
    seen_plan_identities: set[str] = set()
    supplemented: set[str] = set()
    plan_run_ids: set[str] = set()
    with plan_path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            row = _strict_json_line(raw_line, path=plan_path, line_no=line_no)
            if str(row.get("source_kind") or "") != EXISTING_PROCESSED_SOURCE_KIND:
                continue
            source_value = str(row.get("source_path") or "")
            if not source_value:
                raise ValueError(
                    f"processed organizer plan row has no source_path at "
                    f"{plan_path}:{line_no}"
                )
            source_path = Path(source_value).resolve()
            identity = inventory_by_path.get(source_path)
            if identity is None:
                raise ValueError(
                    f"organizer plan contains processed source absent from export manifest "
                    f"at {plan_path}:{line_no}: {source_path}"
                )
            if identity in seen_plan_identities:
                raise ValueError(
                    f"organizer plan repeats processed identity {identity} at "
                    f"{plan_path}:{line_no}"
                )
            seen_plan_identities.add(identity)
            plan_run_id = str(row.get("plan_run_id") or "")
            if not plan_run_id:
                raise ValueError(
                    f"organizer plan row has no plan_run_id at {plan_path}:{line_no}"
                )
            plan_run_ids.add(plan_run_id)

            action = str(row.get("planned_action") or "")
            file_id = _positive_json_int(
                row.get("file_id"),
                context=f"file_id in organizer plan at {plan_path}:{line_no}",
            )
            signature = _plan_cluster_signature(row, path=plan_path, line_no=line_no)
            original_canonical = _plan_canonical_id(
                row, path=plan_path, line_no=line_no
            )
            canonical = canonical_by_edition_id.get(signature[0], original_canonical)

            if identity not in missing_identities:
                if action not in {"canonical", "edition", "source_duplicate"}:
                    raise ValueError(
                        f"invalid processed action at {plan_path}:{line_no}: {action!r}"
                    )
                if action in {"canonical", "edition"}:
                    indexed = representative_rows.get(file_id)
                    if indexed is None:
                        raise ValueError(
                            f"processed representative {identity} from organizer plan is "
                            f"absent from index.jsonl"
                        )
                    if (
                        indexed["canonical_id"] != canonical
                        or indexed["signature"] != signature
                        or str(indexed["row"].get("raw_sha256") or "")
                        != str(row.get("raw_sha256") or "")
                        or str(indexed["row"].get("normalized_sha256") or "")
                        != str(row.get("normalized_sha256") or "")
                    ):
                        raise ValueError(
                            f"organizer plan/index representative mismatch for {identity} "
                            f"at {plan_path}:{line_no}"
                        )
                continue

            if action != "source_duplicate":
                raise ValueError(
                    f"processed identity {identity} is missing from the public index but "
                    f"is not a source_duplicate at {plan_path}:{line_no}"
                )
            duplicate_of = _positive_json_int(
                row.get("duplicate_of_file_id"),
                context=(
                    f"duplicate_of_file_id in organizer plan at {plan_path}:{line_no}"
                ),
            )
            indexed = representative_rows.get(duplicate_of)
            if indexed is None:
                raise ValueError(
                    f"processed duplicate {identity} points to a representative absent "
                    f"from index.jsonl at {plan_path}:{line_no}: {duplicate_of}"
                )
            if indexed["canonical_id"] != canonical or indexed["signature"] != signature:
                raise ValueError(
                    f"processed duplicate {identity} disagrees with representative final "
                    f"ID/cluster at {plan_path}:{line_no}"
                )
            _validate_supplemental_duplicate_relation(
                row,
                indexed["row"],
                path=plan_path,
                line_no=line_no,
            )
            adapter = _processed_plan_source_adapter(row)
            verified = _verify_processed_source(
                adapter,
                line_no=line_no,
                cache=verified_cache,
            )
            if Path(verified.path) != source_path or verified.identity_key != identity:
                raise ValueError(
                    f"organizer plan source/provenance identity mismatch for {identity} "
                    f"at {plan_path}:{line_no}"
                )
            inventory_item = export_inventory[identity]
            if (
                verified.source_sha256 != inventory_item["source_sha256"]
                or verified.source_utf8_bytes != inventory_item["source_utf8_bytes"]
            ):
                raise ValueError(
                    f"organizer plan/export hash or size mismatch for {identity} "
                    f"at {plan_path}:{line_no}"
                )
            source_token = (
                file_id,
                str(row.get("source_root") or ""),
                str(row.get("relative_path") or ""),
            )
            member = {
                "line_no": line_no,
                "origin": "organizer_plan",
                "file_id": file_id,
                "source_token": source_token,
                "action": action,
                "duplicate_of_file_id": duplicate_of,
            }
            observations.append(
                {
                    **member,
                    "identity_key": identity,
                    "canonical_id": canonical,
                    "source_sha256": verified.source_sha256,
                    "source_utf8_bytes": verified.source_utf8_bytes,
                    "source_path": verified.path,
                    "provenance_path": verified.provenance_path,
                    "edition_id": signature[0],
                    "work_id": signature[1],
                    "visible_file": signature[2],
                    "edition_version": signature[3],
                }
            )
            supplemented.add(identity)

    expected_identities = set(export_inventory)
    if seen_plan_identities != expected_identities:
        raise ValueError(
            "organizer plan/export identity set mismatch: "
            f"missing={sorted(expected_identities - seen_plan_identities)}, "
            f"unexpected={sorted(seen_plan_identities - expected_identities)}"
        )
    if supplemented != missing_identities:
        raise ValueError(
            "organizer plan did not safely supplement every missing processed identity: "
            f"missing={sorted(missing_identities - supplemented)}, "
            f"unexpected={sorted(supplemented - missing_identities)}"
        )
    if len(plan_run_ids) != 1:
        raise ValueError(
            f"organizer plan contains multiple plan_run_id values: {sorted(plan_run_ids)}"
        )
    return observations, next(iter(plan_run_ids))


def build_id_map_plan(
    organizer_index: str | Path,
    import_root: str | Path,
    *,
    organizer_plan: str | Path | None = None,
    base_id_map: dict[str, Any] | None = None,
    repair_id_collisions: bool = False,
) -> dict[str, Any]:
    """Derive a hash-verified post-merge legacy identity map.

    Every conflict is detected before the returned plan can be written.  The
    organizer must have completed in copy/retained-source mode because each
    processed ``source.txt`` and sidecar is part of the trust chain.  Since the
    public index intentionally omits source-duplicate ledger rows, callers may
    supply the exact frozen ``plan.jsonl`` that produced the index.  It is used
    only to recover missing processed duplicates through explicit content
    relations; titles and authors are never matching inputs.
    """

    index_path = Path(organizer_index).expanduser().resolve()
    if not index_path.is_file():
        raise FileNotFoundError(f"organizer index does not exist: {index_path}")
    resolved_import_root, export_inventory = _load_export_inventory(import_root)

    id_repair_lookup: dict[tuple[str, str], str] = {}
    id_collision_repairs: list[dict[str, Any]] = []
    if repair_id_collisions:
        signatures_by_id: dict[str, dict[tuple[str, str, str, int], int]] = {}
        highest_id = 0
        with index_path.open("r", encoding="utf-8") as handle:
            for line_no, raw_line in enumerate(handle, start=1):
                if not raw_line.strip():
                    continue
                row = _strict_json_line(raw_line, path=index_path, line_no=line_no)
                canonical = _organizer_canonical_id(row, line_no=line_no)
                if canonical is None:
                    continue
                highest_id = max(highest_id, int(canonical[2:]))
                signature = _organizer_cluster_signature(row, line_no=line_no)
                signatures_by_id.setdefault(canonical, {}).setdefault(signature, line_no)
        for canonical, signatures in sorted(signatures_by_id.items()):
            ordered = sorted(signatures.items(), key=lambda item: (item[1], item[0]))
            for signature, line_no in ordered[1:]:
                highest_id += 1
                if highest_id > 999_999:
                    raise RuntimeError("The six-digit local library id space is exhausted")
                replacement = f"id{highest_id:06d}"
                id_repair_lookup[(canonical, signature[0])] = replacement
                id_collision_repairs.append(
                    {
                        "old_canonical_id": canonical,
                        "new_canonical_id": replacement,
                        "edition_id": signature[0],
                        "work_id": signature[1],
                        "visible_file": signature[2],
                        "edition_version": signature[3],
                        "first_index_line": line_no,
                        "reason": "one_legacy_id_referred_to_multiple_edition_clusters",
                    }
                )

    total_rows = rejected_rows = completed_rows = 0
    occupied: set[str] = set()
    cluster_signatures: dict[str, tuple[str, str, str, int]] = {}
    edition_to_id: dict[str, str] = {}
    cluster_members: dict[str, list[dict[str, Any]]] = {}
    processed_observations: list[dict[str, Any]] = []
    verified_cache: dict[Path, VerifiedProcessedSource] = {}
    indexed_representatives: dict[int, dict[str, Any]] = {}

    with index_path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            total_rows += 1
            row = _strict_json_line(raw_line, path=index_path, line_no=line_no)
            canonical = _organizer_canonical_id(row, line_no=line_no)
            if canonical is None:
                rejected_rows += 1
                continue
            completed_rows += 1
            signature = _organizer_cluster_signature(row, line_no=line_no)
            canonical = id_repair_lookup.get((canonical, signature[0]), canonical)
            occupied.add(canonical)
            previous_signature = cluster_signatures.get(canonical)
            if previous_signature is not None and previous_signature != signature:
                raise ValueError(
                    f"final id {canonical} refers to multiple organizer clusters: "
                    f"{previous_signature!r} != {signature!r} at line {line_no}"
                )
            cluster_signatures[canonical] = signature
            previous_id = edition_to_id.get(signature[0])
            if previous_id is not None and previous_id != canonical:
                raise ValueError(
                    f"edition {signature[0]} maps to multiple ids: "
                    f"{previous_id}, {canonical}"
                )
            edition_to_id[signature[0]] = canonical

            action = str(row.get("action") or "")
            if action not in {"canonical", "edition", "source_duplicate"}:
                raise ValueError(f"invalid organizer action at line {line_no}: {action!r}")
            file_id = _positive_json_int(
                row.get("file_id"), context=f"file_id at line {line_no}"
            )
            source_token = (
                file_id,
                str(row.get("source_root") or ""),
                str(row.get("source_relative_path") or ""),
            )
            duplicate_of = row.get("duplicate_of_file_id")
            if action in {"canonical", "edition"}:
                if duplicate_of is not None:
                    raise ValueError(
                        f"representative row has duplicate_of_file_id at line {line_no}"
                    )
            else:
                duplicate_of = _positive_json_int(
                    duplicate_of,
                    context=f"duplicate_of_file_id at line {line_no}",
                )
            member = {
                "line_no": line_no,
                "origin": "organizer_index",
                "file_id": file_id,
                "source_token": source_token,
                "action": action,
                "duplicate_of_file_id": duplicate_of,
            }
            cluster_members.setdefault(canonical, []).append(member)
            if action in {"canonical", "edition"}:
                indexed = {
                    "canonical_id": canonical,
                    "signature": signature,
                    "source_token": source_token,
                    "row": row,
                }
                previous = indexed_representatives.get(file_id)
                if previous is not None:
                    if previous["canonical_id"] != indexed["canonical_id"]:
                        raise ValueError(
                            f"file_id {file_id} maps to multiple final ids: "
                            f"{previous['canonical_id']}, {indexed['canonical_id']}"
                        )
                    if (
                        previous["signature"] != indexed["signature"]
                        or previous["source_token"] != indexed["source_token"]
                    ):
                        raise ValueError(
                            f"file_id {file_id} identifies conflicting organizer "
                            f"representatives at line {line_no}"
                        )
                indexed_representatives[file_id] = indexed

            if str(row.get("source_kind") or "") != EXISTING_PROCESSED_SOURCE_KIND:
                continue
            verified = _verify_processed_source(
                row,
                line_no=line_no,
                cache=verified_cache,
            )
            inventory_item = export_inventory.get(verified.identity_key)
            if inventory_item is None:
                raise ValueError(
                    f"organizer contains processed identity absent from export manifest: "
                    f"{verified.identity_key}"
                )
            if Path(verified.path) != Path(inventory_item["source_path"]):
                raise ValueError(
                    f"organizer source path disagrees with export manifest for "
                    f"{verified.identity_key}"
                )
            if verified.source_sha256 != inventory_item["source_sha256"]:
                raise ValueError(
                    f"organizer source hash disagrees with export manifest for "
                    f"{verified.identity_key}"
                )
            if verified.source_utf8_bytes != inventory_item["source_utf8_bytes"]:
                raise ValueError(
                    f"organizer source size disagrees with export manifest for "
                    f"{verified.identity_key}"
                )
            processed_observations.append(
                {
                    **member,
                    "identity_key": verified.identity_key,
                    "canonical_id": canonical,
                    "source_sha256": verified.source_sha256,
                    "source_utf8_bytes": verified.source_utf8_bytes,
                    "source_path": verified.path,
                    "provenance_path": verified.provenance_path,
                    "edition_id": signature[0],
                    "work_id": signature[1],
                    "visible_file": signature[2],
                    "edition_version": signature[3],
                }
            )

    observed_identities = {
        str(item["identity_key"]) for item in processed_observations
    }
    expected_identities = set(export_inventory)
    missing_identity_set = expected_identities - observed_identities
    supplemental_plan_run_id: str | None = None
    supplemental_count = 0
    if missing_identity_set and organizer_plan is not None:
        supplemental, supplemental_plan_run_id = (
            _supplement_processed_duplicates_from_plan(
                organizer_plan,
                missing_identities=missing_identity_set,
                export_inventory=export_inventory,
                representative_rows=indexed_representatives,
                canonical_by_edition_id=edition_to_id,
                verified_cache=verified_cache,
            )
        )
        for observation in supplemental:
            processed_observations.append(observation)
            cluster_members.setdefault(
                str(observation["canonical_id"]), []
            ).append(
                {
                    key: observation[key]
                    for key in (
                        "line_no",
                        "origin",
                        "file_id",
                        "source_token",
                        "action",
                        "duplicate_of_file_id",
                    )
                }
            )
        supplemental_count = len(supplemental)
        observed_identities = {
            str(item["identity_key"]) for item in processed_observations
        }

    missing_identities = sorted(expected_identities - observed_identities)
    unexpected_identities = sorted(observed_identities - expected_identities)
    if missing_identities or unexpected_identities:
        raise ValueError(
            "organizer/export identity set mismatch: "
            f"missing={missing_identities}, unexpected={unexpected_identities}"
        )

    representative_tokens: dict[str, tuple[int, str, str]] = {}
    for canonical, members in sorted(cluster_members.items()):
        representative_rows: dict[tuple[int, str, str], dict[str, Any]] = {}
        for member in members:
            if member["action"] in {"canonical", "edition"}:
                token = member["source_token"]
                prior = representative_rows.get(token)
                if prior is not None and prior["action"] != member["action"]:
                    raise ValueError(
                        f"representative action conflict for {canonical} at lines "
                        f"{prior['line_no']} and {member['line_no']}"
                    )
                representative_rows[token] = member
        if len(representative_rows) != 1:
            raise ValueError(
                f"final id {canonical} must have exactly one organizer representative, "
                f"found {len(representative_rows)}"
            )
        token, representative_row = next(iter(representative_rows.items()))
        representative_tokens[canonical] = token
        representative_file_id = representative_row["file_id"]
        for member in members:
            if (
                member["action"] == "source_duplicate"
                and member["duplicate_of_file_id"] != representative_file_id
            ):
                raise ValueError(
                    f"duplicate row at line {member['line_no']} points outside "
                    f"the {canonical} representative"
                )

    observations_by_identity: dict[str, list[dict[str, Any]]] = {}
    for observation in processed_observations:
        observations_by_identity.setdefault(observation["identity_key"], []).append(observation)

    generated_mappings: dict[str, str] = {}
    identity_records: list[dict[str, Any]] = []
    for identity, observations in sorted(observations_by_identity.items()):
        canonical_ids = {str(item["canonical_id"]) for item in observations}
        source_hashes = {str(item["source_sha256"]) for item in observations}
        cluster_values = {
            (
                item["edition_id"],
                item["work_id"],
                item["visible_file"],
                item["edition_version"],
            )
            for item in observations
        }
        duplicate_row_values = {
            (
                item["source_path"],
                item["file_id"],
                item["action"],
                item["duplicate_of_file_id"],
            )
            for item in observations
        }
        if len(canonical_ids) != 1:
            raise ValueError(
                f"legacy identity {identity} maps to multiple final ids: {sorted(canonical_ids)}"
            )
        if len(source_hashes) != 1:
            raise ValueError(
                f"legacy identity {identity} has multiple verified source hashes: "
                f"{sorted(source_hashes)}"
            )
        if len(cluster_values) != 1:
            raise ValueError(f"legacy identity {identity} appears in multiple clusters")
        if len(duplicate_row_values) != 1:
            raise ValueError(
                f"legacy identity {identity} has inconsistent duplicate index rows"
            )
        canonical = next(iter(canonical_ids))
        generated_mappings[identity] = canonical
        identity_records.append(
            {
                "identity_key": identity,
                "canonical_id": canonical,
                "source_sha256": next(iter(source_hashes)),
                "source_utf8_bytes": observations[0]["source_utf8_bytes"],
                "edition_id": observations[0]["edition_id"],
                "work_id": observations[0]["work_id"],
                "visible_file": observations[0]["visible_file"],
                "index_lines": sorted(
                    {
                        int(item["line_no"])
                        for item in observations
                        if item.get("origin") == "organizer_index"
                    }
                ),
                "plan_lines": sorted(
                    {
                        int(item["line_no"])
                        for item in observations
                        if item.get("origin") == "organizer_plan"
                    }
                ),
                "source_paths": sorted({str(item["source_path"]) for item in observations}),
                "provenance_paths": sorted(
                    {str(item["provenance_path"]) for item in observations}
                ),
            }
        )

    generated_representatives: dict[str, str] = {}
    identities_by_canonical: dict[str, set[str]] = {}
    for identity, canonical in generated_mappings.items():
        identities_by_canonical.setdefault(canonical, set()).add(identity)
    for canonical, identities in sorted(identities_by_canonical.items()):
        representative_token = representative_tokens[canonical]
        candidates = {
            str(item["identity_key"])
            for item in processed_observations
            if item["canonical_id"] == canonical
            and item["source_token"] == representative_token
            and item["action"] in {"canonical", "edition"}
        }
        if len(candidates) != 1:
            raise ValueError(
                f"final id {canonical} has processed identities {sorted(identities)} but "
                "its unique organizer representative is not one verified processed identity"
            )
        representative_identity = next(iter(candidates))
        if representative_identity not in identities:
            raise ValueError(f"internal representative mismatch for {canonical}")
        generated_representatives[canonical] = representative_identity

    for record in identity_records:
        record["representative"] = (
            generated_representatives.get(record["canonical_id"])
            == record["identity_key"]
        )

    generated = {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "mappings": dict(sorted(generated_mappings.items())),
        "representatives": dict(sorted(generated_representatives.items())),
        "occupied_ids": sorted(occupied),
    }
    final_map = _merge_id_maps(generated, base_id_map)
    clusters = [
        {
            "canonical_id": canonical,
            "edition_id": cluster_signatures[canonical][0],
            "work_id": cluster_signatures[canonical][1],
            "visible_file": cluster_signatures[canonical][2],
            "edition_version": cluster_signatures[canonical][3],
            "identity_keys": sorted(identities),
            "representative_identity": generated_representatives[canonical],
        }
        for canonical, identities in sorted(identities_by_canonical.items())
    ]
    return {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "organizer_index": str(index_path),
        "organizer_plan": (
            str(Path(organizer_plan).expanduser().resolve())
            if organizer_plan is not None
            else None
        ),
        "import_root": str(resolved_import_root),
        "id_map": final_map,
        "processed_identities": identity_records,
        "processed_clusters": clusters,
        "id_collision_repairs": id_collision_repairs,
        "summary": {
            "organizer_rows": total_rows,
            "completed_rows": completed_rows,
            "rejected_rows": rejected_rows,
            "occupied_ids": len(occupied),
            "processed_rows": len(processed_observations),
            "exported_identities": len(export_inventory),
            "processed_identities": len(identity_records),
            "supplemented_processed_duplicates": supplemental_count,
            "supplemental_plan_run_id": supplemental_plan_run_id,
            "duplicate_processed_rows": len(processed_observations) - len(identity_records),
            "processed_clusters": len(clusters),
            "multi_identity_clusters": sum(
                len(item["identity_keys"]) > 1 for item in clusters
            ),
            "base_mappings": len(base_id_map.get("mappings", {})) if base_id_map else 0,
            "final_mappings": len(final_map["mappings"]),
            "repaired_id_collisions": len(id_collision_repairs),
            "hash_verified": True,
            "live_switch_ready": False,
        },
    }


def write_id_map_plan(plan: dict[str, Any], plan_dir: str | Path) -> None:
    output = Path(plan_dir)
    _atomic_write_bytes(output / "summary.json", _json_bytes(plan["summary"]))
    _atomic_write_bytes(output / "id_map.json", _json_bytes(plan["id_map"]))
    _atomic_write_bytes(
        output / "processed_identities.jsonl",
        _jsonl_bytes(plan["processed_identities"]),
    )
    _atomic_write_bytes(
        output / "processed_clusters.jsonl",
        _jsonl_bytes(plan["processed_clusters"]),
    )
    _atomic_write_bytes(
        output / "id_collision_repairs.jsonl",
        _jsonl_bytes(plan.get("id_collision_repairs", [])),
    )


def write_id_map(plan: dict[str, Any], output_path: str | Path) -> str:
    return _atomic_write_bytes(Path(output_path), _json_bytes(plan["id_map"]))


def allocate_incremental_ids(
    identity_keys: Iterable[str],
    existing_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append missing identities after the highest occupied id.

    Existing assignments are copied verbatim and are never compacted or
    renumbered.  This helper is opt-in; the reindex phase normally consumes a
    map selected by the global merge/dedup process.
    """
    existing = existing_map or {
        "mappings": {},
        "representatives": {},
        "occupied_ids": [],
    }
    mappings = {str(key): str(value) for key, value in existing.get("mappings", {}).items()}
    occupied = set(str(value) for value in existing.get("occupied_ids", []))
    occupied.update(mappings.values())
    for value in occupied:
        if not CANONICAL_ID_RE.fullmatch(value):
            raise ValueError(f"invalid occupied id: {value}")
    highest = max((int(value[2:]) for value in occupied), default=0)
    for identity in sorted({str(value) for value in identity_keys}):
        if identity in mappings:
            continue
        highest += 1
        canonical = f"id{highest:06d}"
        while canonical in occupied:
            highest += 1
            canonical = f"id{highest:06d}"
        mappings[identity] = canonical
        occupied.add(canonical)
    return {
        "layout_version": ID_MAP_LAYOUT_VERSION,
        "mappings": mappings,
        "representatives": dict(existing.get("representatives", {})),
        "occupied_ids": sorted(occupied),
    }


def _load_export_manifest(import_root: Path) -> list[dict[str, Any]]:
    manifest_path = import_root / "export_manifest.jsonl"
    rows: list[dict[str, Any]] = []
    for line_no, raw_line in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        payload = json.loads(raw_line)
        if not isinstance(payload, dict):
            raise ValueError(f"invalid export manifest row {line_no}")
        if payload.get("status") == "failed":
            continue
        rows.append(payload)
    return rows


class IdResolver:
    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping

    def resolve(self, value: str, *, kind_hint: str | None = None) -> str | None:
        raw = str(value).strip()
        if CANONICAL_ID_RE.fullmatch(raw):
            return self.mapping.get(f"id:{raw}", raw)
        legacy = LEGACY_SLUG_RE.fullmatch(raw)
        if legacy:
            return self.mapping.get(f"{legacy.group('kind')}:{raw}")
        if raw.isdigit() and kind_hint in {"book", "story"}:
            slug = f"{kind_hint}_{int(raw):04d}"
            return self.mapping.get(f"{kind_hint}:{slug}")
        return None


def _kind_hint_from_key(key: str, default: str | None) -> str | None:
    lowered = key.lower()
    if "story" in lowered:
        return "story"
    if "book" in lowered or "clean" in lowered or "raw" in lowered:
        return "book"
    return default


def _rewrite_chapter_id(value: str, resolver: IdResolver, kind_hint: str | None) -> str | None:
    canonical_match = CANONICAL_CHAPTER_RE.fullmatch(value)
    if canonical_match:
        canonical = resolver.resolve(canonical_match.group("content_id"))
        if canonical is None:
            return None
        return chapter_id_for(canonical, int(canonical_match.group("chapter")))
    match = LEGACY_CHAPTER_RE.fullmatch(value)
    if not match:
        return None
    explicit_kind = match.group("kind")
    kind = explicit_kind or kind_hint
    if kind not in {"book", "story"}:
        return None
    old_slug = f"{kind}_{int(match.group('number')):04d}"
    canonical = resolver.resolve(old_slug, kind_hint=kind)
    if canonical is None:
        return None
    return chapter_id_for(canonical, int(match.group("chapter")))


def _replace_reference_tokens(value: str, resolver: IdResolver, kind_hint: str | None) -> str:
    legacy_pattern = re.compile(r"(?<![A-Za-z0-9])(?:book|story)_\d+(?!\d)")
    canonical_chapter_pattern = re.compile(
        r"(?<![A-Za-z0-9])id\d{6}C\d{1,6}(?!\d)"
    )
    canonical_pattern = re.compile(r"(?<![A-Za-z0-9])id\d{6}(?![A-Za-z0-9])")
    rewritten = value
    for legacy_path, canonical_path in LAYOUT_PATH_REPLACEMENTS:
        rewritten = rewritten.replace(legacy_path, canonical_path)
    rewritten = legacy_pattern.sub(
        lambda match: resolver.resolve(match.group(0)) or match.group(0),
        rewritten,
    )
    rewritten = canonical_chapter_pattern.sub(
        lambda match: (
            _rewrite_chapter_id(match.group(0), resolver, kind_hint)
            or match.group(0)
        ),
        rewritten,
    )
    rewritten = canonical_pattern.sub(
        lambda match: resolver.resolve(match.group(0)) or match.group(0),
        rewritten,
    )
    chapter = _rewrite_chapter_id(rewritten, resolver, kind_hint)
    return chapter or rewritten


def _is_reference_key(key: str) -> bool:
    lowered = key.lower()
    return any(
        token in lowered
        for token in ("_id", "_ids", "slug", "path", "source", "output", "ref", "file", "dir", "root", "chunk")
    )


def rewrite_json_payload(
    payload: Any,
    mappings: dict[str, str],
    *,
    default_kind: str | None = None,
    rewrite_all_strings: bool = False,
) -> tuple[Any, list[dict[str, Any]]]:
    """Structurally rewrite id/slug/path/reference fields in one JSON value."""
    resolver = IdResolver(mappings)
    changes: list[dict[str, Any]] = []

    def visit(value: Any, pointer: str, parent_key: str, kind_hint: str | None) -> Any:
        local_kind = _kind_hint_from_key(parent_key, kind_hint)
        if isinstance(value, dict):
            rewritten_items: dict[Any, Any] = {}
            for key, item in value.items():
                rewritten_key = key
                if isinstance(key, str):
                    rewritten_key = _replace_reference_tokens(key, resolver, local_kind)
                    if rewritten_key != key:
                        changes.append(
                            {
                                "pointer": f"{pointer}/{_pointer_escape(key)}" or "/",
                                "old_key": key,
                                "new_key": rewritten_key,
                            }
                        )
                if rewritten_key in rewritten_items:
                    raise ValueError(
                        f"ID rewrite creates duplicate JSON key {rewritten_key!r} at {pointer or '/'}"
                    )
                rewritten_items[rewritten_key] = visit(
                    item,
                    f"{pointer}/{_pointer_escape(str(rewritten_key))}",
                    str(rewritten_key),
                    local_kind,
                )
            return rewritten_items
        if isinstance(value, list):
            return [visit(item, f"{pointer}/{index}", parent_key, local_kind) for index, item in enumerate(value)]
        if not isinstance(value, str) or (
            not rewrite_all_strings and not _is_reference_key(parent_key)
        ):
            return value

        rewritten = value
        lowered = parent_key.lower()
        if "chapter_id" in lowered:
            rewritten = _rewrite_chapter_id(value, resolver, local_kind) or value
        elif lowered.endswith("_id") or lowered in {"book_id", "story_id", "clean_id", "raw_book_id"}:
            rewritten = resolver.resolve(value, kind_hint=local_kind) or _replace_reference_tokens(
                value, resolver, local_kind
            )
        else:
            rewritten = _replace_reference_tokens(value, resolver, local_kind)
        if rewritten != value:
            changes.append({"pointer": pointer or "/", "old": value, "new": rewritten})
        return rewritten

    return visit(payload, "", "", default_kind), changes


def _pointer_escape(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _context_kind_for_path(path: Path) -> str | None:
    parts = set(path.parts)
    if "00_Stories" in parts or any("stories" in part for part in parts):
        return "story"
    if parts.intersection({"01_RawData", "02_CleanedData", "03_ChapterAnalysis"}) or any(
        "novels" in part for part in parts
    ):
        return "book"
    for part in path.parts:
        legacy = LEGACY_SLUG_RE.fullmatch(part)
        if legacy:
            return legacy.group("kind")
    return None


def rewrite_reference_relative_path(relative_path: str, mappings: dict[str, str]) -> str:
    """Rewrite legacy id directory components in a staged relative path."""
    resolver = IdResolver(mappings)
    rewritten_parts: list[str] = []
    for part in Path(relative_path).parts:
        layout_replacement = {
            "stories_raw": "00_Stories",
            "novels_raw": "01_RawData",
            "novels_cleaned": "02_CleanedData",
            "novels_chapter": "03_ChapterAnalysis",
        }.get(part)
        replacement = layout_replacement or resolver.resolve(part)
        rewritten_parts.append(replacement or part)
    return Path(*rewritten_parts).as_posix()


def _deduplicate_reference_targets(
    rewrites: list[dict[str, Any]],
    id_map: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Choose one audited legacy producer when merged identities share a target."""

    representatives = {
        str(canonical): str(identity)
        for canonical, identity in dict(id_map.get("representatives", {})).items()
    }
    grouped: dict[str, list[dict[str, Any]]] = {}
    for rewrite in rewrites:
        grouped.setdefault(str(rewrite["target_relative_path"]), []).append(rewrite)
    selected: list[dict[str, Any]] = []
    aliases: list[dict[str, Any]] = []
    for target, candidates in sorted(grouped.items()):
        if len(candidates) == 1:
            selected.append(candidates[0])
            continue
        canonical = next(
            (part for part in Path(target).parts if CANONICAL_ID_RE.fullmatch(part)),
            "",
        )
        representative_identity = representatives.get(canonical, "")
        representative_slug = (
            representative_identity.split(":", 1)[1]
            if ":" in representative_identity
            else ""
        )

        def rank(item: dict[str, Any]) -> tuple[int, str]:
            parts = set(Path(str(item["relative_path"])).parts)
            return (
                0 if representative_slug and representative_slug in parts else 1,
                str(item["relative_path"]),
            )

        ordered = sorted(candidates, key=rank)
        chosen = ordered[0]
        selected.append(chosen)
        aliases.append(
            {
                "target_relative_path": target,
                "canonical_id": canonical,
                "representative_identity": representative_identity,
                "selected_source": chosen["relative_path"],
                "dropped_sources": [item["relative_path"] for item in ordered[1:]],
                "reason": "merged_legacy_identities_share_one_canonical_reference_target",
            }
        )
    return selected, aliases


def iter_reference_json(library_root: Path, *, include_abstract: bool = False) -> Iterator[Path]:
    seen: set[Path] = set()
    # Stage indexes carry book/chapter/path lineage.  Chapter payloads are not
    # copied: the canonical staging index is regenerated from the assembled book.
    for entity in discover_existing_entities(library_root):
        for stage_path in entity.stages.values():
            index_path = stage_path / "index.json"
            if index_path.is_file() and index_path not in seen:
                seen.add(index_path)
                yield index_path
    roots = [library_root / "Bridges"]
    if include_abstract:
        roots.append(library_root / "AbstractLibrary")
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.json")):
            if path not in seen:
                seen.add(path)
                yield path


def build_reindex_plan(
    library_root: str | Path,
    import_root: str | Path,
    id_map: dict[str, Any],
    *,
    include_abstract: bool = False,
) -> dict[str, Any]:
    root = Path(library_root).resolve()
    imports = Path(import_root).resolve()
    mappings = dict(id_map.get("mappings", {}))
    export_rows = _load_export_manifest(imports)
    entities: list[dict[str, Any]] = []
    for row in export_rows:
        identity = str(row.get("identity_key") or "")
        canonical = mappings.get(identity)
        entities.append(
            {
                **row,
                "canonical_id": canonical or "",
                "status": "ready" if canonical else "missing_id",
                "source_path": str((imports / "imports" / str(row["export_key"]) / "source.txt").resolve()),
            }
        )

    rewrites: list[dict[str, Any]] = []
    invalid_json: list[dict[str, str]] = []
    for path in iter_reference_json(root, include_abstract=include_abstract):
        try:
            payload = _load_json_object(path)
            _, changes = rewrite_json_payload(
                payload,
                mappings,
                default_kind=_context_kind_for_path(path),
            )
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            invalid_json.append({"path": _library_relative(path, root), "error": str(exc)})
            continue
        if changes:
            rewrites.append(
                {
                    "source_path": str(path.resolve()),
                    "relative_path": _library_relative(path, root),
                    "target_relative_path": rewrite_reference_relative_path(
                        _library_relative(path, root),
                        mappings,
                    ),
                    "change_count": len(changes),
                    "changes": changes,
                }
            )
    rewrites, reference_aliases = _deduplicate_reference_targets(rewrites, id_map)
    return {
        "layout_version": REINDEX_LAYOUT_VERSION,
        "library_root": str(root),
        "import_root": str(imports),
        "id_map": id_map,
        "entities": entities,
        "reference_rewrites": rewrites,
        "reference_aliases": reference_aliases,
        "invalid_json": invalid_json,
        "summary": {
            "imports": len(entities),
            "mapped": sum(item["status"] == "ready" for item in entities),
            "missing_id": sum(item["status"] == "missing_id" for item in entities),
            "reference_files": len(rewrites),
            "reference_changes": sum(item["change_count"] for item in rewrites),
            "invalid_json": len(invalid_json),
            "collapsed_reference_targets": len(reference_aliases),
            "dropped_alias_reference_files": sum(
                len(item["dropped_sources"]) for item in reference_aliases
            ),
            "reference_scope": (
                "stage_indexes_and_bridge_json_plus_abstract"
                if include_abstract
                else "stage_indexes_and_bridge_json"
            ),
            "chapter_payloads_rebuilt": False,
            "live_switch_ready": False,
        },
    }


def write_reindex_plan(plan: dict[str, Any], plan_dir: str | Path) -> None:
    output = Path(plan_dir)
    _atomic_write_bytes(output / "summary.json", _json_bytes(plan["summary"]))
    _atomic_write_bytes(output / "id_map.json", _json_bytes(plan["id_map"]))
    _atomic_write_bytes(output / "reindex_entities.jsonl", _jsonl_bytes(plan["entities"]))
    _atomic_write_bytes(
        output / "reference_rewrites.jsonl",
        _jsonl_bytes(plan["reference_rewrites"]),
    )
    _atomic_write_bytes(
        output / "reference_aliases.jsonl",
        _jsonl_bytes(plan.get("reference_aliases", [])),
    )
    _atomic_write_bytes(output / "invalid_json.jsonl", _jsonl_bytes(plan["invalid_json"]))


def load_reindex_plan(
    plan_dir: str | Path,
    *,
    library_root: str | Path,
    import_root: str | Path,
) -> dict[str, Any]:
    """Load an already-reviewed dry-run plan without rescanning live Library."""

    root = Path(plan_dir).resolve()

    def rows(name: str) -> list[dict[str, Any]]:
        path = root / name
        if not path.is_file():
            raise FileNotFoundError(path)
        result: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                payload = _strict_json_line(line, path=path, line_no=line_no)
                result.append(payload)
        return result

    summary = _load_json_object(root / "summary.json")
    id_map = _load_json_object(root / "id_map.json")
    entities = rows("reindex_entities.jsonl")
    rewrites = rows("reference_rewrites.jsonl")
    invalid_json = rows("invalid_json.jsonl")
    original_rewrite_count = len(rewrites)
    rewrites, reference_aliases = _deduplicate_reference_targets(rewrites, id_map)
    expected = {
        "imports": len(entities),
        "reference_files": original_rewrite_count,
        "invalid_json": len(invalid_json),
    }
    for key, actual in expected.items():
        if int(summary.get(key) or 0) != actual:
            raise ValueError(
                f"Saved reindex plan count mismatch for {key}: "
                f"summary={summary.get(key)!r}, rows={actual}"
            )
    effective_summary = dict(summary)
    effective_summary.update(
        {
            "source_reference_files": original_rewrite_count,
            "reference_files": len(rewrites),
            "reference_changes": sum(
                int(item.get("change_count") or 0) for item in rewrites
            ),
            "collapsed_reference_targets": len(reference_aliases),
            "dropped_alias_reference_files": sum(
                len(item["dropped_sources"]) for item in reference_aliases
            ),
        }
    )
    return {
        "layout_version": REINDEX_LAYOUT_VERSION,
        "library_root": str(Path(library_root).resolve()),
        "import_root": str(Path(import_root).resolve()),
        "id_map": id_map,
        "entities": entities,
        "reference_rewrites": rewrites,
        "reference_aliases": reference_aliases,
        "invalid_json": invalid_json,
        "summary": effective_summary,
    }


def _choose_canonical_exports(
    entities: list[dict[str, Any]],
    representatives: dict[str, str],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entity in entities:
        canonical = str(entity.get("canonical_id") or "")
        if entity.get("status") == "ready" and canonical:
            grouped.setdefault(canonical, []).append(entity)
    chosen: dict[str, dict[str, Any]] = {}
    collisions: list[dict[str, Any]] = []
    for canonical, rows in sorted(grouped.items()):
        hashes = {str(row.get("source_sha256") or "") for row in rows}
        representative = str(representatives.get(canonical) or "")
        if representative:
            matches = [row for row in rows if row.get("identity_key") == representative]
            if len(matches) != 1:
                collisions.append(
                    {
                        "canonical_id": canonical,
                        "reason": "invalid_representative",
                        "representative": representative,
                        "identities": [row.get("identity_key") for row in rows],
                    }
                )
                continue
            chosen[canonical] = matches[0]
        elif len(hashes) == 1:
            chosen[canonical] = sorted(
                rows,
                key=lambda row: (
                    0 if str(row.get("selected_stage") or "").endswith("_cleaned") else 1,
                    str(row.get("identity_key") or ""),
                ),
            )[0]
        else:
            collisions.append(
                {
                    "canonical_id": canonical,
                    "reason": "different_content_requires_representative",
                    "identities": [row.get("identity_key") for row in rows],
                    "hashes": sorted(hashes),
                }
            )
    return chosen, collisions


def apply_reindex_plan(
    plan: dict[str, Any],
    staging_root: str | Path,
    *,
    workers: int = 1,
) -> dict[str, Any]:
    """Write canonical imports and rewritten reference copies to staging only."""
    library_root = Path(plan["library_root"])
    staging = Path(staging_root)
    _validate_staging_root(staging, library_root)
    chosen, collisions = _choose_canonical_exports(
        plan["entities"],
        dict(plan["id_map"].get("representatives", {})),
    )
    written = unchanged = failed = 0
    aliases_by_id: dict[str, list[str]] = {}
    for entity in plan["entities"]:
        canonical = str(entity.get("canonical_id") or "")
        if canonical:
            aliases_by_id.setdefault(canonical, []).append(str(entity.get("identity_key") or ""))
    for canonical, entity in chosen.items():
        try:
            source_path = Path(entity["source_path"])
            payload = source_path.read_bytes()
            if payload.startswith(b"\xef\xbb\xbf"):
                raise ValueError(f"export contains UTF-8 BOM: {source_path}")
            actual_hash = hashlib.sha256(payload).hexdigest()
            if actual_hash != entity.get("source_sha256"):
                raise ValueError(f"export hash changed: {source_path}")
            target = staging / "corpus" / canonical
            state = _atomic_write_bytes(target / "source.txt", payload)
            source_provenance = _load_json_object(source_path.parent / "provenance.json")
            canonical_index = {
                "layout_version": REINDEX_LAYOUT_VERSION,
                "id": canonical,
                "content_id": canonical,
                "content_type": "content",
                "title": entity.get("title") or source_provenance.get("title") or "",
                "author": entity.get("author") or source_provenance.get("author") or "",
                "source_sha256": actual_hash,
                "source_utf8_bytes": len(payload),
                "chapter_count": source_provenance.get("chapter_count", 0),
                "chapter_index": [
                    {
                        **chapter,
                        "chapter_id": chapter_id_for(
                            canonical,
                            int(chapter.get("order") or 0),
                        ),
                    }
                    for chapter in source_provenance.get("chapter_index", [])
                    if isinstance(chapter, dict)
                ],
                "legacy_identities": sorted(set(aliases_by_id.get(canonical, []))),
                "representative_identity": entity.get("identity_key"),
                "provenance": source_provenance,
            }
            _atomic_write_bytes(target / "index.json", _json_bytes(canonical_index))
            if state == "written":
                written += 1
            else:
                unchanged += 1
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            failed += 1
            collisions.append(
                {
                    "canonical_id": canonical,
                    "reason": "materialization_failed",
                    "error": str(exc),
                }
            )

    if workers < 1:
        raise ValueError("workers must be >= 1")
    reference_rewrites, newly_collapsed_aliases = _deduplicate_reference_targets(
        list(plan["reference_rewrites"]),
        dict(plan["id_map"]),
    )
    reference_aliases = [
        *list(plan.get("reference_aliases", [])),
        *newly_collapsed_aliases,
    ]
    effective_summary = dict(plan.get("summary", {}))
    effective_summary.update(
        {
            "reference_files": len(reference_rewrites),
            "reference_changes": sum(
                int(item.get("change_count") or 0) for item in reference_rewrites
            ),
            "collapsed_reference_targets": len(reference_aliases),
            "dropped_alias_reference_files": sum(
                len(item["dropped_sources"]) for item in reference_aliases
            ),
        }
    )
    effective_plan = {
        **plan,
        "reference_rewrites": reference_rewrites,
        "reference_aliases": reference_aliases,
        "summary": effective_summary,
    }
    rewritten_files = 0
    mappings = dict(plan["id_map"].get("mappings", {}))

    def materialize_reference(
        rewrite: dict[str, Any],
    ) -> tuple[bool, dict[str, str] | None]:
        source_path = Path(rewrite["source_path"])
        try:
            payload = _load_json_object(source_path)
            rewritten, changes = rewrite_json_payload(
                payload,
                mappings,
                default_kind=_context_kind_for_path(source_path),
            )
            if not changes:
                return False, None
            target = staging / "references" / rewrite["target_relative_path"]
            _atomic_write_bytes(target, _json_bytes(rewritten))
            return True, None
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            return False, {
                "source_path": str(source_path),
                "reason": "reference_rewrite_failed",
                "error": str(exc),
            }

    # Rewriting is independent per source/target. Multiple I/O workers hide
    # remote small-file latency while each atomic writer still fsyncs its own
    # completed file before publication.
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for rewritten, error in executor.map(
            materialize_reference,
            reference_rewrites,
        ):
            rewritten_files += int(rewritten)
            if error is not None:
                failed += 1
                collisions.append(error)
    write_reindex_plan(effective_plan, staging / "_plan")
    _atomic_write_bytes(staging / "_plan" / "collisions.jsonl", _jsonl_bytes(collisions))
    result = {
        "written": written,
        "unchanged": unchanged,
        "rewritten_reference_files": rewritten_files,
        "failed": failed,
        "collisions": len(collisions),
        "collapsed_reference_targets": len(reference_aliases),
        "staging_root": str(staging.resolve()),
    }
    _atomic_write_bytes(staging / "_plan" / "apply_result.json", _json_bytes(result))
    return result


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--library-root",
        default="Library",
        help="Library root to inspect. Default: Library",
    )
    parser.add_argument(
        "--plan-dir",
        help="Explicitly write the dry-run plan artifacts to this directory.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Materialize into --staging-root only; never switches the live corpus.",
    )
    parser.add_argument(
        "--staging-root",
        help="Independent staging destination required with --apply.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Non-destructive existing-corpus export, post-merge map, and reindex planner."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser(
        "export-existing",
        help="Export cleaned-priority whole books without assigning final ids.",
    )
    _add_common_arguments(export_parser)
    export_parser.add_argument(
        "--workers",
        type=int,
        default=available_cpu_count(),
        help=(
            "Bounded assembly processes. For remote small-file storage, 3-4x the "
            "detected CPU quota can overlap I/O waits."
        ),
    )
    export_parser.add_argument(
        "--input-plan-dir",
        help="Reuse a completed export plan instead of rereading every source for planning.",
    )
    export_parser.add_argument(
        "--refresh-unavailable",
        action="store_true",
        help="With --input-plan-dir, re-evaluate only records that were unavailable.",
    )
    export_parser.add_argument(
        "--legacy-only",
        action="store_true",
        help=(
            "Export only book_*/story_* inputs. Required when a provisional "
            "canonical id* tree coexists with the legacy corpus."
        ),
    )

    map_parser = subparsers.add_parser(
        "build-id-map",
        help="Derive a hash-verified legacy identity map from organizer index.jsonl.",
    )
    map_parser.add_argument(
        "--organizer-index",
        required=True,
        help="Completed Library/Noise/index.jsonl emitted by the organizer.",
    )
    map_parser.add_argument(
        "--import-root",
        required=True,
        help="Retained export-existing staging root whose manifest must match the index.",
    )
    map_parser.add_argument(
        "--organizer-plan",
        help=(
            "Exact frozen organizer plan.jsonl that produced the public index; "
            "required when processed source-duplicate rows are absent from index.jsonl."
        ),
    )
    map_parser.add_argument(
        "--base-id-map",
        help="Optional prior id_map.json to merge; every changed assignment is rejected.",
    )
    map_parser.add_argument(
        "--repair-id-collisions",
        action="store_true",
        help=(
            "Keep the first edition cluster on a duplicated final ID and append "
            "fresh monotonic IDs for later clusters; write every repair to the audit."
        ),
    )
    map_parser.add_argument(
        "--plan-dir",
        help="Explicitly write summary/map/audit artifacts to this directory.",
    )
    map_parser.add_argument(
        "--output-id-map",
        help="Explicit final id_map.json destination; omitted means no map file is written.",
    )

    reindex_parser = subparsers.add_parser(
        "reindex-staging",
        help="Apply an explicit post-merge old->idNNNNNN map into staging.",
    )
    _add_common_arguments(reindex_parser)
    reindex_parser.add_argument("--import-root", required=True, help="export-existing staging root")
    reindex_parser.add_argument("--id-map", required=True, help="Post-merge id_map.json")
    reindex_parser.add_argument(
        "--input-plan-dir",
        help="Reuse a reviewed reindex plan instead of rescanning the live Library.",
    )
    reindex_parser.add_argument(
        "--allocate-missing",
        action="store_true",
        help="Explicitly append missing ids after the highest occupied id.",
    )
    reindex_parser.add_argument(
        "--include-abstract",
        action="store_true",
        help="Also inspect AbstractLibrary JSON references (off by default).",
    )
    reindex_parser.add_argument(
        "--workers",
        type=int,
        default=max(1, available_cpu_count() * 4),
        help="Parallel reference rewrite workers; default is 4x detected CPU quota.",
    )
    return parser


def _require_staging(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    if getattr(args, "apply", False) and not getattr(args, "staging_root", None):
        parser.error("--apply requires --staging-root")
    if getattr(args, "staging_root", None) and not getattr(args, "apply", False):
        parser.error("--staging-root is only valid with --apply")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "build-id-map":
        base_map = load_id_map(args.base_id_map) if args.base_id_map else None
        plan = build_id_map_plan(
            args.organizer_index,
            args.import_root,
            organizer_plan=args.organizer_plan,
            base_id_map=base_map,
            repair_id_collisions=args.repair_id_collisions,
        )
        if args.plan_dir:
            write_id_map_plan(plan, args.plan_dir)
        output_state = write_id_map(plan, args.output_id_map) if args.output_id_map else None
        output = {
            "phase": args.command,
            "summary": plan["summary"],
            "result": {
                "dry_run": not bool(args.plan_dir or args.output_id_map),
                "plan_dir": str(Path(args.plan_dir).resolve()) if args.plan_dir else None,
                "output_id_map": (
                    str(Path(args.output_id_map).resolve()) if args.output_id_map else None
                ),
                "output_state": output_state,
            },
        }
        sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
        return 0

    _require_staging(args, parser)

    if args.command == "export-existing":
        if args.workers < 1:
            parser.error("--workers must be >= 1")
        if args.refresh_unavailable and not args.input_plan_dir:
            parser.error("--refresh-unavailable requires --input-plan-dir")
        if args.legacy_only and args.input_plan_dir:
            parser.error("--legacy-only cannot be combined with --input-plan-dir")
        if args.input_plan_dir:
            plan = load_export_plan(
                args.input_plan_dir,
                library_root=args.library_root,
                workers=args.workers,
                refresh_unavailable=args.refresh_unavailable,
            )
        else:
            plan = build_export_plan(
                args.library_root,
                workers=args.workers,
                legacy_only=args.legacy_only,
            )
        if args.plan_dir:
            write_export_plan(plan, args.plan_dir)
        unavailable = int(plan["summary"].get("unavailable") or 0)
        if args.apply and unavailable:
            result = {
                "failed": unavailable,
                "blocked": True,
                "reason": "one or more existing entities are unavailable",
                "staging_root": str(Path(args.staging_root).resolve()),
            }
        elif args.apply:
            result = apply_export_plan(
                plan,
                args.staging_root,
                workers=args.workers,
            )
        else:
            result = {"dry_run": True}
        output = {"phase": args.command, "summary": plan["summary"], "result": result}
        sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
        return 1 if result.get("failed") else 0

    id_map = load_id_map(args.id_map)
    export_rows = _load_export_manifest(Path(args.import_root))
    if args.allocate_missing:
        id_map = allocate_incremental_ids(
            [str(item.get("identity_key") or "") for item in export_rows],
            id_map,
        )
    if args.input_plan_dir:
        plan = load_reindex_plan(
            args.input_plan_dir,
            library_root=args.library_root,
            import_root=args.import_root,
        )
        if plan["id_map"] != id_map:
            raise ValueError("Saved reindex plan id_map differs from --id-map")
    else:
        plan = build_reindex_plan(
            args.library_root,
            args.import_root,
            id_map,
            include_abstract=args.include_abstract,
        )
    if args.plan_dir:
        write_reindex_plan(plan, args.plan_dir)
    result = (
        apply_reindex_plan(plan, args.staging_root, workers=args.workers)
        if args.apply
        else {"dry_run": True}
    )
    output = {"phase": args.command, "summary": plan["summary"], "result": result}
    sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    return 1 if result.get("failed") or result.get("collisions") else 0


if __name__ == "__main__":
    raise SystemExit(main())
