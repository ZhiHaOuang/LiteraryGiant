"""Shared text normalisation utilities used across pipeline stages.

These are pure text-transformation functions with no external dependencies.
They are used by both the :mod:`fetcher` (web-scraped content) and
:mod:`Jormungandr.hardmodel` (file-based raw text) packages.
"""

from __future__ import annotations

import re


def normalize_text(text: str, *, collapse_blank_lines: bool = True) -> str:
    """Normalise line endings, replace full-width spaces, strip.

    Args:
        text: Raw input text.
        collapse_blank_lines: When ``True`` (the default), sequences of 3+
            consecutive newlines are collapsed to two newlines.

    Returns:
        Normalised text.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("　", " ")  # full-width space → ASCII space
    if collapse_blank_lines:
        text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_line(line: str) -> str:
    """Normalise a single line: strip, unify CJK punctuation, collapse spaces.

    Full-width punctuation is mapped to ASCII equivalents for consistent
    pattern matching downstream.
    """
    line = line.strip()
    trans = str.maketrans({
        "：": ":",
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "　": " ",
    })
    line = line.translate(trans)
    line = re.sub(r"\s+", " ", line)
    return line


def is_blank_line(line: str) -> bool:
    """Return ``True`` if *line* is empty or whitespace-only."""
    return not line.strip()


def collapse_blank_lines(text: str, max_consecutive: int = 2) -> str:
    """Collapse runs of blank lines to at most *max_consecutive* blanks.

    Args:
        text: Multi-line text.
        max_consecutive: Maximum consecutive empty lines to keep.

    Returns:
        Text with blank-line runs collapsed.
    """
    pattern = r"\n{" + str(max_consecutive + 1) + r",}"
    return re.sub(pattern, "\n" * max_consecutive, text)
