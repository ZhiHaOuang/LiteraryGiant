"""Plan and stage the verified Noise corpus as the canonical novels_raw tree.

The live Library is never modified by default.  ``plan`` writes auditable
manifests and human-readable catalogues.  ``stage`` materializes into an
independent root, using hardlinks by default so a 780+ GiB corpus does not need
temporary duplicate capacity.  A later reviewed cut-over can replace the live
``TaciturnRaw/01_RawData`` directory atomically.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid
from typing import Any, Iterable

from fetcher.local_archive import _verify_utf8_no_bom
from fetcher.local_resources import available_cpu_count


LAYOUT_VERSION = "taciturn-novels-raw-v2"
PLAN_VERSION = "novels-raw-migration-plan-v1"
ID_LINEAGE_LAYOUT_VERSION = "taciturn-canonical-id-lineage-v1"
CATEGORY_SLUGS = {
    "00": "xuanhuan",
    "01": "qihuan",
    "02": "wuxia",
    "03": "xianxia",
    "04": "dushi",
    "05": "xianshi",
    "06": "yanqing",
    "07": "hougong",
    "08": "danmei",
    "09": "baihe",
    "10": "lishi",
    "11": "junshi",
    "12": "kehuan",
    "13": "xuanyi",
    "14": "jingsong",
    "15": "youxi",
    "16": "tiyu",
    "17": "tongren",
    "18": "erciyuan",
    "19": "qingxiaoshuo",
    "20": "qita",
    "21": "explicit_h",
}
ID_RE = re.compile(r"^id(?P<number>\d{6})$")
SAFE_COMPONENT_RE = re.compile(r"[^0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff]+")


def _json_bytes(payload: Any) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def _jsonl_bytes(rows: Iterable[dict[str, Any]]) -> bytes:
    return "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    ).encode("utf-8")


def _atomic_write(path: Path, payload: bytes, *, durable: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            if durable:
                os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _component(value: object, fallback: str) -> str:
    cleaned = SAFE_COMPONENT_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:120] or fallback


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError(f"JSONL row is not an object at {path}:{line_no}")
            rows.append(payload)
    return rows


def _load_collision_repairs(path: str | Path | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    repairs: dict[str, dict[str, Any]] = {}
    for row in _load_jsonl(Path(path).resolve()):
        edition_id = str(row.get("edition_id") or "")
        canonical = str(row.get("new_canonical_id") or "")
        if not edition_id or not ID_RE.fullmatch(canonical):
            raise ValueError(f"Invalid ID repair row: {row}")
        if edition_id in repairs:
            raise ValueError(f"Duplicate repaired edition_id: {edition_id}")
        repairs[edition_id] = row
    return repairs


def _load_legacy_aliases(path: str | Path | None) -> dict[str, list[str]]:
    if path is None:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    mappings = payload.get("mappings") if isinstance(payload, dict) else None
    if not isinstance(mappings, dict):
        raise ValueError("ID map has no mappings object")
    aliases: dict[str, list[str]] = {}
    for identity, canonical in mappings.items():
        aliases.setdefault(str(canonical), []).append(str(identity))
    return {key: sorted(values) for key, values in aliases.items()}


def _load_incomplete_evidence(
    path: str | Path | None,
) -> dict[int, dict[str, Any]]:
    if path is None:
        return {}
    evidence_by_shorter: dict[int, dict[str, Any]] = {}
    for row in _load_jsonl(Path(path).resolve()):
        if row.get("relation") != "possible_incomplete":
            continue
        evidence_value = row.get("evidence_json")
        evidence = (
            json.loads(evidence_value)
            if isinstance(evidence_value, str)
            else evidence_value
        )
        if not isinstance(evidence, dict) or evidence.get("incomplete_candidate") is not True:
            continue
        shorter = int(evidence.get("shorter_file_id") or 0)
        if shorter:
            evidence_by_shorter[shorter] = evidence
    return evidence_by_shorter


def _load_publication_exclusions(path: str | Path) -> dict[str, dict[str, Any]]:
    """Return audited incomplete-edition exclusions keyed by candidate ID.

    The final raw publication may intentionally omit an edition which was the
    exact source for an older processed ``book_*`` identity.  That identity is
    *not* content-equivalent to the retained edition, so it must become a
    traceable ``retired_incomplete`` lineage record rather than a normal alias.
    """

    exclusions: dict[str, dict[str, Any]] = {}
    for line_no, row in enumerate(_load_jsonl(Path(path).resolve()), start=1):
        if row.get("publication_action") != "exclude_incomplete_candidate_from_final_raw":
            continue
        candidate_id = str(row.get("candidate_id") or "")
        preferred_id = str(row.get("preferred_id") or "")
        if not ID_RE.fullmatch(candidate_id) or not ID_RE.fullmatch(preferred_id):
            raise ValueError(
                "Publication exclusion must contain canonical candidate/preferred IDs "
                f"at line {line_no}: {row!r}"
            )
        if candidate_id == preferred_id:
            raise ValueError(
                f"Publication exclusion cannot supersede itself at line {line_no}: "
                f"{candidate_id}"
            )
        normalized = {
            "candidate_id": candidate_id,
            "preferred_id": preferred_id,
            "review_id": str(row.get("review_id") or ""),
            "work_id": str(row.get("work_id") or ""),
            "guarded_action": str(row.get("guarded_action") or ""),
            "guard_reason": str(row.get("guard_reason") or ""),
        }
        previous = exclusions.get(candidate_id)
        if previous is not None and previous != normalized:
            raise ValueError(
                f"Conflicting publication exclusions for {candidate_id}: "
                f"{previous!r} != {normalized!r}"
            )
        exclusions[candidate_id] = normalized
    return exclusions


def _version_decisions(
    rows: list[dict[str, Any]],
    incomplete_evidence: dict[int, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["work_id"]), []).append(row)
    decisions: dict[str, dict[str, Any]] = {}
    for work_id, members in grouped.items():
        longest = max(int(row.get("characters") or 0) for row in members)
        curated = [
            row
            for row in members
            if str(row.get("source_kind") or "") == "existing_processed"
            and int(row.get("characters") or 0) >= int(longest * 0.97)
        ]
        preferred = max(
            curated or members,
            key=lambda row: (
                int(row.get("characters") or 0),
                int(row.get("source_priority") or 0),
                str(row.get("edition_id") or ""),
            ),
        )
        ordered = sorted(
            members,
            key=lambda row: (
                row is not preferred,
                -int(row.get("characters") or 0),
                -int(row.get("source_priority") or 0),
                str(row.get("edition_id") or ""),
            ),
        )
        for version, row in enumerate(ordered, start=1):
            characters = int(row.get("characters") or 0)
            ratio = characters / longest if longest else 0.0
            direct_incomplete = incomplete_evidence.get(int(row.get("file_id") or 0))
            if row is preferred:
                disposition = "preferred"
                confidence = "high" if len(members) > 1 else "single_version"
                reason = (
                    "curated_existing_within_97_percent_of_longest"
                    if row in curated
                    else "largest_verified_version"
                )
            elif direct_incomplete is not None:
                disposition = "review_probable_incomplete"
                confidence = "high"
                reason = "direct_ordered_containment_evidence"
            elif ratio < 0.80:
                disposition = "review_possible_incomplete"
                confidence = "medium"
                reason = "same_work_but_under_80_percent_of_longest"
            elif ratio < 0.97:
                disposition = "keep_alternate_variant"
                confidence = "medium"
                reason = "same_work_distinct_length_variant"
            else:
                disposition = "keep_alternate_complete"
                confidence = "high"
                reason = "same_work_near_full_length_variant"
            decisions[str(row["edition_id"])] = {
                "work_id": work_id,
                "edition_id": str(row["edition_id"]),
                "source_edition_version": int(row.get("edition_version") or 0),
                "display_version": version,
                "version_label": "" if version == 1 else f"v{version}",
                "characters": characters,
                "longest_characters": longest,
                "length_ratio": round(ratio, 6),
                "disposition": disposition,
                "confidence": confidence,
                "reason": reason,
                "incomplete_evidence": direct_incomplete,
                # No version is deleted merely for being shorter.  A later
                # content-containment review must explicitly approve deletion.
                "automatic_delete": False,
            }
    return decisions


def build_plan(
    organizer_index: str | Path,
    noise_root: str | Path,
    *,
    collision_repairs: str | Path | None = None,
    id_map: str | Path | None = None,
    organizer_review: str | Path | None = None,
) -> dict[str, Any]:
    index_path = Path(organizer_index).resolve()
    noise = Path(noise_root).resolve()
    repairs = _load_collision_repairs(collision_repairs)
    legacy_aliases = _load_legacy_aliases(id_map)
    source_rows = _load_jsonl(index_path)
    rows = [row for row in source_rows if row.get("import_status") == "complete"]
    incomplete_evidence = _load_incomplete_evidence(organizer_review)
    decisions = _version_decisions(rows, incomplete_evidence)
    entries: list[dict[str, Any]] = []
    seen_ids: dict[str, str] = {}
    seen_editions: set[str] = set()
    for line_no, row in enumerate(rows, start=1):
        edition_id = str(row.get("edition_id") or "")
        if not edition_id or edition_id in seen_editions:
            raise ValueError(f"Missing or duplicate edition_id at completed row {line_no}")
        seen_editions.add(edition_id)
        old_id = f"id{int(row['library_id']):06d}"
        repair = repairs.get(edition_id)
        canonical = str(repair.get("new_canonical_id")) if repair else old_id
        if not ID_RE.fullmatch(canonical):
            raise ValueError(f"Invalid canonical id at row {line_no}: {canonical}")
        previous_edition = seen_ids.get(canonical)
        if previous_edition is not None:
            raise ValueError(
                f"Canonical ID {canonical} is still shared by editions "
                f"{previous_edition} and {edition_id}"
            )
        seen_ids[canonical] = edition_id
        category_code = str(row.get("category_code") or "")
        if category_code not in CATEGORY_SLUGS:
            raise ValueError(f"Unknown category code at row {line_no}: {category_code}")
        source_relative = str(row.get("file") or "")
        relative_path = Path(source_relative)
        if (
            not source_relative
            or relative_path.is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.parts)
        ):
            raise ValueError(f"Noise source escapes root at row {line_no}")
        # The organizer's completed full verification already resolved and
        # hashed every destination. Avoid 276k redundant remote lstat calls
        # while building a read-only migration plan; staging re-verifies each
        # selected source before linking it.
        source = noise / relative_path
        decision = decisions[edition_id]
        title = str(row.get("title") or "未命名")
        author = str(row.get("author") or "佚名")
        suffix = "" if decision["display_version"] == 1 else f"_v{decision['display_version']}"
        display_filename = (
            f"{category_code}_{canonical}_{_component(title, '未命名')}_"
            f"{_component(author, '佚名')}{suffix}.txt"
        )
        category_dir = f"{category_code}_{CATEGORY_SLUGS[category_code]}"
        target_dir = f"{category_dir}/{canonical}"
        entries.append(
            {
                "layout_version": LAYOUT_VERSION,
                "canonical_id": canonical,
                "original_canonical_id": old_id,
                "id_repaired": canonical != old_id,
                "content_id": canonical,
                "library_id": int(canonical[2:]),
                "original_library_id": int(row["library_id"]),
                "work_id": str(row.get("work_id") or ""),
                "edition_id": edition_id,
                "edition_version": int(decision["display_version"]),
                "source_edition_version": int(row.get("edition_version") or 0),
                "version_label": decision["version_label"],
                "version_decision": decision,
                "title": title,
                "author": author,
                "genre": str(row.get("genre") or "其他"),
                "category_code": category_code,
                "category_dir": category_dir,
                "tags": list(row.get("tags") or []),
                "characters": int(row.get("characters") or 0),
                "normalized_sha256": str(row.get("normalized_sha256") or ""),
                "source_file": str(source),
                "source_relative_file": source_relative,
                "target_dir": target_dir,
                "target_source": f"{target_dir}/source.txt",
                "target_index": f"{target_dir}/index.json",
                "display_filename": display_filename,
                "legacy_identities": legacy_aliases.get(canonical, []),
                "sort_initial": str(row.get("sort_initial") or "#"),
                "title_sort_key": str(row.get("title_sort_key") or title),
                "author_sort_key": str(row.get("author_sort_key") or author),
            }
        )
    entries.sort(
        key=lambda row: (
            row["category_code"],
            row["author_sort_key"],
            row["title_sort_key"],
            row["edition_version"],
            row["canonical_id"],
        )
    )
    by_disposition: dict[str, int] = {}
    for decision in decisions.values():
        key = str(decision["disposition"])
        by_disposition[key] = by_disposition.get(key, 0) + 1
    work_counts = Counter(str(row["work_id"]) for row in entries)
    return {
        "layout_version": PLAN_VERSION,
        "organizer_index": str(index_path),
        "noise_root": str(noise),
        "entries": entries,
        "version_decisions": sorted(
            decisions.values(), key=lambda row: (row["work_id"], row["display_version"])
        ),
        "id_repairs": sorted(repairs.values(), key=lambda row: row["new_canonical_id"]),
        "summary": {
            "books": len(entries),
            "unique_ids": len(seen_ids),
            "works": len({row["work_id"] for row in entries}),
            "multi_version_works": sum(count > 1 for count in work_counts.values()),
            "id_repairs": sum(bool(row["id_repaired"]) for row in entries),
            "categories": len({row["category_code"] for row in entries}),
            "version_dispositions": dict(sorted(by_disposition.items())),
            "automatic_version_deletions": 0,
            "direct_incomplete_evidence": sum(
                decision["incomplete_evidence"] is not None
                for decision in decisions.values()
            ),
            "source_file_validation": "deferred_to_staging_and_hash_verified",
            "live_library_modified": False,
        },
    }


def _catalog_text(entries: list[dict[str, Any]], *, heading: str) -> str:
    lines = [heading]
    current_category = current_author = None
    for row in entries:
        category = f"{row['genre']} [{row['category_dir']}]"
        author = str(row["author"])
        if category != current_category:
            lines.append(f"├── {category}")
            current_category = category
            current_author = None
        if author != current_author:
            lines.append(f"│   ├── {author}")
            current_author = author
        lines.append(f"│   │   ├── {row['display_filename']}")
    return "\n".join(lines) + "\n"


def write_plan(plan: dict[str, Any], plan_dir: str | Path) -> None:
    output = Path(plan_dir).resolve()
    lineage_rows = identity_lineage_rows(plan)
    _atomic_write(output / "summary.json", _json_bytes(plan["summary"]))
    _atomic_write(output / "files.jsonl", _jsonl_bytes(plan["entries"]))
    _atomic_write(
        output / "version_decisions.jsonl", _jsonl_bytes(plan["version_decisions"])
    )
    _atomic_write(output / "id_repairs.jsonl", _jsonl_bytes(plan["id_repairs"]))
    _atomic_write(output / "identity_lineage.jsonl", _jsonl_bytes(lineage_rows))
    _atomic_write(
        output / "canonical_id_lineage.json",
        _json_bytes(canonical_id_lineage_payload(plan)),
    )
    _atomic_write(
        output / "总目录.txt",
        _catalog_text(plan["entries"], heading="小说总目录").encode("utf-8"),
    )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entry in plan["entries"]:
        grouped.setdefault(str(entry["category_dir"]), []).append(entry)
    for category_dir, entries in grouped.items():
        _atomic_write(
            output / "分类目录" / f"{category_dir}.txt",
            _catalog_text(entries, heading=f"{entries[0]['genre']}目录").encode("utf-8"),
        )


def write_version_review_plan(
    plan: dict[str, Any],
    output_dir: str | Path,
    *,
    batch_size: int = 16,
) -> dict[str, Any]:
    """Write a resumable queue for ambiguous/probably incomplete versions."""

    if batch_size < 1:
        raise ValueError("Review batch size must be >= 1")
    output = Path(output_dir).resolve()
    entries_by_edition = {
        str(entry["edition_id"]): entry for entry in plan["entries"]
    }
    preferred_by_work = {
        str(entry["work_id"]): entry
        for entry in plan["entries"]
        if entry["version_decision"]["disposition"] == "preferred"
    }
    candidates: list[dict[str, Any]] = []
    for decision in plan["version_decisions"]:
        disposition = str(decision["disposition"])
        if disposition not in {
            "review_possible_incomplete",
            "review_probable_incomplete",
        }:
            continue
        candidate = entries_by_edition[str(decision["edition_id"])]
        preferred = preferred_by_work[str(decision["work_id"])]
        candidates.append(
            {
                "review_id": f"vr_{len(candidates) + 1:06d}",
                "batch_id": f"batch_{len(candidates) // batch_size + 1:04d}",
                "status": "pending",
                "work_id": decision["work_id"],
                "disposition": disposition,
                "confidence": decision["confidence"],
                "reason": decision["reason"],
                "length_ratio": decision["length_ratio"],
                "incomplete_evidence": decision["incomplete_evidence"],
                "candidate": {
                    key: candidate[key]
                    for key in (
                        "canonical_id",
                        "edition_id",
                        "title",
                        "author",
                        "characters",
                        "source_file",
                        "target_source",
                        "normalized_sha256",
                    )
                },
                "preferred": {
                    key: preferred[key]
                    for key in (
                        "canonical_id",
                        "edition_id",
                        "title",
                        "author",
                        "characters",
                        "source_file",
                        "target_source",
                        "normalized_sha256",
                    )
                },
                "review_policy": (
                    "compare_structure_endings_and_ordered_content_samples; "
                    "never_delete_on_title_or_length_alone"
                ),
            }
        )
    summary = {
        "candidates": len(candidates),
        "probable_incomplete": sum(
            item["disposition"] == "review_probable_incomplete"
            for item in candidates
        ),
        "possible_incomplete": sum(
            item["disposition"] == "review_possible_incomplete"
            for item in candidates
        ),
        "batch_size": batch_size,
        "batches": (len(candidates) + batch_size - 1) // batch_size,
        "automatic_deletions": 0,
        "status": "prepared",
    }
    _atomic_write(output / "candidates.jsonl", _jsonl_bytes(candidates))
    _atomic_write(output / "summary.json", _json_bytes(summary))
    return summary


def apply_publication_decisions(
    plan: dict[str, Any],
    decision_manifest: str | Path,
) -> dict[str, Any]:
    """Exclude audited incomplete alternates and compact display version labels.

    Normal ``legacy_identities`` mean that a historical processed payload is
    content-equivalent to the final raw edition.  An excluded incomplete
    edition is different: its old payload must be rebuilt from the retained
    complete edition.  We therefore keep those identities as explicit
    ``superseded_legacy_identities`` on the retained raw record instead of
    silently moving them into normal aliases.
    """

    exclusions = _load_publication_exclusions(decision_manifest)
    exclude_ids = set(exclusions)
    entries_by_id = {str(row["canonical_id"]): row for row in plan["entries"]}
    missing = sorted(exclude_ids - set(entries_by_id))
    if missing:
        raise ValueError(f"Publication exclusions not present in plan: {missing[:10]}")
    for canonical_id, exclusion in exclusions.items():
        candidate = entries_by_id[canonical_id]
        preferred_id = exclusion["preferred_id"]
        preferred = entries_by_id.get(preferred_id)
        if preferred is None:
            raise ValueError(
                f"Publication exclusion preferred edition is not present in plan: "
                f"{canonical_id} -> {preferred_id}"
            )
        if preferred_id in exclude_ids:
            raise ValueError(
                f"Publication exclusion must point at a retained preferred edition: "
                f"{canonical_id} -> {preferred_id}"
            )
        if candidate["version_decision"]["disposition"] == "preferred":
            raise ValueError(f"Refusing to exclude preferred edition: {canonical_id}")
        if str(candidate.get("work_id") or "") != str(preferred.get("work_id") or ""):
            raise ValueError(
                f"Publication exclusion crosses works: {canonical_id} "
                f"({candidate.get('work_id')}) -> {preferred_id} "
                f"({preferred.get('work_id')})"
            )
        manifest_work_id = exclusion.get("work_id")
        if manifest_work_id and manifest_work_id != str(candidate.get("work_id") or ""):
            raise ValueError(
                f"Publication exclusion work mismatch for {canonical_id}: "
                f"manifest={manifest_work_id}, plan={candidate.get('work_id')}"
            )

    retained = [dict(row) for row in plan["entries"] if row["canonical_id"] not in exclude_ids]
    retained_by_id = {str(row["canonical_id"]): row for row in retained}
    active_legacy_identities = {
        str(identity)
        for row in retained
        for identity in row.get("legacy_identities", [])
    }
    supersessions: list[dict[str, Any]] = []
    for candidate_id in sorted(exclusions):
        exclusion = exclusions[candidate_id]
        candidate = entries_by_id[candidate_id]
        preferred_id = str(exclusion["preferred_id"])
        preferred = retained_by_id[preferred_id]
        retired_aliases: list[dict[str, Any]] = []
        for identity in sorted({str(value) for value in candidate.get("legacy_identities", [])}):
            if identity in active_legacy_identities:
                raise ValueError(
                    f"Legacy identity is both active and retired: {identity}"
                )
            retired_aliases.append(
                {
                    "identity_key": identity,
                    "status": "retired_incomplete",
                    "source_canonical_id": candidate_id,
                    "superseded_by": preferred_id,
                    "requires_rebuild": True,
                    "review_id": exclusion["review_id"],
                    "reason": "excluded_incomplete_edition",
                }
            )
        if retired_aliases:
            preferred.setdefault("superseded_legacy_identities", []).extend(retired_aliases)
        supersessions.append(
            {
                "candidate_id": candidate_id,
                "preferred_id": preferred_id,
                "work_id": str(candidate.get("work_id") or ""),
                "review_id": exclusion["review_id"],
                "guarded_action": exclusion["guarded_action"],
                "guard_reason": exclusion["guard_reason"],
                "retired_identity_count": len(retired_aliases),
                "retired_identities": [item["identity_key"] for item in retired_aliases],
            }
        )
    by_work: dict[str, list[dict[str, Any]]] = {}
    for entry in retained:
        by_work.setdefault(str(entry["work_id"]), []).append(entry)
    for work_entries in by_work.values():
        work_entries.sort(
            key=lambda row: (
                row["version_decision"]["disposition"] != "preferred",
                int(row["edition_version"]),
                str(row["canonical_id"]),
            )
        )
        for display_version, entry in enumerate(work_entries, start=1):
            entry["edition_version"] = display_version
            entry["version_label"] = "" if display_version == 1 else f"v{display_version}"
            suffix = "" if display_version == 1 else f"_v{display_version}"
            entry["display_filename"] = (
                f"{entry['category_code']}_{entry['canonical_id']}_"
                f"{_component(entry['title'], '未命名')}_"
                f"{_component(entry['author'], '佚名')}{suffix}.txt"
            )
    retained.sort(
        key=lambda row: (
            row["category_code"],
            row["author_sort_key"],
            row["title_sort_key"],
            row["edition_version"],
            row["canonical_id"],
        )
    )
    summary = dict(plan["summary"])
    summary.update(
        {
            "source_books": len(plan["entries"]),
            "books": len(retained),
            "unique_ids": len(retained),
            "publication_exclusions": len(exclude_ids),
            "publication_decision_manifest": str(Path(decision_manifest).resolve()),
            "publication_supersessions": len(supersessions),
            "retired_incomplete_legacy_identities": sum(
                int(item["retired_identity_count"]) for item in supersessions
            ),
            "automatic_version_deletions": 0,
        }
    )
    return {
        **plan,
        "entries": retained,
        "summary": summary,
        "publication_exclusions": [entries_by_id[value] for value in sorted(exclude_ids)],
        "publication_supersessions": supersessions,
    }


def identity_lineage_rows(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Produce a complete, non-ambiguous legacy-identity resolution ledger.

    Active aliases are safe to migrate mechanically because their imported
    processed payload was verified as the same final edition.  Retired aliases
    deliberately remain separate so a consumer cannot relabel a short edition
    as a complete book merely by rewriting IDs.
    """

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in sorted(plan["entries"], key=lambda item: str(item["canonical_id"])):
        canonical_id = str(entry["canonical_id"])
        common = {
            "canonical_id": canonical_id,
            "work_id": str(entry.get("work_id") or ""),
            "edition_id": str(entry.get("edition_id") or ""),
            "normalized_sha256": str(entry.get("normalized_sha256") or ""),
        }
        for identity in sorted({str(value) for value in entry.get("legacy_identities", [])}):
            if identity in seen:
                raise ValueError(f"Legacy identity appears more than once in lineage: {identity}")
            seen.add(identity)
            rows.append(
                {
                    "identity_key": identity,
                    "status": "active_equivalent",
                    "requires_rebuild": False,
                    **common,
                }
            )
        for retired in entry.get("superseded_legacy_identities", []):
            identity = str(retired.get("identity_key") or "")
            if not identity:
                raise ValueError(f"Invalid retired legacy identity on {canonical_id}: {retired!r}")
            if identity in seen:
                raise ValueError(f"Legacy identity appears more than once in lineage: {identity}")
            seen.add(identity)
            rows.append(
                {
                    "identity_key": identity,
                    "status": "retired_incomplete",
                    "requires_rebuild": True,
                    "source_canonical_id": str(retired.get("source_canonical_id") or ""),
                    "superseded_by": canonical_id,
                    "review_id": str(retired.get("review_id") or ""),
                    "reason": str(retired.get("reason") or "excluded_incomplete_edition"),
                    **common,
                }
            )
    rows.sort(key=lambda item: str(item["identity_key"]))
    return rows


