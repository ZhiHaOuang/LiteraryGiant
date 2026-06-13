from __future__ import annotations

from dataclasses import asdict, dataclass, field

from shared import _as_text, _as_list, _dedupe_items


@dataclass(slots=True)
class EntityMention:
    text: str
    label: str
    start: int
    end: int
    score: float | None = None
    chunk_index: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)
@dataclass(slots=True)
class SemanticFeatures:
    summary: str = ""
    detailed_summary: list[str] = field(default_factory=list)
    protagonist: list[str] = field(default_factory=list)
    current_scene: list[str] = field(default_factory=list)
    current_goal_or_task: list[str] = field(default_factory=list)
    supporting_characters: list[str] = field(default_factory=list)
    items_and_props: list[str] = field(default_factory=list)
    protagonist_current_state: list[str] = field(default_factory=list)
    chapter_function: list[str] = field(default_factory=list)
    key_scenes: list[str] = field(default_factory=list)
    important_dialogue_topics: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    foreshadowing: list[str] = field(default_factory=list)
    clues: list[str] = field(default_factory=list)
    ending_hook: str = ""
    state_changes: list[str] = field(default_factory=list)
    relationship_changes: list[str] = field(default_factory=list)
    world_rules_or_system_changes: list[str] = field(default_factory=list)
    tone: str = ""
    open_questions: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict) -> "SemanticFeatures":
        return cls(
            summary=_as_text(payload.get("summary")),
            detailed_summary=_as_list(payload.get("detailed_summary")),
            protagonist=_as_list(payload.get("protagonist") or payload.get("主角")),
            current_scene=_as_list(payload.get("current_scene") or payload.get("当前场景")),
            current_goal_or_task=_as_list(payload.get("current_goal_or_task") or payload.get("当前目标和任务")),
            supporting_characters=_as_list(payload.get("supporting_characters") or payload.get("配角")),
            items_and_props=_as_list(payload.get("items_and_props") or payload.get("物体道具")),
            protagonist_current_state=_as_list(payload.get("protagonist_current_state") or payload.get("主角当前状态")),
            chapter_function=_as_list(payload.get("chapter_function")),
            key_scenes=_as_list(payload.get("key_scenes")),
            important_dialogue_topics=_as_list(payload.get("important_dialogue_topics")),
            conflicts=_as_list(payload.get("conflicts")),
            foreshadowing=_as_list(payload.get("foreshadowing")),
            clues=_as_list(payload.get("clues")),
            ending_hook=_as_text(payload.get("ending_hook")),
            state_changes=_as_list(payload.get("state_changes")),
            relationship_changes=_as_list(payload.get("relationship_changes")),
            world_rules_or_system_changes=_as_list(payload.get("world_rules_or_system_changes")),
            tone=_as_text(payload.get("tone")),
            open_questions=_as_list(payload.get("open_questions")),
        )

    def to_dict(self) -> dict:
        return asdict(self)
