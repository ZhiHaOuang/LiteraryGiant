from __future__ import annotations

from typing import Any

from shared import as_list, as_mapping, as_text, dedupe_items

from .schemas import EMOTION_RHYTHM, EVENTS_LIBRARY, PAYOFF_ANGST, PlotSignature, field_texts, list_of_dicts


PUBLIC_PRESSURE_TERMS = ("公开", "当众", "派对", "宴", "羞辱", "压迫", "嘲讽", "打脸", "反击", "评价")
BETRAYAL_TERMS = ("背叛", "出轨", "旧爱", "前任", "男友", "未婚夫", "旧关系", "退婚")
NEW_RELATION_TERMS = ("新关系", "暧昧", "追求", "伴侣", "一夜情", "保护", "介入", "升温")
RESCUE_TERMS = ("救", "保护", "脱困", "带走", "危机", "困境", "警方", "法庭", "案件")
SECRET_TERMS = ("秘密", "真相", "揭露", "身份", "隐瞒", "发现")
POWER_TERMS = ("豪门", "资本", "公司", "集团", "家族", "权力", "资源", "组织", "阶层")
WORLD_RULE_TERMS = ("规则", "系统", "法则", "权限", "等级", "代价", "惩罚", "奖励", "副本", "积分", "契约")


def text_blob(*values: object) -> str:
    parts: list[str] = []
    for value in values:
        if isinstance(value, dict):
            parts.extend(as_text(item) for item in value.values())
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    parts.extend(as_text(inner) for inner in item.values())
                else:
                    parts.append(as_text(item))
        else:
            parts.append(as_text(value))
    return "\n".join(part for part in parts if part)


def has_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def reader_effects(plot: dict[str, Any], signature: PlotSignature) -> list[str]:
    payoff = as_mapping(plot.get("payoff_and_hook"))
    effects: list[str] = []
    if as_list(payoff.get("reader_payoffs")):
        effects.extend(["压抑释放", "价值确认"])
    if as_list(payoff.get("angst_points")):
        effects.append("替主角不值")
    if as_list(payoff.get("suspense_hooks")) or as_text(payoff.get("ending_hook")):
        effects.append("后续悬念")
    if "关系升温" in signature.plot_function or "关系决裂" in signature.plot_function:
        effects.append("关系张力")
    if has_any(
        text_blob(plot.get("summary"), plot.get("detailed_summary"), plot.get("key_events")),
        BETRAYAL_TERMS + NEW_RELATION_TERMS,
    ):
        effects.append("修罗场期待")
    return dedupe_items(effects)


def infer_character_slot(character: dict[str, Any], plot: dict[str, Any]) -> str:
    role = text_blob(character.get("role_in_plot"), character.get("state_change"), character.get("name"))
    if "主角" in role:
        return "protagonist"
    if has_any(role, ("旧", "前任", "男友", "未婚夫", "出轨", "羞辱", "反派", "对抗", "控制")):
        return "old_relation_oppressor"
    if has_any(role, ("新关系", "富商", "追求", "保护", "帮助", "暧昧", "伴侣", "介入")):
        return "new_relation_intervener"
    if has_any(role, ("朋友", "盟友", "帮助", "支持")):
        return "ally_or_supporter"
    if has_any(role, ("敌", "反派", "阻碍", "压迫")):
        return "antagonist_or_oppressor"
    plot_text = text_blob(plot.get("summary"), plot.get("detailed_summary"))
    name = as_text(character.get("name"))
    if name and plot_text.count(name) >= 2 and has_any(plot_text, NEW_RELATION_TERMS):
        return "relationship_axis_character"
    return "supporting_actor"


def role_bindings(plot: dict[str, Any]) -> dict[str, str]:
    bindings: dict[str, str] = {}
    for character in list_of_dicts(plot.get("characters_involved")):
        name = as_text(character.get("name"))
        if not name:
            continue
        slot = infer_character_slot(character, plot)
        bindings.setdefault(slot, name)
    return bindings


