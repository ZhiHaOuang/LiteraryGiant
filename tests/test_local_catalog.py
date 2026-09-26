from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fetcher.local_catalog import LocalNovelCatalog, SCHEMA_VERSION
from fetcher.local_resources import available_cpu_count
from fetcher.local_fingerprint import FINGERPRINT_VERSION


def _record(
    path: Path,
    *,
    normalized_sha256: str,
    title_key: str = "",
    anchors: tuple[str, ...] = (),
    ctime_ns: int = 30,
    device_id: int = 40,
    inode: int = 50,
) -> dict[str, object]:
    return {
        "source_path": str(path.resolve()),
        "source_root": str(path.parent.resolve()),
        "source_label": path.parent.name,
        "relative_path": path.name,
        "size_bytes": 10,
        "mtime_ns": 20,
        "ctime_ns": ctime_ns,
        "device_id": device_id,
        "inode": inode,
        "scan_status": "ok",
        "fingerprint_version": FINGERPRINT_VERSION,
        "raw_sha256": f"raw-{path.name}",
        "normalized_sha256": normalized_sha256,
        "non_whitespace_chars": 10,
        "line_count": 1,
        "encoding": "utf-8",
        "encoding_confidence": "high",
        "sketch_json": json.dumps(list(anchors)),
        "ordered_sketch_json": json.dumps(list(anchors)),
        "source_name": path.name,
        "display_title": path.stem,
        "title_key": title_key,
        "inspected_at": "2026-01-01T00:00:00+00:00",
    }


