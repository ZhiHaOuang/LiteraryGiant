"""Fallback analysis functions used when LLM inference fails.

These provide deterministic (rule-based) substitutes for the
:class:`~infermodel.summarizer.PlotWindowAnalyzer` methods so the
pipeline can continue even when the local model is unavailable.
"""

from __future__ import annotations

from typing import Any

from .schemas import ChapterSynopsis, GlobalPlot, LocalPlotSegment, PlotWindow, WindowAnalysis


def fallback_window_analysis(window: PlotWindow) -> WindowAnalysis:
    """Build a single-segment analysis for *window* using chapter summaries."""
    summary_parts = [chapter.summary for chapter in window.chapters if chapter.summary]
    detail_parts = [chapter.detailed_summary for chapter in window.chapters if chapter.detailed_summary]
    segment = LocalPlotSegment(
        local_segment_id=f"{window.window_id}_segment_01",
        start_order=window.start_order,
        end_order=window.end_order,
        chapter_orders=list(window.chapter_orders),
        summary=" ".join(summary_parts[:3]).strip(),
        detailed_summary=" ".join(detail_parts[:2]).strip(),
        source_window_ids=[window.window_id],
    )
    return WindowAnalysis(
        window_id=window.window_id,
        window_index=window.window_index,
        start_order=window.start_order,
        end_order=window.end_order,
        chapter_orders=list(window.chapter_orders),
        segments=[segment],
        uncertain_boundaries=[],
        candidate_boundaries=[],
    )


def fallback_plot_fusion(
    plot: GlobalPlot,
    chapters: list[ChapterSynopsis],
) -> tuple[str, str]:
    """Build a fallback plot summary from chapter summaries when fusion fails."""
    summary_texts = _unique_texts([chapter.summary for chapter in chapters])[:3]
    detailed_texts = _unique_texts([chapter.detailed_summary for chapter in chapters])[:4]
    return " ".join(summary_texts).strip(), " ".join(detailed_texts or summary_texts).strip()


def fallback_boundary_assessment(
    left_chapters: list[ChapterSynopsis],
    right_chapters: list[ChapterSynopsis],
) -> dict[str, Any]:
    """Heuristic boundary assessment based on token overlap."""
    left_tokens = _extract_signal_tokens(left_chapters)
    right_tokens = _extract_signal_tokens(right_chapters)
    overlap = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens) or 1
    overlap_ratio = overlap / union
    should_split = overlap_ratio < 0.22
    confidence = max(0.2, min(0.85, 1.0 - overlap_ratio))
    return {
        "should_split": should_split,
        "confidence": round(confidence, 6),
        "reason": "fallback_overlap_check",
        "left_goal": "",
        "right_goal": "",
    }


def fallback_segment_text(
    window: PlotWindow,
    chapter_orders: list[int],
    *,
    detailed: bool = False,
) -> str:
    """Return concatenated chapter summaries covering *chapter_orders*."""
    order_set = set(chapter_orders)
    chapters = [chapter for chapter in window.chapters if chapter.order in order_set]
    texts = [chapter.detailed_summary if detailed else chapter.summary for chapter in chapters]
    texts = [text for text in texts if text]
    return " ".join(texts[:3]).strip()


def build_gap_segment(
    window: PlotWindow,
    gap_orders: list[int],
    segment_index: int,
) -> LocalPlotSegment:
    """Build a :class:`LocalPlotSegment` covering chapters that the LLM missed."""
    return LocalPlotSegment(
        local_segment_id=f"{window.window_id}_segment_gap_{segment_index:02d}",
        start_order=gap_orders[0],
        end_order=gap_orders[-1],
        chapter_orders=gap_orders,
        summary=fallback_segment_text(window, gap_orders, detailed=False),
        detailed_summary=fallback_segment_text(window, gap_orders, detailed=True),
        source_window_ids=[window.window_id],
    )


# -- internal helpers -----------------------------------------------------------


def _extract_signal_tokens(chapters: list[ChapterSynopsis]) -> set[str]:
    """Extract meaningful word tokens from chapter metadata."""
    tokens: set[str] = set()
    for chapter in chapters:
        text = " ".join(filter(None, [chapter.title, chapter.summary, chapter.detailed_summary]))
        import re
        normalized = re.sub(r"[^\w一-鿿]+", " ", text)
        for part in normalized.split():
            part = part.strip()
            if len(part) >= 2:
                tokens.add(part)
    return tokens


def _unique_texts(items: list[str]) -> list[str]:
    """Deduplicate *items* while preserving order."""
    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = " ".join(str(item).strip().split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped
