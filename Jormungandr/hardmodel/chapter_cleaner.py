from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Any, Callable, Iterable

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
    WEAK_NOISE_PATTERNS,
    WEAK_NOISE_TOKENS,
    classify_noise_line,
)
from .numerics import CN_NUMERAL_MAP, CN_UNIT_MAP, cn_to_int

# Type alias for the optional model-based noise classifier.
# Receives weak-noise candidates as small JSON-serializable windows. It may
# return legacy candidate_id/kept_index integers for drops, or structured
# actions such as {"candidate_id": 1, "action": "trim", "cleaned_line": "..."}.
NoiseClassifier = Callable[[list[dict[str, Any]]], list[Any]]


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
        content_type: str = "book",
        processing_profile: str = "longform_book",
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
        self.content_type = content_type
        self.processing_profile = processing_profile
        self.noise_classifier = noise_classifier

        self.raw_text = ""
        self.normalized_text = ""
        self.cleaned_text = ""
        self.chapters: list[ChapterRecord] = []
        self.book_metadata: dict = {}
        self.cleaning_stats: dict[str, int] = {
            "lines_seen": 0,
            "strong_dropped": 0,
            "weak_candidates": 0,
            "weak_windows_built": 0,
            "weak_dropped": 0,
            "protected_by_prose": 0,
            "position_promoted": 0,
            "frequency_promoted": 0,
            "trimmed_lines": 0,
            "rule_trimmed": 0,
            "llm_trimmed": 0,
        }
        self.discarded_line_examples: list[dict[str, Any]] = []
        self.trimmed_line_examples: list[dict[str, Any]] = []
        self._line_frequency_counts: dict[str, int] = {}

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
                content_type=source.content_type,
                processing_profile=source.processing_profile,
                **kwargs,
            )
        return cls.from_whole_book(
            source.primary_source,
            book_id=source.book_id,
            content_type=source.content_type,
            processing_profile=source.processing_profile,
            **kwargs,
        )

    # -- main pipeline ----------------------------------------------------------

    def process(self) -> dict:
        if self.mode == "per_chapter":
            return self._process_per_chapter()

        # Whole-book mode (legacy)
        self.raw_text = self.read_text()
        self.normalized_text = self.normalize_text(self.raw_text)
        self.normalized_text = self._ensure_paragraphs(self.normalized_text)
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

        self._line_frequency_counts = self._build_frequency_counts_for_sources(self._chapter_sources)
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
        normalised = self._ensure_paragraphs(normalised)
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

    def _build_frequency_counts_for_sources(self, chapter_sources: list[ChapterSource]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for ch_src in chapter_sources:
            try:
                raw = ch_src.source_path.read_text(encoding=self.encoding)
            except UnicodeDecodeError:
                raw = self._read_with_fallbacks(ch_src.source_path)
            self._add_frequency_counts(counts, self.normalize_text(raw))
        return counts

    def _add_frequency_counts(self, counts: dict[str, int], text: str) -> None:
        for line in text.splitlines():
            key = self._frequency_key(line)
            if key:
                counts[key] = counts.get(key, 0) + 1

    def _frequency_key(self, line: str) -> str:
        normalized = self.normalize_line(line)
        if len(normalized) < 6:
            return ""
        if self.parse_chapter_line(normalized) or self.parse_volume_line(normalized):
            return ""
        return normalized

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

    # -- paragraph reflow (defensive) ------------------------------------------

    #: Threshold above which a single line is considered under-paragraphed.
    REFLOW_LINE_THRESHOLD: int = 2000

    #: Split after these sentence-ending punctuation marks when they are
    #: followed by a Chinese character or opening quotation mark.
    _REFLOW_SENTENCE: re.Pattern = re.compile(
        r"(?<=[。！？…])(?=[一-鿿“‘　])"
    )
    #: Split after 「」 closing quotes at transitions back into content.
    _REFLOW_CLOSE_QUOTE: re.Pattern = re.compile(
        r"(?<=[」])(?=[一-鿿“‘])"
    )

    def _ensure_paragraphs(self, text: str) -> str:
        """Defensive reflow of text that arrives without paragraph breaks.

        Some source sites serve content with ``<br>`` instead of ``<p>``
        or with HTML that otherwise loses paragraph boundaries.  When every
        line in *text* is shorter than :attr:`REFLOW_LINE_THRESHOLD`
        (default 2 000 characters) the text is returned unchanged.

        Otherwise long lines are split at Chinese sentence-ending
        punctuation (``。！？…``) followed by a content character, and at
        closing book-name quotes (``」``) when they end a sentence.
        """
        lines = text.splitlines()
        non_empty = [ln for ln in lines if ln.strip()]
        if not non_empty:
            return text
        if max(len(ln) for ln in non_empty) < self.REFLOW_LINE_THRESHOLD:
            return text

        result: list[str] = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                result.append("")
                continue
            if len(line) < self.REFLOW_LINE_THRESHOLD:
                result.append(line)
                continue
            # Split at sentence-ending punctuation → new content
            for segment in self._REFLOW_SENTENCE.split(line):
                for sub in self._REFLOW_CLOSE_QUOTE.split(segment):
                    s = sub.strip()
                    if s:
                        result.append(s)

        return "\n".join(result)

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
        frequency_counts = self._line_frequency_counts or {}
        if not frequency_counts:
            frequency_counts = {}
            self._add_frequency_counts(frequency_counts, text)

        source_lines = text.splitlines()
        boundary_positions = self._chapter_boundary_positions(source_lines)

        # First pass: separate lines into keep / discard / uncertain.
        kept: list[str] = []
        uncertain_windows: list[dict[str, Any]] = []

        for line_index, line in enumerate(source_lines):
            stripped = line.strip()
            if not stripped:
                if kept and kept[-1] != "":
                    kept.append("")
                continue

            self.cleaning_stats["lines_seen"] += 1
            original_line = stripped
            trim_result = self._trim_noise_spans(stripped)
            if trim_result.get("action") == "trim":
                stripped = str(trim_result.get("cleaned_line") or "").strip()
                self.cleaning_stats["trimmed_lines"] += 1
                self.cleaning_stats["rule_trimmed"] += 1
                self._record_trimmed_line_example(
                    original_line=original_line,
                    cleaned_line=stripped,
                    source_index=line_index,
                    reason="rule_trim",
                    details=trim_result,
                )
                if not stripped:
                    continue

            # Delegate to the tiered, context-aware classifier.
            position_score = boundary_positions.get(line_index, 0)
            frequency_score = self._pattern_frequency_score(stripped, frequency_counts)
            is_strong, is_weak, details = self._classify_line_details(
                stripped,
                position_score=position_score,
                pattern_frequency_score=frequency_score,
            )
            if is_strong:
                self.cleaning_stats["strong_dropped"] += 1
                self._record_discarded_line_example(
                    line=stripped,
                    source_index=line_index,
                    reason="strong_rule",
                    details=details,
                )
                continue
            if is_weak:
                # Track position in the kept list for potential removal later
                uncertain_windows.append(
                    self._build_weak_noise_window(
                        candidate_id=len(uncertain_windows),
                        kept_index=len(kept),
                        source_index=line_index,
                        lines=source_lines,
                        details=details,
                    )
                )
                self.cleaning_stats["weak_candidates"] += 1
                self.cleaning_stats["weak_windows_built"] += 1
                kept.append(stripped)
                continue
            kept.append(stripped)

        # Second pass: resolve uncertain windows via model fallback.
        if uncertain_windows and noise_classifier is not None:
            discard_indices: set[int] = set()
            trim_updates: dict[int, dict[str, Any]] = {}
            candidates_by_kept_index = {
                int(candidate["kept_index"]): candidate for candidate in uncertain_windows
            }
            try:
                classifier_results = noise_classifier(uncertain_windows)
                discard_values: set[int] = set()
                for result in classifier_results:
                    if isinstance(result, dict):
                        action = str(result.get("action") or "").strip().lower()
                        candidate_id = self._optional_int(result.get("candidate_id"))
                        kept_index = self._optional_int(result.get("kept_index"))
                        target_index = self._resolve_candidate_kept_index(
                            uncertain_windows,
                            candidate_id=candidate_id,
                            kept_index=kept_index,
                        )
                        if target_index is None:
                            continue
                        if action == "drop":
                            discard_indices.add(target_index)
                        elif action == "trim":
                            cleaned_line = str(result.get("cleaned_line") or "").strip()
                            if self._is_safe_trim_remainder(cleaned_line):
                                trim_updates[target_index] = {
                                    "cleaned_line": cleaned_line,
                                    "result": result,
                                }
                        continue
                    try:
                        discard_values.add(int(result))
                    except (TypeError, ValueError):
                        continue
                for candidate in uncertain_windows:
                    candidate_id = int(candidate["candidate_id"])
                    kept_index = int(candidate["kept_index"])
                    if candidate_id in discard_values or kept_index in discard_values:
                        discard_indices.add(kept_index)
            except Exception:
                # If the model classifier fails, keep all uncertain lines
                # rather than losing potentially valid content.
                pass

            for kept_index, update in trim_updates.items():
                if kept_index in discard_indices:
                    continue
                candidate = candidates_by_kept_index.get(kept_index)
                cleaned_line = str(update.get("cleaned_line") or "").strip()
                if candidate and cleaned_line and kept_index < len(kept):
                    self._record_trimmed_line_example(
                        original_line=str(candidate.get("line") or kept[kept_index]),
                        cleaned_line=cleaned_line,
                        source_index=int(candidate.get("source_index") or 0),
                        reason="llm_trim",
                        details=update.get("result") if isinstance(update.get("result"), dict) else {},
                    )
                    kept[kept_index] = cleaned_line
                    self.cleaning_stats["trimmed_lines"] += 1
                    self.cleaning_stats["llm_trimmed"] += 1

            if discard_indices:
                for kept_index in sorted(discard_indices):
                    candidate = candidates_by_kept_index.get(kept_index)
                    if candidate:
                        self._record_discarded_line_example(
                            line=str(candidate.get("line") or ""),
                            source_index=int(candidate.get("source_index") or 0),
                            reason="weak_llm",
                            details=candidate,
                        )
                # Rebuild kept list without discarded indices
                kept = [
                    line
                    for idx, line in enumerate(kept)
                    if idx not in discard_indices
                ]
                self.cleaning_stats["weak_dropped"] += len(discard_indices)

        cleaned = "\n".join(kept)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned.strip()

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _resolve_candidate_kept_index(
        candidates: list[dict[str, Any]],
        *,
        candidate_id: int | None,
        kept_index: int | None,
    ) -> int | None:
        if kept_index is not None:
            return kept_index
        if candidate_id is None:
            return None
        for candidate in candidates:
            raw_candidate_id = candidate.get("candidate_id")
            if raw_candidate_id is None:
                continue
            if int(raw_candidate_id) == candidate_id:
                raw_kept_index = candidate.get("kept_index")
                return int(raw_kept_index) if raw_kept_index is not None else 0
        return None

    def _trim_noise_spans(self, line: str) -> dict[str, Any]:
        """Conservatively remove high-confidence noise prefixes/suffixes."""
        original = line.strip()
        if not original:
            return {"action": "keep", "cleaned_line": original, "removed_spans": []}

        working = original
        removed_spans: list[dict[str, str]] = []

        url_like = r"(?:https?://\S+|www\.\S+|[A-Za-z0-9.-]+\.(?:com|cn|net|org|cc|io))"
        prefix_patterns = [
            (rf"^(?:请收藏(?:本站|本书)?|请记住本站(?:域名)?|最新网址|最新章节|首发地址|本书首发|手机用户请浏览|手机用户请访问|请到.{{0,10}}阅读|天才一秒记住|一秒记住)[^，。！？；\n]{{0,100}}?{url_like}\s+", "site_url_prefix"),
            (r"^(?:https?://\S+|www\.\S+)\s+", "url_prefix"),
            (r"^(?:最新网址|最新章节|首发地址|本书首发|请记住本站(?:域名)?|记住本站)[：:，,、\s]*\S{0,80}?[，。:：、\s]+", "site_prefix"),
            (r"^(?:手机用户请浏览|手机用户请访问|请到.{0,10}阅读|天才一秒记住|一秒记住)[^，。！？；\n]{0,80}[，。:：、\s]+", "reader_site_prefix"),
            (r"^(?:请收藏(?:本站|本书)?|求收藏|求月票|求推荐票|请投票|求订阅|求打赏)[^，。！？；\n]{0,30}[，。:：、\s]+", "solicitation_prefix"),
            (r"^(?:ps|PS)[：:]\s*", "ps_prefix"),
        ]
        suffix_patterns = [
            (r"\s*[（(]?(?:本章完|未完待续)[）)]?\s*$", "end_marker_suffix"),
            (r"\s+(?:https?://\S+|www\.\S+)\s*$", "url_suffix"),
            (r"[，。:：、\s]+(?:请收藏(?:本站|本书)?|求收藏|求月票|求推荐票|请投票|求订阅|求打赏).{0,40}$", "solicitation_suffix"),
        ]

        changed = True
        while changed:
            changed = False
            for pattern, reason in prefix_patterns:
                match = re.match(pattern, working)
                if not match:
                    continue
                removed = match.group(0)
                candidate = working[match.end() :].strip()
                if self._is_safe_trim_remainder(candidate):
                    removed_spans.append({"text": removed.strip(), "reason": reason})
                    working = candidate
                    changed = True
                    break

        changed = True
        while changed:
            changed = False
            for pattern, reason in suffix_patterns:
                match = re.search(pattern, working)
                if not match:
                    continue
                removed = match.group(0)
                candidate = working[: match.start()].strip()
                leading_punctuation = re.match(r"\s*([，。！？；])", removed)
                if reason == "solicitation_suffix" and leading_punctuation:
                    punctuation = leading_punctuation.group(1)
                    if candidate and not candidate.endswith(("，", "。", "！", "？", "；")):
                        candidate = f"{candidate}{punctuation}"
                if self._is_safe_trim_remainder(candidate):
                    removed_spans.append({"text": removed.strip(), "reason": reason})
                    working = candidate
                    changed = True
                    break

        if removed_spans and working != original:
            return {
                "action": "trim",
                "cleaned_line": working,
                "removed_spans": removed_spans,
                "original_line": original,
            }
        return {"action": "keep", "cleaned_line": original, "removed_spans": []}

    def _is_safe_trim_remainder(self, text: str) -> bool:
        cleaned = text.strip()
        if len(re.findall(r"[一-鿿]", cleaned)) < 8:
            return False
        prose_score, _ = self._prose_score(cleaned)
        if prose_score >= 2:
            return True
        return bool(re.search(r"[，。！？；]", cleaned)) and len(cleaned) >= 16

    def _record_discarded_line_example(
        self,
        *,
        line: str,
        source_index: int,
        reason: str,
        details: dict[str, Any],
        limit: int = 20,
    ) -> None:
        if len(self.discarded_line_examples) >= limit:
            return
        text = line.strip()
        if not text:
            return
        self.discarded_line_examples.append(
            {
                "line": text[:240],
                "source_index": source_index,
                "reason": reason,
                "position_score": int(details.get("position_score") or 0),
                "pattern_frequency_score": int(details.get("pattern_frequency_score") or 0),
                "prose_score": int(details.get("prose_score") or 0),
                "noise_score": int(details.get("noise_score") or 0),
                "weak_reason": str(details.get("weak_reason") or ""),
            }
        )

    def _record_trimmed_line_example(
        self,
        *,
        original_line: str,
        cleaned_line: str,
        source_index: int,
        reason: str,
        details: dict[str, Any],
        limit: int = 20,
    ) -> None:
        if len(self.trimmed_line_examples) >= limit:
            return
        original = original_line.strip()
        cleaned = cleaned_line.strip()
        if not original or not cleaned or original == cleaned:
            return
        self.trimmed_line_examples.append(
            {
                "original_line": original[:240],
                "cleaned_line": cleaned[:240],
                "source_index": source_index,
                "reason": reason,
                "removed_spans": details.get("removed_spans", []),
            }
        )

    def _build_weak_noise_window(
        self,
        *,
        candidate_id: int,
        kept_index: int,
        source_index: int,
        lines: list[str],
        details: dict[str, Any],
        radius: int = 2,
    ) -> dict[str, Any]:
        start = max(0, source_index - radius)
        end = min(len(lines), source_index + radius + 1)
        context: list[dict[str, Any]] = []
        for idx in range(start, end):
            text = lines[idx].strip()
            if not text:
                continue
            role = "current" if idx == source_index else ("before" if idx < source_index else "after")
            context.append({"source_index": idx, "role": role, "text": text})
        return {
            "candidate_id": candidate_id,
            "kept_index": kept_index,
            "source_index": source_index,
            "line": lines[source_index].strip(),
            "context": context,
            "window_text": "\n".join(
                f"{'>>>' if item['role'] == 'current' else '   '} {item['text']}"
                for item in context
            ),
            "position_score": details.get("position_score", 0),
            "pattern_frequency_score": details.get("pattern_frequency_score", 0),
            "prose_score": details.get("prose_score", 0),
            "prose_reasons": details.get("prose_reasons", []),
            "noise_score": details.get("noise_score", 0),
            "boundary_zone": details.get("boundary_zone", "middle"),
            "weak_reason": details.get("weak_reason", "rule_candidate"),
            "allowed_actions": ["keep", "drop", "trim"],
        }

    def _chapter_boundary_positions(self, lines: list[str]) -> dict[int, int]:
        """Score lines near chapter heads/tails.

        Noise from novel sites is highly concentrated around chapter boundaries:
        update notices, reader prompts, site ads, and end markers. The score is
        intentionally small and only makes already-suspicious lines more
        aggressive; it does not make clean prose suspicious by itself.
        """
        content_indices: list[int] = []
        result: dict[int, int] = {}

        def flush_segment() -> None:
            if not content_indices:
                return
            last = len(content_indices) - 1
            for offset, source_index in enumerate(content_indices):
                distance = min(offset, last - offset)
                if distance <= 1:
                    result[source_index] = 2
                elif distance <= 4:
                    result[source_index] = 1

        for source_index, raw_line in enumerate(lines):
            line = raw_line.strip()
            if not line:
                continue
            normalized = self.normalize_line(line)
            if self.parse_chapter_line(normalized):
                flush_segment()
                content_indices = []
                continue
            if self.parse_volume_line(normalized):
                continue
            content_indices.append(source_index)

        flush_segment()
        return result

    def _pattern_frequency_score(self, line: str, frequency_counts: dict[str, int]) -> int:
        count = frequency_counts.get(self._frequency_key(line), 0)
        if count >= 5:
            return 2
        if count >= 3:
            return 1
        return 0

    def _prose_score(self, line: str) -> tuple[int, list[str]]:
        """Cheap protection score for lines that look like novel prose.

        This is not a quality score. It only estimates false-drop risk.
        High-scoring prose is never strong-dropped by hard rules.
        """
        score = 0
        reasons: list[str] = []
        normalized = self.normalize_line(line)

        if re.search(r"[“”「」『』]", normalized) or re.search(
            r"(说|问|喊|笑|低声|冷冷|淡淡|喃喃|怒道|喝道)[：:]",
            normalized,
        ):
            score += 2
            reasons.append("dialogue")

        if re.search(
            r"(他|她|我|你|众人|少年|少女|男人|女人|老人|主角).{0,10}"
            r"(走|看|说|问|笑|推|拉|醒|逃|追|杀|退|转身|抬头|低头|伸手|皱眉)",
            normalized,
        ):
            score += 2
            reasons.append("character_action")

        if re.search(r"(想到|意识到|觉得|看见|听见|感到|察觉|明白|心中|脑海|瞳孔|呼吸)", normalized):
            score += 1
            reasons.append("mind_or_perception")

        if re.search(
            r"(门|窗|街|房间|天空|雨|风|血|剑|刀|阵法|灵气|城市|系统|任务|屏幕|火焰|黑暗|影子)",
            normalized,
        ):
            score += 1
            reasons.append("scene_or_object")

        chinese_chars = len(re.findall(r"[一-鿿]", normalized))
        punctuation = len(re.findall(r"[，。！？；：]", normalized))
        if chinese_chars >= 18 and punctuation >= 1:
            score += 1
            reasons.append("natural_sentence")
        elif chinese_chars >= 12 and punctuation >= 1 and re.search(r"(忽然|其实|所谓|仿佛|似乎|终于)", normalized):
            score += 1
            reasons.append("natural_sentence")

        return min(score, 6), reasons

    def _has_single_weak_signal(self, line: str) -> bool:
        if any(token in line for token in WEAK_NOISE_TOKENS):
            return True
        return any(pattern.search(line) for pattern in WEAK_NOISE_PATTERNS)

    def _classify_line(
        self,
        line: str,
        *,
        position_score: int = 0,
        pattern_frequency_score: int = 0,
    ) -> tuple[bool, bool]:
        is_strong, is_weak, _ = self._classify_line_details(
            line,
            position_score=position_score,
            pattern_frequency_score=pattern_frequency_score,
        )
        return (is_strong, is_weak)

    def _classify_line_details(
        self,
        line: str,
        *,
        position_score: int = 0,
        pattern_frequency_score: int = 0,
    ) -> tuple[bool, bool, dict[str, Any]]:
        """Classify a single line using rule, prose, position, and frequency signals.

        Returns:
            ``(is_strong_noise, is_weak_noise, details)`` tuple.
        """
        normalised = self.normalize_line(line)
        details: dict[str, Any] = {
            "position_score": position_score,
            "pattern_frequency_score": pattern_frequency_score,
            "prose_score": 0,
            "prose_reasons": [],
            "noise_score": 0,
            "boundary_zone": "edge" if position_score >= 2 else ("near_edge" if position_score else "middle"),
            "weak_reason": "",
        }

        if not normalised:
            return (False, False, details)

        # Chapter / volume headings are always clean
        if self.parse_chapter_line(normalised) or self.parse_volume_line(normalised):
            return (False, False, details)

        prose_score, prose_reasons = self._prose_score(normalised)
        details["prose_score"] = prose_score
        details["prose_reasons"] = prose_reasons

        # Very short lines are not noise (could be dialogue fragments)
        if len(normalised) <= 2:
            return (False, False, details)

        # Pure punctuation / symbol lines are strong noise
        if re.fullmatch(r"[0-9\-\.,，。:：_/\\|]+", normalised):
            if prose_score >= 4:
                self.cleaning_stats["protected_by_prose"] += 1
                details["weak_reason"] = "protected_punctuation"
                return (False, True, details)
            return (True, False, details)

        # Use the shared tiered classifier
        is_strong, is_weak = classify_noise_line(normalised)
        if is_strong and prose_score >= 2:
            details["weak_reason"] = "protected_mixed_noise_prose"
            self.cleaning_stats["protected_by_prose"] += 1
            return (False, True, details)
        if is_strong and prose_score >= 2 and re.match(r"^\s*(?:ps|PS)[:：]", normalised):
            details["weak_reason"] = "protected_ps_prose"
            self.cleaning_stats["protected_by_prose"] += 1
            return (False, True, details)
        if prose_score >= 4:
            if is_strong:
                self.cleaning_stats["protected_by_prose"] += 1
            if is_strong or is_weak:
                details["weak_reason"] = "protected_high_prose"
            return (False, bool(is_strong or is_weak), details)
        if is_strong:
            return (True, False, details)

        # Additional hardmodel-specific checks that may upgrade weak to strong
        chinese_chars = len(re.findall(r"[一-鿿]", normalised))
        alnum_chars = len(re.findall(r"[A-Za-z0-9]", normalised))
        symbol_chars = len(re.findall(r"[^一-鿿A-Za-z0-9\s]", normalised))
        total_chars = max(len(normalised), 1)

        symbol_ratio = symbol_chars / total_chars
        alnum_ratio = alnum_chars / total_chars

        # High symbol ratio on short lines is strong noise
        if len(normalised) < 50 and symbol_ratio > 0.35:
            return (True, False, details)
        # High alnum ratio with few Chinese chars is strong noise
        if len(normalised) < 50 and alnum_ratio > 0.6 and chinese_chars < 5:
            return (True, False, details)

        noise_score = 0
        if is_weak:
            noise_score += 2
        elif self._has_single_weak_signal(normalised) and position_score >= 1 and prose_score <= 3:
            is_weak = True
            noise_score += 1
            details["weak_reason"] = "single_boundary_weak_signal"
        noise_score += position_score
        noise_score += pattern_frequency_score
        details["noise_score"] = noise_score

        # The chapter boundary model is deliberately more aggressive only at
        # chapter heads/tails, where site boilerplate concentrates.
        if is_weak and position_score >= 2 and pattern_frequency_score >= 1 and prose_score <= 1:
            self.cleaning_stats["position_promoted"] += 1
            if pattern_frequency_score:
                self.cleaning_stats["frequency_promoted"] += 1
            return (True, False, details)

        if noise_score >= 3 and prose_score <= 3:
            if pattern_frequency_score:
                self.cleaning_stats["frequency_promoted"] += 1
            details["weak_reason"] = "scored_noise_candidate"
            return (False, True, details)

        if is_weak:
            details["weak_reason"] = "pattern_noise_candidate"
        return (is_strong, is_weak, details)

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
        cleaning_summary = self.build_cleaning_summary()
        return {
            "book_id": self.book_id,
            "content_type": self.content_type,
            "processing_profile": self.processing_profile,
            "source_path": str(self.source_path),
            "chapter_count": len(self.chapters),
            "volume_count": len(dict.fromkeys(volume_titles)),
            "total_chars": total_chars,
            "total_paragraphs": total_paragraphs,
            "avg_chapter_chars": round(total_chars / len(self.chapters), 2) if self.chapters else 0,
            "cleaning_stats": dict(self.cleaning_stats),
            "cleaning_summary": cleaning_summary,
            "chapter_anomalies": self.detect_chapter_anomalies(),
        }

    def build_cleaning_summary(self) -> dict[str, Any]:
        lines_seen = int(self.cleaning_stats.get("lines_seen") or 0)
        strong_dropped = int(self.cleaning_stats.get("strong_dropped") or 0)
        weak_dropped = int(self.cleaning_stats.get("weak_dropped") or 0)
        discarded_total = strong_dropped + weak_dropped
        weak_candidates = int(self.cleaning_stats.get("weak_candidates") or 0)
        return {
            "lines_seen": lines_seen,
            "discarded_lines": discarded_total,
            "strong_dropped": strong_dropped,
            "weak_candidates": weak_candidates,
            "weak_dropped": weak_dropped,
            "discard_rate": round(discarded_total / lines_seen, 4) if lines_seen else 0.0,
            "weak_candidate_rate": round(weak_candidates / lines_seen, 4) if lines_seen else 0.0,
            "typical_discarded_lines": self._dedupe_discarded_line_examples(limit=10),
            "trimmed_lines": int(self.cleaning_stats.get("trimmed_lines") or 0),
            "rule_trimmed": int(self.cleaning_stats.get("rule_trimmed") or 0),
            "llm_trimmed": int(self.cleaning_stats.get("llm_trimmed") or 0),
            "trim_rate": round(int(self.cleaning_stats.get("trimmed_lines") or 0) / lines_seen, 4) if lines_seen else 0.0,
            "typical_trimmed_lines": self._dedupe_trimmed_line_examples(limit=10),
        }

    def _dedupe_discarded_line_examples(self, *, limit: int = 10) -> list[dict[str, Any]]:
        seen: set[tuple[str, str]] = set()
        result: list[dict[str, Any]] = []
        for item in self.discarded_line_examples:
            key = (str(item.get("line") or ""), str(item.get("reason") or ""))
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
            if len(result) >= limit:
                break
        return result

    def _dedupe_trimmed_line_examples(self, *, limit: int = 10) -> list[dict[str, Any]]:
        seen: set[tuple[str, str]] = set()
        result: list[dict[str, Any]] = []
        for item in self.trimmed_line_examples:
            key = (str(item.get("original_line") or ""), str(item.get("cleaned_line") or ""))
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
            if len(result) >= limit:
                break
        return result

    def detect_chapter_anomalies(self) -> list[dict[str, object]]:
        """Detect suspicious chapter-level artifacts for downstream review."""
        if not self.chapters:
            return []
        anomalies: list[dict[str, object]] = []
        lengths = [chapter.char_count for chapter in self.chapters if chapter.char_count > 0]
        avg_chars = sum(lengths) / len(lengths) if lengths else 0
        expected_order = 1
        for chapter in self.chapters:
            reasons: list[str] = []
            if chapter.order != expected_order:
                reasons.append(f"non_contiguous_order_expected_{expected_order}")
                expected_order = chapter.order
            expected_order += 1
            if chapter.char_count == 0:
                reasons.append("empty_content")
            elif chapter.char_count < 80:
                reasons.append("very_short_content")
            elif avg_chars and chapter.char_count < avg_chars * 0.12:
                reasons.append("short_length_outlier")
            elif avg_chars and chapter.char_count > avg_chars * 4:
                reasons.append("long_length_outlier")
            if chapter.paragraph_count <= 1 and chapter.char_count > 300:
                reasons.append("single_paragraph_long_chapter")
            if reasons:
                anomalies.append(
                    {
                        "order": chapter.order,
                        "chapter_id": chapter.chapter_id,
                        "clean_title": chapter.clean_title,
                        "char_count": chapter.char_count,
                        "paragraph_count": chapter.paragraph_count,
                        "reasons": reasons,
                    }
                )
        return anomalies

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