def template_family(plot: dict[str, Any], signature: PlotSignature) -> str:
    blob = text_blob(
        plot.get("summary"),
        plot.get("detailed_summary"),
        plot.get("key_events"),
        plot.get("conflict_model"),
        plot.get("payoff_and_hook"),
    )
    if has_any(blob, PUBLIC_PRESSURE_TERMS) and has_any(blob, BETRAYAL_TERMS + NEW_RELATION_TERMS):
        return "public_humiliation_relationship_counterattack"
    if has_any(blob, PUBLIC_PRESSURE_TERMS):
        return "public_pressure_value_reversal"
    if has_any(blob, BETRAYAL_TERMS) and has_any(blob, NEW_RELATION_TERMS):
        return "betrayal_to_new_relation_disruption"
    if has_any(blob, SECRET_TERMS):
        return "secret_reveal_reframes_relationship"
    if has_any(blob, RESCUE_TERMS):
        return "crisis_rescue_power_intervention"
    if has_any(blob, POWER_TERMS):
        return "power_structure_pressure_reversal"
    if "资源争夺驱动" in signature.driving_force:
        return "resource_contest_status_shift"
    return "plot_turning_pattern"


def signal_tags(plot: dict[str, Any], signature: PlotSignature) -> list[str]:
    blob = text_blob(
        plot.get("summary"),
        plot.get("detailed_summary"),
        plot.get("key_events"),
        plot.get("relationship_changes"),
        plot.get("conflict_model"),
        plot.get("payoff_and_hook"),
    )
    tags: list[str] = []
    tag_rules = [
        ("public_pressure", PUBLIC_PRESSURE_TERMS),
        ("betrayal_pressure", BETRAYAL_TERMS),
        ("new_relation_intervention", NEW_RELATION_TERMS),
        ("crisis_rescue", RESCUE_TERMS),
        ("secret_reveal", SECRET_TERMS),
        ("power_structure", POWER_TERMS),
    ]
    for tag, terms in tag_rules:
        if has_any(blob, terms):
            tags.append(tag)
    if "反击" in blob or "打脸" in blob:
        tags.append("counterattack")
    if "证据" in blob or "澄清" in blob:
        tags.append("evidence_flip")
    if "身份" in blob:
        tags.append("identity_reveal")
    if "追悔" in blob or "后悔" in blob:
        tags.append("regret_hook")
    if "关系升温" in signature.plot_function:
        tags.append("relationship_warmup")
    if "关系决裂" in signature.plot_function or "关系降温" in signature.plot_function:
        tags.append("relationship_break_or_cooldown")
    if as_list(as_mapping(plot.get("payoff_and_hook")).get("reader_payoffs")):
        tags.append("payoff_release")
    if as_list(as_mapping(plot.get("payoff_and_hook")).get("angst_points")):
        tags.append("angst_pressure")
    if as_list(as_mapping(plot.get("payoff_and_hook")).get("suspense_hooks")) or as_text(as_mapping(plot.get("payoff_and_hook")).get("ending_hook")):
        tags.append("suspense_hook")
    tags.extend(f"function:{item}" for item in signature.plot_function[:4])
    tags.extend(f"drive:{item}" for item in signature.driving_force[:3])
    return dedupe_items(tags)


def macro_pattern(plot: dict[str, Any], signature: PlotSignature, *, dimension: str) -> str:
    tags = set(signal_tags(plot, signature))
    if dimension == EVENTS_LIBRARY:
        if "secret_reveal" in tags:
            return "秘密揭露转折事件"
        if "crisis_rescue" in tags:
            return "危机介入事件"
        if "public_pressure" in tags:
            return "公开压迫反击事件"
        if "power_structure" in tags:
            return "权力结构反制事件"
        if "betrayal_pressure" in tags or "new_relation_intervention" in tags:
            return "关系秩序重排事件"
        return "阶段转折事件"
    if dimension == PAYOFF_ANGST:
        if "public_pressure" in tags and "payoff_release" in tags:
            return "评价权反转爽点"
        if "crisis_rescue" in tags:
            return "安全感确认爽点"
        if "secret_reveal" in tags:
            return "认知反转/揭露爽点"
        if "angst_pressure" in tags and "payoff_release" not in tags:
            return "持续压迫刀点"
        return "阶段压力释放机制"
    if dimension == EMOTION_RHYTHM:
        if "secret_reveal" in tags:
            return "秘密-揭露情绪曲线"
        if "crisis_rescue" in tags:
            return "失控-依赖情绪曲线"
        if "public_pressure" in tags and "payoff_release" in tags:
            return "压迫-释放情绪曲线"
        if "relationship_break_or_cooldown" in tags:
            return "关系断裂情绪曲线"
        return "悬念延迟情绪曲线"
    return template_family(plot, signature)


