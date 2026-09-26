from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared import as_list, as_mapping, as_text, dedupe_items

from .bridge_llm import BridgeLLMClient, BridgeLLMResponseError
from .pattern_store import _refresh_pattern_support, read_jsonl, write_jsonl_atomic
from .schemas import AUTOMATED_PATTERN_LIBRARIES


SEMANTIC_COMPACTION_SYSTEM_PROMPT = """你是 AbstractLibrary 的跨书语义策展器。

输入是多本书已经通过初步筛选的 EmergingPatterns。你的任务是只把不同书籍之间机制等价的模式合成一个更强的可复用模式，并保留其全部来源实例。

严格规则：
- 人名、职业、道具、场景、题材外壳、冲突强度不同，不足以保留为不同模式。
- 若触发 -> 压力/行动链 -> 状态变化 -> 读者效果的骨架等价，必须合并。
- 只有因果顺序、角色权力结构、读者效果机制、约束/代价或状态变化类型至少两项实质不同，才保留为独立组。
- 同一本书里的两个 pattern 不能互相证明通用性，不得在此阶段合并。
- 一个合并组中每本书最多只能贡献一个 pattern，防止用一个外书实例吞并某本书内多个不同机制。
- 每一组只返回成员 ID、简短原因、canonical 名称和一句核心机制；其它完整字段由系统从已有 pattern 保留。
- 只返回确实需要合并的多成员组；不需要合并或无法判断的 pattern 不要输出，系统会自动原样保留。
- 只输出 JSON，不要 Markdown。"""


def compact_emerging_patterns(
    *,
    abstract_library_root: str | Path,
    client: BridgeLLMClient,
    libraries: list[str] | None = None,
) -> dict[str, Any]:
    """LLM-compact one library's newly created patterns without losing instances."""
    root = Path(abstract_library_root)
    selected = libraries or list(AUTOMATED_PATTERN_LIBRARIES)
    result: dict[str, Any] = {"libraries": {}, "created_groups": 0, "merged_patterns": 0}
    for library in selected:
        if library not in AUTOMATED_PATTERN_LIBRARIES:
            continue
        rows = read_jsonl(root / library / "emerging_patterns.jsonl")
        if len(rows) < 2:
            result["libraries"][library] = {"before": len(rows), "after": len(rows), "status": "not_needed"}
            continue
        try:
            parsed, _ = client.generate_json(
                system_prompt=SEMANTIC_COMPACTION_SYSTEM_PROMPT,
                user_prompt=_compaction_prompt(library, rows),
            )
        except BridgeLLMResponseError as exc:
            result["libraries"][library] = {"before": len(rows), "after": len(rows), "status": "incomplete_json", "error": str(exc)}
            continue
        except Exception as exc:  # noqa: BLE001 - a failed compaction must never discard patterns.
            result["libraries"][library] = {"before": len(rows), "after": len(rows), "status": "error", "error": f"{type(exc).__name__}: {exc}"}
            continue
        groups = _validated_groups(parsed, rows)
        compacted, pattern_map = _apply_groups(library, rows, groups)
        instances = _remap_instances(read_jsonl(root / library / "instances.jsonl"), pattern_map)
        _refresh_pattern_support({"emerging": compacted, "universal": []}, instances)
        write_jsonl_atomic(root / library / "emerging_patterns.jsonl", compacted)
        write_jsonl_atomic(root / library / "instances.jsonl", instances)
        result["libraries"][library] = {
            "before": len(rows),
            "after": len(compacted),
            "status": "compacted",
            "merged_patterns": len(rows) - len(compacted),
        }
        result["created_groups"] += len(compacted)
        result["merged_patterns"] += len(rows) - len(compacted)
    return result


