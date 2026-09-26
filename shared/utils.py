from __future__ import annotations

import json
import re
from pathlib import Path


UNIFIED_CONTENT_ID_WIDTH = 6
_UNIFIED_CONTENT_ID_RE = re.compile(r"id(\d+)", re.IGNORECASE)
_LEGACY_CONTENT_ID_RE = re.compile(r"(?:book|story)_(\d+)", re.IGNORECASE)


def normalize_fs_name(name: str) -> str:
    """Sanitise a string so it can be used as a file-system directory name."""
    normalized = re.sub(r'[<>:"/\\|?*\n\r\t]+', "_", name).strip(" .")
    return normalized or "unknown_book"


def content_id_number(value: str | int) -> int:
    """Return the numeric part of a unified or legacy content identifier.

    The migration accepts existing ``book_0001``/``story_0001`` values while
    new corpus identities use the type-neutral ``id000001`` form.
    """

    raw = str(value).strip()
    match = _UNIFIED_CONTENT_ID_RE.fullmatch(raw) or _LEGACY_CONTENT_ID_RE.fullmatch(raw)
    if match is not None:
        return int(match.group(1))
    if raw.isdigit():
        return int(raw)
    raise ValueError(f"Content id must be numeric, idNNNNNN, book_NNNN or story_NNNN: {value!r}")


def canonical_content_id(value: str | int, *, width: int = UNIFIED_CONTENT_ID_WIDTH) -> str:
    """Return the type-neutral, zero-padded ``idNNNNNN`` representation."""

    number = content_id_number(value)
    if number < 0 or number >= 10**width:
        raise ValueError(f"Content id is outside the {width}-digit namespace: {value!r}")
    return f"id{number:0{width}d}"


def is_unified_content_id(value: object) -> bool:
    """Return whether *value* is already an ``id``-prefixed identifier."""

    return _UNIFIED_CONTENT_ID_RE.fullmatch(str(value).strip()) is not None


def chapter_id_for(content_id: str | int, order: int) -> str:
    """Return the canonical ``idNNNNNNCNNNNNN`` chapter identifier.

    Legacy and bare numeric inputs are accepted only as an ingestion
    convenience; they are canonicalised immediately and are never emitted.
    """

    chapter_order = int(order)
    if chapter_order <= 0:
        raise ValueError(f"Chapter order must be positive: {order!r}")
    if _LEGACY_CONTENT_ID_RE.fullmatch(str(content_id).strip()):
        raise ValueError(
            "Legacy book_/story_ chapter IDs require the reviewed migration map; "
            f"runtime conversion is forbidden: {content_id!r}"
        )
    if chapter_order >= 10**UNIFIED_CONTENT_ID_WIDTH:
        raise ValueError(
            "Chapter order is outside the six-digit namespace: "
            f"{order!r}"
        )
    return (
        f"{canonical_content_id(content_id)}"
        f"C{chapter_order:0{UNIFIED_CONTENT_ID_WIDTH}d}"
    )


def canonical_book_slug(book_id: str) -> str:
    """Return the canonical derived/source directory slug for a content id.

    Bare numeric and already-unified values collapse to the same type-neutral
    ID.  A legacy ``book_*``/``story_*`` value is rejected because its final
    global ID can only be resolved by the reviewed one-time migration map.
    """
    normalized = normalize_fs_name(str(book_id).strip())
    if _LEGACY_CONTENT_ID_RE.fullmatch(normalized):
        raise ValueError(
            "Legacy content slugs require the reviewed migration map: "
            f"{book_id!r}"
        )
    if is_unified_content_id(normalized) or normalized.isdigit():
        return canonical_content_id(normalized)
    raise ValueError(f"Content directory identity is not canonical: {book_id!r}")


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
