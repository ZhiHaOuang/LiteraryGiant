"""Streaming audit export for the local novel import pipeline.

The report deliberately separates removal of a source path after successful
publication from loss of novel content.  That distinction is essential when a
``move`` run removes canonical sources and exact duplicates alongside corrupt
or unconvertible inputs.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import tempfile
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


AUDIT_SCHEMA = "local_novel_import_audit.v1"
_SUMMARY_TOP_K = 50


class _BoundedSummary:
    """Fixed-memory heavy hitters plus a bounded-cardinality estimate.

    Per-item ledgers remain exact.  This helper prevents human-oriented
    ``summary.json`` from retaining hundreds of thousands of unique titles or
    path-bearing error strings in RAM.  Counts in ``top`` are exact until the
    capacity is exceeded, then use the standard Space-Saving estimate.  The
    unique count remains exact for small inputs and switches to HyperLogLog for
    larger streams.
    """

    def __init__(self, *, capacity: int = _SUMMARY_TOP_K, exact_unique_limit: int = 4096) -> None:
        self.capacity = max(1, int(capacity))
        self.counts: dict[object, tuple[int, int]] = {}
        self.total = 0
        self._exact_unique_limit = max(1, int(exact_unique_limit))
        self._exact_unique: set[object] | None = set()
        self._hll_precision = 12
        self._hll = bytearray(1 << self._hll_precision)

    @staticmethod
    def _encoded(value: object) -> bytes:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )

    def _observe_unique(self, value: object) -> None:
        if self._exact_unique is not None:
            self._exact_unique.add(value)
            if len(self._exact_unique) > self._exact_unique_limit:
                self._exact_unique = None
        digest = int.from_bytes(
            hashlib.blake2b(self._encoded(value), digest_size=8).digest(), "big"
        )
        index_mask = (1 << self._hll_precision) - 1
        index = digest & index_mask
        remainder = digest >> self._hll_precision
        width = 64 - self._hll_precision
        rank = width + 1 if remainder == 0 else width - remainder.bit_length() + 1
        self._hll[index] = max(self._hll[index], rank)

    def add(self, value: object) -> None:
        self.total += 1
        self._observe_unique(value)
        existing = self.counts.get(value)
        if existing is not None:
            self.counts[value] = (existing[0] + 1, existing[1])
            return
        if len(self.counts) < self.capacity:
            self.counts[value] = (1, 0)
            return
        victim, (minimum, _error) = min(
            self.counts.items(), key=lambda item: (item[1][0], self._encoded(item[0]))
        )
        del self.counts[victim]
        self.counts[value] = (minimum + 1, minimum)

    def _unique_estimate(self) -> int:
        if self._exact_unique is not None:
            return len(self._exact_unique)
        buckets = len(self._hll)
        alpha = 0.7213 / (1.0 + 1.079 / buckets)
        estimate = alpha * buckets * buckets / sum(2.0 ** (-value) for value in self._hll)
        zeroes = self._hll.count(0)
        if zeroes:
            estimate = buckets * math.log(buckets / zeroes)
        return max(0, int(round(estimate)))

    def summary(self, *, transition: bool = False) -> dict[str, object]:
        top: list[dict[str, object]] = []
        for value, (count, error) in sorted(
            self.counts.items(), key=lambda item: (-item[1][0], self._encoded(item[0]))
        ):
            item: dict[str, object] = {
                "count": int(count),
                "maximum_overcount": int(error),
            }
            if transition:
                before, after = value  # type: ignore[misc]
                item.update({"before": str(before), "after": str(after)})
            else:
                item["value"] = str(value)
            top.append(item)
        return {
            "total": self.total,
            "unique": self._unique_estimate(),
            "unique_is_estimate": self._exact_unique is None,
            "top": top,
            "top_is_estimate": self.total > sum(count - error for count, error in self.counts.values()),
            "capacity": self.capacity,
        }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_object(value: object, fallback: object) -> object:
    if value in (None, ""):
        return fallback
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _value(row: Mapping[str, Any], key: str, default: object = None) -> object:
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def _counter(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted((str(key), int(value)) for key, value in counter.items()))


def _transition(counter: Counter[tuple[str, str]]) -> dict[str, int]:
    return {
        f"{before or '(empty)'} -> {after or '(empty)'}": int(value)
        for (before, after), value in sorted(counter.items())
    }


class _JsonlWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        self.handle = self.temporary.open("wb")
        self.digest = hashlib.sha256()
        self.lines = 0
        self.bytes = 0

    def write(self, payload: Mapping[str, object]) -> None:
        encoded = (
            json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        self.handle.write(encoded)
        self.digest.update(encoded)
        self.lines += 1
        self.bytes += len(encoded)

    def close(self) -> dict[str, object]:
        if not self.handle.closed:
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.handle.close()
            os.replace(self.temporary, self.path)
        return {
            "path": str(self.path),
            "lines": self.lines,
            "bytes": self.bytes,
            "sha256": self.digest.hexdigest(),
        }

    def abort(self) -> None:
        if not self.handle.closed:
            self.handle.close()
        self.temporary.unlink(missing_ok=True)


def _atomic_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(dict(payload), handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _readonly_connection(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=120)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _backup_catalog(source_path: Path, destination_path: Path) -> None:
    """Take one SQLite-consistent backup, including committed WAL contents."""

    source = _readonly_connection(source_path)
    destination = sqlite3.connect(destination_path, timeout=120)
    try:
        source.backup(destination)
        destination.commit()
    finally:
        destination.close()
        source.close()


def _iter_jsonl(path: Path):
    """Yield valid JSON objects and retain malformed-line evidence."""

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except (UnicodeError, json.JSONDecodeError) as exc:
                yield line_number, None, f"{type(exc).__name__}: {exc}"
                continue
            if not isinstance(record, Mapping):
                yield line_number, None, "JSONL record is not an object"
                continue
            yield line_number, record, None


def _has_table(connection: sqlite3.Connection, name: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        is not None
    )


def _latest_plan(connection: sqlite3.Connection) -> str | None:
    row = connection.execute(
        """
        SELECT run_id FROM runs
        WHERE phase='plan' AND status='complete'
          AND EXISTS (SELECT 1 FROM plan_files WHERE plan_run_id=runs.run_id)
        ORDER BY COALESCE(finished_at, started_at) DESC, run_id DESC LIMIT 1
        """
    ).fetchone()
    return str(row[0]) if row is not None else None


def _validate_plan(connection: sqlite3.Connection, run_id: str) -> None:
    row = connection.execute(
        "SELECT phase, status FROM runs WHERE run_id=?", (run_id,)
    ).fetchone()
    if row is None or str(row["phase"]) != "plan" or str(row["status"]) != "complete":
        raise RuntimeError(f"Plan is missing or incomplete: {run_id}")


def _metadata_payload(row: Mapping[str, Any]) -> dict[str, object]:
    return {
        "title": str(row["display_title"] or ""),
        "title_key": str(row["title_key"] or ""),
        "author": str(row["author"] or ""),
        "aliases": _json_object(row["aliases_json"], []),
        "title_confidence": float(row["title_confidence"] or 0.0),
        "genre": str(row["genre"] or ""),
        "genre_confidence": float(row["genre_confidence"] or 0.0),
        "genre_tags": _json_object(row["genre_tags_json"], []),
    }


def _compact_metadata_change(
    before: object,
    proposal: object,
    after: object,
    changed_fields: object,
) -> dict[str, object]:
    """Avoid tripling large identical evidence payloads for no-op decisions."""

    changed = changed_fields if isinstance(changed_fields, list) else []
    if changed:
        return {"before": before, "proposal": proposal, "after": after, "unchanged": False}
    compact_proposal: dict[str, object] = {}
    if isinstance(proposal, Mapping):
        for key in ("source", "title", "author", "genre", "confidence", "low_confidence"):
            if key in proposal:
                compact_proposal[key] = proposal[key]
    return {
        "before": None,
        "proposal": compact_proposal or None,
        "after": None,
        "unchanged": True,
        "exact_payload_location": "catalog.metadata_events or source_audit",
    }


def _outcome(plan: Mapping[str, Any] | None) -> dict[str, object]:
    if plan is None:
        return {
            "state": "not_planned",
            "source_path_deleted": False,
            "content_discarded": False,
            "content_preserved": False,
            "reason": "",
        }
    state = str(plan.get("raw_transfer_state") or "pending")
    action = str(plan.get("planned_action") or "")
    outcomes = {
        "moved": ("source_removed_after_publish", True, False, True),
        "deduplicated": ("duplicate_source_removed", True, False, True),
        "invalid_deleted": ("invalid_source_deleted", True, True, False),
        "conversion_failed_deleted": (
            "conversion_failure_source_deleted",
            True,
            True,
            False,
        ),
        "converted": ("published_source_retained", False, False, True),
        "indexed_duplicate": ("duplicate_indexed_source_retained", False, False, True),
        "invalid_rejected": ("invalid_source_retained", False, False, False),
        "conversion_rejected": ("conversion_failure_source_retained", False, False, False),
    }
    label, source_deleted, discarded, preserved = outcomes.get(
        state,
        (
            "planned_not_applied" if state == "pending" else state,
            False,
            False,
            False,
        ),
    )
    reason = {
        "delete_invalid": "scan marked the input invalid",
        "source_duplicate": str(plan.get("duplicate_kind") or "duplicate content"),
    }.get(action, "")
    if state == "moved":
        reason = "UTF-8 destination verified before source removal"
    if state == "conversion_failed_deleted":
        reason = "UTF-8 conversion failed"
    return {
        "state": label,
        "raw_transfer_state": state,
        "apply_status": str(plan.get("apply_status") or ""),
        "applied_at": plan.get("applied_at"),
        "source_path_deleted": source_deleted,
        "content_discarded": discarded,
        "content_preserved": preserved,
        "reason": reason,
    }


def _metadata_audit_paths_from_catalog(connection: sqlite3.Connection) -> list[Path]:
    paths: list[Path] = []
    for row in connection.execute(
        "SELECT summary_json FROM runs WHERE phase='metadata_llm' AND summary_json IS NOT NULL"
    ):
        summary = _json_object(row[0], {})
        if isinstance(summary, Mapping) and summary.get("audit_path"):
            paths.append(Path(str(summary["audit_path"])).expanduser())
    return paths


def _apply_journal_paths_from_catalog(connection: sqlite3.Connection) -> list[Path]:
    paths: list[Path] = []
    for row in connection.execute(
        """
        SELECT run_id, options_json, summary_json FROM runs
        WHERE phase='apply' ORDER BY started_at, run_id
        """
    ):
        summary = _json_object(row["summary_json"], {})
        if isinstance(summary, Mapping) and summary.get("journal"):
            paths.append(Path(str(summary["journal"])).expanduser())
            continue
        # Older/failed apply runs did not include the journal in summary_json.
        # Its location is nevertheless deterministic from the recorded archive
        # root and run id, so retain their error/deletion evidence as well.
        options = _json_object(row["options_json"], {})
        if isinstance(options, Mapping) and options.get("archive_root"):
            paths.append(
                Path(str(options["archive_root"])).expanduser()
                / ".state"
                / "runs"
                / str(row["run_id"])
                / "journal.jsonl"
            )
    return list(dict.fromkeys(path.resolve() for path in paths))


def _verify_deletion_evidence(
    connection: sqlite3.Connection,
    plan_run_id: str | None,
) -> dict[int, dict[str, object]]:
    """Load the latest physical source-deletion result for a selected plan.

    The journal is authoritative and intentionally supports the field contract
    used by new verify runs.  Summary lists are a compatibility fallback for a
    completed verify whose journal has been moved or intentionally compacted.
    """

    if not plan_run_id:
        return {}
    evidence: dict[int, dict[str, object]] = {}
    rows = connection.execute(
        """
        SELECT run_id, status, options_json, summary_json, started_at, finished_at
        FROM runs WHERE phase='verify' ORDER BY started_at, run_id
        """
    )
    for row in rows:
        options = _json_object(row["options_json"], {})
        summary = _json_object(row["summary_json"], {})
        candidate_plan = ""
        if isinstance(summary, Mapping):
            candidate_plan = str(summary.get("plan_run_id") or "")
        if not candidate_plan and isinstance(options, Mapping):
            candidate_plan = str(options.get("plan_run_id") or "")
        if candidate_plan != plan_run_id:
            continue
        run_id = str(row["run_id"])
        base = {
            "run_id": run_id,
            "run_status": str(row["status"]),
            "verified_at": row["finished_at"] or row["started_at"],
        }
        if isinstance(summary, Mapping):
            verified_ids = summary.get("verified_deleted_file_ids") or []
            if isinstance(verified_ids, Sequence) and not isinstance(verified_ids, (str, bytes)):
                for value in verified_ids:
                    try:
                        file_id = int(value)
                    except (TypeError, ValueError):
                        continue
                    evidence[file_id] = {
                        **base,
                        "source_deleted_verified": True,
                        "evidence_source": "verify_summary",
                    }
            journal_value = summary.get("journal")
        else:
            journal_value = None
        if not journal_value and isinstance(options, Mapping) and options.get("archive_root"):
            journal_value = str(
                Path(str(options["archive_root"]))
                / ".state"
                / "runs"
                / run_id
                / "journal.jsonl"
            )
        if not journal_value:
            continue
        journal_path = Path(str(journal_value)).expanduser()
        if not journal_path.is_file():
            continue
        for line_number, record, malformed in _iter_jsonl(journal_path):
            if malformed or record is None or record.get("file_id") is None:
                continue
            try:
                file_id = int(record["file_id"])
            except (TypeError, ValueError):
                continue
            if "source_deleted_verified" not in record:
                continue
            verified_value = record.get("source_deleted_verified")
            verified = verified_value if isinstance(verified_value, bool) else None
            evidence[file_id] = {
                **base,
                "source_deleted_verified": verified,
                "destination_verified": record.get("destination_verified"),
                "status": str(record.get("status") or ""),
                "error": str(record.get("error") or ""),
                "evidence_source": "verify_journal",
                "journal": str(journal_path),
                "journal_line": line_number,
            }
    return evidence


def backfill_legacy_metadata_events(
    catalog_path: str | Path,
    metadata_audit_paths: Sequence[str | Path] = (),
) -> dict[str, object]:
    """Reconstruct exact rule baselines for legacy accepted LLM records.

    The reconstruction is accepted only when the source still has the exact
    size and nanosecond mtime captured by the scanner.  It re-runs the same
    deterministic filename/path/head rules and stores a version-2 metadata
    event; novel files and current metadata are never changed.
    """

    from .local_catalog import LocalNovelCatalog
    from .local_fingerprint import read_head_text
    from .local_metadata import build_local_metadata, canonical_name_key

    catalog_file = Path(catalog_path).expanduser().resolve()
    counters = Counter[str]()
    failures: list[dict[str, object]] = []
    with LocalNovelCatalog(catalog_file) as catalog:
        discovered = _metadata_audit_paths_from_catalog(catalog.connection)
        paths = {
            Path(path).expanduser().resolve()
            for path in [*discovered, *metadata_audit_paths]
            if Path(path).expanduser().is_file()
        }
        for audit_path in sorted(paths, key=lambda item: os.fsencode(str(item))):
            run_id = audit_path.parent.name
            with audit_path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, 1):
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    if record.get("schema_version") == "metadata_audit.v2":
                        counters["v2_skipped"] += 1
                        continue
                    if "accepted_title" not in record:
                        counters["unchanged_legacy_skipped"] += 1
                        continue
                    file_id = int(record.get("file_id") or 0)
                    if catalog.connection.execute(
                        "SELECT 1 FROM metadata_events WHERE run_id=? AND file_id=?",
                        (run_id, file_id),
                    ).fetchone() is not None:
                        counters["already_present"] += 1
                        continue
                    try:
                        row = catalog.get_file(file_id)
                        source = Path(str(row["source_path"]))
                        current = source.stat()
                        if (
                            current.st_size != int(row["size_bytes"])
                            or current.st_mtime_ns != int(row["mtime_ns"])
                        ):
                            raise RuntimeError("source identity differs from the scan record")
                        head = read_head_text(
                            source,
                            str(row["encoding"]),
                            max_bytes=96 * 1024,
                        )
                        rules = build_local_metadata(
                            {
                                "id": str(file_id),
                                "filename": str(row["source_name"]),
                                "path": str(row["source_path"]),
                                "head_excerpt": head,
                            }
                        )
                        rule_confidence = rules.get("field_confidence") or {}
                        before = {
                            "title": str(rules.get("title") or ""),
                            "title_key": str(rules.get("canonical_name_key") or ""),
                            "author": str(rules.get("author") or ""),
                            "aliases": list(rules.get("aliases") or []),
                            "title_confidence": float(rule_confidence.get("title") or 0.0),
                            "title_evidence": list(rules.get("evidence") or []),
                            "genre": str(rules.get("genre") or ""),
                            "genre_confidence": float(rule_confidence.get("genre") or 0.0),
                            "genre_tags": list(rules.get("tags") or []),
                            "genre_evidence": list(rules.get("evidence") or []),
                        }
                        accepted_title = str(record.get("accepted_title") or before["title"])
                        accepted_author = str(record.get("accepted_author") or "")
                        model_confidence = record.get("field_confidence") or {}
                        evidence = list(record.get("evidence") or [])
                        after = {
                            "title": accepted_title,
                            "title_key": canonical_name_key(accepted_title),
                            "author": accepted_author,
                            "aliases": list(record.get("aliases") or []),
                            "title_confidence": float(
                                model_confidence.get("title") or record.get("confidence") or 0.0
                            ),
                            "title_evidence": evidence,
                            "genre": str(record.get("genre") or before["genre"]),
                            "genre_confidence": float(
                                model_confidence.get("genre") or record.get("confidence") or 0.0
                            ),
                            "genre_tags": list(record.get("tags") or []),
                            "genre_evidence": evidence,
                        }
                        compared_fields = (
                            "title",
                            "title_key",
                            "author",
                            "aliases",
                            "title_confidence",
                            "genre",
                            "genre_confidence",
                            "genre_tags",
                        )
                        changed_fields = [
                            field
                            for field in compared_fields
                            if before.get(field) != after.get(field)
                        ]
                        reconstruction_reasons = [
                            "rule baseline reconstructed from unchanged scanned source",
                            f"legacy audit {audit_path}:{line_number}",
                        ]
                        if str(record.get("title") or "") != accepted_title:
                            reconstruction_reasons.append(
                                "legacy title proposal was rejected by the similarity guardrail"
                            )
                        if str(record.get("author") or "") != accepted_author:
                            reconstruction_reasons.append(
                                "legacy author proposal was rejected by the conflict guardrail"
                            )
                        catalog.record_metadata_event(
                            run_id,
                            file_id,
                            decision="legacy_accepted_reconstructed",
                            changed_fields=changed_fields,
                            reasons=reconstruction_reasons,
                            before=before,
                            proposal=record,
                            after=after,
                        )
                        counters["reconstructed"] += 1
                        if counters["reconstructed"] % 100 == 0:
                            catalog.commit()
                    except (OSError, ValueError, RuntimeError, KeyError, UnicodeError) as exc:
                        counters["failed"] += 1
                        failures.append(
                            {
                                "audit_path": str(audit_path),
                                "line": line_number,
                                "file_id": file_id,
                                "error": f"{type(exc).__name__}: {exc}",
                            }
                        )
        catalog.commit()
    return {
        "catalog_path": str(catalog_file),
        "counts": _counter(counters),
        "failures": failures,
    }


def export_local_novel_audit(
    catalog_path: str | Path,
    output_dir: str | Path,
    *,
    plan_run_id: str | None = None,
    metadata_audit_paths: Sequence[str | Path] = (),
    supplemental_jsonl_paths: Sequence[str | Path] = (),
) -> dict[str, object]:
    """Export complete per-file lifecycle, changes, and deletion ledgers.

    ``metadata_audit_paths`` accepts legacy vLLM result logs.  Version-2
    events already present in ``metadata_events`` are de-duplicated by
    ``(run_id, file_id)``.  ``supplemental_jsonl_paths`` can point to EPUB or
    archive-extraction logs so their destructive actions appear in the same
    deletion ledger.
    """

    catalog_file = Path(catalog_path).expanduser().resolve()
    if not catalog_file.is_file():
        raise FileNotFoundError(catalog_file)
    root = Path(output_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    snapshot_directory = tempfile.TemporaryDirectory(prefix="literary-giant-audit-")
    snapshot_path = Path(snapshot_directory.name) / "catalog.snapshot.sqlite3"
    try:
        _backup_catalog(catalog_file, snapshot_path)
    except BaseException:
        snapshot_directory.cleanup()
        raise
    # ``summary.json`` is the completion marker.  Never leave an older marker
    # beside a partially replaced set of JSONL artifacts after a failed run.
    (root / "summary.json").unlink(missing_ok=True)
    files_writer = _JsonlWriter(root / "files.jsonl")
    changes_writer = _JsonlWriter(root / "changes.jsonl")
    deletions_writer = _JsonlWriter(root / "deletions.jsonl")
    supplemental_writer = _JsonlWriter(root / "supplemental_events.jsonl")

    scan_status = Counter[str]()
    scan_status_bytes = Counter[str]()
    scan_errors = _BoundedSummary()
    source_labels = Counter[str]()
    encodings = Counter[str]()
    genres = Counter[str]()
    plan_actions = Counter[str]()
    duplicate_kinds = Counter[str]()
    apply_states = Counter[str]()
    deletion_classes = Counter[str]()
    deletion_bytes = Counter[str]()
    deletion_verification_counts = Counter[str]()
    verified_deletion_classes = Counter[str]()
    failed_verification_classes = Counter[str]()
    metadata_decisions = Counter[str]()
    metadata_changed_fields = Counter[str]()
    title_transitions = _BoundedSummary()
    author_transitions = _BoundedSummary()
    genre_transitions = Counter[tuple[str, str]]()
    supplemental_events = Counter[str]()
    legacy_metadata_rows = 0
    legacy_changed_without_before = 0
    seen_metadata_events: set[tuple[str, int]] = set()
    apply_errors: dict[int, str] = {}

    malformed_logs = Counter[str]()
    connection = _readonly_connection(snapshot_path)
    try:
        # The production WAL was released immediately after the backup above.
        # This immutable copy can now be streamed for as long as necessary
        # without preventing scanner/apply checkpoints.
        selected_plan = plan_run_id or _latest_plan(connection)
        if selected_plan is not None:
            _validate_plan(connection, selected_plan)
        verify_deletions = _verify_deletion_evidence(connection, selected_plan)

        if _has_table(connection, "metadata_events"):
            for row in connection.execute(
                """
                SELECT event.run_id, event.file_id, event.decision,
                       event.changed_fields_json, event.reasons_json,
                       event.before_json, event.proposal_json, event.after_json,
                       event.created_at, files.source_path, files.source_name,
                       selected.row_json AS selected_plan_json
                FROM metadata_events event
                JOIN files ON files.file_id=event.file_id
                LEFT JOIN plan_files selected
                  ON selected.file_id=event.file_id AND selected.plan_run_id=?
                ORDER BY event.event_id
                """,
                (selected_plan or "",),
            ):
                key = (str(row["run_id"]), int(row["file_id"]))
                seen_metadata_events.add(key)
                before = _json_object(row["before_json"], {})
                proposal = _json_object(row["proposal_json"], {})
                after = _json_object(row["after_json"], {})
                changed = _json_object(row["changed_fields_json"], [])
                reasons = _json_object(row["reasons_json"], [])
                decision = str(row["decision"])
                metadata_decisions[decision] += 1
                if isinstance(changed, list):
                    metadata_changed_fields.update(str(value) for value in changed)
                if isinstance(before, Mapping) and isinstance(after, Mapping):
                    if before.get("title") != after.get("title"):
                        title_transitions.add(
                            (str(before.get("title") or ""), str(after.get("title") or ""))
                        )
                    if before.get("author") != after.get("author"):
                        author_transitions.add(
                            (str(before.get("author") or ""), str(after.get("author") or ""))
                        )
                    if before.get("genre") != after.get("genre"):
                        genre_transitions[(str(before.get("genre") or ""), str(after.get("genre") or ""))] += 1
                compact = _compact_metadata_change(before, proposal, after, changed)
                event_plan = _json_object(row["selected_plan_json"], {})
                event_source_path = (
                    str(event_plan.get("source_path") or "")
                    if isinstance(event_plan, Mapping)
                    else ""
                ) or str(row["source_path"])
                event_source_name = (
                    str(event_plan.get("source_name") or "")
                    if isinstance(event_plan, Mapping)
                    else ""
                ) or str(row["source_name"])
                changes_writer.write(
                    {
                        "schema": AUDIT_SCHEMA,
                        "change_type": "metadata",
                        "run_id": key[0],
                        "file_id": key[1],
                        "source_path": event_source_path,
                        "source_name": event_source_name,
                        "at": row["created_at"],
                        "decision": decision,
                        "changed_fields": changed,
                        "reasons": reasons,
                        **compact,
                        "audit_completeness": "exact",
                    }
                )

        discovered_metadata_logs = _metadata_audit_paths_from_catalog(connection)
        all_metadata_logs = {
            Path(path).expanduser().resolve()
            for path in [*discovered_metadata_logs, *metadata_audit_paths]
            if Path(path).expanduser().exists()
        }
        for audit_path in sorted(all_metadata_logs, key=lambda item: os.fsencode(str(item))):
            for line_number, record, malformed in _iter_jsonl(audit_path):
                if malformed or record is None:
                    malformed_logs[f"metadata:{audit_path}"] += 1
                    continue
                try:
                    file_id = int(record.get("file_id") or 0)
                except (TypeError, ValueError):
                    malformed_logs[f"metadata:{audit_path}"] += 1
                    continue
                run_id = str(record.get("run_id") or audit_path.parent.name)
                key = (run_id, file_id)
                if key in seen_metadata_events:
                    continue
                if record.get("schema_version") == "metadata_audit.v2":
                    before = record.get("before") or {}
                    after = record.get("after") or {}
                    changed = record.get("changed_fields") or []
                    decision = str(record.get("decision") or "unknown")
                    completeness = "exact"
                else:
                    legacy_metadata_rows += 1
                    decision = "legacy_model_accepted" if "accepted_title" in record else "legacy_rules_fallback"
                    changed = (
                        ["title", "author", "genre"]
                        if "accepted_title" in record
                        else []
                    )
                    before = {"unavailable": True}
                    after = {
                        "title": record.get("accepted_title") or record.get("title"),
                        "author": record.get("accepted_author") or record.get("author") or "",
                        "genre": record.get("genre") or record.get("canonical_genre") or "",
                    }
                    completeness = "legacy_before_unavailable" if changed else "legacy_no_change"
                    if changed:
                        legacy_changed_without_before += 1
                seen_metadata_events.add(key)
                metadata_decisions[decision] += 1
                metadata_changed_fields.update(str(value) for value in changed)
                if isinstance(before, Mapping) and isinstance(after, Mapping):
                    if before.get("title") != after.get("title"):
                        title_transitions.add(
                            (str(before.get("title") or ""), str(after.get("title") or ""))
                        )
                    if before.get("author") != after.get("author"):
                        author_transitions.add(
                            (str(before.get("author") or ""), str(after.get("author") or ""))
                        )
                    if before.get("genre") != after.get("genre"):
                        genre_transitions[
                            (str(before.get("genre") or ""), str(after.get("genre") or ""))
                        ] += 1
                proposal = record.get("proposal") or record
                compact = _compact_metadata_change(before, proposal, after, changed)
                changes_writer.write(
                    {
                        "schema": AUDIT_SCHEMA,
                        "change_type": "metadata",
                        "run_id": run_id,
                        "file_id": file_id,
                        "source_path": record.get("source_path") or "",
                        "source_name": record.get("raw") or "",
                        "source_audit": str(audit_path),
                        "source_line": line_number,
                        "decision": decision,
                        "changed_fields": changed,
                        "reasons": record.get("reasons") or record.get("evidence") or [],
                        **compact,
                        "audit_completeness": completeness,
                    }
                )

        for journal_path in _apply_journal_paths_from_catalog(connection):
            if not journal_path.is_file():
                continue
            for _line_number, record, malformed in _iter_jsonl(journal_path):
                if malformed or record is None:
                    malformed_logs[f"apply:{journal_path}"] += 1
                    continue
                if record.get("file_id") is not None and record.get("error"):
                    apply_errors[int(record["file_id"])] = str(record["error"])

        if selected_plan is None:
            rows = connection.execute("SELECT files.*, NULL AS row_json FROM files ORDER BY file_id")
        else:
            rows = connection.execute(
                """
                SELECT files.*, plan_files.row_json, plan_files.apply_status AS plan_apply_status,
                       plan_files.raw_transfer_state AS plan_transfer_state,
                       plan_files.applied_at AS plan_applied_at
                FROM files
                LEFT JOIN plan_files
                  ON plan_files.file_id=files.file_id AND plan_files.plan_run_id=?
                ORDER BY files.file_id
                """,
                (selected_plan,),
            )

        for row in rows:
            file_id = int(row["file_id"])
            plan: dict[str, Any] | None = None
            if row["row_json"]:
                plan = json.loads(str(row["row_json"]))
                plan["apply_status"] = str(row["plan_apply_status"] or "")
                plan["raw_transfer_state"] = str(row["plan_transfer_state"] or "")
                plan["applied_at"] = row["plan_applied_at"]
                action = str(plan.get("planned_action") or "")
                plan_actions[action] += 1
                if plan.get("duplicate_kind"):
                    duplicate_kinds[str(plan["duplicate_kind"])] += 1
                apply_states[str(plan.get("raw_transfer_state") or "pending")] += 1

            # A selected plan is an immutable historical statement.  Current
            # ``files`` rows may later be rescanned, renamed to an archived
            # synthetic identity, or reused by a new upload, so lifecycle
            # fields must come from the frozen snapshot whenever it exists.
            lifecycle: Mapping[str, Any] = plan if plan is not None else row
            size_bytes = int(lifecycle["size_bytes"] or 0)
            status = str(lifecycle["scan_status"] or "unknown")
            scan_status[status] += 1
            scan_status_bytes[status] += size_bytes
            source_labels[str(lifecycle["source_label"] or "")] += 1
            if lifecycle["scan_error"]:
                scan_errors.add(str(lifecycle["scan_error"]))
            if lifecycle["encoding"]:
                encodings[str(lifecycle["encoding"])] += 1
            if row["genre"]:
                genres[str(row["genre"])] += 1

            outcome = _outcome(plan)
            deletion_verification = verify_deletions.get(file_id)
            deletion_recorded = bool(outcome["source_path_deleted"])
            deletion_verified: bool | None = None
            if deletion_recorded and deletion_verification is not None:
                verified_value = deletion_verification.get("source_deleted_verified")
                if isinstance(verified_value, bool):
                    deletion_verified = verified_value
            outcome["source_deletion_recorded"] = deletion_recorded
            outcome["source_deletion_verified"] = deletion_verified
            outcome["deletion_verification"] = deletion_verification
            original = {
                "source_path": str(lifecycle["source_path"]),
                "source_root": str(lifecycle["source_root"]),
                "source_label": str(lifecycle["source_label"]),
                "relative_path": str(lifecycle["relative_path"]),
                "source_name": str(lifecycle["source_name"]),
                "size_bytes": size_bytes,
                "mtime_ns": int(lifecycle["mtime_ns"] or 0),
                "ctime_ns": int(
                    _value(lifecycle, "ctime_ns", _value(row, "ctime_ns", 0)) or 0
                ),
                "device_id": int(
                    _value(lifecycle, "device_id", _value(row, "device_id", 0)) or 0
                ),
                "inode": int(_value(lifecycle, "inode", _value(row, "inode", 0)) or 0),
                "raw_sha256": str(lifecycle["raw_sha256"] or ""),
            }
            scan = {
                "status": status,
                "error": str(lifecycle["scan_error"] or ""),
                "encoding": str(lifecycle["encoding"] or ""),
                "encoding_confidence": str(lifecycle["encoding_confidence"] or ""),
                "normalized_sha256": str(lifecycle["normalized_sha256"] or ""),
                "non_whitespace_chars": int(lifecycle["non_whitespace_chars"] or 0),
                "line_count": int(lifecycle["line_count"] or 0),
                "replacement_chars": int(
                    _value(
                        lifecycle,
                        "replacement_chars",
                        _value(row, "replacement_chars", 0),
                    )
                    or 0
                ),
                "replacement_chars_basis": (
                    "frozen_plan_snapshot"
                    if _value(lifecycle, "replacement_chars") is not None and plan is not None
                    else "catalog_current_fallback"
                    if plan is not None
                    else "catalog_current"
                ),
            }
            plan_payload: dict[str, object] | None = None
            if plan is not None:
                plan_payload = {
                    "run_id": selected_plan,
                    "action": str(plan.get("planned_action") or ""),
                    "work_id": str(plan.get("work_id") or ""),
                    "edition_id": str(plan.get("edition_id") or ""),
                    "library_id": int(plan.get("library_id") or 0),
                    "category_code": str(plan.get("category_code") or ""),
                    "edition_version": int(plan.get("edition_version") or 0),
                    "duplicate_of_file_id": plan.get("duplicate_of_file_id"),
                    "duplicate_kind": str(plan.get("duplicate_kind") or ""),
                    "duplicate_evidence": _json_object(plan.get("duplicate_evidence_json"), {}),
                    "destination": str(plan.get("raw_destination") or ""),
                    "previous_destination": str(plan.get("previous_destination") or ""),
                    "metadata": _metadata_payload(plan),
                }
                destination = str(plan.get("raw_destination") or "")
                action = str(plan.get("planned_action") or "")
                publication_changed_fields = ["disposition"]
                if destination:
                    publication_changed_fields.extend(["path", "filename"])
                if action in {"canonical", "edition"}:
                    publication_changed_fields.extend(["encoding_utf8_no_bom", "library_id"])
                elif action == "source_duplicate":
                    publication_changed_fields.append("duplicate_target")
                changes_writer.write(
                    {
                        "schema": AUDIT_SCHEMA,
                        "change_type": "publication",
                        "run_id": selected_plan,
                        "file_id": file_id,
                        "decision": action,
                        "changed_fields": publication_changed_fields,
                        "before": {
                            "path": original["source_path"],
                            "filename": original["source_name"],
                            "encoding": scan["encoding"],
                        },
                        "after": {
                            "destination": destination,
                            "filename": Path(destination).name if destination else "",
                            "encoding": "utf-8-no-bom" if destination else "",
                            "library_id": int(plan.get("library_id") or 0),
                            "metadata_ref": {
                                "artifact": "files.jsonl",
                                "file_id": file_id,
                                "field": "plan.metadata",
                            },
                        },
                        "apply": outcome,
                        "audit_completeness": "exact_plan_snapshot",
                    }
                )

            files_writer.write(
                {
                    "schema": AUDIT_SCHEMA,
                    "file_id": file_id,
                    "lifecycle_basis": (
                        "frozen_plan_snapshot" if plan is not None else "catalog_current"
                    ),
                    "original": original,
                    "scan": scan,
                    "catalog_current": {
                        "source_path": str(row["source_path"]),
                        "source_name": str(row["source_name"]),
                        "size_bytes": int(row["size_bytes"] or 0),
                        "mtime_ns": int(row["mtime_ns"] or 0),
                        "ctime_ns": int(_value(row, "ctime_ns", 0) or 0),
                        "device_id": int(_value(row, "device_id", 0) or 0),
                        "inode": int(_value(row, "inode", 0) or 0),
                        "scan_status": str(row["scan_status"] or "unknown"),
                        "scan_error": str(row["scan_error"] or ""),
                        "raw_sha256": str(row["raw_sha256"] or ""),
                    },
                    "metadata_current": _metadata_payload(row),
                    "plan": plan_payload,
                    "outcome": outcome,
                }
            )

            if bool(outcome["source_path_deleted"]):
                deletion_class = str(outcome["state"])
                deletion_classes[deletion_class] += 1
                deletion_bytes[deletion_class] += size_bytes
                deletion_reason = str(outcome["reason"] or "")
                if deletion_class == "invalid_source_deleted":
                    deletion_reason = str(lifecycle["scan_error"] or deletion_reason)
                elif deletion_class == "conversion_failure_source_deleted":
                    deletion_reason = apply_errors.get(file_id, deletion_reason)
                deletion_verification_counts[
                    "verified_deleted"
                    if deletion_verified is True
                    else "verification_failed"
                    if deletion_verified is False
                    else "not_verified"
                ] += 1
                if deletion_verified is True:
                    verified_deletion_classes[deletion_class] += 1
                elif deletion_verified is False:
                    failed_verification_classes[deletion_class] += 1
                deletions_writer.write(
                    {
                        "schema": AUDIT_SCHEMA,
                        "item_type": "txt_source",
                        "file_id": file_id,
                        "original_path": original["source_path"],
                        "original_name": original["source_name"],
                        "size_bytes": size_bytes,
                        "raw_sha256": original["raw_sha256"],
                        "deletion_class": deletion_class,
                        "reason": deletion_reason,
                        "recorded_deleted": True,
                        "verified_deleted": deletion_verified,
                        "verification": deletion_verification,
                        "content_discarded": bool(outcome["content_discarded"]),
                        "content_preserved": bool(outcome["content_preserved"]),
                        "preserved_at": (
                            str(plan.get("raw_destination") or "") if plan is not None else ""
                        ),
                        "duplicate_of_file_id": (
                            plan.get("duplicate_of_file_id") if plan is not None else None
                        ),
                        "applied_at": outcome.get("applied_at"),
                    }
                )

        supplemental_paths = {
            Path(path).expanduser().resolve()
            for path in supplemental_jsonl_paths
            if Path(path).expanduser().is_file()
        }
        for event_path in sorted(supplemental_paths, key=lambda item: os.fsencode(str(item))):
            for line_number, record, malformed in _iter_jsonl(event_path):
                if malformed or record is None:
                    malformed_logs[f"supplemental:{event_path}"] += 1
                    continue
                event = str(record.get("event") or "unknown")
                status = str(record.get("status") or "")
                supplemental_events[f"{event}:{status or '(none)'}"] += 1
                supplemental_writer.write(
                    {
                        "schema": AUDIT_SCHEMA,
                        "source_log": str(event_path),
                        "source_line": line_number,
                        "record": record,
                    }
                )
                if event == "delete_result" and status == "rejected_deleted":
                    deletion_class = "epub_rejected_deleted"
                    deletion_classes[deletion_class] += 1
                    identity = record.get("identity") or {}
                    size_bytes = (
                        int(identity.get("size") or record.get("source_bytes") or 0)
                        if isinstance(identity, Mapping)
                        else 0
                    )
                    deletion_bytes[deletion_class] += size_bytes
                    error = record.get("error") or record.get("rejection") or {}
                    supplemental_verified = (
                        record.get("source_deleted_verified")
                        if isinstance(record.get("source_deleted_verified"), bool)
                        else None
                    )
                    deletion_verification_counts[
                        "verified_deleted"
                        if supplemental_verified is True
                        else "verification_failed"
                        if supplemental_verified is False
                        else "not_verified"
                    ] += 1
                    if supplemental_verified is True:
                        verified_deletion_classes[deletion_class] += 1
                    elif supplemental_verified is False:
                        failed_verification_classes[deletion_class] += 1
                    deletions_writer.write(
                        {
                            "schema": AUDIT_SCHEMA,
                            "item_type": "epub_source",
                            "original_path": record.get("source_path") or "",
                            "size_bytes": size_bytes,
                            "deletion_class": deletion_class,
                            "reason": error,
                            "recorded_deleted": True,
                            "verified_deleted": supplemental_verified,
                            "content_discarded": True,
                            "content_preserved": False,
                            "source_log": str(event_path),
                            "source_line": line_number,
                        }
                    )
                if (
                    event == "archive_extract"
                    and record.get("archive_deleted") is True
                    and status == "complete"
                ):
                    deletion_class = "archive_replaced_by_extracted_files"
                    deletion_classes[deletion_class] += 1
                    size_bytes = int(record.get("archive_bytes") or 0)
                    deletion_bytes[deletion_class] += size_bytes
                    supplemental_verified = (
                        record.get("source_deleted_verified")
                        if isinstance(record.get("source_deleted_verified"), bool)
                        else None
                    )
                    deletion_verification_counts[
                        "verified_deleted"
                        if supplemental_verified is True
                        else "verification_failed"
                        if supplemental_verified is False
                        else "not_verified"
                    ] += 1
                    if supplemental_verified is True:
                        verified_deletion_classes[deletion_class] += 1
                    elif supplemental_verified is False:
                        failed_verification_classes[deletion_class] += 1
                    deletions_writer.write(
                        {
                            "schema": AUDIT_SCHEMA,
                            "item_type": "archive_source",
                            "original_path": record.get("archive") or "",
                            "size_bytes": size_bytes,
                            "deletion_class": deletion_class,
                            "reason": "verified extraction completed",
                            "recorded_deleted": True,
                            "verified_deleted": supplemental_verified,
                            "content_discarded": False,
                            "content_preserved": True,
                            "preserved_at": record.get("output_root") or "",
                            "source_log": str(event_path),
                            "source_line": line_number,
                        }
                    )

        artifacts = {
            "files": files_writer.close(),
            "changes": changes_writer.close(),
            "deletions": deletions_writer.close(),
            "supplemental_events": supplemental_writer.close(),
        }
        totals = connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM files"
        ).fetchone()
        plan_details: dict[str, object] = {
            "run_id": selected_plan,
            "actions": _counter(plan_actions),
            "duplicate_kinds": _counter(duplicate_kinds),
            "apply_transfer_states": _counter(apply_states),
        }
        if selected_plan is not None:
            plan_counts = connection.execute(
                """
                SELECT COUNT(DISTINCT CASE
                           WHEN COALESCE(json_extract(row_json, '$.work_id'), '')<>''
                           THEN json_extract(row_json, '$.work_id') END),
                       COUNT(DISTINCT CASE
                           WHEN COALESCE(json_extract(row_json, '$.edition_id'), '')<>''
                           THEN json_extract(row_json, '$.edition_id') END)
                FROM plan_files WHERE plan_run_id=?
                """,
                (selected_plan,),
            ).fetchone()
            plan_details["works"] = int(plan_counts[0] or 0)
            plan_details["editions"] = int(plan_counts[1] or 0)

        pipeline_runs = []
        run_statuses = Counter[str]()
        for run in connection.execute(
            """
            SELECT run_id, phase, status, options_json, started_at, finished_at,
                   summary_json
            FROM runs ORDER BY started_at, run_id
            """
        ):
            phase = str(run["phase"])
            status = str(run["status"])
            run_statuses[f"{phase}:{status}"] += 1
            pipeline_runs.append(
                {
                    "run_id": str(run["run_id"]),
                    "phase": phase,
                    "status": status,
                    "started_at": str(run["started_at"]),
                    "finished_at": run["finished_at"],
                    "options": _json_object(run["options_json"], {}),
                    "summary": _json_object(run["summary_json"], None),
                }
            )

        discarded_classes = {
            "invalid_source_deleted",
            "conversion_failure_source_deleted",
            "epub_rejected_deleted",
        }
        recorded_discarded = sum(
            count for name, count in deletion_classes.items() if name in discarded_classes
        )
        verified_discarded = sum(
            count
            for name, count in verified_deletion_classes.items()
            if name in discarded_classes
        )
        summary: dict[str, object] = {
            "schema": AUDIT_SCHEMA,
            "generated_at": _utc_now(),
            "catalog_path": str(catalog_file),
            "output_dir": str(root),
            "catalog_snapshot": {
                "method": "sqlite_backup",
                "production_wal_released_before_jsonl_export": True,
            },
            "inventory": {
                "files": sum(scan_status.values()),
                "size_bytes": sum(scan_status_bytes.values()),
                "catalog_current_files": int(totals[0]),
                "catalog_current_size_bytes": int(totals[1]),
                "scan_status_files": _counter(scan_status),
                "scan_status_bytes": _counter(scan_status_bytes),
                "scan_errors": scan_errors.summary(),
                "source_labels": _counter(source_labels),
                "detected_encodings": _counter(encodings),
                "current_genres": _counter(genres),
            },
            "metadata": {
                "decisions": _counter(metadata_decisions),
                "changed_fields": _counter(metadata_changed_fields),
                "title_transitions": title_transitions.summary(transition=True),
                "author_transitions": author_transitions.summary(transition=True),
                "genre_transitions": _transition(genre_transitions),
                "legacy_rows": legacy_metadata_rows,
                "legacy_changed_rows_without_exact_before": legacy_changed_without_before,
            },
            "plan": plan_details,
            "filters": {
                "scan_not_accepted_files": sum(
                    count for status, count in scan_status.items() if status != "ok"
                ),
                "planned_invalid_files": int(plan_actions.get("delete_invalid", 0)),
                "planned_duplicate_files": int(plan_actions.get("source_duplicate", 0)),
                "recorded_discarded_content_files": recorded_discarded,
                "actually_discarded_content_files": verified_discarded,
            },
            "deletions": {
                "counting_basis": "recorded_apply_or_supplemental_state",
                "by_class_files": _counter(deletion_classes),
                "by_class_bytes": _counter(deletion_bytes),
                "physical_verification": _counter(deletion_verification_counts),
                "verified_by_class_files": _counter(verified_deletion_classes),
                "verification_failed_by_class_files": _counter(failed_verification_classes),
                "content_discarded_files": recorded_discarded,
                "verified_content_discarded_files": verified_discarded,
                "source_paths_removed_but_content_preserved": sum(
                    count
                    for name, count in deletion_classes.items()
                    if name not in discarded_classes
                ),
            },
            "supplemental": {
                "events": _counter(supplemental_events),
                "malformed_jsonl_records": _counter(malformed_logs),
            },
            "pipeline_run_statuses": _counter(run_statuses),
            "pipeline_runs": pipeline_runs,
            "audit_limitations": (
                ([
                    f"{legacy_changed_without_before} legacy LLM changes predate metadata_audit.v2; "
                    "their accepted values are recorded but exact prior values are unavailable."
                ]
                if legacy_changed_without_before
                else [])
                + (
                    [
                        f"{deletion_verification_counts.get('not_verified', 0)} recorded deletions "
                        "do not yet have a successful physical verify event."
                    ]
                    if deletion_verification_counts.get("not_verified", 0)
                    else []
                )
                + (
                    [
                        f"{sum(malformed_logs.values())} malformed JSONL records were skipped; "
                        "their source logs are listed in supplemental.malformed_jsonl_records."
                    ]
                    if malformed_logs
                    else []
                )
            ),
            "artifacts": artifacts,
        }
        _atomic_json(root / "summary.json", summary)
        return summary
    except BaseException:
        files_writer.abort()
        changes_writer.abort()
        deletions_writer.abort()
        supplemental_writer.abort()
        raise
    finally:
        connection.close()
        snapshot_directory.cleanup()
