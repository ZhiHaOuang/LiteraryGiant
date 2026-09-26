import tempfile
import unittest
from pathlib import Path

from Jormungandr.hardmodel.chapter_cleaner import CleanTextDraft, RawNovelBook


class HardmodelChapterSplittingTests(unittest.TestCase):
    def make_book(self, root: str) -> RawNovelBook:
        source = Path(root) / "source.txt"
        source.write_text("", encoding="utf-8")
        return RawNovelBook(source, book_id="id000001")

    def test_adjacent_duplicate_chapter_heading_is_collapsed(self):
        with tempfile.TemporaryDirectory() as root:
            chapters = self.make_book(root).split_chapters(
                "第4章 压惊汤\n第4章压惊汤\n正文第一段\n正文第二段\n第5章 后续\n下一章正文"
            )

        self.assertEqual([chapter.chapter_no for chapter in chapters], [4, 5])
        self.assertEqual(
            [chapter.chapter_id for chapter in chapters],
            ["id000001C000001", "id000001C000002"],
        )
        self.assertEqual(chapters[0].content, "正文第一段\n正文第二段")
        self.assertEqual(chapters[1].content, "下一章正文")

    def test_adjacent_different_chapter_numbers_are_not_collapsed(self):
        with tempfile.TemporaryDirectory() as root:
            chapters = self.make_book(root).split_chapters(
                "第4章 缺失正文\n第5章 正常\n正文"
            )

        self.assertEqual([chapter.chapter_no for chapter in chapters], [4, 5])
        self.assertEqual(chapters[0].content, "")
        self.assertEqual(chapters[1].content, "正文")

    def test_consecutive_section_labels_remain_inline_table_of_contents(self):
        with tempfile.TemporaryDirectory() as root:
            chapters = self.make_book(root).split_chapters(
                "第9章 正文\n前文\n总篇\n第一节 条目一\n第二节 条目二\n第三节 条目三\n后文\n第10章 后续\n下一章正文"
            )

        self.assertEqual([chapter.chapter_no for chapter in chapters], [9, 10])
        self.assertIn("第一节 条目一", chapters[0].content)
        self.assertIn("第三节 条目三", chapters[0].content)
        self.assertEqual(chapters[1].content, "下一章正文")

    def test_small_weak_noise_set_skips_llm_conservatively(self):
        with tempfile.TemporaryDirectory() as root:
            calls = []
            book = RawNovelBook(
                Path(root) / "source.txt",
                noise_classifier=lambda rows: calls.append(rows) or [],
                noise_classifier_min_windows=2,
            )
            draft = CleanTextDraft(
                kept=["疑似提示"],
                uncertain_windows=[{"candidate_id": 0, "kept_index": 0}],
            )
            book.apply_classifier_to_clean_text(draft, book.noise_classifier)

        self.assertEqual(calls, [])
        self.assertEqual(book.cleaning_stats["weak_classifier_calls"], 0)
        self.assertEqual(book.cleaning_stats["weak_classifier_skipped_below_threshold"], 1)

    def test_repetition_and_boundary_scores_do_not_create_noise_signal(self):
        with tempfile.TemporaryDirectory() as root:
            book = self.make_book(root)
            is_strong, is_weak, details = book._classify_line_details(
                "王易闻言，心中一片震动。",
                position_score=1,
                pattern_frequency_score=2,
            )

        self.assertFalse(is_strong)
        self.assertFalse(is_weak)
        self.assertEqual(details["noise_score"], 3)
        self.assertEqual(details["weak_reason"], "")

    def test_scores_still_promote_a_real_weak_noise_signal(self):
        with tempfile.TemporaryDirectory() as root:
            book = self.make_book(root)
            is_strong, is_weak, details = book._classify_line_details(
                "书友们记得收藏订阅支持本书",
                position_score=1,
                pattern_frequency_score=1,
            )

        self.assertFalse(is_strong)
        self.assertTrue(is_weak)
        self.assertEqual(details["weak_reason"], "scored_noise_candidate")

    def test_llm_drop_guard_keeps_story_mentions_and_chapter_titles(self):
        with tempfile.TemporaryDirectory() as root:
            book = self.make_book(root)
            story_candidate = {
                "line": "其宣传推广对于提升角色知名度至关重要。",
                "prose_score": 1,
                "pattern_frequency_score": 0,
            }
            dialogue_candidate = {
                "line": "“谢谢大家的支持，我们继续出发。”",
                "prose_score": 2,
                "pattern_frequency_score": 0,
            }
            chapter_candidate = {
                "line": "0108章 秦王破阵（3/10求首订）",
                "prose_score": 0,
                "pattern_frequency_score": 0,
            }

            self.assertFalse(book._is_safe_llm_drop(story_candidate))
            self.assertFalse(book._is_safe_llm_drop(dialogue_candidate))
            self.assertFalse(book._is_safe_llm_drop(chapter_candidate))

    def test_llm_drop_guard_allows_explicit_external_noise(self):
        with tempfile.TemporaryDirectory() as root:
            book = self.make_book(root)

            self.assertTrue(
                book._is_safe_llm_drop(
                    {
                        "line": "请持续关注我们，更新最快的小说网站www.example.com",
                        "prose_score": 1,
                        "pattern_frequency_score": 0,
                    }
                )
            )
            self.assertTrue(
                book._is_safe_llm_drop(
                    {
                        "line": "PS：今晚更新较晚，感谢书友们支持。",
                        "prose_score": 2,
                        "pattern_frequency_score": 0,
                    }
                )
            )
            self.assertTrue(
                book._is_safe_llm_drop(
                    {
                        "line": "欢迎加入『灵珑小说群』",
                        "prose_score": 0,
                        "pattern_frequency_score": 1,
                    }
                )
            )


if __name__ == "__main__":
    unittest.main()
