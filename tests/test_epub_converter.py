from __future__ import annotations

import errno
import json
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock
from xml.sax.saxutils import escape

from fetcher.epub_converter import (
    EpubLimits,
    delete_rejected_epub,
    inspect_epub,
    write_utf8_text,
)
from fetcher.local_resources import available_cpu_count
from scripts.convert_epub_novels import _parser as epub_cli_parser
from scripts.convert_epub_novels import main as epub_cli_main


def _xhtml(*, title: str, body: str, heading: str = "") -> bytes:
    heading_markup = f"<h2>{escape(heading)}</h2>" if heading else ""
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml">'
        f"<head><title>{escape(title)}</title></head>"
        f"<body>{heading_markup}{body}</body></html>"
    ).encode("utf-8")


def _make_epub(
    path: Path,
    *,
    documents: dict[str, bytes],
    spine: list[str],
    toc_titles: dict[str, str] | None = None,
    title: str = "测试书名",
    author: str = "测试作者",
    encryption_xml: bytes | None = None,
    extra_members: dict[str, bytes] | None = None,
    linear_no: set[str] | None = None,
) -> None:
    manifest_items = [
        f'<item id="{escape(item_id)}" href="Text/{escape(item_id)}.xhtml" '
        'media-type="application/xhtml+xml"/>'
        for item_id in documents
    ]
    if toc_titles is not None:
        manifest_items.append(
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        )
    non_linear = linear_no or set()
    spine_items = "".join(
        f'<itemref idref="{escape(item_id)}"'
        + (' linear="no"' if item_id in non_linear else "")
        + "/>"
        for item_id in spine
    )
    spine_attribute = ' toc="ncx"' if toc_titles is not None else ""
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
        'unique-identifier="book-id">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:opf="http://www.idpf.org/2007/opf">'
        f"<dc:title>{escape(title)}</dc:title>"
        f'<dc:creator opf:role="aut">{escape(author)}</dc:creator>'
        '<dc:language>zh-CN</dc:language><dc:identifier id="book-id">urn:test:1</dc:identifier>'
        "</metadata>"
        f"<manifest>{''.join(manifest_items)}</manifest>"
        f"<spine{spine_attribute}>"
        f"{spine_items}</spine></package>"
    ).encode("utf-8")
    container = (
        '<?xml version="1.0"?>'
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    ).encode("utf-8")

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("OEBPS/content.opf", opf)
        # Deliberately store content in reverse insertion order: only the OPF
        # spine, never ZIP member order, may determine output order.
        for item_id in reversed(list(documents)):
            archive.writestr(f"OEBPS/Text/{item_id}.xhtml", documents[item_id])
        if toc_titles is not None:
            nav_points = "".join(
                '<navPoint id="nav-{index}" playOrder="{index}">'
                f"<navLabel><text>{escape(label)}</text></navLabel>"
                f'<content src="Text/{escape(item_id)}.xhtml"/></navPoint>'
                for index, (item_id, label) in enumerate(toc_titles.items(), start=1)
            )
            ncx = (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" '
                '"http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">'
                '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
                f"<navMap>{nav_points}</navMap></ncx>"
            ).encode("utf-8")
            archive.writestr("OEBPS/toc.ncx", ncx)
        if encryption_xml is not None:
            archive.writestr("META-INF/encryption.xml", encryption_xml)
        for member, content in (extra_members or {}).items():
            archive.writestr(member, content)


def _mark_one_member_zip_encrypted(path: Path) -> None:
    data = bytearray(path.read_bytes())
    central_header = data.find(b"PK\x01\x02")
    if central_header < 0:
        raise AssertionError("test EPUB has no central ZIP header")
    flags_offset = central_header + 8
    flags = int.from_bytes(data[flags_offset : flags_offset + 2], "little") | 0x1
    data[flags_offset : flags_offset + 2] = flags.to_bytes(2, "little")
    path.write_bytes(data)


