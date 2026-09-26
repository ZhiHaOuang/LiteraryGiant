from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import fetcher.local_archive as local_archive_module
from fetcher.local_archive import (
    SourceEntry,
    apply_plan,
    inspect_source_entry,
    plan_catalog,
    scan_sources,
    snapshot_sources,
    verify_plan,
)
from fetcher.local_catalog import LocalNovelCatalog
from scripts.organize_local_novels import build_parser, main as organize_main


def _novel(prefix: str, count: int = 80) -> str:
    return "\n\n".join(
        f"第{index}章 {prefix}人物追查线索{index}，并记录这一段独有的情节{index}。"
        f"众人在天亮前完成任务{index}，随后前往下一处地点。"
        for index in range(1, count + 1)
    ) + "\n"


def _scan_books(
    catalog: LocalNovelCatalog,
    archive: Path,
    source: Path,
    prefixes: list[str],
) -> None:
    source.mkdir(parents=True)
    for index, prefix in enumerate(prefixes, start=1):
        (source / f"书籍{index}-{prefix}.txt").write_text(
            _novel(prefix),
            encoding="utf-8",
        )
    summary = scan_sources(
        catalog,
        [source],
        archive_root=archive,
        workers=1,
        stable_age_seconds=0,
        run_id="scan-resume-tests",
    )
    if summary["statuses"].get("ok") != len(prefixes):
        raise AssertionError(summary)


