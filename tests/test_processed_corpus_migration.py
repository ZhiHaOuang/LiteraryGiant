from __future__ import annotations

import contextlib
import io
import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from fetcher.local_archive import apply_plan, plan_catalog, scan_sources
from fetcher.local_catalog import LocalNovelCatalog
from scripts.processed_corpus_migration import (
    ID_MAP_LAYOUT_VERSION,
    _deduplicate_reference_targets,
    allocate_incremental_ids,
    apply_export_plan,
    apply_reindex_plan,
    build_id_map_plan,
    build_export_plan,
    build_reindex_plan,
    discover_existing_entities,
    load_export_plan,
    load_reindex_plan,
    main,
    rewrite_json_payload,
    rewrite_reference_relative_path,
    write_export_plan,
    write_id_map,
    write_reindex_plan,
)


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


class ProcessedCorpusMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.library = self.root / "Library"
        self._build_fixture()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _build_fixture(self) -> None:
        raw_book = self.library / "TaciturnRaw/novels_raw/book_0001"
        raw_book.mkdir(parents=True)
        _write_json(
            raw_book / "index.json",
            {"book_slug": "book_0001", "title": "测试长篇", "author": "作者甲"},
        )
        (raw_book / "source.txt").write_text("未清洗的原始正文\n", encoding="utf-8")

        cleaned_book = self.library / "TaciturnRaw/novels_cleaned/book_0001"
        cleaned_book.mkdir(parents=True)
        _write_json(
            cleaned_book / "index.json",
            {
                "book_metadata": {
                    "book_id": "0001",
                    "source_path": "Library/TaciturnRaw/novels_raw/book_0001",
                    "source_lineage": {
                        "raw_book_slug": "book_0001",
                        "title": "测试长篇",
                        "author": "作者甲",
                    },
                },
                # Deliberately put the entries out of order.  The exporter must
                # use the numeric order, not manifest array or filename order.
                "chapter_manifest": [
                    {
                        "order": 2,
                        "chapter_id": "0001C0002",
                        "clean_title": "第二章 继续",
                        "file_name": "chapter_0002.json",
                    },
                    {
                        "order": 1,
                        "chapter_id": "0001C0001",
                        "clean_title": "第一章 开始",
                        "file_name": "chapter_0001.json",
                    },
                ],
            },
        )
        _write_json(
            cleaned_book / "chapter_0001.json",
            {
                "chapter_id": "0001C0001",
                "order": 1,
                "clean_title": "第一章 开始",
                "content": "清洗一",
            },
        )
        _write_json(
            cleaned_book / "chapter_0002.json",
            {
                "chapter_id": "0001C0002",
                "order": 2,
                "clean_title": "第二章 继续",
                "content": "清洗二",
            },
        )

        feature_book = self.library / "TaciturnRaw/novels_chapter/book_0001"
        _write_json(
            feature_book / "index.json",
            {
                "book_metadata": {"book_id": "0001"},
                "source_book_dir": "Library/TaciturnRaw/novels_cleaned/book_0001",
                "chapter_manifest": [
                    {
                        "order": 1,
                        "chapter_id": "0001C0001",
                        "file_name": "chapter_0001.json",
                    }
                ],
            },
        )

        raw_story = self.library / "TaciturnRaw/stories_raw/story_0001"
        raw_story.mkdir(parents=True)
        _write_json(
            raw_story / "index.json",
            {"story_slug": "story_0001", "title": "测试短篇", "content_type": "story"},
        )
        # The input contains a BOM; every exported source must not.
        (raw_story / "story.txt").write_bytes("\ufeff短篇正文\r\n".encode("utf-8"))

        bridge = self.library / "Bridges/novels_plot/book_0001"
        _write_json(
            bridge / "plot.json",
            {
                "book_id": "0001",
                "book_slug": "book_0001",
                "chapter_id": "0001C0002",
                "source_ref": {
                    "chapter_file": "Library/TaciturnRaw/novels_cleaned/book_0001/chapter_0002.json"
                },
                "evidence_chunk_ids": ["book_0001:plot_2"],
                "summary": "正文中写着 book_0001 时不应按普通文本替换。",
            },
        )

    def _export_and_index_rows(self) -> tuple[Path, list[dict]]:
        export = self.root / "export-for-map"
        apply_export_plan(build_export_plan(self.library), export)
        book_source = export / "imports/book_book_0001/source.txt"
        story_source = export / "imports/story_story_0001/source.txt"

        def row(
            source: Path,
            *,
            file_id: int,
            action: str,
            duplicate_of: int | None,
            library_id: int = 10,
            edition_id: str = "ed_111111111111111111111111",
            work_id: str = "work_000010",
        ) -> dict:
            canonical = f"id{library_id:06d}"
            return {
                "schema": "literary-giant-flat-index-v3",
                "file_id": file_id,
                "file": f"其他/00_{canonical}_测试_佚名.txt",
                "library_id": library_id,
                "book_id": canonical,
                "content_id": canonical,
                "catalog_id": f"00_{canonical}",
                "category_code": "00",
                "edition_version": 1,
                "edition_key": edition_id,
                "edition_id": edition_id,
                "work_id": work_id,
                "action": action,
                "duplicate_of_file_id": duplicate_of,
                "source_root": str(export.resolve()),
                "source_relative_path": source.relative_to(export).as_posix(),
                "source_kind": "existing_processed",
                "source_priority": 100,
                "raw_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "normalized_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "source_encoding": "utf-8",
                "import_status": "complete",
            }

        return export, [
            row(book_source, file_id=1, action="canonical", duplicate_of=None),
            row(story_source, file_id=2, action="source_duplicate", duplicate_of=1),
        ]

    def test_legacy_only_snapshot_excludes_provisional_canonical_outputs(self) -> None:
        provisional = self.library / "TaciturnRaw/novels_cleaned/id999999"
        provisional.mkdir(parents=True)
        _write_json(
            provisional / "index.json",
            {
                "book_metadata": {"book_id": "id999999", "title": "临时 canonical"},
                "chapter_manifest": [
                    {
                        "order": 1,
                        "file_name": "chapter_0001.json",
                        "chapter_id": "id999999C000001",
                    }
                ],
            },
        )
        _write_json(
            provisional / "chapter_0001.json",
            {"order": 1, "chapter_id": "id999999C000001", "content": "临时正文"},
        )

        all_identities = {item.identity_key for item in discover_existing_entities(self.library)}
        legacy_identities = {
            item.identity_key
            for item in discover_existing_entities(self.library, legacy_only=True)
        }
        self.assertIn("id:id999999", all_identities)
        self.assertNotIn("id:id999999", legacy_identities)
        self.assertIn("book:book_0001", legacy_identities)

    def test_export_is_cleaned_first_ordered_utf8_and_non_destructive(self) -> None:
        raw_source = self.library / "TaciturnRaw/novels_raw/book_0001/source.txt"
        original_raw = raw_source.read_bytes()

        plan = build_export_plan(self.library)
        self.assertEqual(plan["summary"]["entities"], 2)
        self.assertEqual(plan["summary"]["ready"], 2)
        book = next(item for item in plan["records"] if item["identity_key"] == "book:book_0001")
        self.assertEqual(book["selected_stage"], "novels_cleaned")
        self.assertEqual(book["chapter_count"], 2)
        self.assertFalse((self.root / "export").exists())

        result = apply_export_plan(plan, self.root / "export")
        self.assertEqual(result["failed"], 0)
        whole = self.root / "export/imports/book_book_0001/source.txt"
        self.assertEqual(
            whole.read_text(encoding="utf-8"),
            "第一章 开始\n\n清洗一\n\n第二章 继续\n\n清洗二\n",
        )
        self.assertFalse(whole.read_bytes().startswith(b"\xef\xbb\xbf"))
        story = self.root / "export/imports/story_story_0001/source.txt"
        self.assertEqual(story.read_text(encoding="utf-8"), "短篇正文\n")
        self.assertFalse(story.read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertEqual(raw_source.read_bytes(), original_raw)

        marker = json.loads((self.root / "export/export_marker.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["source_kind"], "existing_processed")
        self.assertEqual(marker["source_priority"], 100)
        self.assertFalse(marker["live_switch_performed"])

        provenance = json.loads(
            (self.root / "export/imports/book_book_0001/provenance.json").read_text(encoding="utf-8")
        )
        self.assertTrue(provenance["existing_processed"])
        self.assertEqual(provenance["source_kind"], "existing_processed")
        self.assertEqual(provenance["source_priority"], 100)
        self.assertEqual(
            [item["order"] for item in provenance["chapter_index"]],
            [1, 2],
        )

    def test_small_cleaned_placeholder_gap_is_recovered_and_audited(self) -> None:
        cleaned = self.library / "TaciturnRaw/novels_cleaned/book_0002"
        manifest = []
        for order in range(1, 21):
            name = f"chapter_{order:04d}.json"
            manifest.append({"order": order, "file_name": name})
            _write_json(
                cleaned / name,
                {
                    "order": order,
                    "clean_title": f"第{order}章",
                    "content": "" if order == 9 else f"正文{order}",
                },
            )
        _write_json(cleaned / "index.json", {"title": "缺一章测试", "chapter_manifest": manifest})

        first_plan = build_export_plan(self.library, workers=1)
        plan_dir = self.root / "first-plan"
        write_export_plan(first_plan, plan_dir)
        reused = load_export_plan(
            plan_dir,
            library_root=self.library,
            workers=4,
            refresh_unavailable=True,
        )
        book = next(item for item in reused["records"] if item["identity_key"] == "book:book_0002")
        self.assertEqual(book["status"], "ready")
        self.assertEqual(book["chapter_count"], 19)
        self.assertEqual(book["omitted_chapter_count"], 1)
        self.assertEqual(book["omitted_chapters"][0]["file_name"], "chapter_0009.json")

        result = apply_export_plan(reused, self.root / "recovered-export", workers=2)
        self.assertEqual(result["failed"], 0)
        provenance = json.loads(
            (
                self.root
                / "recovered-export/imports/book_book_0002/provenance.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(provenance["omitted_chapter_count"], 1)
        self.assertNotIn("正文9", (self.root / "recovered-export/imports/book_book_0002/source.txt").read_text())

    def test_organizer_trusts_only_hash_verified_processed_provenance(self) -> None:
        incoming = self.root / "incoming"
        exported = self.root / "existing-export" / "imports" / "book_book_0099"
        incoming.mkdir()
        exported.mkdir(parents=True)
        # A literal U+FFFD left by an older cleaner is valid UTF-8.  Both raw
        # and processed inputs may retain a very low rate after a full strict
        # decode proves that the character came from the source; processed
        # provenance still wins representative selection.
        text = (("第一章 开始\n\n这是经过清洗的既有正文内容。\n" * 400) + "�\n").encode("utf-8")
        (incoming / "新库里的别名-另一作者.txt").write_bytes(text)
        source = exported / "source.txt"
        source.write_bytes(text)
        _write_json(
            exported / "provenance.json",
            {
                "layout_version": "processed-existing-export-v1",
                "identity_key": "book:book_0099",
                "export_key": "book_book_0099",
                "kind": "book",
                "old_slug": "book_0099",
                "existing_processed": True,
                "source_kind": "existing_processed",
                "source_priority": 100,
                "source_sha256": hashlib.sha256(text).hexdigest(),
                "source_utf8_bytes": len(text),
                "title": "权威中文书名",
                "author": "作者甲",
            },
        )
        export_root = self.root / "existing-export"
        _write_json(
            export_root / "export_marker.json",
            {
                "layout_version": "processed-existing-export-v1",
                "stage_kind": "existing_processed_import_staging",
                "source_kind": "existing_processed",
                "source_priority": 100,
                "manifest": "export_manifest.jsonl",
                "imports_root": "imports",
                "live_switch_performed": False,
            },
        )
        _write_jsonl(
            export_root / "export_manifest.jsonl",
            [
                {
                    "identity_key": "book:book_0099",
                    "export_key": "book_book_0099",
                    "existing_processed": True,
                    "source_kind": "existing_processed",
                    "source_priority": 100,
                    "source_sha256": hashlib.sha256(text).hexdigest(),
                    "source_utf8_bytes": len(text),
                }
            ],
        )
        archive = self.root / "Noise"
        with LocalNovelCatalog(archive / ".state/catalog.sqlite3") as catalog:
            scan_sources(
                catalog,
                [incoming, self.root / "existing-export"],
                archive_root=archive,
                workers=1,
                stable_age_seconds=0,
                run_id="scan-existing-priority",
            )
            plan_catalog(catalog, archive, run_id="plan-existing-priority")
            canonical = next(
                row
                for row in catalog.plan_rows("plan-existing-priority")
                if row["planned_action"] == "canonical"
            )
            self.assertEqual(canonical["source_path"], str(source.resolve()))
            self.assertEqual(canonical["source_priority"], 100)
            self.assertEqual(canonical["source_kind"], "existing_processed")
            self.assertEqual(canonical["display_title"], "权威中文书名")
            self.assertEqual(canonical["author"], "作者甲")
            processed_row = catalog.connection.execute(
                "SELECT * FROM files WHERE source_kind='existing_processed'"
            ).fetchone()
            raw_row = catalog.connection.execute(
                "SELECT * FROM files WHERE source_kind='raw'"
            ).fetchone()
            self.assertEqual(processed_row["scan_status"], "ok")
            self.assertEqual(raw_row["scan_status"], "ok")
            self.assertIn(
                "encoding:strict-literal-ufffd-v1=1",
                raw_row["title_evidence_json"],
            )
            self.assertIn(
                "processed-export:verified-utf8-literal-replacements=1",
                processed_row["title_evidence_json"],
            )
            applied = apply_plan(
                catalog,
                archive,
                plan_run_id="plan-existing-priority",
                transfer_mode="copy",
                confirm_transfer_complete=True,
            )
            self.assertEqual(applied["status"], "complete")

        generated = build_id_map_plan(archive / "index.jsonl", export_root)
        self.assertEqual(
            generated["id_map"]["mappings"],
            {"book:book_0099": generated["id_map"]["occupied_ids"][0]},
        )
        self.assertEqual(
            generated["id_map"]["representatives"],
            {
                generated["id_map"]["occupied_ids"][0]: "book:book_0099",
            },
        )

        provenance_path = exported / "provenance.json"
        bad_provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        bad_provenance["source_sha256"] = "0" * 64
        _write_json(provenance_path, bad_provenance)
        bad_archive = self.root / "Noise-bad-provenance"
        with LocalNovelCatalog(bad_archive / ".state/catalog.sqlite3") as catalog:
            summary = scan_sources(
                catalog,
                [self.root / "existing-export"],
                archive_root=bad_archive,
                workers=1,
                stable_age_seconds=0,
                run_id="scan-bad-existing-provenance",
            )
            self.assertEqual(summary["statuses"].get("error"), 1)
            with self.assertRaisesRegex(RuntimeError, "unresolved"):
                plan_catalog(catalog, bad_archive, run_id="plan-must-refuse-bad-provenance")

    def test_reindex_uses_explicit_post_merge_map_and_only_writes_staging(self) -> None:
        export_plan = build_export_plan(self.library)
        apply_export_plan(export_plan, self.root / "export")
        id_map = {
            "layout_version": ID_MAP_LAYOUT_VERSION,
            "mappings": {
                "book:book_0001": "id000010",
                "story:story_0001": "id000011",
            },
            "representatives": {},
            "occupied_ids": ["id000010", "id000011"],
        }
        original_bridge = (
            self.library / "Bridges/novels_plot/book_0001/plot.json"
        ).read_bytes()

        plan = build_reindex_plan(self.library, self.root / "export", id_map)
        self.assertEqual(plan["summary"]["mapped"], 2)
        self.assertGreaterEqual(plan["summary"]["reference_files"], 1)
        self.assertFalse((self.root / "reindex").exists())

        saved_plan = self.root / "saved-reindex-plan"
        write_reindex_plan(plan, saved_plan)
        plan = load_reindex_plan(
            saved_plan,
            library_root=self.library,
            import_root=self.root / "export",
        )
        self.assertEqual(plan["summary"]["mapped"], 2)

        result = apply_reindex_plan(plan, self.root / "reindex")
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["collisions"], 0)
        canonical_source = self.root / "reindex/corpus/id000010/source.txt"
        self.assertEqual(
            canonical_source.read_bytes(),
            (self.root / "export/imports/book_book_0001/source.txt").read_bytes(),
        )
        canonical_index = json.loads(
            (self.root / "reindex/corpus/id000010/index.json").read_text(encoding="utf-8")
        )
        self.assertEqual(canonical_index["id"], "id000010")
        self.assertEqual(canonical_index["content_id"], "id000010")
        self.assertEqual(canonical_index["content_type"], "content")
        self.assertEqual(
            [item["chapter_id"] for item in canonical_index["chapter_index"]],
            ["id000010C000001", "id000010C000002"],
        )

        rewritten_bridge = json.loads(
            (
                self.root
                / "reindex/references/Bridges/novels_plot/id000010/plot.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(rewritten_bridge["book_id"], "id000010")
        self.assertEqual(rewritten_bridge["book_slug"], "id000010")
        self.assertEqual(rewritten_bridge["chapter_id"], "id000010C000002")
        self.assertIn("/id000010/", rewritten_bridge["source_ref"]["chapter_file"])
        self.assertEqual(rewritten_bridge["evidence_chunk_ids"], ["id000010:plot_2"])
        self.assertIn("book_0001", rewritten_bridge["summary"])
        self.assertEqual(
            (self.library / "Bridges/novels_plot/book_0001/plot.json").read_bytes(),
            original_bridge,
        )

    def test_reference_target_merge_prefers_canonical_representative(self) -> None:
        rewrites = [
            {
                "relative_path": "TaciturnRaw/novels_raw/book_0002/index.json",
                "target_relative_path": "TaciturnRaw/novels_raw/id000010/index.json",
            },
            {
                "relative_path": "TaciturnRaw/novels_raw/book_0001/index.json",
                "target_relative_path": "TaciturnRaw/novels_raw/id000010/index.json",
            },
        ]
        selected, aliases = _deduplicate_reference_targets(
            rewrites,
            {"representatives": {"id000010": "book:book_0002"}},
        )
        self.assertEqual(len(selected), 1)
        self.assertEqual(
            selected[0]["relative_path"],
            "TaciturnRaw/novels_raw/book_0002/index.json",
        )
        self.assertEqual(
            aliases[0]["dropped_sources"],
            ["TaciturnRaw/novels_raw/book_0001/index.json"],
        )

    def test_build_id_map_verifies_sources_and_uses_unique_cluster_representative(self) -> None:
        export, rows = self._export_and_index_rows()
        # Repeating a row for the same old identity is harmless only when its
        # verified hash, final ID, and organizer cluster are all unchanged.
        rows.insert(1, dict(rows[0]))
        rows.append(
            {
                "schema": "literary-giant-flat-index-v3",
                "file_id": 3,
                "file": "其他/00_id000011_新书_佚名.txt",
                "library_id": 11,
                "book_id": "id000011",
                "content_id": "id000011",
                "catalog_id": "00_id000011",
                "category_code": "00",
                "edition_version": 1,
                "edition_key": "ed_222222222222222222222222",
                "edition_id": "ed_222222222222222222222222",
                "work_id": "work_000011",
                "action": "canonical",
                "duplicate_of_file_id": None,
                "source_root": str((self.root / "incoming").resolve()),
                "source_relative_path": "new.txt",
                "source_kind": "raw",
                "source_priority": 0,
                "raw_sha256": "2" * 64,
                "source_encoding": "utf-8",
                "import_status": "complete",
            }
        )
        index = self.root / "Noise/index.jsonl"
        _write_jsonl(index, rows)

        plan = build_id_map_plan(index, export)
        self.assertEqual(
            plan["id_map"]["mappings"],
            {
                "book:book_0001": "id000010",
                "story:story_0001": "id000010",
            },
        )
        self.assertEqual(
            plan["id_map"]["representatives"],
            {"id000010": "book:book_0001"},
        )
        self.assertEqual(plan["id_map"]["occupied_ids"], ["id000010", "id000011"])
        self.assertEqual(plan["summary"]["duplicate_processed_rows"], 1)
        self.assertEqual(plan["summary"]["multi_identity_clusters"], 1)

        output = self.root / "generated/id_map.json"
        self.assertFalse(output.exists())
        self.assertEqual(write_id_map(plan, output), "written")
        self.assertEqual(
            json.loads(output.read_text(encoding="utf-8")),
            plan["id_map"],
        )

    def test_build_id_map_supplements_public_index_duplicates_from_frozen_plan(self) -> None:
        export, rows = self._export_and_index_rows()
        representative, duplicate = rows
        # Real Library/Noise/index.jsonl is a public edition catalog and omits
        # source_duplicate rows.  The frozen plan is the source ledger.
        index = self.root / "Noise/index.jsonl"
        _write_jsonl(index, [representative])

        def plan_row(index_row: dict, *, action: str) -> dict:
            source = (
                Path(index_row["source_root"])
                / str(index_row["source_relative_path"])
            ).resolve()
            return {
                "plan_run_id": "frozen-content-plan",
                "file_id": index_row["file_id"],
                "planned_action": action,
                "duplicate_of_file_id": (
                    representative["file_id"] if action == "source_duplicate" else None
                ),
                "duplicate_kind": "same_edition" if action == "source_duplicate" else "",
                "duplicate_evidence_json": json.dumps(
                    {
                        "exact": False,
                        "length_ratio": 0.999,
                        "order_ratio": 1.0,
                        "shared_anchors": 96,
                        "sketch_containment": 1.0,
                        "sketch_jaccard": 1.0,
                        # Deliberately low: title similarity is not a matching input.
                        "title_similarity": 0.0,
                    }
                ),
                "library_id": representative["library_id"],
                "edition_id": representative["edition_id"],
                "work_id": representative["work_id"],
                "edition_version": representative["edition_version"],
                "raw_destination": representative["file"],
                "source_path": str(source),
                "source_root": index_row["source_root"],
                "relative_path": index_row["source_relative_path"],
                "source_kind": "existing_processed",
                "source_priority": 100,
                "raw_sha256": index_row["raw_sha256"],
                "normalized_sha256": index_row["normalized_sha256"],
                "encoding": "utf-8",
            }

        frozen_plan = self.root / "frozen-plan/plan.jsonl"
        _write_jsonl(
            frozen_plan,
            [
                plan_row(representative, action="canonical"),
                plan_row(duplicate, action="source_duplicate"),
            ],
        )

        with self.assertRaisesRegex(ValueError, "identity set mismatch"):
            build_id_map_plan(index, export)

        generated = build_id_map_plan(
            index,
            export,
            organizer_plan=frozen_plan,
        )
        self.assertEqual(
            generated["id_map"]["mappings"],
            {
                "book:book_0001": "id000010",
                "story:story_0001": "id000010",
            },
        )
        self.assertEqual(
            generated["id_map"]["representatives"],
            {"id000010": "book:book_0001"},
        )
        self.assertEqual(generated["summary"]["supplemented_processed_duplicates"], 1)
        story = next(
            item
            for item in generated["processed_identities"]
            if item["identity_key"] == "story:story_0001"
        )
        self.assertEqual(story["index_lines"], [])
        self.assertEqual(story["plan_lines"], [2])

        unsafe_rows = [
            plan_row(representative, action="canonical"),
            plan_row(duplicate, action="source_duplicate"),
        ]
        unsafe_evidence = json.loads(unsafe_rows[1]["duplicate_evidence_json"])
        unsafe_evidence.update(
            {
                "length_ratio": 0.5,
                "sketch_containment": 0.2,
                "title_similarity": 1.0,
            }
        )
        unsafe_rows[1]["duplicate_evidence_json"] = json.dumps(unsafe_evidence)
        unsafe_plan = self.root / "unsafe-title-only-plan/plan.jsonl"
        _write_jsonl(unsafe_plan, unsafe_rows)
        with self.assertRaisesRegex(ValueError, "below safety thresholds"):
            build_id_map_plan(index, export, organizer_plan=unsafe_plan)

    def test_build_id_map_cli_is_dry_run_without_explicit_output(self) -> None:
        export, rows = self._export_and_index_rows()
        index = self.root / "Noise/index.jsonl"
        _write_jsonl(index, rows)
        plan_dir = self.root / "must-not-exist"
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            exit_code = main(
                [
                    "build-id-map",
                    "--organizer-index",
                    str(index),
                    "--import-root",
                    str(export),
                ]
            )
        self.assertEqual(exit_code, 0)
        self.assertFalse(plan_dir.exists())
        output = json.loads(stdout.getvalue())
        self.assertTrue(output["result"]["dry_run"])
        self.assertIsNone(output["result"]["output_id_map"])

    def test_build_id_map_rejects_hash_id_cluster_and_base_map_conflicts(self) -> None:
        export, rows = self._export_and_index_rows()
        index = self.root / "Noise/index.jsonl"

        bad_hash = [dict(row) for row in rows]
        bad_hash[0]["raw_sha256"] = "0" * 64
        _write_jsonl(index, bad_hash)
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            build_id_map_plan(index, export)

        _write_jsonl(index, rows[:1])
        with self.assertRaisesRegex(ValueError, "identity set mismatch"):
            build_id_map_plan(index, export)

        rejected_processed = [dict(row) for row in rows]
        rejected_processed[1].update(
            {
                "library_id": None,
                "book_id": None,
                "content_id": None,
                "catalog_id": None,
                "file": None,
                "import_status": "conversion_rejected",
            }
        )
        _write_jsonl(index, rejected_processed)
        with self.assertRaisesRegex(ValueError, "processed source has no final id"):
            build_id_map_plan(index, export)

        different_id = [dict(row) for row in rows]
        repeated = dict(different_id[0])
        repeated.update(
            {
                "library_id": 12,
                "book_id": "id000012",
                "content_id": "id000012",
                "catalog_id": "00_id000012",
                "file": "其他/00_id000012_测试_佚名.txt",
                "edition_id": "ed_333333333333333333333333",
                "edition_key": "ed_333333333333333333333333",
                "work_id": "work_000012",
            }
        )
        different_id.append(repeated)
        _write_jsonl(index, different_id)
        with self.assertRaisesRegex(ValueError, "maps to multiple final ids"):
            build_id_map_plan(index, export)

        different_cluster = [dict(row) for row in rows]
        different_cluster[1]["edition_id"] = "ed_444444444444444444444444"
        different_cluster[1]["edition_key"] = "ed_444444444444444444444444"
        _write_jsonl(index, different_cluster)
        with self.assertRaisesRegex(ValueError, "multiple organizer clusters"):
            build_id_map_plan(index, export)

        _write_jsonl(index, rows)
        conflicting_base = {
            "layout_version": ID_MAP_LAYOUT_VERSION,
            "mappings": {"book:book_0001": "id000099"},
            "representatives": {"id000099": "book:book_0001"},
            "occupied_ids": ["id000099"],
        }
        with self.assertRaisesRegex(ValueError, "mapping conflict"):
            build_id_map_plan(index, export, base_id_map=conflicting_base)

        retained_source = export / "imports/book_book_0001/source.txt"
        retained_source.unlink()
        with self.assertRaisesRegex(FileNotFoundError, "retain/copy export staging"):
            build_id_map_plan(index, export)

    def test_build_id_map_rejects_two_representatives_for_one_id(self) -> None:
        export, rows = self._export_and_index_rows()
        rows[1]["action"] = "canonical"
        rows[1]["duplicate_of_file_id"] = None
        index = self.root / "Noise/index.jsonl"
        _write_jsonl(index, rows)
        with self.assertRaisesRegex(ValueError, "exactly one organizer representative"):
            build_id_map_plan(index, export)

    def test_build_id_map_can_audit_and_repair_distinct_clusters_sharing_an_id(self) -> None:
        export, rows = self._export_and_index_rows()
        rows[1].update(
            {
                "action": "canonical",
                "duplicate_of_file_id": None,
                "edition_id": "ed_444444444444444444444444",
                "edition_key": "ed_444444444444444444444444",
                "file": "其他/00_id000010_另一版本_佚名.txt",
            }
        )
        index = self.root / "Noise/index.jsonl"
        _write_jsonl(index, rows)

        with self.assertRaisesRegex(ValueError, "multiple organizer clusters"):
            build_id_map_plan(index, export)

        repaired = build_id_map_plan(
            index,
            export,
            repair_id_collisions=True,
        )
        self.assertEqual(repaired["summary"]["repaired_id_collisions"], 1)
        self.assertEqual(
            repaired["id_map"]["mappings"],
            {
                "book:book_0001": "id000010",
                "story:story_0001": "id000011",
            },
        )
        self.assertEqual(
            repaired["id_collision_repairs"][0]["new_canonical_id"],
            "id000011",
        )

    def test_incremental_allocator_never_renumbers_or_fills_old_slots(self) -> None:
        existing = {
            "mappings": {"book:book_0001": "id000100"},
            "representatives": {},
            "occupied_ids": ["id000250"],
        }
        allocated = allocate_incremental_ids(
            ["book:book_0001", "book:book_0002", "story:story_0001"],
            existing,
        )
        self.assertEqual(allocated["mappings"]["book:book_0001"], "id000100")
        self.assertEqual(allocated["mappings"]["book:book_0002"], "id000251")
        self.assertEqual(allocated["mappings"]["story:story_0001"], "id000252")

    def test_existing_canonical_id_can_be_remapped_in_staged_references(self) -> None:
        mappings = {"id:id000010": "id000099"}
        payload = {
            "content_id": "id000010",
            "book_id": "id000010",
            "chapter_id": "id000010C0002",
            "source_ref": {
                "chapter_file": "TaciturnRaw/novels_cleaned/id000010/chapter_0002.json"
            },
            "evidence_chunk_ids": ["id000010:plot_2"],
            "chunk_id": "id000010C0002-ck-001",
        }

        rewritten, changes = rewrite_json_payload(
            payload,
            mappings,
            default_kind="book",
        )

        self.assertTrue(changes)
        self.assertEqual(rewritten["content_id"], "id000099")
        self.assertEqual(rewritten["book_id"], "id000099")
        self.assertEqual(rewritten["chapter_id"], "id000099C000002")
        self.assertIn("/id000099/", rewritten["source_ref"]["chapter_file"])
        self.assertEqual(rewritten["evidence_chunk_ids"], ["id000099:plot_2"])
        self.assertEqual(rewritten["chunk_id"], "id000099C000002-ck-001")
        self.assertEqual(
            rewrite_reference_relative_path(
                "Bridges/novels_plot/id000010/plot.json",
                mappings,
            ),
            "Bridges/novels_plot/id000099/plot.json",
        )

    def test_different_exports_cannot_share_id_without_representative(self) -> None:
        export_plan = build_export_plan(self.library)
        apply_export_plan(export_plan, self.root / "export")
        id_map = {
            "layout_version": ID_MAP_LAYOUT_VERSION,
            "mappings": {
                "book:book_0001": "id000010",
                "story:story_0001": "id000010",
            },
            "representatives": {},
            "occupied_ids": ["id000010"],
        }
        plan = build_reindex_plan(self.library, self.root / "export", id_map)
        result = apply_reindex_plan(plan, self.root / "collision-reindex")
        self.assertEqual(result["collisions"], 1)
        self.assertFalse((self.root / "collision-reindex/corpus/id000010").exists())


if __name__ == "__main__":
    unittest.main()