def _corrupt_member_payload(path: Path, member: str) -> None:
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo(member)
        offset = info.header_offset
    data = bytearray(path.read_bytes())
    if data[offset : offset + 4] != b"PK\x03\x04":
        raise AssertionError("test member has no local ZIP header")
    name_length = int.from_bytes(data[offset + 26 : offset + 28], "little")
    extra_length = int.from_bytes(data[offset + 28 : offset + 30], "little")
    payload_offset = offset + 30 + name_length + extra_length
    if info.compress_size < 2:
        raise AssertionError("test member payload is too small to corrupt")
    data[payload_offset + info.compress_size // 2] ^= 0x01
    path.write_bytes(data)


class EpubConversionTests(unittest.TestCase):
    def test_cli_default_workers_respect_detected_cpu_quota(self) -> None:
        parsed = epub_cli_parser().parse_args([])
        self.assertEqual(parsed.workers, min(16, available_cpu_count()))

    def test_operational_io_error_is_not_a_deletable_epub_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "book.epub"
            _make_epub(
                source,
                documents={
                    "one": _xhtml(title="正文", body=f"<p>{'正文内容' * 40}</p>")
                },
                spine=["one"],
            )
            with mock.patch(
                "fetcher.epub_converter._load_document",
                side_effect=OSError(errno.EIO, "synthetic storage failure"),
            ):
                with self.assertRaises(OSError):
                    inspect_epub(source)
            self.assertTrue(source.exists())

    def test_unreferenced_bad_crc_does_not_reject_readable_spine(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "unused-corrupt-image.epub"
            _make_epub(
                source,
                documents={
                    "one": _xhtml(
                        title="正文", heading="第一章", body=f"<p>{'正文' * 80}</p>"
                    )
                },
                spine=["one"],
                extra_members={"OEBPS/Images/unused.jpg": bytes(range(256)) * 8},
            )
            _corrupt_member_payload(source, "OEBPS/Images/unused.jpg")

            inspection = inspect_epub(source)
            self.assertTrue(inspection.accepted)

    def test_deep_html_non_text_nodes_and_linear_no(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deep = root / "deep.epub"
            nested = "<div>" * 1500 + f"<p>{'深' * 140}</p>" + "</div>" * 1500
            _make_epub(
                deep,
                documents={
                    "excluded": _xhtml(
                        title="番外", body=f"<p>{'不应出现' * 80}</p>"
                    ),
                    "main": _xhtml(title="正文", body=nested),
                },
                spine=["excluded", "main"],
                linear_no={"excluded"},
            )
            inspection = inspect_epub(deep)
            self.assertTrue(inspection.accepted)
            assert inspection.document is not None
            self.assertEqual(len(inspection.document.chapters), 1)
            self.assertNotIn("不应出现", inspection.document.render_text())
            self.assertIn("linear-no-spine-items-skipped:1", inspection.document.warnings)

            comment_only = root / "comment-only.epub"
            _make_epub(
                comment_only,
                documents={
                    "cover": _xhtml(
                        title="封面",
                        body=f"<!-- {'这不是正文' * 80} -->"
                        '<?processing instruction?>'
                        '<img src="cover.jpg"/>',
                    )
                },
                spine=["cover"],
            )
            rejected = inspect_epub(comment_only)
            self.assertFalse(rejected.accepted)
            self.assertEqual(rejected.rejection_code, "image_only")

    def test_spine_order_metadata_toc_title_and_utf8_without_bom(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "order.epub"
            _make_epub(
                source,
                documents={
                    "one": _xhtml(
                        title="第一章",
                        heading="第一章 初见",
                        body=f"<p>{'甲' * 140}</p>",
                    ),
                    "two": _xhtml(
                        title="Chapter 2",
                        body=f"<p>{'乙' * 140}</p>",
                    ),
                },
                spine=["two", "one"],
                toc_titles={"one": "第一章 初见", "two": "第二章 来客"},
                title="逆序测试录",
                author="甲乙",
            )

            inspection = inspect_epub(source)
            self.assertTrue(inspection.accepted)
            assert inspection.document is not None
            document = inspection.document
            self.assertEqual(document.title, "逆序测试录")
            self.assertEqual(document.authors, ("甲乙",))
            self.assertEqual(document.language, "zh-CN")
            self.assertEqual([chapter.title for chapter in document.chapters], ["第二章 来客", "第一章 初见"])
            self.assertEqual(document.chapters[0].title_source, "toc")
            rendered = document.render_text()
            self.assertLess(rendered.index("第二章 来客"), rendered.index("第一章 初见"))

            destination = root / "converted.txt"
            result = write_utf8_text(document, destination)
            raw = destination.read_bytes()
            self.assertEqual(result["status"], "converted")
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertEqual(raw.decode("utf-8"), rendered)

    def test_rejects_drm_and_zip_encryption(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = _xhtml(title="正文", heading="第一章", body=f"<p>{'正文' * 80}</p>")
            drm = root / "drm.epub"
            encryption = (
                '<?xml version="1.0"?>'
                '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" '
                'xmlns:enc="http://www.w3.org/2001/04/xmlenc#">'
                '<enc:EncryptedData><enc:EncryptionMethod '
                'Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>'
                '<enc:CipherData><enc:CipherReference URI="OEBPS/Text/one.xhtml"/>'
                '</enc:CipherData></enc:EncryptedData></encryption>'
            ).encode("utf-8")
            _make_epub(drm, documents={"one": body}, spine=["one"], encryption_xml=encryption)
            self.assertEqual(inspect_epub(drm).rejection_code, "drm_encrypted")

            unsafe_xml = root / "unsafe-xml.epub"
            entity_declaration = (
                '<?xml version="1.0"?><!DOCTYPE encryption ['
                '<!ENTITY payload "expanded">]><encryption>&payload;</encryption>'
            ).encode("utf-8")
            _make_epub(
                unsafe_xml,
                documents={"one": body},
                spine=["one"],
                encryption_xml=entity_declaration,
            )
            self.assertEqual(inspect_epub(unsafe_xml).rejection_code, "unsafe_xml")

            encrypted_zip = root / "encrypted.epub"
            _make_epub(encrypted_zip, documents={"one": body}, spine=["one"])
            _mark_one_member_zip_encrypted(encrypted_zip)
            self.assertEqual(inspect_epub(encrypted_zip).rejection_code, "zip_encrypted")

    def test_rejects_corruption_traversal_and_zip_bomb(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = _xhtml(title="正文", heading="第一章", body=f"<p>{'正文' * 80}</p>")

            corrupt = root / "corrupt.epub"
            _make_epub(corrupt, documents={"one": body}, spine=["one"])
            corrupt.write_bytes(corrupt.read_bytes()[:-30])
            self.assertEqual(inspect_epub(corrupt).rejection_code, "corrupt_zip")

            traversal = root / "traversal.epub"
            _make_epub(
                traversal,
                documents={"one": body},
                spine=["one"],
                extra_members={"../escaped.txt": b"must-not-extract"},
            )
            self.assertEqual(inspect_epub(traversal).rejection_code, "unsafe_path")
            self.assertFalse((root.parent / "escaped.txt").exists())

            bomb = root / "bomb.epub"
            _make_epub(
                bomb,
                documents={"one": body},
                spine=["one"],
                extra_members={"OEBPS/large.bin": b"Z" * 30_000},
            )
            limits = EpubLimits(max_total_uncompressed_bytes=5_000)
            self.assertEqual(inspect_epub(bomb, limits=limits).rejection_code, "zip_bomb")

    def test_image_only_rejected_and_changed_source_is_not_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "image-only.epub"
            _make_epub(
                source,
                documents={
                    "cover": _xhtml(
                        title="封面",
                        body='<img src="cover.jpg" alt=""/>',
                    )
                },
                spine=["cover"],
            )
            inspection = inspect_epub(source)
            self.assertFalse(inspection.accepted)
            self.assertEqual(inspection.rejection_code, "image_only")
            with source.open("ab") as handle:
                handle.write(b"changed-after-inspection")
            with self.assertRaises(RuntimeError):
                delete_rejected_epub(inspection)
            self.assertTrue(source.exists())

    def test_cli_is_dry_run_by_default_and_confirmed_mode_is_audited(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_dir = root / "incoming" / "晋江"
            source_dir.mkdir(parents=True)
            valid = source_dir / "可读小说.epub"
            rejected = source_dir / "纯图小说.epub"
            _make_epub(
                valid,
                documents={
                    "one": _xhtml(
                        title="第一章",
                        heading="第一章 开始",
                        body=f"<p>{'这是正文内容' * 35}</p>",
                    )
                },
                spine=["one"],
            )
            _make_epub(
                rejected,
                documents={
                    "cover": _xhtml(title="封面", body='<img src="cover.jpg"/>')
                },
                spine=["cover"],
            )
            output = root / "converted"
            dry_report = root / "dry-run.jsonl"
            with redirect_stdout(StringIO()):
                dry_status = epub_cli_main(
                    [str(source_dir), "--output-root", str(output), "--report", str(dry_report)]
                )
            self.assertEqual(dry_status, 0)
            self.assertTrue(valid.exists())
            self.assertTrue(rejected.exists())
            self.assertFalse(output.exists())
            dry_records = [json.loads(line) for line in dry_report.read_text("utf-8").splitlines()]
            self.assertIn("convertible_dry_run", {record.get("status") for record in dry_records})
            self.assertIn("rejected_retained_dry_run", {record.get("status") for record in dry_records})

            confirmed_report = root / "confirmed.jsonl"
            with redirect_stdout(StringIO()):
                confirmed_status = epub_cli_main(
                    [
                        str(source_dir),
                        "--output-root",
                        str(output),
                        "--report",
                        str(confirmed_report),
                        "--confirmed",
                    ]
                )
            self.assertEqual(confirmed_status, 0)
            self.assertTrue(valid.exists(), "accepted source EPUBs are retained")
            self.assertFalse(rejected.exists(), "confirmed mode removes validation-rejected EPUBs")
            converted = list(output.rglob("*.txt"))
            self.assertEqual(len(converted), 1)
            raw = converted[0].read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            raw.decode("utf-8", errors="strict")

            records = [
                json.loads(line) for line in confirmed_report.read_text("utf-8").splitlines()
            ]
            statuses = [record.get("status") for record in records]
            self.assertIn("converted", statuses)
            self.assertLess(
                statuses.index("rejected_pending_delete"),
                statuses.index("rejected_deleted"),
            )
            summary = next(record for record in records if record.get("event") == "run_completed")
            self.assertEqual(summary["counts"]["deleted"], 1)
            self.assertEqual(summary["counts"]["errors"], 0)

    def test_cli_isolates_one_unexpected_parser_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("bad.epub", "good.epub"):
                _make_epub(
                    root / name,
                    documents={
                        "one": _xhtml(
                            title="正文", body=f"<p>{'正文内容' * 40}</p>"
                        )
                    },
                    spine=["one"],
                )
            report = root / "isolated.jsonl"
            real_inspect = inspect_epub

            def flaky_inspect(path: str | Path, **kwargs: object):
                if Path(path).name == "bad.epub":
                    raise RecursionError("synthetic parser depth failure")
                return real_inspect(path, **kwargs)

            with mock.patch(
                "scripts.convert_epub_novels.inspect_epub", side_effect=flaky_inspect
            ), redirect_stdout(StringIO()):
                status = epub_cli_main(
                    [
                        str(root),
                        "--report",
                        str(report),
                        "--workers",
                        "2",
                        "--max-pending",
                        "2",
                    ]
                )
            self.assertEqual(status, 1)
            records = [json.loads(line) for line in report.read_text("utf-8").splitlines()]
            summary = next(record for record in records if record.get("event") == "run_completed")
            self.assertEqual(summary["counts"]["errors"], 1)
            self.assertEqual(summary["counts"]["convertible"], 1)
            self.assertTrue((root / "bad.epub").exists())

    def test_confirmed_resume_requires_source_and_output_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "resume.epub"
            _make_epub(
                source,
                documents={
                    "one": _xhtml(
                        title="正文", body=f"<p>{'重用检查点' * 40}</p>"
                    )
                },
                spine=["one"],
            )
            output = root / "output"
            report = root / "resume.jsonl"
            arguments = [
                str(source),
                "--output-root",
                str(output),
                "--report",
                str(report),
                "--confirmed",
                "--workers",
                "1",
            ]
            with redirect_stdout(StringIO()):
                self.assertEqual(epub_cli_main(arguments), 0)

            with mock.patch(
                "scripts.convert_epub_novels.inspect_epub",
                side_effect=AssertionError("resume should avoid EPUB parsing"),
            ), redirect_stdout(StringIO()):
                self.assertEqual(epub_cli_main([*arguments, "--resume"]), 0)
            records = [json.loads(line) for line in report.read_text("utf-8").splitlines()]
            summaries = [record for record in records if record.get("event") == "run_completed"]
            self.assertEqual(summaries[-1]["counts"]["skipped"], 1)

            converted = next(output.rglob("*.txt"))
            converted.write_text("changed", encoding="utf-8")
            with mock.patch(
                "scripts.convert_epub_novels.inspect_epub",
                side_effect=RecursionError("must reprocess after output changed"),
            ), redirect_stdout(StringIO()):
                self.assertEqual(epub_cli_main([*arguments, "--resume"]), 1)
            records = [json.loads(line) for line in report.read_text("utf-8").splitlines()]
            summaries = [record for record in records if record.get("event") == "run_completed"]
            self.assertEqual(summaries[-1]["counts"]["skipped"], 0)
            self.assertEqual(summaries[-1]["counts"]["errors"], 1)


if __name__ == "__main__":
    unittest.main()
