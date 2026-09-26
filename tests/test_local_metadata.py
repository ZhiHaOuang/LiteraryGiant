from __future__ import annotations

import json
import unittest

from fetcher.local_archive import CATEGORY_CODES
from fetcher.local_metadata import (
    MetadataResponseError,
    VLLMMetadataClient,
    build_local_metadata,
    canonical_name_key,
    classify_genre,
    clean_aliases,
    extract_metadata_from_file,
    parse_book_filename,
    strict_json_loads,
)


class FilenameMetadataTest(unittest.TestCase):
    def test_number_book_marks_and_explicit_author(self) -> None:
        result = parse_book_filename("6.《找错反派哥哥后》作者：青端.txt")
        self.assertEqual(result.title, "找错反派哥哥后")
        self.assertEqual(result.author, "青端")
        self.assertEqual(result.raw, "6.《找错反派哥哥后》作者：青端.txt")
        self.assertGreater(result.confidence, 0.95)
        self.assertTrue(any("book-title-marks" in item for item in result.evidence))

    def test_source_label_and_spaced_author(self) -> None:
        result = parse_book_filename(
            "(少年梦)综漫：里表世界，危在旦夕 作者：蕉下鹿.txt"
        )
        self.assertEqual(result.title, "综漫：里表世界，危在旦夕")
        self.assertEqual(result.author, "蕉下鹿")
        self.assertTrue(any("removed-source-label" in item for item in result.evidence))

    def test_chapter_range_is_removed(self) -> None:
        result = parse_book_filename("娱乐：璀璨人生1-340.txt")
        self.assertEqual(result.title, "娱乐：璀璨人生")
        self.assertIsNone(result.author)
        self.assertTrue(any("chapter-range" in item for item in result.evidence))

        abbreviated = parse_book_filename("娱乐：...1-340.txt")
        self.assertEqual(abbreviated.title, "娱乐")

    def test_book_marks_win_over_trailing_character_names(self) -> None:
        result = parse_book_filename("《A＆B》角色名 作者：X.txt")
        self.assertEqual(result.title, "A")
        self.assertEqual(result.aliases, ("B",))
        self.assertEqual(result.author, "X")
        self.assertTrue(any("ignored-after-book-title-marks" in item for item in result.evidence))

    def test_title_author_form(self) -> None:
        result = parse_book_filename("我的小说-张三.txt")
        self.assertEqual((result.title, result.author), ("我的小说", "张三"))
        self.assertLess(result.field_confidence["author"], 0.7)
        self.assertIn("我的小说-张三", result.aliases)

    def test_unlabelled_separator_keeps_the_full_title_interpretation(self) -> None:
        subtitle = parse_book_filename("X战警-逆转未来.txt")
        self.assertEqual(subtitle.title, "X战警")
        self.assertEqual(subtitle.author, "逆转未来")
        self.assertIn("X战警-逆转未来", subtitle.aliases)
        self.assertLess(subtitle.field_confidence["title"], 0.7)

        numeric_title = parse_book_filename("1984-2024.txt")
        self.assertEqual(numeric_title.title, "1984-2024")
        self.assertIsNone(numeric_title.author)

    def test_labelled_aliases_are_normalized_once(self) -> None:
        result = parse_book_filename("主标题（又名：《别名＆外传》） 作者：某某.txt")
        self.assertEqual(result.title, "主标题")
        self.assertEqual(result.aliases, ("别名&外传",))
        aliases = clean_aliases("主标题（又名：《别名＆外传》） 作者：某某.txt")
        self.assertEqual(aliases.value, ("别名&外传",))
        self.assertGreater(aliases.confidence, 0.8)

    def test_canonical_key_is_only_punctuation_sensitive(self) -> None:
        self.assertEqual(canonical_name_key("《A ＆ B》"), canonical_name_key("a&b"))

    def test_head_metadata_corrects_a_noisy_plain_filename(self) -> None:
        result = extract_metadata_from_file(
            "0007_下载文件.txt",
            """

            本文由某论坛整理
            书名：《真正书名》
            又名：《另一个名字》
            作者：甲乙
            第一章 开始
            """,
            "/incoming/晋江/0007_下载文件.txt",
        )
        self.assertEqual(result.title, "真正书名")
        self.assertEqual(result.author, "甲乙")
        self.assertIn("另一个名字", result.aliases)
        self.assertIn("下载文件", result.aliases)
        self.assertTrue(any("head-candidate-selected" in item for item in result.evidence))

    def test_filename_and_head_are_cross_confirmed(self) -> None:
        result = extract_metadata_from_file(
            "《真正书名》作者：甲乙.txt",
            "《真正书名》 作者：甲乙\n第一章",
        )
        self.assertEqual(result.title, "真正书名")
        self.assertEqual(result.author, "甲乙")
        self.assertGreater(result.confidence, 0.98)
        self.assertIn("title:filename-head-confirmed", result.evidence)
        self.assertIn("author:filename-head-confirmed", result.evidence)

    def test_weak_non_chinese_head_does_not_replace_chinese_filename(self) -> None:
        numeric = extract_metadata_from_file(
            "吾家妻宝-星幸的我.txt",
            "《1》\n第一章 开始",
        )
        self.assertEqual(numeric.title, "吾家妻宝")
        self.assertIn("1", numeric.aliases)
        self.assertIn("title:preferred-cjk-filename-over-weak-head", numeric.evidence)

        slug = extract_metadata_from_file(
            "天爵本纪之温情江湖-青墨煜香川.CS.txt",
            "《legendoftheking》\n第一章 江湖",
        )
        self.assertEqual(slug.title, "天爵本纪之温情江湖")

    def test_explicit_labelled_english_title_can_still_override_filename(self) -> None:
        result = extract_metadata_from_file(
            "中文占位书名.txt",
            "书名：The Real Title\n第一章",
        )
        self.assertEqual(result.title, "The Real Title")

    def test_head_scan_stops_after_two_hundred_nonempty_lines(self) -> None:
        head = "\n".join(["普通正文"] * 200 + ["书名：不应读取", "作者：不应读取"])
        result = extract_metadata_from_file("文件名.txt", head)
        self.assertEqual(result.title, "文件名")
        self.assertIsNone(result.author)


