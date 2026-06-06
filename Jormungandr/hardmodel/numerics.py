"""Chinese numeral parsing utilities.

Maps Chinese numeral characters (零, 一, 二, ...) and unit characters
(十, 百, 千, 万) to their integer values, and provides a function for
converting mixed Chinese-numeral strings to integers.
"""

from __future__ import annotations

CN_NUMERAL_MAP: dict[str, int] = {
    "零": 0,
    "〇": 0,
    "O": 0,
    "o": 0,
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

CN_UNIT_MAP: dict[str, int] = {
    "十": 10,
    "百": 100,
    "千": 1000,
    "万": 10000,
}


def cn_to_int(text: str) -> int | None:
    """Convert a Chinese-numeral string to an integer.

    Handles both pure digit-like sequences (e.g. "一二三" → 123) and
    unit-based forms (e.g. "一百二十三" → 123, "十二万" → 120000).
    Returns ``None`` when no digits can be extracted.
    """
    if not text:
        return None

    # All characters are simple numerals → concatenate digits
    if all(char in CN_NUMERAL_MAP for char in text):
        digits = "".join(str(CN_NUMERAL_MAP[char]) for char in text)
        return int(digits)

    total = 0
    section = 0
    number = 0
    for char in text:
        if char in CN_NUMERAL_MAP:
            number = CN_NUMERAL_MAP[char]
            continue
        if char in CN_UNIT_MAP:
            unit = CN_UNIT_MAP[char]
            if unit == 10000:
                section = (section + (number or 1)) * unit
                total += section
                section = 0
            else:
                section += (number or 1) * unit
            number = 0

    result = total + section + number
    return result if result > 0 else None
