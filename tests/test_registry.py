from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fetcher.registry as registry_module
from fetcher.registry import BookRegistry


def _write_registry(path: Path, *, last_id: int, books: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "layout_version": "novel-agent-data-v1",
                "last_id": last_id,
                "books": books or {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


class BookRegistryIdAllocationTests(unittest.TestCase):
    def test_global_registry_and_disk_scan_is_cached(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry_path = root / "indexes" / "books.json"
            raw_root = root / "raw"
            cleaned_root = root / "cleaned"
            stories_root = root / "stories"
            raw_root.mkdir()
            cleaned_root.mkdir()
            stories_root.mkdir()
            (cleaned_root / "id000710").mkdir()
            _write_registry(
                registry_path,
                last_id=3,
                books={
                    "id000703": {
                        "book_id": "id000703",
                        "book_slug": "id000703",
                        "content_type": "book",
                    }
                },
            )

            with (
                patch.object(registry_module, "TACITURN_NOVELS_RAW_ROOT", raw_root),
                patch.object(registry_module, "TACITURN_NOVELS_CLEANED_ROOT", cleaned_root),
                patch.object(registry_module, "TACITURN_STORIES_RAW_ROOT", stories_root),
            ):
                registry = BookRegistry(registry_path)
                with patch.object(
                    registry,
                    "_initial_global_id_high_watermark",
                    wraps=registry._initial_global_id_high_watermark,
                ) as initial_scan:
                    self.assertEqual(registry._next_id(content_type="book"), "id000711")

                    # Created after the initial scan: the exact candidate probe
                    # must avoid it without another glob over the collection.
                    (raw_root / "id000712").mkdir()
                    registry.payload["last_id"] = 711
                    self.assertEqual(registry._next_id(content_type="book"), "id000713")
                    initial_scan.assert_called_once()

    def test_register_uses_reloaded_last_id_after_cache_warmup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry_path = root / "indexes" / "books.json"
            raw_root = root / "raw"
            cleaned_root = root / "cleaned"
            stories_root = root / "stories"
            raw_root.mkdir()
            cleaned_root.mkdir()
            stories_root.mkdir()
            _write_registry(registry_path, last_id=0)

            with (
                patch.object(registry_module, "TACITURN_NOVELS_RAW_ROOT", raw_root),
                patch.object(registry_module, "TACITURN_NOVELS_CLEANED_ROOT", cleaned_root),
                patch.object(registry_module, "TACITURN_STORIES_RAW_ROOT", stories_root),
            ):
                registry = BookRegistry(registry_path)
                self.assertEqual(
                    registry.register("第一本", dedupe_by_title=False),
                    "id000001",
                )

                # Simulate another process advancing the counter while this
                # instance keeps its in-memory disk high-water cache.
                external_payload = json.loads(registry_path.read_text(encoding="utf-8"))
                external_payload["last_id"] = 40
                registry_path.write_text(
                    json.dumps(external_payload, ensure_ascii=False),
                    encoding="utf-8",
                )
                # Also simulate an out-of-band directory at the next ID.  The
                # allocator should probe and skip it after reading last_id=40.
                (raw_root / "id000041").mkdir()

                self.assertEqual(
                    registry.register("第二本", dedupe_by_title=False),
                    "id000042",
                )

            payload = json.loads(registry_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["last_id"], 42)
            self.assertIn("id000042", payload["books"])


if __name__ == "__main__":
    unittest.main()
