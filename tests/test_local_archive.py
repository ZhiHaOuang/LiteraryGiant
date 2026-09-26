from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from fetcher.local_archive import (
    DedupeThresholds,
    apply_plan,
    plan_catalog,
    scan_sources,
    snapshot_sources,
    snapshots_match,
    verify_plan,
    _transfer_raw,
)
from fetcher.local_catalog import LocalNovelCatalog
from fetcher.local_fingerprint import compare_fingerprints, fingerprint_file


def _novel(prefix: str, count: int = 260) -> str:
    paragraphs = [
        f"第{index}章 {prefix}人物沿着山路前行，记录了只属于这一段故事的事件编号{index}。"
        f"随后众人讨论线索{index}，并决定在天亮以前完成今天的任务。"
        for index in range(1, count + 1)
    ]
    return "\n\n".join(paragraphs) + "\n"


class LocalFingerprintTests(unittest.TestCase):
    def test_encoding_and_logical_hash_ignore_encoding_and_newlines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            text = _novel("青云")
            utf8 = root / "完全不同的名字.txt"
            gb = root / "另一个名字.txt"
            utf16 = root / "第三个名字.txt"
            utf8.write_text(text, encoding="utf-8", newline="\n")
            gb.write_bytes(text.replace("\n", "\r\n").encode("gb18030"))
            utf16.write_bytes(text.encode("utf-16"))

            left = fingerprint_file(utf8)
            right = fingerprint_file(gb)
            third = fingerprint_file(utf16)
            evidence = compare_fingerprints(left, right)
            self.assertEqual(left.encoding, "utf-8")
            self.assertEqual(right.encoding, "gb18030")
            self.assertEqual(third.encoding, "utf-16-le")
            self.assertEqual(left.normalized_sha256, right.normalized_sha256)
            self.assertEqual(left.normalized_sha256, third.normalized_sha256)
            self.assertTrue(evidence.exact)

    def test_streaming_sketch_finds_body_after_large_inserted_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = _novel("主线", count=300)
            shorter = root / "异名甲.txt"
            longer = root / "毫不相同的名字.txt"
            shorter.write_text(body, encoding="utf-8")
            longer.write_text(_novel("序言", count=90) + body, encoding="utf-8")

            evidence = compare_fingerprints(
                fingerprint_file(shorter), fingerprint_file(longer)
            )
            self.assertGreater(evidence.sketch_containment, 0.90)
            self.assertGreater(evidence.order_ratio, 0.95)
            self.assertGreaterEqual(evidence.shared_anchors, 10)