def micro_pattern(tags: list[str], *, dimension: str) -> str:
    selected: list[str] = []
    tag_labels = {
        "public_pressure": "公开压迫",
        "betrayal_pressure": "背叛压力",
        "new_relation_intervention": "新关系介入",
        "crisis_rescue": "危机救场",
        "secret_reveal": "秘密揭露",
        "power_structure": "权力结构",
        "counterattack": "反击",
        "evidence_flip": "证据翻盘",
        "identity_reveal": "身份揭露",
        "regret_hook": "追悔钩子",
        "relationship_warmup": "关系升温",
        "relationship_break_or_cooldown": "关系降温/决裂",
        "payoff_release": "释放",
        "angst_pressure": "压迫",
        "suspense_hook": "悬念钩子",
    }
    priority = [
        "public_pressure",
        "crisis_rescue",
        "secret_reveal",
        "betrayal_pressure",
        "new_relation_intervention",
        "power_structure",
        "evidence_flip",
        "identity_reveal",
        "counterattack",
        "relationship_warmup",
        "relationship_break_or_cooldown",
        "payoff_release",
        "angst_pressure",
        "suspense_hook",
    ]
    tag_set = set(tags)
    for tag in priority:
        if tag in tag_set:
            selected.append(tag_labels[tag])
    if not selected:
        selected.append("阶段转折")
    suffix = {
        EVENTS_LIBRARY: "事件模板",
        PAYOFF_ANGST: "爽虐机制",
        EMOTION_RHYTHM: "情绪曲线",
    }.get(dimension, "模板")
    return " + ".join(selected[:5]) + suffix


def template_seed(plot: dict[str, Any], signature: PlotSignature, *, dimension: str) -> dict[str, Any]:
    tags = signal_tags(plot, signature)
    macro = macro_pattern(plot, signature, dimension=dimension)
    micro = micro_pattern(tags, dimension=dimension)
    signature_terms = [
        macro,
        micro,
        *[tag for tag in tags if not tag.startswith("function:") and not tag.startswith("drive:")],
        *[f"role:{slot}" for slot in role_bindings(plot).keys()],
    ]
    return {
        "template_name": micro,
        "macro_pattern": macro,
        "micro_pattern": micro,
        "signature_terms": dedupe_items(signature_terms),
    }


def resolve_template(
    registry: object | None,
    *,
    dimension: str,
    plot: dict[str, Any],
    signature: PlotSignature,
    source_ref: dict[str, Any] | None = None,
) -> dict[str, Any]:
    seed = template_seed(plot, signature, dimension=dimension)
    if registry is None:
        return {
            "template_id": f"{dimension.lower()}_standalone",
            "template_name": seed["template_name"],
            "macro_pattern": seed["macro_pattern"],
            "micro_pattern": seed["micro_pattern"],
            "signature_terms": seed["signature_terms"],
            "support_count": 1,
            "template_match": {"status": "standalone", "similarity": 0.0, "threshold": 0.0},
        }
    return registry.resolve(dimension, seed, source_ref=source_ref)


def event_template(
    plot: dict[str, Any],
    signature: PlotSignature,
    *,
    registry: object | None = None,
    source_ref: dict[str, Any] | None = None,
) -> dict[str, Any]:
    family = template_family(plot, signature)
    effects = reader_effects(plot, signature)
    template = resolve_template(
        registry,
        dimension=EVENTS_LIBRARY,
        plot=plot,
        signature=signature,
        source_ref=source_ref,
    )
    tags = set(signal_tags(plot, signature))
    role_slots = inferred_role_slots(tags, plot)
    payload = {
        "template_id": template["template_id"],
        "template_name": template["template_name"],
        "macro_pattern": template["macro_pattern"],
        "micro_pattern": template["micro_pattern"],
        "template_match": template["template_match"],
        "support_count": template.get("support_count", 1),
        "event_template": event_template_sentence(tags),
        "trigger_condition": trigger_condition(tags),
        "role_slots": role_slots,
        "action_sequence": action_sequence(tags),
        "consequence": consequence_text(tags),
    }
    return {
        **payload,
        "narrative_function": dedupe_items([*signature.plot_function, *signature.driving_force]),
        "reader_effect": effects,
        "transferable_genres": transferable_genres(family),
        "failure_risks": failure_risks(family),
    }


