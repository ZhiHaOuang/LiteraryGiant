"""Streaming fingerprints for local whole-book TXT files.

The local corpus is much larger than the web fetcher's normal workload.  This
module therefore keeps the expensive, full-file pass deliberately simple:

* a byte SHA-256 protects provenance and detects files changed after scanning;
* a whitespace-insensitive Unicode SHA-256 catches encoding/newline variants;
* a small bottom-k sketch of sampled Chinese sentences finds near duplicates.

Title similarity is intentionally not part of the fingerprint.  Two books can
have the same title, and a single book can have several unrelated filenames.
Content evidence must decide duplication.
"""

from __future__ import annotations

import codecs
import hashlib
import heapq
import math
import os
import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

READ_CHUNK_BYTES = 1024 * 1024
FINGERPRINT_VERSION = 4
ENCODING_SAMPLE_BYTES = 64 * 1024
SKETCH_WINDOW_BYTES = 64 * 1024
SKETCH_WINDOW_FRACTIONS = (0.0, 0.18, 0.38, 0.62, 0.82, 1.0)

_SENTENCE_SPLIT_RE = re.compile(r"[。！？!?；;\n\r]+")
_SPACE_RE = re.compile(r"\s+")
_URL_RE = re.compile(r"(?:https?://|www\.|[a-z0-9-]+\.(?:com|cn|net|org))", re.I)
_NOISE_RE = re.compile(
    r"(?:版权归|本作品来自|下载.{0,8}小时|小说群|交流群|QQ群|qq\s*[:：]?\s*\d+|"
    r"网盘地址|手机用户请|最新网址|章节错误|求收藏|求推荐票|加入书签)",
    re.I,
)
_MOJIBAKE_RE = re.compile(r"(?:锟斤拷|烫烫烫|屯屯屯|�|Ã.|Â.|姝ｆ枃|绗\S|鍗\S)")


@dataclass(frozen=True, slots=True)
class EncodingDecision:
    """Auditable file-encoding choice rather than a bare codec name."""

    encoding: str
    confidence: str
    score: float
    margin: float
    candidates: tuple[tuple[str, float], ...]

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["candidates"] = [list(item) for item in self.candidates]
        return payload


@dataclass(frozen=True, slots=True)
class FileFingerprint:
    """Content identity and quality information for one source file."""

    raw_sha256: str
    normalized_sha256: str
    size_bytes: int
    non_whitespace_chars: int
    line_count: int
    replacement_chars: int
    encoding: str
    encoding_confidence: str
    encoding_score: float
    encoding_margin: float
    sketch: tuple[str, ...]
    ordered_sketch: tuple[str, ...]
    sampled_chars: int
    fingerprint_version: int

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["sketch"] = list(self.sketch)
        payload["ordered_sketch"] = list(self.ordered_sketch)
        return payload