class LocalArchivePipelineTests(unittest.TestCase):
    def test_curated_source_priority_wins_representative_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            text = _novel("同一正文")
            (source / "普通来源-甲.txt").write_text(text, encoding="utf-8")
            (source / "既有成品-甲.txt").write_text(text, encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-source-priority",
                )
                processed = next(
                    row for row in catalog.iter_files()
                    if row["source_name"] == "既有成品-甲.txt"
                )
                catalog.set_source_priority(
                    int(processed["file_id"]),
                    priority=100,
                    source_kind="processed",
                )
                plan_catalog(catalog, archive, run_id="plan-source-priority")
                canonical = next(
                    row for row in catalog.plan_rows("plan-source-priority")
                    if row["planned_action"] == "canonical"
                )
                self.assertEqual(canonical["source_name"], "既有成品-甲.txt")
                self.assertEqual(canonical["source_priority"], 100)
                self.assertEqual(canonical["source_kind"], "processed")

    def test_flat_names_have_stable_ids_and_distinct_books_do_not_fake_versions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            archive = base / "Library" / "Noise"
            (source / "甲").mkdir(parents=True)
            (source / "乙").mkdir(parents=True)
            (source / "甲" / "同名书-同一作者.txt").write_text(
                _novel("完全不同的甲"), encoding="utf-8"
            )
            (source / "乙" / "同名书-同一作者.txt").write_text(
                _novel("完全不同的乙"), encoding="utf-8"
            )

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-chinese-names",
                )
                plan_catalog(catalog, archive, run_id="plan-chinese-names")
                names = sorted(Path(row["raw_destination"]).name for row in catalog.plan_rows("plan-chinese-names"))
                self.assertEqual(
                    names,
                    [
                        "20_id000001_同名书_同一作者.txt",
                        "20_id000002_同名书_同一作者.txt",
                    ],
                )

    def test_apply_converts_gb18030_to_utf8_without_bom(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            book = source / "青云录-甲.txt"
            original = _novel("编码转换")
            book.write_bytes(original.encode("gb18030"))

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-utf8-output",
                )
                plan_catalog(catalog, archive, run_id="plan-utf8-output")
                result = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-utf8-output",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(result["failed"], 0)
                row = next(catalog.plan_rows("plan-utf8-output"))
                output = archive / row["raw_destination"]
                raw = output.read_bytes()
                self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
                self.assertEqual(raw.decode("utf-8"), original)
                self.assertEqual(output.name, "20_id000001_青云录_甲.txt")
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-utf8-output")["errors"],
                    0,
                )

    def test_move_deletes_invalid_text_and_indexes_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            bad = source / "无法转换-未知.txt"
            bad.write_bytes(b"")
            stable = snapshot_sources([source])

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scanned = scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-invalid-delete",
                )
                self.assertEqual(scanned["catalog"]["scan_status"]["invalid"], 1)
                plan_catalog(catalog, archive, run_id="plan-invalid-delete")
                result = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-invalid-delete",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=stable,
                )
                self.assertEqual(result["invalid_deleted"], 1)
                self.assertFalse(bad.exists())
                # The public index is a usable-book catalog. Rejected sources
                # remain in the immutable plan/SQLite/audit deletion ledger,
                # but must not masquerade as a book with ``file=null``.
                self.assertEqual(
                    (archive / "index.jsonl").read_text(encoding="utf-8"), ""
                )
                rejected = catalog.get_plan_file(
                    "plan-invalid-delete",
                    next(catalog.iter_files(status="invalid"))["file_id"],
                )
                self.assertEqual(rejected["apply_status"], "deleted_invalid")
                self.assertEqual(
                    verify_plan(catalog, archive, plan_run_id="plan-invalid-delete")["errors"],
                    0,
                )

    def test_copy_then_move_same_plan_does_not_skip_source_removal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            book = source / "先复制后移动.txt"
            book.write_text(_novel("阶段"), encoding="utf-8")
            stable = snapshot_sources([source])

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-copy-move",
                )
                plan_catalog(catalog, archive, run_id="plan-copy-move")
                copied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-copy-move",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(copied["remaining"], 0)
                self.assertTrue(book.exists())

                moved = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-copy-move",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=stable,
                )
                self.assertEqual(moved["processed"], 1)
                self.assertEqual(moved["remaining"], 0)
                self.assertFalse(book.exists())
                row = next(catalog.plan_rows("plan-copy-move"))
                self.assertEqual(row["raw_transfer_state"], "moved")

    def test_move_can_preserve_existing_processed_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            same = _novel("现有成品")
            canonical_source = source / "现有成品-甲.txt"
            duplicate_source = source / "现有成品副本-甲.txt"
            raw_source = source / "新增原始书-乙.txt"
            canonical_source.write_text(same, encoding="utf-8")
            duplicate_source.write_text(same, encoding="utf-8")
            raw_source.write_text(_novel("新增原始"), encoding="utf-8")
            stable = snapshot_sources([source])

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog, [source], archive_root=archive, workers=1,
                    stable_age_seconds=0, run_id="scan-preserve-processed",
                )
                for row in catalog.iter_files():
                    if Path(str(row["source_path"])) == canonical_source:
                        catalog.set_source_priority(
                            int(row["file_id"]), priority=100,
                            source_kind="existing_processed",
                        )
                    elif Path(str(row["source_path"])) == duplicate_source:
                        catalog.set_source_priority(
                            int(row["file_id"]), priority=90,
                            source_kind="existing_processed",
                        )
                plan_catalog(catalog, archive, run_id="plan-preserve-processed")

                with self.assertRaisesRegex(ValueError, "only in move mode"):
                    apply_plan(
                        catalog, archive, plan_run_id="plan-preserve-processed",
                        transfer_mode="copy", confirm_transfer_complete=True,
                        preserve_existing_processed=True,
                    )

                applied = apply_plan(
                    catalog, archive, plan_run_id="plan-preserve-processed",
                    transfer_mode="move", confirm_transfer_complete=True,
                    stability_snapshot=stable, workers=2,
                    preserve_existing_processed=True,
                )
                self.assertEqual(applied["status"], "complete")
                self.assertEqual(applied["remaining"], 0)
                self.assertEqual(applied["preserved_existing_processed"], 2)
                self.assertTrue(canonical_source.exists())
                self.assertTrue(duplicate_source.exists())
                self.assertFalse(raw_source.exists())
                states = {
                    Path(str(row["source_path"])): row["raw_transfer_state"]
                    for row in catalog.plan_rows("plan-preserve-processed")
                }
                self.assertEqual(states[canonical_source], "source_preserved")
                self.assertEqual(
                    states[duplicate_source], "source_duplicate_preserved"
                )
                verified = verify_plan(
                    catalog, archive, plan_run_id="plan-preserve-processed",
                    workers=2,
                )
                self.assertEqual(verified["errors"], 0)

                journal = Path(str(applied["journal"])).read_text(encoding="utf-8")
                delete_sources = {
                    json.loads(line).get("source")
                    for line in journal.splitlines()
                    if json.loads(line).get("operation") == "delete_intent"
                }
                self.assertNotIn(str(canonical_source), delete_sources)
                self.assertNotIn(str(duplicate_source), delete_sources)

                resumed = apply_plan(
                    catalog, archive, plan_run_id="plan-preserve-processed",
                    transfer_mode="move", confirm_transfer_complete=True,
                    stability_snapshot=snapshot_sources([source]), workers=2,
                    preserve_existing_processed=True,
                )
                self.assertEqual(resumed["remaining"], 0)
                self.assertEqual(resumed["processed"], 0)

    def test_fuzzy_chains_do_not_create_transitive_work_merges(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            first = _novel("甲线", count=180)
            third = _novel("丙线", count=180)
            (source / "1-甲.txt").write_text(first, encoding="utf-8")
            (source / "2-桥接.txt").write_text(first + third, encoding="utf-8")
            (source / "3-丙.txt").write_text(third, encoding="utf-8")

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-chain",
                )
                summary = plan_catalog(
                    catalog,
                    archive,
                    thresholds=DedupeThresholds(
                        minimum_fuzzy_chars=100,
                        same_work_length_ratio=0.40,
                        same_work_containment=0.85,
                        minimum_shared_anchors=5,
                    ),
                    run_id="plan-chain",
                )
                rows = list(catalog.plan_rows("plan-chain"))
                self.assertEqual(len({row["work_id"] for row in rows}), 2)
                self.assertGreaterEqual(summary["review_edges"], 1)
                relations = {
                    str(row[0])
                    for row in catalog.connection.execute(
                        "SELECT relation FROM duplicate_edges WHERE plan_run_id='plan-chain'"
                    )
                }
                self.assertIn("transitive_conflict", relations)

    def test_move_archives_to_an_independent_inode_before_unlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.txt"
            destination = root / "archive" / "source.txt"
            source.write_text(_novel("跨挂载", count=5), encoding="utf-8")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            source_inode = source.stat().st_ino
            result = _transfer_raw(
                source,
                destination,
                expected_hash=digest,
                mode="move",
            )
            self.assertEqual(result, "moved")
            self.assertFalse(source.exists())
            self.assertNotEqual(destination.stat().st_ino, source_inode)
            self.assertEqual(hashlib.sha256(destination.read_bytes()).hexdigest(), digest)

    def test_near_duplicate_becomes_a_preserved_edition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            full = source / "山河旧梦-甲.txt"
            variant = source / "完全不同标题-甲.txt"
            body = _novel("山河", count=260)
            full.write_text(body, encoding="utf-8")
            variant.write_text(
                "欢迎加入小说群 QQ：123456\n本作品来自互联网，版权归作者所有。\n"
                + body
                + _novel("山河", count=20).replace("第", "番外第"),
                encoding="utf-8",
            )

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-near",
                )
                summary = plan_catalog(
                    catalog,
                    archive,
                    thresholds=DedupeThresholds(minimum_fuzzy_chars=100),
                    run_id="plan-near",
                )
                rows = list(catalog.plan_rows("plan-near"))
                self.assertEqual(len({row["work_id"] for row in rows}), 1)
                self.assertEqual({row["planned_action"] for row in rows}, {"canonical", "edition"})
                self.assertEqual(len({row["library_id"] for row in rows}), 2)
                self.assertEqual({row["edition_version"] for row in rows}, {1, 2})
                names = {Path(row["raw_destination"]).name for row in rows}
                self.assertEqual(sum(name.endswith("_v2.txt") for name in names), 1)
                self.assertGreaterEqual(summary["near_edges"], 1)

    def test_incomplete_candidate_is_review_only_unless_explicitly_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            (source / "完整版").mkdir(parents=True)
            (source / "短版").mkdir()
            archive = base / "Library" / "Noise"
            (source / "完整版" / "山河旧梦-甲.txt").write_text(
                _novel("山河", count=160), encoding="utf-8"
            )
            (source / "短版" / "山河旧梦-甲.txt").write_text(
                _novel("山河", count=96), encoding="utf-8"
            )
            thresholds = DedupeThresholds(minimum_fuzzy_chars=100)

            with LocalNovelCatalog(archive / ".state" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-incomplete-review",
                )
                review_plan = plan_catalog(
                    catalog,
                    archive,
                    thresholds=thresholds,
                    run_id="plan-incomplete-review",
                )
                review_rows = list(catalog.plan_rows("plan-incomplete-review"))
                self.assertEqual(review_plan["possible_incomplete_edges"], 1)
                self.assertEqual(review_plan["incomplete_duplicates"], 0)
                self.assertEqual(review_plan["review_items"], 1)
                self.assertEqual(
                    {row["planned_action"] for row in review_rows},
                    {"canonical", "edition"},
                )
                self.assertEqual(len({row["library_id"] for row in review_rows}), 2)
                self.assertEqual({row["edition_version"] for row in review_rows}, {1, 2})
                review_records = [
                    json.loads(line)
                    for line in Path(review_plan["review_path"])
                    .read_text(encoding="utf-8")
                    .splitlines()
                ]
                self.assertEqual(
                    [record["relation"] for record in review_records],
                    ["possible_incomplete"],
                )

                long_id = next(
                    int(row["library_id"])
                    for row in review_rows
                    if Path(row["source_path"]).parent.name == "完整版"
                )
                collapse_plan = plan_catalog(
                    catalog,
                    archive,
                    thresholds=thresholds,
                    run_id="plan-incomplete-collapse",
                    delete_high_confidence_incomplete=True,
                )
                collapse_rows = list(catalog.plan_rows("plan-incomplete-collapse"))
                self.assertEqual(collapse_plan["editions"], 1)
                self.assertEqual(collapse_plan["incomplete_duplicates"], 1)
                self.assertEqual(
                    {row["planned_action"] for row in collapse_rows},
                    {"canonical", "source_duplicate"},
                )
                short_row = next(
                    row
                    for row in collapse_rows
                    if Path(row["source_path"]).parent.name == "短版"
                )
                self.assertEqual(short_row["duplicate_kind"], "incomplete_duplicate")
                self.assertEqual(
                    {int(row["library_id"]) for row in collapse_rows}, {long_id}
                )
                self.assertEqual(
                    len({row["raw_destination"] for row in collapse_rows}), 1
                )
                self.assertNotIn("_v2.txt", str(short_row["raw_destination"]))

    def test_conflicting_authors_prevent_incomplete_collapse(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            (source / "甲源").mkdir(parents=True)
            (source / "乙源").mkdir()
            archive = base / "Library" / "Noise"
            (source / "甲源" / "山河旧梦-甲.txt").write_text(
                _novel("山河", count=160), encoding="utf-8"
            )
            (source / "乙源" / "山河旧梦-乙.txt").write_text(
                _novel("山河", count=96), encoding="utf-8"
            )

            with LocalNovelCatalog(archive / ".state" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-incomplete-author-conflict",
                )
                summary = plan_catalog(
                    catalog,
                    archive,
                    thresholds=DedupeThresholds(minimum_fuzzy_chars=100),
                    run_id="plan-incomplete-author-conflict",
                    delete_high_confidence_incomplete=True,
                )
                rows = list(catalog.plan_rows("plan-incomplete-author-conflict"))
                self.assertEqual(summary["possible_incomplete_edges"], 0)
                self.assertEqual(summary["incomplete_duplicates"], 0)
                self.assertNotIn(
                    "source_duplicate", {row["planned_action"] for row in rows}
                )
                self.assertEqual(len({row["raw_destination"] for row in rows}), 2)

    def test_scan_plan_copy_apply_verify_and_idempotence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            nested = source / "晋江" / "2024热榜"
            nested.mkdir(parents=True)
            archive = base / "Library" / "Noise"

            original = _novel("青云")
            same_content = nested / "1.《青云录》作者：甲.txt"
            different_name = source / "玄幻魔法" / "完全不同的书名-甲.txt"
            different_name.parent.mkdir(parents=True)
            same_title_different_content = source / "其他" / "青云录-乙.txt"
            same_title_different_content.parent.mkdir(parents=True)
            same_content.write_text(original, encoding="utf-8")
            different_name.write_bytes(original.replace("\n", "\r\n").encode("gb18030"))
            same_title_different_content.write_text(_novel("深海"), encoding="utf-8")
            before = {
                path: (path.read_bytes(), path.stat().st_mtime_ns)
                for path in (same_content, different_name, same_title_different_content)
            }

            catalog_path = archive / "catalog" / "catalog.sqlite3"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan = scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=2,
                    stable_age_seconds=0,
                    run_id="scan-test",
                )
                self.assertEqual(scan["statuses"].get("ok"), 3)

                plan = plan_catalog(
                    catalog,
                    archive,
                    thresholds=DedupeThresholds(minimum_fuzzy_chars=100),
                    run_id="plan-test",
                )
                self.assertEqual(plan["source_duplicates"], 1)
                rows = list(catalog.plan_rows("plan-test"))
                by_name = {row["source_name"]: row for row in rows}
                self.assertEqual(
                    by_name[same_content.name]["work_id"],
                    by_name[different_name.name]["work_id"],
                )
                self.assertNotEqual(
                    by_name[same_content.name]["work_id"],
                    by_name[same_title_different_content.name]["work_id"],
                )
                representative = next(
                    row
                    for row in (by_name[same_content.name], by_name[different_name.name])
                    if row["planned_action"] == "canonical"
                )
                self.assertTrue(json.loads(representative["aliases_json"]))

                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-test",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(applied["failed"], 0)
                verified = verify_plan(catalog, archive, plan_run_id="plan-test")
                self.assertEqual(verified["errors"], 0)

                applied_again = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-test",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(applied_again["failed"], 0)
                self.assertEqual(applied_again["raw_transferred"], 0)
                self.assertEqual(applied_again["editions_written"], 0)

            for path, (raw, mtime_ns) in before.items():
                self.assertTrue(path.exists())
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(path.stat().st_mtime_ns, mtime_ns)

    def test_move_requires_matching_stable_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            book = source / "移动测试-作者.txt"
            book.write_text(_novel("迁移"), encoding="utf-8")

            stable = snapshot_sources([source])
            self.assertTrue(snapshots_match(stable, snapshot_sources([source])))
            marker = source / "transfer.raysync.uploading"
            marker.write_text("active", encoding="utf-8")
            self.assertFalse(snapshots_match(stable, snapshot_sources([source])))
            marker.unlink()

            with LocalNovelCatalog(archive / "catalog" / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-move",
                )
                plan_catalog(catalog, archive, run_id="plan-move")
                result = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-move",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=stable,
                    raw_only=True,
                )
                self.assertEqual(result["failed"], 0)
                self.assertFalse(book.exists())
                row = next(catalog.plan_rows("plan-move"))
                self.assertTrue((archive / row["raw_destination"]).exists())
                self.assertEqual(row["raw_destination"], row["work_destination"])
                self.assertTrue((archive / row["work_destination"]).exists())
                self.assertTrue((archive / "index.jsonl").exists())
                raw_verify = verify_plan(catalog, archive, plan_run_id="plan-move")
                self.assertEqual(raw_verify["checked"], 1)
                self.assertEqual(raw_verify["errors"], 0)

                # Reapplying the flat plan is idempotent even though the old
                # external path is now gone.
                processed = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-move",
                    transfer_mode="copy",
                    confirm_transfer_complete=True,
                )
                self.assertEqual(processed["failed"], 0)
                row = next(catalog.plan_rows("plan-move"))
                self.assertTrue((archive / row["work_destination"]).exists())


if __name__ == "__main__":
    unittest.main()
