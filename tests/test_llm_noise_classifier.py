import json
import unittest

from Jormungandr.hardmodel.llm_noise_classifier import (
    QwenWeakNoiseClassifier,
    VLLMWeakNoiseClassifier,
)


class LLMNoiseClassifierTests(unittest.TestCase):
    def test_compact_actions_are_parsed(self):
        actions = QwenWeakNoiseClassifier._parse_actions(
            json.dumps([[7, "d"], [8, "t", "正文"]], ensure_ascii=False),
            [7, 8, 9],
        )

        self.assertEqual(
            actions,
            [
                {"candidate_id": 7, "action": "drop"},
                {"candidate_id": 8, "action": "trim", "cleaned_line": "正文"},
            ],
        )

    def test_compact_object_actions_are_parsed(self):
        actions = QwenWeakNoiseClassifier._parse_actions(
            json.dumps({"d": [7], "t": [[8, "正文"]]}, ensure_ascii=False),
            [7, 8, 9],
        )

        self.assertEqual(
            actions,
            [
                {"candidate_id": 7, "action": "drop"},
                {"candidate_id": 8, "action": "trim", "cleaned_line": "正文"},
            ],
        )

    def test_compact_prompt_omits_duplicate_current_context(self):
        candidate = {
            "candidate_id": 7,
            "line": "疑似广告",
            "context": [
                {"role": "before", "text": "上一行"},
                {"role": "current", "text": "疑似广告"},
                {"role": "after", "text": "下一行"},
            ],
            "prose_score": 0,
            "pattern_frequency_score": 2,
            "noise_score": 4,
            "boundary_zone": "edge",
            "weak_reason": "scored_noise_candidate",
        }

        prompt = VLLMWeakNoiseClassifier._build_prompt([candidate])

        self.assertEqual(prompt.count("疑似广告"), 1)
        self.assertIn("上一行", prompt)
        self.assertIn("下一行", prompt)
        self.assertIn("keep项必须省略", prompt)
        self.assertIn('只输出{\"d\":[],\"t\":[]}', prompt)

    def test_character_budget_splits_batches(self):
        classifier = VLLMWeakNoiseClassifier(
            batch_size=64,
            max_batch_characters=1_000,
        )
        candidates = [
            {
                "candidate_id": candidate_id,
                "line": "疑似噪声" * 80,
                "context": [],
            }
            for candidate_id in range(5)
        ]

        batches = classifier._build_batches(candidates)

        self.assertGreater(len(batches), 1)
        self.assertEqual(sum(len(batch) for batch in batches), len(candidates))


if __name__ == "__main__":
    unittest.main()
