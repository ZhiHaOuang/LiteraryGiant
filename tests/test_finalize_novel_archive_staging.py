from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.finalize_novel_archive_staging import finalize


class FinalizeNovelArchiveStagingTests(unittest.TestCase):
    def test_complete_split_inventory_is_sampled_published_and_archive_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "分类.zip"
            contents = {f"书-{index}.txt": f"正文-{index}".encode() for index in range(5)}
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as handle:
                for name, data in contents.items():
                    handle.writestr(name, data)
            staging = root / ".extract-分类.zip-test"
            staging.mkdir()
            with zipfile.ZipFile(archive) as handle:
                handle.extractall(staging)
            output = root / "分类"
            output.mkdir()
            (staging / "书-0.txt").replace(output / "书-0.txt")

            dry = finalize(
                archive,
                staging,
                sample_files=3,
                stable_age_seconds=0,
                dry_run=True,
            )
            self.assertEqual(dry["status"], "validated")
            self.assertTrue(archive.is_file())

            result = finalize(
                archive,
                staging,
                sample_files=3,
                stable_age_seconds=0,
                dry_run=False,
            )
            self.assertEqual(result["sample_files"], 3)
            self.assertTrue(result["archive_deleted"])
            self.assertFalse(archive.exists())
            self.assertFalse(staging.exists())
            self.assertEqual(
                {path.name: path.read_bytes() for path in output.iterdir()},
                contents,
            )

    def test_incomplete_staging_is_rejected_and_archive_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "分类.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("甲.txt", b"one")
                handle.writestr("乙.txt", b"two")
            staging = root / ".extract-分类.zip-test"
            staging.mkdir()
            (staging / "甲.txt").write_bytes(b"one")

            with self.assertRaisesRegex(RuntimeError, "incomplete staging inventory"):
                finalize(
                    archive,
                    staging,
                    sample_files=2,
                    stable_age_seconds=0,
                    dry_run=False,
                )

            self.assertTrue(archive.is_file())
            self.assertTrue(staging.is_dir())
            self.assertFalse((root / "分类").exists())
