from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.novels_raw_migration import (
    apply_publication_decisions,
    build_plan,
    stage_plan,
    write_plan,
    write_version_review_plan,
)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


class NovelsRawMigrationTest(unittest.TestCase):
    def test_unique_ids_version_ranking_catalogues_and_non_destructive_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            noise = root / "Noise"
            (noise / "玄幻").mkdir(parents=True)
            payloads = {
                "玄幻/a.txt": "甲" * 100,
                "玄幻/b.txt": "甲" * 50,
                "玄幻/c.txt": "乙" * 80,
            }
            for relative, text in payloads.items():
                (noise / relative).write_text(text, encoding="utf-8")

            def row(
                relative: str,
                *,
                library_id: int,
                edition_id: str,
                work_id: str,
                characters: int,
                title: str,
            ) -> dict:
                text = payloads[relative]
                digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                return {
                    "import_status": "complete",
                    "library_id": library_id,
                    "edition_id": edition_id,
                    "work_id": work_id,
                    "edition_version": 1,
                    "characters": characters,
                    "category_code": "00",
                    "genre": "玄幻",
                    "file": relative,
                    "title": title,
                    "author": "测试作者",
                    "normalized_sha256": digest,
                    "tags": ["测试"],
                    "source_kind": "raw",
                    "source_priority": 0,
                    "sort_initial": "C",
                    "title_sort_key": title,
                    "author_sort_key": "测试作者",
                }

            index = root / "index.jsonl"
            _write_jsonl(
                index,
                [
                    row(
                        "玄幻/a.txt",
                        library_id=1,
                        edition_id="ed_a",
                        work_id="work_1",
                        characters=100,
                        title="长版",
                    ),
                    row(
                        "玄幻/b.txt",
                        library_id=2,
                        edition_id="ed_b",
                        work_id="work_1",
                        characters=50,
                        title="短版",
                    ),
                    row(
                        "玄幻/c.txt",
                        library_id=1,
                        edition_id="ed_c",
                        work_id="work_2",
                        characters=80,
                        title="另一书",
                    ),
                ],
            )
            repairs = root / "repairs.jsonl"
            _write_jsonl(
                repairs,
                [
                    {
                        "edition_id": "ed_c",
                        "old_canonical_id": "id000001",
                        "new_canonical_id": "id000003",
                    }
                ],
            )
            id_map = root / "id-map.json"
            id_map.write_text(
                json.dumps({"mappings": {"book:book_0099": "id000002"}}),
                encoding="utf-8",
            )

            review = root / "review.jsonl"
            _write_jsonl(
                review,
                [
                    {
                        "relation": "possible_incomplete",
                        "evidence_json": json.dumps(
                            {
                                "incomplete_candidate": True,
                                "shorter_file_id": 22,
                                "longer_file_id": 11,
                                "order_ratio": 1.0,
                                "sketch_containment": 1.0,
                            }
                        ),
                    }
                ],
            )
            # File IDs connect version decisions to direct content evidence.
            indexed_rows = [json.loads(line) for line in index.read_text(encoding="utf-8").splitlines()]
            indexed_rows[0]["file_id"] = 11
            indexed_rows[1]["file_id"] = 22
            indexed_rows[2]["file_id"] = 33
            _write_jsonl(index, indexed_rows)
            plan = build_plan(
                index,
                noise,
                collision_repairs=repairs,
                id_map=id_map,
                organizer_review=review,
            )
            self.assertEqual(plan["summary"]["books"], 3)
            self.assertEqual(plan["summary"]["unique_ids"], 3)
            self.assertEqual(plan["summary"]["id_repairs"], 1)
            decisions = {row["edition_id"]: row for row in plan["version_decisions"]}
            self.assertEqual(decisions["ed_a"]["disposition"], "preferred")
            self.assertEqual(
                decisions["ed_b"]["disposition"], "review_probable_incomplete"
            )
            self.assertEqual(decisions["ed_b"]["confidence"], "high")
            self.assertFalse(decisions["ed_b"]["automatic_delete"])

            plan_dir = root / "plan"
            write_plan(plan, plan_dir)
            catalogue = (plan_dir / "总目录.txt").read_text(encoding="utf-8")
            self.assertIn("玄幻 [00_xuanhuan]", catalogue)
            self.assertIn("测试作者", catalogue)

            review_dir = root / "version-review"
            review_summary = write_version_review_plan(
                plan,
                review_dir,
                batch_size=2,
            )
            self.assertEqual(review_summary["candidates"], 1)
            self.assertEqual(review_summary["probable_incomplete"], 1)
            review_row = json.loads(
                (review_dir / "candidates.jsonl").read_text(encoding="utf-8")
            )
            self.assertEqual(review_row["candidate"]["edition_id"], "ed_b")
            self.assertEqual(review_row["preferred"]["edition_id"], "ed_a")

            decisions = root / "decisions.jsonl"
            _write_jsonl(
                decisions,
                [
                    {
                        "candidate_id": "id000002",
                        "preferred_id": "id000001",
                        "review_id": "vr_000001",
                        "work_id": "work_1",
                        "publication_action": "exclude_incomplete_candidate_from_final_raw",
                    }
                ],
            )
            publish_plan = apply_publication_decisions(plan, decisions)
            self.assertEqual(publish_plan["summary"]["books"], 2)
            self.assertEqual(publish_plan["summary"]["publication_exclusions"], 1)
            self.assertNotIn(
                "id000002",
                {row["canonical_id"] for row in publish_plan["entries"]},
            )
            retained = {
                row["canonical_id"]: row for row in publish_plan["entries"]
            }["id000001"]
            self.assertEqual(
                retained["superseded_legacy_identities"],
                [
                    {
                        "identity_key": "book:book_0099",
                        "status": "retired_incomplete",
                        "source_canonical_id": "id000002",
                        "superseded_by": "id000001",
                        "requires_rebuild": True,
                        "review_id": "vr_000001",
                        "reason": "excluded_incomplete_edition",
                    }
                ],
            )
            published_plan_dir = root / "published-plan"
            write_plan(publish_plan, published_plan_dir)
            lineage = [
                json.loads(line)
                for line in (published_plan_dir / "identity_lineage.jsonl").read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            self.assertEqual(lineage[0]["identity_key"], "book:book_0099")
            self.assertEqual(lineage[0]["status"], "retired_incomplete")
            self.assertTrue(lineage[0]["requires_rebuild"])
            lineage_payload = json.loads(
                (published_plan_dir / "canonical_id_lineage.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(lineage_payload["mappings"], {})
            self.assertEqual(
                lineage_payload["retired_identities"][0]["superseded_by"], "id000001"
            )

            staging = root / "staging"
            result = stage_plan(
                plan,
                staging,
                limit=3,
                workers=3,
                verification_mode="trusted_frozen",
            )
            self.assertEqual(result["failed"], 0)
            self.assertEqual(result["written"], 3)
            self.assertEqual(result["workers"], 3)
            self.assertEqual(result["verification_mode"], "trusted_frozen")
            self.assertFalse(result["complete"])
            target = staging / "00_xuanhuan/id000001/source.txt"
            self.assertEqual(target.stat().st_ino, (noise / "玄幻/a.txt").stat().st_ino)
            self.assertTrue((staging / "00_xuanhuan/id000001/index.json").is_file())
            self.assertTrue((noise / "玄幻/a.txt").is_file())
            with self.assertRaisesRegex(ValueError, "only safe with hardlink"):
                stage_plan(
                    plan,
                    root / "unsafe-copy",
                    transfer_mode="copy",
                    verification_mode="trusted_frozen",
                )


if __name__ == "__main__":
    unittest.main()
