from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.review_novel_versions_vllm import build_review_payload, guard_result


class VersionReviewVllmTest(unittest.TestCase):
    def test_bounded_samples_and_delete_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.txt"
            preferred = root / "preferred.txt"
            candidate.write_text("开头\n" + "甲" * 10000 + "\n未完", encoding="utf-8")
            preferred.write_text("开头\n" + "甲" * 10000 + "\n大结局", encoding="utf-8")
            row = {
                "review_id": "vr_000001",
                "work_id": "work_1",
                "disposition": "review_probable_incomplete",
                "length_ratio": 0.5,
                "incomplete_evidence": {"sketch_containment": 1.0},
                "candidate": {
                    "canonical_id": "id000001",
                    "title": "测试",
                    "author": "甲",
                    "characters": 10000,
                    "source_file": str(candidate),
                },
                "preferred": {
                    "canonical_id": "id000002",
                    "title": "测试",
                    "author": "甲",
                    "characters": 20000,
                    "source_file": str(preferred),
                },
            }
            payload = build_review_payload(row, sample_chars=120)
            self.assertLessEqual(len(payload["candidate"]["samples"]["ending"]), 120)
            guarded = guard_result(
                row,
                {
                    "decision": "candidate_incomplete",
                    "confidence": 0.9,
                    "candidate_has_ending": False,
                    "preferred_has_additional_chapters": True,
                    "evidence": ["候选结尾截断"],
                },
            )
            self.assertEqual(guarded["guarded_action"], "recommend_remove_after_audit")
            self.assertFalse(guarded["automatic_delete"])

            row["incomplete_evidence"] = None
            guarded = guard_result(
                row,
                {
                    "decision": "candidate_incomplete",
                    "confidence": 0.99,
                    "candidate_has_ending": False,
                    "preferred_has_additional_chapters": True,
                    "evidence": ["模型单独判断"],
                },
            )
            self.assertEqual(guarded["guarded_action"], "secondary_review")

            row["incomplete_evidence"] = {"sketch_containment": 1.0}
            guarded = guard_result(
                row,
                {
                    "decision": "candidate_incomplete",
                    "confidence": 0.99,
                    "candidate_has_ending": True,
                    "preferred_has_additional_chapters": False,
                    "evidence": ["未确认存在后续章节"],
                },
            )
            self.assertEqual(guarded["guarded_action"], "secondary_review")


if __name__ == "__main__":
    unittest.main()