class LocalPlanPersistenceTests(unittest.TestCase):
    def test_scan_detects_ctime_only_change_during_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            path = source / "扫描身份.txt"
            path.write_text(_novel("扫描身份"), encoding="utf-8")
            entry = SourceEntry(
                path=path,
                root=source,
                label=source.name,
                relative_path=Path(path.name),
            )
            real_fingerprint = local_archive_module.fingerprint_file

            def fingerprint_then_change_ctime(value: Path) -> object:
                fingerprint = real_fingerprint(value)
                value.chmod(value.stat().st_mode ^ 0o100)
                return fingerprint

            with patch.object(
                local_archive_module,
                "fingerprint_file",
                side_effect=fingerprint_then_change_ctime,
            ):
                record = inspect_source_entry(entry)
            self.assertEqual(record["scan_status"], "unstable")
            self.assertIn("changed while scanning", str(record["scan_error"]))

    def test_incremental_apply_uses_stat_tokens_and_revalidates_on_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["低成本增量"])
                plan_catalog(catalog, archive, run_id="plan-token-original")
                first = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-token-original",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(first["status"], "complete")
                original = next(catalog.plan_rows("plan-token-original"))
                self.assertNotEqual(original["destination_inode"], 0)

                plan_catalog(catalog, archive, run_id="plan-token-inherited")
                inherited = next(catalog.plan_rows("plan-token-inherited"))
                self.assertEqual(inherited["raw_transfer_state"], "converted")
                self.assertEqual(
                    inherited["destination_inode"], original["destination_inode"]
                )

                # Identical inherited source and destination stat tokens need
                # lstat only: neither complete-file verifier is entered.
                with (
                    patch.object(
                        local_archive_module,
                        "_verify_utf8_no_bom",
                        side_effect=AssertionError("destination body was read"),
                    ),
                    patch.object(
                        local_archive_module,
                        "_regular_file_identity_unchanged",
                        side_effect=AssertionError("source body was read"),
                    ),
                ):
                    skipped = apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-token-inherited",
                        transfer_mode="copy",
                        confirm_transfer_complete=True,
                    )
                self.assertEqual(skipped["already_satisfied"], 1)
                self.assertEqual(skipped["processed"], 0)

                destination = archive / str(inherited["raw_destination"])
                destination_stat = destination.stat()
                os.utime(
                    destination,
                    ns=(
                        destination_stat.st_atime_ns,
                        destination_stat.st_mtime_ns + 1_000_000_000,
                    ),
                )
                real_verify = local_archive_module._verify_utf8_no_bom
                with patch.object(
                    local_archive_module,
                    "_verify_utf8_no_bom",
                    wraps=real_verify,
                ) as verify_mock:
                    refreshed = apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-token-inherited",
                        transfer_mode="copy",
                        confirm_transfer_complete=True,
                    )
                self.assertEqual(refreshed["processed"], 0)
                self.assertEqual(verify_mock.call_count, 1)
                refreshed_row = next(catalog.plan_rows("plan-token-inherited"))
                self.assertEqual(
                    refreshed_row["destination_mtime_ns"],
                    destination.stat().st_mtime_ns,
                )

                # A changed source token is not trusted even when its bytes are
                # unchanged: hash once, then retain the file in copy mode.
                source_path = Path(str(refreshed_row["source_path"]))
                source_stat = source_path.stat()
                os.utime(
                    source_path,
                    ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000_000),
                )
                real_source_verify = local_archive_module._regular_file_identity_unchanged
                with patch.object(
                    local_archive_module,
                    "_regular_file_identity_unchanged",
                    wraps=real_source_verify,
                ) as source_verify_mock:
                    changed_source = apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-token-inherited",
                        transfer_mode="copy",
                        confirm_transfer_complete=True,
                    )
                self.assertEqual(changed_source["processed"], 0)
                self.assertEqual(source_verify_mock.call_count, 1)

    def test_first_ids_follow_pinyin_but_incremental_ids_only_append(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            wave = source / "波浪-甲.txt"
            wave.write_text(_novel("波浪"), encoding="utf-8")
            ending = source / "张三传-丙.txt"
            ending.write_text(_novel("张三"), encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-pinyin-first",
                )
                plan_catalog(catalog, archive, run_id="plan-pinyin-first")
                first_rows = list(catalog.plan_rows("plan-pinyin-first"))
                first_by_title = {row["display_title"]: row for row in first_rows}
                self.assertEqual(first_by_title["波浪"]["library_id"], 1)
                self.assertEqual(first_by_title["张三传"]["library_id"], 2)
                apply_plan(
                    catalog, archive, plan_run_id="plan-pinyin-first",
                    transfer_mode="copy", confirm_transfer_complete=True,
                )

                earlier = source / "阿城-乙.txt"
                earlier.write_text(_novel("阿城"), encoding="utf-8")
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-pinyin-incremental",
                )
                plan_catalog(catalog, archive, run_id="plan-pinyin-incremental")
                rows = list(catalog.plan_rows("plan-pinyin-incremental"))
                by_title = {row["display_title"]: row for row in rows}
                self.assertEqual(by_title["波浪"]["library_id"], 1)
                self.assertEqual(by_title["张三传"]["library_id"], 2)
                self.assertEqual(by_title["阿城"]["library_id"], 3)
                apply_plan(
                    catalog, archive, plan_run_id="plan-pinyin-incremental",
                    transfer_mode="copy", confirm_transfer_complete=True,
                )
                index_rows = [
                    json.loads(line)
                    for line in (archive / "index.jsonl").read_text(encoding="utf-8").splitlines()
                ]
                self.assertEqual([row["title"] for row in index_rows], ["阿城", "波浪", "张三传"])
                self.assertEqual([row["library_id"] for row in index_rows], [3, 1, 2])
                self.assertTrue(all(row["category_code"] == "20" for row in index_rows))
                self.assertTrue(all(row["content_id"].startswith("id") for row in index_rows))
                self.assertTrue(all(row["edition_key"].startswith("ed_") for row in index_rows))

    def test_unified_index_seeds_library_id_high_watermark(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            archive.mkdir(parents=True)
            (archive / "index.jsonl").write_text(
                json.dumps(
                    {
                        "schema": "literary-giant-flat-index-v3",
                        "library_id": 123,
                        "book_id": "id000123",
                        "file": "20_id000123_旧书_佚名.txt",
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            (source / "新书-甲.txt").write_text(_novel("新书"), encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-seeded-id",
                )
                summary = plan_catalog(catalog, archive, run_id="plan-seeded-id")
                row = next(catalog.plan_rows("plan-seeded-id"))
                self.assertEqual(summary["library_id_high_watermark"], 123)
                self.assertEqual(row["library_id"], 124)

    def test_replan_migrates_published_file_when_title_or_category_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            incoming = source / "旧名-甲.txt"
            incoming.write_text(_novel("迁移"), encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                snapshot = snapshot_sources([source])
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-path-migration",
                )
                plan_catalog(catalog, archive, run_id="plan-path-before")
                before = next(catalog.plan_rows("plan-path-before"))
                apply_plan(
                    catalog, archive, plan_run_id="plan-path-before",
                    transfer_mode="move", confirm_transfer_complete=True,
                    stability_snapshot=snapshot,
                )
                old_path = archive / before["raw_destination"]
                self.assertTrue(old_path.is_file())

                catalog.set_plan(
                    int(before["file_id"]),
                    display_title="新名",
                    title_key="新名",
                    genre="科幻",
                )
                catalog.commit()
                plan_catalog(catalog, archive, run_id="plan-path-after")
                after = next(catalog.plan_rows("plan-path-after"))
                self.assertEqual(after["library_id"], before["library_id"])
                self.assertEqual(after["category_code"], "12")
                self.assertEqual(after["previous_destination"], before["raw_destination"])
                self.assertNotEqual(after["raw_destination"], before["raw_destination"])

                copied = apply_plan(
                    catalog, archive, plan_run_id="plan-path-after",
                    transfer_mode="copy", confirm_transfer_complete=True,
                )
                self.assertEqual(copied["failed"], 0)
                self.assertEqual(copied["migrated_existing"], 1)
                self.assertTrue(old_path.exists())
                self.assertTrue((archive / after["raw_destination"]).is_file())

                migrated = apply_plan(
                    catalog, archive, plan_run_id="plan-path-after",
                    transfer_mode="move", confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]),
                )
                self.assertEqual(migrated["failed"], 0)
                self.assertEqual(migrated["migrated_existing"], 1)
                self.assertFalse(old_path.exists())
                self.assertTrue((archive / after["raw_destination"]).is_file())
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-path-after")["errors"],
                    0,
                )

    def test_moved_library_survives_incremental_rescan_and_reused_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            incoming = source / "重复使用的文件名.txt"
            incoming.write_text(_novel("旧书"), encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                first_snapshot = snapshot_sources([source])
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-incremental-old",
                )
                plan_catalog(catalog, archive, run_id="plan-incremental-old")
                apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-incremental-old",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=first_snapshot,
                )
                self.assertFalse(incoming.exists())

                empty = scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-incremental-empty",
                )
                self.assertEqual(empty["missing_marked"], 0)
                self.assertEqual(empty["catalog"]["scan_status"]["ok"], 1)

                incoming.write_text(_novel("新书"), encoding="utf-8")
                added = scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-incremental-new",
                )
                self.assertEqual(added["submitted"], 1)
                self.assertEqual(added["catalog"]["scan_status"]["ok"], 2)
                planned = plan_catalog(catalog, archive, run_id="plan-incremental-new")
                self.assertEqual(planned["works"], 2)
                second_snapshot = snapshot_sources([source])
                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-incremental-new",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=second_snapshot,
                )
                self.assertEqual(applied["remaining"], 0)
                self.assertFalse(incoming.exists())
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-incremental-new")["errors"],
                    0,
                )
                self.assertEqual(len((archive / "index.jsonl").read_text(encoding="utf-8").splitlines()), 2)

    def test_walk_failure_never_reconciles_an_existing_row_as_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["保留"])
                file_id = int(next(catalog.iter_files())["file_id"])

                def failing_walk(*_args, onerror=None, **_kwargs):
                    assert onerror is not None
                    onerror(PermissionError("simulated unreadable subtree"))
                    return iter(())

                with (
                    patch("fetcher.local_archive.os.walk", new=failing_walk),
                    self.assertRaises(PermissionError),
                ):
                    scan_sources(
                        catalog,
                        [source],
                        archive_root=archive,
                        workers=1,
                        stable_age_seconds=0,
                        run_id="scan-walk-failure",
                    )

                self.assertEqual(catalog.get_file(file_id)["scan_status"], "ok")

    def test_completed_rescan_marks_disappeared_unstable_rows_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            vanished = source / "传输中的文件.txt"
            vanished.write_text(_novel("未完成"), encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                first = scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=3600,
                    run_id="scan-before-disappear",
                )
                self.assertEqual(first["unresolved"], 1)
                vanished.unlink()
                (source / "稳定文件.txt").write_text(_novel("稳定"), encoding="utf-8")

                second = scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-after-disappear",
                )
                self.assertEqual(second["missing_marked"], 1)
                self.assertEqual(second["unresolved"], 0)
                self.assertEqual(second["catalog"]["scan_status"]["missing"], 1)
                planned = plan_catalog(catalog, archive, run_id="plan-after-disappear")
                self.assertEqual(planned["planned_files"], 1)

    def test_old_plan_remains_usable_after_a_new_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["旧计划"])
                plan_catalog(catalog, archive, run_id="plan-old")
                old_row = next(catalog.plan_rows("plan-old"))
                old_title = old_row["display_title"]

                # Change the mutable catalog view before freezing a later plan,
                # making it observable which snapshot apply actually consumes.
                catalog.set_plan(
                    int(old_row["file_id"]),
                    display_title="后续计划采用的新标题",
                    title_key="后续计划采用的新标题",
                )
                catalog.commit()
                plan_catalog(catalog, archive, run_id="plan-new")
                new_row = next(catalog.plan_rows("plan-new"))

                self.assertEqual(
                    next(catalog.plan_rows("plan-old"))["display_title"],
                    old_title,
                )
                self.assertEqual(new_row["display_title"], "后续计划采用的新标题")

                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-old",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(applied["status"], "complete")
                self.assertEqual(applied["remaining"], 0)

                old_after = next(catalog.plan_rows("plan-old"))
                new_after = next(catalog.plan_rows("plan-new"))
                self.assertEqual(old_after["apply_status"], "complete")
                self.assertEqual(new_after["apply_status"], "")
                index_rows = [
                    json.loads(line)
                    for line in (archive / "index.jsonl").read_text(encoding="utf-8").splitlines()
                ]
                indexed = next(item for item in index_rows if item["file_id"] == old_after["file_id"])
                self.assertEqual(indexed["title"], old_title)
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-old")["errors"],
                    0,
                )

    def test_reused_and_path_traversal_run_ids_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["安全编号"])

                with self.assertRaisesRegex(ValueError, "Run ID"):
                    plan_catalog(catalog, archive, run_id="../escaped-plan")
                self.assertFalse((archive / "escaped-plan").exists())

                plan_catalog(catalog, archive, run_id="plan-once")
                plan_path = archive / ".state" / "runs" / "plan-once" / "plan.jsonl"
                original_plan = plan_path.read_bytes()
                original_rows = list(catalog.plan_rows("plan-once"))

                with self.assertRaisesRegex(RuntimeError, "already exists"):
                    plan_catalog(catalog, archive, run_id="plan-once")
                self.assertEqual(plan_path.read_bytes(), original_plan)
                self.assertEqual(list(catalog.plan_rows("plan-once")), original_rows)

    def test_plan_artifact_failure_rolls_back_plan_rows_and_id_allocation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["事务回滚"])
                with (
                    patch.object(
                        local_archive_module,
                        "_atomic_write_json",
                        side_effect=OSError("injected summary write failure"),
                    ),
                    self.assertRaisesRegex(OSError, "injected summary write failure"),
                ):
                    plan_catalog(catalog, archive, run_id="plan-artifact-failure")

                run = catalog.connection.execute(
                    "SELECT status FROM runs WHERE run_id='plan-artifact-failure'"
                ).fetchone()
                self.assertIsNotNone(run)
                self.assertEqual(run["status"], "failed")
                self.assertEqual(
                    catalog.connection.execute(
                        "SELECT COUNT(*) FROM plan_files "
                        "WHERE plan_run_id='plan-artifact-failure'"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    catalog.connection.execute(
                        "SELECT COUNT(*) FROM library_file_ids"
                    ).fetchone()[0],
                    0,
                )
                current = next(catalog.iter_files())
                self.assertEqual(current["plan_run_id"], "")
                self.assertEqual(current["library_id"], 0)


class LocalApplyResumeTests(unittest.TestCase):
    def test_verify_io_error_is_not_reported_as_verified_source_deletion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["删除验证IO错误"])
                plan_catalog(catalog, archive, run_id="plan-verify-source-io")
                source_path = Path(
                    str(next(catalog.plan_rows("plan-verify-source-io"))["source_path"])
                )
                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-verify-source-io",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]),
                )
                self.assertEqual(applied["status"], "complete")
                real_stat = local_archive_module._regular_file_stat

                def fail_source_stat(path: Path, *, purpose: str) -> os.stat_result:
                    if purpose == "source" and Path(path) == source_path:
                        raise PermissionError("injected source lstat denial")
                    return real_stat(path, purpose=purpose)

                with patch.object(
                    local_archive_module,
                    "_regular_file_stat",
                    side_effect=fail_source_stat,
                ):
                    verified = verify_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-verify-source-io",
                    )
                self.assertEqual(verified["errors"], 1)
                self.assertEqual(verified["source_deleted_verified"], 0)
                self.assertIn(
                    "injected source lstat denial",
                    verified["error_items"][0]["error"],
                )

    def test_parallel_publish_finishes_canonicals_before_duplicate_deletion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            duplicate_body = _novel("并行重复")
            (source / "并行甲.txt").write_text(duplicate_body, encoding="utf-8")
            (source / "并行甲异名.txt").write_text(duplicate_body, encoding="utf-8")
            (source / "并行乙.txt").write_text(_novel("并行独立"), encoding="utf-8")
            snapshot = snapshot_sources([source])

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-parallel-apply",
                )
                plan_catalog(catalog, archive, run_id="plan-parallel-apply")
                with patch.object(
                    local_archive_module,
                    "_verify_utf8_no_bom",
                    side_effect=AssertionError(
                        "unchanged representative token must avoid duplicate rehash"
                    ),
                ):
                    applied = apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-parallel-apply",
                        transfer_mode="move",
                        confirm_transfer_complete=True,
                        stability_snapshot=snapshot,
                        workers=3,
                    )
                self.assertEqual(applied["status"], "complete")
                self.assertEqual(applied["processed"], 3)
                self.assertEqual(applied["duplicates_removed"], 1)
                self.assertFalse(any(source.glob("*.txt")))
                applied_rows = list(catalog.plan_rows("plan-parallel-apply"))
                self.assertTrue(
                    all(row["destination_inode"] != 0 for row in applied_rows),
                    applied_rows,
                )
                self.assertEqual(
                    verify_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-parallel-apply",
                        workers=3,
                    )["errors"],
                    0,
                )

    def test_apply_rebuilds_missing_destination_instead_of_false_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["目标恢复"])
                plan_catalog(catalog, archive, run_id="plan-missing-destination")
                first = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-missing-destination",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(first["status"], "complete")
                row = next(catalog.plan_rows("plan-missing-destination"))
                destination = archive / str(row["raw_destination"])
                destination.unlink()

                resumed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-missing-destination",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(resumed["status"], "complete")
                self.assertEqual(resumed["processed"], 1)
                self.assertEqual(resumed["skipped"], 0)
                self.assertTrue(destination.is_file())
                self.assertEqual(
                    verify_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-missing-destination",
                    )["errors"],
                    0,
                )

    def test_copy_after_move_keeps_irreversible_invalid_deleted_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            rejected = source / "empty.txt"
            rejected.write_bytes(b"")
            snapshot = snapshot_sources([source])

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-irrev-delete",
                )
                plan_catalog(catalog, archive, run_id="plan-irrev-delete")
                moved = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-irrev-delete",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot,
                )
                self.assertEqual(moved["status"], "complete")
                self.assertFalse(rejected.exists())

                copied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-irrev-delete",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(copied["status"], "complete")
                self.assertEqual(copied["processed"], 0)
                row = next(catalog.plan_rows("plan-irrev-delete"))
                self.assertEqual(row["apply_status"], "deleted_invalid")
                self.assertEqual(row["raw_transfer_state"], "invalid_deleted")
                self.assertEqual(
                    (
                        row["destination_device_id"],
                        row["destination_inode"],
                        row["destination_size_bytes"],
                        row["destination_mtime_ns"],
                        row["destination_ctime_ns"],
                    ),
                    (0, 0, 0, 0, 0),
                )
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-irrev-delete")[
                        "errors"
                    ],
                    0,
                )

                # Resuming in move mode must also accept that an irreversibly
                # deleted invalid source has no archive destination.
                resumed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-irrev-delete",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]),
                )
                self.assertEqual(resumed["status"], "complete")
                self.assertEqual(resumed["processed"], 0)

    def test_move_rejects_symlink_destination_without_deleting_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["链接拒绝"])
                plan_catalog(catalog, archive, run_id="plan-symlink-destination")
                row = next(catalog.plan_rows("plan-symlink-destination"))
                source_path = Path(str(row["source_path"]))
                snapshot = snapshot_sources([source])
                outside = base / "outside-copy.txt"
                outside.write_bytes(source_path.read_bytes())
                destination = archive / str(row["raw_destination"])
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(outside)

                result = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-symlink-destination",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot,
                )
                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["failed"], 1)
                self.assertTrue(source_path.is_file())
                self.assertTrue(destination.is_symlink())

    def test_move_manifest_records_intent_for_already_absent_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["缺席意图"])
                plan_catalog(catalog, archive, run_id="plan-absent-intent")
                initial = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-absent-intent",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]),
                )
                self.assertEqual(initial["status"], "complete")
                row = next(catalog.plan_rows("plan-absent-intent"))
                source_path = Path(str(row["source_path"]))
                self.assertFalse(source_path.exists())
                catalog.connection.execute(
                    """
                    UPDATE plan_files
                    SET apply_status='', raw_transfer_state='', applied_at=NULL
                    WHERE plan_run_id=? AND file_id=?
                    """,
                    ("plan-absent-intent", int(row["file_id"])),
                )
                catalog.commit()

                resumed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-absent-intent",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]),
                )
                records = [
                    json.loads(line)
                    for line in Path(str(resumed["journal"])).read_text("utf-8").splitlines()
                ]
                self.assertTrue(
                    any(
                        record.get("operation") == "delete_intent"
                        and record.get("source") == str(source_path)
                        for record in records
                    ),
                    records,
                )

    def test_apply_prepass_and_verify_writer_failures_leave_no_running_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["失败收尾"])
                plan_catalog(catalog, archive, run_id="plan-failure-finalization")
                snapshot = snapshot_sources([source])
                real_flush = local_archive_module._DurableJournal.flush
                calls = 0

                def fail_first_flush(writer: object) -> None:
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        raise OSError("synthetic prepass journal failure")
                    real_flush(writer)  # type: ignore[arg-type]

                with patch.object(
                    local_archive_module._DurableJournal,
                    "flush",
                    new=fail_first_flush,
                ):
                    with self.assertRaisesRegex(OSError, "synthetic prepass"):
                        apply_plan(
                            catalog,
                            archive,
                            plan_run_id="plan-failure-finalization",
                            transfer_mode="move",
                            confirm_transfer_complete=True,
                            stability_snapshot=snapshot,
                        )
                self.assertTrue(any(source.glob("*.txt")))
                apply_statuses = [
                    str(row[0])
                    for row in catalog.connection.execute(
                        "SELECT status FROM runs WHERE phase='apply'"
                    )
                ]
                self.assertNotIn("running", apply_statuses)

                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-failure-finalization",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(applied["status"], "complete")
                with patch.object(
                    local_archive_module,
                    "_DurableJournal",
                    side_effect=OSError("synthetic verify writer failure"),
                ):
                    with self.assertRaisesRegex(OSError, "synthetic verify writer"):
                        verify_plan(
                            catalog,
                            archive,
                            plan_run_id="plan-failure-finalization",
                        )
                verify_statuses = [
                    str(row[0])
                    for row in catalog.connection.execute(
                        "SELECT status FROM runs WHERE phase='verify'"
                    )
                ]
                self.assertNotIn("running", verify_statuses)

    def test_apply_abort_journal_failure_still_marks_run_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["日志故障收尾"])
                plan_catalog(catalog, archive, run_id="plan-abort-journal-failure")
                real_append = local_archive_module._DurableJournal.append

                def fail_abort_append(
                    writer: object,
                    event: object,
                    *,
                    force: bool = False,
                ) -> None:
                    if isinstance(event, dict) and event.get("operation") == "run_aborted":
                        raise OSError("injected abort journal failure")
                    real_append(writer, event, force=force)  # type: ignore[arg-type]

                with (
                    patch.object(
                        local_archive_module,
                        "_write_flat_index",
                        side_effect=RuntimeError("injected final index failure"),
                    ),
                    patch.object(
                        local_archive_module._DurableJournal,
                        "append",
                        new=fail_abort_append,
                    ),
                    self.assertRaisesRegex(RuntimeError, "injected final index failure"),
                ):
                    apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-abort-journal-failure",
                        transfer_mode="copy",
                        confirm_transfer_complete=True,
                    )

                run = catalog.connection.execute(
                    """
                    SELECT status, summary_json FROM runs
                    WHERE phase='apply' ORDER BY started_at DESC, run_id DESC LIMIT 1
                    """
                ).fetchone()
                self.assertIsNotNone(run)
                self.assertEqual(run["status"], "failed")
                summary = json.loads(str(run["summary_json"]))
                self.assertIn("injected final index failure", summary["error"])
                self.assertTrue(
                    any("journal_append" in item for item in summary["cleanup_errors"])
                )

    def test_apply_verify_and_cli_reject_nonpositive_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["限制检查"])
                plan_catalog(catalog, archive, run_id="plan-invalid-limit")
                for invalid in (0, -1):
                    with self.assertRaises(ValueError):
                        apply_plan(
                            catalog,
                            archive,
                            plan_run_id="plan-invalid-limit",
                            transfer_mode="copy",
                            confirm_transfer_complete=True,
                            limit=invalid,
                        )
                    with self.assertRaises(ValueError):
                        verify_plan(
                            catalog,
                            archive,
                            plan_run_id="plan-invalid-limit",
                            limit=invalid,
                        )

            parser = build_parser()
            for command in ("apply", "verify"):
                for invalid in ("0", "-1"):
                    with redirect_stderr(StringIO()), self.assertRaises(SystemExit):
                        parser.parse_args([command, "--limit", invalid])

    def test_verify_cli_forwards_worker_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "Library" / "Noise"
            with (
                patch(
                    "scripts.organize_local_novels.verify_plan",
                    return_value={"errors": 0},
                ) as verifier,
                redirect_stdout(StringIO()),
            ):
                exit_code = organize_main(
                    [
                        "--archive-root",
                        str(archive),
                        "verify",
                        "--plan-run-id",
                        "plan-for-cli-forwarding",
                        "--workers",
                        "3",
                    ]
                )
            self.assertEqual(exit_code, 0)
            self.assertEqual(verifier.call_args.kwargs["workers"], 3)

    def test_enrich_cli_uses_batch_concurrency_without_undefined_workers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "Library" / "Noise"
            with (
                patch(
                    "scripts.organize_local_novels.enrich_low_confidence_metadata",
                    return_value={"degraded": False},
                ) as enricher,
                redirect_stdout(StringIO()),
            ):
                exit_code = organize_main(
                    [
                        "--archive-root",
                        str(archive),
                        "enrich-metadata",
                        "--model",
                        "Qwen-test",
                        "--batch-size",
                        "7",
                        "--items-per-request",
                        "3",
                    ]
                )
            self.assertEqual(exit_code, 0)
            self.assertEqual(enricher.call_args.kwargs["batch_size"], 7)
            self.assertEqual(enricher.call_args.kwargs["items_per_request"], 3)

    def test_partial_move_resumes_from_new_snapshot_even_if_status_write_was_lost(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["甲", "乙", "丙"])
                plan_catalog(catalog, archive, run_id="plan-move-resume")
                original_snapshot = snapshot_sources([source])
                partial = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-move-resume",
                    transfer_mode="move",
                    raw_only=True,
                    confirm_transfer_complete=True,
                    stability_snapshot=original_snapshot,
                    limit=1,
                )
                self.assertEqual(partial["remaining"], 2)

                # Simulate a crash after durable raw publication + source
                # unlink but before the plan status transaction committed.
                moved_row = next(
                    row
                    for row in catalog.plan_rows("plan-move-resume")
                    if row["raw_transfer_state"] == "moved"
                )
                catalog.connection.execute(
                    """
                    UPDATE plan_files SET apply_status='', raw_transfer_state='', applied_at=NULL
                    WHERE plan_run_id=? AND file_id=?
                    """,
                    ("plan-move-resume", moved_row["file_id"]),
                )
                catalog.commit()

                with self.assertRaisesRegex(RuntimeError, "differs"):
                    apply_plan(
                        catalog,
                        archive,
                        plan_run_id="plan-move-resume",
                        transfer_mode="move",
                        raw_only=True,
                        confirm_transfer_complete=True,
                        stability_snapshot=original_snapshot,
                    )

                remaining_snapshot = snapshot_sources([source])
                resumed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-move-resume",
                    transfer_mode="move",
                    raw_only=True,
                    confirm_transfer_complete=True,
                    stability_snapshot=remaining_snapshot,
                )
                self.assertEqual(resumed["remaining"], 0)
                self.assertFalse(any(source.glob("*.txt")))
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-move-resume")["errors"],
                    0,
                )

    def test_limit_reports_remaining_then_resume_and_complete_rerun_skip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                _scan_books(catalog, archive, source, ["青山", "深海", "星河"])
                plan_catalog(catalog, archive, run_id="plan-limited")

                partial = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-limited",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                    limit=1,
                )
                self.assertEqual(partial["status"], "partial")
                self.assertEqual(partial["planned"], 3)
                self.assertEqual(partial["processed"], 1)
                self.assertEqual(partial["remaining"], 2)

                partial_verify = verify_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-limited",
                )
                self.assertEqual(partial_verify["checked"], 1)
                self.assertEqual(partial_verify["incomplete"], 2)
                self.assertEqual(partial_verify["errors"], 2)

                resumed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-limited",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(resumed["status"], "complete")
                self.assertEqual(resumed["already_satisfied"], 1)
                self.assertEqual(resumed["processed"], 2)
                self.assertEqual(resumed["remaining"], 0)
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-limited")["errors"],
                    0,
                )

                complete_rerun = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-limited",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(complete_rerun["status"], "complete")
                self.assertEqual(complete_rerun["already_satisfied"], 3)
                self.assertEqual(complete_rerun["processed"], 0)
                self.assertEqual(complete_rerun["skipped"], 3)
                self.assertEqual(complete_rerun["raw_transferred"], 0)
                self.assertEqual(complete_rerun["editions_written"], 0)
                self.assertEqual(complete_rerun["remaining"], 0)


if __name__ == "__main__":
    unittest.main()
