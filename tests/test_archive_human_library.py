from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.archive_human_library import (
    build_archive_plan,
    copy_catalog,
    create_archives,
    verify_archives,
)


class HumanLibraryArchiveTest(unittest.TestCase):
    def test_bounded_zip64_shards_resume_and_minimal_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "TaciturnHuman"
            target = root / "TaciturnHumanZip"
            raw = source / "01_RawData"
            for code in range(23):
                label = "文学" if code == 22 else f"类别{code:02d}"
                category = raw / f"{code:02d}_{label}"
                category.mkdir(parents=True)
                suffix = ".pdf" if code == 22 else ".txt"
                for item in range(3):
                    identifier = code * 10 + item + 1
                    filename = (
                        f"{code:02d}_id{identifier:06d}_书{item}_作者{item}{suffix}"
                    )
                    (category / filename).write_bytes(bytes([65 + item]) * (10 + item))
            catalog = source / "02_Catalog"
            (catalog / "分类目录").mkdir(parents=True)
            (catalog / "全部书目.xlsx").write_bytes(b"xlsx")
            (catalog / "分类目录" / "00_类别00.txt").write_text(
                "目录", encoding="utf-8"
            )

            shards = build_archive_plan(
                source,
                target,
                max_files=2,
                max_bytes=1_024,
            )
            self.assertEqual(len(shards), 46)
            self.assertTrue(all(len(shard.entries) <= 2 for shard in shards))
            result = create_archives(
                shards,
                workers=2,
                compression_level=6,
                minimum_free_bytes=0,
                max_bytes=1_024,
            )
            self.assertEqual(result["created"], 46)
            resumed = create_archives(
                shards,
                workers=2,
                compression_level=6,
                minimum_free_bytes=0,
                max_bytes=1_024,
            )
            self.assertEqual(resumed["skipped"], 46)
            copy_catalog(source, target)
            verification = verify_archives(shards, target)
            self.assertEqual(verification["files"], 69)
            self.assertEqual(verification["archives"], 46)
            first = shards[0]
            with zipfile.ZipFile(first.output) as archive:
                self.assertEqual(len(archive.infolist()), 2)
                self.assertTrue(
                    all(name.startswith(f"{first.category}/") for name in archive.namelist())
                )
            self.assertEqual(
                {path.name for path in (target / "02_Catalog").iterdir()},
                {"全部书目.xlsx", "分类目录"},
            )


if __name__ == "__main__":
    unittest.main()
