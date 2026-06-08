from __future__ import annotations

import json
import re
from pathlib import Path


def normalize_fs_name(name: str) -> str:
    """Sanitise a string so it can be used as a file-system directory name."""
    normalized = re.sub(r'[<>:"/\\|?*\n\r\t]+', "_", name).strip(" .")
    return normalized or "unknown_book"


def canonical_book_slug(book_id: str) -> str:
    """Return the canonical derived/source directory slug for a book id."""
    normalized = normalize_fs_name(str(book_id).strip())
    if normalized.startswith(("book_", "story_")):
        return normalized
    return f"book_{normalized}"


def load_json(path: str | Path) -> dict:
    """Read and parse a JSON file, returning a dictionary."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def serialize_payload(payload: dict, *, pretty: bool = True) -> str:
    """Serialize a dictionary to a JSON string.

    When *pretty* is ``True`` (the default) the output is indented;
    otherwise it is compact.
    """
    if pretty:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