def _compaction_prompt(library: str, rows: list[dict[str, Any]]) -> str:
    payload = {
        "task": "conservative_cross_book_semantic_compaction",
        "library": library,
        "patterns": [_pattern_brief(row) for row in rows],
        "output_schema": {
            "library": library,
            "groups": [
                {
                    "member_pattern_ids": [],
                    "reason": "concise mechanism-level reason",
                    "canonical_pattern": {
                        "pattern_name": "",
                        "core_mechanism": "",
                    },
                }
            ],
        },
        "rules": [
            "Return JSON only.",
            "Only output true merge groups with at least two member_pattern_ids.",
            "Omit every singleton or uncertain pattern; omitted patterns are retained automatically.",
            "A multi-pattern group must contain patterns from at least two distinct supported_books.",
            "A multi-pattern group may contain at most one pattern from each book.",
            "Do not target a fixed number of groups. Create a separate group only when its structural mechanism is genuinely different.",
            "Do not preserve a singleton merely because names, settings, jobs, props, or intensity differ.",
            "canonical_pattern.pattern_name must be <= 32 Chinese characters.",
            "canonical_pattern.pattern_name must be natural Chinese and must not be an English slug.",
            "canonical_pattern.core_mechanism must be one sentence and <= 220 Chinese characters.",
            "reason must be <= 80 Chinese characters.",
            "Do not output definition, role_slots, required_conditions, variation_axes, reader_effect, failure_risks, or generation_usage.",
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _pattern_brief(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "pattern_id": as_text(row.get("pattern_id")),
        "pattern_name": as_text(row.get("pattern_name")),
        "definition": as_text(row.get("definition"))[:360],
        "core_mechanism": as_text(row.get("core_mechanism"))[:480],
        "role_slots": sorted(as_mapping(row.get("role_slots")).keys()),
        "required_conditions": as_list(row.get("required_conditions"))[:4],
        "reader_effect": as_text(row.get("reader_effect"))[:240],
        "supported_books": as_list(row.get("supported_books")),
        "registered_instance_count": row.get("registered_instance_count", 0),
    }


def _validated_groups(parsed: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    source_by_id = {as_text(row.get("pattern_id")): row for row in rows if as_text(row.get("pattern_id"))}
    assigned: set[str] = set()
    groups: list[dict[str, Any]] = []
    for raw in parsed.get("groups") or []:
        if not isinstance(raw, dict):
            continue
        member_ids = [as_text(value) for value in as_list(raw.get("member_pattern_ids"))]
        member_ids = [value for value in member_ids if value in source_by_id and value not in assigned]
        canonical = as_mapping(raw.get("canonical_pattern"))
        if len(member_ids) < 2 or not as_text(canonical.get("pattern_name")) or not as_text(canonical.get("core_mechanism")):
            continue
        if not _cross_book_group_allowed(member_ids, source_by_id):
            continue
        assigned.update(member_ids)
        groups.append({"member_pattern_ids": member_ids, "canonical_pattern": canonical, "reason": as_text(raw.get("reason"))})
    for pattern_id in source_by_id:
        if pattern_id in assigned:
            continue
        source = source_by_id[pattern_id]
        groups.append(
            {
                "member_pattern_ids": [pattern_id],
                "canonical_pattern": _pattern_brief(source),
                "reason": "model_left_unassigned; retained_without_loss",
            }
        )
    return groups


def _cross_book_group_allowed(
    member_ids: list[str],
    source_by_id: dict[str, dict[str, Any]],
) -> bool:
    books_per_member = [
        {as_text(book) for book in as_list(source_by_id[pattern_id].get("supported_books")) if as_text(book)}
        for pattern_id in member_ids
    ]
    if any(not books for books in books_per_member):
        return False
    all_books = set().union(*books_per_member)
    if len(all_books) < 2:
        return False
    return all(
        sum(book in books for books in books_per_member) <= 1
        for book in all_books
    )


def _apply_groups(
    library: str,
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    source_by_id = {as_text(row.get("pattern_id")): row for row in rows}
    compacted: list[dict[str, Any]] = []
    pattern_map: dict[str, str] = {}
    writable_fields = {
        "pattern_name",
        "definition",
        "core_mechanism",
        "role_slots",
        "required_conditions",
        "variation_axes",
        "reader_effect",
        "failure_risks",
        "generation_usage",
    }
    for group in groups:
        member_ids = group["member_pattern_ids"]
        members = [source_by_id[pattern_id] for pattern_id in member_ids]
        canonical_id = min(member_ids)
        canonical = dict(members[0] if as_text(members[0].get("pattern_id")) == canonical_id else source_by_id[canonical_id])
        proposal = as_mapping(group.get("canonical_pattern"))
        canonical.update({key: proposal[key] for key in writable_fields if key in proposal and proposal[key] not in ("", [], {})})
        canonical["pattern_id"] = canonical_id
        canonical["library"] = library
        canonical["supported_books"] = dedupe_items(
            [book for member in members for book in as_list(member.get("supported_books"))]
        )
        canonical["supported_book_count"] = len(canonical["supported_books"])
        canonical["evidence_refs"] = _dedupe_dicts(
            [ref for member in members for ref in as_list(member.get("evidence_refs")) if isinstance(ref, dict)]
        )
        curation = dict(as_mapping(canonical.get("curation")))
        curation["semantic_compaction"] = {
            "merged_source_pattern_ids": member_ids,
            "reason": group.get("reason", ""),
        }
        canonical["curation"] = curation
        compacted.append(canonical)
        pattern_map.update({pattern_id: canonical_id for pattern_id in member_ids})
    return compacted, pattern_map


def _remap_instances(rows: list[dict[str, Any]], pattern_map: dict[str, str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in rows:
        row = dict(raw)
        original_pattern_id = as_text(row.get("pattern_id"))
        pattern_id = pattern_map.get(original_pattern_id, original_pattern_id)
        row["pattern_id"] = pattern_id
        row["instance_id"] = _remapped_instance_id(as_text(row.get("instance_id")), pattern_id)
        instance_id = as_text(row.get("instance_id"))
        if not instance_id or instance_id in seen:
            continue
        seen.add(instance_id)
        result.append(row)
    return result


def _remapped_instance_id(value: str, pattern_id: str) -> str:
    parts = value.split(":", 3)
    if len(parts) == 4:
        return f"{parts[0]}:{parts[1]}:{pattern_id}:{parts[3]}"
    return value


def _dedupe_dicts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for row in rows:
        key = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            result.append(row)
            seen.add(key)
    return result