def inferred_role_slots(tags: set[str], plot: dict[str, Any]) -> dict[str, str]:
    slots = {
        "protagonist": "承担压力并推动局势改变的一方",
        "opposing_force": "制造压力、阻碍或评价权的一方",
        "affected_character": "因事件结果改变关系或状态的一方",
    }
    if "public_pressure" in tags:
        slots["public_audience"] = "见证评价变化的人群"
    if "new_relation_intervention" in tags or "crisis_rescue" in tags:
        slots["intervener"] = "提供新资源、保护或关系张力的一方"
    if "betrayal_pressure" in tags:
        slots["old_relation"] = "背叛、控制或仍试图评价主角的旧关系对象"
    if "secret_reveal" in tags:
        slots["secret_holder"] = "掌握、隐瞒或揭露关键信息的人"
    if "power_structure" in tags:
        slots["power_holder"] = "掌握资源分配、组织规则或评价权的一方"
    bindings = role_bindings(plot)
    if bindings:
        slots["source_role_bindings"] = ", ".join(f"{slot}={name}" for slot, name in bindings.items())
    return slots


def event_template_sentence(tags: set[str]) -> str:
    if "secret_reveal" in tags:
        return "隐藏信息被揭露后，角色关系、目标或局势评价被重新定义"
    if "crisis_rescue" in tags:
        return "角色陷入外部压力或危机时，新资源或强势关系介入改变困境"
    if "public_pressure" in tags and "counterattack" in tags:
        return "被压低价值的一方在可见评价场中完成反击或评价权反转"
    if "betrayal_pressure" in tags and "new_relation_intervention" in tags:
        return "旧关系伤害后，新关系或新资源介入并重排原有关系秩序"
    if "power_structure" in tags:
        return "角色借助新资源反制组织、资本、家族或阶层压力"
    return "一组行动改变角色关系、问题状态或冲突方向"


def trigger_condition(tags: set[str]) -> str:
    conditions: list[str] = []
    if "public_pressure" in tags:
        conditions.append("角色被公开评价、羞辱或压低价值")
    if "betrayal_pressure" in tags:
        conditions.append("旧关系已经造成背叛、控制或信任损伤")
    if "crisis_rescue" in tags:
        conditions.append("角色暂时无法凭当前资源独自脱困")
    if "secret_reveal" in tags:
        conditions.append("关键身份、事实或动机长期被隐藏")
    if "power_structure" in tags:
        conditions.append("组织、资本、家族或阶层规则限制行动空间")
    return "；".join(conditions) or "当前 plot 已积累未解决压力或行动目标"


def action_sequence(tags: set[str]) -> list[str]:
    sequence = ["压力或目标被明确"]
    if "public_pressure" in tags:
        sequence.append("评价权掌握者公开施压")
    if "betrayal_pressure" in tags:
        sequence.append("旧关系伤害成为行动动机")
    if "secret_reveal" in tags:
        sequence.append("隐藏信息浮出并改变判断")
    if "new_relation_intervention" in tags or "crisis_rescue" in tags:
        sequence.append("新关系、盟友或资源介入")
    if "counterattack" in tags or "evidence_flip" in tags or "identity_reveal" in tags:
        sequence.append("主角用行动、证据或身份改变局势")
    sequence.append("关系、评价权或问题状态发生变化")
    return dedupe_items(sequence)


def consequence_text(tags: set[str]) -> str:
    consequences: list[str] = []
    if "public_pressure" in tags or "counterattack" in tags:
        consequences.append("原评价权受损，主角价值被重新确认")
    if "new_relation_intervention" in tags:
        consequences.append("新关系获得叙事正当性并制造后续张力")
    if "secret_reveal" in tags:
        consequences.append("读者和角色认知被刷新，新问题替代旧问题")
    if "crisis_rescue" in tags:
        consequences.append("危机暂时解除，但保护关系或依赖代价被建立")
    if "power_structure" in tags:
        consequences.append("更大层级的权力冲突被打开")
    return "；".join(consequences) or "plot 进入下一阶段"


