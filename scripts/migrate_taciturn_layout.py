"""One-time in-place migration to the canonical TaciturnRaw v2 layout.

The migration has deliberately different semantics from the historical
staging reindexer: it rewrites the authoritative source artifacts once, then
runtime code reads only canonical ``idNNNNNN`` identities.  The legacy map is
retained solely in the immutable migration audit and is never a runtime
lookup.

Default execution is a read-only plan.  ``--apply`` requires a blocker-free
plan and performs these resumable operations under an exclusive layout lock:

* remove only model-reviewed, high-confidence incomplete Noise candidates;
* retire incomplete derived artifacts instead of relabelling them as a
  complete edition;
* collapse verified duplicate legacy producers and rename every active
  resource directory/file to its final canonical ID;
* rename the four TaciturnRaw roots and structurally rewrite IDs, chapter IDs,
  paths, registries, bridge indexes and abstract-library references;
* register pre-existing canonical cleaned results so future hardmodel runs do
  not recompute them;
* publish a hardmodel gate only after the final consistency audit succeeds.

The operation is idempotent.  A rerun after interruption resumes from either
the legacy or v2 physical root and only rewrites values that still differ.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
from typing import Any, Iterable, Iterator, Mapping
import uuid

from fetcher.local_resources import available_cpu_count
from scripts.processed_corpus_migration import LAYOUT_PATH_REPLACEMENTS, rewrite_json_payload
from shared import chapter_id_for


LAYOUT_VERSION = "taciturn-source-layout-migration-v2"
HARDMODEL_GATE_VERSION = "taciturn-hardmodel-resource-gate-v1"
CANONICAL_ID_RE = re.compile(r"^id\d{6}$")
LEGACY_SLUG_RE = re.compile(r"^(?P<kind>book|story)_(?P<number>\d+)$")
LEGACY_BACKUP_RE = re.compile(r"^(?P<slug>(?:book|story)_\d+)\.old$")
LEGACY_NESTED_CHAPTER_RE = re.compile(
    r"^(?:(?:book|story)_)?\d+[Cc](?P<order>\d+)$"
)
LEGACY_UNIT_CHAPTER_RE = re.compile(
    r"^(?:book|story)_\d+_chapter_(?P<chapter>\d+)_unit_(?P<unit>\d+)$"
)
STRUCTURED_SUFFIXES = {".json", ".jsonl"}
STRUCTURED_MARKERS = {
    ".hardmodel.done",
    ".softmodel.done",
    ".infermodel.done",
}
LEGACY_RUNTIME_TOKEN_BYTES_RE = re.compile(
    rb"(?<![A-Za-z0-9_])(?:book|story)_\d{4,}(?!\d)"
)
GENERATED_RUNTIME_REFERENCE_ROOTS = (
    "Bridges",
    "BridgeIndex",
    "LLMExtracted",
    "AbstractLibrary",
)
RAW_PROVENANCE_KEYS = (
    "layout_version",
    "canonical_id",
    "content_id",
    "edition_id",
    "normalized_sha256",
    "work_id",
    "category_code",
    "version_label",
)


@dataclass(frozen=True, slots=True)
class ResourceStage:
    name: str
    new_relative_root: str
    old_relative_root: str | None
    kind: str
    rewrite_mode: str


RESOURCE_STAGES = (
    ResourceStage("stories", "TaciturnRaw/00_Stories", "TaciturnRaw/stories_raw", "story", "all"),
    ResourceStage(
        "cleaned",
        "TaciturnRaw/02_CleanedData",
        "TaciturnRaw/novels_cleaned",
        "book",
        "all",
    ),
    ResourceStage(
        "chapter_analysis",
        "TaciturnRaw/03_ChapterAnalysis",
        "TaciturnRaw/novels_chapter",
        "book",
        "all",
    ),
    ResourceStage("novel_bridges", "Bridges/novels_plot", None, "book", "all"),
    ResourceStage("story_bridges", "Bridges/stories_plot", None, "story", "all"),
    ResourceStage("llm_extracted", "LLMExtracted", None, "book", "all"),
)

ROOT_TRANSITIONS = (
    ("TaciturnRaw/stories_raw", "TaciturnRaw/00_Stories"),
    ("TaciturnRaw/novels_raw", "TaciturnRaw/01_RawData"),
    ("TaciturnRaw/novels_cleaned", "TaciturnRaw/02_CleanedData"),
    ("TaciturnRaw/novels_chapter", "TaciturnRaw/03_ChapterAnalysis"),
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _progress(phase: str, **fields: Any) -> None:
    """Emit machine-readable progress without contaminating stdout results."""
    payload = {"at": _utc_now(), "phase": phase, **fields}
    sys.stderr.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def _json_bytes(payload: Any, *, pretty: bool = True) -> bytes:
    kwargs: dict[str, Any] = {"ensure_ascii": False}
    if pretty:
        kwargs["indent"] = 2
    else:
        kwargs["separators"] = (",", ":")
    return (json.dumps(payload, **kwargs) + "\n").encode("utf-8")


def _atomic_write(
    path: Path,
    payload: bytes,
    *,
    durable: bool = False,
    known_current: bytes | None = None,
    parent_ready: bool = False,
) -> str:
    if not parent_ready:
        path.parent.mkdir(parents=True, exist_ok=True)
    if known_current is not None:
        if known_current == payload:
            return "unchanged"
    elif path.is_file() and path.read_bytes() == payload:
        return "unchanged"
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            if durable:
                os.fsync(handle.fileno())
        os.replace(temporary, path)
        if durable:
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)
    return "written"


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return payload


def _iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_no}") from exc
            if not isinstance(payload, dict):
                raise ValueError(f"Expected JSON object at {path}:{line_no}")
            yield payload


def _identity(kind: str, slug: str) -> str:
    return f"{kind}:{slug}"


def _slug_from_identity(identity: str) -> str:
    return identity.split(":", 1)[1] if ":" in identity else identity


def _stat_token(path: Path) -> list[int]:
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_lineage(path: Path) -> tuple[dict[str, str], dict[str, dict[str, Any]], dict[str, Any]]:
    payload = _load_json_object(path)
    if payload.get("layout_version") != "taciturn-canonical-id-lineage-v1":
        raise ValueError(f"Unsupported canonical lineage: {path}")
    mappings = {str(k): str(v) for k, v in dict(payload.get("mappings", {})).items()}
    for identity, canonical in mappings.items():
        if not re.fullmatch(r"(?:book|story):(?:book|story)_\d+", identity):
            raise ValueError(f"Invalid legacy identity in lineage: {identity!r}")
        if not CANONICAL_ID_RE.fullmatch(canonical):
            raise ValueError(f"Invalid canonical ID in lineage: {canonical!r}")
    retired: dict[str, dict[str, Any]] = {}
    for row in payload.get("retired_identities", []):
        if not isinstance(row, dict):
            raise ValueError("retired_identities must contain JSON objects")
        identity = str(row.get("identity_key") or "")
        if row.get("status") != "retired_incomplete" or not row.get("requires_rebuild"):
            raise ValueError(f"Retired identity lacks incomplete/rebuild guard: {identity}")
        retired[identity] = dict(row)
    overlap = set(mappings).intersection(retired)
    if overlap:
        raise ValueError(f"Active and retired lineage overlap: {sorted(overlap)[:5]}")
    return mappings, retired, payload


def _load_representatives(path: Path, mappings: Mapping[str, str]) -> dict[str, str]:
    payload = _load_json_object(path)
    representatives = {
        str(canonical): str(identity)
        for canonical, identity in dict(payload.get("representatives", {})).items()
    }
    for canonical, identity in representatives.items():
        if identity in mappings and mappings[identity] != canonical:
            raise ValueError(
                f"Representative target disagrees with repaired lineage: {identity}"
            )
    return representatives


def _stage_live_root(library_root: Path, stage: ResourceStage) -> tuple[Path, str]:
    new_root = library_root / stage.new_relative_root
    old_root = library_root / stage.old_relative_root if stage.old_relative_root else None
    if new_root.exists() and old_root is not None and old_root.exists():
        return new_root, "conflict"
    if new_root.exists():
        return new_root, "v2"
    if old_root is not None and old_root.exists():
        return old_root, "legacy"
    return new_root, "missing"


def _resource_operations(
    library_root: Path,
    mappings: Mapping[str, str],
    retired: Mapping[str, Mapping[str, Any]],
    representatives: Mapping[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], dict[str, int]]:
    directory_ops: list[dict[str, Any]] = []
    file_ops: list[dict[str, Any]] = []
    blockers: list[str] = []
    stage_counts: dict[str, int] = {}

    for stage in RESOURCE_STAGES:
        root, root_state = _stage_live_root(library_root, stage)
        if root_state == "conflict":
            blockers.append(
                f"both legacy and v2 roots exist for {stage.name}: "
                f"{stage.old_relative_root}, {stage.new_relative_root}"
            )
            continue
        if not root.is_dir():
            stage_counts[stage.name] = 0
            continue
        children = [child for child in root.iterdir() if child.is_dir()]
        stage_counts[stage.name] = len(children)
        canonical_existing = {child.name: child for child in children if CANONICAL_ID_RE.fullmatch(child.name)}
        grouped: dict[str, list[tuple[str, Path]]] = defaultdict(list)
        for child in children:
            match = LEGACY_SLUG_RE.fullmatch(child.name)
            if match is not None:
                kind = match.group("kind")
                if kind != stage.kind:
                    blockers.append(f"{stage.name}: unexpected {kind} slug {child.name}")
                    continue
                identity = _identity(kind, child.name)
                if identity in retired:
                    directory_ops.append(
                        {
                            "action": "delete_retired_incomplete",
                            "stage": stage.name,
                            "root": stage.new_relative_root,
                            "source_name": child.name,
                            "identity_key": identity,
                            "reason": retired[identity].get("reason", "retired_incomplete"),
                        }
                    )
                elif identity in mappings:
                    grouped[mappings[identity]].append((identity, child))
                else:
                    blockers.append(f"{stage.name}: unmapped legacy directory {child}")
                continue
            backup = LEGACY_BACKUP_RE.fullmatch(child.name)
            if backup is not None:
                base = root / backup.group("slug")
                if base.is_dir():
                    directory_ops.append(
                        {
                            "action": "delete_stale_backup",
                            "stage": stage.name,
                            "root": stage.new_relative_root,
                            "source_name": child.name,
                            "reason": "explicit .old backup has an active sibling",
                        }
                    )
                else:
                    blockers.append(f"{stage.name}: orphan backup needs review: {child}")
                continue
            if child.name == ".hardmodel_staging":
                if any(child.iterdir()):
                    blockers.append(f"{stage.name}: non-empty hardmodel staging: {child}")
                else:
                    directory_ops.append(
                        {
                            "action": "delete_empty_staging",
                            "stage": stage.name,
                            "root": stage.new_relative_root,
                            "source_name": child.name,
                            "reason": "empty interrupted-run staging directory",
                        }
                    )
                continue
            if not CANONICAL_ID_RE.fullmatch(child.name):
                blockers.append(f"{stage.name}: unknown resource directory {child}")

        for canonical, sources in sorted(grouped.items()):
            if canonical in canonical_existing:
                blockers.append(
                    f"{stage.name}: canonical target {canonical} coexists with legacy "
                    f"sources {[path.name for _, path in sources]}"
                )
                continue
            requested = representatives.get(canonical, "")
            selected = next((item for item in sources if item[0] == requested), None)
            if selected is None:
                selected = sorted(sources, key=lambda item: item[0])[0]
            selected_identity, selected_path = selected
            aliases = sorted(identity for identity, _ in sources)
            for identity, path in sources:
                if path == selected_path:
                    continue
                directory_ops.append(
                    {
                        "action": "delete_verified_duplicate",
                        "stage": stage.name,
                        "root": stage.new_relative_root,
                        "source_name": path.name,
                        "identity_key": identity,
                        "canonical_id": canonical,
                        "representative_identity": selected_identity,
                        "reason": "verified legacy identities share one canonical edition",
                    }
                )
            directory_ops.append(
                {
                    "action": "rename_canonical",
                    "stage": stage.name,
                    "root": stage.new_relative_root,
                    "source_name": selected_path.name,
                    "target_name": canonical,
                    "identity_key": selected_identity,
                    "legacy_identities": aliases,
                }
            )

    bridge_index = library_root / "BridgeIndex/books"
    if bridge_index.is_dir():
        grouped_files: dict[str, list[tuple[str, Path]]] = defaultdict(list)
        for path in bridge_index.iterdir():
            if not path.is_file():
                continue
            match = re.match(r"^(?P<slug>book_\d+)(?P<suffix>.*)$", path.name)
            if match is None:
                continue
            slug = match.group("slug")
            identity = _identity("book", slug)
            if identity in retired:
                file_ops.append(
                    {
                        "action": "delete_retired_incomplete",
                        "root": "BridgeIndex/books",
                        "source_name": path.name,
                        "identity_key": identity,
                    }
                )
                continue
            canonical = mappings.get(identity)
            if canonical is None:
                blockers.append(f"BridgeIndex: unmapped legacy file {path}")
                continue
            grouped_files[canonical + match.group("suffix")].append((identity, path))
        for target_name, sources in sorted(grouped_files.items()):
            target = bridge_index / target_name
            if target.exists():
                blockers.append(f"BridgeIndex target already exists beside legacy source: {target}")
                continue
            canonical = target_name[:8]
            requested = representatives.get(canonical, "")
            selected = next((item for item in sources if item[0] == requested), None)
            if selected is None:
                selected = sorted(sources, key=lambda item: item[0])[0]
            for identity, path in sources:
                if path != selected[1]:
                    file_ops.append(
                        {
                            "action": "delete_verified_duplicate",
                            "root": "BridgeIndex/books",
                            "source_name": path.name,
                            "identity_key": identity,
                            "canonical_id": canonical,
                        }
                    )
            file_ops.append(
                {
                    "action": "rename_canonical",
                    "root": "BridgeIndex/books",
                    "source_name": selected[1].name,
                    "target_name": target_name,
                    "identity_key": selected[0],
                    "canonical_id": canonical,
                }
            )
    return directory_ops, file_ops, blockers, stage_counts


def _raw_root(library_root: Path) -> Path:
    new = library_root / "TaciturnRaw/01_RawData"
    old = library_root / "TaciturnRaw/novels_raw"
    if new.exists() and old.exists():
        raise ValueError(f"Both raw roots exist: {old}, {new}")
    return new if new.exists() else old


def _raw_records(raw_root: Path, required_ids: set[str] | None = None) -> tuple[dict[str, dict[str, Any]], int, int]:
    records: dict[str, dict[str, Any]] = {}
    count = high_water = 0
    for row in _iter_jsonl(raw_root / "index.jsonl"):
        canonical = str(row.get("canonical_id") or row.get("content_id") or "")
        if not CANONICAL_ID_RE.fullmatch(canonical):
            raise ValueError(f"Invalid raw canonical id: {canonical!r}")
        count += 1
        high_water = max(high_water, int(canonical[2:]))
        if required_ids is None or canonical in required_ids:
            if canonical in records:
                raise ValueError(f"Duplicate raw canonical ID: {canonical}")
            records[canonical] = row
    return records, count, high_water


def _noise_delete_plan(
    decision_manifest: Path,
    noise_root: Path,
    raw_ids: set[str],
) -> tuple[list[dict[str, Any]], list[str], int]:
    decisions = [
        row
        for row in _iter_jsonl(decision_manifest)
        if row.get("publication_action") == "exclude_incomplete_candidate_from_final_raw"
    ]
    blockers: list[str] = []
    by_relative: dict[str, dict[str, Any]] = {}
    for row in decisions:
        if row.get("guarded_action") != "recommend_remove_after_audit":
            blockers.append(f"unguarded deletion decision: {row.get('review_id')}")
            continue
        model_result = row.get("model_result")
        confidence = float(model_result.get("confidence") or 0) if isinstance(model_result, dict) else 0.0
        if confidence < 0.95:
            blockers.append(f"deletion confidence below 0.95: {row.get('review_id')}")
        candidate = Path(str(row.get("candidate_source") or "")).resolve()
        try:
            relative = candidate.relative_to(noise_root.resolve()).as_posix()
        except ValueError:
            blockers.append(f"candidate is outside Noise: {candidate}")
            continue
        if relative in by_relative:
            blockers.append(f"duplicate deletion path in manifest: {relative}")
        by_relative[relative] = row
        if str(row.get("candidate_id") or "") in raw_ids:
            blockers.append(f"candidate still present in final raw: {row.get('candidate_id')}")
        if str(row.get("preferred_id") or "") not in raw_ids:
            blockers.append(f"preferred version absent from final raw: {row.get('preferred_id')}")

    indexed_by_relative: dict[str, dict[str, Any]] = {}
    index_count = 0
    with (noise_root / "index.jsonl").open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue
            index_count += 1
            row = json.loads(raw)
            relative = str(row.get("file") or "")
            if relative in by_relative:
                if relative in indexed_by_relative:
                    blockers.append(f"Noise index repeats deletion path: {relative}")
                indexed_by_relative[relative] = row

    candidates: list[dict[str, Any]] = []
    for relative, decision in sorted(by_relative.items()):
        path = noise_root / relative
        public_row = indexed_by_relative.get(relative)
        if path.exists() and not path.is_file():
            blockers.append(f"delete target is not a regular file: {path}")
        if path.is_file() and public_row is None:
            blockers.append(f"live delete target missing from Noise index: {relative}")
        candidates.append(
            {
                "review_id": decision.get("review_id"),
                "candidate_id": decision.get("candidate_id"),
                "preferred_id": decision.get("preferred_id"),
                "work_id": decision.get("work_id"),
                "relative_path": relative,
                "public_content_id": (public_row or {}).get("content_id"),
                "normalized_sha256": (public_row or {}).get("normalized_sha256"),
                "confidence": (decision.get("model_result") or {}).get("confidence"),
                "guard_reason": decision.get("guard_reason"),
                "stat_token": _stat_token(path) if path.is_file() else None,
                "size_bytes": path.stat().st_size if path.is_file() else 0,
                "already_deleted": not path.exists() and public_row is None,
            }
        )
    if len(candidates) != len(decisions):
        blockers.append(
            f"decision path cardinality changed: {len(decisions)} decisions, {len(candidates)} paths"
        )
    return candidates, blockers, index_count


def build_plan(
    library_root: str | Path,
    lineage_path: str | Path,
    representatives_path: str | Path,
    decision_manifest: str | Path,
) -> dict[str, Any]:
    library = Path(library_root).resolve()
    lineage_file = Path(lineage_path).resolve()
    representative_file = Path(representatives_path).resolve()
    decision_file = Path(decision_manifest).resolve()
    mappings, retired, lineage = _load_lineage(lineage_file)
    representatives = _load_representatives(representative_file, mappings)
    directory_ops, file_ops, blockers, stage_counts = _resource_operations(
        library, mappings, retired, representatives
    )

    required_ids = set(mappings.values())
    required_ids.update(
        str(row.get("superseded_by") or "")
        for row in retired.values()
        if CANONICAL_ID_RE.fullmatch(str(row.get("superseded_by") or ""))
    )
    for stage in RESOURCE_STAGES:
        if stage.name != "cleaned":
            continue
        root, _ = _stage_live_root(library, stage)
        if root.is_dir():
            required_ids.update(
                child.name
                for child in root.iterdir()
                if child.is_dir() and CANONICAL_ID_RE.fullmatch(child.name)
            )
    raw_root = _raw_root(library)
    raw_records, raw_count, high_water = _raw_records(raw_root, required_ids=None)
    missing_raw = sorted(required_ids - set(raw_records))
    if missing_raw:
        blockers.append(f"canonical resources absent from raw: {missing_raw[:20]}")

    for identity, canonical in mappings.items():
        row = raw_records.get(canonical)
        expected_hash = next(
            (
                item.get("normalized_sha256")
                for item in _iter_jsonl(lineage_file.with_name("identity_lineage.jsonl"))
                if item.get("identity_key") == identity
            ),
            None,
        )
        if expected_hash and row and row.get("normalized_sha256") != expected_hash:
            blockers.append(f"lineage hash disagrees with raw for {identity} -> {canonical}")

    noise_candidates, noise_blockers, noise_index_count = _noise_delete_plan(
        decision_file,
        library / "Noise",
        set(raw_records),
    )
    blockers.extend(noise_blockers)
    active_by_canonical: dict[str, list[str]] = defaultdict(list)
    for identity, canonical in mappings.items():
        active_by_canonical[canonical].append(identity)

    reserved_high_water = max(
        [
            high_water,
            *(
                int(str(value)[2:])
                for item in noise_candidates
                for value in (item.get("candidate_id"), item.get("public_content_id"))
                if (match := CANONICAL_ID_RE.fullmatch(str(value or ""))) is not None
            ),
        ]
    )

    return {
        "layout_version": LAYOUT_VERSION,
        "created_at": _utc_now(),
        "library_root": str(library),
        "inputs": {
            "canonical_lineage": str(lineage_file),
            "canonical_lineage_sha256": _sha256(lineage_file),
            "representatives": str(representative_file),
            "representatives_sha256": _sha256(representative_file),
            "decision_manifest": str(decision_file),
            "decision_manifest_sha256": _sha256(decision_file),
        },
        "root_transitions": [
            {"old": old, "new": new} for old, new in ROOT_TRANSITIONS
        ],
        "mappings": dict(mappings),
        "representatives": dict(representatives),
        "retired_identities": list(retired.values()),
        "canonical_legacy_identities": {
            canonical: sorted(identities)
            for canonical, identities in sorted(active_by_canonical.items())
        },
        "raw_records": {canonical: raw_records[canonical] for canonical in sorted(required_ids)},
        "directory_operations": directory_ops,
        "file_operations": file_ops,
        "noise_deletions": noise_candidates,
        "blockers": blockers,
        "summary": {
            "active_legacy_identities": len(mappings),
            "active_canonical_resources": len(active_by_canonical),
            "retired_incomplete_identities": len(retired),
            "raw_books": raw_count,
            "raw_id_high_watermark": high_water,
            "global_id_high_watermark": reserved_high_water,
            "noise_index_rows_before": noise_index_count,
            "noise_deletions": len(noise_candidates),
            "noise_delete_bytes": sum(int(item["size_bytes"]) for item in noise_candidates),
            "directory_operations": len(directory_ops),
            "file_operations": len(file_ops),
            "stage_directory_counts_before": stage_counts,
            "blockers": len(blockers),
            "runtime_mapping_required_after_apply": False,
        },
    }


def write_plan(plan: Mapping[str, Any], output_dir: str | Path) -> None:
    output = Path(output_dir)
    _atomic_write(output / "plan.json", _json_bytes(plan), durable=True)
    _atomic_write(output / "summary.json", _json_bytes(plan["summary"]), durable=True)
    _atomic_write(
        output / "resource_operations.jsonl",
        b"".join(
            _json_bytes(item, pretty=False)
            for item in [*plan["directory_operations"], *plan["file_operations"]]
        ),
        durable=True,
    )
    _atomic_write(
        output / "noise_deletions.jsonl",
        b"".join(_json_bytes(item, pretty=False) for item in plan["noise_deletions"]),
        durable=True,
    )


def load_plan(path: str | Path) -> dict[str, Any]:
    plan_path = Path(path)
    if plan_path.is_dir():
        plan_path = plan_path / "plan.json"
    payload = _load_json_object(plan_path)
    if payload.get("layout_version") != LAYOUT_VERSION:
        raise ValueError(f"Unsupported migration plan: {plan_path}")
    return payload


def _validate_frozen_inputs(plan: Mapping[str, Any]) -> None:
    for name in ("canonical_lineage", "representatives", "decision_manifest"):
        path = Path(str(plan["inputs"][name]))
        expected = str(plan["inputs"][f"{name}_sha256"])
        if not path.is_file() or _sha256(path) != expected:
            raise ValueError(f"Frozen migration input changed: {name} ({path})")


def _apply_root_transitions(library_root: Path, transitions: Iterable[Mapping[str, Any]]) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for item in transitions:
        old = library_root / str(item["old"])
        new = library_root / str(item["new"])
        if old.exists() and new.exists():
            raise ValueError(f"Cannot merge two live roots during cutover: {old}, {new}")
        if old.exists():
            new.parent.mkdir(parents=True, exist_ok=True)
            os.rename(old, new)
            results.append({"old": str(old), "new": str(new), "state": "renamed"})
        elif new.exists():
            results.append({"old": str(old), "new": str(new), "state": "already_v2"})
        else:
            # Empty optional roots (notably stories) are allowed to be absent.
            results.append({"old": str(old), "new": str(new), "state": "absent"})
    retired_story_cleaned = library_root / "TaciturnRaw/stories_cleaned"
    if retired_story_cleaned.exists():
        if not retired_story_cleaned.is_dir() or any(retired_story_cleaned.iterdir()):
            raise ValueError(
                f"Retired stories_cleaned is not empty and cannot be deleted: {retired_story_cleaned}"
            )
        retired_story_cleaned.rmdir()
        results.append(
            {
                "old": str(retired_story_cleaned),
                "new": "",
                "state": "deleted_empty_retired_stage",
            }
        )
    return results


def _apply_resource_operations(
    library_root: Path,
    directory_ops: Iterable[Mapping[str, Any]],
    file_ops: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    counters: Counter[str] = Counter()
    # Remove retired/duplicate producers before publishing their representative
    # into the now-unambiguous canonical target.
    delete_actions = {
        "delete_retired_incomplete",
        "delete_verified_duplicate",
        "delete_stale_backup",
        "delete_empty_staging",
    }
    directory_rows = list(directory_ops)
    file_rows = list(file_ops)
    for row in directory_rows:
        if row["action"] not in delete_actions:
            continue
        source = library_root / str(row["root"]) / str(row["source_name"])
        if source.exists():
            if not source.is_dir():
                raise ValueError(f"Expected resource directory: {source}")
            shutil.rmtree(source)
            counters[str(row["action"])] += 1
        else:
            counters[f"{row['action']}_already_absent"] += 1
    for row in file_rows:
        if row["action"] not in delete_actions:
            continue
        source = library_root / str(row["root"]) / str(row["source_name"])
        if source.exists():
            if not source.is_file():
                raise ValueError(f"Expected resource file: {source}")
            source.unlink()
            counters[str(row["action"])] += 1
        else:
            counters[f"{row['action']}_already_absent"] += 1

    for row in directory_rows:
        if row["action"] != "rename_canonical":
            continue
        root = library_root / str(row["root"])
        source = root / str(row["source_name"])
        target = root / str(row["target_name"])
        if source.exists() and target.exists():
            raise ValueError(f"Canonical target collision during apply: {source}, {target}")
        if source.exists():
            os.rename(source, target)
            counters["directories_renamed"] += 1
        elif target.is_dir():
            counters["directories_already_renamed"] += 1
        else:
            raise FileNotFoundError(f"Neither source nor target exists: {source}, {target}")
    for row in file_rows:
        if row["action"] != "rename_canonical":
            continue
        root = library_root / str(row["root"])
        source = root / str(row["source_name"])
        target = root / str(row["target_name"])
        if source.exists() and target.exists():
            raise ValueError(f"Canonical file target collision: {source}, {target}")
        if source.exists():
            os.rename(source, target)
            counters["files_renamed"] += 1
        elif target.is_file():
            counters["files_already_renamed"] += 1
        else:
            raise FileNotFoundError(f"Neither source nor target exists: {source}, {target}")
    return dict(counters)


def _apply_noise_deletions(
    library_root: Path,
    rows: Iterable[Mapping[str, Any]],
    audit_root: Path,
) -> dict[str, Any]:
    noise_root = library_root / "Noise"
    candidates = list(rows)
    relative_paths = {str(row["relative_path"]) for row in candidates}
    if len(relative_paths) != len(candidates):
        raise ValueError("Noise deletion plan contains duplicate paths")

    present: list[tuple[Path, Mapping[str, Any]]] = []
    for row in candidates:
        path = noise_root / str(row["relative_path"])
        if not path.exists():
            continue
        if not path.is_file():
            raise ValueError(f"Noise deletion target is no longer a file: {path}")
        expected = row.get("stat_token")
        if expected is not None and _stat_token(path) != [int(value) for value in expected]:
            raise ValueError(f"Noise deletion target changed since planning: {path}")
        present.append((path, row))

    index = noise_root / "index.jsonl"
    temporary = index.with_name(f".{index.name}.{uuid.uuid4().hex}.tmp")
    removed_index_rows = kept_index_rows = 0
    try:
        with index.open("r", encoding="utf-8") as source, temporary.open("x", encoding="utf-8") as target:
            for line_no, raw in enumerate(source, start=1):
                if not raw.strip():
                    continue
                payload = json.loads(raw)
                relative = str(payload.get("file") or "")
                if relative in relative_paths:
                    removed_index_rows += 1
                    continue
                target.write(raw if raw.endswith("\n") else raw + "\n")
                kept_index_rows += 1
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, index)
    finally:
        temporary.unlink(missing_ok=True)

    deleted_bytes = 0
    deleted_rows: list[dict[str, Any]] = []
    for path, row in present:
        size = path.stat().st_size
        path.unlink()
        deleted_bytes += size
        deleted_rows.append(
            {
                **dict(row),
                "deleted_at": _utc_now(),
                "deleted_path": str(path),
                "deleted_size_bytes": size,
                "delete_reason": "confirmed_incomplete_and_superseded",
            }
        )
    ledger = audit_root / "retired_incomplete_noise.jsonl"
    # Preserve the first successful deletion ledger on an idempotent resume.
    # Replacing it with the original candidates would lose deleted_at and the
    # observed byte count after every target has already disappeared.
    if deleted_rows or not ledger.is_file():
        _atomic_write(
            ledger,
            b"".join(_json_bytes(item, pretty=False) for item in deleted_rows or candidates),
            durable=True,
        )
    return {
        "planned": len(candidates),
        "files_present_before_apply": len(present),
        "files_deleted": len(deleted_rows),
        "bytes_deleted": deleted_bytes,
        "index_rows_removed": removed_index_rows,
        "index_rows_kept": kept_index_rows,
        "ledger": str(ledger),
    }


def _raw_relative_paths(raw: Mapping[str, Any]) -> dict[str, str]:
    target_dir = str(raw.get("target_dir") or "")
    if not target_dir:
        raise ValueError(f"Raw record lacks target_dir: {raw.get('canonical_id')}")
    base = f"TaciturnRaw/01_RawData/{target_dir}"
    return {
        "dir": base,
        "source": f"{base}/source.txt",
        "index": f"{base}/index.json",
    }


def _canonical_raw_provenance(raw: Mapping[str, Any]) -> dict[str, Any]:
    provenance: dict[str, Any] = {}
    for key in RAW_PROVENANCE_KEYS:
        value = raw.get(key)
        if key == "version_label" and value is None:
            value = ""
        if key != "version_label" and not value:
            raise ValueError(f"Raw record lacks provenance {key}: {raw.get('canonical_id')}")
        provenance[key] = value
    return provenance


def _raw_reference(raw: Mapping[str, Any]) -> dict[str, Any]:
    canonical = str(raw["canonical_id"])
    paths = _raw_relative_paths(raw)
    return {
        "content_id": canonical,
        "raw_book_id": canonical,
        "raw_book_slug": canonical,
        "raw_path": paths["dir"],
        "raw_primary_source": paths["source"],
        "raw_index_path": paths["index"],
        "source_signature": f"normalized_sha256:{raw['normalized_sha256']}",
        "source_url": "",
        "adapter_domain": "local-corpus",
        "title": str(raw.get("title") or ""),
        "author": str(raw.get("author") or "佚名"),
        "content_type": "content",
        "processing_profile": "longform_book",
        "chapter_count": 1,
        "fetcher_run_id": "",
        "identity_key": f"edition:{raw.get('edition_id')}",
        "edition_id": raw.get("edition_id"),
        "work_id": raw.get("work_id"),
        "normalized_sha256": raw.get("normalized_sha256"),
    }


def _reserved_global_id_high_watermark(plan: Mapping[str, Any]) -> int:
    """Return the highest ID ever issued, including retired Noise candidates."""
    values = [int(plan["summary"]["global_id_high_watermark"])]
    for row in plan.get("noise_deletions", []):
        for key in ("candidate_id", "public_content_id"):
            match = CANONICAL_ID_RE.fullmatch(str(row.get(key) or ""))
            if match is not None:
                values.append(int(str(row.get(key))[2:]))
    return max(values)


def _set(mapping: dict[str, Any], key: str, value: Any) -> bool:
    if mapping.get(key) == value:
        return False
    mapping[key] = value
    return True


def _canonicalize_nested_chapter_value(value: Any, canonical_id: str) -> Any:
    if not isinstance(value, str):
        return value
    unit = LEGACY_UNIT_CHAPTER_RE.fullmatch(value)
    if unit is not None:
        return (
            f"{canonical_id}_chapter_{unit.group('chapter')}"
            f"_unit_{unit.group('unit')}"
        )
    chapter = LEGACY_NESTED_CHAPTER_RE.fullmatch(value)
    if chapter is not None:
        return chapter_id_for(canonical_id, int(chapter.group("order")))
    return value


def _normalize_nested_chapter_ids(payload: Any, canonical_id: str) -> bool:
    """Rewrite chapter IDs nested below manifests, anomalies and plot units."""
    changed = False
    if isinstance(payload, dict):
        for key, value in list(payload.items()):
            if key == "chapter_id" or key.endswith("_chapter_id") or key.endswith("_unit_id"):
                normalized = _canonicalize_nested_chapter_value(value, canonical_id)
                if normalized != value:
                    payload[key] = normalized
                    value = normalized
                    changed = True
            elif key.endswith("chapter_ids") and isinstance(value, list):
                normalized_items = [
                    _canonicalize_nested_chapter_value(item, canonical_id)
                    for item in value
                ]
                if normalized_items != value:
                    payload[key] = normalized_items
                    value = normalized_items
                    changed = True
            changed |= _normalize_nested_chapter_ids(value, canonical_id)
    elif isinstance(payload, list):
        for item in payload:
            changed |= _normalize_nested_chapter_ids(item, canonical_id)
    return changed


def _drop_deprecated_runtime_mapping_fields(payload: Any) -> bool:
    """Remove per-resource legacy alias lists after the one-time rewrite.

    The immutable migration plan and deletion ledgers retain those aliases for
    auditability.  Runtime artifacts keep only their canonical ID and reuse
    status, so no later stage can mistake provenance aliases for a mapping it
    should apply again.
    """

    changed = False
    if isinstance(payload, dict):
        if "legacy_identities" in payload:
            payload.pop("legacy_identities", None)
            changed = True
        for value in payload.values():
            changed |= _drop_deprecated_runtime_mapping_fields(value)
    elif isinstance(payload, list):
        for value in payload:
            changed |= _drop_deprecated_runtime_mapping_fields(value)
    return changed


def _normalize_payload(
    payload: Any,
    *,
    stage: str,
    canonical_id: str | None,
    path: Path,
    library_root: Path,
    raw: Mapping[str, Any] | None,
    legacy_identities: Iterable[str] = (),
) -> bool:
    if not isinstance(payload, dict) or canonical_id is None:
        return False
    changed = False
    changed |= _normalize_nested_chapter_ids(payload, canonical_id)
    raw_paths = _raw_relative_paths(raw) if raw is not None else None
    raw_ref = _raw_reference(raw) if raw is not None else None
    raw_provenance = _canonical_raw_provenance(raw) if raw is not None else None

    metadata = payload.get("book_metadata")
    if isinstance(metadata, dict):
        changed |= _set(metadata, "book_id", canonical_id)
        if raw_paths is not None:
            changed |= _set(metadata, "source_path", str((library_root / raw_paths["source"]).resolve()))
        registry = metadata.get("clean_registry")
        if isinstance(registry, dict):
            changed |= _set(registry, "clean_id", canonical_id)
            changed |= _set(registry, "clean_slug", canonical_id)
        if raw_ref is not None:
            changed |= _set(metadata, "source_lineage", raw_ref)
        if raw_provenance is not None:
            existing_provenance = metadata.get("canonical_raw_provenance")
            if isinstance(existing_provenance, dict):
                raw_provenance = {**raw_provenance}
                if existing_provenance.get("mapping_manifest_sha256"):
                    raw_provenance["mapping_manifest_sha256"] = existing_provenance[
                        "mapping_manifest_sha256"
                    ]
            changed |= _set(metadata, "canonical_raw_provenance", raw_provenance)
        migration = metadata.setdefault("resource_migration", {})
        if isinstance(migration, dict):
            changed |= _set(migration, "layout_version", LAYOUT_VERSION)
            changed |= _set(migration, "canonical_id", canonical_id)
            if "legacy_identities" in migration:
                migration.pop("legacy_identities", None)
                changed = True
            changed |= _set(
                migration,
                "reuse_status",
                "hash_verified_legacy_reuse" if legacy_identities else "preexisting_canonical_reuse",
            )

    if stage == "cleaned" and path.name != "index.json":
        order = payload.get("order")
        if order is not None:
            changed |= _set(payload, "chapter_id", chapter_id_for(canonical_id, int(order)))
        chapter_metadata = payload.get("metadata")
        if isinstance(chapter_metadata, dict):
            changed |= _set(chapter_metadata, "book_id", canonical_id)
            if raw_paths is not None:
                changed |= _set(
                    chapter_metadata,
                    "source_path",
                    str((library_root / raw_paths["source"]).resolve()),
                )
    elif stage == "chapter_analysis" and path.name != "index.json":
        context = payload.get("chapter_context")
        if isinstance(context, dict):
            order = int(context.get("order") or 0)
            changed |= _set(context, "book_id", canonical_id)
            if order > 0:
                changed |= _set(context, "chapter_id", chapter_id_for(canonical_id, order))
            changed |= _set(
                context,
                "source_file",
                str((library_root / "TaciturnRaw/02_CleanedData" / canonical_id / path.name).resolve()),
            )
        source_ref = payload.get("source_ref")
        if isinstance(source_ref, dict):
            changed |= _set(
                source_ref,
                "chapter_file",
                str((library_root / "TaciturnRaw/02_CleanedData" / canonical_id / path.name).resolve()),
            )
    if stage == "chapter_analysis" and path.name == "index.json":
        changed |= _set(
            payload,
            "source_book_dir",
            str((library_root / "TaciturnRaw/02_CleanedData" / canonical_id).resolve()),
        )
    if stage in {"novel_bridges", "story_bridges"} and path.name == "index.json":
        changed |= _set(
            payload,
            "source_feature_dir",
            str((library_root / "TaciturnRaw/03_ChapterAnalysis" / canonical_id).resolve()),
        )
    if stage == "stories" and path.name == "index.json":
        for key in ("id", "content_id", "book_id", "book_slug", "story_slug"):
            if key in payload:
                changed |= _set(payload, key, canonical_id)
    return changed


def _canonical_id_from_path(path: Path) -> str | None:
    for part in reversed(path.parts):
        if CANONICAL_ID_RE.fullmatch(part):
            return part
    match = re.match(r"^(id\d{6})(?:\.|$)", path.name)
    return match.group(1) if match else None


def _audit_generated_runtime_references(library_root: Path) -> dict[str, Any]:
    """Find legacy identity tokens in model-generated runtime metadata.

    These roots contain machine metadata rather than source novel prose, so a
    remaining ``book_*``/``story_*`` token is always a stale runtime identity,
    including tokens embedded in explanatory strings such as discarded LLM
    observations.  Historical aliases remain available only in the migration
    audit and registry provenance, outside these roots.
    """

    paths: list[Path] = []
    for relative_root in GENERATED_RUNTIME_REFERENCE_ROOTS:
        root = library_root / relative_root
        if not root.is_dir():
            continue
        paths.extend(
            path
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in STRUCTURED_SUFFIXES
        )

    def inspect(path: Path) -> tuple[Path, list[bytes], str | None]:
        try:
            return path, LEGACY_RUNTIME_TOKEN_BYTES_RE.findall(path.read_bytes()), None
        except Exception as exc:
            return path, [], f"{path}: {type(exc).__name__}: {exc}"

    files_scanned = len(paths)
    matched_files = 0
    matched_occurrences = 0
    examples: list[dict[str, Any]] = []
    read_errors: list[str] = []
    audit_workers = max(4, min(32, available_cpu_count() * 4))
    with ThreadPoolExecutor(max_workers=audit_workers) as executor:
        for path, matches, error in executor.map(inspect, paths, chunksize=8):
            if error:
                read_errors.append(error)
                continue
            if not matches:
                continue
            matched_files += 1
            matched_occurrences += len(matches)
            if len(examples) < 50:
                examples.append(
                    {
                        "path": str(path),
                        "occurrences": len(matches),
                        "tokens": sorted(
                            {match.decode("ascii") for match in matches}
                        )[:20],
                    }
                )
    return {
        "files_scanned": files_scanned,
        "matched_files": matched_files,
        "matched_occurrences": matched_occurrences,
        "examples": examples,
        "read_error_count": len(read_errors),
        "read_errors": read_errors[:50],
        "workers": audit_workers,
    }


def _fast_rewrite_canonical_cleaned_chapter(
    path: Path,
    original: bytes,
    *,
    canonical_id: str | None,
    legacy_identities: list[str],
) -> str | None:
    """Patch equal-length legacy roots in already-canonical chapter JSON.

    The 1.8k pre-existing canonical cleaned books already have final content
    and chapter IDs.  Their ~630k chapter files only retained absolute
    ``novels_raw``/``novels_cleaned`` path segments.  Parsing, serializing,
    creating a temporary file and renaming every one of those files multiplies
    remote metadata I/O.  Equal-length path segments can instead be replaced
    by one positional write without changing JSON size or structure.

    The optimization fails closed: any legacy identity alias, noncanonical
    chapter ID, unequal replacement, or remaining old path token falls back to
    the full structural JSON rewriter.
    """
    if (
        canonical_id is None
        or legacy_identities
        or not re.fullmatch(r"chapter_\d+\.json", path.name)
        or original.startswith(b"\xef\xbb\xbf")
    ):
        return None
    chapter_pattern = (
        rb'"chapter_id"\s*:\s*"'
        + re.escape(canonical_id.encode("ascii"))
        + rb'C\d{6}"'
    )
    if re.search(chapter_pattern, original) is None:
        return None

    replacements: list[tuple[bytes, bytes]] = []
    rewritten = original
    for old_text, new_text in LAYOUT_PATH_REPLACEMENTS:
        old = old_text.encode("utf-8")
        new = new_text.encode("utf-8")
        if old not in rewritten:
            continue
        if len(old) != len(new):
            return None
        rewritten = rewritten.replace(old, new)
        replacements.append((old, new))
    if any(old.encode("utf-8") in rewritten for old, _ in LAYOUT_PATH_REPLACEMENTS):
        return None
    if not replacements:
        return "unchanged"

    descriptor = os.open(path, os.O_RDWR)
    try:
        for old, new in replacements:
            offset = 0
            while True:
                offset = original.find(old, offset)
                if offset < 0:
                    break
                os.pwrite(descriptor, new, offset)
                offset += len(old)
    finally:
        os.close(descriptor)
    return "written"


def _rewrite_structured_file(
    task: tuple[Path, str, str, dict[str, str], dict[str, dict[str, Any]], dict[str, list[str]], Path]
) -> tuple[str, str | None]:
    path, stage, kind, mappings, raw_records, aliases, library_root = task
    try:
        original = path.read_bytes()
        if original.startswith(b"\xef\xbb\xbf"):
            raise ValueError("structured metadata contains UTF-8 BOM")
        text = original.decode("utf-8")
        canonical = _canonical_id_from_path(path)
        raw = raw_records.get(canonical or "")
        legacy = aliases.get(canonical or "", [])
        if stage == "cleaned" and path.suffix.lower() == ".json":
            fast_state = _fast_rewrite_canonical_cleaned_chapter(
                path,
                original,
                canonical_id=canonical,
                legacy_identities=legacy,
            )
            if fast_state is not None:
                return fast_state, None
        changed = False
        if path.suffix.lower() == ".jsonl":
            output_lines: list[str] = []
            for line_no, line in enumerate(text.splitlines(), start=1):
                if not line.strip():
                    continue
                payload = json.loads(line)
                rewritten, changes = rewrite_json_payload(
                    payload,
                    mappings,
                    default_kind=kind,
                    rewrite_all_strings=stage
                    in {
                        "novel_bridges",
                        "story_bridges",
                        "llm_extracted",
                        "bridge_index",
                        "abstract_library",
                    },
                )
                dropped_mapping_fields = _drop_deprecated_runtime_mapping_fields(
                    rewritten
                )
                normalized = _normalize_payload(
                    rewritten,
                    stage=stage,
                    canonical_id=canonical,
                    path=path,
                    library_root=library_root,
                    raw=raw,
                    legacy_identities=legacy,
                )
                changed |= bool(changes) or dropped_mapping_fields or normalized
                output_lines.append(json.dumps(rewritten, ensure_ascii=False, separators=(",", ":")))
            if not changed:
                return "unchanged", None
            payload_bytes = ("\n".join(output_lines) + ("\n" if output_lines else "")).encode("utf-8")
        else:
            payload = json.loads(text)
            rewritten, changes = rewrite_json_payload(
                payload,
                mappings,
                default_kind=kind,
                rewrite_all_strings=stage
                in {
                    "novel_bridges",
                    "story_bridges",
                    "llm_extracted",
                    "bridge_index",
                    "abstract_library",
                },
            )
            dropped_mapping_fields = _drop_deprecated_runtime_mapping_fields(
                rewritten
            )
            normalized = _normalize_payload(
                rewritten,
                stage=stage,
                canonical_id=canonical,
                path=path,
                library_root=library_root,
                raw=raw,
                legacy_identities=legacy,
            )
            if not changes and not dropped_mapping_fields and not normalized:
                return "unchanged", None
            pretty = text.lstrip().startswith(("{\n", "[\n"))
            payload_bytes = _json_bytes(rewritten, pretty=pretty)
        state = _atomic_write(
            path,
            payload_bytes,
            known_current=original,
            parent_ready=True,
        )
        return state, None
    except Exception as exc:
        return "failed", f"{path}: {type(exc).__name__}: {exc}"


def _structured_tasks(
    plan: Mapping[str, Any],
    library_root: Path,
    *,
    workers: int,
) -> list[tuple[Path, str, str, dict[str, str], dict[str, dict[str, Any]], dict[str, list[str]], Path]]:
    mappings = {str(k): str(v) for k, v in dict(plan["mappings"]).items()}
    raw_records = {str(k): dict(v) for k, v in dict(plan["raw_records"]).items()}
    aliases = {
        str(k): [str(item) for item in value]
        for k, value in dict(plan["canonical_legacy_identities"]).items()
    }
    scan_specs: list[tuple[Path, str, str, bool]] = []
    for stage in RESOURCE_STAGES:
        root = library_root / stage.new_relative_root
        if not root.is_dir():
            continue
        for directory in root.iterdir():
            if not directory.is_dir() or not CANONICAL_ID_RE.fullmatch(directory.name):
                continue
            # Even a directory that already had an idNNNNNN name can contain
            # absolute legacy root paths in each chapter payload.  Every
            # structured file must therefore participate in the one-time
            # source rewrite; checking only index.json leaves hidden runtime
            # dependencies on novels_raw/novels_cleaned.
            scan_specs.append((directory, stage.name, stage.kind, True))

    for root_relative, stage, kind in (
        ("BridgeIndex/books", "bridge_index", "book"),
        ("AbstractLibrary", "abstract_library", "book"),
    ):
        root = library_root / root_relative
        if not root.is_dir():
            continue
        scan_specs.append((root, stage, kind, True))

    def scan(
        spec: tuple[Path, str, str, bool]
    ) -> list[tuple[Path, str, str, dict[str, str], dict[str, dict[str, Any]], dict[str, list[str]], Path]]:
        directory, stage, kind, recursive = spec
        paths: Iterable[Path] = directory.rglob("*") if recursive else [directory]
        found = []
        for path in paths:
            if not path.is_file():
                continue
            if path.suffix.lower() not in STRUCTURED_SUFFIXES and path.name not in STRUCTURED_MARKERS:
                continue
            found.append((path, stage, kind, mappings, raw_records, aliases, library_root))
        return found

    tasks: list[
        tuple[Path, str, str, dict[str, str], dict[str, dict[str, Any]], dict[str, list[str]], Path]
    ] = []
    scan_started = time.monotonic()
    last_report = scan_started
    scan_workers = max(1, min(workers, 64, len(scan_specs) or 1))
    with ThreadPoolExecutor(max_workers=scan_workers) as executor:
        for completed, found in enumerate(executor.map(scan, scan_specs), start=1):
            tasks.extend(found)
            now = time.monotonic()
            if completed == len(scan_specs) or completed % 250 == 0 or now - last_report >= 30:
                _progress(
                    "structured_scan_progress",
                    directories_completed=completed,
                    directories_total=len(scan_specs),
                    files_found=len(tasks),
                    scan_workers=scan_workers,
                )
                last_report = now
    abstract_index = library_root / "indexes/abstract_index.jsonl"
    if abstract_index.is_file():
        tasks.append((
            abstract_index,
            "abstract_index",
            "book",
            mappings,
            raw_records,
            aliases,
            library_root,
        ))
    return tasks


def _apply_structured_rewrites(
    plan: Mapping[str, Any],
    library_root: Path,
    *,
    workers: int,
) -> dict[str, Any]:
    _progress("structured_scan_started", workers=workers)
    tasks = _structured_tasks(plan, library_root, workers=workers)
    _progress("structured_scan_complete", tasks=len(tasks), workers=workers)
    counts: Counter[str] = Counter()
    failures: list[str] = []
    started = time.monotonic()
    last_report = started
    completed = 0
    task_iterator = iter(tasks)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        pending = {
            executor.submit(_rewrite_structured_file, task)
            for task in (next(task_iterator, None) for _ in range(workers * 4))
            if task is not None
        }
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                state, error = future.result()
                completed += 1
                next_task = next(task_iterator, None)
                if next_task is not None:
                    pending.add(executor.submit(_rewrite_structured_file, next_task))
                counts[state] += 1
                if error is not None:
                    failures.append(error)
                now = time.monotonic()
                if completed == len(tasks) or completed % 10_000 == 0 or now - last_report >= 30:
                    elapsed = max(now - started, 1e-9)
                    rate = completed / elapsed
                    remaining = max(0, len(tasks) - completed)
                    _progress(
                        "structured_rewrite_progress",
                        completed=completed,
                        total=len(tasks),
                        written=counts["written"],
                        unchanged=counts["unchanged"],
                        failed=counts["failed"],
                        files_per_second=round(rate, 2),
                        eta_seconds=round(remaining / rate, 1) if rate else None,
                    )
                    last_report = now
    return {
        "tasks": len(tasks),
        "written": counts["written"],
        "unchanged": counts["unchanged"],
        "failed": counts["failed"],
        "failures": failures[:200],
    }


def _entry_identity(entry: Mapping[str, Any], key: str, kind: str) -> str:
    slug = str(
        entry.get("story_slug")
        or entry.get("book_slug")
        or (entry.get("raw") or {}).get("raw_book_slug")
        or entry.get("clean_slug")
        or ""
    )
    match = LEGACY_SLUG_RE.fullmatch(slug)
    if match is not None:
        return _identity(match.group("kind"), slug)
    numeric = str(entry.get("book_id") or entry.get("clean_id") or key).strip()
    if numeric.isdigit():
        return _identity(kind, f"{kind}_{int(numeric):04d}")
    if CANONICAL_ID_RE.fullmatch(slug) or CANONICAL_ID_RE.fullmatch(numeric):
        canonical = slug if CANONICAL_ID_RE.fullmatch(slug) else numeric
        return f"id:{canonical}"
    return ""


def _choose_registry_entry(
    rows: list[tuple[str, dict[str, Any]]],
    canonical: str,
    representatives: Mapping[str, str],
) -> tuple[str, dict[str, Any]]:
    requested = str(representatives.get(canonical) or "")
    for identity, entry in rows:
        if identity == requested:
            return identity, entry
    return sorted(rows, key=lambda item: item[0])[0]


def _merge_registry_urls(selected: dict[str, Any], rows: Iterable[tuple[str, Mapping[str, Any]]]) -> None:
    urls: list[str] = []
    for _, entry in rows:
        for value in [entry.get("source_url"), *(entry.get("alternate_urls") or [])]:
            text = str(value or "").strip()
            if text and text not in urls:
                urls.append(text)
    primary = str(selected.get("source_url") or "").strip()
    selected["alternate_urls"] = [value for value in urls if value != primary]


def _rewrite_fetch_registry(
    path: Path,
    *,
    kind: str,
    plan: Mapping[str, Any],
    library_root: Path,
    audit_root: Path,
) -> dict[str, Any]:
    if not path.is_file():
        return {"path": str(path), "state": "absent", "active": 0}
    payload = _load_json_object(path)
    mappings = {str(k): str(v) for k, v in dict(plan["mappings"]).items()}
    retired = {
        str(row["identity_key"]): dict(row) for row in plan["retired_identities"]
    }
    representatives = {str(k): str(v) for k, v in dict(plan["representatives"]).items()}
    raw_records = {str(k): dict(v) for k, v in dict(plan["raw_records"]).items()}
    grouped: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    retired_rows: list[dict[str, Any]] = [
        dict(row)
        for row in payload.get("retired_during_v2_migration", [])
        if isinstance(row, dict)
    ]
    for key, raw_entry in dict(payload.get("books", {})).items():
        if not isinstance(raw_entry, dict):
            retired_rows.append({"registry_key": key, "reason": "invalid_registry_entry"})
            continue
        entry = dict(raw_entry)
        identity = _entry_identity(entry, str(key), kind)
        if identity.startswith("id:"):
            grouped[identity.split(":", 1)[1]].append((identity, entry))
        elif identity in mappings:
            grouped[mappings[identity]].append((identity, entry))
        else:
            retired_rows.append(
                {
                    "registry_key": key,
                    "identity_key": identity,
                    "title": entry.get("title"),
                    "source_url": entry.get("source_url"),
                    "reason": (
                        retired.get(identity, {}).get("reason")
                        if identity in retired
                        else "registry_has_no_surviving_source_resource"
                    ),
                }
            )

    books: dict[str, dict[str, Any]] = {}
    for canonical, rows in sorted(grouped.items()):
        identity, entry = _choose_registry_entry(rows, canonical, representatives)
        rewritten, _ = rewrite_json_payload(entry, mappings, default_kind=kind)
        if not isinstance(rewritten, dict):
            raise ValueError(f"Registry entry did not remain an object: {path} {canonical}")
        _merge_registry_urls(rewritten, rows)
        rewritten["book_id"] = canonical
        rewritten["book_slug"] = canonical
        rewritten["content_id"] = canonical
        if kind == "story":
            rewritten["story_slug"] = canonical
            rawdata = f"TaciturnRaw/00_Stories/{canonical}"
        else:
            raw = raw_records.get(canonical)
            if raw is None:
                raise ValueError(f"Fetch registry target absent from raw: {canonical}")
            rawdata = _raw_relative_paths(raw)["dir"]
        rewritten.setdefault("paths", {})["rawdata"] = rawdata
        rewritten.pop("legacy_identities", None)
        rewritten["registry_migration"] = {
            "layout_version": LAYOUT_VERSION,
            "source_count": len(rows),
            "runtime_mapping_required": False,
        }
        books[canonical] = rewritten

    new_payload = {
        **{
            key: value
            for key, value in payload.items()
            if key != "retired_during_v2_migration"
        },
        "layout_version": "novel-agent-data-v2",
        "last_id": _reserved_global_id_high_watermark(plan),
        "id_format": "idNNNNNN",
        "books": books,
        "migration": {
            "layout_version": LAYOUT_VERSION,
            "migrated_at": _utc_now(),
            "runtime_mapping_required": False,
        },
    }
    state = _atomic_write(path, _json_bytes(new_payload), durable=True)
    if retired_rows:
        ledger = audit_root / f"retired_{kind}_registry_entries.jsonl"
        _atomic_write(
            ledger,
            b"".join(_json_bytes(row, pretty=False) for row in retired_rows),
            durable=True,
        )
    return {
        "path": str(path),
        "state": state,
        "active": len(books),
        "retired": len(retired_rows),
        "merged_alias_entries": sum(max(0, len(rows) - 1) for rows in grouped.values()),
    }


def _registry_last_cleaned(metadata: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "at": _utc_now(),
        "source_signature": str(
            (metadata.get("source_lineage") or {}).get("source_signature") or ""
        ),
        "chapter_count": int(metadata.get("chapter_count") or 0),
        "total_chars": int(metadata.get("total_chars") or 0),
        "total_paragraphs": int(metadata.get("total_paragraphs") or 0),
        "cleaning_stats": metadata.get("cleaning_stats") or {},
        "cleaning_summary": metadata.get("cleaning_summary") or {},
    }


def _rewrite_cleaned_registry(
    path: Path,
    *,
    plan: Mapping[str, Any],
    library_root: Path,
    audit_root: Path,
) -> dict[str, Any]:
    payload = _load_json_object(path) if path.is_file() else {}
    mappings = {str(k): str(v) for k, v in dict(plan["mappings"]).items()}
    representatives = {str(k): str(v) for k, v in dict(plan["representatives"]).items()}
    retired = {
        str(row["identity_key"]): dict(row) for row in plan["retired_identities"]
    }
    raw_records = {str(k): dict(v) for k, v in dict(plan["raw_records"]).items()}
    old_grouped: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    retired_rows: list[dict[str, Any]] = [
        dict(row)
        for row in payload.get("retired_during_v2_migration", [])
        if isinstance(row, dict)
    ]
    for key, raw_entry in dict(payload.get("books", {})).items():
        if not isinstance(raw_entry, dict):
            continue
        entry = dict(raw_entry)
        identity = _entry_identity(entry, str(key), "book")
        if identity.startswith("id:"):
            old_grouped[identity.split(":", 1)[1]].append((identity, entry))
        elif identity in mappings:
            old_grouped[mappings[identity]].append((identity, entry))
        else:
            retired_rows.append(
                {
                    "registry_key": key,
                    "identity_key": identity,
                    "title": entry.get("title"),
                    "reason": retired.get(identity, {}).get(
                        "reason", "cleaned_registry_has_no_surviving_resource"
                    ),
                }
            )

    cleaned_root = library_root / "TaciturnRaw/02_CleanedData"
    canonical_dirs = sorted(
        child
        for child in cleaned_root.iterdir()
        if child.is_dir() and CANONICAL_ID_RE.fullmatch(child.name)
    )
    books: dict[str, dict[str, Any]] = {}
    for directory in canonical_dirs:
        canonical = directory.name
        raw = raw_records.get(canonical)
        if raw is None:
            raise ValueError(f"Cleaned resource has no canonical raw record: {canonical}")
        index = _load_json_object(directory / "index.json")
        metadata = index.get("book_metadata")
        if not isinstance(metadata, dict) or metadata.get("book_id") != canonical:
            raise ValueError(f"Cleaned index identity mismatch: {directory}")
        rows = old_grouped.get(canonical, [])
        if rows:
            _, entry = _choose_registry_entry(rows, canonical, representatives)
            entry, _ = rewrite_json_payload(entry, mappings, default_kind="book")
            if not isinstance(entry, dict):
                raise ValueError(f"Invalid migrated cleaned registry entry: {canonical}")
        else:
            timestamp = datetime.fromtimestamp(directory.stat().st_mtime, tz=timezone.utc).isoformat()
            entry = {
                "status": "active",
                "content_type": "content",
                "title": raw.get("title") or "",
                "created_at": timestamp,
                "updated_at": timestamp,
                "history": [],
            }
        raw_ref = _raw_reference(raw)
        entry.update(
            {
                "clean_id": canonical,
                "clean_slug": canonical,
                "status": "active",
                "content_type": "content",
                "title": raw.get("title") or entry.get("title") or "",
                "raw": raw_ref,
                "paths": {
                    "rawdata": _raw_relative_paths(raw)["dir"],
                    "cleaned_chapters": f"TaciturnRaw/02_CleanedData/{canonical}",
                },
                "last_cleaned": entry.get("last_cleaned") or _registry_last_cleaned(metadata),
                "reuse_status": entry.get("reuse_status")
                or (
                    "hash_verified_legacy_reuse"
                    if any(not identity.startswith("id:") for identity, _ in rows)
                    else "preexisting_canonical_reuse"
                ),
            }
        )
        entry.pop("legacy_identities", None)
        books[canonical] = entry

    events: list[dict[str, Any]] = []
    for event in payload.get("events", []):
        if not isinstance(event, dict):
            continue
        identity = _entry_identity(event, str(event.get("clean_id") or ""), "book")
        if identity in retired:
            continue
        rewritten, _ = rewrite_json_payload(event, mappings, default_kind="book")
        if isinstance(rewritten, dict):
            events.append(rewritten)
    events.append(
        {
            "type": "canonical-layout-migration",
            "at": _utc_now(),
            "active_resources": len(books),
            "retired_resources": len(retired_rows),
            "layout_version": LAYOUT_VERSION,
        }
    )
    new_payload = {
        **{
            key: value
            for key, value in payload.items()
            if key != "retired_during_v2_migration"
        },
        "layout_version": "novel-agent-cleaned-registry-v2",
        "updated_at": _utc_now(),
        "last_id": _reserved_global_id_high_watermark(plan),
        "id_format": "idNNNNNN",
        "books": books,
        "deleted": {},
        "events": events[-2000:],
        "migration": {
            "layout_version": LAYOUT_VERSION,
            "runtime_mapping_required": False,
        },
    }
    state = _atomic_write(path, _json_bytes(new_payload), durable=True)
    if retired_rows:
        _atomic_write(
            audit_root / "retired_cleaned_registry_entries.jsonl",
            b"".join(_json_bytes(row, pretty=False) for row in retired_rows),
            durable=True,
        )
    return {
        "path": str(path),
        "state": state,
        "active": len(books),
        "retired": len(retired_rows),
        "synthesized_for_preexisting_canonical": sum(
            canonical not in old_grouped for canonical in books
        ),
    }


def _rewrite_registries(
    plan: Mapping[str, Any],
    library_root: Path,
    audit_root: Path,
) -> dict[str, Any]:
    indexes = library_root / "indexes"
    results = {
        "books": _rewrite_fetch_registry(
            indexes / "books.json",
            kind="book",
            plan=plan,
            library_root=library_root,
            audit_root=audit_root,
        ),
        "stories": _rewrite_fetch_registry(
            indexes / "stories.json",
            kind="story",
            plan=plan,
            library_root=library_root,
            audit_root=audit_root,
        ),
        "cleaned_books": _rewrite_cleaned_registry(
            indexes / "cleaned_books.json",
            plan=plan,
            library_root=library_root,
            audit_root=audit_root,
        ),
    }
    content_ids = {
        "layout_version": "literary-giant-content-id-high-watermark-v1",
        "id_format": "idNNNNNN",
        "last_id": _reserved_global_id_high_watermark(plan),
        "updated_at": _utc_now(),
        "source": "TaciturnRaw/01_RawData/index.jsonl",
    }
    results["content_ids"] = {
        "path": str(indexes / "content_ids.json"),
        "state": _atomic_write(indexes / "content_ids.json", _json_bytes(content_ids), durable=True),
    }
    return results


def _patch_raw_retirement_lineage(plan: Mapping[str, Any], library_root: Path) -> dict[str, Any]:
    raw_root = library_root / "TaciturnRaw/01_RawData"
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in plan["retired_identities"]:
        grouped[str(row["superseded_by"])].append(
            {
                "identity_key": row["identity_key"],
                "status": row["status"],
                "source_canonical_id": row["source_canonical_id"],
                "superseded_by": row["superseded_by"],
                "requires_rebuild": bool(row["requires_rebuild"]),
                "review_id": row.get("review_id"),
                "reason": row.get("reason"),
            }
        )
    index = raw_root / "index.jsonl"
    temporary = index.with_name(f".{index.name}.{uuid.uuid4().hex}.tmp")
    changed = 0
    seen: set[str] = set()
    try:
        with index.open("r", encoding="utf-8") as source, temporary.open("x", encoding="utf-8") as target:
            for raw in source:
                if not raw.strip():
                    continue
                row = json.loads(raw)
                canonical = str(row.get("canonical_id") or row.get("content_id") or "")
                if canonical in grouped:
                    value = sorted(grouped[canonical], key=lambda item: item["identity_key"])
                    if row.get("superseded_legacy_identities") != value:
                        row["superseded_legacy_identities"] = value
                        changed += 1
                    seen.add(canonical)
                target.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            target.flush()
            os.fsync(target.fileno())
        missing = sorted(set(grouped) - seen)
        if missing:
            raise ValueError(f"Raw retirement targets missing: {missing}")
        os.replace(temporary, index)
    finally:
        temporary.unlink(missing_ok=True)

    per_book = 0
    raw_records = dict(plan["raw_records"])
    for canonical, retired_rows in grouped.items():
        raw = raw_records.get(canonical)
        if not isinstance(raw, dict):
            raise ValueError(f"Plan lacks raw retirement target: {canonical}")
        index_path = raw_root / str(raw["target_index"])
        payload = _load_json_object(index_path)
        value = sorted(retired_rows, key=lambda item: item["identity_key"])
        if payload.get("superseded_legacy_identities") != value:
            payload["superseded_legacy_identities"] = value
            _atomic_write(index_path, _json_bytes(payload), durable=False)
            per_book += 1
    return {"global_index_rows_changed": changed, "book_indexes_changed": per_book}


def verify_layout(plan: Mapping[str, Any], library_root: str | Path) -> dict[str, Any]:
    library = Path(library_root).resolve()
    errors: list[str] = []
    counts: dict[str, int] = {}
    for old, new in ROOT_TRANSITIONS:
        old_path = library / old
        new_path = library / new
        if old_path.exists():
            errors.append(f"legacy root still exists: {old_path}")
        if not new_path.exists():
            errors.append(f"v2 root is missing: {new_path}")
    if (library / "TaciturnRaw/stories_cleaned").exists():
        errors.append("retired stories_cleaned still exists")

    raw_root = library / "TaciturnRaw/01_RawData"
    try:
        _, raw_count, high_water = _raw_records(raw_root, required_ids=set())
        counts["raw_books"] = raw_count
        if raw_count != int(plan["summary"]["raw_books"]):
            errors.append(
                f"raw cardinality changed: {raw_count} != {plan['summary']['raw_books']}"
            )
        expected_raw_high_water = int(
            plan["summary"].get(
                "raw_id_high_watermark",
                plan["summary"]["global_id_high_watermark"],
            )
        )
        if high_water != expected_raw_high_water:
            errors.append(f"raw high-water mark changed: {high_water}")
    except Exception as exc:
        errors.append(f"raw index verification failed: {exc}")

    stage_by_name = {stage.name: stage for stage in RESOURCE_STAGES}
    for stage_name in ("stories", "cleaned", "chapter_analysis", "novel_bridges", "llm_extracted"):
        stage = stage_by_name[stage_name]
        root = library / stage.new_relative_root
        if not root.is_dir():
            counts[stage_name] = 0
            continue
        canonical_dirs = [
            child for child in root.iterdir() if child.is_dir() and CANONICAL_ID_RE.fullmatch(child.name)
        ]
        counts[stage_name] = len(canonical_dirs)
        for child in root.iterdir():
            if not child.is_dir():
                continue
            if child.name.startswith("."):
                errors.append(f"staging directory remains active: {child}")
            elif not CANONICAL_ID_RE.fullmatch(child.name):
                errors.append(f"legacy/noncanonical resource directory remains: {child}")

    expected_legacy_targets: dict[str, set[str]] = defaultdict(set)
    for row in plan["directory_operations"]:
        if row["action"] == "rename_canonical":
            expected_legacy_targets[str(row["stage"])].add(str(row["target_name"]))
    for stage_name, targets in expected_legacy_targets.items():
        stage = stage_by_name[stage_name]
        root = library / stage.new_relative_root
        missing = sorted(target for target in targets if not (root / target).is_dir())
        if missing:
            errors.append(f"{stage_name} canonical migrations missing: {missing[:20]}")

    cleaned_root = library / "TaciturnRaw/02_CleanedData"
    raw_records = {str(k): dict(v) for k, v in dict(plan["raw_records"]).items()}
    cleaned_ids: set[str] = set()
    if cleaned_root.is_dir():
        for directory in sorted(cleaned_root.iterdir(), key=lambda item: item.name):
            if not directory.is_dir() or not CANONICAL_ID_RE.fullmatch(directory.name):
                continue
            cleaned_ids.add(directory.name)
            try:
                index = _load_json_object(directory / "index.json")
                metadata = index.get("book_metadata")
                if not isinstance(metadata, dict) or metadata.get("book_id") != directory.name:
                    errors.append(f"cleaned index ID mismatch: {directory}")
                    continue
                expected = raw_records.get(directory.name)
                if expected is None:
                    errors.append(f"cleaned resource absent from raw plan: {directory.name}")
                else:
                    actual_provenance = metadata.get("canonical_raw_provenance")
                    expected_provenance = _canonical_raw_provenance(expected)
                    if not isinstance(actual_provenance, dict) or any(
                        actual_provenance.get(key) != value
                        for key, value in expected_provenance.items()
                    ):
                        errors.append(f"cleaned raw provenance mismatch: {directory.name}")
            except Exception as exc:
                errors.append(f"cleaned index invalid {directory}: {exc}")

    cleaned_registry_path = library / "indexes/cleaned_books.json"
    try:
        registry = _load_json_object(cleaned_registry_path)
        registry_ids = set(dict(registry.get("books", {})))
        if registry_ids != cleaned_ids:
            errors.append(
                "cleaned registry/resource mismatch: "
                f"missing={sorted(cleaned_ids-registry_ids)[:10]}, "
                f"stale={sorted(registry_ids-cleaned_ids)[:10]}"
            )
        if any(not CANONICAL_ID_RE.fullmatch(value) for value in registry_ids):
            errors.append("cleaned registry still contains noncanonical keys")
    except Exception as exc:
        errors.append(f"cleaned registry verification failed: {exc}")

    reserved_high_water = _reserved_global_id_high_watermark(plan)
    counts["reserved_global_id_high_watermark"] = reserved_high_water
    for registry_name in ("books.json", "stories.json"):
        registry_path = library / "indexes" / registry_name
        try:
            registry = _load_json_object(registry_path)
            registry_ids = set(dict(registry.get("books", {})))
            if any(not CANONICAL_ID_RE.fullmatch(value) for value in registry_ids):
                errors.append(f"{registry_name} still contains noncanonical keys")
            if int(registry.get("last_id") or 0) != reserved_high_water:
                errors.append(
                    f"{registry_name} does not reserve global high-water ID "
                    f"{reserved_high_water}"
                )
        except Exception as exc:
            errors.append(f"{registry_name} verification failed: {exc}")
    try:
        content_ids = _load_json_object(library / "indexes/content_ids.json")
        if int(content_ids.get("last_id") or 0) != reserved_high_water:
            errors.append(
                f"content_ids.json does not reserve global high-water ID {reserved_high_water}"
            )
    except Exception as exc:
        errors.append(f"content_ids.json verification failed: {exc}")

    noise_root = library / "Noise"
    deletion_paths = {str(row["relative_path"]) for row in plan["noise_deletions"]}
    still_present = sorted(relative for relative in deletion_paths if (noise_root / relative).exists())
    if still_present:
        errors.append(f"retired Noise files remain: {still_present[:20]}")
    indexed_retired: list[str] = []
    try:
        for row in _iter_jsonl(noise_root / "index.jsonl"):
            relative = str(row.get("file") or "")
            if relative in deletion_paths:
                indexed_retired.append(relative)
                if len(indexed_retired) >= 20:
                    break
    except Exception as exc:
        errors.append(f"Noise index verification failed: {exc}")
    if indexed_retired:
        errors.append(f"Noise index still references retired files: {indexed_retired[:20]}")

    retired_slugs = {_slug_from_identity(str(row["identity_key"])) for row in plan["retired_identities"]}
    for stage in RESOURCE_STAGES:
        root = library / stage.new_relative_root
        for slug in retired_slugs:
            if (root / slug).exists():
                errors.append(f"retired derived resource remains: {root / slug}")

    runtime_reference_audit = _audit_generated_runtime_references(library)
    counts["legacy_runtime_reference_files"] = runtime_reference_audit[
        "matched_files"
    ]
    if runtime_reference_audit["read_error_count"]:
        errors.append(
            "generated runtime reference audit had read errors: "
            f"{runtime_reference_audit['read_errors'][:5]}"
        )
    if runtime_reference_audit["matched_files"]:
        errors.append(
            "generated runtime metadata still contains legacy identity tokens: "
            f"files={runtime_reference_audit['matched_files']}, "
            f"occurrences={runtime_reference_audit['matched_occurrences']}, "
            f"examples={runtime_reference_audit['examples'][:5]}"
        )

    return {
        "layout_version": LAYOUT_VERSION,
        "verified_at": _utc_now(),
        "status": "complete" if not errors else "failed",
        "counts": counts,
        "errors": errors[:500],
        "error_count": len(errors),
        "runtime_reference_audit": runtime_reference_audit,
    }


def _stamp_cleaned_gate(
    library_root: Path,
    gate_sha256: str,
    *,
    workers: int,
) -> dict[str, Any]:
    cleaned = library_root / "TaciturnRaw/02_CleanedData"
    indexes = [
        child / "index.json"
        for child in cleaned.iterdir()
        if child.is_dir() and CANONICAL_ID_RE.fullmatch(child.name)
    ]

    def stamp(path: Path) -> tuple[str, str | None]:
        try:
            payload = _load_json_object(path)
            metadata = payload.get("book_metadata")
            if not isinstance(metadata, dict):
                raise ValueError("book_metadata is missing")
            provenance = metadata.get("canonical_raw_provenance")
            if not isinstance(provenance, dict):
                raise ValueError("canonical_raw_provenance is missing")
            if provenance.get("mapping_manifest_sha256") == gate_sha256:
                return "unchanged", None
            provenance["mapping_manifest_sha256"] = gate_sha256
            _atomic_write(path, _json_bytes(payload, pretty=False))
            return "written", None
        except Exception as exc:
            return "failed", f"{path}: {exc}"

    counts: Counter[str] = Counter()
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for state, error in executor.map(stamp, indexes, chunksize=16):
            counts[state] += 1
            if error:
                failures.append(error)
    return {
        "indexes": len(indexes),
        "written": counts["written"],
        "unchanged": counts["unchanged"],
        "failed": counts["failed"],
        "failures": failures[:100],
    }


def _publish_hardmodel_gate(
    plan: Mapping[str, Any],
    library_root: Path,
    verification: Mapping[str, Any],
    *,
    workers: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    gate_path = library_root / "indexes/taciturn_hardmodel_gate.json"
    gate = {
        "layout_version": HARDMODEL_GATE_VERSION,
        "status": "ready_for_hardmodel",
        "raw_root": str((library_root / "TaciturnRaw/01_RawData").resolve()),
        "cleaned_root": str((library_root / "TaciturnRaw/02_CleanedData").resolve()),
        "chapter_root": str((library_root / "TaciturnRaw/03_ChapterAnalysis").resolve()),
        "id_format": "idNNNNNN",
        "chapter_id_format": "idNNNNNNCNNNNNN",
        "raw_books": int(plan["summary"]["raw_books"]),
        "reusable_cleaned_resources": int(verification["counts"].get("cleaned", 0)),
        "canonical_lineage_sha256": plan["inputs"]["canonical_lineage_sha256"],
        "resource_verification_status": verification["status"],
        "runtime_mapping_required": False,
        "completed_at": _utc_now(),
    }
    gate_bytes = _json_bytes(gate)
    gate_sha256 = hashlib.sha256(gate_bytes).hexdigest()
    stamp = _stamp_cleaned_gate(library_root, gate_sha256, workers=workers)
    if stamp["failed"]:
        raise RuntimeError(f"Failed to stamp cleaned provenance gate: {stamp['failures'][:3]}")
    _atomic_write(gate_path, gate_bytes, durable=True)
    return {"path": str(gate_path), "sha256": gate_sha256, **gate}, stamp


def apply_plan(
    plan: Mapping[str, Any],
    *,
    workers: int,
    audit_root: str | Path,
) -> dict[str, Any]:
    if plan.get("blockers"):
        raise ValueError(f"Migration plan has {len(plan['blockers'])} blocker(s)")
    if workers < 1:
        raise ValueError("workers must be positive")
    _validate_frozen_inputs(plan)
    library_root = Path(str(plan["library_root"])).resolve()
    audit = Path(audit_root).resolve()
    audit.mkdir(parents=True, exist_ok=True)
    lock_path = library_root / "TaciturnRaw/.layout-migration.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _progress("migration_started", workers=workers, audit_root=str(audit))
        results: dict[str, Any] = {
            "layout_version": LAYOUT_VERSION,
            "started_at": _utc_now(),
            "workers": workers,
            "hardmodel_started": False,
        }
        results["noise_cleanup"] = _apply_noise_deletions(
            library_root, plan["noise_deletions"], audit
        )
        _progress("noise_cleanup_complete", **results["noise_cleanup"])
        results["root_transitions"] = _apply_root_transitions(
            library_root, plan["root_transitions"]
        )
        _progress("root_transitions_complete", transitions=results["root_transitions"])
        results["resource_operations"] = _apply_resource_operations(
            library_root,
            plan["directory_operations"],
            plan["file_operations"],
        )
        _progress("resource_operations_complete", **results["resource_operations"])
        results["raw_retirement_lineage"] = _patch_raw_retirement_lineage(
            plan, library_root
        )
        _progress("raw_retirement_lineage_complete", **results["raw_retirement_lineage"])
        results["structured_rewrites"] = _apply_structured_rewrites(
            plan, library_root, workers=workers
        )
        if results["structured_rewrites"]["failed"]:
            results["status"] = "failed_structured_rewrites"
            results["finished_at"] = _utc_now()
            _atomic_write(audit / "apply_result.json", _json_bytes(results), durable=True)
            _progress("migration_failed", status=results["status"])
            return results
        results["registries"] = _rewrite_registries(plan, library_root, audit)
        _progress("registries_rewritten", registries=list(results["registries"]))
        verification = verify_layout(plan, library_root)
        results["verification"] = verification
        _atomic_write(audit / "verification.json", _json_bytes(verification), durable=True)
        _progress(
            "verification_complete",
            status=verification["status"],
            error_count=verification["error_count"],
            counts=verification["counts"],
        )
        if verification["status"] == "complete":
            gate, stamp = _publish_hardmodel_gate(
                plan, library_root, verification, workers=workers
            )
            results["hardmodel_gate"] = gate
            results["cleaned_gate_stamp"] = stamp
            results["status"] = "complete"
            _progress(
                "hardmodel_gate_published_without_starting_model",
                path=gate["path"],
                reusable_cleaned_resources=gate["reusable_cleaned_resources"],
            )
        else:
            results["status"] = "failed_verification"
        results["finished_at"] = _utc_now()
        _atomic_write(audit / "apply_result.json", _json_bytes(results), durable=True)
        _progress("migration_finished", status=results["status"], hardmodel_started=False)
        return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-root", default="Library")
    parser.add_argument(
        "--canonical-lineage",
        default="runs/novels-raw-mapping-repair-plan-20260722/canonical_id_lineage.json",
    )
    parser.add_argument(
        "--representatives",
        default="runs/post-merge-id-map-20260720.json",
    )
    parser.add_argument(
        "--decision-manifest",
        default="runs/version-review-final-20260720/decision_manifest.jsonl",
    )
    parser.add_argument(
        "--plan-dir",
        default="runs/taciturn-layout-v2-plan-20260722",
    )
    parser.add_argument(
        "--input-plan",
        help="Reuse an already-reviewed plan.json instead of rebuilding it.",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--workers",
        type=int,
        default=max(4, available_cpu_count() * 4),
        help="Parallel small-file metadata workers; default is 4x CPU quota.",
    )
    parser.add_argument(
        "--audit-root",
        default="Library/indexes/migrations/taciturn-layout-v2-20260722",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify an applied --input-plan without mutating any resource.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.workers < 1:
        parser.error("--workers must be positive")
    if args.verify_only and not args.input_plan:
        parser.error("--verify-only requires --input-plan")
    if args.input_plan:
        plan = load_plan(args.input_plan)
    else:
        plan = build_plan(
            args.library_root,
            args.canonical_lineage,
            args.representatives,
            args.decision_manifest,
        )
        write_plan(plan, args.plan_dir)
    if args.verify_only:
        result = verify_layout(plan, plan["library_root"])
    elif args.apply:
        result = apply_plan(plan, workers=args.workers, audit_root=args.audit_root)
    else:
        result = {
            "dry_run": True,
            "plan_dir": str(Path(args.plan_dir).resolve()),
            "summary": plan["summary"],
            "blockers": plan["blockers"][:100],
        }
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if plan.get("blockers"):
        return 2
    if isinstance(result, dict) and result.get("status") not in {None, "complete"}:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
