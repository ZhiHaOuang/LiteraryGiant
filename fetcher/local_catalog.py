"""SQLite catalog for the resumable local-novel import pipeline."""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .local_resources import available_cpu_count


SCHEMA_VERSION = 10
DEFAULT_MAX_NEAR_PAIR_ROWS = 25_000_000
COMPLETED_PLAN_STATES_META_KEY = "completed_plan_states_ready_v1"

PLAN_SNAPSHOT_FIELDS = (
    "file_id",
    "source_path",
    "source_root",
    "source_label",
    "relative_path",
    "source_name",
    "size_bytes",
    "mtime_ns",
    "ctime_ns",
    "device_id",
    "inode",
    "scan_status",
    "scan_error",
    "fingerprint_version",
    "raw_sha256",
    "normalized_sha256",
    "non_whitespace_chars",
    "line_count",
    "replacement_chars",
    "encoding",
    "encoding_confidence",
    "display_title",
    "title_key",
    "author",
    "aliases_json",
    "title_confidence",
    "title_evidence_json",
    "genre",
    "genre_confidence",
    "genre_tags_json",
    "genre_evidence_json",
    "source_priority",
    "source_kind",
    "library_id",
    "category_code",
    "edition_version",
    "title_sort_key",
    "author_sort_key",
    "sort_initial",
    "sort_method",
    "previous_destination",
    "plan_run_id",
    "planned_action",
    "work_id",
    "edition_id",
    "duplicate_of_file_id",
    "duplicate_kind",
    "duplicate_evidence_json",
    "raw_destination",
    "work_destination",
)
_RUN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}\Z")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sqlite_identity_int(value: object) -> int:
    """Map an OS identity value into SQLite's signed 64-bit INTEGER range."""

    number = int(value or 0)
    if -(1 << 63) <= number < (1 << 63):
        return number
    return ((number + (1 << 63)) % (1 << 64)) - (1 << 63)


def _destination_stat_token(value: Sequence[int]) -> tuple[int, int, int, int, int]:
    """Normalize an lstat token for durable SQLite storage."""

    if len(value) != 5:
        raise ValueError("destination_stat_token must contain five integers")
    device_id, inode, size_bytes, mtime_ns, ctime_ns = value
    size = int(size_bytes)
    if size < 0:
        raise ValueError("destination size must not be negative")
    return (
        _sqlite_identity_int(device_id),
        _sqlite_identity_int(inode),
        size,
        int(mtime_ns),
        int(ctime_ns),
    )


def _plan_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    return {field: row[field] for field in PLAN_SNAPSHOT_FIELDS}


