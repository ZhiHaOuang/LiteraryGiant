from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fetcher.local_archive import (
    plan_catalog,
    revalidate_quarantined_literals,
    scan_sources,
)
from fetcher.local_catalog import LocalNovelCatalog


def _literal_book(replacements: int = 1, *, lines: int = 1200) -> str:
    body = "".join(
        f"第{index}章 山河人物沿着旧路前行并记录今日发生的完整故事。\n"
        for index in range(lines)
    )
    return body + ("�" * replacements) + "\n"


def _scan(catalog: LocalNovelCatalog, source: Path, archive: Path, run_id: str) -> None:
    scan_sources(
        catalog,
        [source],
        archive_root=archive,
        workers=1,
        stable_age_seconds=0,
        run_id=run_id,
    )


def _legacy_status(
    catalog: LocalNovelCatalog,
    file_id: int,
    status: str,
    *,
    clear_anchors: bool,
) -> None:
    catalog.connection.execute(
        """
        UPDATE files SET scan_status=?, scan_error='', title_evidence_json='[]',
                         plan_run_id='', planned_action=''
        WHERE file_id=?
        """,
        (status, file_id),
    )
    catalog.connection.execute("DELETE FROM anchors WHERE file_id=?", (file_id,))
    if not clear_anchors:
        row = catalog.get_file(file_id)
        catalog.connection.executemany(
            "INSERT OR IGNORE INTO anchors(file_id,anchor) VALUES(?,?)",
            ((file_id, value) for value in json.loads(row["sketch_json"])),
        )
    catalog.commit()


class LocalQualityRevalidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "incoming"
        self.source.mkdir()
        self.archive = self.root / "Noise"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _catalog(self) -> LocalNovelCatalog:
        return LocalNovelCatalog(self.root / "catalog.sqlite3")

    def test_future_scan_accepts_low_rate_strict_literal_replacement(self) -> None:
        (self.source / "合法占位符.txt").write_text(
            _literal_book(), encoding="utf-8"
        )
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-literal")
            row = next(catalog.iter_files(status=None))
            self.assertEqual(row["scan_status"], "ok")
            self.assertEqual(row["replacement_chars"], 1)
            self.assertIn("encoding:strict-literal-ufffd-v1=1", row["title_evidence_json"])

    def test_future_scan_rejects_low_rate_decoder_generated_replacement(self) -> None:
        raw = bytearray(_literal_book(0, lines=18_000).encode("utf-8"))
        raw[len(raw) // 4 : len(raw) // 4] = b"\xff"
        (self.source / "坏字节.txt").write_bytes(raw)
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-bad-byte")
            row = next(catalog.iter_files(status=None))
            self.assertEqual(row["encoding"], "utf-8")
            self.assertEqual(row["encoding_confidence"], "high")
            self.assertGreater(row["replacement_chars"], 0)
            self.assertEqual(row["scan_status"], "quarantine")
            self.assertIn("decision=strict_decode_failed", row["scan_error"])

    def test_rate_above_limit_never_invokes_strict_validator(self) -> None:
        (self.source / "占位符过多.txt").write_text(
            _literal_book(20, lines=100), encoding="utf-8"
        )
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-high-rate")
            row = next(catalog.iter_files(status=None))
            _legacy_status(
                catalog, int(row["file_id"]), "quarantine", clear_anchors=True
            )
            with patch(
                "fetcher.local_archive._strict_validate_quality_payload"
            ) as validator:
                result = revalidate_quarantined_literals(
                    catalog,
                    self.archive,
                    workers=1,
                    run_id="quality-high-rate",
                    apply_changes=True,
                )
            validator.assert_not_called()
            self.assertEqual(result["strict_checked"], 0)
            self.assertEqual(catalog.get_file(int(row["file_id"]))["scan_status"], "quarantine")

    def test_dry_run_is_catalog_only_and_does_not_change_status(self) -> None:
        (self.source / "只预览.txt").write_text(_literal_book(), encoding="utf-8")
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-preview")
            row = next(catalog.iter_files(status=None))
            file_id = int(row["file_id"])
            _legacy_status(catalog, file_id, "quarantine", clear_anchors=True)
            with patch(
                "fetcher.local_archive._strict_validate_quality_payload"
            ) as validator:
                result = revalidate_quarantined_literals(
                    catalog,
                    self.archive,
                    workers=1,
                    run_id="quality-preview",
                    apply_changes=False,
                )
            validator.assert_not_called()
            self.assertTrue(result["dry_run"])
            self.assertEqual(result["strict_eligible"], 1)
            self.assertEqual(result["strict_checked"], 0)
            self.assertEqual(result["promoted"], 0)
            self.assertEqual(result["demoted"], 0)
            self.assertEqual(catalog.get_file(file_id)["scan_status"], "quarantine")

    def test_changed_source_becomes_unresolved_instead_of_promoted(self) -> None:
        path = self.source / "后来变化.txt"
        path.write_text(_literal_book(), encoding="utf-8")
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-before-change")
            row = next(catalog.iter_files(status=None))
            file_id = int(row["file_id"])
            _legacy_status(catalog, file_id, "quarantine", clear_anchors=True)
            path.write_text(_literal_book() + "新的尾声\n", encoding="utf-8")
            os.utime(path, None)
            result = revalidate_quarantined_literals(
                catalog,
                self.archive,
                workers=1,
                run_id="quality-changed",
                apply_changes=True,
            )
            self.assertEqual(result["unresolved"], 1)
            self.assertEqual(catalog.get_file(file_id)["scan_status"], "unstable")

    def test_revalidation_is_idempotent_and_restores_anchors(self) -> None:
        (self.source / "重新接入.txt").write_text(_literal_book(), encoding="utf-8")
        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-reconnect")
            row = next(catalog.iter_files(status=None))
            file_id = int(row["file_id"])
            expected_anchors = len(set(json.loads(row["sketch_json"])))
            _legacy_status(catalog, file_id, "quarantine", clear_anchors=True)

            first = revalidate_quarantined_literals(
                catalog,
                self.archive,
                workers=1,
                run_id="quality-first",
                apply_changes=True,
            )
            self.assertEqual(first["promoted"], 1)
            self.assertEqual(
                catalog.connection.execute(
                    "SELECT COUNT(*) FROM anchors WHERE file_id=?", (file_id,)
                ).fetchone()[0],
                expected_anchors,
            )

            second = revalidate_quarantined_literals(
                catalog,
                self.archive,
                workers=1,
                run_id="quality-second",
                apply_changes=True,
            )
            self.assertEqual(second["strict_checked"], 0)
            self.assertEqual(second["already_validated"], 1)
            self.assertEqual(catalog.get_file(file_id)["scan_status"], "ok")

    def test_legacy_ok_invalid_byte_is_demoted_and_new_plan_rejects_it(self) -> None:
        good = self.source / "可以保留.txt"
        bad = self.source / "旧缓存坏成员.txt"
        good.write_text(_literal_book(), encoding="utf-8")
        raw = bytearray(_literal_book(0, lines=18_000).encode("utf-8"))
        raw[len(raw) // 4 : len(raw) // 4] = b"\xff"
        bad.write_bytes(raw)

        with self._catalog() as catalog:
            _scan(catalog, self.source, self.archive, "scan-integration")
            rows = {Path(row["source_path"]).name: row for row in catalog.iter_files(status=None)}
            good_id = int(rows[good.name]["file_id"])
            bad_id = int(rows[bad.name]["file_id"])
            _legacy_status(catalog, good_id, "quarantine", clear_anchors=True)
            _legacy_status(catalog, bad_id, "ok", clear_anchors=False)

            result = revalidate_quarantined_literals(
                catalog,
                self.archive,
                workers=2,
                run_id="quality-integration",
                apply_changes=True,
            )
            self.assertEqual(result["promoted"], 1)
            self.assertEqual(result["demoted"], 1)
            self.assertEqual(catalog.get_file(good_id)["scan_status"], "ok")
            self.assertEqual(catalog.get_file(bad_id)["scan_status"], "quarantine")
            self.assertEqual(
                catalog.connection.execute(
                    "SELECT COUNT(*) FROM anchors WHERE file_id=?", (bad_id,)
                ).fetchone()[0],
                0,
            )

            plan_catalog(catalog, self.archive, run_id="plan-quality-integration")
            actions = {
                int(row["file_id"]): row["planned_action"]
                for row in catalog.plan_rows("plan-quality-integration")
            }
            self.assertIn(actions[good_id], {"canonical", "edition", "source_duplicate"})
            self.assertEqual(actions[bad_id], "delete_invalid")


if __name__ == "__main__":
    unittest.main()
