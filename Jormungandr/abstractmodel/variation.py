from __future__ import annotations

import re
from typing import Any

from shared import as_list, as_mapping, as_text


MAX_AXIS_VALUES = 8
MAX_AXIS_NAME_LENGTH = 36
MAX_AXIS_VALUE_LENGTH = 64
GENERIC_VALUES = {
    "其他",
    "其它",
    "不限",
    "多种",
    "若干",
    "各种",
    "视情况",
    "未知",
    "待补充",
    "可变",
    "灵活",
    "etc",
    "n/a",
    "none",
}


def clean_variation_axes(
    raw_axes: object,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Normalize variation axes and retain a reviewable cleaning trail."""
    cleaned: list[dict[str, Any]] = []
    discarded: list[dict[str, Any]] = []
    log: list[dict[str, Any]] = []
    seen_axes: set[str] = set()

    axes = raw_axes if isinstance(raw_axes, list) else as_list(raw_axes)
    for position, raw in enumerate(axes, start=1):
        parsed, parse_log = _parse_axis(raw)
        log.extend({"position": position, **entry} for entry in parse_log)
        if not parsed:
            discarded.append({"position": position, "raw": raw, "reason": "invalid_axis"})
            continue
        axis = parsed["axis"]
        axis_key = _comparison_key(axis)
        if axis_key in seen_axes:
            discarded.append({"position": position, "raw": raw, "reason": "duplicate_axis"})
            continue
        if len(axis) > MAX_AXIS_NAME_LENGTH:
            discarded.append({"position": position, "raw": raw, "reason": "axis_name_too_long"})
            continue
        seen_axes.add(axis_key)

        values: list[str] = []
        seen_values: set[str] = set()
        for value in parsed["values"]:
            normalized, reason = _clean_value(value)
            if not normalized:
                discarded.append(
                    {"position": position, "axis": axis, "raw": value, "reason": reason or "empty_value"}
                )
                continue
            key = _comparison_key(normalized)
            if key in seen_values:
                discarded.append({"position": position, "axis": axis, "raw": value, "reason": "duplicate_value"})
                continue
            if len(values) >= MAX_AXIS_VALUES:
                discarded.append({"position": position, "axis": axis, "raw": value, "reason": "axis_value_limit"})
                continue
            seen_values.add(key)
            values.append(normalized)

        if not values:
            values = _inferred_axis_values(axis)
            log.append(
                {
                    "position": position,
                    "action": "inferred_missing_values",
                    "axis": axis,
                    "values": values,
                }
            )

        cleaned.append(
            {
                "axis": axis,
                "values": values,
                "function": _axis_function(axis),
            }
        )

    return cleaned, discarded, log


def _parse_axis(raw: object) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    logs: list[dict[str, Any]] = []
    if isinstance(raw, dict):
        mapping = as_mapping(raw)
        axis = _strip_noise(as_text(mapping.get("axis")))
        raw_values = mapping.get("values") if isinstance(mapping.get("values"), list) else as_list(mapping.get("values"))
        values = [_strip_noise(as_text(value)) for value in raw_values]
        return ({"axis": axis, "values": values} if axis else None), logs

    text = _strip_noise(as_text(raw).removeprefix("候选变体："))
    if not text:
        return None, logs
    repaired = _repair_parentheses(text)
    if repaired is None:
        logs.append({"action": "discarded", "raw": text, "reason": "unbalanced_parentheses"})
        return None, logs
    if repaired != text:
        logs.append({"action": "repaired_parentheses", "before": text, "after": repaired})
    text = repaired

    if "：" in text or ":" in text:
        separator = "：" if "：" in text else ":"
        axis, options_text = (_strip_noise(value) for value in text.split(separator, 1))
    else:
        match = re.match(r"^([^（(]+?)\s*[（(]\s*(.+)\s*[）)]$", text)
        if match:
            axis = _strip_noise(match.group(1))
            options_text = match.group(2).strip().rstrip("）)")
        elif re.search(r"\bvs\.?\b", text, flags=re.IGNORECASE):
            left, right = re.split(r"\s*\bvs\.?\b\s*", text, maxsplit=1, flags=re.IGNORECASE)
            axis = _binary_axis_name(left, right)
            options_text = f"{left}/{right}"
        elif "是否" in text:
            axis, options_text = text, "是/否"
        else:
            axis, options_text = _strip_noise(text), ""
    values = [
        value
        for value in re.split(r"\s*(?:/|、|,|，|\||;|；|\bvs\.?\b)\s*", options_text, flags=re.IGNORECASE)
        if value.strip()
    ]
    return ({"axis": axis, "values": values} if axis else None), logs


def _repair_parentheses(text: str) -> str | None:
    pairs = (("（", "）"), ("(", ")"))
    repaired = text
    for opening, closing in pairs:
        difference = repaired.count(opening) - repaired.count(closing)
        if difference == 1 and repaired.count(opening) == 1:
            repaired += closing
        elif difference != 0:
            return None
    return repaired


def _clean_value(value: str) -> tuple[str, str]:
    text = _strip_noise(value).strip("。；，,;:：")
    if not text:
        return "", "empty_value"
    if _comparison_key(text) in GENERIC_VALUES:
        return "", "generic_value"
    if len(text) > MAX_AXIS_VALUE_LENGTH:
        return "", "value_too_long"
    if _repair_parentheses(text) != text:
        return "", "unbalanced_parentheses"
    return text, ""


def _strip_noise(value: str) -> str:
    return re.sub(r"^[\s.。·•*\-–—_、:：]+", "", value).strip().strip("。；，,;:：")


def _binary_axis_name(left: str, right: str) -> str:
    text = f"{left}{right}"
    if "死" in text:
        return "死亡真实性"
    if any(term in text for term in ("成功", "失败")):
        return "行动结果"
    return "二元结果"


def _inferred_axis_values(axis: str) -> list[str]:
    if "是否" in axis:
        return ["是", "否"]
    if any(term in axis for term in ("时机", "位置", "提前", "同步", "到来")):
        return ["前段", "中段", "后段"]
    if any(term in axis for term in ("程度", "强度", "规模", "比重", "深度", "高低", "紧迫")):
        return ["低", "中", "高"]
    if any(term in axis for term in ("内疚", "补偿", "赎罪")):
        return ["压抑回避", "象征性补偿", "行动性赎罪"]
    if any(term in axis for term in ("线索", "揭露", "信息")):
        return ["提前铺垫", "同步发现", "事后确认"]
    if any(term in axis for term in ("撤退", "蛰伏", "反击")):
        return ["战术缓冲", "长期蛰伏", "立即反击"]
    if any(term in axis for term in ("身份", "关系", "牺牲者")):
        return ["亲密关系", "合作关系", "利益关系"]
    if any(term in axis for term in ("方式", "手段", "行动", "介入")):
        return ["直接行动", "间接推动", "第三方介入"]
    if any(term in axis for term in ("类型", "性质", "来源", "危机", "威胁", "背叛")):
        return ["内部因素", "外部因素", "混合因素"]
    if any(term in axis for term in ("结果", "后果", "改变", "方向", "演变")):
        return ["局部改变", "关系改变", "结构改变"]
    if any(term in axis for term in ("规则", "条件", "周期")):
        return ["固定触发", "条件触发", "周期触发"]
    return ["基准版本", "单变量变化", "组合变化"]


def _comparison_key(value: str) -> str:
    return re.sub(r"[\s_\-—–.。·•、,，:：;；（）()]", "", value).lower()


def _axis_function(axis: str) -> str:
    if any(term in axis for term in ("压力", "羞辱", "威胁", "危机", "创伤")):
        return "决定压力如何产生、累积或升级"
    if any(term in axis for term in ("反击", "解决", "保护", "介入", "行动", "调查")):
        return "决定机制中的关键行动如何执行"
    if any(term in axis for term in ("关系", "结果", "后果", "反应", "承诺")):
        return "决定状态变化和关系后果"
    if any(term in axis for term in ("场合", "公开", "环境", "空间", "场域")):
        return "决定机制发生的评价场域与可见程度"
    return "提供不改变核心机制的可迁移变化维度"
