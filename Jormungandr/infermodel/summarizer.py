"""Plot-window analyser using an LLM API backend.

Replaces the previous local-model (Qwen) implementation.  Prompt
templates, fallback logic, and quality assessment are delegated to
their respective sub-modules so the class itself stays focused on
orchestration and API interaction.
"""

from __future__ import annotations

from typing import Any

from .api_client import ApiClient, ApiConfig
from .schemas import ChapterSynopsis, GlobalPlot, PlotWindow, WindowAnalysis
from .summarizer_prompts import (
    build_boundary_prompt,
    build_fusion_prompt,
    build_window_prompt,
    expected_segment_range,
)
from .summarizer_fallback import (
    fallback_boundary_assessment,
    fallback_plot_fusion,
    fallback_window_analysis,
)
from .quality import assess_summary_coverage

from shared import parse_json_payload


DEFAULT_API_MODEL = "mimo-v2.5-pro"
JSON_ONLY_SYSTEM_PROMPT = "你是中文小说情节结构分析器，只输出合法 JSON。不要输出思考过程、reasoning 或 thinking。"


class PlotWindowAnalyzer:
    """Analyses sliding windows of chapter summaries to extract plot segments.

    Uses a configurable LLM API backend (Anthropic-compatible) for
    segmentation, fusion, and boundary assessment, with deterministic
    fallbacks when API calls fail.
    """

    def __init__(
        self,
        config: ApiConfig | None = None,
        *,
        api_key: str | None = None,
        base_url: str = "https://token-plan-cn.xiaomimimo.com/anthropic",
        model_name: str = DEFAULT_API_MODEL,
        max_window_input_chars: int = 14000,
        max_fusion_input_chars: int = 7000,
        max_new_tokens: int = 6144,
    ) -> None:
        if config is not None:
            self._config = config
        else:
            self._config = ApiConfig(
                api_key=api_key or "",
                base_url=base_url,
                model_name=model_name,
                max_tokens=max_new_tokens,
            )
        self._api = ApiClient(self._config)
        self.max_window_input_chars = max(4000, int(max_window_input_chars))
        self.max_fusion_input_chars = max(3000, int(max_fusion_input_chars))
        self.max_new_tokens = max(512, int(max_new_tokens))

    # -- public API ------------------------------------------------------------

    def analyze_window(self, window: PlotWindow, *, mode: str = "initial") -> WindowAnalysis:
        try:
            prompt = self.build_window_prompt(window, mode=mode)
            generated_text = self._api.generate_json(
                system_prompt=JSON_ONLY_SYSTEM_PROMPT,
                user_prompt=prompt,
            )
            payload = parse_json_payload(generated_text)
            return self._normalize_window_payload(window, payload)
        except Exception as exc:
            return fallback_window_analysis(window, reason=f"{type(exc).__name__}: {exc}")

    def fuse_plot_summaries(
        self,
        plot: GlobalPlot,
        chapters: list[ChapterSynopsis],
        supporting_segments=None,
    ) -> dict[str, Any]:
        if not chapters:
            summary = f"第{plot.start_order}章到第{plot.end_order}章构成同一情节。"
            return self._fallback_plot_payload(summary, summary)

        try:
            prompt = self.build_fusion_prompt(plot, chapters)
            generated_text = self._api.generate_json(
                system_prompt=JSON_ONLY_SYSTEM_PROMPT,
                user_prompt=prompt,
            )
            payload = parse_json_payload(generated_text)
            summary = self._clean_text(payload.get("summary"))
            detailed_summary = self._clean_text(payload.get("detailed_summary"))
            if summary or detailed_summary:
                return self._normalize_plot_payload(payload, summary=summary, detailed_summary=detailed_summary or summary)
        except Exception:
            pass
        summary, detailed_summary = fallback_plot_fusion(plot, chapters)
        return self._fallback_plot_payload(summary, detailed_summary)

    def assess_boundary(
        self,
        left_chapters: list[ChapterSynopsis],
        right_chapters: list[ChapterSynopsis],
    ) -> dict[str, Any]:
        try:
            prompt = self.build_boundary_prompt(left_chapters, right_chapters)
            generated_text = self._api.generate_json(
                system_prompt=JSON_ONLY_SYSTEM_PROMPT,
                user_prompt=prompt,
            )
            payload = parse_json_payload(generated_text)
            return {
                "should_split": bool(payload.get("should_split")),
                "confidence": max(0.0, min(1.0, float(payload.get("confidence", 0.0) or 0.0))),
                "reason": self._clean_text(payload.get("reason")),
                "left_goal": self._clean_text(payload.get("left_goal")),
                "right_goal": self._clean_text(payload.get("right_goal")),
            }
        except Exception:
            return fallback_boundary_assessment(left_chapters, right_chapters)

    # -- prompt builders (delegate) --------------------------------------------

    def build_window_prompt(self, window: PlotWindow, *, mode: str = "initial") -> str:
        return build_window_prompt(
            window,
            max_window_input_chars=self.max_window_input_chars,
            mode=mode,
        )

    def build_fusion_prompt(self, plot: GlobalPlot, chapters: list[ChapterSynopsis]) -> str:
        return build_fusion_prompt(
            plot, chapters, max_fusion_input_chars=self.max_fusion_input_chars,
        )

    def build_boundary_prompt(
        self,
        left_chapters: list[ChapterSynopsis],
        right_chapters: list[ChapterSynopsis],
    ) -> str:
        return build_boundary_prompt(
            left_chapters, right_chapters,
            max_window_input_chars=self.max_window_input_chars,
        )

    @staticmethod
    def _expected_segment_range(chapter_count: int, *, mode: str = "initial") -> tuple[int, int]:
        return expected_segment_range(chapter_count, mode=mode)

    # -- quality assessment (delegate) -----------------------------------------

    @staticmethod
    def assess_summary_coverage(
        chapters: list[ChapterSynopsis],
        summary: str,
        detailed_summary: str,
    ) -> float:
        return assess_summary_coverage(chapters, summary, detailed_summary)

    # -- window payload normalisation ------------------------------------------

    def _normalize_window_payload(self, window: PlotWindow, payload: dict) -> WindowAnalysis:
        from .schemas import LocalPlotSegment
        from .summarizer_fallback import build_gap_segment, fallback_segment_text

        window_orders = list(window.chapter_orders)
        order_to_index = {order: index for index, order in enumerate(window_orders)}
        raw_segments = payload.get("segments")
        normalized_segments: list[LocalPlotSegment] = []

        if isinstance(raw_segments, list):
            for index, item in enumerate(raw_segments, start=1):
                segment = LocalPlotSegment.from_dict(
                    item, fallback_id=f"{window.window_id}_segment_{index:02d}"
                )
                start_order = max(window.start_order, segment.start_order or window.start_order)
                end_order = min(window.end_order, segment.end_order or window.end_order)
                if end_order < start_order:
                    continue
                segment_orders = [
                    order for order in window_orders if start_order <= order <= end_order
                ]
                if not segment_orders:
                    continue
                segment.start_order = segment_orders[0]
                segment.end_order = segment_orders[-1]
                segment.chapter_orders = segment_orders
                segment.source_window_ids = [window.window_id]
                if not segment.summary:
                    segment.summary = fallback_segment_text(
                        window, segment_orders, detailed=False
                    )
                if not segment.detailed_summary:
                    segment.detailed_summary = fallback_segment_text(
                        window, segment_orders, detailed=True
                    )
                normalized_segments.append(segment)

        if not normalized_segments:
            return fallback_window_analysis(window)

        normalized_segments.sort(
            key=lambda item: (item.start_order, item.end_order, item.local_segment_id)
        )
        repaired_segments: list[LocalPlotSegment] = []
        cursor = 0
        for segment in normalized_segments:
            start_index = order_to_index[segment.start_order]
            end_index = order_to_index[segment.end_order]
            if end_index < cursor:
                continue
            if start_index > cursor:
                gap_orders = window_orders[cursor:start_index]
                repaired_segments.append(
                    build_gap_segment(window, gap_orders, len(repaired_segments) + 1)
                )
            if start_index < cursor:
                start_index = cursor
            segment_orders = window_orders[start_index : end_index + 1]
            if not segment_orders:
                continue
            segment.start_order = segment_orders[0]
            segment.end_order = segment_orders[-1]
            segment.chapter_orders = segment_orders
            repaired_segments.append(segment)
            cursor = end_index + 1
        if cursor < len(window_orders):
            repaired_segments.append(
                build_gap_segment(window, window_orders[cursor:], len(repaired_segments) + 1)
            )

        uncertain_boundaries = self._normalize_uncertain_boundaries(
            payload.get("uncertain_boundaries"), window_orders
        )
        candidate_boundaries = self._normalize_candidate_boundaries(
            payload.get("candidate_boundaries"), window_orders
        )
        if not candidate_boundaries:
            candidate_boundaries = self._candidate_boundaries_from_segments(
                repaired_segments, window_orders
            )
        return WindowAnalysis(
            window_id=window.window_id,
            window_index=window.window_index,
            start_order=window.start_order,
            end_order=window.end_order,
            chapter_orders=window_orders,
            segments=repaired_segments,
            uncertain_boundaries=uncertain_boundaries,
            candidate_boundaries=candidate_boundaries,
            analysis_status="api",
            analysis_error="",
        )

    # -- boundary helpers ------------------------------------------------------

    def _normalize_uncertain_boundaries(
        self, raw_value: object, window_orders: list[int]
    ) -> list[dict]:
        if not isinstance(raw_value, list):
            return []
        valid_pairs = {(left, right) for left, right in zip(window_orders, window_orders[1:])}
        boundaries: list[dict] = []
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            left_order = self._as_int(item.get("left_order"))
            right_order = self._as_int(item.get("right_order"))
            if left_order is None or right_order is None:
                continue
            if (left_order, right_order) not in valid_pairs:
                continue
            boundaries.append({
                "left_order": left_order,
                "right_order": right_order,
                "reason": self._clean_text(item.get("reason")),
            })
        return boundaries

    def _normalize_candidate_boundaries(
        self, raw_value: object, window_orders: list[int]
    ) -> list[dict]:
        if not isinstance(raw_value, list):
            return []
        valid_left_orders = set(window_orders[:-1])
        valid_types = {
            "world_shift", "task_shift", "enemy_shift", "result_transition",
            "settlement_reset", "setting_shift", "same_action_continuation",
            "conversation_bridge", "other",
        }
        valid_strengths = {"hard", "strong", "weak", "forbid"}
        candidates: list[dict] = []
        seen: set[tuple[int, str, str]] = set()
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            boundary_after = self._as_int(item.get("boundary_after"))
            if boundary_after is None or boundary_after not in valid_left_orders:
                continue
            strength = self._clean_text(item.get("strength")).lower() or "weak"
            if strength not in valid_strengths:
                strength = "weak"
            boundary_type = self._clean_text(item.get("boundary_type")).lower() or "other"
            if boundary_type not in valid_types:
                boundary_type = "other"
            candidate = {
                "boundary_after": boundary_after,
                "boundary_before": boundary_after + 1,
                "strength": strength,
                "boundary_type": boundary_type,
                "should_split": (
                    False if strength == "forbid"
                    else bool(item.get("should_split", True))
                ),
                "left_goal": self._clean_text(item.get("left_goal")),
                "right_goal": self._clean_text(item.get("right_goal")),
                "reason": self._clean_text(item.get("reason")),
            }
            key = (candidate["boundary_after"], candidate["strength"], candidate["boundary_type"])
            if key in seen:
                continue
            seen.add(key)
            candidates.append(candidate)
        return candidates

    def _candidate_boundaries_from_segments(
        self, segments, window_orders: list[int]
    ) -> list[dict]:
        valid_left_orders = set(window_orders[:-1])
        candidates: list[dict] = []
        for index, segment in enumerate(segments[:-1]):
            boundary_after = segment.end_order
            if boundary_after not in valid_left_orders:
                continue
            next_segment = segments[index + 1]
            strength = "strong"
            if segment.uncertain_boundary_after or next_segment.uncertain_boundary_before:
                strength = "weak"
            candidates.append({
                "boundary_after": boundary_after,
                "boundary_before": boundary_after + 1,
                "strength": strength,
                "boundary_type": "other",
                "should_split": True,
                "left_goal": "",
                "right_goal": "",
                "reason": "derived_from_segment_boundary",
            })
        return candidates

    # -- backward-compatible properties ----------------------------------------

    @property
    def model_name(self) -> str:
        return self._config.model_name

    @property
    def resolved_model_source(self) -> str:
        return self._config.base_url

    # -- small utilities -------------------------------------------------------

    @staticmethod
    def _clean_text(value: object) -> str:
        return " ".join(str(value).strip().split())

    @staticmethod
    def _as_int(value: object) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def _normalize_plot_payload(self, payload: dict, *, summary: str, detailed_summary: str) -> dict[str, Any]:
        return {
            "summary": summary,
            "detailed_summary": detailed_summary,
            "plot_function": self._list_of_text(payload.get("plot_function")),
            "driving_force": self._list_of_text(payload.get("driving_force")),
            "key_events": self._list_of_dict(payload.get("key_events")),
            "characters_involved": self._list_of_dict(payload.get("characters_involved")),
            "relationship_changes": self._list_of_dict(payload.get("relationship_changes")),
            "conflict_model": self._mapping(payload.get("conflict_model")),
            "payoff_and_hook": self._mapping(payload.get("payoff_and_hook")),
            "setup_and_resolution": self._mapping(payload.get("setup_and_resolution")),
            "abstraction_hint": self._mapping(payload.get("abstraction_hint")),
        }

    def _fallback_plot_payload(self, summary: str, detailed_summary: str) -> dict[str, Any]:
        return {
            "summary": summary,
            "detailed_summary": detailed_summary or summary,
            "plot_function": [],
            "driving_force": [],
            "key_events": [],
            "characters_involved": [],
            "relationship_changes": [],
            "conflict_model": {},
            "payoff_and_hook": {},
            "setup_and_resolution": {},
            "abstraction_hint": {},
        }

    def _list_of_text(self, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        items: list[str] = []
        seen: set[str] = set()
        for item in value:
            text = self._clean_text(item)
            if not text or text in seen:
                continue
            seen.add(text)
            items.append(text)
        return items

    def _list_of_dict(self, value: object) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        items: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict):
                items.append(self._clean_mapping(item))
        return items

    def _mapping(self, value: object) -> dict[str, Any]:
        return self._clean_mapping(value) if isinstance(value, dict) else {}

    def _clean_mapping(self, value: dict) -> dict[str, Any]:
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_text = self._clean_text(key)
            if not key_text:
                continue
            cleaned[key_text] = self._clean_nested_value(item)
        return cleaned

    def _clean_nested_value(self, value: object) -> Any:
        if isinstance(value, str):
            return self._clean_text(value)
        if isinstance(value, list):
            cleaned_items: list[Any] = []
            for item in value:
                cleaned_item = self._clean_nested_value(item)
                if cleaned_item in ("", None) or cleaned_item == [] or cleaned_item == {}:
                    continue
                cleaned_items.append(cleaned_item)
            return cleaned_items
        if isinstance(value, dict):
            return self._clean_mapping(value)
        return value