def transferable_genres(family: str) -> list[str]:
    if family in {
        "public_humiliation_relationship_counterattack",
        "betrayal_to_new_relation_disruption",
    }:
        return ["都市言情", "退婚流", "豪门复仇", "职场权力关系", "修仙宗门关系线"]
    if family in {"resource_contest_status_shift", "power_structure_pressure_reversal"}:
        return ["升级流", "修仙宗门", "职场经营", "权谋", "系统任务"]
    if family == "secret_reveal_reframes_relationship":
        return ["悬疑言情", "权谋", "身份揭露", "复仇线"]
    return ["长篇主线", "关系线", "阶段冲突"]


def failure_risks(family: str) -> list[str]:
    risks = ["只复述具体事件而没有改变关系/局势"]
    if family.startswith("public_") or family == "betrayal_to_new_relation_disruption":
        risks.extend(["反派过度降智", "新关系对象替主角完成全部反击，削弱主角主动性"])
    if family == "crisis_rescue_power_intervention":
        risks.append("救援过强会让主角失去行动权")
    if family == "secret_reveal_reframes_relationship":
        risks.append("秘密揭露后没有带来新选择或新代价")
    return dedupe_items(risks)


def payoff_pattern(
    plot: dict[str, Any],
    signature: PlotSignature,
    *,
    registry: object | None = None,
    source_ref: dict[str, Any] | None = None,
) -> dict[str, Any]:
    conflict = as_mapping(plot.get("conflict_model"))
    payoff = as_mapping(plot.get("payoff_and_hook"))
    family = template_family(plot, signature)
    has_payoff = bool(as_list(payoff.get("reader_payoffs")))
    has_angst = bool(as_list(payoff.get("angst_points")))
    polarity = "mixed" if has_payoff and has_angst else ("payoff" if has_payoff else "angst")
    event_payload = event_template(plot, signature)
    template = resolve_template(
        registry,
        dimension=PAYOFF_ANGST,
        plot=plot,
        signature=signature,
        source_ref=source_ref,
    )
    return {
        "template_id": template["template_id"],
        "pattern_name": template["template_name"],
        "macro_pattern": template["macro_pattern"],
        "micro_pattern": template["micro_pattern"],
        "template_match": template["template_match"],
        "support_count": template.get("support_count", 1),
        "polarity": polarity,
        "pressure_setup": as_text(conflict.get("surface_conflict")) or event_payload["trigger_condition"],
        "delay_mechanism": delay_mechanism(family, has_angst=has_angst),
        "release_or_damage_action": release_action(family, has_payoff=has_payoff),
        "reader_reward_or_pain": reader_effects(plot, signature),
        "state_change_after": event_payload["consequence"],
        "role_slots": event_payload.get("role_slots", {}),
        "required_conditions": required_conditions(family),
        "failure_risks": failure_risks(family),
        "transferable_form": event_payload["event_template"],
    }


def delay_mechanism(family: str, *, has_angst: bool) -> str:
    if family.startswith("public_"):
        return "主角先承受公开评价和名誉损伤，反击被延迟到证据、资源或关系介入出现时"
    if family == "betrayal_to_new_relation_disruption":
        return "旧关系伤害先造成情绪压抑，新关系介入延迟到主角需要重建价值感时"
    if family == "secret_reveal_reframes_relationship":
        return "关键信息被隐藏或误读，读者等待真相改变局势"
    if has_angst:
        return "压力持续累积，角色暂时无法立即修复损失"
    return "冲突先设置代价，再用行动改变局势"


def release_action(family: str, *, has_payoff: bool) -> str:
    if family.startswith("public_"):
        return "公开反击、证据亮出、强势关系介入或评价权反转"
    if family == "betrayal_to_new_relation_disruption":
        return "主角不再按旧关系秩序行动，转向新关系或新资源"
    if family == "crisis_rescue_power_intervention":
        return "保护者或新资源介入解除危机"
    if family == "secret_reveal_reframes_relationship":
        return "真相揭露迫使角色重新判断"
    return "阶段行动改变问题状态" if has_payoff else "压力继续损伤角色状态"


def required_conditions(family: str) -> list[str]:
    if family.startswith("public_"):
        return ["压迫或羞辱必须可见", "主角必须有真实受损", "反击必须改变评价权或资源格局"]
    if family == "betrayal_to_new_relation_disruption":
        return ["旧关系的背叛或控制要清晰", "新关系不能只做装饰", "主角需要保留选择权"]
    if family == "secret_reveal_reframes_relationship":
        return ["秘密必须影响角色选择", "揭露后要带来新代价或新问题"]
    return ["前置压力明确", "行动造成可追踪后果"]