class LocalCatalogOptimizationTests(unittest.TestCase):
    def test_reserved_library_id_splits_a_previously_conflated_edition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                first = catalog.upsert_file(
                    _record(base / "one.txt", normalized_sha256="content-one")
                )
                second = catalog.upsert_file(
                    _record(base / "two.txt", normalized_sha256="content-two")
                )
                old_id = catalog.assign_library_id(
                    [first, second], ["content-one", "content-two"]
                )
                self.assertEqual(
                    catalog.assign_library_id([first], ["content-one"]), old_id
                )
                new_id = catalog.assign_library_id(
                    [second],
                    ["content-two"],
                    reserved_library_ids={old_id},
                )
                self.assertGreater(new_id, old_id)
                by_file = {
                    int(row[0]): int(row[1])
                    for row in catalog.connection.execute(
                        "SELECT file_id, library_id FROM library_file_ids"
                    )
                }
                self.assertEqual(by_file, {first: old_id, second: new_id})
                by_content = {
                    str(row[0]): int(row[1])
                    for row in catalog.connection.execute(
                        "SELECT content_key, library_id FROM library_content_ids"
                    )
                }
                self.assertEqual(
                    by_content,
                    {"content-one": old_id, "content-two": new_id},
                )

    def test_catalog_uses_detected_sqlite_sort_workers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with LocalNovelCatalog(Path(temporary) / "catalog.sqlite3") as catalog:
                configured = int(catalog.connection.execute("PRAGMA threads").fetchone()[0])
                self.assertEqual(configured, min(8, available_cpu_count()))

    def test_cache_identity_detects_same_size_restored_mtime_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "book.txt"
            source.write_text("contents", encoding="utf-8")
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                catalog.upsert_file(_record(source, normalized_sha256="hash-a"))
                self.assertIsNotNone(
                    catalog.cached_file(
                        source,
                        size_bytes=10,
                        mtime_ns=20,
                        ctime_ns=30,
                        device_id=40,
                        inode=50,
                    )
                )
                self.assertIsNone(
                    catalog.cached_file(
                        source,
                        size_bytes=10,
                        mtime_ns=20,
                        ctime_ns=31,
                        device_id=40,
                        inode=50,
                    )
                )
                self.assertIsNone(
                    catalog.cached_file(
                        source,
                        size_bytes=10,
                        mtime_ns=20,
                        ctime_ns=30,
                        device_id=40,
                        inode=51,
                    )
                )

    def test_legacy_zero_identity_is_lazily_upgraded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "legacy.txt"
            source.write_text("contents", encoding="utf-8")
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                catalog.upsert_file(
                    _record(
                        source,
                        normalized_sha256="hash-a",
                        ctime_ns=0,
                        device_id=0,
                        inode=0,
                    )
                )
                self.assertIsNotNone(
                    catalog.cached_file(
                        source,
                        size_bytes=10,
                        mtime_ns=20,
                        ctime_ns=30,
                        device_id=40,
                        inode=50,
                    )
                )
                upgraded = catalog.get_file(1)
                self.assertEqual(int(upgraded["ctime_ns"]), 30)
                self.assertEqual(
                    (int(upgraded["device_id"]), int(upgraded["inode"])),
                    (40, 50),
                )

    def test_unsigned_network_inode_is_storable_and_comparable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "network.txt"
            source.write_text("contents", encoding="utf-8")
            large_inode = (1 << 63) + 123
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                catalog.upsert_file(
                    _record(
                        source,
                        normalized_sha256="hash-a",
                        inode=large_inode,
                    )
                )
                self.assertIsNotNone(
                    catalog.cached_file(
                        source,
                        size_bytes=10,
                        mtime_ns=20,
                        ctime_ns=30,
                        device_id=40,
                        inode=large_inode,
                    )
                )

    def test_near_candidates_fold_exact_copies_before_frequency_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            anchors = ("a", "b", "c", "d")
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                duplicate_ids = [
                    catalog.upsert_file(
                        _record(
                            base / f"duplicate-{index}.txt",
                            normalized_sha256="same-content",
                            anchors=anchors,
                            inode=100 + index,
                        )
                    )
                    for index in range(4)
                ]
                distinct_id = catalog.upsert_file(
                    _record(
                        base / "distinct.txt",
                        normalized_sha256="distinct-content",
                        anchors=anchors,
                        inode=200,
                    )
                )
                stats = catalog.build_near_candidate_table(
                    max_anchor_frequency=2,
                    min_shared_anchors=4,
                    max_pair_rows=10,
                )
                self.assertEqual(stats["representative_count"], 2)
                self.assertEqual(stats["usable_anchor_count"], 4)
                self.assertEqual(stats["estimated_pair_rows"], 4)
                self.assertEqual(stats["candidate_count"], 1)
                self.assertEqual(
                    list(catalog.iter_near_candidates()),
                    [(min(duplicate_ids), distinct_id, 4)],
                )

    def test_near_candidate_budget_fails_before_pair_materialization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            anchors = ("a", "b", "c", "d")
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                for index in range(4):
                    catalog.upsert_file(
                        _record(
                            base / f"book-{index}.txt",
                            normalized_sha256=f"hash-{index}",
                            anchors=anchors,
                            inode=100 + index,
                        )
                    )
                with self.assertRaisesRegex(RuntimeError, "estimated_pair_rows=24"):
                    catalog.build_near_candidate_table(
                        max_anchor_frequency=4,
                        min_shared_anchors=4,
                        max_pair_rows=20,
                    )
                self.assertEqual(list(catalog.iter_near_candidates()), [])

    def test_title_candidates_have_deterministic_title_and_file_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                ids = {}
                for name, title in (("z1", "z"), ("a1", "a"), ("z2", "z"), ("a2", "a")):
                    ids[name] = catalog.upsert_file(
                        _record(
                            base / f"{name}.txt",
                            normalized_sha256=f"hash-{name}",
                            title_key=title,
                            inode=100 + len(ids),
                        )
                    )
                self.assertEqual(
                    list(catalog.iter_title_candidate_pairs()),
                    [(ids["a1"], ids["a2"]), (ids["z1"], ids["z2"])],
                )

    def test_bulk_latest_destinations_and_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                first = catalog.upsert_file(
                    _record(base / "one.txt", normalized_sha256="one")
                )
                second = catalog.upsert_file(
                    _record(base / "two.txt", normalized_sha256="two", inode=51)
                )
                rows = [
                    ("old", first, "/old.txt", "2026-01-01T00:00:00+00:00"),
                    ("new", first, "/new.txt", "2026-02-01T00:00:00+00:00"),
                    ("only", second, "/second.txt", "2026-01-15T00:00:00+00:00"),
                ]
                catalog.connection.executemany(
                    """
                    INSERT INTO runs(
                        run_id, phase, status, options_json, started_at, finished_at
                    ) VALUES(?, 'plan', 'complete', '{}', ?, ?)
                    """,
                    ((run, applied, applied) for run, _, _, applied in rows),
                )
                catalog.connection.executemany(
                    """
                    INSERT INTO plan_files(
                        plan_run_id, file_id, row_json, apply_status,
                        raw_transfer_state, applied_at
                    ) VALUES(?, ?, ?, 'complete', 'moved', ?)
                    """,
                    (
                        (run, file_id, json.dumps({"raw_destination": destination}), applied)
                        for run, file_id, destination, applied in rows
                    ),
                )
                self.assertEqual(
                    catalog.bulk_latest_published_destinations(),
                    {first: "/new.txt", second: "/second.txt"},
                )
                self.assertEqual(catalog.latest_published_destination(first), "/new.txt")
                indexes = {
                    str(row[1])
                    for row in catalog.connection.execute("PRAGMA index_list(plan_files)")
                }
                self.assertIn("idx_plan_files_file_apply_latest", indexes)
                self.assertIn("idx_plan_files_file_transfer", indexes)

    def test_checkpoint_and_llm_cache_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                file_id = catalog.upsert_file(
                    _record(base / "one.txt", normalized_sha256="one")
                )
                catalog.start_run("plan-checkpoint", "plan", {})
                catalog.set_run_checkpoint(
                    "plan-checkpoint", "dedupe", {"last_file_id": file_id}
                )
                self.assertEqual(
                    catalog.get_run_checkpoint("plan-checkpoint", "dedupe"),
                    {"last_file_id": file_id},
                )
                catalog.put_llm_metadata_cache(
                    "signature",
                    model="qwen-14b",
                    prompt_schema="metadata-v1",
                    file_id=file_id,
                    result={"title": "正常书名"},
                    decision="accepted",
                    created_at="2026-01-01T00:00:00+00:00",
                )
                cached = catalog.get_llm_metadata_cache("signature")
                assert cached is not None
                self.assertEqual(cached["result"], {"title": "正常书名"})
                self.assertEqual(cached["decision"], "accepted")

    def test_completed_plan_state_is_materialized_synced_and_bulk_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                first_path = base / "one.txt"
                second_path = base / "two.txt"
                first = catalog.upsert_file(
                    _record(first_path, normalized_sha256="normalized-one", inode=501)
                )
                second = catalog.upsert_file(
                    _record(second_path, normalized_sha256="normalized-two", inode=502)
                )

                catalog.start_run("plan-one", "plan", {})
                catalog.set_plan(
                    first,
                    plan_run_id="plan-one",
                    planned_action="canonical",
                    raw_destination="/library/old-one.txt",
                    work_destination="/work/old-one.txt",
                    library_id=11,
                )
                catalog.set_plan(
                    second,
                    plan_run_id="plan-one",
                    planned_action="canonical",
                    raw_destination="/library/two.txt",
                    work_destination="/work/two.txt",
                    library_id=12,
                )
                self.assertEqual(catalog.freeze_plan("plan-one"), 2)
                catalog.finish_run("plan-one", "complete", {})
                catalog.set_plan_apply_status(
                    "plan-one",
                    first,
                    apply_status="complete",
                    raw_transfer_state="moved",
                    applied_at="2026-01-02T00:00:00+00:00",
                    destination_stat_token=(41, 42, 43, 44, 45),
                )

                first_state = catalog.bulk_previous_completed_plan_states((first,))[first]
                self.assertEqual(first_state["plan_run_id"], "plan-one")
                self.assertEqual(first_state["destination"], "/library/old-one.txt")
                self.assertEqual(first_state["library_id"], 11)
                self.assertEqual(first_state["apply_status"], "complete")
                self.assertEqual(first_state["raw_transfer_state"], "moved")
                self.assertEqual(first_state["destination_device_id"], 41)
                self.assertEqual(first_state["destination_inode"], 42)
                self.assertEqual(first_state["destination_size_bytes"], 43)
                self.assertEqual(first_state["destination_mtime_ns"], 44)
                self.assertEqual(first_state["destination_ctime_ns"], 45)
                self.assertEqual(first_state["source_path"], str(first_path.resolve()))
                self.assertEqual(first_state["size_bytes"], 10)
                self.assertEqual(first_state["mtime_ns"], 20)
                self.assertEqual(first_state["ctime_ns"], 30)
                self.assertEqual(first_state["device_id"], 40)
                self.assertEqual(first_state["inode"], 501)
                self.assertEqual(first_state["fingerprint_version"], FINGERPRINT_VERSION)
                self.assertEqual(first_state["raw_sha256"], "raw-one.txt")
                self.assertEqual(first_state["normalized_sha256"], "normalized-one")

                # A newer completed subset replaces only files it contains.
                catalog.start_run("plan-two", "plan", {})
                catalog.set_plan(
                    first,
                    plan_run_id="plan-two",
                    planned_action="canonical",
                    raw_destination="/library/new-one.txt",
                    work_destination="/work/new-one.txt",
                    library_id=11,
                    apply_status="",
                    applied_at=None,
                )
                self.assertEqual(catalog.freeze_plan("plan-two"), 1)
                catalog.finish_run("plan-two", "complete", {})
                states = catalog.bulk_previous_completed_plan_states()
                self.assertEqual(states[first]["plan_run_id"], "plan-two")
                self.assertEqual(states[first]["destination"], "/library/new-one.txt")
                self.assertEqual(states[first]["apply_status"], "")
                self.assertEqual(states[second]["plan_run_id"], "plan-one")
                self.assertNotIn(
                    first,
                    catalog.bulk_current_published_destinations((first,)),
                )
                self.assertEqual(
                    catalog.bulk_latest_published_destinations((first,))[first],
                    "/library/old-one.txt",
                )

                catalog.start_run("plan-failed", "plan", {})
                catalog.set_plan(
                    first,
                    plan_run_id="plan-failed",
                    planned_action="canonical",
                    raw_destination="/library/must-not-win.txt",
                    library_id=999,
                    apply_status="",
                    applied_at=None,
                )
                self.assertEqual(catalog.freeze_plan("plan-failed"), 1)
                catalog.finish_run("plan-failed", "failed", {})
                after_failure = catalog.bulk_previous_completed_plan_states((first,))
                self.assertEqual(after_failure[first]["plan_run_id"], "plan-two")

                query_plan = " ".join(
                    str(row[3])
                    for row in catalog.connection.execute(
                        "EXPLAIN QUERY PLAN SELECT * FROM completed_plan_states "
                        "WHERE file_id IN (?, ?)",
                        (first, second),
                    )
                )
                self.assertIn("INTEGER PRIMARY KEY", query_plan)

                # Simulate a v1-v8 catalog: history exists but the v9 current
                # view and completion marker do not.  First bulk read repairs it.
                catalog.connection.execute("DELETE FROM completed_plan_states")
                catalog.connection.execute(
                    "DELETE FROM catalog_meta WHERE key='completed_plan_states_ready_v1'"
                )
                rebuilt = catalog.bulk_previous_completed_plan_states((first, second))
                self.assertEqual(rebuilt[first]["plan_run_id"], "plan-two")
                self.assertEqual(rebuilt[second]["plan_run_id"], "plan-one")

    def test_identical_incremental_plan_inherits_apply_but_changed_path_does_not(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                file_id = catalog.upsert_file(
                    _record(base / "one.txt", normalized_sha256="normalized-one")
                )

                def freeze(run_id: str, destination: str) -> None:
                    catalog.start_run(run_id, "plan", {})
                    catalog.set_plan(
                        file_id,
                        plan_run_id=run_id,
                        planned_action="canonical",
                        raw_destination=destination,
                        work_destination=destination,
                        library_id=17,
                        apply_status="",
                        applied_at=None,
                    )
                    self.assertEqual(catalog.freeze_plan(run_id), 1)

                freeze("plan-original", "玄幻/00_id000017_书名_佚名.txt")
                catalog.finish_run("plan-original", "complete", {})
                catalog.set_plan_apply_status(
                    "plan-original",
                    file_id,
                    apply_status="complete",
                    raw_transfer_state="converted",
                    applied_at="2026-01-02T00:00:00+00:00",
                    destination_stat_token=(51, 52, 53, 54, 55),
                )
                # v1-v8 snapshots may not contain the stronger identity
                # columns. Exact hashes plus size/mtime still permit reuse.
                catalog.connection.execute(
                    """
                    UPDATE completed_plan_states SET
                        ctime_ns=0, device_id=0, inode=0, fingerprint_version=0
                    WHERE file_id=?
                    """,
                    (file_id,),
                )

                freeze("plan-identical", "玄幻/00_id000017_书名_佚名.txt")
                self.assertEqual(catalog.inherit_completed_apply_states("plan-identical"), 1)
                inherited = catalog.get_plan_file("plan-identical", file_id)
                self.assertEqual(inherited["apply_status"], "complete")
                self.assertEqual(inherited["raw_transfer_state"], "converted")
                self.assertEqual(
                    (
                        inherited["destination_device_id"],
                        inherited["destination_inode"],
                        inherited["destination_size_bytes"],
                        inherited["destination_mtime_ns"],
                        inherited["destination_ctime_ns"],
                    ),
                    (51, 52, 53, 54, 55),
                )
                self.assertEqual(catalog.get_file(file_id)["apply_status"], "complete")
                catalog.finish_run("plan-identical", "complete", {})

                freeze("plan-renamed", "玄幻/00_id000017_新书名_佚名.txt")
                self.assertEqual(catalog.inherit_completed_apply_states("plan-renamed"), 0)
                pending = catalog.get_plan_file("plan-renamed", file_id)
                self.assertEqual(pending["apply_status"], "")
                self.assertEqual(pending["raw_transfer_state"], "")

    def test_schema_version_and_v7_reopen_migration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "catalog.sqlite3"
            with LocalNovelCatalog(path):
                pass
            connection = sqlite3.connect(path)
            connection.execute("ALTER TABLE files DROP COLUMN ctime_ns")
            connection.execute("ALTER TABLE files DROP COLUMN device_id")
            connection.execute("ALTER TABLE files DROP COLUMN inode")
            for table in ("plan_files", "completed_plan_states"):
                for column in (
                    "destination_device_id",
                    "destination_inode",
                    "destination_size_bytes",
                    "destination_mtime_ns",
                    "destination_ctime_ns",
                ):
                    connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
            connection.execute("DROP INDEX idx_anchors_anchor_file")
            connection.execute("CREATE INDEX idx_anchors_anchor ON anchors(anchor)")
            connection.execute(
                "UPDATE catalog_meta SET value='7' WHERE key='schema_version'"
            )
            connection.execute(
                "DELETE FROM catalog_meta WHERE key='completed_plan_states_ready_v1'"
            )
            connection.commit()
            connection.close()
            with LocalNovelCatalog(path) as catalog:
                version = catalog.connection.execute(
                    "SELECT value FROM catalog_meta WHERE key='schema_version'"
                ).fetchone()[0]
                self.assertEqual(int(version), SCHEMA_VERSION)
                columns = {
                    str(row[1])
                    for row in catalog.connection.execute("PRAGMA table_info(files)")
                }
                self.assertTrue({"ctime_ns", "device_id", "inode"} <= columns)
                for table in ("plan_files", "completed_plan_states"):
                    token_columns = {
                        str(row[1])
                        for row in catalog.connection.execute(
                            f"PRAGMA table_info({table})"
                        )
                    }
                    self.assertTrue(
                        {
                            "destination_device_id",
                            "destination_inode",
                            "destination_size_bytes",
                            "destination_mtime_ns",
                            "destination_ctime_ns",
                        }
                        <= token_columns
                    )
                indexes = {
                    str(row[1])
                    for row in catalog.connection.execute("PRAGMA index_list(anchors)")
                }
                self.assertIn("idx_anchors_anchor", indexes)
                self.assertNotIn("idx_anchors_anchor_file", indexes)
                catalog.build_near_candidate_table(max_pair_rows=1)
                migrated_indexes = {
                    str(row[1])
                    for row in catalog.connection.execute("PRAGMA index_list(anchors)")
                }
                self.assertIn("idx_anchors_anchor_file", migrated_indexes)
                self.assertNotIn("idx_anchors_anchor", migrated_indexes)


if __name__ == "__main__":
    unittest.main()
