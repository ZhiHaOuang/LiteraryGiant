"""Helpers for keeping chapter lists in reading order."""

from __future__ import annotations

import re

from .base import ChapterEntry

_CN_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


def chapter_number_from_title(title: str) -> int | None:
    """Extract a chapter number from common Chinese web-novel titles."""
    match = re.search(r"第\s*(\d+)\s*[章节回節]", title)
    if match:
        return int(match.group(1))

    match = re.search(r"第\s*([零〇一二两三四五六七八九十百千万]+)\s*[章节回節]", title)
    if match:
        return _parse_chinese_number(match.group(1))

    return None


def sort_chapters_by_title_number(chapters: list[ChapterEntry]) -> list[ChapterEntry]:
    """Sort by extracted chapter number when most entries expose one."""
    numbered = [
        (chapter_number_from_title(ch.title), ch)
        for ch in chapters
    ]
    number_count = sum(1 for num, _ in numbered if num is not None)
    if number_count < max(3, int(len(chapters) * 0.6)):
        return chapters

    sorted_chapters = sorted(
        chapters,
        key=lambda ch: (
            chapter_number_from_title(ch.title) is None,
            chapter_number_from_title(ch.title) or ch.order,
            ch.order,
        ),
    )
    return [
        ChapterEntry(title=ch.title, url=ch.url, order=i)
        for i, ch in enumerate(sorted_chapters, start=1)
    ]


def _parse_chinese_number(text: str) -> int | None:
    total = 0
    section = 0
    number = 0
    seen = False

    for char in text:
        if char in _CN_DIGITS:
            number = _CN_DIGITS[char]
            seen = True
        elif char in _CN_UNITS:
            unit = _CN_UNITS[char]
            seen = True
            if unit == 10000:
                section = (section + number) * unit
                total += section
                section = 0
            else:
                section += (number or 1) * unit
            number = 0
        else:
            return None

    if not seen:
        return None
    return total + section + number