def character_arc_template(character: dict[str, Any], plot: dict[str, Any], signature: PlotSignature) -> dict[str, Any]:
    slot = infer_character_slot(character, plot)
    state_change = as_text(character.get("state_change"))
    role = as_text(character.get("role_in_plot"))
    family = template_family(plot, signature)
    if slot == "protagonist" and has_any(state_change + role, ("报复", "背叛", "情感", "信任", "价值")):
        arc_template = "被背叛者从防御性反击走向主体性恢复"
        initial_state = "情感受损或价值被否定，以防御和反击作为行动动力"
        final_state = "重新获得价值确认，但可能进入新的情感或权力纠葛"
        arc_function = ["主体性恢复", "关系重建", "主线行动启动"]
    elif slot in {"old_relation_oppressor", "antagonist_or_oppressor"}:
        arc_template = "评价权掌握者从压迫者转为失去控制者"
        initial_state = "掌握评价权、资源或旧关系控制权"
        final_state = "权威受损，控制失败，后续追悔或对抗升级"
        arc_function = ["反派压迫", "价值反转", "追悔/对抗启动"]
    elif slot in {"new_relation_intervener", "ally_or_supporter", "relationship_axis_character"}:
        arc_template = "强势介入者从外部资源转为关系轴心"
        initial_state = "以保护者、盟友或高价值对象身份介入"
        final_state = "与主角形成更强绑定，同时制造新的关系张力"
        arc_function = ["保护确认", "恋爱线启动", "阵营绑定"]
    else:
        arc_template = "配角状态推动局部关系变化"
        initial_state = "作为局部冲突参与者出现"
        final_state = "因 plot 行动改变站位或关系功能"
        arc_function = ["局部推进"]
    return {
        "character_slot": slot,
        "arc_template": arc_template,
        "initial_state": initial_state,
        "external_pressure": pressure_summary(plot),
        "turning_action": release_action(family, has_payoff=bool(as_list(as_mapping(plot.get("payoff_and_hook")).get("reader_payoffs")))),
        "final_state": final_state,
        "arc_function": arc_function,
        "failure_risk": "如果角色只保留姓名和动作，不改变选择、关系或行动权限，人物弧会退化成剧情摘要",
    }


def pressure_summary(plot: dict[str, Any]) -> str:
    conflict = as_mapping(plot.get("conflict_model"))
    return as_text(conflict.get("surface_conflict")) or as_text(conflict.get("deep_conflict")) or "plot 内部压力推动角色改变"


def relationship_template(change: dict[str, Any], plot: dict[str, Any], signature: PlotSignature) -> dict[str, Any]:
    change_type = as_text(change.get("change_type")) or "关系变化"
    before = as_text(change.get("before"))
    after = as_text(change.get("after"))
    if "升温" in change_type or "暧昧" in after:
        template_name = "压迫情境中的关系升温"
        relation_function = ["保护确认", "情感绑定", "后续选择钩子"]
    elif "决裂" in change_type or "对抗" in after:
        template_name = "旧关系评价权崩塌"
        relation_function = ["关系切断", "对抗升级", "追悔空间"]
    else:
        template_name = "关系状态重排"
        relation_function = ["关系推进"]
    return {
        "relationship_template": template_name,
        "role_slots": role_bindings(plot),
        "before_state": before or "原关系秩序",
        "after_state": after or "新关系秩序",
        "change_driver": as_text(change.get("cause")) or pressure_summary(plot),
        "relation_function": relation_function,
        "reuse_note": "迁移时保留关系功能和变化方向，替换具体人物身份与场景外壳",
    }