@dataclass(frozen=True, slots=True)
class SimilarityEvidence:
    """Explainable comparison between two content fingerprints."""

    exact: bool
    sketch_jaccard: float
    sketch_containment: float
    length_ratio: float
    shared_anchors: int
    order_ratio: float

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _raw_sample_windows(path: Path, sample_bytes: int) -> list[bytes]:
    size = path.stat().st_size
    if size <= sample_bytes * 2:
        return [path.read_bytes()]
    starts = (0, max(0, size // 2 - sample_bytes // 2), max(0, size - sample_bytes))
    samples: list[bytes] = []
    with path.open("rb") as handle:
        for start in starts:
            handle.seek(start)
            samples.append(handle.read(sample_bytes))
    return samples


def _encoding_text_score(text: str) -> float:
    if not text:
        return -10.0
    total = len(text)
    cjk = sum("\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff" for ch in text)
    printable = sum(ch.isprintable() or ch in "\r\n\t" for ch in text)
    replacement = text.count("\ufffd")
    controls = sum(unicodedata.category(ch) == "Cc" and ch not in "\r\n\t" for ch in text)
    mojibake = len(_MOJIBAKE_RE.findall(text))
    return (
        (cjk / total) * 0.55
        + (printable / total) * 0.45
        - (replacement / total) * 8.0
        - (controls / total) * 5.0
        - min(0.5, mojibake / max(1, total) * 100.0)
    )


def _sample_is_utf8(sample: bytes) -> bool:
    """Validate a seeked UTF-8 sample while tolerating split edge codepoints."""

    if not sample:
        return True
    # A middle/tail sample may begin or end inside a 2-4 byte codepoint. Try a
    # bounded set of edge trims; invalid bytes in the body still fail.
    for leading_trim in range(4):
        for trailing_trim in range(4):
            end = len(sample) - trailing_trim if trailing_trim else len(sample)
            if leading_trim >= end:
                continue
            try:
                sample[leading_trim:end].decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                continue
            return True
    return False


def detect_file_encoding_decision(
    path: str | Path,
    *,
    sample_bytes: int = ENCODING_SAMPLE_BYTES,
) -> EncodingDecision:
    """Score stratified samples and retain the confidence/margin as evidence."""

    source = Path(path)
    samples = _raw_sample_windows(source, sample_bytes)
    prefix = samples[0]
    if prefix.startswith(codecs.BOM_UTF8):
        return EncodingDecision("utf-8-sig", "high", 1.0, 1.0, (("utf-8-sig", 1.0),))
    if prefix.startswith(codecs.BOM_UTF32_LE):
        return EncodingDecision("utf-32-le", "high", 1.0, 1.0, (("utf-32-le", 1.0),))
    if prefix.startswith(codecs.BOM_UTF32_BE):
        return EncodingDecision("utf-32-be", "high", 1.0, 1.0, (("utf-32-be", 1.0),))
    if prefix.startswith(codecs.BOM_UTF16_LE):
        return EncodingDecision("utf-16-le", "high", 1.0, 1.0, (("utf-16-le", 1.0),))
    if prefix.startswith(codecs.BOM_UTF16_BE):
        return EncodingDecision("utf-16-be", "high", 1.0, 1.0, (("utf-16-be", 1.0),))

    if all(_sample_is_utf8(sample) for sample in samples):
        return EncodingDecision("utf-8", "high", 1.0, 1.0, (("utf-8", 1.0),))

    nul_ratio = sum(sample.count(b"\x00") for sample in samples) / max(
        1, sum(len(sample) for sample in samples)
    )
    candidate_names: tuple[str, ...]
    if nul_ratio >= 0.08:
        candidate_names = ("utf-16-le", "utf-16-be", "gb18030", "big5")
    else:
        candidate_names = ("gb18030", "big5")
    scores: list[tuple[str, float]] = []
    for encoding in candidate_names:
        decoded: list[str] = []
        for sample in samples:
            # Seeked samples can start in the middle of a codepoint; a handful
            # of boundary replacements should not dominate the score.
            decoded.append(sample.decode(encoding, errors="replace"))
        score = sum(_encoding_text_score(text) for text in decoded) / len(decoded)
        scores.append((encoding, score))
    scores.sort(key=lambda item: item[1], reverse=True)
    best_encoding, best_score = scores[0]
    margin = best_score - scores[1][1] if len(scores) > 1 else 1.0
    confidence = "high" if margin >= 0.05 else "low" if margin >= 0.02 else "ambiguous"

    return EncodingDecision(
        encoding=best_encoding,
        confidence=confidence,
        score=round(best_score, 6),
        margin=round(margin, 6),
        candidates=tuple((name, round(score, 6)) for name, score in scores),
    )


def detect_file_encoding(path: str | Path, *, sample_bytes: int = ENCODING_SAMPLE_BYTES) -> str:
    """Compatibility wrapper returning only the selected codec name."""

    return detect_file_encoding_decision(path, sample_bytes=sample_bytes).encoding


def iter_decoded_chunks(
    path: str | Path,
    encoding: str,
    *,
    chunk_bytes: int = READ_CHUNK_BYTES,
) -> Iterator[str]:
    """Decode a file incrementally without splitting multibyte characters."""

    decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    with Path(path).open("rb") as handle:
        while True:
            raw = handle.read(chunk_bytes)
            if not raw:
                break
            text = decoder.decode(raw, final=False)
            if text:
                yield text
        tail = decoder.decode(b"", final=True)
        if tail:
            yield tail


def _logical_text(text: str) -> str:
    """Normalize representational differences, retaining actual punctuation."""

    text = unicodedata.normalize("NFKC", text).replace("\ufeff", "").replace("\x00", "")
    # Formatting-only differences should not prevent exact logical matching.
    return _SPACE_RE.sub("", text)


def _decode_window(raw: bytes, encoding: str) -> str:
    """Decode a seeked byte window; broken boundary bytes are safely ignored."""

    if encoding.startswith("utf-16") and len(raw) % 2:
        raw = raw[:-1]
    if encoding.startswith("utf-32"):
        raw = raw[: len(raw) - (len(raw) % 4)]
    try:
        return raw.decode(encoding, errors="ignore")
    except (LookupError, UnicodeError):
        return raw.decode("utf-8", errors="ignore")


def read_sample_windows(
    path: str | Path,
    encoding: str,
    *,
    window_bytes: int = SKETCH_WINDOW_BYTES,
    fractions: Sequence[float] = SKETCH_WINDOW_FRACTIONS,
) -> list[str]:
    """Read bounded windows spread over a file for metadata and near-dedup."""

    source = Path(path)
    size = source.stat().st_size
    if size <= window_bytes * 2:
        return [_decode_window(source.read_bytes(), encoding)]

    starts: set[int] = set()
    max_start = max(0, size - window_bytes)
    for fraction in fractions:
        fraction = min(1.0, max(0.0, float(fraction)))
        start = int(max_start * fraction)
        if encoding.startswith("utf-16"):
            start -= start % 2
        elif encoding.startswith("utf-32"):
            start -= start % 4
        starts.add(start)

    windows: list[str] = []
    with source.open("rb") as handle:
        for start in sorted(starts):
            handle.seek(start)
            windows.append(_decode_window(handle.read(window_bytes), encoding))
    return windows


def read_head_text(
    path: str | Path,
    encoding: str | None = None,
    *,
    max_bytes: int = ENCODING_SAMPLE_BYTES,
) -> str:
    """Read a bounded decoded prefix for title/author extraction."""

    source = Path(path)
    resolved_encoding = encoding or detect_file_encoding(source)
    with source.open("rb") as handle:
        return _decode_window(handle.read(max_bytes), resolved_encoding)


def _sentence_features(windows: Iterable[str]) -> tuple[list[int], int]:
    """Return robust sentence hashes from sampled text windows."""

    features: list[int] = []
    sampled_chars = 0
    for window in windows:
        normalized = unicodedata.normalize("NFKC", window).replace("\ufeff", "")
        sampled_chars += len(normalized)
        for sentence in _SENTENCE_SPLIT_RE.split(normalized):
            sentence = _SPACE_RE.sub("", sentence).strip("-_=*~·—…|【】[]()（）《》<>『』「」")
            if len(sentence) < 18 or _URL_RE.search(sentence) or _NOISE_RE.search(sentence):
                continue
            # Extremely long lines are usually missing punctuation.  Stable
            # overlapping blocks still provide anchors when line wrapping differs.
            blocks: Iterable[str]
            if len(sentence) > 320:
                blocks = (sentence[i : i + 160] for i in range(0, len(sentence) - 79, 80))
            else:
                blocks = (sentence,)
            for block in blocks:
                digest = hashlib.blake2b(block.encode("utf-8"), digest_size=8).digest()
                features.append(int.from_bytes(digest, "big"))
    return features, sampled_chars


def _bottom_k(values: Iterable[int], k: int) -> tuple[str, ...]:
    """Keep the k smallest unique 64-bit values with bounded memory."""

    if k <= 0:
        return ()
    heap: list[int] = []  # negative values make this a max-heap
    selected: set[int] = set()
    for value in values:
        if value in selected:
            continue
        if len(heap) < k:
            heapq.heappush(heap, -value)
            selected.add(value)
            continue
        largest = -heap[0]
        if value >= largest:
            continue
        removed = -heapq.heapreplace(heap, -value)
        selected.remove(removed)
        selected.add(value)
    return tuple(f"{value:016x}" for value in sorted(selected))


def _ordered_subset(values: Iterable[int], selected: Sequence[str]) -> tuple[str, ...]:
    selected_set = set(selected)
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        encoded = f"{value:016x}"
        if encoded in selected_set and encoded not in seen:
            seen.add(encoded)
            ordered.append(encoded)
    return tuple(ordered)


class _StreamingSentenceSketch:
    """Constant-memory, position-independent sentence bottom-k sketch."""

    def __init__(self, size: int) -> None:
        self.size = max(0, int(size))
        self.heap: list[int] = []
        self.selected: set[int] = set()
        self.positions: dict[int, int] = {}
        self.feature_position = 0
        self.previous_block_hash: bytes | None = None
        self.pending = ""
        self.long_sentence = False
        self.sampled_chars = 0

    def _add_block(self, block: str) -> None:
        block = _SPACE_RE.sub("", block).strip("-_=*~·—…|【】[]()（）《》<>『』「」")
        if len(block) < 18 or _URL_RE.search(block) or _NOISE_RE.search(block):
            self.previous_block_hash = None
            return
        block_hash = hashlib.blake2b(block.encode("utf-8"), digest_size=8).digest()
        if self.previous_block_hash is None:
            self.previous_block_hash = block_hash
            return
        # Adjacent-sentence shingles avoid false order inversions from generic
        # repeated phrases (for example the same chapter-closing sentence in
        # an inserted preface and in the main body).
        digest = hashlib.blake2b(
            self.previous_block_hash + block_hash, digest_size=8
        ).digest()
        self.previous_block_hash = block_hash
        value = int.from_bytes(digest, "big")
        position = self.feature_position
        self.feature_position += 1
        if self.size <= 0 or value in self.selected:
            return
        if len(self.heap) < self.size:
            heapq.heappush(self.heap, -value)
            self.selected.add(value)
            self.positions[value] = position
            return
        largest = -self.heap[0]
        if value >= largest:
            return
        removed = -heapq.heapreplace(self.heap, -value)
        self.selected.remove(removed)
        self.positions.pop(removed, None)
        self.selected.add(value)
        self.positions[value] = position

    def _finish_sentence(self) -> None:
        sentence = _SPACE_RE.sub("", self.pending).strip(
            "-_=*~·—…|【】[]()（）《》<>『』「」"
        )
        if self.long_sentence:
            for start in range(0, len(sentence) - 79, 80):
                self._add_block(sentence[start : start + 160])
        elif len(sentence) > 320:
            for start in range(0, len(sentence) - 79, 80):
                self._add_block(sentence[start : start + 160])
        else:
            self._add_block(sentence)
        self.pending = ""
        self.long_sentence = False

    def _drain_long_sentence(self) -> None:
        if len(self.pending) <= 8192:
            return
        self.pending = _SPACE_RE.sub("", self.pending)
        self.long_sentence = True
        # A 160-character block with 80-character overlap is final once at
        # least another 80 characters follow it.  Retain the short tail for
        # the next decoded chunk so chunk boundaries cannot alter features.
        while len(self.pending) >= 240:
            self._add_block(self.pending[:160])
            self.pending = self.pending[80:]

    def feed_normalized(self, text: str) -> None:
        self.sampled_chars += len(text)
        parts = _SENTENCE_SPLIT_RE.split(text)
        for index, part in enumerate(parts):
            self.pending += part
            if index < len(parts) - 1:
                self._finish_sentence()
            else:
                self._drain_long_sentence()

    def finish(self) -> tuple[tuple[str, ...], tuple[str, ...], int]:
        if self.pending:
            self._finish_sentence()
        sketch = tuple(f"{value:016x}" for value in sorted(self.selected))
        ordered = tuple(
            f"{value:016x}"
            for value in sorted(self.selected, key=lambda item: self.positions[item])
        )
        return sketch, ordered, self.sampled_chars


def fingerprint_file(path: str | Path, *, sketch_size: int = 96) -> FileFingerprint:
    """Fingerprint one TXT in one full streaming pass plus bounded samples."""

    source = Path(path)
    stat = source.stat()
    encoding_decision = detect_file_encoding_decision(source)
    encoding = encoding_decision.encoding
    raw_hash = hashlib.sha256()
    logical_hash = hashlib.sha256()
    sketch_builder = _StreamingSentenceSketch(sketch_size)
    non_whitespace_chars = 0
    replacement_chars = 0
    line_count = 0
    saw_text = False
    ended_with_newline = False

    def consume(text: str) -> None:
        nonlocal non_whitespace_chars, replacement_chars, line_count
        nonlocal saw_text, ended_with_newline
        saw_text = saw_text or bool(text)
        replacement_chars += text.count("\ufffd")
        line_count += text.count("\n")
        ended_with_newline = text.endswith("\n")
        normalized = unicodedata.normalize("NFKC", text).replace("\ufeff", "").replace("\x00", "")
        sketch_builder.feed_normalized(normalized)
        logical = _SPACE_RE.sub("", normalized)
        non_whitespace_chars += len(logical)
        logical_hash.update(logical.encode("utf-8"))

    decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    with source.open("rb") as handle:
        while True:
            chunk = handle.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            raw_hash.update(chunk)
            decoded = decoder.decode(chunk, final=False)
            if decoded:
                consume(decoded)
        tail = decoder.decode(b"", final=True)
        if tail:
            consume(tail)
    if saw_text and not ended_with_newline:
        line_count += 1

    sketch, ordered_sketch, sampled_chars = sketch_builder.finish()
    return FileFingerprint(
        raw_sha256=raw_hash.hexdigest(),
        normalized_sha256=logical_hash.hexdigest(),
        size_bytes=stat.st_size,
        non_whitespace_chars=non_whitespace_chars,
        line_count=line_count,
        replacement_chars=replacement_chars,
        encoding=encoding,
        encoding_confidence=encoding_decision.confidence,
        encoding_score=encoding_decision.score,
        encoding_margin=encoding_decision.margin,
        sketch=sketch,
        ordered_sketch=ordered_sketch,
        sampled_chars=sampled_chars,
        fingerprint_version=FINGERPRINT_VERSION,
    )


def _order_ratio(left: Sequence[str], right: Sequence[str]) -> float:
    """Measure whether shared unique anchors occur in the same order."""

    right_positions = {value: index for index, value in enumerate(right)}
    sequence = [right_positions[value] for value in left if value in right_positions]
    if not sequence:
        return 0.0
    # Patience-sort LIS length, O(n log n) for at most ~96 anchors.
    import bisect

    tails: list[int] = []
    for value in sequence:
        index = bisect.bisect_left(tails, value)
        if index == len(tails):
            tails.append(value)
        else:
            tails[index] = value
    return len(tails) / len(sequence)


def compare_fingerprints(left: FileFingerprint, right: FileFingerprint) -> SimilarityEvidence:
    """Compare fingerprints without using filenames or titles."""

    exact = left.normalized_sha256 == right.normalized_sha256
    left_values = {int(value, 16) for value in left.sketch}
    right_values = {int(value, 16) for value in right.sketch}
    # KMV/bottom-k sketches have different kth thresholds when one edition
    # contains substantially more text.  Compare only at the common (lower)
    # threshold; direct set containment would incorrectly score a true subset
    # near its length ratio instead of near 1.0.
    if left_values and right_values:
        common_threshold = min(max(left_values), max(right_values))
        left_sketch = {value for value in left_values if value <= common_threshold}
        right_sketch = {value for value in right_values if value <= common_threshold}
    else:
        left_sketch = left_values
        right_sketch = right_values
    shared = len(left_sketch & right_sketch)
    union = len(left_sketch | right_sketch)
    smaller = min(len(left_sketch), len(right_sketch))
    larger_length = max(left.non_whitespace_chars, right.non_whitespace_chars)
    length_ratio = (
        min(left.non_whitespace_chars, right.non_whitespace_chars) / larger_length
        if larger_length
        else 1.0
    )
    return SimilarityEvidence(
        exact=exact,
        sketch_jaccard=(shared / union if union else (1.0 if exact else 0.0)),
        sketch_containment=(shared / smaller if smaller else (1.0 if exact else 0.0)),
        length_ratio=length_ratio,
        shared_anchors=shared,
        order_ratio=_order_ratio(left.ordered_sketch, right.ordered_sketch),
    )


def size_ratio(left_size: int, right_size: int) -> float:
    """Safe helper used by candidate blocking."""

    largest = max(int(left_size), int(right_size))
    return min(int(left_size), int(right_size)) / largest if largest else 1.0


def logarithmic_size_bucket(size: int, *, steps_per_octave: int = 8) -> int:
    """Bucket sizes so adjacent versions of a book remain near each other."""

    if size <= 0:
        return 0
    return int(math.log2(size) * steps_per_octave)


def file_identity_unchanged(path: str | Path, expected_raw_sha256: str) -> bool:
    """Verify a source immediately before a destructive transfer."""

    digest = hashlib.sha256()
    try:
        with Path(path).open("rb") as handle:
            while True:
                chunk = handle.read(READ_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
    except FileNotFoundError:
        return False
    return digest.hexdigest() == expected_raw_sha256


def stable_source_id(path: str | Path, raw_sha256: str) -> str:
    """Return an ID unique to both bytes and original location."""

    resolved = os.fsencode(str(Path(path).resolve()))
    path_hash = hashlib.blake2s(resolved, digest_size=4).hexdigest()
    return f"src_{raw_sha256[:12]}_{path_hash}"
