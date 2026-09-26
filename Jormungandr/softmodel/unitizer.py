from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from shared import canonical_book_slug


UNITIZER_VERSION = "rules.v1"


@dataclass(frozen=True)
class UnitizerConfig:
    enabled: bool = True
    book_avg_chars_threshold: int = 8000
    book_p90_chars_threshold: int = 12000
    book_short_chapter_count_threshold: int = 300
    book_high_total_chars_threshold: int = 1_500_000
    chapter_split_suggest_chars: int = 8000
    chapter_split_required_chars: int = 12000
    chapter_force_multi_chars: int = 20000
    target_unit_chars: int = 6500
    hard_max_unit_chars: int = 10000
    min_unit_chars: int = 1800

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BookShapeReport:
    book_shape: str
    total_chars: int
    chapter_count: int
    avg_chars_per_chapter: float
    p90_chapter_chars: int
    max_chapter_chars: int
    long_chapter_count: int
    split_chapter_count: int
    unit_count: int
    enabled: bool
    config: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_SCENE_HEADING_RE = re.compile(
    r"^\s*(第[一二三四五六七八九十百千万零〇两\d]+[章节幕卷回部].{0,30}|"
    r"[＊*]{3,}|[-=]{3,}|[—―-]{4,}|"
    r"【[^】]{1,30}】|"
    r"\[[^\]]{1,30}\])\s*$"
)
_TRANSITION_START_RE = re.compile(
    r"^\s*(与此同时|另一边|同一时间|与此同时|随后|紧接着|片刻后|不久后|过了[一二三四五六七八九十\d]+|"
    r"次日|翌日|第二天|几天后|数日后|半个月后|一个月后|多年后|回到|画面一转|镜头一转|"
    r"清晨|黎明|上午|中午|午后|傍晚|深夜|夜里|凌晨|此时|这时|那一刻)"
)
_SENTENCE_BREAK_RE = re.compile(r"(?<=[。！？!?；;])")


def build_book_units(
    chapter_items: list[tuple[Path, dict[str, Any]]],
    *,
    book_id: str,
    config: UnitizerConfig | None = None,
) -> tuple[list[tuple[Path, dict[str, Any]]], BookShapeReport]:
    unitizer_config = config or UnitizerConfig()
    lengths = [_chapter_char_count(payload) for _path, payload in chapter_items]
    total_chars = sum(lengths)
    chapter_count = len(lengths)
    avg_chars = (total_chars / chapter_count) if chapter_count else 0.0
    p90_chars = _percentile(lengths, 0.9)
    max_chars = max(lengths) if lengths else 0
    long_chapter_count = sum(1 for value in lengths if value > unitizer_config.chapter_split_suggest_chars)
    book_shape = classify_book_shape(
        total_chars=total_chars,
        chapter_count=chapter_count,
        avg_chars_per_chapter=avg_chars,
        p90_chapter_chars=p90_chars,
        config=unitizer_config,
    )

    units: list[tuple[Path, dict[str, Any]]] = []
    split_chapter_count = 0
    global_unit_order = 1
    for chapter_file, chapter_payload in chapter_items:
        chapter_units = unitize_chapter(
            chapter_payload,
            book_id=book_id,
            book_shape=book_shape,
            first_global_unit_order=global_unit_order,
            config=unitizer_config,
        )
        if len(chapter_units) > 1:
            split_chapter_count += 1
        for unit_payload in chapter_units:
            units.append((chapter_file, unit_payload))
            global_unit_order += 1

    report = BookShapeReport(
        book_shape=book_shape,
        total_chars=total_chars,
        chapter_count=chapter_count,
        avg_chars_per_chapter=round(avg_chars, 2),
        p90_chapter_chars=p90_chars,
        max_chapter_chars=max_chars,
        long_chapter_count=long_chapter_count,
        split_chapter_count=split_chapter_count,
        unit_count=len(units),
        enabled=unitizer_config.enabled,
        config=unitizer_config.to_dict(),
    )
    return units, report


def classify_book_shape(
    *,
    total_chars: int,
    chapter_count: int,
    avg_chars_per_chapter: float,
    p90_chapter_chars: int,
    config: UnitizerConfig,
) -> str:
    if not config.enabled:
        return "regular_chapter_novel"
    if avg_chars_per_chapter > config.book_avg_chars_threshold:
        return "long_chapter_novel"
    if p90_chapter_chars > config.book_p90_chars_threshold:
        return "long_chapter_novel"
    if (
        chapter_count > 0
        and chapter_count < config.book_short_chapter_count_threshold
        and total_chars >= config.book_high_total_chars_threshold
    ):
        return "long_chapter_novel"
    return "regular_chapter_novel"


