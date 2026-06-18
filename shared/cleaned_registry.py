from __future__ import annotations

import copy
import fcntl
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import FACT_CLEANED_CHAPTERS_ROOT, INDEXES_ROOT, LIBRARY_ROOT
from .utils import canonical_book_slug


CLEANED_BOOKS_REGISTRY_PATH = INDEXES_ROOT / "cleaned_books.json"
LAYOUT_VERSION = "novel-agent-cleaned-registry-v1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_rel_path(path: str | Path) -> str:
    target = Path(path).expanduser().resolve()
    try:
        return target.relative_to(LIBRARY_ROOT.resolve()).as_posix()
    except ValueError:
        return str(target)


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _id_from_slug(value: str, *, width: int = 4) -> str:
    raw = str(value).strip()
    if raw.startswith(("book_", "story_")):
        raw = raw.split("_", 1)[1]
    if raw.isdigit():
        return f"{int(raw):0{width}d}"
    raise ValueError(f"Cleaned registry ids must be numeric: {value!r}")


def compute_source_fingerprint(source: Any) -> str:
    """Return the cheap book-level marker used for registry lineage.

    This deliberately does not hash source content or manifest payload.  The
    hardmodel freshness policy treats equal chapter counts as unchanged.
    """
    index_path = Path(source.source_dir) / "index.json"
    index_payload = _load_json(index_path)
    chapters = getattr(source, "chapters", []) or []
    index_chapters = index_payload.get("chapters")
    if not isinstance(index_chapters, list):
        index_chapters = []
    return f"chapters:{len(index_chapters) or len(chapters)}"