class GenreRulesTest(unittest.TestCase):
    def test_title_keyword_classifies_zongman(self) -> None:
        result = classify_genre(title="综漫：里表世界，危在旦夕")
        self.assertEqual(result.canonical_genre, "同人")
        self.assertIn("综漫", result.tags)
        self.assertFalse(result.low_confidence)
        self.assertTrue(result.evidence)

    def test_directory_hint_is_strong(self) -> None:
        result = classify_genre(
            title="没有明显关键词的名字",
            path="/incoming/科幻小说/作者/文件.txt",
        )
        self.assertEqual(result.genre, "科幻")
        self.assertGreater(result.confidence, 0.8)
        self.assertTrue(any("directory" in item for item in result.evidence))

    def test_harem_is_a_canonical_genre(self) -> None:
        explicit = classify_genre(title="都市多女主后宫文")
        self.assertEqual(explicit.genre, "后宫")
        self.assertIn("后宫", explicit.tags)

        path_hint = classify_genre(
            title="没有题材提示的名字",
            path="/incoming/后宫小说/作品.txt",
        )
        self.assertEqual(path_hint.genre, "后宫")
        self.assertGreater(path_hint.confidence, 0.8)

        palace_prose = classify_genre(
            title="宫墙往事",
            head_excerpt="她在后宫生活多年，见证了王朝兴衰。",
        )
        self.assertNotEqual(palace_prose.genre, "后宫")

    def test_explicit_adult_content_is_a_separate_canonical_genre(self) -> None:
        self.assertEqual(CATEGORY_CODES["露骨H"], "21")
        explicit = classify_genre(title="露骨H肉文合集")
        self.assertEqual(explicit.genre, "露骨H")
        self.assertIn("成人内容", explicit.tags)

        curated_source = classify_genre(
            title="没有题材提示的名字",
            path="/public/home/actueuo6co/后宫/作品.txt",
        )
        self.assertEqual(curated_source.genre, "露骨H")
        self.assertGreater(curated_source.confidence, 0.8)
        self.assertTrue(any("source-root" in item for item in curated_source.evidence))

        ordinary_harem = classify_genre(
            title="没有题材提示的名字",
            path="/incoming/后宫小说/作品.txt",
        )
        self.assertEqual(ordinary_harem.genre, "后宫")

    def test_excerpt_only_signal_is_marked_low_confidence(self) -> None:
        result = classify_genre(
            title="没有线索",
            head_excerpt="少年进入仙门，开始修仙，仍然不知道前路如何。",
        )
        self.assertEqual(result.genre, "仙侠")
        self.assertTrue(result.low_confidence)

    def test_unknown_is_other_and_low_confidence(self) -> None:
        result = classify_genre(title="白色房间")
        self.assertEqual(result.genre, "其他")
        self.assertTrue(result.low_confidence)
        self.assertEqual(result.confidence, 0.2)

    def test_flat_local_record_keeps_provenance(self) -> None:
        result = build_local_metadata(
            {
                "id": "book-1",
                "raw_name": "6.《找错反派哥哥后》作者：青端.txt",
                "path": "/incoming/现代言情/",
            }
        )
        self.assertEqual(result["id"], "book-1")
        self.assertEqual(result["title"], "找错反派哥哥后")
        self.assertEqual(result["canonical_name_key"], "找错反派哥哥后")
        self.assertEqual(result["genre"], "言情")
        self.assertIsInstance(result["confidence"], float)
        self.assertTrue(result["evidence"])


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return {"choices": [{"message": {"content": self.content}}]}


