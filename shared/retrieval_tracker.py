from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stream_sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def compute_path_signature(path: str | Path) -> str:
    target = Path(path).expanduser().resolve()
    if target.is_file():
        return _stream_sha1(target)
    if target.is_dir():
        digest = hashlib.sha1()
        for child in sorted(item for item in target.rglob("*") if item.is_file()):
            relative = child.relative_to(target).as_posix().encode("utf-8")
            digest.update(relative)
            digest.update(b"\0")
            digest.update(_stream_sha1(child).encode("ascii"))
            digest.update(b"\0")
        return digest.hexdigest()
    raise FileNotFoundError(f"Path does not exist for signature computation: {target}")


class PipelineState:
    def __init__(self, *, retrieval_root: str | Path = "runs/pipeline_state") -> None:
        self.retrieval_root = Path(retrieval_root)
        self.retrieval_root.mkdir(parents=True, exist_ok=True)
        self.path = self.retrieval_root / "state.json"
        self.legacy_path = self.retrieval_root / "states.json"
        self.legacy_roots = [
            Path("retrieval_file") / "state.json",
            Path("retrieval_file") / "states.json",
        ]
        self.payload = self._load()
        if not self.path.exists():
            self.save()

    def _default_payload(self) -> dict[str, Any]:
        return {
            "name": "state",
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            "last_sequence": 0,
            "runs": {},
            "books": [],
        }

    def _load(self) -> dict[str, Any]:
        if self.path.exists():
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            return self._normalize_payload(payload)
        if self.legacy_path.exists():
            return self._migrate_legacy_payload(json.loads(self.legacy_path.read_text(encoding="utf-8")))
        for legacy_path in self.legacy_roots:
            if legacy_path.exists():
                payload = json.loads(legacy_path.read_text(encoding="utf-8"))
                if legacy_path.name == "states.json":
                    return self._migrate_legacy_payload(payload)
                return self._normalize_payload(payload)
        return self._default_payload()

    def _normalize_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload.setdefault("name", "state")
        payload.setdefault("created_at", _utc_now())
        payload.setdefault("updated_at", _utc_now())
        payload.setdefault("last_sequence", 0)
        payload.setdefault("runs", {})
        payload.setdefault("books", [])
        for book in payload["books"]:
            book.setdefault("index", "")
            book.setdefault("source_name", "")
            book.setdefault("source_path", "")
            book.setdefault("source_signature", "")
            book.setdefault("raw_stats", {})
            book.setdefault("steps", {})
            book.setdefault("chapters", [])
            for chapter in book["chapters"]:
                chapter.setdefault("chapter_id", "")
                chapter.setdefault("order", 0)
                chapter.setdefault("clean_title", "")
                chapter.setdefault("source_path", "")
                chapter.setdefault("source_signature", "")
                chapter.setdefault("metadata", {})
                chapter.setdefault("steps", {})
        return payload

    def _migrate_legacy_payload(self, legacy: dict[str, Any]) -> dict[str, Any]:
        payload = self._default_payload()
        next_index = str(legacy.get("next_index", "0001")).strip() or "0001"
        try:
            payload["last_sequence"] = max(0, int(next_index) - 1)
        except ValueError:
            payload["last_sequence"] = 0

        books: list[dict[str, Any]] = []
        for item in legacy.get("books", []):
            books.append(
                {
                    "index": item.get("index", f"{len(books) + 1:04d}"),
                    "source_name": item.get("source_name", ""),
                    "source_path": "",
                    "source_signature": item.get("content_hash", ""),
                    "raw_stats": {
                        "detected_encoding": item.get("detected_encoding", ""),
                        "char_count": item.get("char_count", 0),
                        "line_count": item.get("line_count", 0),
                        "file_size_mb": item.get("file_size_mb", 0),
                    },
                    "steps": {
                        "hardmodel": {
                            "status": "completed" if item.get("preprocess_done") else "pending",
                            "processed_at": "",
                            "input_signature": item.get("content_hash", ""),
                            "output_path": "",
                            "params": {},
                            "book_metadata": {
                                "target_name": item.get("target_name", ""),
                            },
                        }
                    },
                    "chapters": [],
                }
            )
        payload["books"] = books
        return payload

    def save(self) -> None:
        self.payload["updated_at"] = _utc_now()
        self.path.write_text(json.dumps(self.payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def begin_run(self, step_name: str, *, total_candidates: int) -> None:
        self.payload.setdefault("runs", {})[step_name] = {
            "started_at": _utc_now(),
            "finished_at": "",
            "total_candidates": total_candidates,
            "processed": 0,
            "skipped": 0,
            "failed": 0,
        }
        self.save()

    def increment_run_counter(self, step_name: str, field: str) -> None:
        run = self.payload.setdefault("runs", {}).setdefault(step_name, {})
        run[field] = run.get(field, 0) + 1

    def finish_run(self, step_name: str) -> None:
        self.payload.setdefault("runs", {}).setdefault(step_name, {})["finished_at"] = _utc_now()
        self.save()

    def run_stats(self, step_name: str) -> dict[str, Any]:
        return self.payload.setdefault("runs", {}).setdefault(step_name, {})

    def next_sequence(self) -> str:
        self.payload["last_sequence"] = int(self.payload.get("last_sequence", 0)) + 1
        return f"{int(self.payload['last_sequence']):04d}"

    def _books(self) -> list[dict[str, Any]]:
        return self.payload.setdefault("books", [])

    @staticmethod
    def _normalized_path(path: str | Path) -> str:
        return str(Path(path).expanduser().resolve())

    def find_book(self, *, source_path: str | Path, source_signature: str | None = None) -> dict[str, Any] | None:
        normalized_path = self._normalized_path(source_path)
        source_name = Path(source_path).name

        for book in reversed(self._books()):
            if source_signature and book.get("source_signature") == source_signature:
                return book

        for book in reversed(self._books()):
            if book.get("source_path") == normalized_path:
                return book

        for book in reversed(self._books()):
            if book.get("source_name") == source_name:
                return book
        return None

    def get_or_create_book(
        self,
        *,
        source_path: str | Path,
        source_signature: str,
        update_source_signature: bool = True,
    ) -> tuple[dict[str, Any], bool]:
        existing = self.find_book(source_path=source_path, source_signature=source_signature)
        if existing is not None:
            existing["source_path"] = self._normalized_path(source_path)
            existing["source_name"] = Path(source_path).name
            if update_source_signature:
                existing["source_signature"] = source_signature
            return existing, False

        record = {
            "index": self.next_sequence(),
            "source_name": Path(source_path).name,
            "source_path": self._normalized_path(source_path),
            "source_signature": source_signature,
            "raw_stats": {},
            "steps": {},
            "chapters": [],
        }
        self._books().append(record)
        return record, True

    def should_skip_step(
        self,
        *,
        step_name: str,
        source_path: str | Path,
        source_signature: str,
        output_path: str | Path | None = None,
    ) -> tuple[bool, dict[str, Any] | None]:
        book = self.find_book(source_path=source_path, source_signature=source_signature)
        if book is None:
            return False, None

        step = book.get("steps", {}).get(step_name, {})
        if step.get("status") != "completed":
            return False, book
        if step.get("input_signature") != source_signature:
            return False, book

        resolved_output = output_path or step.get("output_path", "")
        if resolved_output and not Path(resolved_output).exists():
            return False, book
        return True, book

    def update_raw_stats(self, book: dict[str, Any], raw_stats: dict[str, Any]) -> None:
        book["raw_stats"] = raw_stats

    def _chapters(self, book: dict[str, Any]) -> list[dict[str, Any]]:
        return book.setdefault("chapters", [])

    def find_chapter(self, book: dict[str, Any], *, chapter_id: str) -> dict[str, Any] | None:
        for chapter in self._chapters(book):
            if chapter.get("chapter_id") == chapter_id:
                return chapter
        return None

    def get_or_create_chapter(
        self,
        book: dict[str, Any],
        *,
        chapter_id: str,
        order: int,
        clean_title: str,
        source_path: str | Path,
        source_signature: str,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], bool]:
        existing = self.find_chapter(book, chapter_id=chapter_id)
        if existing is not None:
            existing["order"] = order
            existing["clean_title"] = clean_title
            existing["source_path"] = self._normalized_path(source_path)
            existing["source_signature"] = source_signature
            if metadata is not None:
                existing["metadata"] = metadata
            return existing, False

        record = {
            "chapter_id": chapter_id,
            "order": order,
            "clean_title": clean_title,
            "source_path": self._normalized_path(source_path),
            "source_signature": source_signature,
            "metadata": metadata or {},
            "steps": {},
        }
        self._chapters(book).append(record)
        self._chapters(book).sort(key=lambda item: (int(item.get("order", 0)), item.get("chapter_id", "")))
        return record, True

    def prune_book_chapters(self, book: dict[str, Any], *, valid_chapter_ids: set[str]) -> None:
        book["chapters"] = [chapter for chapter in self._chapters(book) if chapter.get("chapter_id") in valid_chapter_ids]

    def should_skip_chapter(
        self,
        *,
        step_name: str,
        chapter: dict[str, Any],
        input_signature: str,
        output_path: str | Path | None = None,
    ) -> bool:
        step = chapter.get("steps", {}).get(step_name, {})
        if step.get("status") != "completed":
            return False
        if step.get("input_signature") != input_signature:
            return False
        resolved_output = output_path or step.get("output_path", "")
        if resolved_output and not Path(resolved_output).exists():
            return False
        return True

    def record_step(
        self,
        *,
        step_name: str,
        book: dict[str, Any],
        source_signature: str,
        status: str,
        output_path: str | Path | None,
        params: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        book.setdefault("steps", {})[step_name] = {
            "status": status,
            "processed_at": _utc_now(),
            "input_signature": source_signature,
            "output_path": self._normalized_path(output_path) if output_path else "",
            "params": params or {},
            "metadata": metadata or {},
            "error": error,
        }

    def record_chapter_step(
        self,
        *,
        step_name: str,
        chapter: dict[str, Any],
        input_signature: str,
        status: str,
        output_path: str | Path | None,
        params: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        chapter.setdefault("steps", {})[step_name] = {
            "status": status,
            "processed_at": _utc_now(),
            "input_signature": input_signature,
            "output_path": self._normalized_path(output_path) if output_path else "",
            "params": params or {},
            "metadata": metadata or {},
            "error": error,
        }