def emotion_pattern(
    plot: dict[str, Any],
    signature: PlotSignature,
    beats: list[str],
    *,
    registry: object | None = None,
    source_ref: dict[str, Any] | None = None,
) -> dict[str, Any]:
    family = template_family(plot, signature)
    effects = reader_effects(plot, signature)
    template = resolve_template(
        registry,
        dimension=EMOTION_RHYTHM,
        plot=plot,
        signature=signature,
        source_ref=source_ref,
    )
    curve = []
    beat_state = {
        "hook_open": "好奇/关系危险感",
        "tension_setup": "压抑/等待反击",
        "pressure_escalation": "愤怒/替主角不值",
        "angst_pressure": "疼痛/担忧损失扩大",
        "relationship_warmup": "关系张力/安全感上升",
        "relationship_cooldown": "失落/不确定",
        "payoff_release": "爽感释放/价值确认",
        "suspense_hook": "期待下一轮选择或反转",
        "transition_buffer": "短暂缓冲",
    }
    for beat in beats:
        curve.append({"beat": beat, "reader_state": beat_state.get(beat, "情绪推进")})
    return {
        "template_id": template["template_id"],
        "emotion_pattern_name": template["template_name"],
        "macro_pattern": template["macro_pattern"],
        "micro_pattern": template["micro_pattern"],
        "template_match": template["template_match"],
        "support_count": template.get("support_count", 1),
        "emotion_curve": curve,
        "rhythm_type": rhythm_type(beats),
        "tension_accumulation": tension_accumulation(beats),
        "release_position": "plot_end" if beats and beats[-1] in {"payoff_release", "suspense_hook"} else "plot_middle",
        "reader_state_change": " -> ".join(dedupe_items([item["reader_state"] for item in curve])),
        "emotional_core": emotional_core(plot, family),
        "reuse_note": "迁移时保留压迫、释放和钩子的相对顺序，不保留具体人物名和场景名",
        "reader_effect": effects,
    }


def rhythm_type(beats: list[str]) -> str:
    if "payoff_release" in beats and ("pressure_escalation" in beats or "angst_pressure" in beats):
        return "短周期压迫-释放"
    if "suspense_hook" in beats and "payoff_release" not in beats:
        return "悬念延迟"
    if "relationship_warmup" in beats:
        return "关系推进"
    return "情绪转场"


def tension_accumulation(beats: list[str]) -> str:
    if "angst_pressure" in beats and "payoff_release" in beats:
        return "先堆叠情感/名誉损伤，再用行动释放"
    if "pressure_escalation" in beats:
        return "冲突逐步升级，读者等待局势反转"
    return "轻量情绪推进"


def emotional_core(plot: dict[str, Any], family: str) -> str:
    hint = as_mapping(plot.get("abstraction_hint"))
    cores = as_list(hint.get("possible_emotional_core"))
    if cores:
        return " / ".join(cores[:2])
    if family.startswith("public_"):
        return "被压低价值后的自我确认"
    if family == "betrayal_to_new_relation_disruption":
        return "被背叛后的关系重建"
    return "压力下的选择和状态改变"


def trope_surface(plot: dict[str, Any], signature: PlotSignature) -> dict[str, Any]:
    hint = as_mapping(plot.get("abstraction_hint"))
    return {
        "surface_type": "trope_surface_hint",
        "trope_labels": as_list(hint.get("possible_tropes")),
        "emotional_core": as_list(hint.get("possible_emotional_core")),
        "transferable_pattern": as_text(hint.get("possible_transferable_pattern")),
        "recommended_library_name": "TropeSurface",
        "not_meme_reason": "该对象来自 plot abstraction_hint，不是外部热梗、标题话术或平台语气样本",
        "reuse_note": "只能作为套路外壳候选；真正 Memes 需要标题库、热梗库或平台语料补充",
    }


def worldview_mechanism(plot: dict[str, Any], signature: PlotSignature) -> dict[str, Any]:
    blob = text_blob(plot.get("summary"), plot.get("detailed_summary"), plot.get("conflict_model"))
    return {
        "worldview_mechanism": "稳定规则或组织机制对角色行动权限的限制",
        "rule": first_matching_rule(blob),
        "constraint": "角色必须在该规则、等级、系统或组织结构内行动",
        "cost": pressure_summary(plot),
        "narrative_function": "制造可复用的行动限制、代价和突破空间",
        "confidence_note": "v1 only accepts explicit rule/system/organization signals; merge across plots before treating as stable worldview",
    }


def first_matching_rule(blob: str) -> str:
    for term in WORLD_RULE_TERMS:
        if term in blob:
            return f"围绕“{term}”形成的稳定行动规则"
    return "plot 中出现稳定机制信号，但具体规则仍需跨 plot 合并确认"
