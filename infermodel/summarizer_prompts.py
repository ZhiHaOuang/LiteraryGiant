"""Prompt templates for the plot-window analyser.

Each function builds a prompt string that is fed to the local LLM.
They are extracted from :class:`~infermodel.summarizer.PlotWindowAnalyzer`
to keep the core class focused on orchestration and inference.
"""

from __future__ import annotations

import json

from .schemas import ChapterSynopsis, GlobalPlot, PlotWindow


def build_window_prompt(
    window: PlotWindow,
    *,
    max_window_input_chars: int = 14000,
    mode: str = "initial",
) -> str:
    """Build the prompt for analysing a single sliding window."""
    chapter_count = len(window.chapter_orders)
    include_detailed = mode != "refine"
    chapter_text = window.to_prompt_text(max_detail_points=6, include_detailed=include_detailed)
    if len(chapter_text) > max_window_input_chars:
        chapter_text = chapter_text[:max_window_input_chars]

    expected_range = _expected_segment_range(chapter_count, mode=mode)
    segment_hint = f"{expected_range[0]} 到 {expected_range[1]}"

    schema = json.dumps(
        {
            "segments": [
                {
                    "start_order": 1,
                    "end_order": 3,
                    "chapter_orders": [1, 2, 3],
                    "summary": "",
                    "detailed_summary": "",
                    "uncertain_boundary_before": False,
                    "uncertain_boundary_after": False,
                    "uncertainty_notes": [],
                    "confidence": 0.85,
                    "segment_level": "sub_plot",
                }
            ],
            "candidate_boundaries": [
                {
                    "boundary_after": 3,
                    "strength": "strong",
                    "boundary_type": "task_shift",
                    "should_split": True,
                    "left_goal": "",
                    "right_goal": "",
                    "reason": "",
                }
            ],
            "uncertain_boundaries": [
                {
                    "left_order": 3,
                    "right_order": 4,
                    "reason": "",
                }
            ],
        },
        ensure_ascii=False,
        indent=2,
    )
    source_description = "这些章节的 summary 和 detailed_summary" if include_detailed else "这些章节的 summary"
    return (
        "你是中文长篇小说的局部情节切分器。你会看到一个重叠滑动窗口中的若干章节摘要。\n"
        f"你的任务是只基于{source_description}，输出该窗口内的局部情节段。\n\n"
        "总要求：\n"
        "- 只能输出一个合法 JSON 对象，不要输出解释、代码块或额外文字。\n"
        "- `segments` 中每个情节段必须覆盖一段连续章节。\n"
        "- `chapter_orders` 必须和 `start_order`/`end_order` 一致。\n"
        "- 这不是粗分任务。请优先识别窗口内部的阶段转换、目标变化、冲突升级、场景切换、队伍变化、任务切换、线索转向和阶段性结果。\n"
        f"- 当前窗口大约有 {chapter_count} 章，通常应该切成 {segment_hint} 个情节段；只有在整段章节都服务于同一个连续目标且没有明显阶段变化时，才允许只输出 1 个情节段。\n"
        "- 先找边界，再组装情节段。请显式列出 `candidate_boundaries`，不要只靠 `segments` 隐含边界。\n"
        "- `candidate_boundaries` 要覆盖你认为最重要的切分点，至少列出 1 到 5 个，并标明 `strength` 为 `hard` / `strong` / `weak` / `forbid`。\n"
        "- `boundary_type` 只能使用这些值之一：`world_shift`、`task_shift`、`enemy_shift`、`result_transition`、`settlement_reset`、`setting_shift`、`same_action_continuation`、`conversation_bridge`、`other`。\n"
        "- 如果属于进入新世界/新副本、主任务文本明确变化、结算后重新进入任务、主要对抗对象切换，优先标成 `hard` 或 `strong`。\n"
        "- 如果只是同一战斗的连续回合、同一追逐/营救的连续步骤、同一计划的执行细节，优先标成 `forbid`，表示不应该在这里切。\n"
        "- 如果你感觉边界不完全确定，也应该先给出你认为最可能的边界，再用 `uncertain_boundary_before`、`uncertain_boundary_after` 和 `uncertainty_notes` 标记不确定，而不是把多个阶段直接合并成一整段。\n"
        "- 单章情节段应当尽量少见，只有在该章明显承担引入、重大转折、结算或阶段重启作用时才允许单独成段。\n"
        "- 除非确实是同一段持续推进，否则不要让一个情节段过长；如果一个情节段超过 10 章，你需要非常谨慎，并优先检查其中是否存在阶段边界。\n"
        "- 如果连续几章只是同一行动的一部分，可以放在同一段；但只要出现任务切换、地点转换、队伍切换、战斗阶段转换、信息目标转换或阶段性结算，就应该切段。\n"
        "- `segment_level` 只能使用 `setup`、`transition`、`sub_plot`、`parent_plot`、`climax`、`resolution` 之一。一般中层切分优先保留 `sub_plot` / `parent_plot` / `climax` / `resolution`。\n"
        "- `summary` 写 40 到 120 个中文字符，概括该情节段。\n"
        "- `detailed_summary` 写 120 到 320 个中文字符，归纳该情节段的推进、转折和结果。\n"
        "- 如果边界不确定，请在 `uncertain_boundary_before` 或 `uncertain_boundary_after` 标记，并把原因写进 `uncertainty_notes`。\n"
        "- `uncertain_boundaries` 只列出窗口中你觉得最不稳定的边界。\n"
        "- 先在脑中判断每一章是否属于同一连续阶段，再输出 JSON；不要仅因为人物相同或世界观相同就把不同阶段合并。\n\n"
        f"窗口范围：第 {window.start_order} 章 到第 {window.end_order} 章\n"
        f"章节列表：{window.chapter_orders}\n\n"
        f"JSON Schema:\n{schema}\n\n"
        f"窗口章节摘要：\n{chapter_text}\n\n"
        "JSON："
    )


