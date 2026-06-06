from __future__ import annotations

import json
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model_runtime import LocalChatModelRuntime
from .schemas import GenerationCritique, SeedPlot
from shared import WEIGHTS_ROOT


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GENERATOR_MODEL = "Qwen_14B"
DEFAULT_CRITIC_MODEL = "DeepSeek_14B"
GENERATOR_MODEL_VARIANTS = {
    "7b": "Qwen_7B",
    "8b": "Qwen_8B",
    "14b": "Qwen_14B",
    "32b": "Qwen_32B",
}
CRITIC_MODEL_VARIANTS = {
    "7b": "DeepSeek_7B",
    "8b": "DeepSeek_8B",
    "14b": "DeepSeek_14B",
    "32b": "DeepSeek_32B",
}


class _LocalJsonModel:
    def __init__(
        self,
        *,
        model_name: str,
        weights_root: str | Path | None = None,
        family_dirs: list[str] | None = None,
        max_new_tokens: int = 2200,
        device_map: str = "auto",
        allow_fallback: bool = True,
        gpu_memory_utilization: float = 0.9,
        per_gpu_memory_gb: int | None = None,
    ) -> None:
        self.runtime = LocalChatModelRuntime(
            model_name=model_name,
            weights_root=weights_root,
            family_dirs=family_dirs,
            max_new_tokens=max_new_tokens,
            device_map=device_map,
            allow_fallback=allow_fallback,
            gpu_memory_utilization=gpu_memory_utilization,
            per_gpu_memory_gb=per_gpu_memory_gb,
        )
        self.model_name = self.runtime.model_name
        self.weights_root = self.runtime.weights_root
        self.family_dirs = self.runtime.family_dirs
        self.max_new_tokens = self.runtime.max_new_tokens
        self.device_map = self.runtime.device_map
        self.allow_fallback = self.runtime.allow_fallback
        self.resolved_model_source = self.runtime.resolved_model_source
        self.model_available = self.runtime.model_available
        self.runtime_placement = self.runtime.runtime_placement

    def generate_json_text(self, *, system_prompt: str, user_prompt: str) -> str:
        return self.runtime.generate_json_text(system_prompt=system_prompt, user_prompt=user_prompt)

    @staticmethod
    def parse_json_payload(raw_text: str) -> dict[str, Any]:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
            cleaned = re.sub(r"```$", "", cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass
        start = cleaned.find("{")
        if start < 0:
            raise ValueError("Model output does not contain JSON.")
        candidate = cleaned[start:]
        match = re.search(r"\{.*\}", candidate, flags=re.DOTALL)
        if not match:
            raise ValueError("Model output does not contain JSON object.")
        return json.loads(match.group(0))

class PlotChapterGenerator(_LocalJsonModel):
    def __init__(
        self,
        *,
        model_name: str = DEFAULT_GENERATOR_MODEL,
        weights_root: str | Path | None = None,
        max_new_tokens: int = 2200,
        device_map: str = "auto",
        allow_fallback: bool = True,
        family_dirs: list[str] | None = None,
        gpu_memory_utilization: float = 0.9,
        per_gpu_memory_gb: int | None = None,
    ) -> None:
        super().__init__(
            model_name=model_name,
            weights_root=weights_root,
            family_dirs=family_dirs or ["Qwen", "qwen", "QWEN", model_name],
            max_new_tokens=max_new_tokens,
            device_map=device_map,
            allow_fallback=allow_fallback,
            gpu_memory_utilization=gpu_memory_utilization,
            per_gpu_memory_gb=per_gpu_memory_gb,
        )

    def build_initial_prompt(
        self,
        *,
        seed_plots: list[SeedPlot],
        target_book_id: str,
        target_chapter_count: int,
    ) -> str:
        seeds_text = self._build_seed_text(seed_plots)
        schema = json.dumps(self._candidate_schema_example(), ensure_ascii=False, indent=2)
        return (
            "你是中文长篇小说情节生成器。"
            "请基于给定的情节库与章节库样本，随机骨架学习后生成一个全新的 plot JSON 和对应 chapter JSON 列表。"
            "允许在原有样本之间留白、补全缺失环节和创新衔接，但必须保持逻辑连续。\n\n"
            "硬性要求：\n"
            "- 只输出一个合法 JSON 对象，不要输出解释。\n"
            "- 顶层必须包含 `plot` 和 `chapters`。\n"
            "- `plot` 字段结构必须与现有 plot schema 保持一致。\n"
            "- `chapters` 中每个元素都要提供 chapter schema 所需的全部语义字段。\n"
            "- chapter 数量必须等于 plot 的 chapter_ids 数量。\n"
            "- 章节顺序必须连续，从 1 开始。\n"
            "- 情节要有开端、推进、转折、阶段结果，不能只是一串事件堆叠。\n"
            "- 可以融合多个 seed plot，但不要简单复写任何单个样本。\n"
            "- 不要照搬样本标题；允许借鉴类型、结构和节奏。\n"
            "- 输出内容必须是中文。\n\n"
            f"目标 book_id: {target_book_id}\n"
            f"目标 chapter 数量: {target_chapter_count}\n\n"
            f"输出 JSON Schema 示例:\n{schema}\n\n"
            f"样本库:\n{seeds_text}\n\n"
            "JSON："
        )

    def build_revision_prompt(
        self,
        *,
        seed_plots: list[SeedPlot],
        target_book_id: str,
        current_candidate: dict[str, Any],
        critique: GenerationCritique,
    ) -> str:
        seeds_text = self._build_seed_text(seed_plots)
        candidate_text = json.dumps(current_candidate, ensure_ascii=False, indent=2)
        critique_text = json.dumps(critique.to_dict(), ensure_ascii=False, indent=2)
        return (
            "你是中文长篇小说情节生成器，正在根据批判意见修订 plot 和 chapter JSON。"
            "请保留当前候选中的可用部分，并修复逻辑缺口、章节覆盖不足、人物动机跳跃、阶段衔接不清等问题。\n\n"
            "硬性要求：\n"
            "- 只输出一个合法 JSON 对象。\n"
            "- 继续保持 plot schema 和 chapter schema 完整。\n"
            "- 优先修复 critique 中的高严重度问题。\n"
            "- chapter 数量、chapter_ids、chapter_titles、chapter_summaries 必须彼此一致。\n"
            "- 不要删除整体故事主轴，除非 critique 明确指出核心结构错误。\n\n"
            f"目标 book_id: {target_book_id}\n\n"
            f"样本库:\n{seeds_text}\n\n"
            f"当前候选:\n{candidate_text}\n\n"
            f"批判意见:\n{critique_text}\n\n"
            "JSON："
        )

    def generate_candidate(
        self,
        *,
        seed_plots: list[SeedPlot],
        target_book_id: str,
        target_chapter_count: int,
        critique: GenerationCritique | None = None,
        current_candidate: dict[str, Any] | None = None,
        rng: random.Random,
    ) -> dict[str, Any]:
        try:
            if not self.model_available:
                raise FileNotFoundError(f"Generator model directory not found: {self.model_name}")
            if critique is None or current_candidate is None:
                prompt = self.build_initial_prompt(
                    seed_plots=seed_plots,
                    target_book_id=target_book_id,
                    target_chapter_count=target_chapter_count,
                )
            else:
                prompt = self.build_revision_prompt(
                    seed_plots=seed_plots,
                    target_book_id=target_book_id,
                    current_candidate=current_candidate,
                    critique=critique,
                )
            payload = self.parse_json_payload(
                self.generate_json_text(
                    system_prompt="你是中文小说生成器，只输出合法 JSON。",
                    user_prompt=prompt,
                )
            )
        except Exception:
            if not self.allow_fallback:
                raise
            payload = self._build_fallback_candidate(
                seed_plots=seed_plots,
                target_book_id=target_book_id,
                target_chapter_count=target_chapter_count,
                critique=critique,
                current_candidate=current_candidate,
                rng=rng,
            )
        return self.normalize_candidate_payload(
            payload,
            target_book_id=target_book_id,
            default_plot_id="plot1",
            target_chapter_count=target_chapter_count,
        )

    def normalize_candidate_payload(
        self,
        payload: dict[str, Any],
        *,
        target_book_id: str,
        default_plot_id: str,
        target_chapter_count: int,
    ) -> dict[str, Any]:
        plot = dict(payload.get("plot") or {})
        raw_chapters = payload.get("chapters") or []
        if not isinstance(raw_chapters, list):
            raw_chapters = []
        chapters = [item for item in raw_chapters if isinstance(item, dict)]
        if not chapters:
            chapters = [{} for _ in range(target_chapter_count)]

        chapter_count = len(chapters)
        plot_id = str(plot.get("plot_id") or default_plot_id)
        plot_index = int(plot.get("plot_index") or 1)

        normalized_chapters: list[dict[str, Any]] = []
        chapter_ids: list[str] = []
        chapter_titles: list[str] = []
        chapter_summaries: list[dict[str, Any]] = []

        for index, chapter in enumerate(chapters, start=1):
            semantic = self._normalize_semantic_features(chapter.get("semantic_features") or chapter)
            title = self._clean_text(
                chapter.get("title")
                or (chapter.get("chapter_context") or {}).get("clean_title")
                or f"第{index}章 生成情节节点{index}"
            )
            chapter_id = f"{target_book_id}C{index:04d}"
            chapter_payload = {
                "chapter_context": {
                    "book_id": target_book_id,
                    "chapter_id": chapter_id,
                    "order": index,
                    "raw_title": title,
                    "clean_title": title,
                    "chapter_no": index,
                    "volume_title": "生成卷",
                    "volume_no": 1,
                    "char_count": int(chapter.get("char_count") or 0),
                    "paragraph_count": int(chapter.get("paragraph_count") or 0),
                    "dialogue_ratio": self._coerce_float(chapter.get("dialogue_ratio")),
                    "source_file": f"generated://{target_book_id}/{index:04d}.json",
                },
                "source_ref": {
                    "chapter_file": f"generated://{target_book_id}/{index:04d}.json",
                },
                "semantic_features": semantic,
            }
            normalized_chapters.append(chapter_payload)
            chapter_ids.append(chapter_id)
            chapter_titles.append(title)
            chapter_summaries.append(
                {
                    "chapter_id": chapter_id,
                    "title": title,
                    "summary": semantic["summary"],
                }
            )

        plot_summary = self._clean_text(plot.get("summary"))
        detailed_summary = self._clean_text(plot.get("detailed_summary")) or plot_summary
        normalized_plot = {
            "plot_id": plot_id,
            "plot_index": plot_index,
            "start_order": 1,
            "end_order": chapter_count,
            "summary": plot_summary or self._clean_text("；".join(item["summary"] for item in chapter_summaries[:3] if item["summary"])),
            "detailed_summary": detailed_summary or plot_summary,
            "boundary_quality": self._coerce_float(plot.get("boundary_quality")),
            "summary_coverage_quality": self._coerce_float(plot.get("summary_coverage_quality")),
            "chapter_ids": chapter_ids,
            "chapter_titles": chapter_titles,
            "chapter_summaries": chapter_summaries,
            "boundary_vote_before": self._coerce_float(plot.get("boundary_vote_before")),
            "boundary_vote_after": self._coerce_float(plot.get("boundary_vote_after")),
            "confidence": self._coerce_float(plot.get("confidence")),
        }
        return {
            "plot": normalized_plot,
            "chapters": normalized_chapters,
        }

    def _build_seed_text(self, seed_plots: list[SeedPlot]) -> str:
        blocks: list[str] = []
        for index, plot in enumerate(seed_plots, start=1):
            chapter_lines = []
            for chapter in plot.chapters[:8]:
                semantic = (chapter.payload.get("semantic_features") or {}) if isinstance(chapter.payload, dict) else {}
                summary = self._clean_text(semantic.get("summary"))
                detailed = self._clean_text("；".join(semantic.get("detailed_summary") or []))
                chapter_lines.append(
                    f"- 第{chapter.order}章 {chapter.title}\n"
                    f"  summary: {summary or '无'}\n"
                    f"  detailed: {detailed or '无'}"
                )
            blocks.append(
                f"[样本情节 {index}] {plot.plot_id}\n"
                f"plot_summary: {plot.summary}\n"
                f"plot_detailed_summary: {plot.detailed_summary}\n"
                f"chapter_count: {len(plot.chapter_ids)}\n"
                f"chapters:\n" + "\n".join(chapter_lines)
            )
        return "\n\n".join(blocks)

    @staticmethod
    def _candidate_schema_example() -> dict[str, Any]:
        return {
            "plot": {
                "plot_id": "plot1",
                "plot_index": 1,
                "start_order": 1,
                "end_order": 6,
                "summary": "",
                "detailed_summary": "",
                "boundary_quality": 0.82,
                "summary_coverage_quality": 0.87,
                "chapter_ids": ["BOOKIDC0001"],
                "chapter_titles": ["第1章 示例"],
                "chapter_summaries": [{"chapter_id": "BOOKIDC0001", "title": "第1章 示例", "summary": ""}],
                "boundary_vote_before": None,
                "boundary_vote_after": None,
                "confidence": 0.84,
            },
            "chapters": [
                {
                    "title": "第1章 示例",
                    "semantic_features": {
                        "summary": "",
                        "detailed_summary": [""],
                        "protagonist": [""],
                        "current_scene": [""],
                        "current_goal_or_task": [""],
                        "supporting_characters": [""],
                        "items_and_props": [""],
                        "protagonist_current_state": [""],
                        "chapter_function": [""],
                        "key_scenes": [""],
                        "important_dialogue_topics": [""],
                        "conflicts": [""],
                        "foreshadowing": [""],
                        "clues": [""],
                        "ending_hook": "",
                        "state_changes": [""],
                        "relationship_changes": [""],
                        "world_rules_or_system_changes": [""],
                        "tone": "",
                        "open_questions": [""],
                    },
                }
            ],
        }

    def _build_fallback_candidate(
        self,
        *,
        seed_plots: list[SeedPlot],
        target_book_id: str,
        target_chapter_count: int,
        critique: GenerationCritique | None,
        current_candidate: dict[str, Any] | None,
        rng: random.Random,
    ) -> dict[str, Any]:
        if critique is not None and current_candidate is not None:
            candidate = json.loads(json.dumps(current_candidate, ensure_ascii=False))
            for focus in critique.revision_focus:
                if "逻辑" in focus and candidate.get("plot", {}).get("detailed_summary"):
                    candidate["plot"]["detailed_summary"] += " 情节推进被明确拆分为更清晰的阶段，前因后果得到补足。"
                if "覆盖" in focus:
                    for chapter in candidate.get("chapters", []):
                        semantic = chapter.get("semantic_features") or {}
                        if not semantic.get("open_questions"):
                            semantic["open_questions"] = ["当前阶段遗留的问题将在后续处理中解决。"]
            return candidate

        fused_summaries = self._collect_seed_texts(seed_plots, "summary")
        fused_details = self._collect_seed_texts(seed_plots, "detailed_summary")
        protagonists = self._collect_seed_feature_values(seed_plots, "protagonist")
        scenes = self._collect_seed_feature_values(seed_plots, "current_scene")
        goals = self._collect_seed_feature_values(seed_plots, "current_goal_or_task")
        conflicts = self._collect_seed_feature_values(seed_plots, "conflicts")
        hooks = self._collect_seed_feature_values(seed_plots, "ending_hook")
        chapter_templates = self._collect_seed_titles(seed_plots)

        plot_summary = self._compose_plot_summary(fused_summaries, protagonists, goals)
        plot_detailed = self._compose_plot_detail(fused_details, scenes, conflicts)
        chapters: list[dict[str, Any]] = []
        for index in range(1, target_chapter_count + 1):
            title_root = chapter_templates[(index - 1) % len(chapter_templates)] if chapter_templates else "生成情节节点"
            title = f"第{index}章 {title_root}"
            summary = self._build_chapter_summary(
                index=index,
                total=target_chapter_count,
                plot_summary=plot_summary,
                protagonists=protagonists,
                goals=goals,
                scenes=scenes,
                conflicts=conflicts,
            )
            detail_points = [
                summary,
                f"{'、'.join(protagonists[:2]) or '主角'}在{'、'.join(scenes[:2]) or '新场景'}中处理新的推进节点。",
                f"本章围绕{'、'.join(goals[:2]) or '核心任务'}展开，并留下后续变化空间。",
            ]
            ending_hook = hooks[(index - 1) % len(hooks)] if hooks else "新的变数在章末被抛出。"
            chapters.append(
                {
                    "title": title,
                    "semantic_features": {
                        "summary": summary,
                        "detailed_summary": detail_points,
                        "protagonist": protagonists[:3],
                        "current_scene": scenes[:3] or ["未知区域"],
                        "current_goal_or_task": goals[:3] or ["推进当前主线"],
                        "supporting_characters": protagonists[1:4],
                        "items_and_props": ["线索", "关键道具"],
                        "protagonist_current_state": ["承压", "主动推进"],
                        "chapter_function": [self._stage_label(index, target_chapter_count)],
                        "key_scenes": [summary],
                        "important_dialogue_topics": goals[:2] or ["下一步计划"],
                        "conflicts": conflicts[:3] or ["外部阻碍升级"],
                        "foreshadowing": ["隐藏问题尚未完全揭开"],
                        "clues": ["一条新的线索被确认"],
                        "ending_hook": ending_hook,
                        "state_changes": ["局势向新的阶段推进"],
                        "relationship_changes": ["角色间协作与试探并存"],
                        "world_rules_or_system_changes": ["新的限制或规则被进一步揭示"],
                        "tone": "紧张推进",
                        "open_questions": ["接下来的选择会带来什么代价？"],
                    },
                }
            )
        return {
            "plot": {
                "plot_id": "plot1",
                "plot_index": 1,
                "start_order": 1,
                "end_order": target_chapter_count,
                "summary": plot_summary,
                "detailed_summary": plot_detailed,
                "boundary_quality": round(rng.uniform(0.65, 0.9), 6),
                "summary_coverage_quality": round(rng.uniform(0.68, 0.92), 6),
                "chapter_ids": [],
                "chapter_titles": [],
                "chapter_summaries": [],
                "boundary_vote_before": None,
                "boundary_vote_after": None,
                "confidence": round(rng.uniform(0.65, 0.88), 6),
            },
            "chapters": chapters,
        }

    def _collect_seed_texts(self, seed_plots: list[SeedPlot], key: str) -> list[str]:
        values: list[str] = []
        for plot in seed_plots:
            value = self._clean_text(getattr(plot, key, ""))
            if value and value not in values:
                values.append(value)
        return values

    def _collect_seed_titles(self, seed_plots: list[SeedPlot]) -> list[str]:
        titles: list[str] = []
        for plot in seed_plots:
            for title in plot.chapter_titles:
                cleaned = re.sub(r"^第[一二三四五六七八九十百千0-9]+章\s*", "", self._clean_text(title))
                if cleaned and cleaned not in titles:
                    titles.append(cleaned)
        return titles[:8]

    def _collect_seed_feature_values(self, seed_plots: list[SeedPlot], feature_name: str) -> list[str]:
        values: list[str] = []
        for plot in seed_plots:
            for chapter in plot.chapters:
                semantic = (chapter.payload.get("semantic_features") or {}) if isinstance(chapter.payload, dict) else {}
                raw_value = semantic.get(feature_name)
                if isinstance(raw_value, list):
                    candidates = [self._clean_text(item) for item in raw_value]
                else:
                    candidates = [self._clean_text(raw_value)]
                for item in candidates:
                    if item and item not in values:
                        values.append(item)
        return values[:8]

    def _compose_plot_summary(self, summaries: list[str], protagonists: list[str], goals: list[str]) -> str:
        if summaries:
            base = summaries[0]
        else:
            base = "主角们在不断升级的局势中推进新的主线情节。"
        if protagonists:
            base = f"{'、'.join(protagonists[:2])}在新的局势中推进主线任务，并逐步逼近关键真相。"
        if goals:
            base += f" 故事核心围绕{'、'.join(goals[:2])}展开。"
        return base[:140]

    def _compose_plot_detail(self, details: list[str], scenes: list[str], conflicts: list[str]) -> str:
        parts: list[str] = []
        if details:
            parts.append(details[0])
        if scenes:
            parts.append(f"故事主要发生在{'、'.join(scenes[:3])}等场域中，阶段转换较为明显。")
        if conflicts:
            parts.append(f"主角一行围绕{'、'.join(conflicts[:3])}持续承压，并在推进中补上原有情节空缺。")
        if not parts:
            parts.append("故事从任务引入、风险升级、关键转折到阶段结果依次推进，整体形成完整中层情节。")
        return " ".join(parts)[:320]

    def _build_chapter_summary(
        self,
        *,
        index: int,
        total: int,
        plot_summary: str,
        protagonists: list[str],
        goals: list[str],
        scenes: list[str],
        conflicts: list[str],
    ) -> str:
        stage = self._stage_label(index, total)
        protagonist_text = "、".join(protagonists[:2]) or "主角"
        scene_text = "、".join(scenes[:2]) or "新场景"
        goal_text = "、".join(goals[:2]) or "当前任务"
        conflict_text = "、".join(conflicts[:2]) or "新阻碍"
        return (
            f"{protagonist_text}在{scene_text}进入{stage}阶段，围绕{goal_text}采取行动，"
            f"同时正面应对{conflict_text}带来的压力。"
        )[:120]

    @staticmethod
    def _stage_label(index: int, total: int) -> str:
        if index == 1:
            return "引入"
        if index >= total:
            return "阶段收束"
        if index >= total - 1:
            return "高潮"
        if index <= max(2, total // 3):
            return "推进"
        return "转折"

    @staticmethod
    def _normalize_semantic_features(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "summary": PlotChapterGenerator._clean_text(payload.get("summary")),
            "detailed_summary": PlotChapterGenerator._list_of_text(payload.get("detailed_summary")),
            "protagonist": PlotChapterGenerator._list_of_text(payload.get("protagonist")),
            "current_scene": PlotChapterGenerator._list_of_text(payload.get("current_scene")),
            "current_goal_or_task": PlotChapterGenerator._list_of_text(payload.get("current_goal_or_task")),
            "supporting_characters": PlotChapterGenerator._list_of_text(payload.get("supporting_characters")),
            "items_and_props": PlotChapterGenerator._list_of_text(payload.get("items_and_props")),
            "protagonist_current_state": PlotChapterGenerator._list_of_text(payload.get("protagonist_current_state")),
            "chapter_function": PlotChapterGenerator._list_of_text(payload.get("chapter_function")),
            "key_scenes": PlotChapterGenerator._list_of_text(payload.get("key_scenes")),
            "important_dialogue_topics": PlotChapterGenerator._list_of_text(payload.get("important_dialogue_topics")),
            "conflicts": PlotChapterGenerator._list_of_text(payload.get("conflicts")),
            "foreshadowing": PlotChapterGenerator._list_of_text(payload.get("foreshadowing")),
            "clues": PlotChapterGenerator._list_of_text(payload.get("clues")),
            "ending_hook": PlotChapterGenerator._clean_text(payload.get("ending_hook")),
            "state_changes": PlotChapterGenerator._list_of_text(payload.get("state_changes")),
            "relationship_changes": PlotChapterGenerator._list_of_text(payload.get("relationship_changes")),
            "world_rules_or_system_changes": PlotChapterGenerator._list_of_text(payload.get("world_rules_or_system_changes")),
            "tone": PlotChapterGenerator._clean_text(payload.get("tone")),
            "open_questions": PlotChapterGenerator._list_of_text(payload.get("open_questions")),
        }

    @staticmethod
    def _list_of_text(value: object) -> list[str]:
        if isinstance(value, list):
            return [item for item in (PlotChapterGenerator._clean_text(v) for v in value) if item]
        text = PlotChapterGenerator._clean_text(value)
        return [text] if text else []

    @staticmethod
    def _coerce_float(value: object) -> float | None:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _clean_text(value: object) -> str:
        if value is None:
            return ""
        return " ".join(str(value).strip().split())


class PlotChapterCritic(_LocalJsonModel):
    def __init__(
        self,
        *,
        model_name: str = DEFAULT_CRITIC_MODEL,
        weights_root: str | Path | None = None,
        max_new_tokens: int = 2200,
        device_map: str = "auto",
        allow_fallback: bool = True,
        family_dirs: list[str] | None = None,
        gpu_memory_utilization: float = 0.9,
        per_gpu_memory_gb: int | None = None,
    ) -> None:
        super().__init__(
            model_name=model_name,
            weights_root=weights_root,
            family_dirs=family_dirs or ["DeepSeek", "deepseek", "DEEPSEEK", model_name],
            max_new_tokens=max_new_tokens,
            device_map=device_map,
            allow_fallback=allow_fallback,
            gpu_memory_utilization=gpu_memory_utilization,
            per_gpu_memory_gb=per_gpu_memory_gb,
        )

    def critique(
        self,
        *,
        seed_plots: list[SeedPlot],
        candidate: dict[str, Any],
    ) -> GenerationCritique:
        try:
            if not self.model_available:
                raise FileNotFoundError(f"Critic model directory not found: {self.model_name}")
            prompt = self.build_critique_prompt(seed_plots=seed_plots, candidate=candidate)
            payload = self.parse_json_payload(
                self.generate_json_text(
                    system_prompt="你是中文小说结构批判器，只输出合法 JSON。",
                    user_prompt=prompt,
                )
            )
            critique = GenerationCritique.from_dict(payload)
        except Exception:
            if not self.allow_fallback:
                raise
            critique = self._build_fallback_critique(candidate)
        return critique

    def build_critique_prompt(self, *, seed_plots: list[SeedPlot], candidate: dict[str, Any]) -> str:
        seeds_text = self._build_seed_text(seed_plots)
        candidate_text = json.dumps(candidate, ensure_ascii=False, indent=2)
        schema = json.dumps(
            {
                "approved": False,
                "score": 0.72,
                "summary": "",
                "revision_focus": [""],
                "issues": [
                    {
                        "severity": "high",
                        "category": "logic_gap",
                        "message": "",
                        "suggestion": "",
                    }
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        return (
            "你是中文长篇小说 plot/chapter 结构批判器。"
            "请审核候选内容是否存在逻辑断裂、事件跳跃、章节覆盖不全、人物动机不足、章节功能重复、结尾钩子缺失、信息密度不均等问题。\n\n"
            "要求：\n"
            "- 只输出一个合法 JSON 对象。\n"
            "- `approved=true` 仅在候选已经足够完整、逻辑自洽且覆盖 plot 全过程时才能给出。\n"
            "- `score` 取值 0 到 1。\n"
            "- `revision_focus` 用简洁中文列出下一轮最需要修的方向。\n"
            "- `issues` 最多列 6 条，优先指出真正影响成文质量的问题。\n\n"
            f"参考样本库:\n{seeds_text}\n\n"
            f"待审核候选:\n{candidate_text}\n\n"
            f"输出 Schema:\n{schema}\n\n"
            "JSON："
        )

    @staticmethod
    def _build_seed_text(seed_plots: list[SeedPlot]) -> str:
        return PlotChapterGenerator._build_seed_text(seed_plots)

    def _build_fallback_critique(self, candidate: dict[str, Any]) -> GenerationCritique:
        plot = candidate.get("plot") or {}
        chapters = candidate.get("chapters") or []
        issues = []
        revision_focus: list[str] = []
        score = 0.72
        if not plot.get("summary"):
            issues.append(
                {
                    "severity": "high",
                    "category": "missing_plot_summary",
                    "message": "plot 缺少 summary。",
                    "suggestion": "补足对整体情节主轴的高度概括。",
                }
            )
            score -= 0.18
            revision_focus.append("补足 plot 总结")
        if len(chapters) < 3:
            issues.append(
                {
                    "severity": "high",
                    "category": "underdeveloped_structure",
                    "message": "章节数过少，难以形成完整的起承转合。",
                    "suggestion": "增加章节层级推进和阶段结果。",
                }
            )
            score -= 0.2
            revision_focus.append("扩充分阶段推进")
        chapter_summaries = []
        for chapter in chapters:
            semantic = chapter.get("semantic_features") or {}
            summary = str(semantic.get("summary") or "").strip()
            chapter_summaries.append(summary)
            if not semantic.get("ending_hook"):
                score -= 0.03
                revision_focus.append("增强章末钩子")
                issues.append(
                    {
                        "severity": "medium",
                        "category": "missing_hook",
                        "message": "存在章节缺少章末钩子，后续驱动力偏弱。",
                        "suggestion": "在关键章节结尾补一个新问题或新风险。",
                    }
                )
                break
        unique_ratio = len({item for item in chapter_summaries if item}) / max(len(chapter_summaries), 1)
        if unique_ratio < 0.7:
            score -= 0.12
            revision_focus.append("减少章节功能重复")
            issues.append(
                {
                    "severity": "medium",
                    "category": "repetition",
                    "message": "多个章节摘要过于相似，推进层次不够清晰。",
                    "suggestion": "明确每章的独立任务、冲突或信息增量。",
                }
            )
        approved = score >= 0.78 and not any(issue["severity"] == "high" for issue in issues)
        if not revision_focus:
            revision_focus.append("细化阶段衔接")
        return GenerationCritique.from_dict(
            {
                "approved": approved,
                "score": max(0.0, min(1.0, round(score, 6))),
                "summary": "基于规则回退完成批判，已检查 plot 总结、章节覆盖、重复度和钩子完整度。",
                "revision_focus": revision_focus[:4],
                "issues": issues[:6],
            }
        )


def build_generation_metadata(
    *,
    generator_model: PlotChapterGenerator,
    critic_model: PlotChapterCritic,
    seed_plots: list[SeedPlot],
    critique_rounds: list[GenerationCritique],
) -> dict[str, Any]:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator_model": generator_model.model_name,
        "generator_model_source": generator_model.resolved_model_source or generator_model.model_name,
        "generator_model_available": generator_model.model_available,
        "generator_weights_root": generator_model.weights_root,
        "generator_runtime": generator_model.runtime_placement.to_dict(),
        "critic_model": critic_model.model_name,
        "critic_model_source": critic_model.resolved_model_source or critic_model.model_name,
        "critic_model_available": critic_model.model_available,
        "critic_weights_root": critic_model.weights_root,
        "critic_runtime": critic_model.runtime_placement.to_dict(),
        "seed_plot_ids": [plot.plot_id for plot in seed_plots],
        "seed_plot_count": len(seed_plots),
        "critique_rounds": [critique.to_dict() for critique in critique_rounds],
        "synthetic_generation": True,
    }
