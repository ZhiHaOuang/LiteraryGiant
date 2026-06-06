"""Chapter and volume detection patterns for Chinese web novels.

Provides compiled regular expressions and helper functions for
recognising chapter headings ("第X章", "第X回", …) and volume
headings ("第X卷", "正文卷", …).
"""

from __future__ import annotations

import re

# -- compiled patterns ----------------------------------------------------------

VOLUME_PATTERN: re.Pattern = re.compile(
    r"^\s*(第(?P<num>[0-9零〇一二两三四五六七八九十百千万Oo]+)"
    r"(?P<marker>卷|册|部|篇|季|幕)|(?P<free>(卷|正文卷|番外卷)[^\n]*)"
    r")\s*(?P<title>.*)$"
)

CHAPTER_PATTERN: re.Pattern = re.compile(
    r"^\s*(?:(?P<volume_prefix>第[0-9零〇一二两三四五六七八九十百千万Oo]+(?:卷|册|部|篇|季|幕)\s+))?"
    r"(?P<head>(第(?P<num>[0-9零〇一二两三四五六七八九十百千万Oo]+)"
    r"(?P<marker>章|节|回|集|话|部|篇)|序章|楔子|引子|终章|尾声|番外))"
    r"[\s:：.-_]*"
    r"(?P<title>.*)$"
)

# -- helpers --------------------------------------------------------------------


def clean_title(title: str) -> str:
    """Normalise whitespace in a chapter/volume title."""
    cleaned = re.sub(r"\s+", " ", title).strip()
    cleaned = cleaned.replace(" :", ":").replace(" ：", "：")
    return cleaned