class _FakeSession:
    def __init__(self, content: str | None = None, error: Exception | None = None) -> None:
        self.content = content
        self.error = error
        self.calls: list[dict[str, object]] = []

    def post(self, url: str, **kwargs: object) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        if self.error:
            raise self.error
        assert self.content is not None
        return _FakeResponse(self.content)


def _model_item(item_id: str, *, genre: str = "都市") -> dict[str, object]:
    return {
        "id": item_id,
        "title": "璀璨人生",
        "author": "测试作者",
        "aliases": ["娱乐人生"],
        "genre": genre,
        "tags": ["娱乐圈"],
        "confidence": 0.91,
        "field_confidence": {"title": 0.91, "author": 0.88, "genre": 0.90},
        "evidence": ["文件名含娱乐关键词"],
    }


class VLLMClientTest(unittest.TestCase):
    def test_long_paths_are_tail_bounded_in_batch_prompt(self) -> None:
        content = json.dumps({"items": [_model_item("0")]}, ensure_ascii=False)
        session = _FakeSession(content)
        client = VLLMMetadataClient(
            "local-model", session=session, max_path_chars=20
        )
        client.enrich_batch(
            [{"raw_name": "璀璨人生.txt", "path": "/very/long/" + "目录" * 100}]
        )
        user_content = session.calls[0]["json"]["messages"][1]["content"]  # type: ignore[index]
        prompt = json.loads(user_content)
        self.assertLessEqual(len(prompt["items"][0]["path"]), 20)

    def test_strict_json_rejects_fences_and_trailing_prose(self) -> None:
        with self.assertRaises(MetadataResponseError):
            strict_json_loads('```json\n{"items": []}\n```')
        with self.assertRaises(MetadataResponseError):
            strict_json_loads('{"items": []} extra')

    def test_valid_model_response_is_merged(self) -> None:
        content = json.dumps({"items": [_model_item("0")]}, ensure_ascii=False)
        session = _FakeSession(content)
        client = VLLMMetadataClient("local-model", session=session)
        results = client.enrich_batch(
            [{"id": "external-id", "raw_name": "娱乐：璀璨人生1-340.txt"}]
        )
        self.assertEqual(results[0]["id"], "external-id")
        self.assertEqual(results[0]["source"], "vllm")
        self.assertEqual(results[0]["genre"], "都市")
        self.assertEqual(results[0]["author"], "测试作者")
        self.assertEqual(
            results[0]["field_confidence"],
            {"title": 0.91, "author": 0.88, "aliases": 0.91, "genre": 0.9},
        )
        self.assertTrue(any(item == "vllm:strict-json-validated" for item in results[0]["evidence"]))
        call = session.calls[0]
        self.assertEqual(call["url"], "http://127.0.0.1:8000/v1/chat/completions")
        response_format = call["json"]["response_format"]  # type: ignore[index]
        self.assertEqual(response_format["type"], "json_schema")
        self.assertTrue(response_format["json_schema"]["strict"])

    def test_non_allowlisted_genre_falls_back_for_only_that_item(self) -> None:
        content = json.dumps(
            {"items": [_model_item("0", genre="不存在的题材"), _model_item("1")]},
            ensure_ascii=False,
        )
        client = VLLMMetadataClient("local-model", session=_FakeSession(content), batch_size=2)
        results = client.enrich_batch(
            [
                {"raw_name": "未知标题.txt"},
                {"raw_name": "娱乐：璀璨人生.txt"},
            ]
        )
        self.assertEqual(results[0]["source"], "rules")
        self.assertTrue(any("missing-or-invalid-item" in item for item in results[0]["evidence"]))
        self.assertEqual(results[1]["source"], "vllm")

    def test_missing_per_field_confidence_is_rejected_by_strict_schema(self) -> None:
        item = _model_item("0")
        item.pop("field_confidence")
        content = json.dumps({"items": [item]}, ensure_ascii=False)
        result = VLLMMetadataClient(
            "local-model", session=_FakeSession(content)
        ).enrich_batch([{"raw_name": "璀璨人生.txt"}])[0]
        self.assertEqual(result["source"], "rules")
        self.assertTrue(
            any("missing-or-invalid-item" in value for value in result["evidence"])
        )

    def test_null_author_requires_low_author_field_confidence(self) -> None:
        item = _model_item("0")
        item["author"] = None
        content = json.dumps({"items": [item]}, ensure_ascii=False)
        result = VLLMMetadataClient(
            "local-model", session=_FakeSession(content)
        ).enrich_batch([{"raw_name": "璀璨人生.txt"}])[0]
        self.assertEqual(result["source"], "rules")

    def test_ascii_schema_genre_code_maps_back_to_chinese(self) -> None:
        item = _model_item("0")
        item["genre"] = "G14"
        content = json.dumps({"items": [item]}, ensure_ascii=False)
        result = VLLMMetadataClient(
            "local-model", session=_FakeSession(content)
        ).enrich_batch([{"raw_name": "夜班车.txt"}])[0]
        self.assertEqual(result["genre"], "惊悚")

    def test_transport_failure_is_conservative_rules_fallback(self) -> None:
        client = VLLMMetadataClient(
            "local-model",
            session=_FakeSession(error=RuntimeError("offline")),
        )
        result = client.enrich_batch([{"raw_name": "综漫：测试.txt"}])[0]
        self.assertEqual(result["source"], "rules")
        self.assertEqual(result["genre"], "同人")
        self.assertTrue(any("request-error" in item for item in result["evidence"]))

    def test_model_can_clear_an_ambiguous_unlabelled_author(self) -> None:
        item = _model_item("0")
        item.update({"title": "X战警-逆转未来", "author": None, "aliases": []})
        item["field_confidence"] = {"title": 0.91, "author": 0.2, "genre": 0.90}
        content = json.dumps({"items": [item]}, ensure_ascii=False)
        result = VLLMMetadataClient(
            "local-model", session=_FakeSession(content)
        ).enrich_batch([{"raw_name": "X战警-逆转未来.txt"}])[0]
        self.assertEqual(result["title"], "X战警-逆转未来")
        self.assertIsNone(result["author"])


if __name__ == "__main__":
    unittest.main()
