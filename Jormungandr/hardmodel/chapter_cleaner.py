from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Callable, Iterable

from shared.text_utils import normalize_line as _shared_normalize_line
from shared.text_utils import normalize_text as _shared_normalize_text

from .chapter_detector import CHAPTER_PATTERN, VOLUME_PATTERN, clean_title
from .chunking import ChunkRecord, build_chunks, split_paragraphs, take_overlap
from .source_resolver import BookSource, ChapterSource
from .noise_patterns import (
    DEFAULT_NOISE_PATTERNS,
    MEDIUM_NOISE_TOKENS,
    NOISE_REGEXES,
    SHORT_NOISE_TOKENS,
    classify_noise_line,
)
from .numerics import CN_NUMERAL_MAP, CN_UNIT_MAP, cn_to_int

# Type alias for the optional model-based noise classifier.
# Receives a list of (line_index, line_text) and returns the indices of
# lines that should be treated as noise.
NoiseClassifier = Callable[[list[tuple[int, str]]], list[int]]


@dataclass(slots=True)
class ChapterRecord:
    chapter_id: str
    order: int
    raw_title: str
    clean_title: str
    chapter_no: int | None
    volume_title: str | None
    volume_no: int | None
    content: str
    char_count: int
    paragraph_count: int
    dialogue_ratio: float
    metadata: dict = field(default_factory=dict)

    @property
    def paragraphs(self) -> list[str]:
        return split_paragraphs(self.content)

    def build_chunks(self, *, chunk_size: int = 1500, chunk_overlap: int = 200) -> list[ChunkRecord]:
        return build_chunks(
            self.paragraphs,
            chapter_id=self.chapter_id,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

    def to_dict(self) -> dict:
        return {
            "chapter_id": self.chapter_id,
            "order": self.order,
            "raw_title": self.raw_title,
            "clean_title": self.clean_title,
            "chapter_no": self.chapter_no,
            "volume_title": self.volume_title,
            "volume_no": self.volume_no,
            "content": self.content,
            "char_count": self.char_count,
            "paragraph_count": self.paragraph_count,
            "dialogue_ratio": self.dialogue_ratio,
            "metadata": self.metadata,
        }


class RawNovelBook:
    """Rule-based processor for a raw TXT novel.

    Supports two input modes:

    * **Whole-book** — a single ``.txt`` file containing all chapters.
      Chapters are detected via regex patterns.
    * **Per-chapter** — a directory of ``.txt`` files, one per chapter.
      Chapter boundaries are already known; only cleaning is applied.

    Use the :meth:`from_whole_book` / :meth:`from_chapter_files`
    classmethods or construct directly with a book source.
    """

    quoted_text_pattern = re.compile(r"[“\"']([^“”\"']{1,80})[”\"']")

    def __init__(
        self,
        source_path: str | Path,
        *,
        encoding: str = "utf-8",
        fallback_encodings: tuple[str, ...] = ("utf-8-sig", "gb18030", "gbk", "big5"),
        chunk_size: int = 1500,
        chunk_overlap: int = 200,
        chapter_sources: list[ChapterSource] | None = None,
        mode: str = "whole",
        book_id: str | None = None,
        noise_classifier: NoiseClassifier | None = None,
    ) -> None:
        self.source_path = Path(source_path)
        self._book_id = book_id
        self.encoding = encoding
        self.fallback_encodings = fallback_encodings
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

        # Per-chapter mode fields
        self.mode: str = mode
        self._chapter_sources: list[ChapterSource] | None = chapter_sources
        self.noise_classifier = noise_classifier

        self.raw_text = ""
        self.normalized_text = ""
        self.cleaned_text = ""
        self.chapters: list[ChapterRecord] = []
        self.book_metadata: dict = {}

    @property
    def book_id(self) -> str:
        if self._book_id:
            return self._book_id
        if self.mode == "per_chapter":
            return self.source_path.name
        return self.source_path.stem

    # -- alternative constructors -----------------------------------------------

    @classmethod
    def from_whole_book(cls, txt_path: str | Path, **kwargs) -> RawNovelBook:
        """Construct for a single whole-book ``.txt`` file (legacy mode)."""
        return cls(txt_path, mode="whole", **kwargs)

    @classmethod
    def from_chapter_files(
        cls,
        chapter_dir: str | Path,
        chapter_sources: list[ChapterSource],
        **kwargs,
    ) -> RawNovelBook:
        """Construct for a directory of per-chapter ``.txt`` files."""
        return cls(
            chapter_dir,
            mode="per_chapter",
            chapter_sources=chapter_sources,
            **kwargs,
        )

    @classmethod
    def from_book_source(cls, source: BookSource, **kwargs) -> RawNovelBook:
        """Construct from a :class:`BookSource` (preferred entry point)."""
        if source.mode == "per_chapter":
            return cls.from_chapter_files(
                source.source_dir,
                source.chapters,
                book_id=source.book_id,
                **kwargs,
            )
        return cls.from_whole_book(source.primary_source, book_id=source.book_id, **kwargs)

    # -- main pipeline ----------------------------------------------------------

    def process(self) -> dict:
        if self.mode == "per_chapter":
            return self._process_per_chapter()

        # Whole-book mode (legacy)
        self.raw_text = self.read_text()
        self.normalized_text = self.normalize_text(self.raw_text)
        self.cleaned_text = self.clean_text(
            self.normalized_text,
            noise_classifier=self.noise_classifier,
        )
        self.chapters = self.split_chapters(self.cleaned_text)
        self.book_metadata = self.build_book_metadata()
        return self.to_dict()

    def _process_per_chapter(self) -> dict:
        """Process one chapter file at a time — no regex splitting needed."""
        if not self._chapter_sources:
            raise ValueError("Per-chapter mode requires chapter_sources")

        records: list[ChapterRecord] = []
        for ch_src in self._chapter_sources:
            record = self._process_single_chapter(ch_src)
            records.append(record)

        self.chapters = records
        self.book_metadata = self.build_book_metadata()
        return self.to_dict()

    def _process_single_chapter(self, ch_src: ChapterSource) -> ChapterRecord:
        """Read, normalise, clean a single chapter file → ChapterRecord."""
        try:
            raw = ch_src.source_path.read_text(encoding=self.encoding)
        except UnicodeDecodeError:
            # Try fallback encodings
            raw = self._read_with_fallbacks(ch_src.source_path)
        raw = raw.lstrip("﻿")

        normalised = self.normalize_text(raw)
        cleaned = self.clean_text(normalised, noise_classifier=self.noise_classifier)

        # Use the title from ChapterSource (from index.json or filename)
        resolved_title = ch_src.title or f"chapter_{ch_src.order}"
        cleaned_lines = cleaned.splitlines()
        leading_heading = self._leading_chapter_heading(cleaned_lines)
        if leading_heading and self._is_generic_chapter_title(resolved_title):
            resolved_title = leading_heading
        content_lines = self._strip_embedded_chapter_title(
            cleaned_lines,
            title=resolved_title,
            chapter_no=ch_src.chapter_no,
        )

        record = self.build_chapter_record(
            order=ch_src.order,
            raw_title=resolved_title,
            volume_title=None,
            volume_no=None,
            content_lines=content_lines,
        )
        # Per-chapter source manifests are authoritative for chapter titles.
        record.raw_title = resolved_title
        record.clean_title = resolved_title
        if record.chapter_no is None:
            record.chapter_no = ch_src.chapter_no
        record.metadata["source_path"] = str(ch_src.source_path)
        return record

    def _leading_chapter_heading(self, lines: list[str]) -> str | None:
        for raw_line in lines:
            line = raw_line.strip()
            if not line:
                continue
            if self.parse_chapter_line(line):
                return line
            return None
        return None

    @staticmethod
    def _is_generic_chapter_title(title: str) -> bool:
        normalized = title.strip().lower()
        return bool(re.fullmatch(r"chapter[_-]?\d+", normalized)) or normalized in {"chapter", "full_text"}

    def _strip_embedded_chapter_title(
        self,
        lines: list[str],
        *,
        title: str,
        chapter_no: int | None,
    ) -> list[str]:
        trimmed = list(lines)
        while trimmed and not trimmed[0].strip():
            trimmed.pop(0)
        if not trimmed:
            return []

        first_line = trimmed[0].strip()
        first_meta = self.parse_chapter_line(first_line)
        normalized_first = self.normalize_line(first_line)
        normalized_title = self.normalize_line(title)
        if normalized_first == normalized_title:
            return trimmed[1:]

        if first_meta:
            first_clean = self.normalize_line(first_meta.get("clean_title", ""))
            title_meta = self.parse_chapter_line(title)
            title_clean = title_meta.get("clean_title", "") if title_meta else clean_title(title)
            if first_clean and first_clean == self.normalize_line(title_clean):
                return trimmed[1:]
            if chapter_no is not None and first_meta.get("chapter_no") == chapter_no:
                return trimmed[1:]
            if self._is_generic_chapter_title(title):
                return trimmed[1:]

        return trimmed

    def can_resume_chapter(self, ch_src: ChapterSource) -> bool:
        """Check whether *ch_src* has already been processed and is unchanged.

        Used by the incremental processor to skip chapters whose output
        already exists and is up-to-date.
        """
        if self.mode != "per_chapter":
            return False
        # We can't check from here — delegation to PipelineState in processor.py
        return False

    def read_text(self) -> str:
        encodings = [self.encoding, *self.fallback_encodings]
        last_error: UnicodeDecodeError | None = None
        for encoding in dict.fromkeys(encodings):
            try:
                text = self.source_path.read_text(encoding=encoding)
                return text.lstrip("﻿")
            except UnicodeDecodeError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        return self.source_path.read_text().lstrip("﻿")

    def _read_with_fallbacks(self, path: Path) -> str:
        """Try to read *path* with fallback encodings."""
        for encoding in dict.fromkeys([self.encoding, *self.fallback_encodings]):
            try:
                return path.read_text(encoding=encoding)
            except UnicodeDecodeError:
                continue
        # Last resort
        return path.read_text(encoding="latin-1")

    # -- text normalisation -----------------------------------------------------

    @staticmethod
    def normalize_text(text: str) -> str:
        return _shared_normalize_text(text)

    @staticmethod
    def normalize_line(line: str) -> str:
        return _shared_normalize_line(line)

    # -- noise filtering --------------------------------------------------------

    def clean_text(
        self,
        text: str,
        *,
        noise_classifier: NoiseClassifier | None = None,
    ) -> str:
        """Remove noise lines from *text*.

        Uses a three-tier classification:

        1. Lines matching *strong* noise signals are removed immediately.
        2. Lines matching *weak* noise signals are passed to
           *noise_classifier* (when provided) for a second opinion.
        3. All other lines are kept.

        Args:
            text: Normalised multi-line text.
            noise_classifier: Optional callback that receives a list of
                ``(line_index, line_text)`` tuples for lines classified as
                *weak noise* and returns the indices of those that should
                be discarded.  When ``None`` (the default), weak-noise
                lines are kept to avoid false positives.

        Returns:
            Cleaned text with noise lines removed.
        """
        # First pass: separate lines into keep / discard / uncertain
        kept: list[str] = []
        uncertain: list[tuple[int, str]] = []  # (position in kept list, text)

        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                if kept and kept[-1] != "":
                    kept.append("")
                continue

            # Delegate to the tiered classifier
            is_strong, is_weak = self._classify_line(stripped)
            if is_strong:
                continue
            if is_weak:
                # Track position in the kept list for potential removal later
                uncertain.append((len(kept), stripped))
                kept.append(stripped)
                continue
            kept.append(stripped)

        # Second pass: resolve uncertain lines via model fallback
        if uncertain and noise_classifier is not None:
            discard_indices: set[int] = set()
            try:
                discard_indices = set(noise_classifier(uncertain))
            except Exception:
                # If the model classifier fails, keep all uncertain lines
                # rather than losing potentially valid content.
                pass

            if discard_indices:
                # Rebuild kept list without discarded indices
                kept = [
                    line
                    for idx, line in enumerate(kept)
                    if idx not in discard_indices
                ]

        cleaned = "\n".join(kept)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned.strip()

    def _classify_line(self, line: str) -> tuple[bool, bool]:
        """Classify a single line using the tiered signal system.

        Returns:
            ``(is_strong_noise, is_weak_noise)`` tuple.
        """
        normalised = self.normalize_line(line)

        if not normalised:
            return (False, False)

        # Chapter / volume headings are always clean
        if self.parse_chapter_line(normalised) or self.parse_volume_line(normalised):
            return (False, False)

        # Very short lines are not noise (could be dialogue fragments)
        if len(normalised) <= 2:
            return (False, False)

        # Pure punctuation / symbol lines are strong noise
        if re.fullmatch(r"[0-9\-\.,，。:：_/\\|]+", normalised):
            return (True, False)

        # Use the shared tiered classifier
        is_strong, is_weak = classify_noise_line(normalised)
        if is_strong:
            return (True, False)

        # Additional hardmodel-specific checks that may upgrade weak to strong
        chinese_chars = len(re.findall(r"[一-鿿]", normalised))
        alnum_chars = len(re.findall(r"[A-Za-z0-9]", normalised))
        symbol_chars = len(re.findall(r"[^一-鿿A-Za-z0-9\s]", normalised))
        total_chars = max(len(normalised), 1)

        symbol_ratio = symbol_chars / total_chars
        alnum_ratio = alnum_chars / total_chars

        # High symbol ratio on short lines is strong noise
        if len(normalised) < 50 and symbol_ratio > 0.35:
            return (True, False)
        # High alnum ratio with few Chinese chars is strong noise
        if len(normalised) < 50 and alnum_ratio > 0.6 and chinese_chars < 5:
            return (True, False)

        return (is_strong, is_weak)

    # Legacy method — kept for backward compatibility
    def is_noise_line(self, line: str) -> bool:
        is_strong, _ = self._classify_line(line)
        return is_strong

    # -- chapter splitting ------------------------------------------------------

    def split_chapters(self, text: str) -> list[ChapterRecord]:
        chapters: list[ChapterRecord] = []
        current_volume_title: str | None = None
        current_volume_no: int | None = None
        current_title: str | None = None
        buffer: list[str] = []
        order = 1

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line:
                continue

            volume_match = self.parse_volume_line(line)
            chapter_match = self.parse_chapter_line(line)

            if volume_match and not chapter_match:
                current_volume_title = volume_match["volume_title"]
                current_volume_no = volume_match["volume_no"]
                continue

            if chapter_match:
                if current_title is not None or buffer:
                    chapters.append(
                        self.build_chapter_record(
                            order=order,
                            raw_title=current_title or f"chapter_{order}",
                            volume_title=current_volume_title,
                            volume_no=current_volume_no,
                            content_lines=buffer,
                        )
                    )
                    order += 1
                current_title = chapter_match["raw_title"]
                if chapter_match["volume_title"]:
                    current_volume_title = chapter_match["volume_title"]
                if chapter_match["volume_no"] is not None:
                    current_volume_no = chapter_match["volume_no"]
                buffer = []
                continue

            buffer.append(line)

        if current_title is not None or buffer:
            chapters.append(
                self.build_chapter_record(
                    order=order,
                    raw_title=current_title or "preface",
                    volume_title=current_volume_title,
                    volume_no=current_volume_no,
                    content_lines=buffer,
                )
            )

        if not chapters and text.strip():
            chapters.append(
                self.build_chapter_record(
                    order=1,
                    raw_title="full_text",
                    volume_title=None,
                    volume_no=None,
                    content_lines=text.splitlines(),
                )
            )
        return chapters

    def parse_volume_line(self, line: str) -> dict | None:
        match = VOLUME_PATTERN.match(line)
        if not match:
            return None
        number_text = match.group("num")
        free_title = match.group("free")
        title = match.group("title").strip() or free_title or line.strip()
        volume_title = clean_title(title) if title else line.strip()
        return {
            "volume_title": volume_title,
            "volume_no": self.parse_number(number_text) if number_text else None,
        }

    def parse_chapter_line(self, line: str) -> dict | None:
        match = CHAPTER_PATTERN.match(line)
        if not match:
            return None

        volume_title = None
        volume_no = None
        volume_prefix = match.group("volume_prefix")
        if volume_prefix:
            parsed_volume = self.parse_volume_line(volume_prefix.strip())
            if parsed_volume:
                volume_title = parsed_volume["volume_title"]
                volume_no = parsed_volume["volume_no"]

        raw_title = line.strip()
        resolved_clean_title = clean_title(raw_title)
        number_text = match.group("num")
        marker = match.group("marker") or ""
        if number_text and not match.group("title").strip():
            resolved_clean_title = f"{match.group('head')}"
        elif number_text:
            resolved_clean_title = f"第{number_text}{marker} {match.group('title').strip()}".strip()
        else:
            resolved_clean_title = raw_title

        return {
            "raw_title": raw_title,
            "clean_title": resolved_clean_title,
            "chapter_no": self.parse_number(number_text) if number_text else None,
            "volume_title": volume_title,
            "volume_no": volume_no,
        }

    def build_chapter_record(
        self,
        *,
        order: int,
        raw_title: str,
        volume_title: str | None,
        volume_no: int | None,
        content_lines: Iterable[str],
    ) -> ChapterRecord:
        chapter_meta = self.parse_chapter_line(raw_title) or {}
        paragraphs = [line.strip() for line in content_lines if line.strip()]
        content = "\n".join(paragraphs).strip()
        return ChapterRecord(
            chapter_id=f"{self.book_id}C{order:04d}",
            order=order,
            raw_title=raw_title,
            clean_title=chapter_meta.get("clean_title") or clean_title(raw_title),
            chapter_no=chapter_meta.get("chapter_no"),
            volume_title=chapter_meta.get("volume_title") or volume_title,
            volume_no=chapter_meta.get("volume_no") if chapter_meta.get("volume_no") is not None else volume_no,
            content=content,
            char_count=len(content.replace("\n", "")),
            paragraph_count=len(paragraphs),
            dialogue_ratio=self.calculate_dialogue_ratio(content),
            metadata={
                "source_path": str(self.source_path),
                "has_content": bool(content),
            },
        )

    # -- chunking helpers (delegate to standalone functions) ---------------------

    @staticmethod
    def _split_paragraphs(text: str) -> list[str]:
        return split_paragraphs(text)

    @staticmethod
    def _take_overlap(paragraphs: list[str], overlap_chars: int) -> list[str]:
        return take_overlap(paragraphs, overlap_chars)

    def chunk_text(self, *, chapter_id: str, text: str) -> list[ChunkRecord]:
        return build_chunks(
            split_paragraphs(text),
            chapter_id=chapter_id,
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

    def build_chunk_index(self) -> dict[str, list[dict]]:
        return {
            chapter.chapter_id: [
                chunk.to_dict()
                for chunk in chapter.build_chunks(
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                )
            ]
            for chapter in self.chapters
        }

    # -- dialogue ratio ----------------------------------------------------------

    def calculate_dialogue_ratio(self, text: str) -> float:
        if not text:
            return 0.0
        dialogue_chars = sum(len(match.group(1)) for match in self.quoted_text_pattern.finditer(text))
        if dialogue_chars == 0:
            dialogue_chars = sum(
                len(paragraph)
                for paragraph in split_paragraphs(text)
                if paragraph.startswith(("“", "\"", "'"))
            )
        total_chars = max(1, len(text.replace("\n", "")))
        return round(dialogue_chars / total_chars, 4)

    # -- metadata ---------------------------------------------------------------

    def build_book_metadata(self) -> dict:
        total_chars = sum(chapter.char_count for chapter in self.chapters)
        total_paragraphs = sum(chapter.paragraph_count for chapter in self.chapters)
        volume_titles = [chapter.volume_title for chapter in self.chapters if chapter.volume_title]
        return {
            "book_id": self.book_id,
            "source_path": str(self.source_path),
            "chapter_count": len(self.chapters),
            "volume_count": len(dict.fromkeys(volume_titles)),
            "total_chars": total_chars,
            "total_paragraphs": total_paragraphs,
            "avg_chapter_chars": round(total_chars / len(self.chapters), 2) if self.chapters else 0,
        }

    # -- number parsing (delegate to numerics module) ----------------------------

    def parse_number(self, value: str | None) -> int | None:
        if not value:
            return None
        if value.isdigit():
            return int(value)
        return cn_to_int(value)

    # -- serialisation ----------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "book_metadata": self.book_metadata,
            "chapters": [chapter.to_dict() for chapter in self.chapters],
        }
