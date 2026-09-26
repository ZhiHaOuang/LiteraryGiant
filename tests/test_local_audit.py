from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fetcher.local_archive import (
    apply_plan,
    enrich_low_confidence_metadata,
    plan_catalog,
    scan_sources,
    snapshot_sources,
)
from fetcher.local_audit import (
    _BoundedSummary,
    _apply_journal_paths_from_catalog,
    export_local_novel_audit,
)
from fetcher.local_catalog import LocalNovelCatalog


def _novel(label: str, chapters: int = 80) -> str:
    return "\n\n".join(
        f"第{index}章 {label}\n这一章包含可辨认的正文、人物和事件编号{index}。"
        for index in range(1, chapters + 1)
    ) + "\n"


class LocalNovelAuditTests(unittest.TestCase):
    def test_high_cardinality_summary_stays_bounded(self) -> None:
        summary = _BoundedSummary(capacity=5, exact_unique_limit=8)
        for index in range(2_000):
            summary.add((f"旧书名{index}", f"新书名{index}"))
        payload = summary.summary(transition=True)
        self.assertEqual(payload["total"], 2_000)
        self.assertLessEqual(len(payload["top"]), 5)
        self.assertTrue(payload["unique_is_estimate"])
        self.assertGreater(payload["unique"], 1_800)
        self.assertLess(payload["unique"], 2_200)

    def test_vllm_enrichment_persists_exact_before_proposal_after(self) -> None:
        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def enrich_batch(self, items):
                return [
                    {
                        "id": str(item["id"]),
                        "title": Path(str(item["filename"])).stem,
                        "canonical_name_key": Path(str(item["filename"])).stem,
                        "author": "测试作者",
                        "aliases": [],
                        "genre": "都市",
                        "canonical_genre": "都市",
                        "tags": ["现实向"],
                        "confidence": 0.94,
                        "field_confidence": {"title": 0.94, "author": 0.90, "genre": 0.92},
                        "low_confidence": False,
                        "evidence": ["开头作者字段"],
                        "source": "vllm",
                    }
                    for item in items
                ]

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            # The model may add an author only when that literal value occurs
            # in the bounded filename/head input.  An unlabelled occurrence
            # keeps the deterministic author empty while grounding the model
            # proposal for this audit-focused test.
            (source / "元数据审计.txt").write_text(_novel("测试作者"), encoding="utf-8")
            archive = base / "archive"
            catalog_path = base / "catalog.sqlite3"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-metadata-audit",
                )
                with patch("fetcher.local_metadata.VLLMMetadataClient", FakeClient):
                    result = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        run_id="metadata-v2",
                    )
                self.assertEqual(result["accepted"], 1)
                event = catalog.connection.execute(
                    "SELECT * FROM metadata_events WHERE run_id='metadata-v2'"
                ).fetchone()
                self.assertIsNotNone(event)
                before = json.loads(str(event["before_json"]))
                proposal = json.loads(str(event["proposal_json"]))
                after = json.loads(str(event["after_json"]))
                self.assertEqual(before["author"], "")
                self.assertEqual(proposal["author"], "测试作者")
                self.assertEqual(after["author"], "测试作者")
                self.assertIn("author", json.loads(str(event["changed_fields_json"])))
            audit_line = json.loads(
                (
                    archive / ".state" / "runs" / "metadata-v2" / "results.jsonl"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(audit_line["schema_version"], "metadata_audit.v2")
            self.assertEqual(audit_line["before"]["author"], "")
            self.assertEqual(audit_line["after"]["author"], "测试作者")

    def test_report_separates_discarded_content_from_removed_source_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "incoming"
            source.mkdir()
            archive = base / "Library" / "Noise"
            body = _novel("审计测试")
            (source / "原本.txt").write_text(body, encoding="utf-8")
            (source / "异名副本.txt").write_text(body, encoding="utf-8")
            (source / "空文件.txt").write_bytes(b"")
            stable = snapshot_sources([source])
            catalog_path = base / "catalog.sqlite3"

            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-audit",
                )
                row = next(catalog.iter_files())
                before = {
                    "title": str(row["display_title"]),
                    "title_key": str(row["title_key"]),
                    "author": str(row["author"]),
                    "aliases": json.loads(str(row["aliases_json"])),
                    "title_confidence": float(row["title_confidence"]),
                    "genre": str(row["genre"]),
                    "genre_confidence": float(row["genre_confidence"]),
                    "genre_tags": json.loads(str(row["genre_tags_json"])),
                }
                after = {**before, "title": "审计后的书名", "title_key": "审计后的书名"}
                catalog.start_run("metadata-audit", "metadata_llm", {})
                catalog.set_plan(
                    int(row["file_id"]),
                    display_title=after["title"],
                    title_key=after["title_key"],
                )
                catalog.record_metadata_event(
                    "metadata-audit",
                    int(row["file_id"]),
                    decision="accepted",
                    changed_fields=["title", "title_key"],
                    reasons=[],
                    before=before,
                    proposal=after,
                    after=after,
                )
                catalog.finish_run("metadata-audit", "complete", {})
                plan_catalog(catalog, archive, run_id="plan-audit")
                applied = apply_plan(
                    catalog,
                    archive,
                    plan_run_id="plan-audit",
                    transfer_mode="move",
                    confirm_transfer_complete=True,
                    stability_snapshot=stable,
                )
                self.assertEqual(applied["remaining"], 0)

                planned_rows = list(catalog.plan_rows("plan-audit"))
                invalid_plan = next(
                    row for row in planned_rows if row["planned_action"] == "delete_invalid"
                )
                invalid_file_id = int(invalid_plan["file_id"])
                frozen_invalid_path = str(invalid_plan["source_path"])
                frozen_invalid_error = str(invalid_plan["scan_error"])

                verify_journal = (
                    archive / ".state" / "runs" / "verify-audit" / "journal.jsonl"
                )
                verify_journal.parent.mkdir(parents=True, exist_ok=True)
                verify_journal.write_text(
                    json.dumps(
                        {
                            "file_id": invalid_file_id,
                            "source_deleted_verified": True,
                            "destination_verified": None,
                            "status": "ok",
                        }
                    )
                    + "\n",
                    encoding="utf-8",
                )
                catalog.start_run(
                    "verify-audit",
                    "verify",
                    {"plan_run_id": "plan-audit", "archive_root": str(archive)},
                )
                catalog.finish_run(
                    "verify-audit",
                    "complete",
                    {
                        "plan_run_id": "plan-audit",
                        "journal": str(verify_journal),
                        "verified_deleted_file_ids": [invalid_file_id],
                    },
                )

                # A later rescan/path reuse must not rewrite the selected plan's
                # historical original path or rejection reason in the report.
                catalog.connection.execute(
                    """
                    UPDATE files SET source_path=?, scan_status='missing', scan_error=?
                    WHERE file_id=?
                    """,
                    (
                        f"/__later_catalog_identity__/{invalid_file_id}",
                        "later mutable scan state",
                        invalid_file_id,
                    ),
                )

                failed_apply_journal = (
                    archive / ".state" / "runs" / "apply-failed-audit" / "journal.jsonl"
                )
                failed_apply_journal.parent.mkdir(parents=True, exist_ok=True)
                failed_apply_journal.write_text(
                    json.dumps({"file_id": invalid_file_id, "error": "synthetic failure"})
                    + "\n",
                    encoding="utf-8",
                )
                catalog.start_run(
                    "apply-failed-audit",
                    "apply",
                    {"archive_root": str(archive), "plan_run_id": "plan-audit"},
                )
                catalog.finish_run("apply-failed-audit", "failed", {"processed": 1})
                self.assertIn(
                    failed_apply_journal.resolve(),
                    _apply_journal_paths_from_catalog(catalog.connection),
                )
                catalog.commit()

            supplemental = base / "supplemental.jsonl"
            supplemental.write_text(
                "\n".join(
                    json.dumps(record, ensure_ascii=False)
                    for record in (
                        {
                            "event": "delete_result",
                            "status": "rejected_deleted",
                            "source_path": "/raw/image-only.epub",
                            "identity": {"size": 123},
                            "error": {"code": "no_text"},
                        },
                        {
                            "event": "archive_extract",
                            "status": "complete",
                            "archive_deleted": True,
                            "archive": "/raw/books.rar",
                            "archive_bytes": 456,
                            "output_root": "/raw/books",
                        },
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            report = base / "report"
            summary = export_local_novel_audit(
                catalog_path,
                report,
                plan_run_id="plan-audit",
                supplemental_jsonl_paths=[supplemental],
            )

            self.assertEqual(summary["inventory"]["files"], 3)
            self.assertEqual(summary["artifacts"]["files"]["lines"], 3)
            self.assertEqual(summary["artifacts"]["changes"]["lines"], 4)
            self.assertEqual(summary["artifacts"]["deletions"]["lines"], 5)
            self.assertEqual(summary["deletions"]["content_discarded_files"], 2)
            self.assertEqual(
                summary["deletions"]["source_paths_removed_but_content_preserved"],
                3,
            )
            self.assertEqual(summary["metadata"]["decisions"], {"accepted": 1})
            self.assertIn("top", summary["inventory"]["scan_errors"])
            self.assertIn("top", summary["metadata"]["title_transitions"])
            self.assertEqual(
                summary["deletions"]["physical_verification"]["verified_deleted"],
                1,
            )
            self.assertEqual(summary["deletions"]["verified_content_discarded_files"], 1)

            file_rows = {
                row["file_id"]: row
                for row in (
                    json.loads(line)
                    for line in (report / "files.jsonl").read_text(encoding="utf-8").splitlines()
                )
            }
            invalid_lifecycle = file_rows[invalid_file_id]
            self.assertEqual(invalid_lifecycle["lifecycle_basis"], "frozen_plan_snapshot")
            self.assertEqual(invalid_lifecycle["original"]["source_path"], frozen_invalid_path)
            self.assertEqual(invalid_lifecycle["scan"]["error"], frozen_invalid_error)
            self.assertEqual(
                invalid_lifecycle["catalog_current"]["source_path"],
                f"/__later_catalog_identity__/{invalid_file_id}",
            )
            self.assertTrue(invalid_lifecycle["outcome"]["source_deletion_recorded"])
            self.assertTrue(invalid_lifecycle["outcome"]["source_deletion_verified"])

            deletion_rows = [
                json.loads(line)
                for line in (report / "deletions.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(
                sum(bool(row["content_discarded"]) for row in deletion_rows),
                2,
            )
            invalid_deletion = next(
                row for row in deletion_rows if row.get("file_id") == invalid_file_id
            )
            self.assertEqual(invalid_deletion["original_path"], frozen_invalid_path)
            self.assertEqual(invalid_deletion["reason"], frozen_invalid_error)
            self.assertTrue(invalid_deletion["recorded_deleted"])
            self.assertTrue(invalid_deletion["verified_deleted"])
            self.assertTrue(all("original_path" in row for row in deletion_rows))
            saved_summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_summary["schema"], "local_novel_import_audit.v1")


if __name__ == "__main__":
    unittest.main()
