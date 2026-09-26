from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.cold_store_library import (
    atomic_json,
    build_archive,
    build_plan,
    process_task,
    restore_archive,
    retire_sources,
    run_plan,
    safe_path,
    start_plan,
    verify_archive,
)


class ColdStorageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw, self.cleaned, self.human, self.output = [
            self.root / name for name in ("raw", "cleaned", "human", "cold")
        ]
        self.cleaned.mkdir()
        (self.human / "00_玄幻").mkdir(parents=True)
        rows = []
        with zipfile.ZipFile(self.human / "00_玄幻" / "books.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for number in range(1, 4):
                identifier = f"id{number:06d}"
                book = self.raw / "00_xuanhuan" / identifier
                book.mkdir(parents=True)
                body = ("故事正文" * number).encode()
                (book / "source.txt").write_bytes(body)
                (book / "index.json").write_text(json.dumps({"id": identifier}))
                rows.append({"canonical_id": identifier, "target_source": f"00_xuanhuan/{identifier}/source.txt"})
                archive.writestr(f"00_玄幻/00_{identifier}_故事_作者.txt", body)
                cleaned_book = self.cleaned / identifier
                cleaned_book.mkdir()
                (cleaned_book / "chapter_0001.json").write_text(json.dumps({"text": body.decode()}))
                (cleaned_book / "空目录").mkdir()
        (self.raw / "index.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
        (self.raw / "_migration").mkdir()
        (self.raw / "_migration" / "map.json").write_text('{"preserve": true}')
        (self.cleaned / "state.json").write_text('{"checkpoint": 1}')
        self.noise = contextlib.redirect_stdout(io.StringIO())
        self.noise.__enter__()
        self.addCleanup(self.noise.__exit__, None, None, None)

    def plan(self) -> dict:
        return build_plan(self.raw, self.cleaned, self.human, self.output, 2)

    def task(self, name: str) -> tuple:
        with sqlite3.connect(self.output / "plan.sqlite3") as connection:
            return connection.execute("SELECT * FROM tasks WHERE id=?", (name,)).fetchone()

    def snapshot(self, root: Path) -> dict[str, bytes]:
        return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}

    def prepared_cleaned(self) -> tuple:
        config = self.plan()
        task = self.task("cleaned-00000")
        process_task(config, task, delete=False, minimum_free_bytes=0)
        archive = self.output / "archives" / "cleaned-00000.tar.gz"
        receipt_path = self.output / "receipts" / "cleaned-00000.json"
        receipt = json.loads(receipt_path.read_text())
        payload, _ = verify_archive(archive, self.human)
        return config, task, archive, receipt_path, receipt, payload

    def test_end_to_end_retirement_restore_and_rerun(self) -> None:
        raw_before, cleaned_before = self.snapshot(self.raw), self.snapshot(self.cleaned)
        config = self.plan()
        self.assertEqual(config["raw_books"], 3)
        run_plan(self.output, "all", delete=True, maximum=0, minimum_free_bytes=0)
        self.assertEqual({p.name for p in self.raw.iterdir()}, {".gitkeep", "ARCHIVED.md"})
        self.assertEqual({p.name for p in self.cleaned.iterdir()}, {".gitkeep", "ARCHIVED.md"})
        raw_restore, cleaned_restore = self.root / "raw-restore", self.root / "cleaned-restore"
        for archive in sorted((self.output / "archives").glob("*.tar.gz")):
            destination = raw_restore if archive.name.startswith("raw-") else cleaned_restore
            restore_archive(archive, self.human, destination)
        self.assertEqual(self.snapshot(raw_restore), raw_before)
        self.assertEqual(self.snapshot(cleaned_restore), cleaned_before)
        self.assertTrue((cleaned_restore / "id000001" / "空目录").is_dir())
        run_plan(self.output, "all", delete=True, maximum=0, minimum_free_bytes=0)

    def test_same_size_wrong_zip_content_blocks_deletion(self) -> None:
        self.plan()
        zipped = self.human / "00_玄幻" / "books.zip"
        with zipfile.ZipFile(zipped) as archive:
            members = [(i.filename, archive.read(i)) for i in archive.infolist()]
        with zipfile.ZipFile(zipped, "w") as archive:
            for name, content in members:
                archive.writestr(name, b"x" * len(content))
        before = self.snapshot(self.raw)
        with self.assertRaisesRegex(ValueError, "differs from raw"):
            run_plan(self.output, "raw", delete=True, maximum=0, minimum_free_bytes=0)
        self.assertEqual(before, self.snapshot(self.raw))

    def test_changed_source_blocks_entire_shard_deletion(self) -> None:
        _, _, archive, receipt_path, receipt, payload = self.prepared_cleaned()
        file = self.cleaned / "id000001" / "chapter_0001.json"
        file.write_text("modified")
        with self.assertRaisesRegex(RuntimeError, "Source changed"):
            retire_sources(self.cleaned, payload, archive, self.human, receipt_path, receipt)
        self.assertTrue((self.cleaned / "id000002" / "chapter_0001.json").exists())
        self.assertEqual(file.read_text(), "modified")

    def test_new_file_blocks_entire_shard_deletion(self) -> None:
        _, _, archive, receipt_path, receipt, payload = self.prepared_cleaned()
        (self.cleaned / "id000001" / "new.json").write_text("new")
        with self.assertRaisesRegex(RuntimeError, "New source"):
            retire_sources(self.cleaned, payload, archive, self.human, receipt_path, receipt)
        self.assertTrue((self.cleaned / "id000002" / "chapter_0001.json").exists())

    def test_interrupted_deletion_resumes_from_verified_manifest(self) -> None:
        config, task, _, receipt_path, receipt, _ = self.prepared_cleaned()
        receipt["deletion_started"] = True
        atomic_json(receipt_path, receipt)
        (self.cleaned / "id000001" / "chapter_0001.json").unlink()
        process_task(config, task, delete=True, minimum_free_bytes=0)
        self.assertFalse((self.cleaned / "id000001").exists())
        self.assertFalse((self.cleaned / "id000002").exists())
        self.assertTrue(json.loads(receipt_path.read_text())["deleted"])

    def test_corrupted_archive_blocks_deletion(self) -> None:
        config, task, archive, _, _, _ = self.prepared_cleaned()
        data = bytearray(archive.read_bytes())
        data[-8] ^= 0xFF
        archive.write_bytes(data)
        with self.assertRaises((OSError, ValueError)):
            process_task(config, task, delete=True, minimum_free_bytes=0)
        self.assertTrue((self.cleaned / "id000001" / "chapter_0001.json").exists())

    def test_uncovered_raw_book_rejects_plan(self) -> None:
        with zipfile.ZipFile(self.human / "00_玄幻" / "books.zip", "w"):
            pass
        with self.assertRaisesRegex(ValueError, "cover every raw"):
            self.plan()
        self.assertTrue((self.raw / "index.jsonl").exists())

    def test_low_space_and_symlink_leave_sources_untouched(self) -> None:
        self.output.mkdir()
        archive = self.output / "test.tar.gz"
        with self.assertRaisesRegex(RuntimeError, "Free-space"):
            build_archive(self.cleaned, ["id000001"], {}, archive, "test", 2**100)
        (self.cleaned / "id000002" / "link").symlink_to(self.raw / "index.jsonl")
        with self.assertRaisesRegex(ValueError, "symlink"):
            build_archive(self.cleaned, ["id000002"], {}, self.output / "other.tar.gz", "other", 0)
        self.assertTrue((self.cleaned / "id000001" / "chapter_0001.json").exists())

    def test_restore_does_not_overwrite_and_rejects_parent_symlink(self) -> None:
        _, _, archive, _, _, _ = self.prepared_cleaned()
        destination = self.root / "restore"
        destination.mkdir()
        (destination / "id000001").symlink_to(self.raw, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "[Ss]ymlink"):
            restore_archive(archive, self.human, destination)
        self.assertTrue((self.raw / "index.jsonl").exists())
        with self.assertRaises(ValueError):
            safe_path(destination, "../escape")
        fresh = self.root / "fresh-restore"
        restore_archive(archive, self.human, fresh)
        before = self.snapshot(fresh)
        with self.assertRaises(FileExistsError):
            restore_archive(archive, self.human, fresh)
        self.assertEqual(before, self.snapshot(fresh))

    def test_batch_limit_preserves_global_metadata(self) -> None:
        self.plan()
        run_plan(self.output, "raw", delete=True, maximum=1, minimum_free_bytes=0)
        self.assertTrue((self.raw / "index.jsonl").exists())
        self.assertFalse((self.raw / "00_xuanhuan" / "id000001").exists())

    def test_replaced_source_parent_blocks_processing(self) -> None:
        config = self.plan()
        category = self.raw / "00_xuanhuan"
        displaced = self.root / "displaced"
        category.rename(displaced)
        category.symlink_to(displaced, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "category replaced"):
            process_task(config, self.task("raw-0000"), delete=True, minimum_free_bytes=0)
        self.assertTrue((displaced / "id000001" / "source.txt").exists())

    def test_parallel_shards_retire_and_restore_independently(self) -> None:
        raw_before, cleaned_before = self.snapshot(self.raw), self.snapshot(self.cleaned)
        original = self.human / "00_玄幻" / "books.zip"
        with zipfile.ZipFile(original) as archive:
            members = [(i.filename, archive.read(i)) for i in archive.infolist()]
        original.unlink()
        for number, (name, content) in enumerate(members):
            with zipfile.ZipFile(original.with_name(f"part{number}.zip"), "w") as archive:
                archive.writestr(name, content)
        self.plan()
        run_plan(self.output, "all", delete=True, maximum=0, minimum_free_bytes=0, workers=2)
        for archive in sorted((self.output / "archives").glob("*.tar.gz")):
            destination = self.root / ("parallel-raw" if archive.name.startswith("raw-") else "parallel-cleaned")
            restore_archive(archive, self.human, destination)
        self.assertEqual(self.snapshot(self.root / "parallel-raw"), raw_before)
        self.assertEqual(self.snapshot(self.root / "parallel-cleaned"), cleaned_before)

    def test_detached_launcher_finishes_and_records_worker_state(self) -> None:
        self.plan()
        child = start_plan(self.output, "all", delete=True, maximum=0,
                           minimum_free_gib=0, workers=2)
        try:
            code = child.wait(timeout=30)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
        self.assertEqual(code, 0, (self.output / "console.log").read_text())
        worker = json.loads((self.output / "worker.json").read_text())
        self.assertEqual(worker["state"], "complete")
        self.assertEqual(worker["pid"], child.pid)
        self.assertTrue((self.raw / "ARCHIVED.md").exists())
        self.assertTrue((self.cleaned / "ARCHIVED.md").exists())


if __name__ == "__main__":
    unittest.main()