def build_fusion_prompt(
    plot: GlobalPlot,
    chapters: list[ChapterSynopsis],
    *,
    max_fusion_input_chars: int = 7000,
) -> str:
    """Build the prompt for fusing per-segment summaries into a plot-level summary."""
    chapter_lines = []
    for chapter in chapters:
        chapter_lines.append(
            f"第{chapter.order}章 {chapter.title or '未知标题'}\n"
            f"- summary: {chapter.summary or '无'}\n"
            f"- detailed_summary: {chapter.detailed_summary or '无'}"
        )
    chapter_text = "\n\n".join(chapter_lines)
    if len(chapter_text) > max_fusion_input_chars:
        chapter_text = chapter_text[:max_fusion_input_chars]

    schema = json.dumps(
        {
            "summary": "",
            "detailed_summary": "",
        },
        ensure_ascii=False,
        indent=2,
    )
    return (
        "你是中文长篇小说的情节摘要生成器。请只基于当前 plot 内章节本身的 summary 和 detailed_summary，重新生成该 plot 的最终摘要。\n"
        "只输出一个合法 JSON 对象。\n"
        "- `summary` 写 50 到 120 个中文字符。\n"
        "- `detailed_summary` 写 150 到 360 个中文字符。\n"
        "- 必须覆盖该 plot 的开端、主要推进和阶段性结果，不能只总结前几章。\n"
        "- 不允许使用 plot 外的任何章节信息，不允许参考相邻 plot，不允许复用局部窗口摘要中的额外表述。\n"
        "- 如果 plot 内存在多个子阶段，要在 detailed_summary 中体现这些阶段的衔接。\n"
        "- 不能编造当前 plot 章节里没有依据的新事实。\n\n"
        f"目标情节段范围：第 {plot.start_order} 章 到第 {plot.end_order} 章\n"
        f"章节列表：{plot.chapter_orders}\n\n"
        f"JSON Schema:\n{schema}\n\n"
        f"当前 plot 章节内容：\n{chapter_text}\n\n"
        "JSON："
    )


def build_boundary_prompt(
    left_chapters: list[ChapterSynopsis],
    right_chapters: list[ChapterSynopsis],
    *,
    max_window_input_chars: int = 14000,
) -> str:
    """Build the prompt for validating a boundary between two chapter groups."""
    left_text = "\n\n".join(
        chapter.to_window_block(max_detail_points=4, include_detailed=True)
        for chapter in left_chapters
    )
    right_text = "\n\n".join(
        chapter.to_window_block(max_detail_points=4, include_detailed=True)
        for chapter in right_chapters
    )
    prompt_body = (
        "你是中文长篇小说的情节边界验证器。请判断左右两侧章节是否仍在推进同一个中层情节。\n"
        "中层情节的判断优先依据：核心目标、主要冲突对象、主要行动阶段、阶段性结果。\n"
        "如果右侧进入了新任务、新地点、新对抗对象、新规则阶段，或者左侧已经完成阶段性结算，则应判定为应该切分。\n"
        "不要因为人物相同就判定为同一情节。\n"
        "只输出一个合法 JSON 对象。\n\n"
        "JSON Schema:\n"
        "{\n"
        '  "should_split": true,\n'
        '  "confidence": 0.85,\n'
        '  "reason": "",\n'
        '  "left_goal": "",\n'
        '  "right_goal": ""\n'
        "}\n\n"
        f"左侧章节：\n{left_text}\n\n"
        f"右侧章节：\n{right_text}\n\n"
        "JSON："
    )
    if len(prompt_body) > max_window_input_chars:
        prompt_body = prompt_body[:max_window_input_chars]
    return prompt_body


def expected_segment_range(chapter_count: int, *, mode: str = "initial") -> tuple[int, int]:
    """Return the recommended segment count range for a window of *chapter_count* chapters."""
    if mode == "refine":
        if chapter_count >= 40:
            return 4, 7
        if chapter_count >= 28:
            return 3, 6
        if chapter_count >= 18:
            return 2, 4
        return 2, 3
    if chapter_count >= 28:
        return 3, 6
    if chapter_count >= 18:
        return 2, 5
    if chapter_count >= 10:
        return 2, 4
    return 1, 3


# Backward-compatible alias (used as PlotWindowAnalyzer._expected_segment_range).
_expected_segment_range = expected_segment_range
