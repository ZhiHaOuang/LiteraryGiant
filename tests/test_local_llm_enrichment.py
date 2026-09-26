from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fetcher.local_archive import enrich_low_confidence_metadata, scan_sources
from fetcher.local_catalog import LocalNovelCatalog


def _novel(label: str, chapters: int = 40) -> str:
    return "\n\n".join(
        f"第{index}章 {label}\n这一章包含足够的中文正文、人物行动和事件编号{index}。"
        for index in range(1, chapters + 1)
    ) + "\n"


def _model_result(
    item: dict[str, object],
    *,
    title: str | None = None,
    author: str | None = None,
    genre: str = "都市",
) -> dict[str, object]:
    resolved_title = title or Path(str(item["filename"])).stem
    return {
        "id": str(item["id"]),
        "title": resolved_title,
        "canonical_name_key": resolved_title,
        "author": author,
        "aliases": [],
        "genre": genre,
        "canonical_genre": genre,
        "tags": [],
        "confidence": 0.96,
        "field_confidence": {"title": 0.96, "author": 0.95, "genre": 0.96},
        "low_confidence": False,
        "evidence": ["synthetic-test"],
        "source": "vllm",
    }


class _FakeClient:
    calls = 0
    author: str | None = None
    title: str | None = None
    genre = "都市"

    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def enrich_batch(self, items):
        type(self).calls += 1
        return [
            _model_result(
                item,
                title=type(self).title,
                author=type(self).author,
                genre=type(self).genre,
            )
            for item in items
        ]


class _AuthorNullKeptClient(_FakeClient):
    def enrich_batch(self, items):
        results = []
        for item in items:
            result = _model_result(item, title="测试书名", author=None)
            result["author"] = "这不是作者，而是一整段正文说明文字，长度明显不合理。"
            result["evidence"] = ["vllm:author-null-kept-rule-value"]
            results.append(result)
        return results


class LocalLLMEnrichmentTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeClient.calls = 0
        _FakeClient.author = None
        _FakeClient.title = None
        _FakeClient.genre = "都市"

    def _scan_one(
        self,
        base: Path,
        *,
        category: str = "都市",
        name: str = "正常书名.txt",
        body: str | None = None,
    ) -> tuple[Path, Path, Path]:
        source = base / category
        source.mkdir(parents=True)
        source_file = source / name
        source_file.write_text(body or _novel("正文"), encoding="utf-8")
        archive = base / "archive"
        catalog_path = base / "catalog.sqlite3"
        return source_file, archive, catalog_path

    def test_blank_author_alone_is_not_a_difficult_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(Path(temporary))
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-blank-author",
                )
                row = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(row["author"], "")
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        run_id="llm-blank-author",
                    )
            self.assertEqual(summary["selected"], 0)
            self.assertEqual(summary["submitted"], 0)
            self.assertEqual(_FakeClient.calls, 0)

    def test_sanity_mode_unlocks_polluted_high_confidence_author(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary),
                name="测试书名 作者 正确作者.txt",
            )
            _FakeClient.author = "正确作者"
            _FakeClient.title = "测试书名"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-polluted-author",
                )
                catalog.connection.execute(
                    "UPDATE files SET author=?",
                    ("正确作者 第二章正文，敬请欣赏！&lt;/br&gt;",),
                )
                catalog.commit()
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-sanity",
                        candidate_mode="sanity",
                        run_id="llm-sanity-author",
                    )
                row = catalog.connection.execute("SELECT * FROM files").fetchone()
            self.assertEqual(summary["selected"], 1)
            self.assertEqual(row["author"], "正确作者")

    def test_sanity_mode_clears_pollution_repeated_by_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            polluted = "我爱媚媚(soushu555.com)"
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary),
                name=f"测试书名 作者 {polluted}.txt",
            )
            _FakeClient.author = polluted
            _FakeClient.title = "测试书名"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-site-pollution",
                )
                catalog.connection.execute("UPDATE files SET author=?", (polluted,))
                catalog.commit()
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-site-sanity",
                        candidate_mode="sanity",
                        run_id="llm-site-sanity",
                    )
                row = catalog.connection.execute("SELECT * FROM files").fetchone()
            self.assertEqual(summary["selected"], 1)
            self.assertEqual(row["author"], "")

    def test_sanity_mode_honours_batched_model_null_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            polluted = "这不是作者，而是一整段正文说明文字，长度明显不合理。"
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary), name="测试书名.txt"
            )
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-batched-null",
                )
                catalog.connection.execute("UPDATE files SET author=?", (polluted,))
                catalog.commit()
                with patch(
                    "fetcher.local_metadata.VLLMMetadataClient", _AuthorNullKeptClient
                ):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-batched-null",
                        candidate_mode="sanity",
                        run_id="llm-batched-null",
                    )
                row = catalog.connection.execute("SELECT * FROM files").fetchone()
            self.assertEqual(summary["selected"], 1)
            self.assertEqual(row["author"], "")

    def test_nonpositive_limit_is_rejected_before_a_run_is_created(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                for invalid_limit in (0, -1):
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        enrich_low_confidence_metadata(
                            catalog,
                            base / "archive",
                            model="fake",
                            limit=invalid_limit,
                        )
                run_count = catalog.connection.execute(
                    "SELECT COUNT(*) FROM runs"
                ).fetchone()[0]
                self.assertEqual(run_count, 0)

    def test_ungrounded_author_and_high_confidence_genre_are_locked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary), category="露骨H"
            )
            _FakeClient.author = "凭空作者"
            _FakeClient.title = "完全不存在的新书名"
            _FakeClient.genre = "都市"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-locks",
                )
                before = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(before["genre"], "露骨H")
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-locks",
                    )
                after = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(after["display_title"], before["display_title"])
                self.assertEqual(after["author"], "")
                self.assertEqual(after["genre"], "露骨H")
            self.assertGreaterEqual(summary["rejected_title"], 1)
            self.assertGreaterEqual(summary["rejected_author"], 1)
            self.assertGreaterEqual(summary["rejected_genre"], 1)
            self.assertEqual(summary["guardrail_only"], 1)
            self.assertEqual(summary["changed_records"], 0)

    def test_generic_author_is_allowed_without_literal_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(Path(temporary))
            _FakeClient.author = "作者不详"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-generic-author",
                )
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-generic-author",
                    )
                row = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(row["author"], "佚名")

    def test_null_clears_only_ambiguous_not_explicit_rule_author(self) -> None:
        class NullAuthorClient(_FakeClient):
            def enrich_batch(self, items):
                type(self).calls += 1
                results = []
                for item in items:
                    result = _model_result(item, author=None)
                    result["field_confidence"] = {
                        "title": 0.95,
                        "author": 0.20,
                        "genre": 0.95,
                    }
                    results.append(result)
                return results

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "都市"
            source.mkdir()
            ambiguous = source / "星河-逆旅.txt"
            explicit = source / "山海 作者：真作者.txt"
            ambiguous.write_text(_novel("星河"), encoding="utf-8")
            explicit.write_text(_novel("山海"), encoding="utf-8")
            archive = base / "archive"
            with LocalNovelCatalog(base / "catalog.sqlite3") as catalog:
                scan_sources(
                    catalog,
                    [source],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-author-locks",
                )
                rows = {
                    str(row["source_name"]): row
                    for row in catalog.connection.execute("SELECT * FROM files")
                }
                self.assertEqual(rows[ambiguous.name]["author"], "逆旅")
                self.assertEqual(rows[explicit.name]["author"], "真作者")
                with patch(
                    "fetcher.local_metadata.VLLMMetadataClient",
                    NullAuthorClient,
                ):
                    enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-null-author",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-author-locks",
                    )
                rows = {
                    str(row["source_name"]): row
                    for row in catalog.connection.execute("SELECT * FROM files")
                }
                self.assertEqual(rows[ambiguous.name]["author"], "")
                self.assertEqual(rows[explicit.name]["author"], "真作者")

    def test_ambiguous_author_can_be_corrected_only_with_input_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary),
                name="星河-旧猜测.txt",
                body=_novel("正文提到新作者"),
            )
            _FakeClient.author = "新作者"
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-correct-author",
                )
                before = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(before["author"], "旧猜测")
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-correct-author",
                        candidate_mode="confidence",
                        run_id="llm-correct-author",
                    )
                after = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(after["author"], "新作者")

    def test_high_title_field_confidence_is_used_when_overall_is_low(self) -> None:
        class SplitConfidenceClient(_FakeClient):
            def enrich_batch(self, items):
                type(self).calls += 1
                results = []
                for item in items:
                    result = _model_result(item)
                    result["confidence"] = 0.40
                    result["field_confidence"] = {
                        "title": 0.95,
                        "author": 0.10,
                        "genre": 0.20,
                    }
                    results.append(result)
                return results

        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(
                Path(temporary), category="未分类目录"
            )
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-split-confidence",
                )
                before = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertLess(float(before["title_confidence"]), 0.80)
                with patch(
                    "fetcher.local_metadata.VLLMMetadataClient",
                    SplitConfidenceClient,
                ):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-split",
                        candidate_mode="confidence",
                        run_id="llm-split-confidence",
                    )
                after = catalog.connection.execute("SELECT * FROM files").fetchone()
                self.assertEqual(float(after["title_confidence"]), 0.95)
            self.assertEqual(summary["accepted"], 1)
            self.assertEqual(summary["fallback"], 0)

    def test_successful_response_cache_avoids_request_on_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(Path(temporary))
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-cache",
                )
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    first = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-cache-first",
                    )
                    second = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-cache-second",
                    )
            self.assertEqual(first["cache_writes"], 1)
            self.assertEqual(second["cache_hits"], 1)
            self.assertEqual(second["submitted"], 0)
            self.assertEqual(_FakeClient.calls, 1)

    def test_invalid_and_transport_fallbacks_remain_retryable(self) -> None:
        class FallbackClient(_FakeClient):
            reason = "invalid-response"

            def enrich_batch(self, items):
                type(self).calls += 1
                results = []
                for item in items:
                    result = _model_result(item)
                    result["source"] = "rules"
                    result["evidence"] = [f"vllm:fallback:{type(self).reason}"]
                    results.append(result)
                return results

        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(Path(temporary))
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-fallback-cache",
                )
                FallbackClient.calls = 0
                with patch("fetcher.local_metadata.VLLMMetadataClient", FallbackClient):
                    first = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-invalid",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-invalid-first",
                    )
                    second = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-invalid",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-invalid-second",
                    )
                self.assertEqual(first["cache_writes"], 0)
                self.assertEqual(second["cache_hits"], 0)
                self.assertEqual(FallbackClient.calls, 2)

                FallbackClient.reason = "request-error"
                FallbackClient.calls = 0
                with patch("fetcher.local_metadata.VLLMMetadataClient", FallbackClient):
                    transport_first = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-transport",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-transport-first",
                    )
                    transport_second = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake-transport",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-transport-second",
                    )
                self.assertEqual(transport_first["cache_writes"], 0)
                self.assertEqual(transport_second["cache_hits"], 0)
                self.assertEqual(FallbackClient.calls, 2)

    def test_header_read_failure_is_audited_per_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source_file, archive, catalog_path = self._scan_one(Path(temporary))
            with LocalNovelCatalog(catalog_path) as catalog:
                scan_sources(
                    catalog,
                    [source_file.parent],
                    archive_root=archive,
                    workers=1,
                    stable_age_seconds=0,
                    run_id="scan-read-failure",
                )
                source_file.unlink()
                with patch("fetcher.local_metadata.VLLMMetadataClient", _FakeClient):
                    summary = enrich_low_confidence_metadata(
                        catalog,
                        archive,
                        model="fake",
                        genre_confidence_below=1.0,
                        candidate_mode="confidence",
                        run_id="llm-read-failure",
                    )
                event = catalog.connection.execute(
                    "SELECT decision, reasons_json FROM metadata_events "
                    "WHERE run_id='llm-read-failure'"
                ).fetchone()
                self.assertIsNotNone(event)
                self.assertEqual(event["decision"], "head_read_failure")
                self.assertTrue(json.loads(str(event["reasons_json"])))
            self.assertEqual(summary["read_failures"], 1)
            self.assertEqual(summary["submitted"], 0)
            self.assertEqual(_FakeClient.calls, 0)


if __name__ == "__main__":
    unittest.main()
