from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from Jormungandr.hardmodel.processor import process_book_source
from Jormungandr.hardmodel.manifest_writer import (
    resolve_output_dir,
    write_result_file,
)
from Jormungandr.hardmodel.source_resolver import resolve_input
from Jormungandr.hardmodel.validator import (
    HardmodelValidationError,
    validate_processed_book_result,
)
from shared.cleaned_registry import CleanedBookRegistry
from shared.stage_queue import _is_complete_cleaned_entry
from shared.utils import (
    canonical_book_slug,
    canonical_content_id,
    chapter_id_for,
    content_id_number,
)
from scripts.validate_data_layout import book_slug, iter_book_dirs


class UnifiedContentIdTests(unittest.TestCase):
    def test_unified_and_legacy_ids_parse_deterministically(self) -> None:
        self.assertEqual(canonical_content_id("book_0042"), "id000042")
        self.assertEqual(canonical_content_id("story_0042"), "id000042")
        self.assertEqual(canonical_content_id("id42"), "id000042")
        self.assertEqual(content_id_number("id000042"), 42)

    def test_pipeline_slug_preserves_unified_id(self) -> None:
        self.assertEqual(canonical_book_slug("id000042"), "id000042")
        self.assertEqual(canonical_book_slug("42"), "id000042")
        with self.assertRaisesRegex(ValueError, "reviewed migration map"):
            canonical_book_slug("book_0042")
        self.assertEqual(chapter_id_for("id42", 7), "id000042C000007")
        self.assertEqual(chapter_id_for("0042", 7), "id000042C000007")
        with self.assertRaisesRegex(ValueError, "reviewed migration map"):
            chapter_id_for("book_0042", 7)

    def test_hardmodel_and_clean_registry_keep_type_neutral_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_dir = root / "id000042"
            source_dir.mkdir()
            (source_dir / "source.txt").write_text("第一章 开始\n\n正文。\n", encoding="utf-8")
            (source_dir / "index.json").write_text(
                json.dumps(
                    {
                        "content_id": "id000042",
                        "book_id": "id000042",
                        "title": "测试作品",
                        "content_type": "content",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            source = resolve_input(source_dir)[0]
            self.assertEqual(source.book_id, "id000042")
            registry = CleanedBookRegistry(root / "cleaned.json")
            entry = registry.register_source(source, output_root=root / "cleaned")
            self.assertEqual(entry["clean_id"], "id000042")
            self.assertEqual(entry["clean_slug"], "id000042")
            self.assertEqual(registry.payload["last_id"], 42)

    def test_hardmodel_treats_category_txt_files_as_separate_works(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            category = Path(temporary) / "03_科幻"
            category.mkdir()
            (category / "03_id000002_B书_作者乙.txt").write_text("第二本", encoding="utf-8")
            (category / "03_id000001_A书_作者甲.txt").write_text("第一本", encoding="utf-8")

            sources = resolve_input(category)
            self.assertEqual([source.book_id for source in sources], ["id000001", "id000002"])
            self.assertTrue(all(source.mode == "whole" for source in sources))
            self.assertTrue(all(source.content_type == "content" for source in sources))
            self.assertEqual([source.title for source in sources], ["A书", "B书"])

    def test_hardmodel_recurses_machine_category_dirs_and_ignores_catalog_txt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "novels_raw"
            category = root / "12_kehuan"
            book = category / "id000042"
            book.mkdir(parents=True)
            (root / "总目录.txt").write_text("人类可读总目录", encoding="utf-8")
            (category / "目录.txt").write_text("人类可读分类目录", encoding="utf-8")
            (book / "source.txt").write_text("第一章\n正文", encoding="utf-8")
            (book / "index.json").write_text(
                json.dumps(
                    {
                        "content_id": "id000042",
                        "title": "分类目录测试",
                        "content_type": "content",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            sources = resolve_input(root)
            self.assertEqual(len(sources), 1)
            self.assertEqual(sources[0].book_id, "id000042")
            self.assertEqual(sources[0].title, "分类目录测试")

    def test_mixed_archive_directory_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            category = Path(temporary) / "科幻"
            category.mkdir()
            (category / "12_id000001_A书_作者甲.txt").write_text("正文", encoding="utf-8")
            (category / "上传中的临时文件.txt").write_text("正文", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "mixed unified-archive"):
                resolve_input(category)

    def test_duplicate_unified_id_fails_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            category = Path(temporary) / "科幻"
            category.mkdir()
            (category / "12_id000001_A书_作者甲.txt").write_text("正文一", encoding="utf-8")
            (category / "12_id000001_B书_作者乙.txt").write_text("正文二", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Duplicate unified content id id000001"):
                resolve_input(category)

    def test_hardmodel_emits_six_digit_chapter_ids_for_unified_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_path = Path(temporary) / "12_id000042_测试作品_作者甲.txt"
            source_path.write_text(
                "第一章 开始\n\n这是第一章的正文内容。\n\n"
                "第二章 继续\n\n这是第二章的正文内容。\n",
                encoding="utf-8",
            )
            source = resolve_input(source_path)[0]
            result = process_book_source(source)

            self.assertEqual(result["book_metadata"]["book_id"], "id000042")
            self.assertEqual(
                [chapter["chapter_id"] for chapter in result["chapters"]],
                ["id000042C000001", "id000042C000002"],
            )
            output_dir = resolve_output_dir(
                result,
                output_root=Path(temporary) / "cleaned",
            )
            write_result_file(output_dir, result)
            self.assertEqual(output_dir.name, "id000042")
            written_index = json.loads(
                (output_dir / "index.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                written_index["chapter_manifest"][0]["chapter_id"],
                "id000042C000001",
            )

    def test_validator_rejects_foreign_canonical_chapter_prefix(self) -> None:
        payload = {
            "book_metadata": {"book_id": "id000042", "chapter_count": 1},
            "chapters": [
                {
                    "chapter_id": "id999999C000001",
                    "order": 1,
                    "clean_title": "第一章",
                    "content": "正文",
                }
            ],
        }
        with self.assertRaisesRegex(HardmodelValidationError, "id000042C000001"):
            validate_processed_book_result(payload)

    def test_clean_registry_rejects_legacy_and_unified_numeric_double_booking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry_path = root / "cleaned.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "layout_version": "novel-agent-cleaned-registry-v1",
                        "last_id": 42,
                        "books": {
                            "0042": {
                                "clean_id": "0042",
                                "clean_slug": "book_0042",
                                "status": "active",
                                "raw": {"raw_book_slug": "book_0042"},
                            }
                        },
                        "deleted": {},
                        "events": [],
                    }
                ),
                encoding="utf-8",
            )
            source_dir = root / "id000042"
            source_dir.mkdir()
            (source_dir / "source.txt").write_text("第一章\n正文", encoding="utf-8")
            (source_dir / "index.json").write_text(
                json.dumps({"content_id": "id000042", "title": "新归档"}),
                encoding="utf-8",
            )
            source = resolve_input(source_dir)[0]
            registry = CleanedBookRegistry(registry_path)

            with self.assertRaisesRegex(ValueError, "logical id collision"):
                registry.register_source(source, output_root=root / "cleaned")

    def test_content_entry_is_queue_eligible_and_layout_sees_id_dir(self) -> None:
        entry = {
            "status": "active",
            "content_type": "content",
            "raw": {"chapter_count": 1},
            "last_cleaned": {"chapter_count": 12},
        }
        self.assertTrue(_is_complete_cleaned_entry(entry))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "id000042").mkdir()
            (root / "book_0043").mkdir()
            self.assertEqual(book_slug("id42"), "id000042")
            self.assertEqual([path.name for path in iter_book_dirs(root, None)], ["id000042"])


if __name__ == "__main__":
    unittest.main()
