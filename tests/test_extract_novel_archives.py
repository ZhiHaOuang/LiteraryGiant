from __future__ import annotations

import hashlib
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.extract_novel_archives import extract_one, main


BSDTAR = shutil.which("bsdtar") or "bsdtar"


def _write_zip(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)


def _rewrite_zip_member_name(path: Path, old_ascii: str, new_gb18030: str) -> None:
    old = old_ascii.encode("ascii")
    new = new_gb18030.encode("gb18030")
    if len(old) != len(new):
        raise AssertionError("test ZIP names must have equal encoded lengths")
    payload = path.read_bytes()
    # One occurrence is in the local header and one is in the central directory.
    if payload.count(old) != 2:
        raise AssertionError("unexpected test ZIP header layout")
    path.write_bytes(payload.replace(old, new))


def _journal_events(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class NovelArchiveExtractionTests(unittest.TestCase):
    def test_damaged_zip_list_falls_back_with_gb18030_names_crc_and_workers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "其他.zip"
            members = {"abcd.txt": "中文正文".encode("utf-8")}
            members.update(
                {f"book{index}.txt": f"正文-{index}".encode() for index in range(7)}
            )
            _write_zip(source, members)
            _rewrite_zip_member_name(source, "abcd.txt", "中文.txt")
            journal = root / "run" / "journal.jsonl"

            def damaged_list(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
                command = args[0]
                self.assertIsInstance(command, list)
                self.assertIn("-tf", command)
                return subprocess.CompletedProcess(
                    command,
                    1,
                    stdout=b"members were still listed\n",
                    stderr=b"bsdtar: Damaged Zip archive",
                )

            with patch(
                "scripts.extract_novel_archives.subprocess.run",
                side_effect=damaged_list,
            ):
                result = extract_one(
                    source,
                    BSDTAR,
                    journal,
                    stable_age_seconds=0,
                    verify_mode="sample",
                    sample_files=3,
                    workers=7,
                )

            self.assertFalse(source.exists())
            self.assertEqual(
                (root / "其他" / "中文.txt").read_text(encoding="utf-8"),
                "中文正文",
            )
            self.assertEqual(result["extractor"], "python_zip_fallback")
            self.assertEqual(result["zip_fallback_reason"], "bsdtar_list_failed")
            self.assertEqual(result["bsdtar_list_returncode"], 1)
            self.assertEqual(result["zip_filename_recoded"], 1)
            self.assertEqual(result["zip_crc_files_verified"], 8)
            self.assertEqual(result["zip_fallback_workers"], 7)
            self.assertEqual(result["metadata_files_verified"], 8)
            self.assertEqual(result["content_files_verified"], 3)
            self.assertTrue(result["archive_deleted"])

    def test_zip_fallback_crc_failure_discards_both_stagings_and_retains_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "corrupt.zip"
            marker = b"unique-payload-for-crc"
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr("正文.txt", marker)
            payload = source.read_bytes()
            self.assertEqual(payload.count(marker), 1)
            source.write_bytes(payload.replace(marker, b"X" + marker[1:]))
            journal = root / "run" / "journal.jsonl"
            real_run = subprocess.run

            def fail_bsdtar_extract(
                *args: object,
                **kwargs: object,
            ) -> subprocess.CompletedProcess[bytes]:
                command = args[0]
                if isinstance(command, list) and "-tf" in command:
                    return real_run(*args, **kwargs)
                if isinstance(command, list) and "-xf" in command:
                    staging = Path(command[command.index("-C") + 1])
                    (staging / "partial-from-bsdtar.txt").write_bytes(b"partial")
                    return subprocess.CompletedProcess(
                        command,
                        1,
                        stdout=b"",
                        stderr=b"Damaged Zip archive",
                    )
                raise AssertionError(f"unexpected command: {command!r}")

            with patch(
                "scripts.extract_novel_archives.subprocess.run",
                side_effect=fail_bsdtar_extract,
            ):
                with self.assertRaisesRegex(zipfile.BadZipFile, "CRC"):
                    extract_one(
                        source,
                        BSDTAR,
                        journal,
                        stable_age_seconds=0,
                        workers=7,
                    )

            self.assertTrue(source.is_file())
            self.assertFalse((root / "corrupt").exists())
            self.assertEqual(list(root.glob(".extract-corrupt.zip-*")), [])
            failed = _journal_events(journal)[-1]
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["extractor"], "python_zip_fallback")
            self.assertEqual(failed["zip_fallback_reason"], "bsdtar_extract_failed")
            self.assertFalse(failed["archive_deleted"])
            self.assertEqual(failed["staging_cleanup"], "removed_after_failure")

    def test_zip_fallback_rejects_unsafe_path_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "unsafe.zip"
            _write_zip(source, {"../escape.txt": b"escape"})
            journal = root / "run" / "journal.jsonl"

            def damaged_list(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
                return subprocess.CompletedProcess(
                    args[0],
                    1,
                    stdout=b"",
                    stderr=b"Damaged Zip archive",
                )

            with patch(
                "scripts.extract_novel_archives.subprocess.run",
                side_effect=damaged_list,
            ):
                with self.assertRaisesRegex(RuntimeError, "unsafe archive member"):
                    extract_one(source, BSDTAR, journal, stable_age_seconds=0, workers=7)

            self.assertTrue(source.is_file())
            self.assertFalse((root / "escape.txt").exists())
            self.assertEqual(list(root.glob(".extract-unsafe.zip-*")), [])
            self.assertEqual(_journal_events(journal)[-1]["staging_cleanup"], "not_created")

    def test_cli_explicit_skip_member_excludes_one_corrupt_entry_and_audits_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "known-corrupt.zip"
            corrupt_payload = b"known-corrupt-payload"
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr("正常.txt", "正常正文".encode("utf-8"))
                archive.writestr("坏书.txt", corrupt_payload)
            payload = source.read_bytes()
            self.assertEqual(payload.count(corrupt_payload), 1)
            source.write_bytes(
                payload.replace(corrupt_payload, b"X" + corrupt_payload[1:])
            )
            run_dir = root / "run"
            argv = [
                "extract_novel_archives.py",
                "--archive",
                str(source),
                "--skip-member",
                f"{source}::坏书.txt",
                "--run-dir",
                str(run_dir),
                "--stable-age-seconds",
                "0",
                "--workers",
                "7",
            ]

            with patch.object(sys, "argv", argv), redirect_stdout(StringIO()):
                exit_code = main()

            self.assertEqual(exit_code, 0)
            self.assertFalse(source.exists())
            self.assertEqual(
                (root / "known-corrupt" / "正常.txt").read_text(encoding="utf-8"),
                "正常正文",
            )
            self.assertFalse((root / "known-corrupt" / "坏书.txt").exists())
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["skipped_corrupt_member_count"], 1)
            self.assertEqual(
                summary["skipped_corrupt_members"],
                [{"archive": str(source), "members": ["坏书.txt"]}],
            )
            event = _journal_events(run_dir / "journal.jsonl")[-1]
            self.assertEqual(event["skipped_corrupt_members"], ["坏书.txt"])
            self.assertEqual(event["member_candidates_before_skip"], 2)
            self.assertEqual(event["member_candidates"], 1)
            self.assertEqual(event["metadata_files_verified"], 1)
            self.assertTrue(event["archive_deleted"])

    def test_explicit_skip_member_must_exist_exactly_once_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "strict-skip.zip"
            _write_zip(source, {"正文.txt": b"content"})
            journal = root / "run" / "journal.jsonl"

            with self.assertRaisesRegex(RuntimeError, "must exist exactly once"):
                extract_one(
                    source,
                    BSDTAR,
                    journal,
                    stable_age_seconds=0,
                    skip_members=["不存在.txt"],
                )

            self.assertTrue(source.is_file())
            self.assertEqual(list(root.glob(".extract-strict-skip.zip-*")), [])
            failed = _journal_events(journal)[-1]
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["staging_cleanup"], "not_created")

    def test_root_members_are_published_under_archive_stem(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "都市言情.zip"
            _write_zip(source, {"甲.txt": "第一章\n正文".encode("utf-8")})
            journal = root / "run" / "journal.jsonl"

            result = extract_one(source, BSDTAR, journal, stable_age_seconds=0)

            self.assertFalse(source.exists())
            self.assertEqual((root / "都市言情" / "甲.txt").read_text(encoding="utf-8"), "第一章\n正文")
            self.assertFalse((root / "甲.txt").exists())
            self.assertEqual(result["output_root"], str(root / "都市言情"))
            self.assertFalse(result["flattened_wrapper"])

    def test_matching_wrapper_is_removed_once_and_noise_does_not_block_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "武侠修真.zip"
            _write_zip(
                source,
                {
                    "武侠修真/乙.txt": "第二章\n正文".encode("utf-8"),
                    "__MACOSX/._乙.txt": b"noise",
                },
            )

            result = extract_one(
                source,
                BSDTAR,
                root / "run" / "journal.jsonl",
                stable_age_seconds=0,
            )

            self.assertTrue(result["flattened_wrapper"])
            self.assertTrue((root / "武侠修真" / "乙.txt").is_file())
            self.assertFalse((root / "武侠修真" / "武侠修真" / "乙.txt").exists())
            self.assertFalse((root / "武侠修真" / "__MACOSX").exists())

    def test_empty_or_noise_only_archive_is_rejected_and_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, members in (
                ("empty.zip", {}),
                ("noise.zip", {"__MACOSX/._x": b"noise", ".DS_Store": b"noise"}),
            ):
                with self.subTest(name=name):
                    source = root / name
                    _write_zip(source, members)
                    journal = root / f"run-{name}" / "journal.jsonl"
                    with self.assertRaisesRegex(RuntimeError, "no non-noise"):
                        extract_one(source, BSDTAR, journal, stable_age_seconds=0)
                    self.assertTrue(source.is_file())
                    self.assertFalse((root / source.stem).exists())
                    self.assertEqual(list(root.glob(f".extract-{name}-*")), [])
                    failed = _journal_events(journal)[-1]
                    self.assertEqual(failed["status"], "failed")
                    self.assertFalse(failed["archive_deleted"])
                    self.assertEqual(failed["staging_cleanup"], "not_created")

    def test_duplicate_normalized_member_is_rejected_before_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "duplicate.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(source, "w") as archive:
                    archive.writestr("重复.txt", b"first")
                    archive.writestr("重复.txt", b"second")

            journal = root / "run" / "journal.jsonl"
            with self.assertRaisesRegex(RuntimeError, "duplicate normalized archive member"):
                extract_one(source, BSDTAR, journal, stable_age_seconds=0)

            self.assertTrue(source.is_file())
            self.assertFalse((root / "duplicate").exists())
            self.assertEqual(_journal_events(journal)[-1]["staging_cleanup"], "not_created")

    def test_conflicting_existing_file_is_hash_renamed_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "冲突.zip"
            new_content = "压缩包里的新正文".encode("utf-8")
            _write_zip(source, {"同名.txt": new_content})
            output = root / "冲突"
            output.mkdir()
            existing = output / "同名.txt"
            existing.write_bytes(b"existing")

            result = extract_one(
                source,
                BSDTAR,
                root / "run" / "journal.jsonl",
                stable_age_seconds=0,
            )

            digest = hashlib.sha256(new_content).hexdigest()
            conflict = output / f"同名.archive-冲突-{digest[:12]}.txt"
            self.assertEqual(existing.read_bytes(), b"existing")
            self.assertEqual(conflict.read_bytes(), new_content)
            self.assertEqual(result["conflict_renamed"], 1)
            self.assertFalse(source.exists())

    def test_sample_mode_checks_all_metadata_and_distributed_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "抽样.zip"
            _write_zip(
                source,
                {f"书-{index}.txt": f"正文-{index}".encode() for index in range(5)},
            )

            result = extract_one(
                source,
                BSDTAR,
                root / "run" / "journal.jsonl",
                stable_age_seconds=0,
                verify_mode="sample",
                sample_files=3,
            )

            self.assertFalse(source.exists())
            self.assertEqual(result["verify_mode"], "sample")
            self.assertEqual(result["metadata_files_verified"], 5)
            self.assertEqual(result["content_files_verified"], 3)
            self.assertEqual(
                result["sampled_relative_paths"],
                ["书-0.txt", "书-2.txt", "书-4.txt"],
            )

    def test_post_extract_failure_cleans_staging_and_retains_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "symlink.zip"
            link = zipfile.ZipInfo("link.txt")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(link, "target.txt")
            journal = root / "run" / "journal.jsonl"

            with self.assertRaisesRegex(RuntimeError, "symlink|non-regular"):
                extract_one(source, BSDTAR, journal, stable_age_seconds=0)

            self.assertTrue(source.is_file())
            self.assertEqual(list(root.glob(".extract-symlink.zip-*")), [])
            self.assertEqual(_journal_events(journal)[-1]["staging_cleanup"], "removed_after_failure")

    def test_source_identity_change_after_extraction_prevents_publish_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "changing.zip"
            _write_zip(source, {"正文.txt": b"content"})
            journal = root / "run" / "journal.jsonl"
            real_run = subprocess.run

            def run_and_change_source(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
                result = real_run(*args, **kwargs)
                command = args[0]
                if isinstance(command, list) and "-xf" in command:
                    with source.open("ab") as handle:
                        handle.write(b"changed-during-extraction")
                return result

            with patch(
                "scripts.extract_novel_archives.subprocess.run",
                side_effect=run_and_change_source,
            ):
                with self.assertRaisesRegex(RuntimeError, "archive changed"):
                    extract_one(source, BSDTAR, journal, stable_age_seconds=0)

            self.assertTrue(source.is_file())
            self.assertFalse((root / "changing").exists())
            self.assertEqual(list(root.glob(".extract-changing.zip-*")), [])
            self.assertEqual(_journal_events(journal)[-1]["staging_cleanup"], "removed_after_failure")

    def test_cli_exact_archives_continue_after_failure_and_write_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            good = root / "a-good.zip"
            bad = root / "b-empty.zip"
            _write_zip(good, {"正文.txt": b"content"})
            _write_zip(bad, {})
            run_dir = root / "run"
            argv = [
                "extract_novel_archives.py",
                "--archive",
                str(bad),
                "--archive",
                str(good),
                "--run-dir",
                str(run_dir),
                "--stable-age-seconds",
                "0",
            ]

            with patch.object(sys, "argv", argv), redirect_stdout(StringIO()):
                exit_code = main()

            self.assertEqual(exit_code, 1)
            self.assertFalse(good.exists())
            self.assertTrue((root / "a-good" / "正文.txt").is_file())
            self.assertTrue(bad.is_file())
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["status"], "partial")
            self.assertEqual(summary["archives_succeeded"], 1)
            self.assertEqual(summary["archives_failed"], 1)
            self.assertEqual(summary["archives_attempted"], 2)

    def test_cli_workers_extract_concurrently_with_valid_jsonl_and_stable_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archives: list[Path] = []
            for index in range(7):
                source = root / f"batch-{index}.zip"
                if index in {1, 5}:
                    _write_zip(source, {})
                else:
                    _write_zip(source, {f"正文-{index}.txt": f"content-{index}".encode()})
                archives.append(source)
            run_dir = root / "run"
            argv = [
                "extract_novel_archives.py",
                "--run-dir",
                str(run_dir),
                "--stable-age-seconds",
                "0",
                "--workers",
                "7",
            ]
            # Deliberately reverse CLI order; selection and summary must still
            # use deterministic path order.
            for source in reversed(archives):
                argv.extend(("--archive", str(source)))

            with patch.object(sys, "argv", argv), redirect_stdout(StringIO()):
                exit_code = main()

            self.assertEqual(exit_code, 1)
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["workers"], 7)
            self.assertEqual(summary["archives_attempted"], 7)
            self.assertEqual(summary["archives_succeeded"], 5)
            self.assertEqual(summary["archives_failed"], 2)
            self.assertEqual(
                [item["archive"] for item in summary["failures"]],
                [str(archives[1]), str(archives[5])],
            )
            self.assertEqual(
                [item["archive"] for item in summary["archive_results"]],
                [str(source) for source in archives],
            )
            for index, source in enumerate(archives):
                if index in {1, 5}:
                    self.assertTrue(source.is_file())
                else:
                    self.assertFalse(source.exists())
                    self.assertTrue((root / f"batch-{index}" / f"正文-{index}.txt").is_file())

            events = _journal_events(run_dir / "journal.jsonl")
            self.assertEqual(len(events), 14)
            by_archive: dict[str, list[str]] = {}
            for event in events:
                by_archive.setdefault(str(event["archive"]), []).append(str(event["status"]))
            self.assertEqual(set(by_archive), {str(source) for source in archives})
            for statuses in by_archive.values():
                self.assertEqual(statuses[0], "running")
                self.assertIn(statuses[1], {"complete", "failed"})

    def test_fail_fast_is_rejected_with_multiple_workers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "book.zip"
            _write_zip(source, {"正文.txt": b"content"})
            argv = [
                "extract_novel_archives.py",
                "--archive",
                str(source),
                "--run-dir",
                str(root / "run"),
                "--workers",
                "2",
                "--fail-fast",
            ]

            with patch.object(sys, "argv", argv), redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    main()

            self.assertEqual(raised.exception.code, 2)
            self.assertTrue(source.is_file())
            self.assertFalse((root / "run").exists())

    def test_stability_gate_retains_recent_archive_without_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "recent.zip"
            _write_zip(source, {"正文.txt": b"content"})
            journal = root / "run" / "journal.jsonl"

            with self.assertRaisesRegex(RuntimeError, "too recent"):
                extract_one(source, BSDTAR, journal, stable_age_seconds=3600)

            self.assertTrue(source.is_file())
            self.assertEqual(list(root.glob(".extract-recent.zip-*")), [])
            self.assertEqual(_journal_events(journal)[-1]["staging_cleanup"], "not_created")


if __name__ == "__main__":
    unittest.main()
