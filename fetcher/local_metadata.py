"""Fast, conservative metadata extraction for local Chinese novel files.

The local ingest scripts have to deal with filenames collected from many
different sources.  This module intentionally keeps the cheap, deterministic
path usable without a model and exposes an optional OpenAI-compatible client
for the small ambiguous remainder.

The public functions return mapping-compatible dataclasses instead of bare
strings.  In particular, the original value, the rules that fired, and the
confidence are never discarded::

    name = parse_book_filename("6.《找错反派哥哥后》作者：青端.txt")
    assert name.title == "找错反派哥哥后"
    assert name["author"] == "青端"

    genre = classify_genre(title=name.title, path="晋江/纯爱")
    payload = genre.to_dict()

Only the :class:`VLLMMetadataClient` needs ``requests``.  It is imported
lazily so the rule-only path remains Python-stdlib-only.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Iterable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# Keep the allowlist deliberately small and stable.  Downstream directory
# names and indexes should use these values, while more specific information
# belongs in ``tags``.
CANONICAL_GENRES: tuple[str, ...] = (
    "玄幻",
    "奇幻",
    "武侠",
    "仙侠",
    "都市",
    "现实",
    "言情",
    "后宫",
    "耽美",
    "百合",
    "历史",
    "军事",
    "科幻",
    "悬疑",
    "惊悚",
    "游戏",
    "体育",
    "同人",
    "二次元",
    "轻小说",
    "露骨H",
    "其他",
)

_GENRE_ALLOWLIST = frozenset(CANONICAL_GENRES)
_GENRE_CODE_TO_NAME = {
    f"G{index:02d}": genre for index, genre in enumerate(CANONICAL_GENRES)
}
_CJK_PUNCTUATION = frozenset("，。！？：；（）【】“”‘’、—…《》〈〉")
_TEXT_EXTENSION_RE = re.compile(r"(?:\.(?:txt|text|utf8|utf-8|gbk)){1,2}$", re.IGNORECASE)
_INVISIBLE_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2060\ufeff]")
_WHITESPACE_RE = re.compile(r"[\s\u3000]+")
_CJK_RE = re.compile(r"[\u3400-\u9fff]")


def _jsonable(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return value


class _ResultMapping(Mapping[str, Any]):
    """Small mixin that keeps dataclass and dict-style APIs both convenient."""

    def to_dict(self) -> dict[str, Any]:  # pragma: no cover - implemented below
        raise NotImplementedError

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self.to_dict())

    def __len__(self) -> int:
        return len(self.to_dict())


@dataclass(frozen=True)
class CleanedField(_ResultMapping):
    """A normalized scalar/list field with provenance."""

    raw: str
    value: str | tuple[str, ...] | None
    confidence: float
    evidence: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "raw": self.raw,
            "value": _jsonable(self.value),
            "confidence": round(float(self.confidence), 4),
            "evidence": list(self.evidence),
        }


@dataclass(frozen=True)
class BookNameMetadata(_ResultMapping):
    """Structured result of filename/title cleanup."""

    raw: str
    title: str
    author: str | None
    aliases: tuple[str, ...]
    confidence: float
    evidence: tuple[str, ...]
    field_confidence: Mapping[str, float] = field(default_factory=dict)

    @property
    def canonical_name_key(self) -> str:
        return canonical_name_key(self.title)

    def to_dict(self) -> dict[str, Any]:
        return {
            "raw": self.raw,
            "title": self.title,
            "canonical_name_key": self.canonical_name_key,
            "author": self.author,
            "aliases": list(self.aliases),
            "confidence": round(float(self.confidence), 4),
            "field_confidence": {
                str(key): round(float(value), 4)
                for key, value in self.field_confidence.items()
            },
            "evidence": list(self.evidence),
        }


@dataclass(frozen=True)
class GenreClassification(_ResultMapping):
    """Rule classification with an explicit low-confidence state."""

    canonical_genre: str
    tags: tuple[str, ...]
    confidence: float
    evidence: tuple[str, ...]
    low_confidence: bool
    candidates: tuple[tuple[str, float], ...] = ()

    @property
    def genre(self) -> str:
        """Short alias used by JSON manifests."""
        return self.canonical_genre

    def to_dict(self) -> dict[str, Any]:
        return {
            "genre": self.canonical_genre,
            "canonical_genre": self.canonical_genre,
            "tags": list(self.tags),
            "confidence": round(float(self.confidence), 4),
            "low_confidence": bool(self.low_confidence),
            "candidates": [
                {"genre": genre, "score": round(float(score), 4)}
                for genre, score in self.candidates
            ],
            "evidence": list(self.evidence),
        }


class MetadataResponseError(ValueError):
    """Raised internally when a model response violates the JSON contract."""


def _normalize_unicode(value: Any) -> str:
    """Apply NFKC without turning readable Chinese punctuation into ASCII."""
    text = str(value or "")
    normalized = "".join(
        character
        if character in _CJK_PUNCTUATION
        else unicodedata.normalize("NFKC", character)
        for character in text
    )
    normalized = _INVISIBLE_RE.sub("", normalized).replace("\xa0", " ")
    return _WHITESPACE_RE.sub(" ", normalized).strip()


def _basename(value: str) -> str:
    # Path.name on Linux does not understand a Windows backslash path.
    return re.split(r"[/\\]", value)[-1]


def _strip_extension(value: str) -> tuple[str, bool]:
    stripped = _TEXT_EXTENSION_RE.sub("", value).strip()
    return stripped, stripped != value.strip()


_SOURCE_LABELS = frozenset(
    {
        "少年梦",
        "晋江",
        "晋江文学城",
        "起点",
        "起点中文网",
        "番茄",
        "番茄小说",
        "书香门第",
        "知轩藏书",
        "塞班",
        "爱下电子书",
        "txt",
        "txt小说",
    }
)

_LEADING_INDEX_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*(?:第\s*)?\d{1,7}\s*[.．、_]\s*"),
    re.compile(r"^\s*[\[【]\s*\d{1,7}\s*[\]】]\s*"),
)

_RANGE_SUFFIX_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?:[\s._—–-]*(?:第\s*)?\d{1,7}\s*(?:[-~～—–]|至|到)\s*"
        r"\d{1,7}\s*(?:章|节|回|集|话)?\s*(?:完结|全本|全集)?\s*)$",
        re.IGNORECASE,
    ),
    re.compile(
        r"[\[(（【]\s*(?:第\s*)?\d{1,7}\s*(?:[-~～—–]|至|到)\s*"
        r"\d{1,7}\s*(?:章|节|回|集|话)?\s*[\])）】]\s*$",
        re.IGNORECASE,
    ),
)

_EDITION_SUFFIX_RE = re.compile(
    r"(?:[\s._-]*[\[(（【]?\s*(?:TXT下载|精校版?|校对版?|无删减|完整版?|"
    r"完结版?|全本|全集|正文完|番外全|番外完)\s*[\])）】]?\s*)+$",
    re.IGNORECASE,
)


def _drop_leading_noise(value: str) -> tuple[str, list[str]]:
    evidence: list[str] = []
    work = value.strip()
    while True:
        previous = work
        for pattern in _LEADING_INDEX_PATTERNS:
            match = pattern.match(work)
            if match:
                evidence.append(f"title:removed-leading-index={match.group(0).strip()}")
                work = work[match.end() :].lstrip()
                break
        else:
            bracket = re.match(r"^[\(（]([^()（）]{1,20})[\)）]\s*(?=\S)", work)
            if bracket:
                label = _normalize_unicode(bracket.group(1)).casefold()
                source_like = label in _SOURCE_LABELS or bool(
                    re.search(r"(?:书库|小说|文学城|论坛|整理|校对|txt)$", label)
                )
                if source_like:
                    evidence.append(
                        f"title:removed-source-label={bracket.group(0).strip()}"
                    )
                    work = work[bracket.end() :].lstrip()
            square = re.match(r"^[\[【]([^\]】]{1,24})[\]】]\s*(?=\S)", work)
            if square:
                label = _normalize_unicode(square.group(1)).casefold()
                source_like = label in _SOURCE_LABELS or bool(
                    re.search(r"(?:书库|小说|文学城|论坛|整理|校对|txt)$", label)
                )
                if source_like:
                    evidence.append(
                        f"title:removed-source-label={square.group(0).strip()}"
                    )
                    work = work[square.end() :].lstrip()
        if work == previous:
            break
    return work, evidence


def _strip_suffix_noise(value: str) -> tuple[str, list[str]]:
    evidence: list[str] = []
    work = value.strip()
    while work:
        previous = work
        for pattern in _RANGE_SUFFIX_PATTERNS:
            match = pattern.search(work)
            # A filename that is itself a numeric range (for example the novel
            # title ``1984-2024``) is not a removable chapter suffix.
            if match and match.start() > 0:
                evidence.append(f"title:removed-chapter-range={match.group(0).strip()}")
                work = work[: match.start()].rstrip(" .．_—–-~～:：")
                break
        if work != previous:
            continue
        match = _EDITION_SUFFIX_RE.search(work)
        if match and match.start() > 0:
            evidence.append(f"title:removed-edition={match.group(0).strip()}")
            work = work[: match.start()].rstrip(" .．_—–-~～:：")
        if work == previous:
            break
    return work.strip(), evidence


_ALIAS_LABEL = r"(?:又名|别名|原名|曾用名|亦名|aka)"
_ALIAS_CONTAINER_RE = re.compile(
    rf"[\(（\[【]\s*{_ALIAS_LABEL}\s*[:：]?\s*([^\)）\]】]+?)\s*[\)）\]】]",
    re.IGNORECASE,
)
_ALIAS_QUOTED_RE = re.compile(
    rf"{_ALIAS_LABEL}\s*[:：]?\s*《\s*([^《》]+?)\s*》",
    re.IGNORECASE,
)
_ALIAS_TAIL_RE = re.compile(
    rf"(?:[,，;；/|｜]\s*)?{_ALIAS_LABEL}\s*[:：]\s*(.+?)\s*$",
    re.IGNORECASE,
)


def _remove_outer_title_marks(value: str) -> str:
    work = value.strip()
    pairs = (("《", "》"), ("〈", "〉"), ('"', '"'), ("“", "”"), ("'", "'"), ("‘", "’"))
    changed = True
    while changed and len(work) >= 2:
        changed = False
        for left, right in pairs:
            if work.startswith(left) and work.endswith(right):
                work = work[len(left) : -len(right)].strip()
                changed = True
                break
    return work


def _clean_title_core(value: str) -> tuple[str, list[str]]:
    evidence: list[str] = []
    work = _normalize_unicode(value)
    work, leading = _drop_leading_noise(work)
    evidence.extend(leading)
    work, suffix = _strip_suffix_noise(work)
    evidence.extend(suffix)
    work = _remove_outer_title_marks(work)
    work = re.sub(r"\s*([:：,，、;；!?！？])\s*", r"\1", work)
    work = _WHITESPACE_RE.sub(" ", work).strip(" \t\r\n._—–-~～|｜")
    return work, evidence


def _split_ampersand_title_variants(value: str) -> tuple[str, list[str]]:
    """Split the common Jinjiang ``《主名＆推广名》`` convention.

    In the local corpus, ampersands inside the filename's book-title marks are
    used to concatenate alternate promotional titles.  This helper is kept
    scoped to marked/labelled title fields; an ampersand in arbitrary prose is
    never treated as an alias separator.
    """
    parts = [part.strip() for part in re.split(r"\s*[＆&]\s*", value) if part.strip()]
    if len(parts) < 2:
        return value, []
    return parts[0], parts[1:]


def _clean_author_core(value: str) -> tuple[str | None, list[str]]:
    evidence: list[str] = []
    work = _normalize_unicode(value)
    work = _TEXT_EXTENSION_RE.sub("", work).strip()
    work = re.sub(r"^(?:作者|著者|作家|文)\s*[:：]?\s*", "", work, flags=re.IGNORECASE)
    # Metadata fields following the author are not part of the pen name.
    work = re.split(
        r"\s+(?:类型|类别|状态|字数|来源|上传者)\s*[:：]",
        work,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    work = re.sub(
        r"[\[(（【]\s*(?:完结|全本|全集|晋江|起点|作者专栏)\s*[\])）】]\s*$",
        "",
        work,
        flags=re.IGNORECASE,
    )
    work = re.sub(r"\s*(?:著|作品)\s*$", "", work)
    work = _remove_outer_title_marks(work).strip(" \t\r\n,，;；|｜_-—")
    if not work:
        return None, evidence
    if len(work) > 60 or "\n" in work or re.search(r"(?:第\s*)?\d+\s*[-~至到]\s*\d+", work):
        evidence.append("author:rejected-implausible-value")
        return None, evidence
    return work, evidence


def _alias_values(value: str) -> tuple[list[str], str, list[str]]:
    """Extract explicit aliases and remove their clauses from a title."""
    aliases: list[str] = []
    evidence: list[str] = []

    def add(raw_alias: str, rule: str) -> None:
        alias, _ = _clean_title_core(raw_alias)
        alias = alias.strip("《》〈〉\"“”'‘’ ")
        if alias and alias not in aliases:
            aliases.append(alias)
            evidence.append(f"aliases:{rule}={alias}")

    for match in _ALIAS_CONTAINER_RE.finditer(value):
        add(match.group(1), "labelled-container")
    for match in _ALIAS_QUOTED_RE.finditer(value):
        add(match.group(1), "labelled-book-marks")
    # Search a standalone tail only after removing the two structured forms;
    # otherwise ``（又名：别名）`` would be captured a second time including
    # its closing parenthesis.
    without_structured_aliases = _ALIAS_CONTAINER_RE.sub("", value)
    without_structured_aliases = _ALIAS_QUOTED_RE.sub("", without_structured_aliases)
    tail = _ALIAS_TAIL_RE.search(without_structured_aliases)
    if tail:
        add(tail.group(1), "labelled-tail")

    cleaned = without_structured_aliases
    cleaned = _ALIAS_TAIL_RE.sub("", cleaned)
    return aliases, cleaned.strip(), evidence


_AUTHOR_COLON_RE = re.compile(
    r"(?:(?:作者|著者|作家)\s*[:：]|(?<!\S)文\s*[:：])\s*(?P<author>.+?)\s*$",
    re.IGNORECASE,
)
_AUTHOR_SPACED_RE = re.compile(
    r"^(?P<title>.+?)\s+(?:作者|著者|作家|文)\s+(?P<author>\S.{0,59})\s*$",
    re.IGNORECASE,
)


def _extract_author(value: str) -> tuple[str, str | None, float, list[str]]:
    evidence: list[str] = []
    matches = list(_AUTHOR_COLON_RE.finditer(value))
    if matches:
        match = matches[-1]
        author, author_evidence = _clean_author_core(match.group("author"))
        evidence.extend(author_evidence)
        if author:
            evidence.append(f"author:explicit-marker={author}")
            return value[: match.start()].rstrip(), author, 0.99, evidence
    spaced = _AUTHOR_SPACED_RE.match(value)
    if spaced:
        author, author_evidence = _clean_author_core(spaced.group("author"))
        evidence.extend(author_evidence)
        if author:
            evidence.append(f"author:spaced-marker={author}")
            return spaced.group("title").rstrip(), author, 0.94, evidence
    return value, None, 0.0, evidence


_TITLE_AUTHOR_SEPARATOR_RE = re.compile(r"\s+(?:by)\s+|\s*[-—–_]\s*", re.IGNORECASE)


def _plausible_author_suffix(value: str) -> bool:
    author, _ = _clean_author_core(value)
    if not author or len(author) > 30:
        return False
    if re.search(
        r"[《》:：/\\]|(?:完结|全本|全集|精校|校对|章节|小说|下载|电子书|文本|文件|正文|书籍|整理)$",
        author,
    ):
        return False
    if author.isdecimal():
        return False
    # Pen names can contain Latin letters, digits and middle dots, but should
    # not contain sentence punctuation.
    return not bool(re.search(r"[，,。!?！？;；]", author))


def _extract_title_author_form(value: str) -> tuple[str, str | None, list[str]]:
    evidence: list[str] = []
    separators = [match for match in _TITLE_AUTHOR_SEPARATOR_RE.finditer(value) if match.end() > match.start()]
    for match in reversed(separators):
        left = value[: match.start()].strip()
        right = value[match.end() :].strip()
        if not left or not _plausible_author_suffix(right):
            continue
        author, _ = _clean_author_core(right)
        if author:
            evidence.append(f"author:title-author-separator={match.group(0).strip() or '_'}")
            return left, author, evidence
    return value, None, evidence


def parse_book_filename(raw: str | Path) -> BookNameMetadata:
    """Parse a noisy local filename into title/author/aliases.

    The function does not access the file.  Passing a complete path is safe;
    only its basename participates in name parsing and the complete original
    string is retained in ``raw``.
    """
    raw_text = str(raw)
    basename = _normalize_unicode(_basename(raw_text))
    work, had_extension = _strip_extension(basename)
    evidence: list[str] = []
    if had_extension:
        evidence.append("filename:removed-text-extension")

    work, leading_evidence = _drop_leading_noise(work)
    evidence.extend(leading_evidence)
    work, suffix_evidence = _strip_suffix_noise(work)
    evidence.extend(suffix_evidence)
    work, author, author_confidence, author_evidence = _extract_author(work)
    evidence.extend(author_evidence)

    explicit_aliases, work_without_aliases, alias_evidence = _alias_values(work)
    evidence.extend(alias_evidence)
    work = work_without_aliases

    marked_titles = list(re.finditer(r"《\s*([^《》]{1,240}?)\s*》", work))
    title_confidence: float
    if marked_titles:
        title_source = marked_titles[0].group(1)
        title_source, ampersand_aliases = _split_ampersand_title_variants(title_source)
        for raw_alias in ampersand_aliases:
            alias, _ = _clean_title_core(raw_alias)
            if alias and alias not in explicit_aliases:
                explicit_aliases.append(alias)
                evidence.append(f"aliases:ampersand-book-title={alias}")
        title, title_evidence = _clean_title_core(title_source)
        evidence.extend(title_evidence)
        evidence.append(f"title:book-title-marks={title}")
        title_confidence = 0.99
        # Additional marked titles count only when they are explicitly marked
        # as aliases; otherwise they may be two books in a collection.
        for match in marked_titles[1:]:
            context = work[max(0, match.start() - 12) : match.start()]
            if re.search(_ALIAS_LABEL, context, flags=re.IGNORECASE):
                alias, _ = _clean_title_core(match.group(1))
                if alias and alias not in explicit_aliases:
                    explicit_aliases.append(alias)
                    evidence.append(f"aliases:additional-book-marks={alias}")
        trailing = work[marked_titles[0].end() :].strip()
        if trailing and not re.search(_ALIAS_LABEL, trailing, flags=re.IGNORECASE):
            evidence.append(f"title:ignored-after-book-title-marks={trailing[:80]}")
    else:
        ambiguous_full_stem: str | None = None
        if author is None:
            separated_title, separated_author, separated_evidence = _extract_title_author_form(work)
            if separated_author:
                ambiguous_full_stem, _ = _clean_title_core(work)
                work = separated_title
                author = separated_author
                # An unlabelled dash/underscore is inherently ambiguous:
                # ``书名-作者`` is common, but so are subtitles and sequels.
                # Keep both interpretations and route the item to header/LLM
                # reconciliation instead of claiming a high-confidence author.
                author_confidence = 0.58
                evidence.extend(separated_evidence)
                evidence.append("author:ambiguous-unlabelled-separator")
        title, title_evidence = _clean_title_core(work)
        evidence.extend(title_evidence)
        title_confidence = 0.62 if ambiguous_full_stem else (0.91 if author else 0.78)
        if (
            ambiguous_full_stem
            and canonical_name_key(ambiguous_full_stem) != canonical_name_key(title)
            and ambiguous_full_stem not in explicit_aliases
        ):
            explicit_aliases.append(ambiguous_full_stem)
            evidence.append(f"aliases:ambiguous-full-stem={ambiguous_full_stem}")
        evidence.append("title:filename-stem")

    # A malformed all-metadata filename should still be represented without
    # inventing a title.
    if not title:
        fallback, _ = _clean_title_core(work or basename)
        title = fallback or "未命名"
        title_confidence = 0.1
        evidence.append("title:low-confidence-fallback")

    aliases: list[str] = []
    title_key = canonical_name_key(title)
    for alias in explicit_aliases:
        clean_alias, _ = _clean_title_core(alias)
        if clean_alias and canonical_name_key(clean_alias) != title_key and clean_alias not in aliases:
            aliases.append(clean_alias)

    overall = title_confidence
    if author:
        overall = title_confidence * 0.82 + author_confidence * 0.18
    else:
        # Absence of an author is not a parsing failure, but it is useful to
        # distinguish such names before an LLM/reconciliation pass.
        overall = max(0.0, title_confidence - 0.04)
    overall = round(min(0.999, max(0.0, overall)), 4)
    field_confidence = {
        "title": round(title_confidence, 4),
        "author": round(author_confidence, 4) if author else 0.0,
        "aliases": 0.92 if aliases else 0.5,
    }
    return BookNameMetadata(
        raw=raw_text,
        title=title,
        author=author,
        aliases=tuple(aliases),
        confidence=overall,
        evidence=tuple(dict.fromkeys(evidence)),
        field_confidence=field_confidence,
    )


# Discoverable aliases for callers that naturally search for "clean" or
# "normalize".  All retain the structured return contract.
clean_book_name = parse_book_filename
normalize_book_name = parse_book_filename


def clean_title(raw: str | Path) -> CleanedField:
    """Clean a title/filename while retaining provenance and confidence."""
    result = parse_book_filename(raw)
    evidence = tuple(item for item in result.evidence if item.startswith(("title:", "filename:")))
    return CleanedField(
        raw=str(raw),
        value=result.title,
        confidence=float(result.field_confidence.get("title", result.confidence)),
        evidence=evidence,
    )


def clean_author(raw: str | Path) -> CleanedField:
    """Clean either an author field or a filename containing an author."""
    raw_text = str(raw)
    parsed = parse_book_filename(raw_text)
    if parsed.author:
        evidence = tuple(item for item in parsed.evidence if item.startswith("author:"))
        return CleanedField(
            raw=raw_text,
            value=parsed.author,
            confidence=float(parsed.field_confidence.get("author", 0.0)),
            evidence=evidence,
        )
    value, evidence_list = _clean_author_core(raw_text)
    confidence = 0.88 if value else 0.0
    if value:
        evidence_list.append("author:standalone-field")
    return CleanedField(raw=raw_text, value=value, confidence=confidence, evidence=tuple(evidence_list))


def clean_aliases(raw: str | Path) -> CleanedField:
    """Extract labelled title aliases from a noisy filename/title."""
    parsed = parse_book_filename(raw)
    evidence = tuple(item for item in parsed.evidence if item.startswith("aliases:"))
    return CleanedField(
        raw=str(raw),
        value=parsed.aliases,
        confidence=float(parsed.field_confidence.get("aliases", 0.0)),
        evidence=evidence,
    )


def canonical_name_key(value: str) -> str:
    """Return a punctuation-insensitive key suitable for *candidate* matching.

    This is intentionally not a duplicate decision by itself.  Two books with
    the same key still need author/content evidence before they can be merged.
    """
    work = _normalize_unicode(value).casefold()
    work = re.sub(r"(?:txt下载|精校版?|校对版?|完整版?|无删减|完结版?|全本|全集)$", "", work)
    return "".join(character for character in work if character.isalnum())


# (keyword, strength, tags).  Strength is multiplied by source reliability.
_GENRE_RULES: Mapping[str, tuple[tuple[str, float, tuple[str, ...]], ...]] = {
    "玄幻": (
        ("玄幻", 3.2, ("玄幻",)),
        ("异界", 2.5, ("异界",)),
        ("斗气", 2.4, ("升级流",)),
        ("灵气复苏", 2.8, ("灵气复苏",)),
        ("御兽", 2.4, ("御兽",)),
    ),
    "奇幻": (
        ("奇幻", 3.2, ("奇幻",)),
        ("西幻", 3.2, ("西幻",)),
        ("魔法", 2.3, ("魔法",)),
        ("巫师", 2.5, ("巫师",)),
        ("骑士", 1.8, ("骑士",)),
    ),
    "武侠": (
        ("武侠", 3.4, ("武侠",)),
        ("江湖", 2.0, ("江湖",)),
        ("侠客", 2.1, ("侠客",)),
        ("武林", 2.2, ("武林",)),
    ),
    "仙侠": (
        ("仙侠", 3.5, ("仙侠",)),
        ("修仙", 3.2, ("修仙",)),
        ("修真", 3.2, ("修真",)),
        ("飞升", 2.2, ("飞升",)),
        ("仙门", 2.4, ("仙门",)),
        ("洪荒", 2.8, ("洪荒",)),
    ),
    "都市": (
        ("都市", 3.2, ("都市",)),
        ("娱乐圈", 3.0, ("娱乐圈",)),
        ("娱乐", 2.4, ("娱乐圈",)),
        ("神豪", 2.5, ("神豪",)),
        ("商战", 2.3, ("商战",)),
        ("总裁", 1.7, ("豪门",)),
    ),
    "现实": (
        ("现实", 3.0, ("现实向",)),
        ("乡土", 2.4, ("乡土",)),
        ("年代文", 2.3, ("年代文",)),
        ("职场", 2.0, ("职场",)),
    ),
    "言情": (
        ("言情", 3.4, ("言情",)),
        ("甜宠", 2.7, ("甜宠",)),
        ("婚恋", 2.5, ("婚恋",)),
        ("先婚后爱", 2.7, ("先婚后爱",)),
        ("宫斗", 2.1, ("宫斗",)),
        ("宅斗", 2.1, ("宅斗",)),
        ("追妻", 1.9, ("追妻",)),
    ),
    "后宫": (
        ("后宫文", 3.8, ("后宫",)),
        ("后宫流", 3.8, ("后宫",)),
        ("多女主", 3.6, ("多女主",)),
        ("种马文", 3.4, ("后宫",)),
        ("种马流", 3.4, ("后宫",)),
        ("推土机", 2.8, ("后宫",)),
        # A bare 后宫 in prose may describe an imperial palace rather than a
        # harem genre, so it is intentionally too weak to classify from the
        # excerpt alone. It remains decisive in title/path evidence.
        ("后宫", 2.5, ("后宫",)),
    ),
    "露骨H": (
        ("露骨h", 4.5, ("露骨H", "成人内容")),
        ("成人h", 4.2, ("露骨H", "成人内容")),
        ("小黄文", 4.2, ("露骨H", "成人内容")),
        ("黄文", 4.0, ("露骨H", "成人内容")),
        ("肉文", 4.0, ("露骨H", "成人内容")),
        ("h文", 3.8, ("露骨H", "成人内容")),
        ("性奴", 3.6, ("露骨H", "成人内容")),
        ("乱伦", 3.4, ("露骨H", "成人内容")),
        ("色情", 3.4, ("露骨H", "成人内容")),
        ("性爱", 3.2, ("露骨H", "成人内容")),
        ("淫乱", 3.2, ("露骨H", "成人内容")),
        ("情色", 3.0, ("露骨H", "成人内容")),
        ("调教", 2.8, ("露骨H", "成人内容")),
    ),
    "耽美": (
        ("耽美", 3.6, ("耽美",)),
        ("纯爱", 3.0, ("纯爱",)),
        ("双男主", 3.0, ("双男主",)),
        ("bl", 2.8, ("BL",)),
    ),
    "百合": (
        ("百合", 3.6, ("百合",)),
        ("双女主", 3.0, ("双女主",)),
        ("gl", 2.8, ("GL",)),
    ),
    "历史": (
        ("历史", 3.2, ("历史",)),
        ("三国", 2.8, ("三国",)),
        ("大秦", 2.7, ("秦汉",)),
        ("大唐", 2.7, ("唐朝",)),
        ("明朝", 2.5, ("明朝",)),
        ("清穿", 2.6, ("清穿",)),
        ("架空历史", 3.0, ("架空历史",)),
    ),
    "军事": (
        ("军事", 3.4, ("军事",)),
        ("军旅", 2.7, ("军旅",)),
        ("特种兵", 2.8, ("特种兵",)),
        ("抗战", 2.8, ("抗战",)),
        ("谍战", 2.4, ("谍战",)),
    ),
    "科幻": (
        ("科幻", 3.5, ("科幻",)),
        ("星际", 2.8, ("星际",)),
        ("机甲", 2.7, ("机甲",)),
        ("末世", 2.7, ("末世",)),
        ("赛博朋克", 3.0, ("赛博朋克",)),
        ("人工智能", 2.0, ("人工智能",)),
    ),
    "悬疑": (
        ("悬疑", 3.5, ("悬疑",)),
        ("推理", 3.0, ("推理",)),
        ("刑侦", 2.9, ("刑侦",)),
        ("探案", 2.8, ("探案",)),
        ("侦探", 2.6, ("侦探",)),
        ("法医", 2.5, ("法医",)),
    ),
    "惊悚": (
        ("惊悚", 3.5, ("惊悚",)),
        ("恐怖", 3.2, ("恐怖",)),
        ("灵异", 2.9, ("灵异",)),
        ("鬼怪", 2.3, ("鬼怪",)),
    ),
    "游戏": (
        ("网游", 3.4, ("网游",)),
        ("全息", 2.5, ("全息游戏",)),
        ("游戏异界", 2.8, ("游戏异界",)),
        ("游戏", 1.8, ("游戏",)),
        ("电竞", 2.8, ("电竞",)),
    ),
    "体育": (
        ("体育", 3.4, ("体育",)),
        ("足球", 2.8, ("足球",)),
        ("篮球", 2.8, ("篮球",)),
        ("nba", 2.8, ("篮球",)),
    ),
    "同人": (
        ("同人", 3.6, ("同人",)),
        ("综漫", 3.6, ("综漫",)),
        ("衍生", 3.0, ("衍生",)),
        ("火影", 2.7, ("火影",)),
        ("海贼", 2.7, ("海贼",)),
        ("柯南", 2.7, ("柯南",)),
        ("名侦探柯南", 3.0, ("柯南",)),
        ("哈利波特", 2.7, ("哈利·波特",)),
    ),
    "二次元": (
        ("二次元", 3.4, ("二次元",)),
        ("动漫", 2.1, ("动漫",)),
        ("宅系", 2.1, ("宅系",)),
    ),
    "轻小说": (
        ("轻小说", 3.7, ("轻小说",)),
        ("轻文", 2.4, ("轻小说",)),
    ),
}

_EXTRA_TAG_RULES: Mapping[str, tuple[str, ...]] = {
    "穿越": ("穿越", "穿书"),
    "重生": ("重生",),
    "系统": ("系统流", "系统"),
    "快穿": ("快穿",),
    "无限流": ("无限流", "无限恐怖"),
    "种田": ("种田",),
    "校园": ("校园", "大学生活", "高中生活"),
    "豪门": ("豪门", "霸总"),
    "升级流": ("升级流",),
    "无CP": ("无cp", "无感情线"),
    "爽文": ("爽文",),
}

_DIRECTORY_ALIASES: Mapping[str, str] = {
    "玄幻小说": "玄幻",
    "奇幻小说": "奇幻",
    "武侠小说": "武侠",
    "仙侠小说": "仙侠",
    "都市小说": "都市",
    "现实题材": "现实",
    "现代言情": "言情",
    "古代言情": "言情",
    "后宫小说": "后宫",
    "多女主小说": "后宫",
    "纯爱": "耽美",
    "耽美小说": "耽美",
    "百合小说": "百合",
    "历史小说": "历史",
    "军事小说": "军事",
    "科幻小说": "科幻",
    "悬疑小说": "悬疑",
    "恐怖小说": "惊悚",
    "灵异小说": "惊悚",
    "网游": "游戏",
    "游戏小说": "游戏",
    "体育小说": "体育",
    "同人小说": "同人",
    "动漫同人": "同人",
    "二次元小说": "二次元",
    "轻小说": "轻小说",
    "露骨h": "露骨H",
    "成人小说": "露骨H",
    "情色小说": "露骨H",
    "肉文小说": "露骨H",
    "h小说": "露骨H",
}

# Deliberately narrow source override for the curated raw folder named by the
# import owner.  It is strong, but an explicit deeper category directory can
# still win, so it routes most rather than unconditionally every file.
_EXPLICIT_H_SOURCE_PREFIXES: tuple[str, ...] = (
    "/public/home/actueuo6co/后宫/",
)


def _contains_keyword(text: str, keyword: str) -> bool:
    if not text or not keyword:
        return False
    if keyword.isascii() and keyword.isalnum():
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])", text))
    return keyword in text


def _genre_text(value: str | Path | None) -> str:
    return _normalize_unicode(value or "").casefold()


def classify_genre(
    title: str = "",
    path: str | Path = "",
    head_excerpt: str = "",
) -> GenreClassification:
    """Classify a novel using directory hints plus title/excerpt keywords.

    Directory segments and titles carry much more weight than prose.  A lone
    keyword in the excerpt can therefore produce a candidate while remaining
    explicitly low-confidence instead of silently forcing a category.
    """
    title_text = _genre_text(title)
    path_text = _genre_text(path)
    excerpt_text = _genre_text(head_excerpt)[:12000]
    segments = [segment.strip() for segment in re.split(r"[/\\]+", path_text) if segment.strip()]

    scores: dict[str, float] = {genre: 0.0 for genre in CANONICAL_GENRES if genre != "其他"}
    evidence_by_genre: dict[str, list[str]] = {genre: [] for genre in scores}
    found_tags: dict[str, float] = {}
    source_hits: dict[str, set[str]] = {genre: set() for genre in scores}

    explicit_h_source = any(path_text.startswith(prefix) for prefix in _EXPLICIT_H_SOURCE_PREFIXES)
    if explicit_h_source:
        scores["露骨H"] += 9.0
        source_hits["露骨H"].add("path")
        evidence_by_genre["露骨H"].append(
            "path:source-root=/public/home/actueuo6co/后宫->露骨H(+9.00)"
        )
        found_tags["露骨H"] = 9.0
        found_tags["成人内容"] = 9.0

    for segment in segments:
        genre = None
        if explicit_h_source and segment == "后宫":
            # This raw folder predates the split between ordinary harem
            # fiction and explicit adult content.
            continue
        if segment in scores:
            genre = segment
        elif segment in _DIRECTORY_ALIASES:
            genre = _DIRECTORY_ALIASES[segment]
        if genre:
            scores[genre] += 6.5
            source_hits[genre].add("path")
            evidence_by_genre[genre].append(f"path:directory={segment}->{genre}(+6.50)")

    source_specs = (
        ("title", title_text, 1.7),
        ("path", path_text, 1.25),
        ("excerpt", excerpt_text, 0.34),
    )
    for genre, rules in _GENRE_RULES.items():
        for keyword, strength, tags in rules:
            normalized_keyword = _genre_text(keyword)
            for source_name, source_text, multiplier in source_specs:
                if not _contains_keyword(source_text, normalized_keyword):
                    continue
                points = strength * multiplier
                scores[genre] += points
                source_hits[genre].add(source_name)
                evidence_by_genre[genre].append(
                    f"{source_name}:keyword={keyword}->{genre}(+{points:.2f})"
                )
                tag_weight = {"title": 3.0, "path": 2.0, "excerpt": 1.0}[source_name]
                for tag in tags:
                    found_tags[tag] = max(found_tags.get(tag, 0.0), tag_weight + strength)

    combined_for_tags = f"{title_text}\n{path_text}\n{excerpt_text}"
    for tag, keywords in _EXTRA_TAG_RULES.items():
        best = 0.0
        for keyword in keywords:
            normalized_keyword = _genre_text(keyword)
            if _contains_keyword(title_text, normalized_keyword):
                best = max(best, 4.0)
            elif _contains_keyword(path_text, normalized_keyword):
                best = max(best, 3.0)
            elif _contains_keyword(combined_for_tags, normalized_keyword):
                best = max(best, 1.0)
        if best:
            found_tags[tag] = max(found_tags.get(tag, 0.0), best)

    ranked = sorted(scores.items(), key=lambda pair: (-pair[1], CANONICAL_GENRES.index(pair[0])))
    top_genre, top_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    margin = top_score - second_score

    if top_score < 0.9:
        return GenreClassification(
            canonical_genre="其他",
            tags=tuple(tag for tag, _ in sorted(found_tags.items(), key=lambda pair: (-pair[1], pair[0]))[:12]),
            confidence=0.2,
            evidence=("genre:no-reliable-rule-match",),
            low_confidence=True,
            candidates=tuple((genre, score) for genre, score in ranked[:3] if score > 0),
        )

    confidence = 0.40 + min(0.40, top_score * 0.07) + min(0.14, margin * 0.035)
    only_excerpt = source_hits[top_genre] == {"excerpt"}
    if only_excerpt:
        confidence -= 0.18
    if margin < 0.8:
        confidence -= 0.12
    confidence = round(min(0.98, max(0.2, confidence)), 4)
    low_confidence = confidence < 0.62 or margin < 0.8 or only_excerpt
    tags = tuple(
        tag
        for tag, _ in sorted(found_tags.items(), key=lambda pair: (-pair[1], pair[0]))[:12]
    )
    candidates = tuple((genre, score) for genre, score in ranked[:3] if score > 0)
    return GenreClassification(
        canonical_genre=top_genre,
        tags=tags,
        confidence=confidence,
        evidence=tuple(evidence_by_genre[top_genre]),
        low_confidence=low_confidence,
        candidates=candidates,
    )


_HEAD_TITLE_LABEL_RE = re.compile(
    r"(?:书名|作品名|小说名|题名)\s*[:：]\s*"
    r"(?:《\s*(?P<quoted>[^《》]{1,240}?)\s*》|(?P<plain>.{1,240}?))"
    r"(?=\s*(?:(?:[\(（\[【]\s*)?(?:作者|著者|作家|又名|别名|原名|类型|类别|状态|字数|简介)\s*[:：]|$))",
    re.IGNORECASE,
)
_HEAD_ALIAS_LABEL_RE = re.compile(
    rf"{_ALIAS_LABEL}\s*[:：]\s*"
    r"(?:《\s*(?P<quoted>[^《》]{1,240}?)\s*》|(?P<plain>.{1,240}?))"
    r"(?=\s*[\)）\]】]?\s*(?:(?:作者|著者|作家|书名|作品名|小说名|类型|类别|状态|字数|简介)\s*[:：]|$))",
    re.IGNORECASE,
)
_HEAD_AUTHOR_RE = re.compile(
    r"(?:作者|本文作者|著者|作家)\s*[:：]\s*(?P<author>.{1,60}?)"
    r"(?=\s*[\)）\]】]?\s*(?:(?:书名|作品名|小说名|题名|又名|别名|原名|类型|类别|状态|字数|简介)\s*[:：]|$))",
    re.IGNORECASE,
)
_HEAD_STANDALONE_BOOK_RE = re.compile(
    r"^[=\-—_*#~～\s]*《\s*(?P<title>[^《》]{1,240}?)\s*》"
    r"(?:\s*(?:完结|全本|全集|正文完))?[=\-—_*#~～\s]*$",
    re.IGNORECASE,
)


def _head_as_text(value: str | bytes) -> str:
    if isinstance(value, str):
        return value
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return value.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return value.decode("utf-8", errors="replace")


def _add_head_title_candidate(
    candidates: list[dict[str, Any]],
    aliases: list[str],
    evidence: list[str],
    raw_title: str,
    *,
    score: float,
    rule: str,
    line_number: int,
) -> None:
    raw_title = raw_title.rstrip("（([【 ")
    inline_aliases, title_without_aliases, alias_evidence = _alias_values(raw_title)
    primary, ampersand_aliases = _split_ampersand_title_variants(title_without_aliases)
    title, title_cleanup_evidence = _clean_title_core(primary)
    if not title or title == "未命名" or len(title) > 240:
        return
    candidates.append(
        {
            "value": title,
            "score": score,
            "source": "head",
            "eligible": True,
            "line": line_number,
        }
    )
    evidence.extend(f"head:{entry}" for entry in title_cleanup_evidence)
    evidence.extend(f"head:{entry}" for entry in alias_evidence)
    evidence.append(f"head:line-{line_number}:{rule}={title}")
    for raw_alias in (*inline_aliases, *ampersand_aliases):
        alias, _ = _clean_title_core(raw_alias)
        if alias and alias not in aliases:
            aliases.append(alias)
            evidence.append(f"head:line-{line_number}:ampersand-alias={alias}")


def _extract_head_candidates(head_text: str | bytes) -> dict[str, Any]:
    title_candidates: list[dict[str, Any]] = []
    aliases: list[str] = []
    authors: list[dict[str, Any]] = []
    evidence: list[str] = []
    nonempty_line = 0

    for raw_line in _head_as_text(head_text).splitlines():
        line = _normalize_unicode(raw_line)
        if not line:
            continue
        nonempty_line += 1
        if nonempty_line > 200:
            break
        # Extremely long lines are normally chapter prose or broken line
        # endings.  Metadata headers in the sampled corpora are short.
        if len(line) > 1000:
            continue

        labelled_title_keys: set[str] = set()
        labelled_alias_keys: set[str] = set()
        for match in _HEAD_TITLE_LABEL_RE.finditer(line):
            raw_title = match.group("quoted") or match.group("plain") or ""
            before_count = len(title_candidates)
            _add_head_title_candidate(
                title_candidates,
                aliases,
                evidence,
                raw_title,
                score=0.995,
                rule="explicit-title-label",
                line_number=nonempty_line,
            )
            if len(title_candidates) > before_count:
                labelled_title_keys.add(canonical_name_key(title_candidates[-1]["value"]))

        for match in _HEAD_ALIAS_LABEL_RE.finditer(line):
            raw_alias = match.group("quoted") or match.group("plain") or ""
            primary, variant_aliases = _split_ampersand_title_variants(raw_alias)
            for value in (primary, *variant_aliases):
                alias, _ = _clean_title_core(value.rstrip("）)]】 "))
                if alias and alias not in aliases:
                    aliases.append(alias)
                    evidence.append(f"head:line-{nonempty_line}:explicit-alias={alias}")
                if alias:
                    labelled_alias_keys.add(canonical_name_key(alias))

        found_author_on_line = False
        for match in _HEAD_AUTHOR_RE.finditer(line):
            author, author_evidence = _clean_author_core(match.group("author"))
            if author:
                authors.append(
                    {
                        "value": author,
                        "score": 0.99,
                        "source": "head",
                        "line": nonempty_line,
                    }
                )
                evidence.extend(f"head:{entry}" for entry in author_evidence)
                evidence.append(f"head:line-{nonempty_line}:explicit-author={author}")
                found_author_on_line = True

        # ``《书名》作者：...`` is common in the file body.  A quote on such a
        # line is strong even without a separate ``书名：`` label.
        if found_author_on_line:
            for match in re.finditer(r"《\s*([^《》]{1,240}?)\s*》", line):
                raw_title = match.group(1)
                clean_key = canonical_name_key(_clean_title_core(raw_title)[0])
                if clean_key in labelled_title_keys or clean_key in labelled_alias_keys:
                    continue
                _add_head_title_candidate(
                    title_candidates,
                    aliases,
                    evidence,
                    raw_title,
                    score=0.97,
                    rule="book-marks-with-author",
                    line_number=nonempty_line,
                )
        else:
            standalone = _HEAD_STANDALONE_BOOK_RE.match(line)
            if standalone:
                _add_head_title_candidate(
                    title_candidates,
                    aliases,
                    evidence,
                    standalone.group("title"),
                    score=0.84,
                    rule="standalone-book-marks",
                    line_number=nonempty_line,
                )

    return {
        "titles": title_candidates,
        "aliases": aliases,
        "authors": authors,
        "evidence": evidence,
        "nonempty_lines_scanned": min(nonempty_line, 200),
    }


def _rank_field_candidates(
    candidates: Sequence[Mapping[str, Any]],
) -> tuple[str | None, float, set[str], list[str]]:
    """Aggregate independent filename/head evidence by normalized key."""
    groups: dict[str, dict[str, Any]] = {}
    for order, candidate in enumerate(candidates):
        value = str(candidate.get("value") or "").strip()
        key = canonical_name_key(value)
        if not key:
            continue
        group = groups.setdefault(
            key,
            {
                "display": value,
                "display_score": -1.0,
                "source_scores": {},
                "eligible": False,
                "order": order,
            },
        )
        score = float(candidate.get("score") or 0.0)
        source = str(candidate.get("source") or "unknown")
        group["source_scores"][source] = max(
            score,
            float(group["source_scores"].get(source, 0.0)),
        )
        group["eligible"] = bool(group["eligible"] or candidate.get("eligible", True))
        # Prefer the head's explicitly formatted display on an exact-key tie.
        display_score = score + (0.001 if source == "head" else 0.0)
        if display_score > group["display_score"]:
            group["display"] = value
            group["display_score"] = display_score

    ranked: list[tuple[float, int, str, dict[str, Any]]] = []
    for key, group in groups.items():
        if not group["eligible"]:
            continue
        source_scores = group["source_scores"]
        aggregate = sum(float(score) for score in source_scores.values())
        if "filename" in source_scores and "head" in source_scores:
            aggregate += 0.12
        ranked.append((aggregate, -int(group["order"]), key, group))
    ranked.sort(reverse=True)
    if not ranked:
        return None, 0.0, set(), []

    aggregate, _, selected_key, selected = ranked[0]
    selected_sources = set(selected["source_scores"])
    confidence = max(float(score) for score in selected["source_scores"].values())
    if "filename" in selected_sources and "head" in selected_sources:
        confidence = min(0.999, confidence + 0.004)
    conflicts = [
        group["display"]
        for _, _, key, group in ranked[1:]
        if key != selected_key and max(group["source_scores"].values()) >= 0.8
    ]
    if conflicts:
        confidence = max(0.55, confidence - 0.08)
    return str(selected["display"]), round(confidence, 4), selected_sources, conflicts


def extract_metadata_from_file(
    filename: str | Path,
    head_text: str | bytes = "",
    source_path: str | Path = "",
) -> BookNameMetadata:
    """Cross-check filename metadata against the first 200 non-empty lines.

    No file I/O is performed.  ``head_text`` is supplied by the inventory
    reader after encoding detection, although UTF-8/UTF-16/GB18030 bytes are
    accepted as a convenience.  Strong labelled header fields can correct a
    noisy plain filename; conflicts are retained as aliases/evidence and lower
    confidence rather than being silently discarded.
    """
    filename_result = parse_book_filename(filename or source_path)
    if not head_text:
        return filename_result
    head = _extract_head_candidates(head_text)
    evidence = [*filename_result.evidence, *head["evidence"]]
    evidence.append(f"head:nonempty-lines-scanned={head['nonempty_lines_scanned']}")

    title_candidates: list[dict[str, Any]] = [
        {
            "value": filename_result.title,
            "score": float(filename_result.field_confidence.get("title", filename_result.confidence)),
            "source": "filename",
            "eligible": True,
        }
    ]
    for alias in filename_result.aliases:
        title_candidates.append(
            {
                "value": alias,
                "score": 0.68,
                "source": "filename_alias",
                "eligible": False,
            }
        )
    title_candidates.extend(head["titles"])
    for alias in head["aliases"]:
        title_candidates.append(
            {
                "value": alias,
                "score": 0.68,
                "source": "head_alias",
                "eligible": False,
            }
        )

    title, title_confidence, title_sources, title_conflicts = _rank_field_candidates(title_candidates)
    title = title or filename_result.title
    # Standalone 《...》 snippets in scraped bodies are sometimes chapter
    # counters, English slugs, or template fragments.  They must not replace a
    # meaningful Chinese filename title.  Explicit labelled headers retain
    # their stronger score and are therefore unaffected by this guard.
    selected_key_before_cjk_guard = canonical_name_key(title)
    selected_head_score = max(
        (
            float(candidate.get("score") or 0.0)
            for candidate in title_candidates
            if candidate.get("source") == "head"
            and canonical_name_key(str(candidate.get("value") or "")) == selected_key_before_cjk_guard
        ),
        default=0.0,
    )
    if (
        _CJK_RE.search(filename_result.title)
        and not _CJK_RE.search(title)
        and selected_head_score <= 0.90
    ):
        if title and title not in title_conflicts:
            title_conflicts.append(title)
        title = filename_result.title
        title_confidence = float(
            filename_result.field_confidence.get("title", filename_result.confidence)
        )
        title_sources = {"filename"}
        evidence.append("title:preferred-cjk-filename-over-weak-head")
    if "filename" in title_sources and "head" in title_sources:
        evidence.append("title:filename-head-confirmed")
    elif "head" in title_sources:
        evidence.append("title:head-candidate-selected")
    if title_conflicts:
        evidence.append(f"title:conflicting-strong-candidates={len(title_conflicts)}")

    author_candidates: list[dict[str, Any]] = []
    if filename_result.author:
        author_candidates.append(
            {
                "value": filename_result.author,
                "score": float(filename_result.field_confidence.get("author", 0.0)),
                "source": "filename",
                "eligible": True,
            }
        )
    author_candidates.extend(
        {**candidate, "eligible": True} for candidate in head["authors"]
    )
    author, author_confidence, author_sources, author_conflicts = _rank_field_candidates(author_candidates)
    if "filename" in author_sources and "head" in author_sources:
        evidence.append("author:filename-head-confirmed")
    elif "head" in author_sources:
        evidence.append("author:head-candidate-selected")
    if author_conflicts:
        evidence.append(f"author:conflicting-strong-candidates={len(author_conflicts)}")

    aliases: list[str] = []
    selected_key = canonical_name_key(title)
    possible_aliases = [
        *filename_result.aliases,
        *head["aliases"],
        *(str(candidate["value"]) for candidate in title_candidates),
        *title_conflicts,
    ]
    for raw_alias in possible_aliases:
        alias, _ = _clean_title_core(raw_alias)
        if alias and canonical_name_key(alias) != selected_key and alias not in aliases:
            aliases.append(alias)

    if author:
        overall = title_confidence * 0.82 + author_confidence * 0.18
    else:
        overall = max(0.0, title_confidence - 0.04)
    if not head["titles"] and not head["authors"] and not head["aliases"]:
        # Scanning irrelevant chapter prose should not make the filename result
        # appear more certain merely because text was available.
        overall = filename_result.confidence
    if source_path:
        evidence.append("source:path-supplied")
    return BookNameMetadata(
        raw=str(filename),
        title=title,
        author=author,
        aliases=tuple(aliases),
        confidence=round(min(0.999, max(0.0, overall)), 4),
        evidence=tuple(dict.fromkeys(evidence)),
        field_confidence={
            "title": title_confidence,
            "author": author_confidence if author else 0.0,
            "aliases": 0.94 if aliases else 0.5,
        },
    )


def build_local_metadata(item: str | Path | Mapping[str, Any], *, default_id: str = "0") -> dict[str, Any]:
    """Build one flat, JSON-ready rules-only metadata record.

    Mapping inputs may contain ``id``, ``raw_name``/``filename``/``name``,
    ``title``, ``author``, ``aliases``, ``path`` and
    ``head_excerpt``/``excerpt``/``head``.
    """
    if isinstance(item, Mapping):
        source = item
        item_id = str(source.get("id", default_id))
        path = str(source.get("path") or "")
        supplied_title = str(source.get("title") or "")
        raw_name = str(
            source.get("raw_name")
            or source.get("filename")
            or source.get("name")
            or supplied_title
            or _basename(path)
        )
        raw_excerpt = (
            source.get("head_excerpt")
            or source.get("excerpt")
            or source.get("head_text")
            or source.get("head")
            or ""
        )
        excerpt = _head_as_text(raw_excerpt) if isinstance(raw_excerpt, bytes) else str(raw_excerpt)
    else:
        source = {}
        item_id = default_id
        path = str(item) if isinstance(item, Path) else ""
        supplied_title = ""
        raw_name = str(item)
        excerpt = ""

    name = extract_metadata_from_file(raw_name, excerpt, path)
    evidence = list(name.evidence)
    author = name.author
    author_confidence = float(name.field_confidence.get("author", 0.0))
    supplied_author = source.get("author") if isinstance(source, Mapping) else None
    if supplied_author:
        author_field = clean_author(str(supplied_author))
        if author_field.value:
            author = str(author_field.value)
            author_confidence = author_field.confidence
            evidence.extend(author_field.evidence)
            evidence.append("author:supplied-field-preferred")

    aliases = list(name.aliases)
    supplied_aliases = source.get("aliases", ()) if isinstance(source, Mapping) else ()
    if isinstance(supplied_aliases, str):
        supplied_aliases = [supplied_aliases]
    if isinstance(supplied_aliases, Iterable):
        for raw_alias in supplied_aliases:
            alias, _ = _clean_title_core(str(raw_alias))
            if alias and canonical_name_key(alias) != canonical_name_key(name.title) and alias not in aliases:
                aliases.append(alias)
                evidence.append(f"aliases:supplied={alias}")

    genre = classify_genre(title=name.title, path=path, head_excerpt=excerpt)
    evidence.extend(genre.evidence)
    overall_confidence = round(name.confidence * 0.65 + genre.confidence * 0.35, 4)
    return {
        "id": item_id,
        "raw": name.raw,
        "title": name.title,
        "canonical_name_key": canonical_name_key(name.title),
        "author": author,
        "aliases": aliases,
        "genre": genre.canonical_genre,
        "canonical_genre": genre.canonical_genre,
        "tags": list(genre.tags),
        "confidence": overall_confidence,
        "field_confidence": {
            "title": float(name.field_confidence.get("title", 0.0)),
            "author": author_confidence,
            "aliases": float(name.field_confidence.get("aliases", 0.0)),
            "genre": genre.confidence,
        },
        "low_confidence": bool(genre.low_confidence or name.confidence < 0.55),
        "evidence": list(dict.fromkeys(evidence)),
        "source": "rules",
    }


def strict_json_loads(value: str) -> Any:
    """Decode exactly one JSON value, rejecting fences and trailing text."""
    if not isinstance(value, str) or not value.strip():
        raise MetadataResponseError("model response content is empty")
    stripped = value.strip()
    if stripped.startswith("```"):
        raise MetadataResponseError("markdown fenced JSON is not accepted")
    decoder = json.JSONDecoder()
    try:
        decoded, end = decoder.raw_decode(stripped)
    except json.JSONDecodeError as exc:
        raise MetadataResponseError("model response is not valid JSON") from exc
    if stripped[end:].strip():
        raise MetadataResponseError("trailing non-JSON content is not accepted")
    return decoded


_LLM_ITEM_KEYS = frozenset(
    {
        "id",
        "title",
        "author",
        "aliases",
        "genre",
        "tags",
        "confidence",
        "field_confidence",
        "evidence",
    }
)

# Increment this whenever the prompt contract or validation/normalization rules
# change.  The archive importer includes it in its persistent cache key, so a
# stale response can never be reused under a newer acceptance policy.
LLM_METADATA_PROMPT_SCHEMA = "local-metadata.v4-bounded-recoverable-batch"


def _bounded_clean_string(value: Any, *, maximum: int, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise MetadataResponseError("expected a string")
    normalized = _normalize_unicode(value)
    if not normalized or len(normalized) > maximum or "\n" in normalized:
        raise MetadataResponseError("string is empty or over the schema limit")
    return normalized


def _validated_string_list(value: Any, *, maximum_items: int, maximum_length: int) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise MetadataResponseError("expected a bounded JSON array")
    result: list[str] = []
    for item in value:
        cleaned = _bounded_clean_string(item, maximum=maximum_length)
        assert isinstance(cleaned, str)
        if cleaned not in result:
            result.append(cleaned)
    return result


def _validate_llm_item(value: Any, expected_ids: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _LLM_ITEM_KEYS:
        raise MetadataResponseError("metadata item does not match the strict schema")
    item_id = _bounded_clean_string(value["id"], maximum=80)
    assert isinstance(item_id, str)
    if item_id not in expected_ids:
        raise MetadataResponseError("metadata item has an unknown id")
    title = _bounded_clean_string(value["title"], maximum=240)
    assert isinstance(title, str)
    author = _bounded_clean_string(value["author"], maximum=60, nullable=True)
    aliases = _validated_string_list(value["aliases"], maximum_items=20, maximum_length=240)
    genre = _bounded_clean_string(value["genre"], maximum=20)
    genre = _GENRE_CODE_TO_NAME.get(genre, genre)
    if genre not in _GENRE_ALLOWLIST:
        raise MetadataResponseError("genre is not in the canonical allowlist")
    tags = _validated_string_list(value["tags"], maximum_items=20, maximum_length=40)
    evidence = _validated_string_list(value["evidence"], maximum_items=20, maximum_length=240)
    confidence = value["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise MetadataResponseError("confidence must be a JSON number")
    confidence = float(confidence)
    if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
        raise MetadataResponseError("confidence is outside [0, 1]")
    raw_field_confidence = value["field_confidence"]
    if not isinstance(raw_field_confidence, dict) or set(raw_field_confidence) != {
        "title",
        "author",
        "genre",
    }:
        raise MetadataResponseError("field_confidence does not match the strict schema")
    field_confidence: dict[str, float] = {}
    for field_name in ("title", "author", "genre"):
        field_value = raw_field_confidence[field_name]
        if isinstance(field_value, bool) or not isinstance(field_value, (int, float)):
            raise MetadataResponseError("field confidence must be a JSON number")
        field_value = float(field_value)
        if not math.isfinite(field_value) or not 0.0 <= field_value <= 1.0:
            raise MetadataResponseError("field confidence is outside [0, 1]")
        field_confidence[field_name] = field_value
    if author is None and field_confidence["author"] >= 0.5:
        raise MetadataResponseError(
            "null author must have low author field confidence"
        )
    return {
        "id": item_id,
        "title": title,
        "author": author,
        "aliases": aliases,
        "genre": genre,
        "tags": tags,
        "confidence": confidence,
        "field_confidence": field_confidence,
        "evidence": evidence,
    }


class VLLMMetadataClient:
    """OpenAI-compatible batch metadata client with rules-only fallback.

    ``enrich_batch`` never raises for a transport/model/schema failure by
    default.  Affected records retain their deterministic local result and get
    a ``vllm:fallback:*`` evidence entry.  Pass ``raise_on_error=True`` when a
    job runner needs fail-fast behavior instead.
    """

    def __init__(
        self,
        model: str,
        *,
        base_url: str = "http://127.0.0.1:8000/v1",
        api_key: str | None = None,
        timeout: float = 120.0,
        batch_size: int = 1,
        request_concurrency: int = 8,
        max_excerpt_chars: int = 1800,
        max_path_chars: int = 400,
        max_prompt_chars: int = 6000,
        max_tokens: int = 1024,
        session: Any | None = None,
        raise_on_error: bool = False,
    ) -> None:
        if not model.strip():
            raise ValueError("model must not be empty")
        if batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        if max_excerpt_chars < 0:
            raise ValueError("max_excerpt_chars must be >= 0")
        if max_path_chars < 0:
            raise ValueError("max_path_chars must be >= 0")
        if request_concurrency < 1:
            raise ValueError("request_concurrency must be >= 1")
        if max_prompt_chars < 512:
            raise ValueError("max_prompt_chars must be >= 512")
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = float(timeout)
        self.batch_size = int(batch_size)
        self.request_concurrency = int(request_concurrency)
        self.max_excerpt_chars = int(max_excerpt_chars)
        self.max_path_chars = int(max_path_chars)
        self.max_prompt_chars = int(max_prompt_chars)
        self.max_tokens = int(max_tokens)
        self.raise_on_error = bool(raise_on_error)
        self._owns_session = session is None
        if session is None:
            try:
                import requests
            except ImportError as exc:  # pragma: no cover - requests is a project dependency
                raise RuntimeError("VLLMMetadataClient requires the requests package") from exc
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=self.request_concurrency,
                pool_maxsize=self.request_concurrency,
                max_retries=0,
            )
            session.mount("http://", adapter)
            session.mount("https://", adapter)
        self.session = session
        self._executor = (
            ThreadPoolExecutor(
                max_workers=self.request_concurrency,
                thread_name_prefix="novel-vllm",
            )
            if self.request_concurrency > 1
            else None
        )
        self._closed = False

    @property
    def endpoint(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/chat/completions"
        return f"{self.base_url}/v1/chat/completions"

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=True)
        if self._owns_session and hasattr(self.session, "close"):
            self.session.close()

    def __enter__(self) -> "VLLMMetadataClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    @staticmethod
    def _system_prompt() -> str:
        genres = json.dumps(_GENRE_CODE_TO_NAME, ensure_ascii=False, sort_keys=True)
        return (
            "你是中文小说文件元数据清洗器。只根据输入的原文件名、路径提示、开头摘录和规则初值纠错；"
            "不得补写没有证据的作者或书名。输出且只输出一个 JSON 对象，禁止 Markdown。"
            "顶层必须恰好为 {\"items\": [...]}。每项必须恰好包含 id,title,author,aliases,genre,"
            "tags,confidence,field_confidence,evidence；author 未知必须为 null，"
            "aliases/tags/evidence 必须为字符串数组，field_confidence 必须恰好包含 title,author,genre，"
            "confidence 必须为 0 到 1 的数字，表示你结合文件名和摘录复核后的可信度，"
            "field_confidence 中每项也必须为 0 到 1，分别表示该字段自身的证据强度；"
            "不得直接复制 rule_result 的 confidence。没有明确作者证据时 author 必须为 null 且其"
            "field_confidence.author 必须低于 0.5。genre 必须输出以下 ASCII 代码之一："
            f"{genres}。evidence 用简短中文字符串数组说明输入中的依据。"
        )

    def _prompt_items(
        self,
        chunk: Sequence[tuple[str, Mapping[str, Any], dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        prompt_items: list[dict[str, Any]] = []
        for internal_id, original, fallback in chunk:
            excerpt = str(
                original.get("head_excerpt")
                or original.get("excerpt")
                or original.get("head")
                or ""
            )[: self.max_excerpt_chars]
            source_path = str(original.get("path") or "")
            if self.max_path_chars and len(source_path) > self.max_path_chars:
                source_path = source_path[-self.max_path_chars :]
            prompt_items.append(
                {
                    "id": internal_id,
                    "raw_name": fallback["raw"],
                    "path": source_path,
                    "head_excerpt": excerpt,
                    "rule_result": {
                        "title": fallback["title"],
                        "author": fallback["author"],
                        "aliases": fallback["aliases"],
                        "genre": fallback["genre"],
                        "tags": fallback["tags"],
                        "confidence": fallback["confidence"],
                    },
                }
            )
        return prompt_items

    def _request_chunk(
        self,
        chunk: Sequence[tuple[str, Mapping[str, Any], dict[str, Any]]],
    ) -> dict[str, dict[str, Any]]:
        prompt_items = self._prompt_items(chunk)
        expected_ids = [internal_id for internal_id, _, _ in chunk]
        item_schema = {
            "type": "object",
            "additionalProperties": False,
            "required": sorted(_LLM_ITEM_KEYS),
            "properties": {
                "id": {"type": "string", "enum": expected_ids},
                "title": {"type": "string"},
                "author": {"type": ["string", "null"]},
                "aliases": {"type": "array", "items": {"type": "string"}},
                "genre": {"type": "string", "enum": list(_GENRE_CODE_TO_NAME)},
                "tags": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "field_confidence": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["title", "author", "genre"],
                    "properties": {
                        "title": {"type": "number", "minimum": 0, "maximum": 1},
                        "author": {"type": "number", "minimum": 0, "maximum": 1},
                        "genre": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
                "evidence": {"type": "array", "items": {"type": "string"}},
            },
        }
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._system_prompt()},
                {
                    "role": "user",
                    "content": json.dumps({"items": prompt_items}, ensure_ascii=False),
                },
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "novel_metadata_batch",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["items"],
                        "properties": {
                            "items": {
                                "type": "array",
                                "items": item_schema,
                                "minItems": len(expected_ids),
                                "maxItems": len(expected_ids),
                            }
                        },
                    },
                },
            },
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        response = self.session.post(
            self.endpoint,
            json=body,
            headers=headers,
            timeout=self.timeout,
        )
        response.raise_for_status()
        envelope = response.json()
        try:
            choice = envelope["choices"][0]
            content = choice["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise MetadataResponseError("OpenAI response envelope is incomplete") from exc
        finish_reason = str(choice.get("finish_reason") or "")
        if finish_reason not in {"stop", ""}:
            raise MetadataResponseError(f"model finish reason was {finish_reason}")
        payload = strict_json_loads(content)
        if not isinstance(payload, dict) or set(payload) != {"items"} or not isinstance(payload["items"], list):
            raise MetadataResponseError("top-level response does not match the strict schema")

        expected_ids = set(expected_ids)
        validated: dict[str, dict[str, Any]] = {}
        invalid_ids: set[str] = set()
        for raw_item in payload["items"]:
            raw_id = str(raw_item.get("id")) if isinstance(raw_item, dict) and "id" in raw_item else ""
            try:
                item = _validate_llm_item(raw_item, expected_ids)
            except MetadataResponseError:
                if raw_id in expected_ids:
                    invalid_ids.add(raw_id)
                continue
            if item["id"] in validated:
                invalid_ids.add(item["id"])
                validated.pop(item["id"], None)
                continue
            validated[item["id"]] = item
        for invalid_id in invalid_ids:
            validated.pop(invalid_id, None)
        return validated

    def _bounded_chunks(
        self,
        prepared: Sequence[tuple[str, Mapping[str, Any], dict[str, Any]]],
    ) -> list[list[tuple[str, Mapping[str, Any], dict[str, Any]]]]:
        """Bound requests by both item count and serialized input size."""

        chunks: list[list[tuple[str, Mapping[str, Any], dict[str, Any]]]] = []
        current: list[tuple[str, Mapping[str, Any], dict[str, Any]]] = []
        for item in prepared:
            candidate = [*current, item]
            prompt_chars = len(
                json.dumps(
                    {"items": self._prompt_items(candidate)},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            if current and (
                len(candidate) > self.batch_size
                or prompt_chars > self.max_prompt_chars
            ):
                chunks.append(current)
                current = [item]
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks

    @staticmethod
    def _merge_llm(fallback: dict[str, Any], llm: Mapping[str, Any]) -> dict[str, Any]:
        model_title, ampersand_aliases = _split_ampersand_title_variants(str(llm["title"]))
        title, title_evidence = _clean_title_core(model_title)
        if not title:
            raise MetadataResponseError("model title became empty after normalization")
        author = fallback.get("author")
        fallback_author_confidence = float(
            fallback.get("field_confidence", {}).get("author", 0.0)
        )
        kept_fallback_author = bool(
            author
            and llm["author"] is None
            and fallback_author_confidence >= 0.80
        )
        if llm["author"] is None and not kept_fallback_author:
            author = None
        if llm["author"] is not None:
            author, _ = _clean_author_core(str(llm["author"]))
            if not author:
                raise MetadataResponseError("model author is invalid after normalization")

        aliases: list[str] = []
        for raw_alias in [*fallback["aliases"], *llm["aliases"], *ampersand_aliases]:
            alias, _ = _clean_title_core(str(raw_alias))
            if alias and canonical_name_key(alias) != canonical_name_key(title) and alias not in aliases:
                aliases.append(alias)
        tags = list(dict.fromkeys([*llm["tags"], *fallback["tags"]]))[:20]
        llm_confidence = min(0.97, float(llm["confidence"]))
        llm_field_confidence = {
            field_name: min(0.97, float(llm["field_confidence"][field_name]))
            for field_name in ("title", "author", "genre")
        }
        result = dict(fallback)
        result.update(
            {
                "title": title,
                "canonical_name_key": canonical_name_key(title),
                "author": author,
                "aliases": aliases,
                "genre": str(llm["genre"]),
                "canonical_genre": str(llm["genre"]),
                "tags": tags,
                "confidence": round(llm_confidence, 4),
                "low_confidence": llm_confidence < 0.62,
                "source": "vllm",
            }
        )
        field_confidence = dict(fallback["field_confidence"])
        author_field_confidence = (
            float(fallback["field_confidence"].get("author", 0.0))
            if kept_fallback_author
            else (llm_field_confidence["author"] if author else 0.0)
        )
        field_confidence.update(
            {
                "title": llm_field_confidence["title"],
                "author": author_field_confidence,
                "aliases": llm_confidence if aliases else 0.5,
                "genre": llm_field_confidence["genre"],
            }
        )
        result["field_confidence"] = field_confidence
        result["evidence"] = list(
            dict.fromkeys(
                [
                    *fallback["evidence"],
                    *title_evidence,
                    "vllm:strict-json-validated",
                    *(["vllm:author-null-kept-rule-value"] if kept_fallback_author else []),
                    *(f"vllm:{entry}" for entry in llm["evidence"]),
                ]
            )
        )
        return result

    @staticmethod
    def _fallback_with_reason(fallback: dict[str, Any], reason: str) -> dict[str, Any]:
        result = dict(fallback)
        result["evidence"] = [*fallback["evidence"], f"vllm:fallback:{reason}"]
        result["source"] = "rules"
        return result

    def enrich_batch(
        self,
        items: Sequence[str | Path | Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        """Return validated model metadata in input order, falling back per item."""
        prepared: list[tuple[str, Mapping[str, Any], dict[str, Any]]] = []
        for index, item in enumerate(items):
            internal_id = str(index)
            if isinstance(item, Mapping):
                original: Mapping[str, Any] = item
            else:
                original = {"raw_name": str(item)}
            fallback = build_local_metadata(original, default_id=internal_id)
            prepared.append((internal_id, original, fallback))

        chunks = self._bounded_chunks(prepared)
        responses: dict[int, tuple[dict[str, dict[str, Any]] | None, Exception | None]] = {}

        def request(index: int, chunk):
            try:
                model_items = self._request_chunk(chunk)
                missing = [
                    item for item in chunk if item[0] not in model_items
                ]
                # A batched answer may be syntactically valid while omitting or
                # corrupting one item.  Retry only those items as singletons so
                # one weak answer does not discard the rest of the batch.
                for item in missing:
                    try:
                        model_items.update(self._request_chunk([item]))
                    except Exception:
                        pass
                return index, model_items, None
            except Exception as exc:
                if isinstance(exc, MetadataResponseError) and len(chunk) > 1:
                    # Truncated/malformed multi-book JSON is recoverable.  The
                    # singleton retries run inside independent request workers,
                    # preserving high vLLM concurrency without resubmitting
                    # already valid items.
                    recovered: dict[str, dict[str, Any]] = {}
                    for item in chunk:
                        try:
                            recovered.update(self._request_chunk([item]))
                        except Exception:
                            pass
                    return index, recovered, None
                return index, None, exc

        if len(chunks) <= 1 or self.request_concurrency == 1:
            for index, chunk in enumerate(chunks):
                _, model_items, error = request(index, chunk)
                responses[index] = (model_items, error)
        else:
            assert self._executor is not None
            futures = {
                self._executor.submit(request, index, chunk): index
                for index, chunk in enumerate(chunks)
            }
            for future in as_completed(futures):
                index, model_items, error = future.result()
                responses[index] = (model_items, error)

        output: list[dict[str, Any]] = []
        for index, chunk in enumerate(chunks):
            model_items, error = responses[index]
            if error is not None:
                if self.raise_on_error:
                    raise error
                reason = (
                    "invalid-response"
                    if isinstance(error, MetadataResponseError)
                    else "request-error"
                )
                output.extend(
                    self._fallback_with_reason(fallback, reason)
                    for _, _, fallback in chunk
                )
                continue
            assert model_items is not None
            for internal_id, _, fallback in chunk:
                model_item = model_items.get(internal_id)
                if model_item is None:
                    output.append(self._fallback_with_reason(fallback, "missing-or-invalid-item"))
                    continue
                try:
                    output.append(self._merge_llm(fallback, model_item))
                except MetadataResponseError:
                    output.append(self._fallback_with_reason(fallback, "invalid-normalized-item"))
        return output

    # Useful names for batch job code and backwards-friendly discoverability.
    infer_batch = enrich_batch
    classify_batch = enrich_batch


__all__ = [
    "BookNameMetadata",
    "CANONICAL_GENRES",
    "CleanedField",
    "GenreClassification",
    "LLM_METADATA_PROMPT_SCHEMA",
    "MetadataResponseError",
    "VLLMMetadataClient",
    "build_local_metadata",
    "canonical_name_key",
    "classify_genre",
    "clean_aliases",
    "clean_author",
    "clean_book_name",
    "clean_title",
    "extract_metadata_from_file",
    "normalize_book_name",
    "parse_book_filename",
    "strict_json_loads",
]
