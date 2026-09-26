from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.export_human_library import (
    build_export_plan,
    copy_items,
    parse_literature_catalog,
    populate_source_sizes,
    verify_export,
    write_catalogs,
)


class HumanLibraryExportTest(unittest.TestCase):
    def test_independent_flat_copy_literature_ids_and_minimal_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "TaciturnRaw" / "01_RawData"
            target = root / "TaciturnHuman"
            literature = root / "GF72"
            first = raw / "00_xuanhuan" / "id000001"
            second = raw / "01_qihuan" / "id000003"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            (first / "source.txt").write_text("玄幻正文", encoding="utf-8")
            (second / "source.txt").write_text("奇幻正文", encoding="utf-8")
            long_title = "很长的中文标题" * 30
            rows = [
                {
                    "canonical_id": "id000001",
                    "category_code": "00",
                    "genre": "玄幻",
                    "title": long_title,
                    "author": "甲作者",
                    "edition_version": 1,
                    "display_filename": f"00_id000001_{long_title}_甲作者.txt",
                    "target_source": "00_xuanhuan/id000001/source.txt",
                    "characters": 4,
                    "tags": ["测试"],
                },
                {
                    "canonical_id": "id000003",
                    "category_code": "01",
                    "genre": "奇幻",
                    "title": "黎明",
                    "author": "乙作者",
                    "edition_version": 1,
                    "display_filename": "01_id000003_黎明_乙作者.txt",
                    "target_source": "01_qihuan/id000003/source.txt",
                    "characters": 4,
                    "tags": [],
                },
            ]
            (raw / "index.jsonl").write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                encoding="utf-8",
            )

            (literature / "英国文学" / "罗斯金").mkdir(parents=True)
            (literature / "英国文学" / "其他").mkdir(parents=True)
            pdf_one = literature / "英国文学" / "罗斯金" / "现代画家[英]罗斯金.陆平译.pdf"
            pdf_two = literature / "英国文学" / "其他" / "英国散文.王甲著.出版社.pdf"
            pdf_one.write_bytes(b"%PDF-one")
            pdf_two.write_bytes(b"%PDF-two")
            catalog = literature / "文学_文件目录.txt"
            catalog.write_text(
                "├── 英国文学\n"
                "│   ├── 罗斯金\n"
                "│   │   └── 现代画家[英]罗斯金.陆平译.pdf\n"
                "│   └── 其他\n"
                "│       └── 英国散文.王甲著.出版社.pdf\n",
                encoding="utf-8",
            )

            self.assertEqual(len(parse_literature_catalog(catalog)), 2)
            items = build_export_plan(raw, literature, target)
            self.assertEqual(len(items), 4)
            literature_items = [item for item in items if item.category_code == "22"]
            self.assertEqual(
                [item.canonical_id for item in literature_items],
                ["id000004", "id000005"],
            )
            self.assertEqual(literature_items[0].author, "罗斯金")
            overlong = next(item for item in items if item.canonical_id == "id000001")
            self.assertLessEqual(len(overlong.actual_filename.encode("utf-8")), 255)
            self.assertIn("id000001", overlong.actual_filename)

            populate_source_sizes(items, workers=2)
            result = copy_items(items, workers=2)
            self.assertEqual(result["copied"], 4)
            for item in items:
                self.assertTrue(item.target.is_file())
                self.assertNotEqual(item.source.stat().st_ino, item.target.stat().st_ino)
                self.assertEqual(item.source.read_bytes(), item.target.read_bytes())

            write_catalogs(items, target)
            verification = verify_export(items, target)
            self.assertEqual(verification["files"], 4)
            self.assertEqual(verification["literature_files"], 2)
            self.assertEqual(
                {path.name for path in (target / "02_Catalog").iterdir()},
                {"全部书目.xlsx", "分类目录"},
            )
            self.assertEqual(
                len(list((target / "02_Catalog" / "分类目录").glob("*.txt"))),
                23,
            )
            with zipfile.ZipFile(target / "02_Catalog" / "全部书目.xlsx") as archive:
                self.assertIn("xl/worksheets/sheet1.xml", archive.namelist())
            literature_text = (
                target / "02_Catalog" / "分类目录" / "22_文学.txt"
            ).read_text(encoding="utf-8")
            self.assertIn("英国文学", literature_text)
            self.assertIn("22_id000004_现代画家_罗斯金.pdf", literature_text)


if __name__ == "__main__":
    unittest.main()
