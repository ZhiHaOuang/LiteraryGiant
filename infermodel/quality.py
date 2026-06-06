"""Quality-assessment helpers for plot-summary outputs.

Provides functions that estimate the coverage and quality of a generated
plot summary relative to its source chapters, using n-gram overlap and
length heuristics.
"""

from __future__ import annotations

import re

from .schemas import ChapterSynopsis


def assess_summary_coverage(
    chapters: list[ChapterSynopsis],
    summary: str,
    detailed_summary: str,
) -> float:
    """Return a 0–1 score estimating how well *summary* + *detailed_summary*
    cover the content of *chapters*."""
    if not chapters:
        return 0.0

    output_ngrams = _extract_signal_ngrams(" ".join(filter(None, [summary, detailed_summary])))
    if not output_ngrams:
        return 0.0

    covered = 0
    for chapter in chapters:
        chapter_ngrams = _extract_signal_ngrams(
            " ".join(filter(None, [chapter.title, chapter.summary, chapter.detailed_summary]))
        )
        if not chapter_ngrams:
            continue
        overlap = len(chapter_ngrams & output_ngrams)
        overlap_ratio = overlap / max(len(chapter_ngrams), 1)
        if overlap >= 3 or overlap_ratio >= 0.08:
            covered += 1

    coverage_ratio = covered / max(len(chapters), 1)
    summary_len_score = min(len(summary) / 80.0, 1.0) if summary else 0.0
    detailed_len_score = min(len(detailed_summary) / 220.0, 1.0) if detailed_summary else 0.0
    score = 0.6 * coverage_ratio + 0.15 * summary_len_score + 0.25 * detailed_len_score
    return round(max(0.0, min(1.0, score)), 6)


def _extract_signal_ngrams(text: str) -> set[str]:
    """Extract character n-grams and word tokens from *text*."""
    normalized = re.sub(r"\s+", "", text or "")
    normalized = re.sub(r"[^\w一-鿿]+", "", normalized)
    ngrams: set[str] = set()
    for size in (2, 3, 4):
        for index in range(0, max(len(normalized) - size + 1, 0)):
            piece = normalized[index:index + size]
            if piece:
                ngrams.add(piece)
    for part in re.split(r"[^\w一-鿿]+", text or ""):
        part = part.strip()
        if len(part) >= 2:
            ngrams.add(part)
    return ngrams
