from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.migrate_taciturn_layout import apply_plan, build_plan, verify_layout


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def _raw_row(canonical: str, *, category: str = "20_qita") -> dict:
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    return {
        "layout_version": "taciturn-novels-raw-v2",
        "canonical_id": canonical,
        "content_id": canonical,
        "edition_id": f"ed_{digest[:24]}",
        "normalized_sha256": digest,
        "work_id": f"work_{canonical[2:]}",
        "category_code": category[:2],
        "category_dir": category,
        "version_label": "",
        "title": f"测试{canonical}",
        "author": "测试作者",
        "target_dir": f"{category}/{canonical}",
        "target_index": f"{category}/{canonical}/index.json",
        "target_source": f"{category}/{canonical}/source.txt",
    }


class TaciturnLayoutMigrationTest(unittest.TestCase):
    def test_full_source_migration_reuses_canonical_and_retires_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            library = root / "Library"
            raw_root = library / "TaciturnRaw/novels_raw"
            raw_rows = [_raw_row(value) for value in ("id000010", "id000011", "id000013", "id000014")]
            _write_jsonl(raw_root / "index.jsonl", raw_rows)
            for row in raw_rows:
                book = raw_root / row["target_dir"]
                book.mkdir(parents=True)
                (book / "source.txt").write_text(f"正文{row['canonical_id']}", encoding="utf-8")
                _write_json(book / "index.json", row)

            # An active legacy book, a retired incomplete book, an existing
            # canonical hardmodel result and one short story.
            cleaned = library / "TaciturnRaw/novels_cleaned"
            _write_json(
                cleaned / "book_0001/index.json",
                {
                    "book_metadata": {
                        "book_id": "0001",
                        "source_path": "Library/TaciturnRaw/novels_raw/book_0001",
                        "chapter_count": 1,
                    },
                    "chapter_manifest": [
                        {"order": 1, "chapter_id": "0001C0001", "file_name": "chapter_0001.json"}
                    ],
                    "chapter_anomalies": [
                        {"order": 9, "chapter_id": "0082C0009", "reasons": ["short"]}
                    ],
                },
            )
            _write_json(
                cleaned / "book_0001/chapter_0001.json",
                {
                    "chapter_id": "0001C0001",
                    "order": 1,
                    "content": "旧资源正文",
                    "metadata": {"book_id": "0001", "source_path": "rawdata/novels/book_0001/a.txt"},
                },
            )
            _write_json(
                cleaned / "book_0002/index.json",
                {"book_metadata": {"book_id": "0002", "chapter_count": 1}},
            )
            _write_json(
                cleaned / "id000014/index.json",
                {
                    "book_metadata": {
                        "book_id": "id000014",
                        "source_path": str(raw_root / "20_qita/id000014/source.txt"),
                        "chapter_count": 1,
                    }
                },
            )
            _write_json(
                cleaned / "id000014/chapter_0001.json",
                {
                    "chapter_id": "id000014C000001",
                    "order": 1,
                    "content": "已算正文",
                    "metadata": {
                        "source_path": str(
                            library
                            / "TaciturnRaw/novels_raw/20_qita/id000014/source.txt"
                        )
                    },
                },
            )

            chapter = library / "TaciturnRaw/novels_chapter"
            _write_json(
                chapter / "book_0001/index.json",
                {
                    "book_metadata": {"book_id": "0001"},
                    "source_book_dir": "Library/TaciturnRaw/novels_cleaned/book_0001",
                },
            )
            _write_json(
                chapter / "book_0001/chapter_0001.json",
                {
                    "chapter_context": {
                        "book_id": "0001",
                        "chapter_id": "0001C0001",
                        "order": 1,
                        "source_file": "reference/facts/cleaned_chapters/book_0001/chapter_0001.json",
                    },
                    "source_ref": {
                        "chapter_file": "reference/facts/cleaned_chapters/book_0001/chapter_0001.json"
                    },
                },
            )
            _write_json(chapter / "book_0002/index.json", {"book_metadata": {"book_id": "0002"}})

            stories = library / "TaciturnRaw/stories_raw"
            _write_json(
                stories / "story_0001/index.json",
                {"story_slug": "story_0001", "content_type": "story", "title": "短篇"},
            )
            (stories / "story_0001/story.txt").write_text("短篇正文", encoding="utf-8")

            bridge = library / "Bridges/novels_plot/book_0001"
            _write_json(
                bridge / "index.json",
                {
                    "book_metadata": {"book_id": "0001"},
                    "source_feature_dir": "Library/TaciturnRaw/novels_chapter/book_0001",
                },
            )
            _write_json(
                bridge / "plot1.json",
                {
                    "book_id": "0001",
                    "chapter_ids": ["0001C0001"],
                    "chapter_summaries": [
                        {
                            "chapter_id": "book_0001_chapter_0001_unit_01",
                            "unit_id": "book_0001_chapter_0001_unit_01",
                        }
                    ],
                    "summary": "book_0001 是普通文本",
                },
            )
            _write_jsonl(
                library / "AbstractLibrary/CharacterArc/emerging_patterns.jsonl",
                [
                    {
                        "pattern_id": "legacy_pattern",
                        "supported_books": ["book_0001"],
                        "note": "book_0001:plot1 是旧资源引用",
                        "candidate_id": "emotion_rhythm_book_01",
                    }
                ],
            )
            _write_json(
                library / "BridgeIndex/books/book_0001.stats.json",
                {"node_labels": ["book:book_0001"]},
            )
            _write_jsonl(
                library / "LLMExtracted/book_0001/extractions.jsonl",
                [{"book_id": "0001", "discarded_observations": ["book_0001:plot1 已丢弃"]}],
            )

            mappings = {
                "book:book_0001": "id000010",
                "story:story_0001": "id000013",
            }
            lineage_dir = root / "lineage"
            _write_json(
                lineage_dir / "canonical_id_lineage.json",
                {
                    "layout_version": "taciturn-canonical-id-lineage-v1",
                    "mappings": mappings,
                    "retired_identities": [
                        {
                            "identity_key": "book:book_0002",
                            "status": "retired_incomplete",
                            "requires_rebuild": True,
                            "reason": "excluded_incomplete_edition",
                            "source_canonical_id": "id000012",
                            "superseded_by": "id000011",
                            "review_id": "vr_test",
                        }
                    ],
                },
            )
            _write_jsonl(
                lineage_dir / "identity_lineage.jsonl",
                [
                    {
                        "identity_key": identity,
                        "canonical_id": canonical,
                        "normalized_sha256": next(
                            row["normalized_sha256"] for row in raw_rows if row["canonical_id"] == canonical
                        ),
                    }
                    for identity, canonical in mappings.items()
                ],
            )
            representatives = root / "representatives.json"
            _write_json(
                representatives,
                {"representatives": {"id000010": "book:book_0001", "id000013": "story:story_0001"}},
            )

            noise = library / "Noise"
            candidate = noise / "其他/20_id000012_残缺_佚名_v2.txt"
            preferred = noise / "其他/20_id000010_完整_佚名.txt"
            candidate.parent.mkdir(parents=True)
            candidate.write_text("残缺", encoding="utf-8")
            preferred.write_text("完整正文", encoding="utf-8")
            _write_jsonl(
                noise / "index.jsonl",
                [
                    {
                        "file": "其他/20_id000010_完整_佚名.txt",
                        "content_id": "id000010",
                        "normalized_sha256": hashlib.sha256("完整正文".encode()).hexdigest(),
                    },
                    {
                        "file": "其他/20_id000012_残缺_佚名_v2.txt",
                        "content_id": "id000012",
                        "normalized_sha256": hashlib.sha256("残缺".encode()).hexdigest(),
                    },
                ],
            )
            decisions = root / "decisions.jsonl"
            _write_jsonl(
                decisions,
                [
                    {
                        "review_id": "vr_test",
                        "work_id": "work_000010",
                        # The internal review ID can exceed the published raw
                        # high-water mark after a public-ID collision repair.
                        # It must still remain permanently reserved.
                        "candidate_id": "id000015",
                        "preferred_id": "id000010",
                        "candidate_source": str(candidate.resolve()),
                        "preferred_source": str(preferred.resolve()),
                        "model_result": {"confidence": 1.0},
                        "guarded_action": "recommend_remove_after_audit",
                        "guard_reason": "test_guard",
                        "publication_action": "exclude_incomplete_candidate_from_final_raw",
                    }
                ],
            )

            _write_json(
                library / "indexes/books.json",
                {
                    "layout_version": "novel-agent-data-v1",
                    "last_id": 2,
                    "books": {
                        "1": {"book_id": "1", "book_slug": "book_0001", "title": "完整"},
                        "2": {"book_id": "2", "book_slug": "book_0002", "title": "残缺"},
                    },
                },
            )
            _write_json(
                library / "indexes/stories.json",
                {
                    "layout_version": "novel-agent-data-v1",
                    "last_id": 1,
                    "books": {
                        "1": {
                            "book_id": "1",
                            "book_slug": "story_0001",
                            "story_slug": "story_0001",
                            "content_type": "story",
                            "title": "短篇",
                        }
                    },
                },
            )
            _write_json(
                library / "indexes/cleaned_books.json",
                {
                    "layout_version": "novel-agent-cleaned-registry-v1",
                    "last_id": 2,
                    "books": {
                        "0001": {"clean_id": "0001", "clean_slug": "book_0001", "title": "完整"},
                        "0002": {"clean_id": "0002", "clean_slug": "book_0002", "title": "残缺"},
                    },
                    "events": [],
                },
            )

            plan = build_plan(
                library,
                lineage_dir / "canonical_id_lineage.json",
                representatives,
                decisions,
            )
            self.assertEqual(plan["blockers"], [])
            result = apply_plan(plan, workers=4, audit_root=root / "audit")
            self.assertEqual(result["status"], "complete")
            self.assertFalse(candidate.exists())
            self.assertFalse((library / "TaciturnRaw/novels_raw").exists())
            self.assertTrue((library / "TaciturnRaw/01_RawData").is_dir())
            self.assertTrue((library / "TaciturnRaw/02_CleanedData/id000010").is_dir())
            self.assertTrue((library / "TaciturnRaw/02_CleanedData/id000014").is_dir())
            self.assertFalse((library / "TaciturnRaw/02_CleanedData/book_0002").exists())

            chapter_payload = json.loads(
                (library / "TaciturnRaw/02_CleanedData/id000010/chapter_0001.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(chapter_payload["chapter_id"], "id000010C000001")
            self.assertEqual(chapter_payload["metadata"]["book_id"], "id000010")
            cleaned_index = json.loads(
                (library / "TaciturnRaw/02_CleanedData/id000010/index.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                cleaned_index["chapter_anomalies"][0]["chapter_id"],
                "id000010C000009",
            )
            reused_payload = json.loads(
                (library / "TaciturnRaw/02_CleanedData/id000014/chapter_0001.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertIn(
                "/TaciturnRaw/01_RawData/",
                reused_payload["metadata"]["source_path"],
            )
            self.assertNotIn("/TaciturnRaw/novels_raw/", json.dumps(reused_payload))
            bridge_payload = json.loads(
                (library / "Bridges/novels_plot/id000010/plot1.json").read_text(encoding="utf-8")
            )
            self.assertEqual(bridge_payload["book_id"], "id000010")
            self.assertEqual(bridge_payload["chapter_ids"], ["id000010C000001"])
            self.assertEqual(
                bridge_payload["chapter_summaries"][0]["chapter_id"],
                "id000010_chapter_0001_unit_01",
            )
            self.assertEqual(
                bridge_payload["chapter_summaries"][0]["unit_id"],
                "id000010_chapter_0001_unit_01",
            )
            self.assertIn("id000010", bridge_payload["summary"])
            abstract_payload = json.loads(
                (library / "AbstractLibrary/CharacterArc/emerging_patterns.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()[0]
            )
            self.assertEqual(abstract_payload["supported_books"], ["id000010"])
            self.assertIn("id000010:plot1", abstract_payload["note"])
            self.assertEqual(
                abstract_payload["candidate_id"], "emotion_rhythm_book_01"
            )
            bridge_stats = json.loads(
                (library / "BridgeIndex/books/id000010.stats.json").read_text(encoding="utf-8")
            )
            self.assertEqual(bridge_stats["node_labels"], ["book:id000010"])
            extracted_payload = json.loads(
                (library / "LLMExtracted/id000010/extractions.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()[0]
            )
            self.assertEqual(extracted_payload["book_id"], "id000010")
            self.assertIn("id000010:plot1", extracted_payload["discarded_observations"][0])

            cleaned_registry = json.loads(
                (library / "indexes/cleaned_books.json").read_text(encoding="utf-8")
            )
            self.assertEqual(set(cleaned_registry["books"]), {"id000010", "id000014"})
            self.assertNotIn(
                "legacy_identities", cleaned_registry["books"]["id000010"]
            )
            self.assertTrue((library / "indexes/taciturn_hardmodel_gate.json").is_file())
            content_ids = json.loads(
                (library / "indexes/content_ids.json").read_text(encoding="utf-8")
            )
            self.assertEqual(content_ids["last_id"], 15)
            self.assertEqual(verify_layout(plan, library)["status"], "complete")

            # A resume after every physical operation has already committed
            # must retain source lineage and the original deletion audit.
            resumed = apply_plan(plan, workers=4, audit_root=root / "audit")
            self.assertEqual(resumed["status"], "complete")
            resumed_registry = json.loads(
                (library / "indexes/cleaned_books.json").read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "legacy_identities", resumed_registry["books"]["id000010"]
            )
            deletion_ledger = [
                json.loads(line)
                for line in (root / "audit/retired_incomplete_noise.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            self.assertIn("deleted_at", deletion_ledger[0])


if __name__ == "__main__":
    unittest.main()