class LocalNovelCatalog(AbstractContextManager["LocalNovelCatalog"]):
    """Single-writer catalog with WAL reads and idempotent upserts."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, timeout=120)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        # This SQLite build supports up to eight auxiliary sorter workers.
        # Large anchor covering-index builds and candidate GROUP BY operations
        # otherwise default to zero workers and pin one CPU for many minutes.
        self.connection.execute(
            f"PRAGMA threads={min(8, available_cpu_count())}"
        )
        self._initialize()

    def __exit__(self, exc_type, exc, traceback) -> None:
        if exc_type is None:
            self.connection.commit()
        else:
            self.connection.rollback()
        self.connection.close()

    def _initialize(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS catalog_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                phase TEXT NOT NULL,
                status TEXT NOT NULL,
                options_json TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                summary_json TEXT
            );
            CREATE TABLE IF NOT EXISTS files (
                file_id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_path TEXT NOT NULL UNIQUE,
                source_root TEXT NOT NULL,
                source_label TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                ctime_ns INTEGER NOT NULL DEFAULT 0,
                device_id INTEGER NOT NULL DEFAULT 0,
                inode INTEGER NOT NULL DEFAULT 0,
                scan_status TEXT NOT NULL,
                fingerprint_version INTEGER NOT NULL DEFAULT 0,
                scan_error TEXT NOT NULL DEFAULT '',
                raw_sha256 TEXT NOT NULL DEFAULT '',
                normalized_sha256 TEXT NOT NULL DEFAULT '',
                non_whitespace_chars INTEGER NOT NULL DEFAULT 0,
                line_count INTEGER NOT NULL DEFAULT 0,
                replacement_chars INTEGER NOT NULL DEFAULT 0,
                encoding TEXT NOT NULL DEFAULT '',
                encoding_confidence TEXT NOT NULL DEFAULT '',
                encoding_score REAL NOT NULL DEFAULT 0,
                encoding_margin REAL NOT NULL DEFAULT 0,
                sketch_json TEXT NOT NULL DEFAULT '[]',
                ordered_sketch_json TEXT NOT NULL DEFAULT '[]',
                sampled_chars INTEGER NOT NULL DEFAULT 0,
                source_name TEXT NOT NULL DEFAULT '',
                display_title TEXT NOT NULL DEFAULT '',
                title_key TEXT NOT NULL DEFAULT '',
                author TEXT NOT NULL DEFAULT '',
                aliases_json TEXT NOT NULL DEFAULT '[]',
                title_confidence REAL NOT NULL DEFAULT 0,
                title_evidence_json TEXT NOT NULL DEFAULT '[]',
                genre TEXT NOT NULL DEFAULT 'unknown',
                genre_confidence REAL NOT NULL DEFAULT 0,
                genre_tags_json TEXT NOT NULL DEFAULT '[]',
                genre_evidence_json TEXT NOT NULL DEFAULT '[]',
                source_priority INTEGER NOT NULL DEFAULT 0,
                source_kind TEXT NOT NULL DEFAULT 'raw',
                library_id INTEGER NOT NULL DEFAULT 0,
                category_code TEXT NOT NULL DEFAULT '',
                edition_version INTEGER NOT NULL DEFAULT 0,
                title_sort_key TEXT NOT NULL DEFAULT '',
                author_sort_key TEXT NOT NULL DEFAULT '',
                sort_initial TEXT NOT NULL DEFAULT '#',
                sort_method TEXT NOT NULL DEFAULT '',
                previous_destination TEXT NOT NULL DEFAULT '',
                inspected_at TEXT NOT NULL,
                last_seen_scan_id TEXT NOT NULL DEFAULT '',
                plan_run_id TEXT NOT NULL DEFAULT '',
                planned_action TEXT NOT NULL DEFAULT '',
                work_id TEXT NOT NULL DEFAULT '',
                edition_id TEXT NOT NULL DEFAULT '',
                duplicate_of_file_id INTEGER,
                duplicate_kind TEXT NOT NULL DEFAULT '',
                duplicate_evidence_json TEXT NOT NULL DEFAULT '{}',
                raw_destination TEXT NOT NULL DEFAULT '',
                work_destination TEXT NOT NULL DEFAULT '',
                apply_status TEXT NOT NULL DEFAULT '',
                applied_at TEXT,
                FOREIGN KEY(duplicate_of_file_id) REFERENCES files(file_id)
            );
            CREATE TABLE IF NOT EXISTS anchors (
                file_id INTEGER NOT NULL,
                anchor TEXT NOT NULL,
                PRIMARY KEY(file_id, anchor),
                FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS duplicate_edges (
                plan_run_id TEXT NOT NULL,
                left_file_id INTEGER NOT NULL,
                right_file_id INTEGER NOT NULL,
                relation TEXT NOT NULL,
                auto_merge INTEGER NOT NULL,
                evidence_json TEXT NOT NULL,
                PRIMARY KEY(plan_run_id, left_file_id, right_file_id)
            );
            CREATE TABLE IF NOT EXISTS plan_files (
                plan_run_id TEXT NOT NULL,
                file_id INTEGER NOT NULL,
                row_json TEXT NOT NULL,
                apply_status TEXT NOT NULL DEFAULT '',
                raw_transfer_state TEXT NOT NULL DEFAULT '',
                applied_at TEXT,
                destination_device_id INTEGER NOT NULL DEFAULT 0,
                destination_inode INTEGER NOT NULL DEFAULT 0,
                destination_size_bytes INTEGER NOT NULL DEFAULT 0,
                destination_mtime_ns INTEGER NOT NULL DEFAULT 0,
                destination_ctime_ns INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(plan_run_id, file_id),
                FOREIGN KEY(file_id) REFERENCES files(file_id)
            );
            CREATE TABLE IF NOT EXISTS completed_plan_states (
                file_id INTEGER PRIMARY KEY,
                plan_run_id TEXT NOT NULL,
                plan_finished_at TEXT NOT NULL,
                raw_destination TEXT NOT NULL DEFAULT '',
                work_destination TEXT NOT NULL DEFAULT '',
                library_id INTEGER NOT NULL DEFAULT 0,
                planned_action TEXT NOT NULL DEFAULT '',
                apply_status TEXT NOT NULL DEFAULT '',
                raw_transfer_state TEXT NOT NULL DEFAULT '',
                applied_at TEXT,
                destination_device_id INTEGER NOT NULL DEFAULT 0,
                destination_inode INTEGER NOT NULL DEFAULT 0,
                destination_size_bytes INTEGER NOT NULL DEFAULT 0,
                destination_mtime_ns INTEGER NOT NULL DEFAULT 0,
                destination_ctime_ns INTEGER NOT NULL DEFAULT 0,
                source_path TEXT NOT NULL DEFAULT '',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                mtime_ns INTEGER NOT NULL DEFAULT 0,
                ctime_ns INTEGER NOT NULL DEFAULT 0,
                device_id INTEGER NOT NULL DEFAULT 0,
                inode INTEGER NOT NULL DEFAULT 0,
                fingerprint_version INTEGER NOT NULL DEFAULT 0,
                raw_sha256 TEXT NOT NULL DEFAULT '',
                normalized_sha256 TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE,
                FOREIGN KEY(plan_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS run_checkpoints (
                run_id TEXT NOT NULL,
                checkpoint_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(run_id, checkpoint_key),
                FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS metadata_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                file_id INTEGER NOT NULL,
                decision TEXT NOT NULL,
                changed_fields_json TEXT NOT NULL DEFAULT '[]',
                reasons_json TEXT NOT NULL DEFAULT '[]',
                before_json TEXT NOT NULL,
                proposal_json TEXT NOT NULL,
                after_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(run_id, file_id),
                FOREIGN KEY(file_id) REFERENCES files(file_id)
            );
            CREATE TABLE IF NOT EXISTS llm_metadata_cache (
                input_signature TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                prompt_schema TEXT NOT NULL,
                file_id INTEGER NOT NULL,
                result_json TEXT NOT NULL,
                decision TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS library_identities (
                library_id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_file_ids (
                file_id INTEGER PRIMARY KEY,
                library_id INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE,
                FOREIGN KEY(library_id) REFERENCES library_identities(library_id)
            );
            CREATE TABLE IF NOT EXISTS library_content_ids (
                content_key TEXT PRIMARY KEY,
                library_id INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                FOREIGN KEY(library_id) REFERENCES library_identities(library_id)
            );
            CREATE TABLE IF NOT EXISTS library_work_versions (
                work_anchor_id INTEGER NOT NULL,
                edition_library_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                PRIMARY KEY(work_anchor_id, edition_library_id),
                UNIQUE(work_anchor_id, version),
                FOREIGN KEY(work_anchor_id) REFERENCES library_identities(library_id),
                FOREIGN KEY(edition_library_id) REFERENCES library_identities(library_id)
            );
            CREATE INDEX IF NOT EXISTS idx_files_normalized_hash ON files(normalized_sha256);
            CREATE INDEX IF NOT EXISTS idx_files_title_key ON files(title_key);
            CREATE INDEX IF NOT EXISTS idx_files_scan_status ON files(scan_status);
            CREATE INDEX IF NOT EXISTS idx_files_plan_run ON files(plan_run_id);
            CREATE INDEX IF NOT EXISTS idx_plan_files_run_status
                ON plan_files(plan_run_id, apply_status);
            CREATE INDEX IF NOT EXISTS idx_plan_files_file_apply_latest
                ON plan_files(
                    file_id, apply_status, applied_at DESC, plan_run_id DESC
                );
            CREATE INDEX IF NOT EXISTS idx_plan_files_latest_complete
                ON plan_files(file_id, applied_at DESC, plan_run_id DESC)
                WHERE apply_status='complete';
            CREATE INDEX IF NOT EXISTS idx_runs_completed_plans
                ON runs(finished_at, run_id)
                WHERE phase='plan' AND status='complete';
            CREATE INDEX IF NOT EXISTS idx_completed_plan_states_run
                ON completed_plan_states(plan_run_id, file_id);
            CREATE INDEX IF NOT EXISTS idx_metadata_events_file
                ON metadata_events(file_id, event_id);
            CREATE INDEX IF NOT EXISTS idx_metadata_events_run
                ON metadata_events(run_id, event_id);
            CREATE INDEX IF NOT EXISTS idx_llm_metadata_cache_file
                ON llm_metadata_cache(file_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_library_file_ids_library
                ON library_file_ids(library_id);
            CREATE INDEX IF NOT EXISTS idx_library_content_ids_library
                ON library_content_ids(library_id);
            """
        )
        current = self.connection.execute(
            "SELECT value FROM catalog_meta WHERE key='schema_version'"
        ).fetchone()
        is_new_catalog = current is None
        current_version = int(current[0]) if current is not None else SCHEMA_VERSION
        if current_version not in set(range(1, SCHEMA_VERSION + 1)):
            raise RuntimeError(
                f"Unsupported local catalog schema {current[0]}; expected {SCHEMA_VERSION}"
            )
        columns = {
            str(row[1])
            for row in self.connection.execute("PRAGMA table_info(plan_files)")
        }
        if "raw_transfer_state" not in columns:
            self.connection.execute(
                "ALTER TABLE plan_files ADD COLUMN raw_transfer_state TEXT NOT NULL DEFAULT ''"
            )
        destination_token_columns = {
            "destination_device_id": "INTEGER NOT NULL DEFAULT 0",
            "destination_inode": "INTEGER NOT NULL DEFAULT 0",
            "destination_size_bytes": "INTEGER NOT NULL DEFAULT 0",
            "destination_mtime_ns": "INTEGER NOT NULL DEFAULT 0",
            "destination_ctime_ns": "INTEGER NOT NULL DEFAULT 0",
        }
        for column_name, declaration in destination_token_columns.items():
            if column_name not in columns:
                self.connection.execute(
                    f"ALTER TABLE plan_files ADD COLUMN {column_name} {declaration}"
                )
        completed_columns = {
            str(row[1])
            for row in self.connection.execute(
                "PRAGMA table_info(completed_plan_states)"
            )
        }
        for column_name, declaration in destination_token_columns.items():
            if column_name not in completed_columns:
                self.connection.execute(
                    "ALTER TABLE completed_plan_states "
                    f"ADD COLUMN {column_name} {declaration}"
                )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_plan_files_file_transfer "
            "ON plan_files(file_id, raw_transfer_state)"
        )
        file_columns = {
            str(row[1]) for row in self.connection.execute("PRAGMA table_info(files)")
        }
        if "fingerprint_version" not in file_columns:
            self.connection.execute(
                "ALTER TABLE files ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 0"
            )
        if "last_seen_scan_id" not in file_columns:
            self.connection.execute(
                "ALTER TABLE files ADD COLUMN last_seen_scan_id TEXT NOT NULL DEFAULT ''"
            )
        new_file_columns = {
            "ctime_ns": "INTEGER NOT NULL DEFAULT 0",
            "device_id": "INTEGER NOT NULL DEFAULT 0",
            "inode": "INTEGER NOT NULL DEFAULT 0",
            "source_priority": "INTEGER NOT NULL DEFAULT 0",
            "source_kind": "TEXT NOT NULL DEFAULT 'raw'",
            "library_id": "INTEGER NOT NULL DEFAULT 0",
            "category_code": "TEXT NOT NULL DEFAULT ''",
            "edition_version": "INTEGER NOT NULL DEFAULT 0",
            "title_sort_key": "TEXT NOT NULL DEFAULT ''",
            "author_sort_key": "TEXT NOT NULL DEFAULT ''",
            "sort_initial": "TEXT NOT NULL DEFAULT '#'",
            "sort_method": "TEXT NOT NULL DEFAULT ''",
            "previous_destination": "TEXT NOT NULL DEFAULT ''",
        }
        for column_name, declaration in new_file_columns.items():
            if column_name not in file_columns:
                self.connection.execute(
                    f"ALTER TABLE files ADD COLUMN {column_name} {declaration}"
                )

        # Build the covering anchor index immediately for a new (empty)
        # catalog.  On a large v1-v7 catalog defer its multi-gigabyte rebuild
        # until near-candidate planning actually starts; ordinary reports and
        # incremental scans must not unexpectedly pay that migration cost.
        if is_new_catalog:
            self._ensure_anchor_covering_index()
            self.connection.execute(
                "INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, '1')",
                (COMPLETED_PLAN_STATES_META_KEY,),
            )

        # Version 1 kept only the latest plan on the mutable ``files`` rows.
        # Preserve that still-recoverable latest snapshot during migration;
        # all version-2 plans are frozen explicitly by ``freeze_plan``.
        if current_version == 1:
            rows = self.connection.execute(
                "SELECT * FROM files WHERE plan_run_id<>'' ORDER BY file_id"
            )
            batch: list[tuple[object, ...]] = []
            for row in rows:
                payload = _plan_payload(row)
                batch.append(
                    (
                        str(row["plan_run_id"]),
                        int(row["file_id"]),
                        _json(payload),
                        str(row["apply_status"] or ""),
                        "",
                        row["applied_at"],
                    )
                )
                if len(batch) >= 1000:
                    self.connection.executemany(
                        """
                        INSERT OR REPLACE INTO plan_files(
                            plan_run_id, file_id, row_json, apply_status,
                            raw_transfer_state, applied_at
                        ) VALUES(?, ?, ?, ?, ?, ?)
                        """,
                        batch,
                    )
                    batch.clear()
            if batch:
                self.connection.executemany(
                    """
                    INSERT OR REPLACE INTO plan_files(
                        plan_run_id, file_id, row_json, apply_status,
                        raw_transfer_state, applied_at
                    ) VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    batch,
                )
        self.connection.execute(
            "INSERT OR REPLACE INTO catalog_meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        self.connection.commit()

    def _ensure_anchor_covering_index(self) -> None:
        """Install the plan-only covering index without an unsafe gap."""

        # Version 7 used ``anchors(anchor)``.  Candidate generation always
        # needs file_id as well.  Create the replacement before dropping the
        # old index so an interrupted migration retains at least one index.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_anchors_anchor_file "
            "ON anchors(anchor, file_id)"
        )
        self.connection.execute("DROP INDEX IF EXISTS idx_anchors_anchor")

    def _materialize_completed_plan(self, run_id: str, finished_at: str) -> int:
        """Merge one completed immutable plan into the per-file current view."""

        cursor = self.connection.execute(
            """
            INSERT INTO completed_plan_states(
                file_id, plan_run_id, plan_finished_at,
                raw_destination, work_destination, library_id, planned_action,
                apply_status, raw_transfer_state, applied_at,
                destination_device_id, destination_inode,
                destination_size_bytes, destination_mtime_ns,
                destination_ctime_ns,
                source_path, size_bytes, mtime_ns, ctime_ns, device_id, inode,
                fingerprint_version, raw_sha256, normalized_sha256
            )
            SELECT
                plan_files.file_id,
                plan_files.plan_run_id,
                ?,
                COALESCE(json_extract(plan_files.row_json, '$.raw_destination'), ''),
                COALESCE(json_extract(plan_files.row_json, '$.work_destination'), ''),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.library_id'), 0) AS INTEGER),
                COALESCE(json_extract(plan_files.row_json, '$.planned_action'), ''),
                plan_files.apply_status,
                plan_files.raw_transfer_state,
                plan_files.applied_at,
                plan_files.destination_device_id,
                plan_files.destination_inode,
                plan_files.destination_size_bytes,
                plan_files.destination_mtime_ns,
                plan_files.destination_ctime_ns,
                COALESCE(json_extract(plan_files.row_json, '$.source_path'), ''),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.size_bytes'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.mtime_ns'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.ctime_ns'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.device_id'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.inode'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(plan_files.row_json, '$.fingerprint_version'), 0) AS INTEGER),
                COALESCE(json_extract(plan_files.row_json, '$.raw_sha256'), ''),
                COALESCE(json_extract(plan_files.row_json, '$.normalized_sha256'), '')
            FROM plan_files
            WHERE plan_files.plan_run_id=?
            ON CONFLICT(file_id) DO UPDATE SET
                plan_run_id=excluded.plan_run_id,
                plan_finished_at=excluded.plan_finished_at,
                raw_destination=excluded.raw_destination,
                work_destination=excluded.work_destination,
                library_id=excluded.library_id,
                planned_action=excluded.planned_action,
                apply_status=excluded.apply_status,
                raw_transfer_state=excluded.raw_transfer_state,
                applied_at=excluded.applied_at,
                destination_device_id=excluded.destination_device_id,
                destination_inode=excluded.destination_inode,
                destination_size_bytes=excluded.destination_size_bytes,
                destination_mtime_ns=excluded.destination_mtime_ns,
                destination_ctime_ns=excluded.destination_ctime_ns,
                source_path=excluded.source_path,
                size_bytes=excluded.size_bytes,
                mtime_ns=excluded.mtime_ns,
                ctime_ns=excluded.ctime_ns,
                device_id=excluded.device_id,
                inode=excluded.inode,
                fingerprint_version=excluded.fingerprint_version,
                raw_sha256=excluded.raw_sha256,
                normalized_sha256=excluded.normalized_sha256
            WHERE excluded.plan_finished_at > completed_plan_states.plan_finished_at
               OR (
                    excluded.plan_finished_at=completed_plan_states.plan_finished_at
                    AND excluded.plan_run_id>completed_plan_states.plan_run_id
               )
            """,
            (str(finished_at or ""), str(run_id)),
        )
        return max(0, int(cursor.rowcount))

    def _ensure_completed_plan_states(self) -> None:
        """Lazily backfill the current-plan view for a pre-v9 catalog."""

        ready = self.connection.execute(
            "SELECT value FROM catalog_meta WHERE key=?",
            (COMPLETED_PLAN_STATES_META_KEY,),
        ).fetchone()
        if ready is not None and str(ready[0]) == "1":
            return

        savepoint = "completed_plan_states_backfill"
        self.connection.execute(f"SAVEPOINT {savepoint}")
        try:
            self.connection.execute("DELETE FROM completed_plan_states")
            completed_runs = self.connection.execute(
                """
                SELECT run_id, COALESCE(finished_at, '') AS finished_at
                FROM runs
                WHERE phase='plan' AND status='complete'
                ORDER BY finished_at, run_id
                """
            )
            for row in completed_runs:
                self._materialize_completed_plan(
                    str(row["run_id"]), str(row["finished_at"])
                )
            self.connection.execute(
                "INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, '1')",
                (COMPLETED_PLAN_STATES_META_KEY,),
            )
            self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        except Exception:
            self.connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self.connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise

    def start_run(self, run_id: str, phase: str, options: Mapping[str, object]) -> None:
        self.require_new_run_id(run_id)
        self.connection.execute(
            """
            INSERT INTO runs(run_id, phase, status, options_json, started_at)
            VALUES(?, ?, 'running', ?, ?)
            """,
            (run_id, phase, _json(dict(options)), utc_now()),
        )
        self.connection.commit()

    def require_new_run_id(self, run_id: str) -> None:
        if not _RUN_ID_RE.fullmatch(run_id):
            raise ValueError(
                "Run ID must be 1-96 ASCII letters, digits, dots, underscores, or hyphens"
            )
        if self.connection.execute(
            "SELECT 1 FROM runs WHERE run_id=?", (run_id,)
        ).fetchone() is not None:
            raise RuntimeError(f"Run ID already exists and cannot be overwritten: {run_id}")

    def finish_run(self, run_id: str, status: str, summary: Mapping[str, object]) -> None:
        run = self.connection.execute(
            "SELECT phase FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if run is None:
            raise KeyError(run_id)
        is_completed_plan = str(run["phase"]) == "plan" and status == "complete"
        if is_completed_plan:
            # Existing v1-v8 plans must be present before the newly completed
            # run advances the materialized per-file view.
            self._ensure_completed_plan_states()
        finished_at = utc_now()
        self.connection.execute(
            "UPDATE runs SET status=?, finished_at=?, summary_json=? WHERE run_id=?",
            (status, finished_at, _json(dict(summary)), run_id),
        )
        if is_completed_plan:
            self._materialize_completed_plan(run_id, finished_at)
        self.connection.commit()

    def set_run_checkpoint(
        self,
        run_id: str,
        checkpoint_key: str,
        payload: Mapping[str, object],
    ) -> None:
        """Persist a resumable phase checkpoint independently of run summary."""

        if not str(checkpoint_key).strip():
            raise ValueError("checkpoint_key must not be empty")
        run = self.connection.execute(
            "SELECT status FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if run is None:
            raise KeyError(run_id)
        if str(run["status"]) != "running":
            raise RuntimeError(f"Cannot checkpoint non-running run: {run_id}")
        self.connection.execute(
            """
            INSERT INTO run_checkpoints(
                run_id, checkpoint_key, payload_json, updated_at
            ) VALUES(?, ?, ?, ?)
            ON CONFLICT(run_id, checkpoint_key) DO UPDATE SET
                payload_json=excluded.payload_json,
                updated_at=excluded.updated_at
            """,
            (run_id, str(checkpoint_key), _json(dict(payload)), utc_now()),
        )

    def get_run_checkpoint(
        self, run_id: str, checkpoint_key: str
    ) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT payload_json FROM run_checkpoints "
            "WHERE run_id=? AND checkpoint_key=?",
            (run_id, str(checkpoint_key)),
        ).fetchone()
        return json.loads(str(row[0])) if row is not None else None

    def clear_run_checkpoints(self, run_id: str) -> int:
        cursor = self.connection.execute(
            "DELETE FROM run_checkpoints WHERE run_id=?", (run_id,)
        )
        return max(0, int(cursor.rowcount))

    def cached_file(
        self,
        source_path: str | Path,
        *,
        size_bytes: int,
        mtime_ns: int,
        ctime_ns: int | None = None,
        device_id: int | None = None,
        inode: int | None = None,
    ):
        """Return a reusable fingerprint only when the source identity matches.

        ``size`` and ``mtime`` remain the portable baseline.  ``ctime`` and
        the device/inode pair catch same-size, restored-mtime replacements.
        Old catalogs contain zeroes for those new fields; a baseline match
        accepts such a row and records the current identity without forcing a
        one-time rehash of the entire remote library.  Zero inode values are
        treated as unavailable because some network filesystems do not expose
        a stable inode identity.
        """

        from .local_fingerprint import FINGERPRINT_VERSION

        row = self.connection.execute(
            "SELECT * FROM files WHERE source_path=?",
            (str(Path(source_path).resolve()),),
        ).fetchone()
        # Invalid/ambiguous files are just as expensive to decode as accepted
        # ones.  Reuse their unchanged inspection result too; a fingerprint
        # version bump or any source-identity change still forces a rescan.
        cacheable_statuses = {"ok", "invalid", "quarantine"}
        baseline_matches = (
            row is not None
            and row["scan_status"] in cacheable_statuses
            and row["size_bytes"] == size_bytes
            and row["mtime_ns"] == mtime_ns
            and int(row["fingerprint_version"]) == FINGERPRINT_VERSION
        )
        if not baseline_matches:
            return None

        assert row is not None
        stored_ctime = int(row["ctime_ns"] or 0)
        current_ctime = _sqlite_identity_int(ctime_ns)
        if stored_ctime and current_ctime and stored_ctime != current_ctime:
            return None

        stored_device = int(row["device_id"] or 0)
        stored_inode = int(row["inode"] or 0)
        current_device = _sqlite_identity_int(device_id)
        current_inode = _sqlite_identity_int(inode)
        stored_inode_identity = stored_device != 0 and stored_inode != 0
        current_inode_identity = current_device != 0 and current_inode != 0
        if (
            stored_inode_identity
            and current_inode_identity
            and (stored_device, stored_inode) != (current_device, current_inode)
        ):
            return None

        # Upgrade a legacy row lazily.  This preserves v1-v7 cache behavior on
        # the first post-migration scan while making subsequent checks stricter.
        identity_updates: dict[str, int] = {}
        if not stored_ctime and current_ctime:
            identity_updates["ctime_ns"] = current_ctime
        if not stored_inode_identity and current_inode_identity:
            identity_updates["device_id"] = current_device
            identity_updates["inode"] = current_inode
        if identity_updates:
            assignments = ",".join(f"{name}=?" for name in identity_updates)
            self.connection.execute(
                f"UPDATE files SET {assignments} WHERE file_id=?",
                (*identity_updates.values(), int(row["file_id"])),
            )
        return row

    def upsert_file(self, record: Mapping[str, object]) -> int:
        # A moved source path may later be reused by a newly uploaded batch.
        # Preserve the already archived row under a synthetic catalog identity
        # before inserting the new physical file at that path.
        existing = self.connection.execute(
            "SELECT file_id FROM files WHERE source_path=?",
            (record["source_path"],),
        ).fetchone()
        if existing is not None:
            archived = self.connection.execute(
                """
                SELECT 1 FROM plan_files
                WHERE file_id=? AND raw_transfer_state IN (
                    'moved', 'deduplicated', 'invalid_deleted',
                    'conversion_failed_deleted'
                ) LIMIT 1
                """,
                (int(existing["file_id"]),),
            ).fetchone()
            if archived is not None:
                self.connection.execute(
                    "UPDATE files SET source_path=? WHERE file_id=?",
                    (
                        f"/__literarygiant_archived_record__/{int(existing['file_id'])}",
                        int(existing["file_id"]),
                    ),
                )
        fields = (
            "source_path", "source_root", "source_label", "relative_path", "size_bytes",
            "mtime_ns", "ctime_ns", "device_id", "inode", "scan_status",
            "fingerprint_version", "scan_error", "raw_sha256", "normalized_sha256",
            "non_whitespace_chars", "line_count", "replacement_chars", "encoding",
            "encoding_confidence", "encoding_score", "encoding_margin", "sketch_json",
            "ordered_sketch_json", "sampled_chars", "source_name", "display_title", "title_key", "author",
            "aliases_json", "title_confidence", "title_evidence_json", "genre",
            "genre_confidence", "genre_tags_json", "genre_evidence_json", "inspected_at",
            "last_seen_scan_id", "source_priority", "source_kind",
        )
        identity_fields = {"ctime_ns", "device_id", "inode"}
        values = [
            _sqlite_identity_int(record.get(field, 0))
            if field in identity_fields
            else record.get(field, "")
            for field in fields
        ]
        placeholders = ",".join("?" for _ in fields)
        updates = ",".join(
            f"{field}=excluded.{field}" for field in fields if field != "source_path"
        )
        self.connection.execute(
            f"""
            INSERT INTO files({','.join(fields)}) VALUES({placeholders})
            ON CONFLICT(source_path) DO UPDATE SET {updates},
                plan_run_id='', planned_action='', work_id='', edition_id='',
                duplicate_of_file_id=NULL, duplicate_kind='', duplicate_evidence_json='{{}}',
                library_id=0, category_code='', edition_version=0,
                title_sort_key='', author_sort_key='', sort_initial='#', sort_method='',
                previous_destination='', raw_destination='', work_destination='',
                apply_status='', applied_at=NULL
            """,
            values,
        )
        row = self.connection.execute(
            "SELECT file_id FROM files WHERE source_path=?", (record["source_path"],)
        ).fetchone()
        assert row is not None
        file_id = int(row[0])
        self.connection.execute("DELETE FROM anchors WHERE file_id=?", (file_id,))
        if record.get("scan_status") == "ok":
            sketch = json.loads(str(record.get("sketch_json") or "[]"))
            self.connection.executemany(
                "INSERT OR IGNORE INTO anchors(file_id, anchor) VALUES(?, ?)",
                ((file_id, str(anchor)) for anchor in sketch),
            )
        return file_id

    def commit(self) -> None:
        self.connection.commit()

    def mark_seen(self, source_path: str | Path, run_id: str) -> None:
        cursor = self.connection.execute(
            "UPDATE files SET last_seen_scan_id=? WHERE source_path=?",
            (run_id, str(Path(source_path).resolve())),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"Cannot mark unknown catalog path as seen: {source_path}")

    def apply_quality_revalidation(
        self,
        file_id: int,
        *,
        expected_source_path: str,
        expected_raw_sha256: str,
        scan_status: str,
        scan_error: str,
        inspected_at: str,
        stat_token: Sequence[int],
        evidence: str | None = None,
    ) -> None:
        """Persist one guarded text-quality decision and maintain anchors.

        Frozen ``plan_files`` rows are intentionally untouched.  Any status
        transition invalidates the mutable planning fields so callers must
        build and audit a new final plan before applying it.
        """

        if scan_status not in {"ok", "quarantine", "unstable", "error"}:
            raise ValueError(f"unsupported quality status: {scan_status}")
        token = _destination_stat_token(stat_token)
        row = self.connection.execute(
            "SELECT * FROM files WHERE file_id=?", (int(file_id),)
        ).fetchone()
        if row is None:
            raise KeyError(file_id)
        if (
            str(row["source_path"]) != str(expected_source_path)
            or str(row["raw_sha256"]) != str(expected_raw_sha256)
        ):
            raise RuntimeError(f"quality revalidation target changed: file_id={file_id}")

        evidence_values = json.loads(str(row["title_evidence_json"] or "[]"))
        if not isinstance(evidence_values, list):
            evidence_values = []
        if evidence and evidence not in evidence_values:
            evidence_values.append(evidence)

        status_changed = str(row["scan_status"]) != scan_status
        assignments = [
            "scan_status=?",
            "scan_error=?",
            "inspected_at=?",
            "device_id=?",
            "inode=?",
            "size_bytes=?",
            "mtime_ns=?",
            "ctime_ns=?",
            "title_evidence_json=?",
        ]
        values: list[object] = [
            scan_status,
            scan_error,
            inspected_at,
            token[0],
            token[1],
            token[2],
            token[3],
            token[4],
            _json(evidence_values),
        ]
        if status_changed:
            assignments.extend(
                [
                    "plan_run_id=''",
                    "planned_action=''",
                    "work_id=''",
                    "edition_id=''",
                    "duplicate_of_file_id=NULL",
                    "duplicate_kind=''",
                    "duplicate_evidence_json='{}'",
                    "library_id=0",
                    "category_code=''",
                    "edition_version=0",
                    "title_sort_key=''",
                    "author_sort_key=''",
                    "sort_initial='#'",
                    "sort_method=''",
                    "previous_destination=''",
                    "raw_destination=''",
                    "work_destination=''",
                    "apply_status=''",
                    "applied_at=NULL",
                ]
            )
        cursor = self.connection.execute(
            f"UPDATE files SET {','.join(assignments)} WHERE file_id=?",
            (*values, int(file_id)),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"quality revalidation update failed: file_id={file_id}")

        self.connection.execute("DELETE FROM anchors WHERE file_id=?", (int(file_id),))
        if scan_status == "ok":
            sketch = json.loads(str(row["sketch_json"] or "[]"))
            self.connection.executemany(
                "INSERT OR IGNORE INTO anchors(file_id, anchor) VALUES(?, ?)",
                ((int(file_id), str(anchor)) for anchor in sketch),
            )

    def reconcile_completed_scan(self, roots: Iterable[str | Path], run_id: str) -> int:
        """Mark unarchived rows missing after an unlimited traversal.

        Rows whose originals were already moved into Noise stay active.  This
        is what lets a later batch deduplicate against the existing library.
        """

        resolved_roots = sorted({str(Path(root).expanduser().resolve()) for root in roots})
        if not resolved_roots:
            return 0
        placeholders = ",".join("?" for _ in resolved_roots)
        predicate = (
            f"source_root IN ({placeholders}) AND last_seen_scan_id<>? "
            "AND scan_status<>'missing' AND NOT EXISTS ("
            "SELECT 1 FROM plan_files pf WHERE pf.file_id=files.file_id "
            "AND pf.raw_transfer_state IN ("
            "'moved','deduplicated','invalid_deleted','conversion_failed_deleted'))"
        )
        self.connection.execute(
            f"DELETE FROM anchors WHERE file_id IN (SELECT file_id FROM files WHERE {predicate})",
            (*resolved_roots, run_id),
        )
        cursor = self.connection.execute(
            f"""
            UPDATE files SET
                scan_status='missing', scan_error='not seen in completed source scan',
                plan_run_id='', planned_action='', work_id='', edition_id='',
                duplicate_of_file_id=NULL, duplicate_kind='', duplicate_evidence_json='{{}}',
                library_id=0, category_code='', edition_version=0,
                title_sort_key='', author_sort_key='', sort_initial='#', sort_method='',
                previous_destination='', raw_destination='', work_destination='',
                apply_status='', applied_at=NULL
            WHERE {predicate}
            """,
            (*resolved_roots, run_id),
        )
        return max(0, int(cursor.rowcount))

    def iter_files(self, *, status: str | None = "ok") -> Iterator[sqlite3.Row]:
        if status is None:
            cursor = self.connection.execute("SELECT * FROM files ORDER BY file_id")
        else:
            cursor = self.connection.execute(
                "SELECT * FROM files WHERE scan_status=? ORDER BY file_id", (status,)
            )
        yield from cursor

    def get_file(self, file_id: int) -> sqlite3.Row:
        row = self.connection.execute(
            "SELECT * FROM files WHERE file_id=?", (file_id,)
        ).fetchone()
        if row is None:
            raise KeyError(file_id)
        return row

    def set_source_priority(
        self,
        file_id: int,
        *,
        priority: int,
        source_kind: str,
    ) -> None:
        """Mark a curated/processed source as preferred during dedupe selection."""

        normalized_kind = str(source_kind).strip() or "raw"
        cursor = self.connection.execute(
            "UPDATE files SET source_priority=?, source_kind=? WHERE file_id=?",
            (int(priority), normalized_kind, int(file_id)),
        )
        if cursor.rowcount != 1:
            raise KeyError(file_id)

    def get_plan_file(self, run_id: str, file_id: int) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT row_json, apply_status, raw_transfer_state, applied_at, "
            "destination_device_id, destination_inode, destination_size_bytes, "
            "destination_mtime_ns, destination_ctime_ns FROM plan_files "
            "WHERE plan_run_id=? AND file_id=?",
            (run_id, file_id),
        ).fetchone()
        if row is None:
            raise KeyError((run_id, file_id))
        payload = json.loads(str(row["row_json"]))
        payload["apply_status"] = row["apply_status"]
        payload["raw_transfer_state"] = row["raw_transfer_state"]
        payload["applied_at"] = row["applied_at"]
        for field in (
            "destination_device_id",
            "destination_inode",
            "destination_size_bytes",
            "destination_mtime_ns",
            "destination_ctime_ns",
        ):
            payload[field] = int(row[field] or 0)
        return payload

    def exact_groups(self) -> Iterator[list[int]]:
        cursor = self.connection.execute(
            """
            SELECT normalized_sha256, GROUP_CONCAT(file_id) AS ids
            FROM (
                SELECT normalized_sha256, file_id
                FROM files
                WHERE scan_status='ok' AND normalized_sha256<>''
                ORDER BY normalized_sha256, file_id
            )
            GROUP BY normalized_sha256 HAVING COUNT(*) > 1
            ORDER BY normalized_sha256
            """
        )
        for row in cursor:
            yield [int(value) for value in str(row["ids"]).split(",")]

    def build_near_candidate_table(
        self,
        *,
        max_anchor_frequency: int = 64,
        min_shared_anchors: int = 4,
        max_pair_rows: int | None = DEFAULT_MAX_NEAR_PAIR_ROWS,
    ) -> dict[str, int]:
        """Build bounded near-duplicate candidates from exact-content reps.

        Exact normalized-content copies are already handled by
        :meth:`exact_groups`; allowing every copy into the anchor join both
        repeats work and makes a useful anchor appear artificially common.
        This builder therefore selects one deterministic (lowest ``file_id``)
        representative per normalized hash before measuring anchor frequency.

        ``estimated_pair_rows`` is the number of posting-pair contributions
        the SQL aggregation would need to consume.  It is an inexpensive,
        conservative upper bound on the final candidate count.  The method
        fails before the large self-join when that estimate exceeds
        ``max_pair_rows``; callers may explicitly raise or disable the budget
        after inspecting the returned corpus statistics on a smaller run.
        """

        if max_anchor_frequency < 2:
            raise ValueError("max_anchor_frequency must be at least 2")
        if min_shared_anchors < 1:
            raise ValueError("min_shared_anchors must be at least 1")
        if max_pair_rows is not None and max_pair_rows < 1:
            raise ValueError("max_pair_rows must be positive or None")

        self._ensure_anchor_covering_index()

        # ``sqlite3.Connection.executescript`` commits any pending transaction
        # before running its script. Planning keeps mutable file rows, duplicate
        # edges and permanent-ID allocation in one transaction, so these TEMP
        # tables must be created with ordinary transactional statements.
        for statement in (
            "DROP TABLE IF EXISTS temp.near_candidates",
            "DROP TABLE IF EXISTS temp.near_usable_anchors",
            "DROP TABLE IF EXISTS temp.near_candidate_representatives",
            """
            CREATE TEMP TABLE near_candidates (
                left_file_id INTEGER NOT NULL,
                right_file_id INTEGER NOT NULL,
                shared_anchors INTEGER NOT NULL,
                PRIMARY KEY(left_file_id, right_file_id)
            ) WITHOUT ROWID
            """,
            """
            CREATE TEMP TABLE near_candidate_representatives (
                file_id INTEGER PRIMARY KEY,
                normalized_sha256 TEXT NOT NULL
            ) WITHOUT ROWID
            """,
            """
            CREATE TEMP TABLE near_usable_anchors (
                anchor TEXT PRIMARY KEY,
                representative_frequency INTEGER NOT NULL
            ) WITHOUT ROWID
            """,
        ):
            self.connection.execute(statement)

        # Non-empty normalized hashes collapse to one representative.  Empty
        # hashes cannot prove equality, so each remains independently eligible.
        self.connection.execute(
            """
            INSERT INTO near_candidate_representatives(file_id, normalized_sha256)
            SELECT MIN(file_id), normalized_sha256
            FROM files
            WHERE scan_status='ok' AND normalized_sha256<>''
            GROUP BY normalized_sha256
            """
        )
        self.connection.execute(
            """
            INSERT INTO near_candidate_representatives(file_id, normalized_sha256)
            SELECT file_id, '' FROM files
            WHERE scan_status='ok' AND normalized_sha256=''
            ORDER BY file_id
            """
        )
        self.connection.execute(
            """
            INSERT INTO near_usable_anchors(anchor, representative_frequency)
            SELECT anchors.anchor, COUNT(*)
            FROM anchors
            JOIN near_candidate_representatives representatives
              ON representatives.file_id=anchors.file_id
            GROUP BY anchors.anchor
            HAVING COUNT(*) BETWEEN 2 AND ?
            """,
            (int(max_anchor_frequency),),
        )

        budget_row = self.connection.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM near_candidate_representatives),
                COUNT(*),
                COALESCE(SUM(
                    representative_frequency * (representative_frequency - 1) / 2
                ), 0)
            FROM near_usable_anchors
            """
        ).fetchone()
        assert budget_row is not None
        stats = {
            "representative_count": int(budget_row[0]),
            "usable_anchor_count": int(budget_row[1]),
            "estimated_pair_rows": int(budget_row[2]),
        }
        if max_pair_rows is not None and stats["estimated_pair_rows"] > max_pair_rows:
            raise RuntimeError(
                "Near-candidate pair budget exceeded before materialization: "
                f"estimated_pair_rows={stats['estimated_pair_rows']:,}, "
                f"max_pair_rows={max_pair_rows:,}, "
                f"representatives={stats['representative_count']:,}, "
                f"usable_anchors={stats['usable_anchor_count']:,}. "
                "Raise max_pair_rows only after confirming SQLite temporary-space capacity."
            )

        self.connection.execute(
            """
            INSERT INTO near_candidates(left_file_id, right_file_id, shared_anchors)
            SELECT a.file_id, b.file_id, COUNT(*)
            FROM near_usable_anchors usable
            JOIN anchors a ON a.anchor=usable.anchor
            JOIN near_candidate_representatives left_rep
              ON left_rep.file_id=a.file_id
            JOIN anchors b ON b.anchor=usable.anchor AND a.file_id < b.file_id
            JOIN near_candidate_representatives right_rep
              ON right_rep.file_id=b.file_id
            WHERE left_rep.normalized_sha256=''
               OR right_rep.normalized_sha256=''
               OR left_rep.normalized_sha256<>right_rep.normalized_sha256
            GROUP BY a.file_id, b.file_id
            HAVING COUNT(*) >= ?
            ORDER BY a.file_id, b.file_id
            """,
            (int(min_shared_anchors),),
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS temp.idx_near_candidates_left ON near_candidates(left_file_id)"
        )
        stats["candidate_count"] = int(
            self.connection.execute("SELECT COUNT(*) FROM near_candidates").fetchone()[0]
        )
        return stats

    def iter_near_candidates(self) -> Iterator[tuple[int, int, int]]:
        cursor = self.connection.execute(
            "SELECT left_file_id, right_file_id, shared_anchors "
            "FROM near_candidates ORDER BY left_file_id, right_file_id"
        )
        for row in cursor:
            yield int(row[0]), int(row[1]), int(row[2])

    def iter_title_candidate_pairs(self, *, max_group: int = 64) -> Iterator[tuple[int, int]]:
        cursor = self.connection.execute(
            """
            SELECT title_key, GROUP_CONCAT(file_id) AS ids, COUNT(*) AS n
            FROM (
                SELECT title_key, file_id
                FROM files
                WHERE scan_status='ok' AND title_key<>''
                ORDER BY title_key, file_id
            )
            GROUP BY title_key HAVING COUNT(*) BETWEEN 2 AND ?
            ORDER BY title_key
            """,
            (max_group,),
        )
        for row in cursor:
            ids = [int(value) for value in str(row["ids"]).split(",")]
            for index, left in enumerate(ids):
                for right in ids[index + 1 :]:
                    yield left, right

    @staticmethod
    def _chunks(values: Sequence[object], size: int = 400) -> Iterator[Sequence[object]]:
        for start in range(0, len(values), size):
            yield values[start : start + size]

    def iter_assigned_library_groups(self) -> Iterator[list[int]]:
        """Yield active files that were previously assigned to one stable book id."""

        cursor = self.connection.execute(
            """
            SELECT mapping.library_id, GROUP_CONCAT(mapping.file_id) AS ids
            FROM library_file_ids mapping
            JOIN files ON files.file_id=mapping.file_id AND files.scan_status='ok'
            GROUP BY mapping.library_id HAVING COUNT(*) > 1
            ORDER BY mapping.library_id
            """
        )
        for row in cursor:
            yield [int(value) for value in str(row["ids"]).split(",")]

    def assign_library_id(
        self,
        file_ids: Sequence[int],
        content_keys: Sequence[str],
        *,
        reserved_library_ids: Iterable[int] = (),
    ) -> int:
        """Return one permanent, monotonically allocated id for a dedupe work.

        File and normalized-content mappings both participate.  This preserves
        the id when a source is renamed, rescanned, or joined by a later exact
        or fuzzy duplicate.  If two previously independent works are later
        merged, the older (smaller) id wins and the newer id is never reused.
        """

        unique_file_ids = sorted({int(value) for value in file_ids})
        unique_content_keys = sorted({str(value) for value in content_keys if str(value)})
        reserved_ids = {int(value) for value in reserved_library_ids}
        candidate_ids: set[int] = set()
        for chunk in self._chunks(unique_file_ids):
            placeholders = ",".join("?" for _ in chunk)
            candidate_ids.update(
                int(row[0])
                for row in self.connection.execute(
                    f"SELECT DISTINCT library_id FROM library_file_ids WHERE file_id IN ({placeholders})",
                    tuple(chunk),
                )
            )
        for chunk in self._chunks(unique_content_keys):
            placeholders = ",".join("?" for _ in chunk)
            candidate_ids.update(
                int(row[0])
                for row in self.connection.execute(
                    f"SELECT DISTINCT library_id FROM library_content_ids WHERE content_key IN ({placeholders})",
                    tuple(chunk),
                )
            )

        reusable_ids = candidate_ids - reserved_ids
        if reusable_ids:
            library_id = min(reusable_ids)
            retired_ids = sorted(reusable_ids - {library_id})
            if retired_ids:
                placeholders = ",".join("?" for _ in retired_ids)
                self.connection.execute(
                    f"UPDATE library_file_ids SET library_id=? WHERE library_id IN ({placeholders})",
                    (library_id, *retired_ids),
                )
                self.connection.execute(
                    f"UPDATE library_content_ids SET library_id=? WHERE library_id IN ({placeholders})",
                    (library_id, *retired_ids),
                )
        else:
            cursor = self.connection.execute(
                "INSERT INTO library_identities(created_at) VALUES(?)",
                (utc_now(),),
            )
            library_id = int(cursor.lastrowid)
            if library_id > 999_999:
                raise RuntimeError("The six-digit local library id space is exhausted")

        assigned_at = utc_now()
        # A later, more accurate plan can split two editions that an earlier
        # plan assigned to one ID.  In that case the first edition keeps the
        # old ID and the remaining edition receives a fresh monotonic ID.
        # UPSERT only the identities in this edition; never rewrite unrelated
        # rows still anchored to a reserved ID.
        self.connection.executemany(
            """
            INSERT INTO library_file_ids(file_id, library_id, assigned_at)
            VALUES(?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                library_id=excluded.library_id,
                assigned_at=excluded.assigned_at
            """,
            ((file_id, library_id, assigned_at) for file_id in unique_file_ids),
        )
        self.connection.executemany(
            """
            INSERT INTO library_content_ids(content_key, library_id, assigned_at)
            VALUES(?, ?, ?)
            ON CONFLICT(content_key) DO UPDATE SET
                library_id=excluded.library_id,
                assigned_at=excluded.assigned_at
            """,
            ((content_key, library_id, assigned_at) for content_key in unique_content_keys),
        )
        return library_id

    def ensure_work_versions(
        self,
        work_anchor_id: int,
        edition_library_ids: Sequence[int],
    ) -> dict[int, int]:
        """Persist stable ``v2``/``v3`` numbers for visible work editions."""

        ordered_ids = list(dict.fromkeys(int(value) for value in edition_library_ids))
        existing = {
            int(row[0]): int(row[1])
            for row in self.connection.execute(
                """
                SELECT edition_library_id, version FROM library_work_versions
                WHERE work_anchor_id=?
                """,
                (int(work_anchor_id),),
            )
        }
        next_version = max(existing.values(), default=0) + 1
        assigned_at = utc_now()
        for edition_library_id in ordered_ids:
            if edition_library_id in existing:
                continue
            self.connection.execute(
                """
                INSERT INTO library_work_versions(
                    work_anchor_id, edition_library_id, version, assigned_at
                )
                VALUES(?, ?, ?, ?)
                """,
                (int(work_anchor_id), edition_library_id, next_version, assigned_at),
            )
            existing[edition_library_id] = next_version
            next_version += 1
        return {edition_id: existing[edition_id] for edition_id in ordered_ids}

    def reserve_library_id_high_watermark(self, value: int) -> int:
        """Ensure future IDs are greater than an imported unified-index ID."""

        high_watermark = int(value)
        if high_watermark < 0 or high_watermark > 999_999:
            raise ValueError(f"Invalid six-digit library id high-water mark: {value}")
        row = self.connection.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='library_identities'"
        ).fetchone()
        current = int(row[0]) if row is not None else 0
        if high_watermark > current:
            if row is None:
                self.connection.execute(
                    "INSERT INTO sqlite_sequence(name, seq) VALUES('library_identities', ?)",
                    (high_watermark,),
                )
            else:
                self.connection.execute(
                    "UPDATE sqlite_sequence SET seq=? WHERE name='library_identities'",
                    (high_watermark,),
                )
        return max(current, high_watermark)

    def bulk_previous_completed_plan_states(
        self,
        file_ids: Iterable[int] | None = None,
    ) -> dict[int, dict[str, Any]]:
        """Return the latest completed-plan snapshot for each requested file.

        The materialized table contains one row per file, so a full planner
        preload is a linear primary-key scan and targeted batches are indexed
        point lookups.  ``apply_status`` and ``raw_transfer_state`` remain
        mutable: apply updates are mirrored into this view when this run is
        still the latest completed plan for that file.

        Pre-v9 catalogs are backfilled on the first call rather than during
        ordinary open/report/scan operations.
        """

        self._ensure_completed_plan_states()
        requested = (
            None if file_ids is None else sorted({int(value) for value in file_ids})
        )
        if requested == []:
            return {}

        result: dict[int, dict[str, Any]] = {}
        chunks: Iterable[Sequence[object]]
        if requested is None:
            chunks = ((),)
        else:
            chunks = self._chunks(requested)
        for chunk in chunks:
            predicate = ""
            parameters: tuple[object, ...] = ()
            if chunk:
                placeholders = ",".join("?" for _ in chunk)
                predicate = f"WHERE file_id IN ({placeholders})"
                parameters = tuple(chunk)
            cursor = self.connection.execute(
                f"""
                SELECT
                    file_id, plan_run_id, plan_finished_at,
                    raw_destination, work_destination, library_id, planned_action,
                    apply_status, raw_transfer_state, applied_at,
                    destination_device_id, destination_inode,
                    destination_size_bytes, destination_mtime_ns,
                    destination_ctime_ns,
                    source_path, size_bytes, mtime_ns, ctime_ns, device_id, inode,
                    fingerprint_version, raw_sha256, normalized_sha256
                FROM completed_plan_states
                {predicate}
                ORDER BY file_id
                """,
                parameters,
            )
            for row in cursor:
                file_id = int(row["file_id"])
                result[file_id] = {
                    "file_id": file_id,
                    "plan_run_id": str(row["plan_run_id"]),
                    "plan_finished_at": str(row["plan_finished_at"]),
                    "destination": str(row["raw_destination"] or ""),
                    "raw_destination": str(row["raw_destination"] or ""),
                    "work_destination": str(row["work_destination"] or ""),
                    "library_id": int(row["library_id"] or 0),
                    "planned_action": str(row["planned_action"] or ""),
                    "apply_status": str(row["apply_status"] or ""),
                    "raw_transfer_state": str(row["raw_transfer_state"] or ""),
                    "applied_at": row["applied_at"],
                    "destination_device_id": int(row["destination_device_id"] or 0),
                    "destination_inode": int(row["destination_inode"] or 0),
                    "destination_size_bytes": int(row["destination_size_bytes"] or 0),
                    "destination_mtime_ns": int(row["destination_mtime_ns"] or 0),
                    "destination_ctime_ns": int(row["destination_ctime_ns"] or 0),
                    "source_path": str(row["source_path"] or ""),
                    "size_bytes": int(row["size_bytes"] or 0),
                    "mtime_ns": int(row["mtime_ns"] or 0),
                    "ctime_ns": int(row["ctime_ns"] or 0),
                    "device_id": int(row["device_id"] or 0),
                    "inode": int(row["inode"] or 0),
                    "fingerprint_version": int(row["fingerprint_version"] or 0),
                    "raw_sha256": str(row["raw_sha256"] or ""),
                    "normalized_sha256": str(row["normalized_sha256"] or ""),
                }
        return result

    def bulk_latest_published_destinations(
        self,
        file_ids: Iterable[int] | None = None,
    ) -> dict[int, str]:
        """Return each file's latest successfully published destination.

        Supplying ``None`` performs one indexed pass for the whole catalog;
        supplying IDs keeps targeted callers below SQLite's parameter limit.
        This replaces the former N+1 pattern of running one ordered query for
        every file during a plan.
        """

        requested = (
            None if file_ids is None else sorted({int(value) for value in file_ids})
        )
        if requested == []:
            return {}

        result: dict[int, str] = {}
        chunks: Iterable[Sequence[object]]
        if requested is None:
            chunks = ((),)
        else:
            chunks = self._chunks(requested)
        for chunk in chunks:
            id_predicate = ""
            parameters: tuple[object, ...] = ()
            if chunk:
                placeholders = ",".join("?" for _ in chunk)
                id_predicate = f" AND plan_files.file_id IN ({placeholders})"
                parameters = tuple(chunk)
            cursor = self.connection.execute(
                f"""
                SELECT
                    plan_files.file_id,
                    json_extract(plan_files.row_json, '$.raw_destination') AS destination
                FROM plan_files
                JOIN runs ON runs.run_id=plan_files.plan_run_id
                WHERE plan_files.apply_status='complete'
                  AND runs.phase='plan' AND runs.status='complete'
                  AND json_extract(plan_files.row_json, '$.raw_destination') IS NOT NULL
                  AND json_extract(plan_files.row_json, '$.raw_destination')<>''
                  {id_predicate}
                ORDER BY plan_files.file_id, plan_files.applied_at DESC,
                         plan_files.plan_run_id DESC
                """,
                parameters,
            )
            previous_file_id: int | None = None
            for row in cursor:
                file_id = int(row["file_id"])
                if file_id == previous_file_id:
                    continue
                result[file_id] = str(row["destination"])
                previous_file_id = file_id
        return result

    def bulk_current_published_destinations(
        self,
        file_ids: Iterable[int] | None = None,
    ) -> dict[int, str]:
        """Read published destinations from the one-row-per-file current view.

        Unlike the historical lookup this normally needs one primary-key table
        pass, not one ordered plan-history query per SQLite parameter chunk.
        A caller that needs an older publication after a newer incomplete plan
        should fall back to :meth:`bulk_latest_published_destinations` only for
        those missing IDs.
        """

        self._ensure_completed_plan_states()
        requested = (
            None if file_ids is None else sorted({int(value) for value in file_ids})
        )
        if requested == []:
            return {}
        result: dict[int, str] = {}
        chunks: Iterable[Sequence[object]] = (
            ((),) if requested is None else self._chunks(requested)
        )
        for chunk in chunks:
            predicate = ""
            parameters: tuple[object, ...] = ()
            if chunk:
                placeholders = ",".join("?" for _ in chunk)
                predicate = f" AND file_id IN ({placeholders})"
                parameters = tuple(chunk)
            for row in self.connection.execute(
                f"""
                SELECT file_id, raw_destination
                FROM completed_plan_states
                WHERE apply_status='complete' AND raw_destination<>'' {predicate}
                ORDER BY file_id
                """,
                parameters,
            ):
                result[int(row["file_id"])] = str(row["raw_destination"])
        return result

    def latest_published_destination(self, file_id: int) -> str:
        """Return one latest destination; bulk callers should use its peer."""

        return self.bulk_latest_published_destinations((int(file_id),)).get(
            int(file_id), ""
        )

    def reset_plan(self, run_id: str) -> None:
        self.connection.execute(
            """
            UPDATE files SET
                plan_run_id=?, planned_action='', work_id='', edition_id='',
                duplicate_of_file_id=NULL, duplicate_kind='', duplicate_evidence_json='{}',
                library_id=0, category_code='', edition_version=0,
                title_sort_key='', author_sort_key='', sort_initial='#', sort_method='',
                previous_destination='', raw_destination='', work_destination='',
                apply_status='', applied_at=NULL
            WHERE scan_status='ok'
            """,
            (run_id,),
        )
        self.connection.execute("DELETE FROM duplicate_edges WHERE plan_run_id=?", (run_id,))
        self.connection.execute("DELETE FROM plan_files WHERE plan_run_id=?", (run_id,))

    def set_plan(self, file_id: int, **fields: object) -> None:
        allowed = {
            "plan_run_id", "planned_action", "work_id", "edition_id",
            "duplicate_of_file_id", "duplicate_kind", "duplicate_evidence_json",
            "raw_destination", "work_destination", "apply_status", "applied_at",
            "display_title", "title_key", "author", "aliases_json", "title_confidence",
            "title_evidence_json", "genre", "genre_confidence", "genre_tags_json",
            "genre_evidence_json", "library_id", "category_code", "edition_version",
            "title_sort_key", "author_sort_key", "sort_initial", "sort_method",
            "previous_destination",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f"Unsupported plan fields: {sorted(unknown)}")
        assignments = ",".join(f"{name}=?" for name in fields)
        self.connection.execute(
            f"UPDATE files SET {assignments} WHERE file_id=?",
            (*fields.values(), file_id),
        )

    def set_plans(
        self,
        plans: Iterable[tuple[int, Mapping[str, object]]],
    ) -> int:
        """Apply a caller-bounded batch of heterogeneous plan updates.

        Rows are grouped by their field set and written with ``executemany``.
        Callers should pass modest batches (for example 1,000 rows), allowing
        periodic checkpoints without paying one Python/SQLite round trip per
        file.
        """

        allowed = {
            "plan_run_id", "planned_action", "work_id", "edition_id",
            "duplicate_of_file_id", "duplicate_kind", "duplicate_evidence_json",
            "raw_destination", "work_destination", "apply_status", "applied_at",
            "display_title", "title_key", "author", "aliases_json", "title_confidence",
            "title_evidence_json", "genre", "genre_confidence", "genre_tags_json",
            "genre_evidence_json", "library_id", "category_code", "edition_version",
            "title_sort_key", "author_sort_key", "sort_initial", "sort_method",
            "previous_destination",
        }
        grouped: dict[tuple[str, ...], list[tuple[object, ...]]] = {}
        seen_file_ids: set[int] = set()
        for raw_file_id, raw_fields in plans:
            file_id = int(raw_file_id)
            if file_id in seen_file_ids:
                raise ValueError(f"Duplicate file_id in plan update batch: {file_id}")
            seen_file_ids.add(file_id)
            fields = dict(raw_fields)
            unknown = set(fields) - allowed
            if unknown:
                raise ValueError(f"Unsupported plan fields: {sorted(unknown)}")
            if not fields:
                raise ValueError(f"Empty plan update for file_id {file_id}")
            names = tuple(sorted(fields))
            grouped.setdefault(names, []).append(
                (*(fields[name] for name in names), file_id)
            )
        for names, values in grouped.items():
            assignments = ",".join(f"{name}=?" for name in names)
            self.connection.executemany(
                f"UPDATE files SET {assignments} WHERE file_id=?",
                values,
            )
        return len(seen_file_ids)

    def record_metadata_event(
        self,
        run_id: str,
        file_id: int,
        *,
        decision: str,
        changed_fields: Sequence[str],
        reasons: Sequence[str],
        before: Mapping[str, object],
        proposal: Mapping[str, object],
        after: Mapping[str, object],
        created_at: str | None = None,
    ) -> None:
        """Persist one immutable before/proposal/after metadata decision."""

        self.connection.execute(
            """
            INSERT INTO metadata_events(
                run_id, file_id, decision, changed_fields_json, reasons_json,
                before_json, proposal_json, after_json, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                int(file_id),
                str(decision),
                _json(list(changed_fields)),
                _json(list(reasons)),
                _json(dict(before)),
                _json(dict(proposal)),
                _json(dict(after)),
                created_at or utc_now(),
            ),
        )

    def get_llm_metadata_cache(self, input_signature: str) -> dict[str, Any] | None:
        """Return a cached LLM result and its provenance, if present."""

        row = self.connection.execute(
            """
            SELECT model, prompt_schema, file_id, result_json, decision, created_at
            FROM llm_metadata_cache WHERE input_signature=?
            """,
            (str(input_signature),),
        ).fetchone()
        if row is None:
            return None
        return {
            "input_signature": str(input_signature),
            "model": str(row["model"]),
            "prompt_schema": str(row["prompt_schema"]),
            "file_id": int(row["file_id"]),
            "result": json.loads(str(row["result_json"])),
            "decision": str(row["decision"]),
            "created_at": str(row["created_at"]),
        }

    def put_llm_metadata_cache(
        self,
        input_signature: str,
        *,
        model: str,
        prompt_schema: str,
        file_id: int,
        result: Mapping[str, object],
        decision: str,
        created_at: str | None = None,
    ) -> None:
        """Store a deterministic metadata response for reuse across runs."""

        signature = str(input_signature).strip()
        if not signature:
            raise ValueError("input_signature must not be empty")
        self.connection.execute(
            """
            INSERT INTO llm_metadata_cache(
                input_signature, model, prompt_schema, file_id,
                result_json, decision, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(input_signature) DO UPDATE SET
                model=excluded.model,
                prompt_schema=excluded.prompt_schema,
                file_id=excluded.file_id,
                result_json=excluded.result_json,
                decision=excluded.decision,
                created_at=excluded.created_at
            """,
            (
                signature,
                str(model),
                str(prompt_schema),
                int(file_id),
                _json(dict(result)),
                str(decision),
                created_at or utc_now(),
            ),
        )

    def add_duplicate_edge(
        self,
        run_id: str,
        left_file_id: int,
        right_file_id: int,
        relation: str,
        *,
        auto_merge: bool,
        evidence: Mapping[str, object],
    ) -> None:
        left, right = sorted((left_file_id, right_file_id))
        self.connection.execute(
            """
            INSERT OR REPLACE INTO duplicate_edges(
                plan_run_id, left_file_id, right_file_id, relation, auto_merge, evidence_json
            ) VALUES(?, ?, ?, ?, ?, ?)
            """,
            (run_id, left, right, relation, int(auto_merge), _json(dict(evidence))),
        )

    def freeze_plan(self, run_id: str) -> int:
        """Persist an immutable file-row snapshot for a completed plan."""

        self.connection.execute("DELETE FROM plan_files WHERE plan_run_id=?", (run_id,))
        rows = self.connection.execute(
            "SELECT * FROM files WHERE plan_run_id=? ORDER BY file_id", (run_id,)
        )
        count = 0
        batch: list[tuple[object, ...]] = []
        for row in rows:
            payload = _plan_payload(row)
            batch.append(
                (
                    run_id,
                    int(row["file_id"]),
                    _json(payload),
                    str(row["apply_status"] or ""),
                    "",
                    row["applied_at"],
                )
            )
            count += 1
            if len(batch) >= 1000:
                self.connection.executemany(
                    """
                    INSERT INTO plan_files(
                        plan_run_id, file_id, row_json, apply_status,
                        raw_transfer_state, applied_at
                    ) VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    batch,
                )
                batch.clear()
        if batch:
            self.connection.executemany(
                """
                INSERT INTO plan_files(
                    plan_run_id, file_id, row_json, apply_status,
                    raw_transfer_state, applied_at
                ) VALUES(?, ?, ?, ?, ?, ?)
                """,
                batch,
            )
        return count

    def inherit_completed_apply_states(self, run_id: str) -> int:
        """Reuse a prior successful apply only for an identical frozen item.

        This is the inexpensive half of incremental imports: scanning already
        reuses unchanged fingerprints, while this method prevents a new plan
        from retranscoding every unchanged, already-published book.  The
        predicate is intentionally strict.  Content/source identity, action,
        permanent ID and both destinations must all agree; a rename,
        reclassification, dedupe change, or source replacement therefore
        remains pending and is applied normally.
        """

        self._ensure_completed_plan_states()
        reusable_statuses = (
            "complete",
            "deleted_invalid",
            "invalid_rejected",
            "deleted_conversion_failure",
            "conversion_rejected",
        )
        placeholders = ",".join("?" for _ in reusable_statuses)
        cursor = self.connection.execute(
            f"""
            UPDATE plan_files AS current
            SET
                apply_status=previous.apply_status,
                raw_transfer_state=previous.raw_transfer_state,
                applied_at=previous.applied_at,
                destination_device_id=previous.destination_device_id,
                destination_inode=previous.destination_inode,
                destination_size_bytes=previous.destination_size_bytes,
                destination_mtime_ns=previous.destination_mtime_ns,
                destination_ctime_ns=previous.destination_ctime_ns
            FROM completed_plan_states AS previous
            WHERE current.plan_run_id=?
              AND previous.file_id=current.file_id
              AND previous.apply_status IN ({placeholders})
              AND previous.raw_transfer_state<>''
              AND previous.source_path=COALESCE(
                    json_extract(current.row_json, '$.source_path'), ''
              )
              AND previous.size_bytes=CAST(COALESCE(
                    json_extract(current.row_json, '$.size_bytes'), 0
              ) AS INTEGER)
              AND previous.mtime_ns=CAST(COALESCE(
                    json_extract(current.row_json, '$.mtime_ns'), 0
              ) AS INTEGER)
              AND (
                    previous.ctime_ns=0
                    OR previous.ctime_ns=CAST(COALESCE(
                        json_extract(current.row_json, '$.ctime_ns'), 0
                    ) AS INTEGER)
              )
              AND (
                    previous.device_id=0 OR previous.inode=0
                    OR (
                        previous.device_id=CAST(COALESCE(
                            json_extract(current.row_json, '$.device_id'), 0
                        ) AS INTEGER)
                        AND previous.inode=CAST(COALESCE(
                            json_extract(current.row_json, '$.inode'), 0
                        ) AS INTEGER)
                    )
              )
              AND (
                    previous.fingerprint_version=0
                    OR previous.fingerprint_version=CAST(COALESCE(
                        json_extract(current.row_json, '$.fingerprint_version'), 0
                    ) AS INTEGER)
              )
              AND previous.raw_sha256=COALESCE(
                    json_extract(current.row_json, '$.raw_sha256'), ''
              )
              AND previous.normalized_sha256=COALESCE(
                    json_extract(current.row_json, '$.normalized_sha256'), ''
              )
              AND previous.planned_action=COALESCE(
                    json_extract(current.row_json, '$.planned_action'), ''
              )
              AND previous.library_id=CAST(COALESCE(
                    json_extract(current.row_json, '$.library_id'), 0
              ) AS INTEGER)
              AND previous.raw_destination=COALESCE(
                    json_extract(current.row_json, '$.raw_destination'), ''
              )
              AND previous.work_destination=COALESCE(
                    json_extract(current.row_json, '$.work_destination'), ''
              )
            """,
            (str(run_id), *reusable_statuses),
        )
        inherited = max(0, int(cursor.rowcount))
        if inherited:
            self.connection.execute(
                """
                UPDATE files AS current
                SET
                    apply_status=frozen.apply_status,
                    applied_at=frozen.applied_at
                FROM plan_files AS frozen
                WHERE current.plan_run_id=?
                  AND frozen.plan_run_id=?
                  AND frozen.file_id=current.file_id
                  AND frozen.apply_status<>''
                """,
                (str(run_id), str(run_id)),
            )
        return inherited

    def require_plan(self, run_id: str) -> int:
        run = self.connection.execute(
            "SELECT phase, status FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if run is None or run["phase"] != "plan" or run["status"] != "complete":
            raise RuntimeError(f"Plan is missing or incomplete: {run_id}")
        count = int(
            self.connection.execute(
                "SELECT COUNT(*) FROM plan_files WHERE plan_run_id=?", (run_id,)
            ).fetchone()[0]
        )
        if count == 0:
            raise RuntimeError(f"Plan has no persistent file snapshot: {run_id}")
        return count

    def plan_rows(
        self,
        run_id: str,
        *,
        source_duplicates_last: bool = False,
        index_order: bool = False,
    ) -> Iterator[dict[str, Any]]:
        if source_duplicates_last and index_order:
            raise ValueError("source_duplicates_last and index_order are mutually exclusive")
        ordering = (
            "COALESCE(json_extract(row_json, '$.category_code'), '99'), "
            "COALESCE(json_extract(row_json, '$.title_sort_key'), ''), "
            "COALESCE(json_extract(row_json, '$.author_sort_key'), ''), "
            "CAST(COALESCE(json_extract(row_json, '$.library_id'), 0) AS INTEGER), "
            "CAST(COALESCE(json_extract(row_json, '$.edition_version'), 0) AS INTEGER), file_id"
            if index_order
            else
            "CASE WHEN json_extract(row_json, '$.planned_action')='source_duplicate' "
            "THEN 1 ELSE 0 END, file_id"
            if source_duplicates_last
            else "file_id"
        )
        cursor = self.connection.execute(
            f"""
            SELECT row_json, apply_status, raw_transfer_state, applied_at,
                   destination_device_id, destination_inode,
                   destination_size_bytes, destination_mtime_ns,
                   destination_ctime_ns
            FROM plan_files WHERE plan_run_id=? ORDER BY {ordering}
            """,
            (run_id,),
        )
        for row in cursor:
            payload = json.loads(str(row["row_json"]))
            payload["apply_status"] = str(row["apply_status"] or "")
            payload["raw_transfer_state"] = str(row["raw_transfer_state"] or "")
            payload["applied_at"] = row["applied_at"]
            for field in (
                "destination_device_id",
                "destination_inode",
                "destination_size_bytes",
                "destination_mtime_ns",
                "destination_ctime_ns",
            ):
                payload[field] = int(row[field] or 0)
            yield payload

    def plan_source_roots(self, run_id: str) -> set[str]:
        return {str(row["source_root"]) for row in self.plan_rows(run_id)}

    def set_plan_apply_status(
        self,
        run_id: str,
        file_id: int,
        *,
        apply_status: str,
        raw_transfer_state: str | None = None,
        applied_at: str | None,
        destination_stat_token: Sequence[int] | None = None,
    ) -> None:
        token: tuple[int | None, ...] = (
            (None, None, None, None, None)
            if destination_stat_token is None
            else _destination_stat_token(destination_stat_token)
        )
        cursor = self.connection.execute(
            """
            UPDATE plan_files SET
                apply_status=?,
                raw_transfer_state=COALESCE(?, raw_transfer_state),
                applied_at=?,
                destination_device_id=COALESCE(?, destination_device_id),
                destination_inode=COALESCE(?, destination_inode),
                destination_size_bytes=COALESCE(?, destination_size_bytes),
                destination_mtime_ns=COALESCE(?, destination_mtime_ns),
                destination_ctime_ns=COALESCE(?, destination_ctime_ns)
            WHERE plan_run_id=? AND file_id=?
            """,
            (
                apply_status,
                raw_transfer_state,
                applied_at,
                *token,
                run_id,
                file_id,
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"File {file_id} is not part of plan {run_id}")
        self.connection.execute(
            """
            UPDATE completed_plan_states SET
                apply_status=?,
                raw_transfer_state=COALESCE(?, raw_transfer_state),
                applied_at=?,
                destination_device_id=COALESCE(?, destination_device_id),
                destination_inode=COALESCE(?, destination_inode),
                destination_size_bytes=COALESCE(?, destination_size_bytes),
                destination_mtime_ns=COALESCE(?, destination_mtime_ns),
                destination_ctime_ns=COALESCE(?, destination_ctime_ns)
            WHERE file_id=? AND plan_run_id=?
            """,
            (
                apply_status,
                raw_transfer_state,
                applied_at,
                *token,
                file_id,
                run_id,
            ),
        )
        # Keep the mutable latest-plan view useful for reports, without
        # allowing a later plan to overwrite this run's persistent status.
        self.connection.execute(
            """
            UPDATE files SET apply_status=?, applied_at=?
            WHERE file_id=? AND plan_run_id=?
            """,
            (apply_status, applied_at, file_id, run_id),
        )

    def set_plan_destination_stat_token(
        self,
        run_id: str,
        file_id: int,
        destination_stat_token: Sequence[int],
    ) -> None:
        """Refresh one verified publication token without changing apply state."""

        token = _destination_stat_token(destination_stat_token)
        cursor = self.connection.execute(
            """
            UPDATE plan_files SET
                destination_device_id=?, destination_inode=?,
                destination_size_bytes=?, destination_mtime_ns=?,
                destination_ctime_ns=?
            WHERE plan_run_id=? AND file_id=?
            """,
            (*token, str(run_id), int(file_id)),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"File {file_id} is not part of plan {run_id}")
        self.connection.execute(
            """
            UPDATE completed_plan_states SET
                destination_device_id=?, destination_inode=?,
                destination_size_bytes=?, destination_mtime_ns=?,
                destination_ctime_ns=?
            WHERE file_id=? AND plan_run_id=?
            """,
            (*token, int(file_id), str(run_id)),
        )

    def latest_plan_run_id(self) -> str | None:
        row = self.connection.execute(
            """
            SELECT run_id FROM runs
            WHERE phase='plan' AND status='complete'
              AND EXISTS (
                  SELECT 1 FROM plan_files WHERE plan_run_id=runs.run_id
              )
            ORDER BY finished_at DESC, run_id DESC LIMIT 1
            """
        ).fetchone()
        return str(row[0]) if row else None

    def stats(self) -> dict[str, object]:
        by_status = {
            str(row[0]): int(row[1])
            for row in self.connection.execute(
                "SELECT scan_status, COUNT(*) FROM files GROUP BY scan_status"
            )
        }
        totals = self.connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM files"
        ).fetchone()
        genres = {
            str(row[0]): int(row[1])
            for row in self.connection.execute(
                "SELECT genre, COUNT(*) FROM files WHERE scan_status='ok' GROUP BY genre"
            )
        }
        actions = {
            str(row[0]): int(row[1])
            for row in self.connection.execute(
                "SELECT planned_action, COUNT(*) FROM files WHERE planned_action<>'' GROUP BY planned_action"
            )
        }
        return {
            "files": int(totals[0]),
            "size_bytes": int(totals[1]),
            "scan_status": by_status,
            "genres": genres,
            "planned_actions": actions,
        }