@contextmanager
def _locked_file(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(path) + ".lock")
    with lock_path.open("w", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class CleanedBookRegistry:
    """Persistent mapping from raw sources to curated cleaned artifacts.

    Raw ``book_XXXX`` slugs are treated as permanent identities.  Cleaned
    artifacts therefore use the same numeric id/slug as their raw source, so
    ``TaciturnRaw/novels_raw/book_0027`` maps to
    ``TaciturnRaw/novels_cleaned/book_0027``.
    """

    def __init__(
        self,
        path: str | Path = CLEANED_BOOKS_REGISTRY_PATH,
        *,
        width: int = 4,
    ) -> None:
        self.path = Path(path)
        self.width = width
        self.payload = self._load()

    def register_source(
        self,
        source: Any,
        *,
        source_signature: str | None = None,
        output_root: str | Path | None = None,
        replace_clean_slug: str | None = None,
    ) -> dict[str, Any]:
        """Assign a stable cleaned id for a raw ``BookSource``.

        Existing active raw sources keep their cleaned id.  New sources use
        the numeric suffix from their raw slug, keeping raw and clean identities
        one-to-one.
        """
        signature = source_signature or compute_source_fingerprint(source)
        raw = self.raw_reference(source, source_signature=signature)

        with _locked_file(self.path):
            self.payload = self._load()
            if replace_clean_slug:
                entry = self._replace_source_unlocked(
                    replace_clean_slug,
                    source,
                    raw=raw,
                    output_root=output_root,
                )
                self._write_unlocked()
                return copy.deepcopy(entry)

            existing = self._find_active_by_raw(raw)
            if existing is not None:
                existing["title"] = raw.get("title") or existing.get("title", "")
                existing["content_type"] = raw.get("content_type") or existing.get("content_type", "book")
                existing["raw"] = raw
                existing.setdefault("paths", {})["rawdata"] = raw.get("raw_path", "")
                existing.setdefault("paths", {})["cleaned_chapters"] = self._cleaned_path(
                    existing["clean_id"],
                    output_root=output_root,
                    clean_slug=existing.get("clean_slug"),
                )
                existing["updated_at"] = _utc_now()
                self._append_event("refresh", existing)
                self._write_unlocked()
                return copy.deepcopy(existing)

            clean_id = self._clean_id_from_raw(raw)
            self._assert_clean_slot_available_unlocked(clean_id, raw)
            entry = self._new_entry(clean_id, raw, output_root=output_root)
            self.payload.setdefault("books", {})[clean_id] = entry
            self.payload["last_id"] = max(int(self.payload.get("last_id", 0)), int(clean_id))
            self._append_event("register", entry)
            self._write_unlocked()
            return copy.deepcopy(entry)

    def replace_source(
        self,
        clean_slug: str,
        source: Any,
        *,
        source_signature: str | None = None,
        output_root: str | Path | None = None,
    ) -> dict[str, Any]:
        signature = source_signature or compute_source_fingerprint(source)
        raw = self.raw_reference(source, source_signature=signature)
        with _locked_file(self.path):
            self.payload = self._load()
            entry = self._replace_source_unlocked(
                clean_slug,
                source,
                raw=raw,
                output_root=output_root,
            )
            self._write_unlocked()
            return copy.deepcopy(entry)

    def mark_deleted(self, clean_slug: str, *, reason: str = "") -> dict[str, Any]:
        """Remove an active cleaned id and make its numeric slot reusable."""
        clean_id = _id_from_slug(clean_slug, width=self.width)
        with _locked_file(self.path):
            self.payload = self._load()
            books = self.payload.setdefault("books", {})
            entry = books.pop(clean_id, None)
            if entry is None:
                raise KeyError(f"Unknown active cleaned id: {clean_slug}")
            snapshot = copy.deepcopy(entry)
            snapshot["deleted_at"] = _utc_now()
            snapshot["delete_reason"] = reason
            self.payload.setdefault("deleted", {}).setdefault(clean_id, []).append(snapshot)
            self._append_event("delete", snapshot)
            self._write_unlocked()
            return snapshot

    def record_cleaned(
        self,
        clean_slug: str,
        *,
        book_metadata: dict[str, Any],
        output_dir: str | Path,
        source_signature: str | None = None,
    ) -> dict[str, Any]:
        clean_id = _id_from_slug(clean_slug, width=self.width)
        with _locked_file(self.path):
            self.payload = self._load()
            entry = self.payload.setdefault("books", {}).get(clean_id)
            if entry is None:
                raise KeyError(f"Unknown active cleaned id: {clean_slug}")
            if source_signature:
                entry.setdefault("raw", {})["source_signature"] = source_signature
            entry.setdefault("paths", {})["cleaned_chapters"] = _as_rel_path(output_dir)
            entry["last_cleaned"] = {
                "at": _utc_now(),
                "source_signature": entry.get("raw", {}).get("source_signature", ""),
                "chapter_count": book_metadata.get("chapter_count", 0),
                "total_chars": book_metadata.get("total_chars", 0),
                "total_paragraphs": book_metadata.get("total_paragraphs", 0),
                "cleaning_stats": book_metadata.get("cleaning_stats", {}),
                "cleaning_summary": book_metadata.get("cleaning_summary", {}),
            }
            entry["updated_at"] = _utc_now()
            self._append_event("clean", entry)
            self._write_unlocked()
            return copy.deepcopy(entry)

    def metadata_for(self, entry: dict[str, Any]) -> dict[str, Any]:
        return {
            "clean_registry": {
                "registry_path": _as_rel_path(self.path),
                "clean_id": entry.get("clean_id", ""),
                "clean_slug": entry.get("clean_slug", ""),
            },
            "source_lineage": copy.deepcopy(entry.get("raw", {})),
        }

    def find_entry_for_source(
        self,
        source: Any,
        *,
        source_signature: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the active clean entry for *source* without mutating registry."""
        signature = source_signature or compute_source_fingerprint(source)
        raw = self.raw_reference(source, source_signature=signature)
        self.payload = self._load()
        entry = self._find_active_by_raw(raw)
        return copy.deepcopy(entry) if entry is not None else None

    def source_is_current(
        self,
        source: Any,
        *,
        source_signature: str | None = None,
        output_root: str | Path | None = None,
        allow_chapter_count_match: bool = True,
    ) -> tuple[bool, dict[str, Any] | None, str]:
        """Return whether an active clean entry already covers *source*.

        Freshness is intentionally chapter-count based.  If the cleaned output
        exists and the last cleaned chapter count matches the current source
        chapter count, the book is considered current.
        """
        entry = self.find_entry_for_source(
            source,
            source_signature=source_signature or compute_source_fingerprint(source),
        )
        if entry is None:
            return False, None, "not_registered"

        output_dir = self.output_dir_for_entry(entry, output_root=output_root)
        if not output_dir.exists() or not (output_dir / "index.json").exists():
            return False, entry, "missing_output"

        last_cleaned = entry.get("last_cleaned") or {}
        expected_count = len(getattr(source, "chapters", []) or [])
        try:
            cleaned_count = int(last_cleaned.get("chapter_count") or -1)
        except (TypeError, ValueError):
            cleaned_count = -1
        if allow_chapter_count_match and expected_count > 0 and cleaned_count == expected_count:
            return True, entry, "chapter_count_match"

        return False, entry, "chapter_count_changed"

    def output_dir_for_entry(
        self,
        entry: dict[str, Any],
        *,
        output_root: str | Path | None = None,
    ) -> Path:
        if output_root is not None:
            clean_slug = entry.get("clean_slug") or canonical_book_slug(entry.get("clean_id", ""))
            return Path(output_root) / clean_slug
        raw_path = str(entry.get("paths", {}).get("cleaned_chapters") or "")
        if raw_path:
            path = Path(raw_path)
            return path if path.is_absolute() else LIBRARY_ROOT / path
        clean_slug = entry.get("clean_slug") or canonical_book_slug(entry.get("clean_id", ""))
        return FACT_CLEANED_CHAPTERS_ROOT / clean_slug

    def active_entries(self) -> list[dict[str, Any]]:
        books = self.payload.get("books", {})
        return [
            copy.deepcopy(entry)
            for _, entry in sorted(books.items(), key=lambda item: int(item[0]))
        ]

    def active_entries_by_raw_slug(self) -> dict[str, dict[str, Any]]:
        """Return active entries keyed by their raw book/story slug."""
        entries: dict[str, dict[str, Any]] = {}
        for entry in self.active_entries():
            raw_slug = str(entry.get("raw", {}).get("raw_book_slug") or "")
            if raw_slug:
                entries[raw_slug] = entry
        return entries

    def entry_has_clean_output(
        self,
        entry: dict[str, Any],
        *,
        output_root: str | Path | None = None,
        require_last_cleaned: bool = True,
    ) -> tuple[bool, str]:
        """Return whether *entry* has enough cleaned output for fast resume."""
        if require_last_cleaned and not entry.get("last_cleaned"):
            return False, "never_cleaned"
        output_dir = self.output_dir_for_entry(entry, output_root=output_root)
        if not output_dir.exists():
            return False, "missing_output_dir"
        if not (output_dir / "index.json").exists():
            return False, "missing_output_index"
        return True, "id_output_match"

    def raw_reference(self, source: Any, *, source_signature: str) -> dict[str, Any]:
        index_payload = _load_json(Path(source.source_dir) / "index.json")
        raw_slug = (
            index_payload.get("book_slug")
            or index_payload.get("story_slug")
            or canonical_book_slug(source.book_id)
        )
        source_url = str(index_payload.get("source_url") or "").strip()
        content_type = str(index_payload.get("content_type") or source.content_type or "book")
        raw_path = _as_rel_path(source.source_dir)
        primary_source = _as_rel_path(source.primary_source)
        index_path = Path(source.source_dir) / "index.json"

        raw: dict[str, Any] = {
            "raw_book_id": str(source.book_id),
            "raw_book_slug": str(raw_slug),
            "raw_path": raw_path,
            "raw_primary_source": primary_source,
            "raw_index_path": _as_rel_path(index_path) if index_path.exists() else "",
            "source_signature": source_signature,
            "source_url": source_url,
            "adapter_domain": str(index_payload.get("adapter_domain") or ""),
            "title": str(index_payload.get("title") or source.title or ""),
            "content_type": content_type,
            "processing_profile": str(
                index_payload.get("processing_profile")
                or source.processing_profile
                or "longform_book"
            ),
            "chapter_count": len(getattr(source, "chapters", []) or []),
            "fetcher_run_id": str(index_payload.get("fetcher_run_id") or ""),
        }
        if source_url:
            raw["identity_key"] = f"url:{source_url.rstrip('/')}"
        else:
            raw["identity_key"] = f"path:{raw_path}"
        return raw

    def _load(self) -> dict[str, Any]:
        payload = _load_json(self.path)
        if not payload:
            payload = {
                "layout_version": LAYOUT_VERSION,
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
                "last_id": 0,
                "books": {},
                "deleted": {},
                "events": [],
            }
        payload.setdefault("layout_version", LAYOUT_VERSION)
        payload.setdefault("created_at", _utc_now())
        payload.setdefault("updated_at", _utc_now())
        payload.setdefault("last_id", 0)
        payload.setdefault("books", {})
        payload.setdefault("deleted", {})
        payload.setdefault("events", [])
        return payload

    def _write_unlocked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.payload["updated_at"] = _utc_now()
        tmp_path = Path(str(self.path) + ".tmp")
        tmp_path.write_text(
            json.dumps(self.payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp_path, self.path)

    def _clean_id_from_raw(self, raw: dict[str, Any]) -> str:
        raw_slug = str(raw.get("raw_book_slug") or raw.get("raw_book_id") or "").strip()
        return _id_from_slug(raw_slug, width=self.width)

    def _assert_clean_slot_available_unlocked(self, clean_id: str, raw: dict[str, Any]) -> None:
        existing = self.payload.get("books", {}).get(clean_id)
        if existing is None:
            return
        existing_raw = existing.get("raw", {})
        existing_slug = existing_raw.get("raw_book_slug")
        raw_slug = raw.get("raw_book_slug")
        if existing_slug != raw_slug:
            raise ValueError(
                "Cleaned registry id collision: "
                f"clean_id={clean_id} is already assigned to raw={existing_slug!r}, "
                f"cannot assign raw={raw_slug!r}."
            )

    def _new_entry(
        self,
        clean_id: str,
        raw: dict[str, Any],
        *,
        output_root: str | Path | None,
        clean_slug: str | None = None,
    ) -> dict[str, Any]:
        now = _utc_now()
        clean_slug = clean_slug or str(raw.get("raw_book_slug") or canonical_book_slug(clean_id))
        return {
            "clean_id": clean_id,
            "clean_slug": clean_slug,
            "status": "active",
            "content_type": raw.get("content_type", "book"),
            "title": raw.get("title", ""),
            "created_at": now,
            "updated_at": now,
            "raw": raw,
            "paths": {
                "rawdata": raw.get("raw_path", ""),
                "cleaned_chapters": self._cleaned_path(
                    clean_id,
                    output_root=output_root,
                    clean_slug=clean_slug,
                ),
            },
            "history": [],
        }

    def _replace_source_unlocked(
        self,
        clean_slug: str,
        source: Any,
        *,
        raw: dict[str, Any],
        output_root: str | Path | None,
    ) -> dict[str, Any]:
        clean_id = _id_from_slug(clean_slug, width=self.width)
        books = self.payload.setdefault("books", {})
        entry = books.get(clean_id)
        if entry is None:
            entry = self._new_entry(
                clean_id,
                raw,
                output_root=output_root,
                clean_slug=clean_slug,
            )
            books[clean_id] = entry
            self.payload["last_id"] = max(int(self.payload.get("last_id", 0)), int(clean_id))
            self._append_event("replace-create", entry)
            return entry

        previous = {
            "raw": copy.deepcopy(entry.get("raw", {})),
            "title": entry.get("title", ""),
            "last_cleaned": copy.deepcopy(entry.get("last_cleaned", {})),
            "replaced_at": _utc_now(),
        }
        entry.setdefault("history", []).append(previous)
        entry["title"] = raw.get("title") or getattr(source, "title", "")
        entry["content_type"] = raw.get("content_type", entry.get("content_type", "book"))
        entry["raw"] = raw
        entry.setdefault("paths", {})["rawdata"] = raw.get("raw_path", "")
        entry.setdefault("paths", {})["cleaned_chapters"] = self._cleaned_path(
            clean_id,
            output_root=output_root,
            clean_slug=entry.get("clean_slug"),
        )
        entry["updated_at"] = _utc_now()
        self._append_event("replace", entry)
        return entry

    def _find_active_by_raw(self, raw: dict[str, Any]) -> dict[str, Any] | None:
        raw_path = raw.get("raw_path")
        raw_slug = raw.get("raw_book_slug")
        if raw_slug:
            expected_clean_id = self._clean_id_from_raw(raw)
            for entry in self.payload.get("books", {}).values():
                known = entry.get("raw", {})
                if known.get("raw_book_slug") == raw_slug and entry.get("clean_id") == expected_clean_id:
                    return entry
            return None

        if raw_path:
            for entry in self.payload.get("books", {}).values():
                known = entry.get("raw", {})
                if known.get("raw_path") == raw_path:
                    return entry
            return None

        identity_key = raw.get("identity_key")
        source_url = raw.get("source_url")
        for entry in self.payload.get("books", {}).values():
            known = entry.get("raw", {})
            if identity_key and known.get("identity_key") == identity_key:
                return entry
            if source_url and known.get("source_url") == source_url:
                return entry
        return None

    def _cleaned_path(
        self,
        clean_id: str,
        *,
        output_root: str | Path | None,
        clean_slug: str | None = None,
    ) -> str:
        root = Path(output_root) if output_root is not None else FACT_CLEANED_CHAPTERS_ROOT
        return _as_rel_path(root / (clean_slug or canonical_book_slug(clean_id)))

    def _append_event(self, event_type: str, entry: dict[str, Any]) -> None:
        event = {
            "type": event_type,
            "at": _utc_now(),
            "clean_id": entry.get("clean_id", ""),
            "clean_slug": entry.get("clean_slug", ""),
            "raw_book_slug": entry.get("raw", {}).get("raw_book_slug", ""),
        }
        events = self.payload.setdefault("events", [])
        events.append(event)
        if len(events) > 2000:
            del events[:-2000]