def canonical_id_lineage_payload(plan: dict[str, Any]) -> dict[str, Any]:
    """Return the durable map consumed by downstream migration gates."""

    rows = identity_lineage_rows(plan)
    active = {
        str(row["identity_key"]): str(row["canonical_id"])
        for row in rows
        if row["status"] == "active_equivalent"
    }
    retired = [row for row in rows if row["status"] != "active_equivalent"]
    return {
        "layout_version": ID_LINEAGE_LAYOUT_VERSION,
        "raw_layout_version": LAYOUT_VERSION,
        "mappings": dict(sorted(active.items())),
        "retired_identities": retired,
        "summary": {
            "active_equivalent_identities": len(active),
            "retired_incomplete_identities": len(retired),
            "total_legacy_identities": len(rows),
            "raw_books": len(plan["entries"]),
            "publication_supersessions": len(plan.get("publication_supersessions", [])),
        },
    }


def stage_plan(
    plan: dict[str, Any],
    staging_root: str | Path,
    *,
    transfer_mode: str = "hardlink",
    limit: int | None = None,
    workers: int = 1,
    verification_mode: str = "full",
) -> dict[str, Any]:
    if transfer_mode not in {"hardlink", "copy"}:
        raise ValueError("Staging transfer mode must be hardlink or copy")
    if workers < 1:
        raise ValueError("Staging workers must be >= 1")
    if verification_mode not in {"full", "trusted_frozen"}:
        raise ValueError("Verification mode must be full or trusted_frozen")
    if verification_mode == "trusted_frozen" and transfer_mode != "hardlink":
        raise ValueError("trusted_frozen verification is only safe with hardlink staging")
    staging = Path(staging_root).resolve()
    live = Path("Library/TaciturnRaw/01_RawData").resolve()
    if staging == live or live in staging.parents:
        raise ValueError("Staging root must be independent from live 01_RawData")
    selected = plan["entries"] if limit is None else plan["entries"][:limit]
    # Organizer order groups an entire category together. Feeding that order to
    # many workers makes every mkdir contend on one remote parent inode. Spread
    # work round-robin across category parents to avoid the metadata hot spot.
    by_category: dict[str, list[dict[str, Any]]] = {}
    for entry in selected:
        by_category.setdefault(str(entry["category_dir"]), []).append(entry)
    for category_dir in by_category:
        (staging / category_dir).mkdir(parents=True, exist_ok=True)
    category_offsets = {category: 0 for category in by_category}
    staging_entries: list[dict[str, Any]] = []
    remaining = len(selected)
    while remaining:
        for category, entries in by_category.items():
            offset = category_offsets[category]
            if offset >= len(entries):
                continue
            staging_entries.append(entries[offset])
            category_offsets[category] = offset + 1
            remaining -= 1
    def stage_entry(entry: dict[str, Any]) -> tuple[str, dict[str, str] | None]:
        source = Path(entry["source_file"])
        target = staging / entry["target_source"]
        try:
            if verification_mode == "full":
                _verify_utf8_no_bom(source, str(entry["normalized_sha256"]))
            else:
                source_stat = source.lstat()
                if not stat.S_ISREG(source_stat.st_mode):
                    raise ValueError(f"Frozen source is not a regular file: {source}")
            target.parent.mkdir(exist_ok=True)
            if target.exists():
                if verification_mode == "full":
                    _verify_utf8_no_bom(target, str(entry["normalized_sha256"]))
                elif target.stat().st_ino != source.stat().st_ino:
                    raise ValueError(f"Existing hardlink target differs from source: {target}")
                state = "unchanged"
            elif transfer_mode == "hardlink":
                os.link(source, target)
                state = "written"
            else:
                temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                try:
                    shutil.copy2(source, temporary)
                    _verify_utf8_no_bom(temporary, str(entry["normalized_sha256"]))
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                state = "written"
            index_payload = {
                key: entry[key]
                for key in (
                    "layout_version",
                    "canonical_id",
                    "content_id",
                    "library_id",
                    "original_library_id",
                    "work_id",
                    "edition_id",
                    "edition_version",
                    "version_label",
                    "version_decision",
                    "title",
                    "author",
                    "genre",
                    "category_code",
                    "tags",
                    "characters",
                    "normalized_sha256",
                    "display_filename",
                    "legacy_identities",
                    "superseded_legacy_identities",
                )
                if key in entry
            }
            index_payload.update(
                {
                    "content_type": "content",
                    "processing_profile": "longform_book",
                    "structure_type": "whole",
                    "source_file": "source.txt",
                }
            )
            # Per-book metadata is independently resumable, so a costly fsync
            # per tiny file is unnecessary. Final catalogues and summary remain
            # durable atomic writes.
            _atomic_write(
                staging / entry["target_index"],
                _json_bytes(index_payload),
                durable=False,
            )
            return state, None
        except Exception as exc:  # every failure is retained in the staging audit
            return "failed", {
                "canonical_id": str(entry["canonical_id"]),
                "error": str(exc),
            }

    written = unchanged = failed = 0
    errors: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for state, error in executor.map(stage_entry, staging_entries):
            written += int(state == "written")
            unchanged += int(state == "unchanged")
            failed += int(state == "failed")
            if error is not None:
                errors.append(error)
    complete = limit is None and failed == 0 and len(selected) == len(plan["entries"])
    if complete:
        _atomic_write(staging / "index.jsonl", _jsonl_bytes(plan["entries"]))
        _atomic_write(
            staging / "总目录.txt",
            _catalog_text(plan["entries"], heading="小说总目录").encode("utf-8"),
        )
        grouped: dict[str, list[dict[str, Any]]] = {}
        for entry in plan["entries"]:
            grouped.setdefault(str(entry["category_dir"]), []).append(entry)
        for category_dir, entries in grouped.items():
            _atomic_write(
                staging / category_dir / "目录.txt",
                _catalog_text(entries, heading=f"{entries[0]['genre']}目录").encode("utf-8"),
            )
    summary = {
        "planned": len(plan["entries"]),
        "selected": len(selected),
        "written": written,
        "unchanged": unchanged,
        "failed": failed,
        "complete": complete,
        "transfer_mode": transfer_mode,
        "verification_mode": verification_mode,
        "workers": workers,
        "entry_order": "category_round_robin",
        "staging_root": str(staging),
        "live_switch_performed": False,
        "errors": errors[:100],
    }
    _atomic_write(staging / "_migration" / "summary.json", _json_bytes(summary))
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--organizer-index", required=True)
    parser.add_argument("--noise-root", default="Library/Noise")
    parser.add_argument("--collision-repairs")
    parser.add_argument("--id-map")
    parser.add_argument("--organizer-review")
    parser.add_argument(
        "--publication-decisions",
        help="Optional finalized decision_manifest.jsonl used to exclude audited incomplete alternates.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("--plan-dir")
    review_parser = subparsers.add_parser(
        "review-plan",
        help="Prepare batched version-completeness candidates for later review.",
    )
    review_parser.add_argument("--output-dir", required=True)
    review_parser.add_argument("--batch-size", type=int, default=16)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--staging-root", required=True)
    stage_parser.add_argument(
        "--transfer-mode", choices=("hardlink", "copy"), default="hardlink"
    )
    stage_parser.add_argument("--limit", type=int)
    stage_parser.add_argument(
        "--workers",
        type=int,
        default=max(1, available_cpu_count() * 4),
        help="Parallel small-file workers; default is 4x detected CPU quota.",
    )
    stage_parser.add_argument(
        "--verification-mode",
        choices=("full", "trusted_frozen"),
        default="full",
        help=(
            "full re-hashes every source; trusted_frozen performs metadata-only "
            "checks and is permitted only for hardlinks from an already fully "
            "verified frozen Noise corpus"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    plan = build_plan(
        args.organizer_index,
        args.noise_root,
        collision_repairs=args.collision_repairs,
        id_map=args.id_map,
        organizer_review=args.organizer_review,
    )
    if args.publication_decisions:
        plan = apply_publication_decisions(plan, args.publication_decisions)
    if args.command == "plan":
        if args.plan_dir:
            write_plan(plan, args.plan_dir)
        result: dict[str, Any] = {
            "dry_run": True,
            "plan_dir": str(Path(args.plan_dir).resolve()) if args.plan_dir else None,
        }
    elif args.command == "review-plan":
        result = write_version_review_plan(
            plan,
            args.output_dir,
            batch_size=args.batch_size,
        )
    else:
        if args.limit is not None and args.limit < 1:
            raise ValueError("--limit must be positive")
        result = stage_plan(
            plan,
            args.staging_root,
            transfer_mode=args.transfer_mode,
            limit=args.limit,
            workers=args.workers,
            verification_mode=args.verification_mode,
        )
    sys.stdout.write(
        json.dumps(
            {"phase": args.command, "summary": plan["summary"], "result": result},
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