def unitize_chapter(
    chapter_payload: dict[str, Any],
    *,
    book_id: str,
    book_shape: str,
    first_global_unit_order: int,
    config: UnitizerConfig,
) -> list[dict[str, Any]]:
    content = str(chapter_payload.get("content") or "")
    chapter_chars = _chapter_char_count(chapter_payload)
    chunks = [content]
    split_reason = "original_chapter"
    if config.enabled and chapter_chars > config.chapter_split_suggest_chars:
        chunks = split_narrative_units(content, config=config)
        if len(chunks) > 1:
            if chapter_chars > config.chapter_force_multi_chars:
                split_reason = "long_chapter_forced_multi_split"
            elif chapter_chars > config.chapter_split_required_chars:
                split_reason = "long_chapter_required_split"
            else:
                split_reason = "long_chapter_scene_split"

    if not chunks:
        chunks = [content]
    total_units = len(chunks)
    units: list[dict[str, Any]] = []
    original_order = _safe_int(chapter_payload.get("order")) or 0
    original_chapter_id = str(chapter_payload.get("chapter_id") or f"{book_id}C{original_order:04d}")
    original_title = str(chapter_payload.get("clean_title") or chapter_payload.get("raw_title") or "")
    unit_id_prefix = _canonical_book_unit_prefix(book_id)

    offset = 0
    for unit_index, chunk in enumerate(chunks, start=1):
        global_order = first_global_unit_order + unit_index - 1
        unit_payload = dict(chapter_payload)
        unit_id = (
            original_chapter_id
            if total_units == 1
            else f"{unit_id_prefix}_chapter_{original_order:04d}_unit_{unit_index:02d}"
        )
        char_start = offset
        char_end = offset + len(chunk)
        offset = char_end
        unit_payload.update(
            {
                "chapter_id": unit_id,
                "order": global_order,
                "content": chunk,
                "char_count": len(chunk),
                "paragraph_count": _paragraph_count(chunk),
                "unit_id": unit_id,
                "global_unit_order": global_order,
                "unit_order_in_chapter": unit_index,
                "unit_count_in_chapter": total_units,
                "source_chapter_id": original_chapter_id,
                "source_chapter_order": original_order,
                "source_chapter_title": original_title,
                "source_chapter_char_count": chapter_chars,
                "source_char_start": char_start,
                "source_char_end": char_end,
                "split_reason": split_reason,
                "book_shape": book_shape,
                "unitizer_version": UNITIZER_VERSION,
            }
        )
        units.append(unit_payload)
    return units


def split_narrative_units(content: str, *, config: UnitizerConfig) -> list[str]:
    text = str(content or "").strip()
    if not text:
        return [""]
    if len(text) <= config.hard_max_unit_chars:
        return [text]

    blocks = _paragraph_blocks(text)
    chunks = _split_blocks(blocks, config=config)
    final_chunks: list[str] = []
    for chunk in chunks:
        if len(chunk) <= config.hard_max_unit_chars:
            final_chunks.append(chunk)
        else:
            final_chunks.extend(_hard_split_text(chunk, max_chars=config.hard_max_unit_chars))
    return _merge_tiny_chunks(final_chunks, config=config)


def _split_blocks(blocks: list[str], *, config: UnitizerConfig) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if current:
            chunks.append("\n\n".join(part.strip() for part in current if part.strip()).strip())
        current = []
        current_len = 0

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        if len(block) > config.hard_max_unit_chars:
            flush()
            chunks.extend(_hard_split_text(block, max_chars=config.hard_max_unit_chars))
            continue

        projected = current_len + len(block)
        boundary_before = _is_preferred_boundary(block)
        if current and (
            projected > config.hard_max_unit_chars
            or (current_len >= config.target_unit_chars and boundary_before)
            or current_len >= config.hard_max_unit_chars
        ):
            flush()

        current.append(block)
        current_len += len(block)
        if current_len >= config.target_unit_chars and not boundary_before:
            flush()

    flush()
    return [chunk for chunk in chunks if chunk]


def _merge_tiny_chunks(chunks: list[str], *, config: UnitizerConfig) -> list[str]:
    if len(chunks) <= 1:
        return chunks
    merged: list[str] = []
    index = 0
    while index < len(chunks):
        chunk = chunks[index]
        if (
            len(chunk) < config.min_unit_chars
            and index + 1 < len(chunks)
            and len(chunk) + len(chunks[index + 1]) <= config.hard_max_unit_chars
        ):
            merged.append(f"{chunk}\n\n{chunks[index + 1]}".strip())
            index += 2
            continue
        if (
            len(chunk) < config.min_unit_chars
            and merged
            and len(merged[-1]) + len(chunk) <= config.hard_max_unit_chars
        ):
            merged[-1] = f"{merged[-1]}\n\n{chunk}".strip()
            index += 1
            continue
        merged.append(chunk)
        index += 1
    return merged


def _paragraph_blocks(text: str) -> list[str]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n+", text) if block.strip()]
    if len(blocks) >= 2:
        return blocks
    blocks = [block.strip() for block in text.splitlines() if block.strip()]
    if len(blocks) >= 2:
        return blocks
    return [part.strip() for part in _SENTENCE_BREAK_RE.split(text) if part.strip()]


def _hard_split_text(text: str, *, max_chars: int) -> list[str]:
    parts = [part.strip() for part in _SENTENCE_BREAK_RE.split(text) if part.strip()]
    if len(parts) <= 1:
        return [text[start:start + max_chars].strip() for start in range(0, len(text), max_chars)]

    chunks: list[str] = []
    current = ""
    for part in parts:
        if current and len(current) + len(part) > max_chars:
            chunks.append(current.strip())
            current = part
        else:
            current = f"{current}{part}"
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _is_preferred_boundary(block: str) -> bool:
    if _SCENE_HEADING_RE.search(block):
        return True
    return bool(_TRANSITION_START_RE.search(block[:80]))


def _chapter_char_count(payload: dict[str, Any]) -> int:
    value = _safe_int(payload.get("char_count"))
    if value is not None and value > 0:
        return value
    return len(str(payload.get("content") or ""))


def _paragraph_count(text: str) -> int:
    if not text:
        return 0
    return len([block for block in re.split(r"\n\s*\n+", text) if block.strip()])


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _canonical_book_unit_prefix(book_id: str) -> str:
    return canonical_book_slug(str(book_id or "").strip())


def _percentile(values: list[int], ratio: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
    return int(ordered[index])
