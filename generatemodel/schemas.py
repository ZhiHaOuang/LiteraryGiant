from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from shared import _as_clean_text as _as_text, _as_list, _as_dict


@dataclass(slots=True)
class SeedChapter:
    chapter_id: str = ""
    order: int = 0
    title: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SeedPlot:
    plot_id: str = ""
    plot_index: int = 0
    summary: str = ""
    detailed_summary: str = ""
    chapter_ids: list[str] = field(default_factory=list)
    chapter_titles: list[str] = field(default_factory=list)
    chapter_summaries: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    chapters: list[SeedChapter] = field(default_factory=list)

    @classmethod
    def from_bundle(cls, plot_payload: dict[str, Any], chapter_payloads: list[dict[str, Any]]) -> "SeedPlot":
        chapter_objects: list[SeedChapter] = []
        for chapter_payload in chapter_payloads:
            chapter_context = _as_dict(chapter_payload.get("chapter_context"))
            chapter_objects.append(
                SeedChapter(
                    chapter_id=_as_text(chapter_context.get("chapter_id")),
                    order=int(chapter_context.get("order") or 0),
                    title=_as_text(chapter_context.get("clean_title") or chapter_context.get("raw_title")),
                    payload=chapter_payload,
                )
            )
        return cls(
            plot_id=_as_text(plot_payload.get("plot_id")),
            plot_index=int(plot_payload.get("plot_index") or 0),
            summary=_as_text(plot_payload.get("summary")),
            detailed_summary=_as_text(plot_payload.get("detailed_summary")),
            chapter_ids=_as_list(plot_payload.get("chapter_ids")),
            chapter_titles=_as_list(plot_payload.get("chapter_titles")),
            chapter_summaries=list(plot_payload.get("chapter_summaries") or []),
            payload=plot_payload,
            chapters=chapter_objects,
        )


@dataclass(slots=True)
class CritiqueIssue:
    severity: str = "medium"
    category: str = "other"
    message: str = ""
    suggestion: str = ""

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CritiqueIssue":
        payload = _as_dict(payload)
        severity = _as_text(payload.get("severity")).lower() or "medium"
        if severity not in {"low", "medium", "high"}:
            severity = "medium"
        return cls(
            severity=severity,
            category=_as_text(payload.get("category")).lower() or "other",
            message=_as_text(payload.get("message")),
            suggestion=_as_text(payload.get("suggestion")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class GenerationCritique:
    approved: bool = False
    score: float = 0.0
    summary: str = ""
    revision_focus: list[str] = field(default_factory=list)
    issues: list[CritiqueIssue] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "GenerationCritique":
        payload = _as_dict(payload)
        raw_issues = payload.get("issues")
        issues: list[CritiqueIssue] = []
        if isinstance(raw_issues, list):
            issues = [CritiqueIssue.from_dict(item) for item in raw_issues if isinstance(item, dict)]
        score = payload.get("score")
        try:
            numeric_score = float(score)
        except (TypeError, ValueError):
            numeric_score = 0.0
        numeric_score = max(0.0, min(1.0, numeric_score))
        return cls(
            approved=bool(payload.get("approved")),
            score=numeric_score,
            summary=_as_text(payload.get("summary")),
            revision_focus=_as_list(payload.get("revision_focus")),
            issues=issues,
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["issues"] = [issue.to_dict() for issue in self.issues]
        return payload
