"""Type-coercion helpers used across pipeline schemas.

Each function accepts loosely-typed values (typically from parsed JSON)
and returns a well-defined Python type, filtering out junk where needed.
"""

from __future__ import annotations

from typing import Any

# ── strings ──────────────────────────────────────────────────────────

EMPTY_LIKE_STRINGS: frozenset[str] = frozenset(
    {"", "none", "null", "nil", "nan", "n/a", "na"}
)


def as_text(value: object) -> str:
    """Normalise *value* to a whitespace-collapsed string.

    Returns ``""`` for ``None`` and strings that map to known empty-like
    tokens (``"none"``, ``"n/a"``, …).
    """
    if value is None:
        return ""
    normalized = " ".join(str(value).strip().split())
    return "" if normalized.lower() in EMPTY_LIKE_STRINGS else normalized


def as_clean_text(value: object) -> str:
    """Like :func:`as_text` but does **not** filter empty-like tokens.

    Useful when you want to keep a value like ``"none"`` that is
    semantically meaningful in context.
    """
    if value is None:
        return ""
    return " ".join(str(value).strip().split())


# ── lists ────────────────────────────────────────────────────────────


def as_list(value: object) -> list[str]:
    """Normalise *value* to a deduplicated list of non-empty strings."""
    if value is None:
        return []
    if isinstance(value, list):
        items = [as_clean_text(item) for item in value]
        return dedupe_items([item for item in items if item])
    text = as_clean_text(value)
    return [text] if text else []


def dedupe_items(items: list[str]) -> list[str]:
    """Deduplicate *items* while preserving order, using whitespace-collapsed
    normalisation so ``"foo  bar"`` and ``"foo bar"`` are treated as equal."""
    seen: set[str] = set()
    deduped: list[str] = []
    for item in items:
        normalized = " ".join(item.split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


# ── dicts ─────────────────────────────────────────────────────────────


def as_dict(value: object) -> dict[str, Any]:
    """Return *value* as a ``dict``, or an empty dict when it is not one."""
    if isinstance(value, dict):
        return value
    return {}


# Alias kept for backward compatibility with ``infermodel`` code that uses ``_as_mapping``.
as_mapping = as_dict


# ── scalars ───────────────────────────────────────────────────────────


def as_int(value: object) -> int | None:
    """Coerce *value* to ``int``, returning ``None`` on failure."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_float(value: object) -> float | None:
    """Coerce *value* to ``float``, returning ``None`` on failure."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def as_bool(value: object) -> bool:
    """Coerce *value* to ``bool``, treating common truthy/falsy strings."""
    if isinstance(value, bool):
        return value
    normalized = as_text(value).lower()
    return normalized in {"true", "1", "yes", "y", "是"}
