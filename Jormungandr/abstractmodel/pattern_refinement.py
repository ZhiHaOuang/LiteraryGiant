from __future__ import annotations

import hashlib
import re
from collections import Counter
from typing import Any

from shared import as_list, as_mapping, as_text

from .instance_cards import build_source_ref, normalize_instance_card
from .variation import clean_variation_axes


LIBRARY_SPECS: dict[str, dict[str, Any]] = {
    "EventsLibrary": {
        "prefix": "EL",
        "perspective": "事件如何被触发、执行，并造成外部局势变化",
        "excluded": ["不解释读者为什么爽", "不展开人物长期成长", "不作为全书情绪曲线"],
        "focus_fields": ["event_trigger", "event_action_sequence", "event_consequence", "state_change"],
    },
    "PayoffAngst": {
        "prefix": "PA",
        "perspective": "压力、延迟与释放如何制造读者回报或疼痛",
        "excluded": ["不记录完整事件顺序", "不展开人物长期弧线", "不作为情绪曲线主条目"],
        "focus_fields": [
            "pressure_setup",
            "delay_mechanism",
            "release_or_damage_action",
            "reader_reward_or_pain",
            "required_emotional_setup",
        ],
    },
    "CharacterArc": {
        "prefix": "CA",
        "perspective": "角色状态、行动能力与关系功能如何跨阶段变化",
        "excluded": ["不写成事件列表", "不把单次爽点当人物弧", "不代替情绪节奏"],
        "focus_fields": [
            "arc_scope",
            "initial_state",
            "external_pressure",
            "turning_choice",
            "final_state",
            "arc_function",
            "relationship_consequence",
        ],
    },
    "EmotionRhythm": {
        "prefix": "ER",
        "perspective": "压力如何累积、延迟、释放、反转并形成后续情绪钩子",
        "excluded": ["不复述具体事件流程", "不代替人物完整成长", "不把一次事件结果当完整节奏"],
        "focus_fields": [
            "rhythm_scope",
            "emotion_start",
            "tension_accumulation",
            "delay_method",
            "release_position",
            "post_release_hook",
            "reader_state_change",
        ],
    },
    "Worldview": {
        "prefix": "WV",
        "perspective": "稳定规则、资源、身份权限、权力结构与代价如何反复约束故事",
        "excluded": ["不把一次剧情事件当稳定规则", "不记录纯氛围设定", "不代替事件机制"],
        "focus_fields": [
            "stable_rule",
            "rule_scope",
            "resource_or_permission",
            "constraint",
            "enforcement_mechanism",
            "cost",
            "affected_choices",
            "repeatability",
            "resource_distribution_logic",
            "cost_model",
            "who_benefits",
            "who_is_constrained",
            "story_conflicts_enabled",
        ],
    },
}


LIBRARY_FALLBACK_ROLE_SLOTS: dict[str, dict[str, str]] = {
    "EventsLibrary": {
        "event_initiator": "启动关键行动链的一方",
        "affected_party": "承受事件后果并发生状态变化的一方",
        "opposing_force": "阻止行动或维持原局势的一方或机制",
    },
    "PayoffAngst": {
        "emotion_anchor": "承受读者情绪投射与损失的一方",
        "pressure_source": "制造压力、延迟或伤害的一方或机制",
        "release_agent": "触发回报、痛感兑现或认知释放的一方或行动",
    },
    "CharacterArc": {
        "arc_subject": "经历初态、压力、选择与终态变化的核心角色",
        "pressure_source": "迫使角色无法维持初始状态的一方或机制",
        "turning_catalyst": "促成关键选择或认知转变的一方、事件或资源",
    },
    "EmotionRhythm": {
        "emotion_anchor": "承受读者情绪投射的一方",
        "pressure_source": "制造并维持情绪压力的事件、角色或规则",
        "release_agent": "带来释放、反转或暂时安全感的一方或行动",
        "hook_source": "在释放后制造新悬念或二次压力的因素",
    },
    "Worldview": {
        "rule_authority": "制定、掌握或执行稳定规则的一方或系统",
        "constrained_group": "选择持续受到规则限制的一方或群体",
        "resource_gate": "控制权限、资源或身份准入的机制",
    },
}


CANONICAL_ROLE_SLOTS: dict[str, dict[str, str]] = {
    "ability_awakening": {
        "ability_acquirer": "获得并激活新能力、因而被卷入更大冲突的一方",
        "ability_carrier": "承载能力并规定其使用边界的物品、系统或媒介",
        "knowledge_guide": "解释能力来源、用法或风险的一方",
        "opposing_force": "因能力暴露而追踪、压制或争夺的一方",
    },
    "insider_threat_strategic_withdrawal": {
        "decision_maker": "在信息不全时承担撤退决策责任的一方",
        "analysis_partner": "提供推演、情报校验或反对意见的一方",
        "suspected_insider": "使原有信任与防线失效的内部威胁",
        "protected_group": "需要被转移、保存或重新组织的人力与资源",
    },
    "public_confrontation_exposure": {
        "revealer": "主动把隐蔽矛盾带入公开场域的一方",
        "concealing_authority": "试图维持秘密、身份或既有叙事的一方",
        "witness_group": "放大揭露后果并改变群体判断的见证者",
    },
    "safe_haven_sacrifice_escape": {
        "protector": "在逃生链条中承担风险并可能牺牲的一方",
        "survivor": "因保护行动得以逃生并承担后续情感或使命的一方",
        "threat_source": "侵入安全区并迫使角色撤离的敌人或灾难",
        "late_support": "事后提供救援、见证或后续资源的一方",
    },
    "perfect_crime_investigation": {
        "investigator": "通过证据重建和实验推翻表面解释的一方",
        "offender": "利用误导结构隐藏真实行动与动机的一方",
        "victim": "其经历或隐藏信息构成调查因果核心的一方",
        "misdirecting_suspect": "承担错误解释、但可被证据排除的一方",
        "judging_authority": "决定调查方向或承认最终结论的机构或负责人",
    },
    "sacrifice_countdown_release": {
        "doomed_actor": "在时间或生命倒计时中坚持完成目标的一方",
        "unfinished_goal": "延迟情绪释放并赋予牺牲方向的真相、愿望或使命",
        "attachment_witness": "见证倒计时并承担离别余波的一方",
    },
    "legacy_inheritance_grief_release": {
        "sacrifice_source": "以牺牲留下情感债务与未竟目标的一方",
        "legacy_inheritor": "把悲恸转化为行动并承接遗志的一方",
        "unfinished_mission": "使痛感获得后续方向的承诺、责任或目标",
        "supporting_witness": "见证继承并帮助其转化为现实行动的一方",
    },
    "sacrifice_to_mission_identity_transformation": {
        "sacrifice_source": "以牺牲打断旧身份并留下责任的一方",
        "mission_inheritor": "把痛感转化为使命、因此重建身份的一方",
        "unfinished_mission": "连接牺牲与后续行动的承诺、责任或目标",
        "supporting_witness": "见证身份转变并协助使命落地的一方",
    },
    "trauma_disclosure_power_reversal": {
        "traumatized_authority": "通过暴露创伤重新组织威慑与权力的一方",
        "challenger": "因利益、生存或不信任而挑战原秩序的一方或群体",
        "trauma_trigger": "使隐蔽创伤进入冲突现场的媒介、记忆或事件",
        "witness_group": "其态度变化确认权力重构的一方",
    },
    "repeated_death_announcement_suspense": {
        "endangered_subject": "生死状态被反复宣布、否认或误读的关键角色",
        "information_controller": "控制死亡信息出现顺序与可信度的一方或机制",
        "emotional_proxy": "用反应承载读者希望、恐惧与失落的一方",
    },
    "false_accusation_correction_release": {
        "misjudged_subject": "因证据误读而承担冤屈或评价损失的一方",
        "investigator": "必须承认误判并重建证据链的一方",
        "actual_cause": "被早期解释遮蔽的真实责任方或因果机制",
        "evidence_trigger": "迫使旧判断失效并启动纠正的新证据或证人",
    },
    "sacrificial_revival_with_cost": {
        "loss_subject": "其死亡或不可逆损失把情绪推向绝境的一方",
        "revival_agent": "突破限制实施逆转并承担选择责任的一方",
        "revived_subject": "恢复生命却携带新代价或异化风险的一方",
        "cost_bearer": "直接或间接承受复活副作用的一方",
    },
    "pain_primed_power_reveal": {
        "risk_taker": "主动承受实验、训练或能力反噬以换取力量的一方",
        "facilitator": "提供技术、规则解释或最低安全保障的一方",
        "power_source": "产生痛感并最终兑现能力回报的资源或机制",
        "new_threat": "在爽点释放后立即恢复不确定性的风险来源",
    },
    "outsider_sacrifice_value_recognition": {
        "arc_subject": "从索取归属转向主动承担风险、以牺牲证明价值的一方",
        "reluctant_mentor": "起初保留接纳、后来承担内疚与评价修正的一方",
        "crisis_source": "迫使角色把归属转化为真实付出的危机",
    },
    "sacrifice_catalyzed_relational_reorientation": {
        "arc_subject": "因他人牺牲而改变情感判断、身份选择或行动方向的一方",
        "sacrifice_catalyst": "以不可逆损失触发人物关系与价值认知翻转的一方",
        "relationship_counterpart": "其关系位置因牺牲后果而被重新定义的一方",
    },
    "instrument_to_authority_through_regicide": {
        "instrumentalized_subject": "起初被更高权威利用、最终夺回规则制定权的一方",
        "incumbent_authority": "掌握旧秩序并试图维持控制的一方",
        "rule_revealer": "揭示晋升条件、责任或代价的一方或机制",
    },
    "dependency_to_independence_after_authority_loss": {
        "dependent_subject": "从被保护或追随状态转向独立承担责任的一方",
        "lost_authority": "其死亡、失踪或背叛打破原有依赖结构的一方",
        "challenge_source": "检验新主体性并迫使角色行动的危机",
    },
    "awakener_bond_identity_revelation": {
        "awakener": "主动唤醒、照顾并首先投入关系的一方",
        "awakened_subject": "携带秘密和能力、逐渐回应依恋的一方",
        "identity_pressure": "迫使隐藏身份进入关系判断的外部危机或旧势力",
    },
    "trust_collapse_strategic_reorientation": {
        "decision_maker": "因内部渗透而重估信任并改变战略的一方",
        "trusted_partner": "在信任收缩后仍能参与关键决策的一方",
        "suspected_insider": "使原联盟与防线失去可信度的一方或系统漏洞",
    },
    "ability_constraint_strategy_awakening": {
        "ability_holder": "从追求能力强度转向理解限制和策略的一方",
        "reflection_partner": "提供反馈并促成认知修正的同伴或导师",
        "constraint_source": "使粗暴使用能力失败的规则、副作用或环境",
    },
    "nominal_to_real_leadership_recovery": {
        "disempowered_leader": "保留名义身份但失去实际资源、后重新赢得指挥权的一方",
        "hidden_ally": "在危机中提供重新证明能力所需机会或资源的一方",
        "follower_group": "其信任与服从变化确认领导权恢复的群体",
    },
}


GENERALIZED_PATTERN_NAMES = {
    "instrument_to_authority_through_regicide": "工具性角色通过弑杀权威获得主体性",
    "awakener_bond_identity_revelation": "唤醒关系中的互依与身份重构",
    "nominal_to_real_leadership_recovery": "名义领导者在危机中恢复实权",
    "sacrificial_revival_with_cost": "复活逆转后的代价型痛感释放",
    "repeated_death_announcement_suspense": "生死信息反复翻转的悬念释放",
    "pain_primed_power_reveal": "痛感铺垫后的能力兑现与再加压",
}


DISPLAY_PATTERN_NAMES = {
    "collective_failure_sacrifice_lonely_settle": "集体失败后的牺牲与孤独沉降节奏",
    "political_sacrifice_assignment": "政治牺牲式任务派遣",
    "desperate_contract_reversal": "绝境契约反转",
    "bounty_elite_resource_exchange": "赏金精英资源交换",
    "sacrifice_awakens_buried_power": "牺牲触发潜藏力量觉醒",
    "bitter_victory_self_sacrifice": "苦涩胜利后的人质式自我牺牲",
    "sacrificial_revenge_ascension": "牺牲驱动的复仇晋升",
}


SLUG_TERMS = (
    ("牺牲引领的身份与使命转变", "sacrifice_to_mission_identity_transformation"),
    ("牺牲催化情感翻转", "sacrifice_catalyzed_relational_reorientation"),
    ("永恒压力驱动下的间歇释放与终极牺牲补偿", "persistent_pressure_interleaved_release_terminal_sacrifice"),
    ("从自我放弃到生存意志重建的阶段性疗愈", "despair_to_survival_will_recovery"),
    ("唤醒者与被唤醒者的情感依恋与身份揭秘", "awakener_bond_identity_revelation"),
    ("内部危机震慑破局后外部打断", "internal_crisis_deterrence_external_interrupt"),
    ("权威消失后的依赖型独立", "dependency_to_independence_after_authority_loss"),
    ("死亡-复活-疯狂反转", "death_revival_alienation_reversal"),
    ("指挥官信任塌陷与战略转向", "trust_collapse_strategic_reorientation"),
    ("闯入者牺牲价值证明", "outsider_sacrifice_value_recognition"),
    ("弑神晋升蜕变", "instrument_to_authority_through_regicide"),
    ("内鬼假设下的战略撤退", "insider_threat_strategic_withdrawal"),
    ("创伤震慑与权力转化", "trauma_disclosure_power_reversal"),
    ("反复死亡宣告", "repeated_death_announcement_suspense"),
    ("遗志继承痛感释放", "legacy_inheritance_grief_release"),
    ("牺牲倒计时释放", "sacrifice_countdown_release"),
    ("外部催化下的边界觉醒", "external_catalyst_boundary_awareness"),
    ("报复驱动转情感依赖", "revenge_to_attachment"),
    ("逃避自愈与亲密接纳", "escape_healing_intimacy_acceptance"),
    ("保护行动催化关系升级", "protective_action_commitment"),
    ("保护者脆弱下的权力再平衡", "protector_vulnerability_power_rebalance"),
    ("技术崩溃后的关键逆转", "technical_collapse_recovery"),
    ("创伤守护者的遗孤觉醒", "trauma_guardian_orphan_awakening"),
    ("牺牲复活后的使命承担", "revival_mission_ownership"),
    ("逝亲纪念与自我和解", "grief_self_reconciliation"),
    ("领导者道德觉醒", "leader_moral_awakening"),
    ("误导-澄清循环", "misdirection_clarification_cycle"),
    ("误导澄清循环", "misdirection_clarification_cycle"),
    ("内部叛乱", "internal_rebellion"),
    ("恐惧镇压", "fear_suppression"),
    ("阶梯式秘密揭露", "staged_secret_revelation"),
    ("多线压力收敛", "multi_pressure_convergence"),
    ("焦点释放", "focused_release"),
    ("临终陪伴", "end_of_life_companionship"),
    ("希望-失望", "hope_disappointment_oscillation"),
    ("推理解谜", "reasoning_mystery_cycle"),
    ("伪装权威身份", "disguised_authority"),
    ("制造混乱逃脱", "chaos_escape"),
    ("科技植入物", "technology_implant"),
    ("能力觉醒", "ability_awakening"),
    ("暴露风险链", "exposure_risk_chain"),
    ("误导排除", "misdirection_elimination"),
    ("推理实验破案", "reasoning_experiment_resolution"),
    ("内部背叛", "internal_betrayal"),
    ("权威惩罚", "authority_punishment"),
    ("压制下的反击", "suppression_counterattack"),
    ("升温后的外部破坏", "bonding_external_disruption"),
    ("高风险能力获取", "high_risk_ability_acquisition"),
    ("期待-痛感-代价释放", "expectation_pain_cost_release"),
    ("牺牲复位", "sacrifice_reversal"),
    ("负面激化", "negative_escalation"),
    ("逃生计划中断", "escape_plan_interruption"),
    ("希望-恐惧-释放", "hope_fear_release"),
    ("从被动依赖到主动选择", "dependency_to_agency"),
    ("从报复驱动到情感依赖", "revenge_to_attachment"),
    ("从被动接受到主动拒绝", "passive_to_refusal"),
    ("接受亲密与自爱", "intimacy_self_love"),
    ("关系权力再平衡", "relationship_power_rebalance"),
    ("关系承诺升级", "commitment_escalation"),
    ("家庭内部财物失窃", "family_asset_theft"),
    ("公开恋情", "public_romance"),
    ("公开表白", "public_confession"),
    ("被拒", "rejection"),
    ("公开羞辱", "public_humiliation"),
    ("独立宣言", "independence_declaration"),
    ("浪漫宣示", "romantic_declaration"),
    ("外部危机", "external_crisis"),
    ("外部威胁", "external_threat"),
    ("外部介入", "external_intervention"),
    ("外部干扰", "external_interference"),
    ("职场冲突", "workplace_conflict"),
    ("过去创伤", "past_trauma"),
    ("关系张力", "relationship_tension"),
    ("丑闻", "scandal"),
    ("谈判筹码", "bargaining_leverage"),
    ("旧案调查", "cold_case_investigation"),
    ("公开反击", "public_counterattack"),
    ("法律维权", "legal_defense"),
    ("权力介入", "power_intervention"),
    ("惩罚骚扰者", "harasser_punishment"),
    ("保护者介入", "protector_intervention"),
    ("欺凌事件", "bullying_event"),
    ("旅行疗愈", "travel_healing"),
    ("关系升温", "relationship_deepening"),
    ("引爆冲突", "conflict_escalation"),
    ("关系测试", "relationship_test"),
    ("边界侵犯", "boundary_violation"),
    ("主动行动", "active_response"),
    ("悬念保留", "suspense_retention"),
    ("悬念", "suspense"),
    ("合作方缺陷", "partner_failure"),
    ("资源调用", "resource_activation"),
    ("替代解决", "replacement_resolution"),
    ("反转打脸", "reversal_payoff"),
    ("情感补偿", "emotional_compensation"),
    ("保护与信任重建", "protection_trust_rebuild"),
)


TAXONOMY_RULES: dict[str, tuple[tuple[tuple[str, ...], str, str], ...]] = {
    "EventsLibrary": (
        (("insider_threat_strategic_withdrawal",), "insider_threat_strategic_withdrawal", "strategic_response_event"),
        (("scandal", "bargaining"), "scandal_leverage_negotiation", "information_power_exchange"),
        (("cold_case", "investigation"), "historical_truth_investigation", "truth_revelation_and_repair"),
        (("public_counterattack", "legal_defense"), "public_evidence_legal_counterattack", "public_evaluation_reversal"),
        (("external_interference",), "relationship_external_stress_test", "relationship_pressure_event"),
        (("external_threat", "relationship_deepening"), "threat_protection_bonding", "crisis_driven_relationship_change"),
        (("power_intervention", "harasser_punishment"), "power_backed_harassment_punishment", "hierarchical_intervention"),
        (("protector_intervention", "bullying_event"), "protector_bullying_intervention", "crisis_driven_relationship_change"),
        (("travel_healing",), "shared_journey_healing", "relationship_repair_event"),
        (("relationship_deepening",), "care_intervention_relationship_deepening", "relationship_repair_event"),
        (("external_threat",), "external_threat_protection_response", "crisis_driven_relationship_change"),
        (("disguised_authority", "chaos_escape"), "disguised_authority_chaos_escape", "deception_and_escape"),
        (("technology_implant", "ability_awakening"), "implant_awakening_exposure_chain", "capability_activation_event"),
        (("misdirection_elimination", "reasoning_experiment"), "misdirection_elimination_reasoning_resolution", "truth_revelation_and_repair"),
    ),
    "PayoffAngst": (
        (("sacrifice_to_mission_identity_transformation",), "sacrifice_to_mission_identity_transformation", "sacrifice_and_consequence"),
        (("sacrifice_countdown_release",), "sacrifice_countdown_release", "sacrifice_and_consequence"),
        (("legacy_inheritance_grief_release",), "legacy_inheritance_grief_release", "grief_and_legacy"),
        (("trauma_disclosure_power_reversal",), "trauma_disclosure_power_reversal", "trauma_and_power"),
        (("repeated_death_announcement_suspense",), "repeated_death_announcement_suspense", "survival_uncertainty"),
        (("family_asset_theft",), "family_betrayal_punishment_payoff", "betrayal_and_retribution"),
        (("public_romance",), "public_relationship_exposure_backlash", "public_opinion_pressure_release"),
        (("public_humiliation",), "public_humiliation_reversal_payoff", "public_evaluation_reversal"),
        (("independence_declaration",), "boundary_assertion_payoff", "agency_reclamation"),
        (("romantic_declaration", "external_threat"), "romantic_declaration_under_threat", "relationship_pressure_release"),
        (("external_intervention", "conflict_escalation"), "relationship_intervention_conflict_payoff", "relationship_pressure_release"),
        (("public_confession", "rejection"), "public_confession_rejection_suspense", "romantic_expectation_delay"),
        (("external_crisis", "trust_rebuild"), "crisis_protection_trust_payoff", "safety_and_trust_confirmation"),
        (("workplace_conflict",), "workplace_resource_reversal_payoff", "resource_power_reversal"),
        (("past_trauma", "emotional_compensation"), "trauma_revelation_compensation", "trauma_and_emotional_repair"),
        (("relationship_tension",), "relationship_tension_release", "relationship_pressure_release"),
        (("internal_betrayal", "authority_punishment"), "family_betrayal_authority_punishment", "betrayal_and_retribution"),
        (("suppression_counterattack",), "suppression_counterattack_release", "agency_reclamation"),
        (("bonding_external_disruption",), "bonding_disrupted_by_external_pressure", "relationship_pressure_release"),
        (("high_risk_ability",), "high_risk_power_gain_cost_release", "power_gain_and_cost"),
        (("sacrifice_reversal",), "sacrifice_reversal_negative_cost", "sacrifice_and_consequence"),
        (("escape_plan_interruption",), "escape_interruption_hope_fear_release", "survival_pressure_release"),
    ),
    "CharacterArc": (
        (("sacrifice_catalyzed_relational_reorientation",), "sacrifice_catalyzed_relational_reorientation", "sacrifice_driven_identity_change"),
        (("outsider_sacrifice_value_recognition",), "outsider_sacrifice_value_recognition", "sacrifice_driven_identity_change"),
        (("instrument_to_authority_through_regicide",), "instrument_to_authority_through_regicide", "power_and_identity_transformation"),
        (("dependency_to_independence_after_authority_loss",), "dependency_to_independence_after_authority_loss", "autonomy_recovery"),
        (("awakener_bond_identity_revelation",), "awakener_bond_identity_revelation", "relational_identity_reorientation"),
        (("trust_collapse_strategic_reorientation",), "trust_collapse_strategic_reorientation", "leadership_adaptation"),
        (("dependency_to_agency",), "dependency_to_agentic_boundary", "autonomy_recovery"),
        (("revenge_to_attachment",), "revenge_to_genuine_attachment", "relational_reorientation"),
        (("passive_to_refusal",), "passive_acceptance_to_active_refusal", "autonomy_recovery"),
        (("intimacy_self_love",), "escape_to_intimacy_and_self_acceptance", "trauma_recovery"),
        (("commitment_escalation",), "external_challenge_to_commitment", "commitment_formation"),
        (("relationship_power_rebalance",), "protector_vulnerability_power_rebalance", "relationship_power_change"),
        (("external_catalyst_boundary_awareness",), "dependency_to_agentic_boundary", "autonomy_recovery"),
        (("escape_healing_intimacy_acceptance",), "escape_to_intimacy_and_self_acceptance", "trauma_recovery"),
        (("protective_action_commitment",), "protection_to_reciprocal_commitment", "commitment_formation"),
        (("protector_vulnerability_power_rebalance",), "protector_vulnerability_power_rebalance", "relationship_power_change"),
        (("technical_collapse_recovery",), "system_failure_to_capability_recovery", "capability_reconstruction"),
        (("trauma_guardian_orphan_awakening",), "inherited_trauma_to_protective_agency", "legacy_and_responsibility"),
        (("revival_mission_ownership",), "restored_life_to_mission_ownership", "mission_formation"),
        (("grief_self_reconciliation",), "grief_to_self_reconciliation", "grief_integration"),
        (("leader_moral_awakening",), "authority_to_moral_responsibility", "moral_accountability"),
    ),
    "EmotionRhythm": (
        (("persistent_pressure_interleaved_release_terminal_sacrifice",), "persistent_pressure_interleaved_release_terminal_sacrifice", "book_emotion_curve"),
        (("despair_to_survival_will_recovery",), "despair_to_survival_will_recovery", "recovery_stage_curve"),
        (("death_revival_alienation_reversal",), "death_revival_alienation_reversal", "existential_reversal_rhythm"),
        (("internal_crisis_deterrence_external_interrupt",), "internal_crisis_deterrence_external_interrupt", "compound_crisis_rhythm"),
        (("boundary_violation",), "boundary_violation_action_suspense_cycle", "boundary_pressure_release"),
        (("partner_failure", "resource_activation"), "task_failure_resource_substitution_cycle", "task_pressure_release"),
        (("misdirection_clarification_cycle",), "misdirection_clarification_reasoning_cycle", "cognitive_suspense_release"),
        (("internal_rebellion", "fear_suppression"), "rebellion_fear_suppression_moral_cost", "coercive_pressure_rhythm"),
        (("staged_secret_revelation",), "staged_secret_revelation_suspense", "cognitive_suspense_release"),
        (("multi_pressure_convergence", "focused_release"), "multi_pressure_convergence_release", "convergent_pressure_release"),
        (("end_of_life_companionship",), "end_of_life_hope_grief_release", "grief_and_catharsis"),
        (("reasoning_mystery_cycle",), "reasoning_misdirection_clarification_cycle", "cognitive_suspense_release"),
    ),
    "Worldview": (),
}


ARCHETYPES: dict[str, dict[str, Any]] = {
    "evidence_reversal_event": {
        "library": "EventsLibrary",
        "match": ("证据", "翻盘", "话语权"),
        "slug": "evidence_reversal_event",
        "core_mechanism": "主角先被错误指控或压低评价，随后可公开验证的证据进入评价场域，使裁决者或群体修正判断，并把话语权、制度结果或资源权限转回主角。",
        "role_slots": {
            "protagonist": "被错误评价、指控或压低价值的一方",
            "accuser_or_oppressor": "制造错误叙事、压迫或指控的一方",
            "evidence_holder": "掌握、展示或触发关键证据的一方",
            "audience_or_judge": "评价权发生转移的群体、见证者或制度",
        },
        "required_conditions": [
            "必须存在可被外部验证的证据",
            "前期评价权由反对者、群体或制度掌握",
            "证据出现后必须改变群体判断、制度结果或资源格局",
            "证据不能只补充解释，必须产生外部可见后果",
        ],
        "variation_axes": [
            "证据来源：记录/证人/物证/规则日志/公开行为",
            "裁决场域：私人对质/公开会议/舆论场/正式审判",
            "结果强度：澄清事实/撤销惩罚/转移权力/反向追责",
            "证据控制权：主角持有/盟友提交/制度自动揭示",
        ],
        "failure_risks": ["证据来得毫无铺垫", "证据只解释真相却不改变局势", "裁决者无理由瞬间转向"],
        "specificity_anchor": ["可验证证据", "评价场域", "外部裁决改变"],
        "must_not": ["不等同于所有打脸事件", "不等同于纯身份揭露", "不等同于无证据的强者压制"],
        "focus": {
            "event_trigger": "错误评价、指控或压迫形成可见后果",
            "event_action_sequence": ["固化错误判断", "证据进入场域", "证据被验证", "裁决或群体改判"],
            "event_consequence": "主角夺回话语权，原评价者失去裁决优势",
            "state_change": "评价权由指控者或制度转向主角及其证据",
        },
    },
    "crisis_rescue_dependency_event": {
        "library": "EventsLibrary",
        "match": ("危机", "救场", "依赖"),
        "slug": "crisis_rescue_dependency_event",
        "core_mechanism": "危机使主角短期失去控制或行动能力，保护者以承担风险和成本的行动解除危机；事件解决后，双方关系功能从可替代协助变为信任、依赖、戒备或责任绑定。",
        "role_slots": {
            "endangered_protagonist": "在危机中短期失控、受困或无法独自解决的一方",
            "protector": "承担可见行动成本并改变危机结果的一方",
            "threat_source": "制造身体、制度、舆论或资源危机的力量",
        },
        "required_conditions": [
            "危机必须造成主角短期失控、受困或无法独自解决",
            "救场者必须付出可见行动成本或承担风险",
            "救场后关系功能必须变化，而不是只解决事件",
            "主角后续必须产生信任、依赖、戒备或道德压力",
        ],
        "variation_axes": [
            "危机来源：袭击/制度惩罚/舆论围攻/身体失控",
            "保护方式：身体救援/权力庇护/证据介入/资源替代",
            "行动成本：受伤/暴露身份/消耗资源/承担责任",
            "关系后果：信任升温/新束缚/戒备加深/责任倒置",
        ],
        "failure_risks": ["保护者零成本万能救场", "主角被永久剥夺行动权", "危机解除后关系没有变化"],
        "specificity_anchor": ["主角短期失控", "保护者承担成本", "关系功能变化"],
        "must_not": ["不等同于所有英雄救美", "不等同于普通协助", "不等同于只带来爽感的碾压"],
        "focus": {
            "event_trigger": "危机升级到主角无法独立控制",
            "event_action_sequence": ["危机封锁行动空间", "保护者承担成本介入", "解除直接威胁", "关系责任重排"],
            "event_consequence": "危机解除并建立新的信任、依赖或责任压力",
            "state_change": "保护者由外部协助者转为关系中的稳定功能位",
        },
    },
    "relationship_evaluation_shift_event": {
        "library": "EventsLibrary",
        "match": ("旧关系", "新关系", "评价权"),
        "slug": "relationship_evaluation_shift_event",
        "core_mechanism": "旧关系仍试图解释、评价或控制主角，新关系通过公开选择、资源介入或身份承认改变外部视角与行动条件，使主角获得新的选择空间，并让旧关系的权威可见受损。",
        "role_slots": {
            "protagonist": "仍受旧关系评价或解释权影响的一方",
            "old_relation_authority": "试图维持评价、控制或关系解释权的一方",
            "new_relation_intervener": "以选择、资源或承认改变关系格局的一方",
            "witness_or_system": "确认评价权变化的群体或制度",
        },
        "required_conditions": [
            "旧关系仍试图掌握主角评价权或关系解释权",
            "新关系介入必须改变外部视角、资源结构或主角选择权",
            "主角不能完全被动接受拯救，必须获得新的行动空间",
            "介入之后旧关系的权威必须可见受损",
        ],
        "variation_axes": [
            "旧权威来源：情感惯性/经济控制/身份合法性/群体认同",
            "新关系介入方式：公开选择/资源支持/身份承认/共同承担",
            "主角主动性：借力反击/明确选择/设定边界/拒绝双重控制",
            "旧关系后果：失控/追悔/报复/评价失效",
        ],
        "failure_risks": ["新关系完全代替主角行动", "只换了更强控制者", "旧关系权威没有实际受损"],
        "specificity_anchor": ["旧关系评价权", "新关系改变行动空间", "旧权威失效"],
        "must_not": ["不等同于所有三角关系", "不等同于普通救场", "不等同于单纯换伴侣"],
        "focus": {
            "event_trigger": "旧关系再次行使评价或控制权",
            "event_action_sequence": ["旧关系施压", "新关系公开介入", "主角利用新增空间做出选择", "旧权威受损"],
            "event_consequence": "关系解释权与行动资源重新分配",
            "state_change": "主角由旧关系评价对象转为拥有选择权的一方",
        },
    },
    "old_oppressor_loss_arc": {
        "library": "CharacterArc",
        "match": ("旧关系", "评价权", "失控"),
        "slug": "old_oppressor_loss_arc",
        "core_mechanism": "旧关系对象起初掌握主角的价值判断权，并通过羞辱、控制、背叛或关系惯性维持优势；随着主角获得新资源、新关系或证据支持，其评价权逐步失效，行为从稳定压迫转为失控、追悔或补偿性挽回。",
        "role_slots": {"old_relation_oppressor": "起初掌握主角评价权、后来失去控制的一方", "protagonist": "逐步脱离旧评价体系的一方"},
        "required_conditions": ["初期旧关系确实掌握评价或控制优势", "权力失效必须由多次选择或局势变化累积", "终态行为要体现失控、追悔或补偿", "主角必须获得独立于旧关系的判断依据"],
        "variation_axes": ["初始控制方式：羞辱/经济/情感惯性/身份合法性", "失权原因：证据/新关系/自我成长/制度支持", "失控表现：追悔/报复/补偿/自我崩塌", "终局功能：警示旧秩序/制造阻力/完成清算"],
        "failure_risks": ["只有反派吃瘪而没有长期功能变化", "追悔缺少失权过程", "主角仍依赖旧关系评价"],
        "specificity_anchor": ["评价权由有到无", "跨阶段行为反转", "旧关系功能失效"],
        "must_not": ["不等同于普通反派失败", "不等同于一次打脸", "不等同于无铺垫追妻"],
        "focus": {"initial_state": "掌握主角价值判断与关系解释权", "external_pressure": "主角获得新支持并持续拒绝旧秩序", "turning_choice": "继续控制或承认评价权已失效", "final_state": "由压迫者转为失控、追悔或补偿者", "arc_function": "展示旧关系秩序瓦解", "relationship_consequence": "主角脱离旧评价体系"},
    },
    "intervener_to_axis_arc": {
        "library": "CharacterArc",
        "match": ("介入者", "外部资源", "关系轴心"),
        "slug": "intervener_to_relation_axis_arc",
        "core_mechanism": "强势介入者最初作为外部资源解决危机，但随着多次救场、共同选择和情绪确认，其功能从工具性支援转为关系主轴，并迫使主角重新判断依赖、信任与亲密边界。",
        "role_slots": {"strong_intervener": "最初以资源或能力介入、后来承担关系主轴的一方", "protagonist": "需要重新判断依赖与亲密边界的一方"},
        "required_conditions": ["介入者初期功能必须主要是外部资源", "关系轴心地位需要多次选择和成本累积", "主角必须主动回应依赖或亲密边界", "终态不能只停留在万能工具人"],
        "variation_axes": ["初始资源：权力/武力/证据/情绪支持", "绑定方式：共同危机/承诺/秘密共享/责任承担", "主角回应：接受/戒备/谈判边界/反向保护", "终态关系：伴侣轴心/盟友核心/道德锚点/共同决策者"],
        "failure_risks": ["连续救场取代人物变化", "关系升温只有台词没有选择", "介入者始终是功能性外挂"],
        "specificity_anchor": ["功能从资源转为关系轴心", "多次成本与选择", "主角重估亲密边界"],
        "must_not": ["不等同于所有保护者", "不等同于强者救场", "不等同于普通恋爱升温"],
        "focus": {"initial_state": "可替代的外部资源或危机解决者", "external_pressure": "重复危机与共同责任要求其持续选择", "turning_choice": "承担超出工具关系的情感或责任成本", "final_state": "成为关系与决策轴心", "arc_function": "把外部资源线转成核心关系线", "relationship_consequence": "主角重新界定依赖、信任与亲密"},
    },
    "crisis_dependency_rhythm": {
        "library": "EmotionRhythm",
        "match": ("危机", "保护", "依赖"),
        "slug": "crisis_to_dependency_rhythm",
        "core_mechanism": "读者先随主角经历控制感下降与危险逼近，在救援介入时获得即时安全释放；释放后通过关系依赖、责任或新束缚把安心转成持续期待。",
        "role_slots": {"experiencing_character": "承受失控与恢复安全感的一方", "safety_provider": "触发安全释放并带来关系后果的一方"},
        "required_conditions": ["危险感必须在救援前逐步逼近", "释放点必须清晰恢复短期安全", "安全恢复后要产生依赖或责任余波", "节奏重点是读者状态变化而非救援动作本身"],
        "variation_axes": ["危机来源：袭击/舆论/规则惩罚/身体失控", "保护方式：身体救场/权力庇护/证据介入/情绪安抚", "依赖后果：信任/新束缚/道德压力/旧关系失控", "释放位置：危机中即时/危机后确认/救援后转悬念"],
        "failure_risks": ["危机没有累积就立即解决", "安全释放后没有情绪余波", "把事件救场误当完整节奏"],
        "specificity_anchor": ["控制感下降", "安全感恢复", "依赖余波"],
        "must_not": ["不等同于所有危机情节", "不等同于普通甜宠", "不等同于单次英雄救美"],
        "focus": {"rhythm_scope": "plot_cycle", "emotion_start": "不安与控制感下降", "tension_accumulation": "威胁逐步压缩行动空间", "delay_method": "推迟有效援助或确认保护意愿", "release_position": "保护行动解除直接危机时", "post_release_hook": "依赖、责任或新束缚形成", "reader_state_change": "恐惧紧张转为安全释放，再转为关系期待"},
    },
    "secret_reframe_rhythm": {
        "library": "EmotionRhythm",
        "match": ("秘密", "认知反转"),
        "slug": "secret_to_reframe_rhythm",
        "core_mechanism": "信息缺口持续制造疑虑与误判，零散线索延迟完整解释；秘密揭露时，读者重新解释此前行为并获得认知释放，随后由新代价或关系判断开启下一轮不确定。",
        "role_slots": {"perceiving_character": "在信息不足下持续误判的一方", "information_controller": "隐瞒、分段释放或触发秘密的一方"},
        "required_conditions": ["前期必须存在可感知但不完整的信息缺口", "线索应能在揭露后被重新解释", "揭露必须改变读者对既往行为的理解", "揭露后需要新代价、选择或关系问题"],
        "variation_axes": ["秘密类型：身份/动机/历史关系/制度真相", "线索密度：稀疏暗示/反复误导/多源拼合", "揭露方式：主动坦白/证据暴露/第三方揭示/危机触发", "反转余波：信任重建/背叛感/新责任/更大谜团"],
        "failure_risks": ["秘密没有前置线索", "揭露只补设定不重构理解", "反转后没有情绪余波"],
        "specificity_anchor": ["信息缺口", "旧线索重解释", "揭露后新判断"],
        "must_not": ["不等同于所有身份揭露", "不等同于普通悬念", "不等同于纯信息说明"],
        "focus": {"rhythm_scope": "plot_cycle", "emotion_start": "疑虑与信息不对称", "tension_accumulation": "线索与误判反复叠加", "delay_method": "分段释放信息并维持解释缺口", "release_position": "秘密使旧线索获得新解释时", "post_release_hook": "新代价或关系选择出现", "reader_state_change": "疑虑转为认知释放，再转为重新判断"},
    },
    "public_pressure_release_rhythm": {
        "library": "EmotionRhythm",
        "match": ("短周期", "公开压迫", "释放"),
        "slug": "public_pressure_release_cycle",
        "core_mechanism": "公开见证放大主角受压时的羞耻与不值感，反击被短暂延迟以累积期待；可见释放改变现场判断后，余波钩子把爽感转入下一轮关系或风险期待。",
        "role_slots": {"experiencing_character": "承受公开压力并完成释放的一方", "pressure_source": "持续制造羞辱或评价压力的一方", "witness_group": "放大压力并确认释放结果的见证者"},
        "required_conditions": ["压力必须被公开或准公开见证", "反击前要有足够延迟形成期待", "释放必须被同一评价场域看见", "释放后应保留关系或风险余波"],
        "variation_axes": ["压力场域：宴会/会议/审判/直播/考核", "延迟长度：即时忍耐/多轮升级/证据等待", "释放方式：自我反击/证据介入/规则改判/盟友支持", "余波方向：关系升温/对手报复/新身份压力/道德代价"],
        "failure_risks": ["压迫不具体导致释放无力", "反击没有延迟与期待", "现场判断没有改变"],
        "specificity_anchor": ["公开见证", "压迫延迟", "可见释放"],
        "must_not": ["不等同于所有打脸爽点", "不等同于私下冲突", "不等同于无余波的即时反击"],
        "focus": {"rhythm_scope": "plot_cycle", "emotion_start": "公开受压与羞耻不值感", "tension_accumulation": "羞辱升级且反击被延迟", "delay_method": "等待证据、时机或介入条件", "release_position": "现场评价权可见转移时", "post_release_hook": "关系或风险余波接管爽感", "reader_state_change": "憋屈期待转为公开释放，再转为追读期待"},
    },
    "public_evidence_payoff": {
        "library": "PayoffAngst",
        "match": ("公开压迫", "证据翻盘"),
        "slug": "public_evidence_reversal_payoff",
        "core_mechanism": "公开压迫先让读者确认主角真实受损，反击因证据尚未出现而延迟；证据被同一评价场域验证后，外部判断和资源结果同步反转，释放替主角不值的积累情绪。",
        "role_slots": {"suffering_protagonist": "被公开压低价值并真实受损的一方", "pressure_source": "掌握前期评价权的一方", "evidence_trigger": "使证据进入公开判断场域的人或机制", "witness_group": "确认评价反转的群体或制度"},
        "required_conditions": ["公开压力必须造成可感知损失", "必须存在可验证且有前置铺垫的证据", "释放前应让错误评价维持足够时间", "证据必须改变群体判断或资源结果"],
        "variation_axes": ["受损类型：名誉/资格/资源/关系合法性", "证据类型：记录/证人/物证/制度日志", "延迟来源：证据缺失/主角隐忍/程序等待/对手封锁", "回报结果：洗清指控/反向追责/恢复资格/夺回资源"],
        "failure_risks": ["证据机械降临", "主角没有真实受损", "只解释真相而没有外部回报"],
        "specificity_anchor": ["公开受损", "证据延迟", "评价与资源同步反转"],
        "must_not": ["不等同于所有证据事件", "不等同于身份揭露", "不等同于强者直接碾压"],
        "focus": {"pressure_setup": "公开错误评价使主角承受名誉或资源损失", "delay_mechanism": "关键证据被隐藏、封锁或等待验证", "release_or_damage_action": "证据在原评价场域被验证并触发改判", "reader_reward_or_pain": "替主角不值的情绪转为评价权回收爽感", "required_emotional_setup": ["主角真实受损", "错误评价持续", "读者知道或期待真相出现"]},
    },
    "rescue_safety_payoff": {
        "library": "PayoffAngst",
        "match": ("危机救场", "安全感"),
        "slug": "rescue_safety_confirmation_payoff",
        "core_mechanism": "危机逐步剥夺主角的控制感，读者对保护承诺是否兑现产生焦虑；保护者承担成本完成救援时，安全感和关系可靠性被同时确认，形成关系型回报。",
        "role_slots": {"endangered_protagonist": "控制感被危机削弱的一方", "protector": "需要用行动兑现可靠性的一方", "threat_source": "维持危险与不确定的力量"},
        "required_conditions": ["危机必须真实威胁主角安全或选择空间", "保护承诺需要在救援前存在不确定性", "保护者必须付出成本而非随手解决", "释放应同时确认安全和关系可靠性"],
        "variation_axes": ["威胁类型：身体/制度/舆论/资源断裂", "承诺状态：未说出口/曾被拒绝/关系破裂后重建", "救援成本：受伤/暴露/失去资源/承担责任", "回报余波：信任/依赖/新债务/边界谈判"],
        "failure_risks": ["危机没有威胁感", "保护者万能且零成本", "救援只解决事件不确认关系"],
        "specificity_anchor": ["控制感丧失", "保护承诺兑现", "安全与关系双重确认"],
        "must_not": ["不等同于所有救场", "不等同于普通安全脱险", "不等同于单纯关系升温"],
        "focus": {"pressure_setup": "危机剥夺控制感并让保护可靠性悬而未决", "delay_mechanism": "援助时机、能力或意愿暂不确定", "release_or_damage_action": "保护者承担成本解除危机", "reader_reward_or_pain": "安全恢复与关系可靠性确认的双重回报", "required_emotional_setup": ["危险逼近", "保护承诺不确定", "主角无法独立恢复控制"]},
    },
    "public_evaluation_payoff": {
        "library": "PayoffAngst",
        "match": ("公开压迫", "评价权反转"),
        "slug": "public_evaluation_reversal_payoff",
        "core_mechanism": "公开评价持续压低主角价值并累积读者的不值感，主角或盟友在延迟后改变评价标准、身份位置或资源控制，使原评价者失去定义主角的权力。",
        "role_slots": {"devalued_protagonist": "被公开评价压低的一方", "evaluation_authority": "前期掌握价值定义权的一方", "witness_group": "确认评价标准变化的群体"},
        "required_conditions": ["压迫必须发生在有见证的评价场域", "主角必须承受名誉、关系或资源损失", "释放必须改变谁有权定义主角价值", "反转后原评价者的权威需要可见受损"],
        "variation_axes": ["评价场域：社交/职场/制度/舆论", "反转资源：主角能力/盟友选择/身份位置/规则改判", "主动性：主角主导/共同完成/盟友触发主角收束", "权威后果：沉默/失控/追悔/被反向评价"],
        "failure_risks": ["主角全程被动", "只有身份炫耀没有评价标准变化", "反派降智导致反转廉价"],
        "specificity_anchor": ["公开评价场", "价值定义权转移", "原权威受损"],
        "must_not": ["不等同于所有打脸", "不等同于所有证据翻盘", "不等同于普通资源升级"],
        "focus": {"pressure_setup": "公开评价压低主角价值并造成可见损失", "delay_mechanism": "反击资源或选择暂不公开", "release_or_damage_action": "改变评价标准或谁拥有定义权", "reader_reward_or_pain": "替主角不值转为价值被重新承认的爽感", "required_emotional_setup": ["公开见证", "真实受损", "读者认同旧评价不公"]},
    },
    "secret_reframe_payoff": {
        "library": "PayoffAngst",
        "match": ("秘密揭露", "认知反转"),
        "slug": "secret_reframe_payoff",
        "core_mechanism": "信息缺口让读者基于错误解释累积疑虑、疼痛或期待；秘密揭露使此前行为获得新含义，并通过新的关系判断、责任或代价完成认知型回报。",
        "role_slots": {"affected_protagonist": "因信息缺口做出错误判断或承受疼痛的一方", "secret_controller": "隐瞒、保护或释放秘密的一方", "revelation_trigger": "使秘密不可继续维持的人、证据或危机"},
        "required_conditions": ["秘密必须影响角色选择与读者判断", "前期需要留下可回看的线索", "揭露必须重构对既往行为的解释", "揭露后必须带来新关系判断、责任或代价"],
        "variation_axes": ["秘密内容：身份/动机/牺牲/历史关系/制度真相", "误判代价：疏远/伤害/错失/敌对", "揭露方式：坦白/证据/第三方/危机暴露", "回报类型：释然/心疼/信任重建/背叛确认"],
        "failure_risks": ["秘密没有前置线索", "揭露只补设定不改变感受", "为了反转强行隐瞒"],
        "specificity_anchor": ["信息缺口造成情绪积累", "旧行为被重新解释", "揭露带来情绪回报或疼痛"],
        "must_not": ["不等同于所有身份揭露", "不等同于普通悬念解答", "不等同于事件层证据翻盘"],
        "focus": {"pressure_setup": "信息缺口导致误判、疏远或替角色不值", "delay_mechanism": "线索分段出现但关键解释被推迟", "release_or_damage_action": "秘密揭露并重构此前行为含义", "reader_reward_or_pain": "获得释然、心疼、信任重建或背叛确认", "required_emotional_setup": ["错误解释已造成情绪代价", "前置线索可回看", "读者关心关系判断"]},
    },
}


def refine_pattern(
    source: dict[str, Any],
    *,
    materialized_id: str,
    instances: list[dict[str, Any]],
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, Any],
]:
    library = as_text(source.get("library"))
    name = as_text(source.get("pattern_name"))
    archetype, spec = classify_archetype(library, name, source=source, instances=instances)
    spec = dict(spec)
    canonical_archetype, archetype_family = _taxonomy(
        library,
        as_text(spec.get("slug")),
        name=name,
        source=source,
    )
    grounded_focus = _instance_grounded_focus(library, source, instances)
    spec["focus"] = {
        **spec["focus"],
        **{key: value for key, value in grounded_focus.items() if value not in (None, "", [], {})},
    }
    library_spec = LIBRARY_SPECS[library]
    old_slots = {
        **_aggregate_instance_role_slots(instances),
        **as_mapping(source.get("role_slots")),
    }
    spec["role_slots"] = _pattern_role_slots(
        library=library,
        canonical_archetype=canonical_archetype,
        archetype_slots=as_mapping(spec.get("role_slots")),
        observed_slots=old_slots,
    )
    role_support = _role_support(instances)
    optional_slots, discarded_slots = _prune_slots(old_slots, spec["role_slots"], role_support, len(instances))
    normalized_instances = [normalize_instance(row, materialized_id=materialized_id) for row in instances]
    source_refs = _source_refs(normalized_instances)
    structured_axes, discarded_axis_values, variation_cleaning_log = clean_variation_axes(spec["variation_axes"])
    example_variants = _example_variants(
        instances=normalized_instances,
        materialized_id=materialized_id,
        structured_axes=structured_axes,
    )
    quality_scores = [
        _score(row.get("fit_score") or row.get("confidence"))
        for row in normalized_instances
        if _score(row.get("fit_score") or row.get("confidence")) > 0
    ]
    pattern_status, evidence_tier = _materialized_status(source)
    display_name = DISPLAY_PATTERN_NAMES.get(canonical_archetype, name)
    pattern = {
        "schema_version": "reference_pattern.v2",
        "pattern_id": materialized_id,
        "source_pattern_id": source.get("pattern_id", ""),
        "pattern_name": display_name,
        "source_pattern_name": name,
        "generalized_pattern_name": GENERALIZED_PATTERN_NAMES.get(canonical_archetype, display_name),
        "library": library,
        "library_perspective": library_spec["perspective"],
        "excluded_perspectives": library_spec["excluded"],
        "source_archetype": archetype,
        "archetype": archetype,
        "canonical_archetype": canonical_archetype,
        "archetype_family": archetype_family,
        "pattern_status": pattern_status,
        "source_pattern_status": source.get("pattern_status", "book_evidence"),
        "evidence_tier": evidence_tier,
        "cross_book_candidate": evidence_tier == "cross_book_candidate",
        "definition": spec["core_mechanism"],
        "source_definition": source.get("definition", ""),
        "core_mechanism": spec["core_mechanism"],
        "role_slots": spec["role_slots"],
        "optional_role_slots": optional_slots,
        "required_conditions": spec["required_conditions"],
        "variation_axes": structured_axes,
        "variation_axes_raw": spec["variation_axes"],
        "discarded_axis_values": discarded_axis_values,
        "failure_risks": spec["failure_risks"],
        **spec["focus"],
        "generation_usage": source.get("generation_usage", ""),
        "supported_books": source.get("supported_books", []),
        "supported_book_count": source.get("supported_book_count", 0),
        "registered_instance_count": len(normalized_instances),
        "source_quality_score": round(sum(quality_scores) / len(quality_scores), 4) if quality_scores else _score(source.get("quality_score")),
        "source_refs": source_refs,
        "signature_terms": [f"archetype:{archetype}", *([f"scope:{spec['focus']['rhythm_scope']}"] if library == "EmotionRhythm" else [])],
    }
    counterexamples = [
        {
            "schema_version": "pattern_counterexample.v1",
            "pattern_id": materialized_id,
            "description": text,
            "reason": "outside_specificity_boundary",
        }
        for text in spec["must_not"]
    ]
    boundary_status, boundary_issues = _library_boundary_review(pattern)
    promotion_readiness = _promotion_readiness(pattern, example_variants)
    review = {
        "schema_version": "pattern_review.v2",
        "pattern_id": materialized_id,
        "canonical_archetype": canonical_archetype,
        "archetype_family": archetype_family,
        "generality_level": "medium",
        "overgeneralization_risk": _overgeneralization_risk(source, spec),
        "specificity_anchor": spec["specificity_anchor"],
        "must_not_generalize_beyond": spec["must_not"],
        "nearest_neighbor_patterns": [],
        "boundary_with_neighbors": {},
        "merge_candidates": [],
        "split_candidates": _split_candidates(normalized_instances, materialized_id=materialized_id),
        "should_merge": False,
        "should_split": False,
        "promote_to_universal_when": [
            "至少 3 本不同书籍出现同一核心机制",
            "至少登记 8 个可追溯实例",
            "至少 2 个跨书或跨场景具体变体，且不改变模式边界",
            "不存在未解决的合并、拆分或库边界审查问题",
        ],
        "promotion_readiness": promotion_readiness,
        "library_boundary_status": boundary_status,
        "boundary_issues": boundary_issues,
        "cross_library_pollution_risk": (
            "high" if boundary_status == "contaminated" else ("medium" if boundary_status == "needs_review" else "low")
        ),
        "variation_cleaning_log": variation_cleaning_log,
        "role_slot_pruning_log": {
            "input_role_slots": sorted(old_slots),
            "core_role_slots": sorted(spec["role_slots"]),
            "optional_role_slots": sorted(optional_slots),
            "discarded_role_slots": discarded_slots,
            "instance_support": role_support,
        },
        "review_status": (
            "needs_cross_book_support"
            if spec.get("source_defined")
            else ("needs_support_review" if not normalized_instances else "materialized")
        ),
        "review_notes": [
            "Library focus fields were aggregated from structured source instances.",
            "Source-defined patterns remain emerging until supported by multiple books.",
        ],
    }
    return pattern, normalized_instances, example_variants, counterexamples, review


def classify_archetype(
    library: str,
    name: str,
    *,
    source: dict[str, Any] | None = None,
    instances: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    candidates = [
        (key, spec)
        for key, spec in ARCHETYPES.items()
        if spec["library"] == library
    ]
    scored = [
        (sum(term in name for term in spec["match"]), key, spec)
        for key, spec in candidates
    ]
    score, key, spec = max(scored, default=(0, "", {}), key=lambda row: row[0])
    if score < 2:
        spec = _source_defined_spec(library, source or {}, instances or [])
        return f"source_defined_{spec['slug']}", spec
    return key, spec


def taxonomy_for_pattern(
    library: str,
    name: str,
    *,
    source: dict[str, Any] | None = None,
    instances: list[dict[str, Any]] | None = None,
) -> tuple[str, str, str, dict[str, Any]]:
    source_archetype, spec = classify_archetype(
        library,
        name,
        source=source,
        instances=instances,
    )
    canonical, family = _taxonomy(
        library,
        as_text(spec.get("slug")),
        name=name,
        source=source or {},
    )
    return source_archetype, canonical, family, spec


def _source_defined_spec(
    library: str,
    source: dict[str, Any],
    instances: list[dict[str, Any]],
) -> dict[str, Any]:
    required = as_list(source.get("required_conditions")) or _default_required_conditions(library, source)
    axes = [value for value in as_list(source.get("variation_axes")) if not value.startswith("候选变体：")]
    if not axes:
        axes = _default_variation_axes(library, source)
    mechanism = as_text(source.get("core_mechanism")) or as_text(source.get("definition"))
    focus = _instance_grounded_focus(library, source, instances)
    slug = _stable_taxonomy_slug(source.get("canonical_archetype")) or _descriptive_slug(
        as_text(source.get("pattern_name")),
        as_text(source.get("pattern_id")),
    )
    return {
        "library": library,
        "match": (),
        "slug": slug,
        "source_defined": True,
        "core_mechanism": mechanism,
        "role_slots": as_mapping(source.get("role_slots")),
        "required_conditions": required,
        "variation_axes": axes,
        "failure_risks": as_list(source.get("failure_risks")),
        "specificity_anchor": required[:3] or [mechanism[:120]],
        "must_not": ["不得仅因题材、职业、人物或道具相似就归入本模式"],
        "focus": focus,
    }


def _default_required_conditions(library: str, source: dict[str, Any]) -> list[str]:
    if library == "EmotionRhythm":
        scope = as_text(source.get("rhythm_scope")) or "plot_cycle"
        if scope == "stage_curve":
            return ["至少跨越三个相邻情节并形成可识别的阶段终点", "压力、局部释放与阶段后果必须连续可追踪"]
        if scope == "book_curve":
            return ["证据必须覆盖开篇、中段与终局", "全书压力升级、阶段释放与终局余味必须形成稳定骨架"]
    return ["触发、行动与状态变化必须由来源证据共同支持"]


def _default_variation_axes(library: str, source: dict[str, Any]) -> list[str]:
    if library == "EmotionRhythm":
        scope = as_text(source.get("rhythm_scope")) or "plot_cycle"
        if scope == "stage_curve":
            return ["阶段长度：短阶段/中阶段/长阶段", "阶段主压力：内部压力/外部压力/关系压力", "阶段释放强度：低/中/高"]
        if scope == "book_curve":
            return ["压力峰值数量：单峰/双峰/多峰", "中段释放方式：关系补偿/局部胜利/秘密揭露", "终局余味：释然/苦涩/悬置"]
    return ["触发条件：内部触发/外部触发/混合触发", "后果强度：局部改变/关系改变/结构改变"]


def _aggregate_instance_role_slots(instances: list[dict[str, Any]]) -> dict[str, str]:
    descriptions: dict[str, list[str]] = {}
    for instance in instances:
        for role, raw_description in as_mapping(instance.get("role_slots")).items():
            role_name = re.sub(r"[A-CＡ-Ｃ1-3]+$", "", as_text(role)).strip()
            if not role_name:
                continue
            description = _role_description(raw_description)
            if description and description not in descriptions.setdefault(role_name, []):
                descriptions[role_name].append(description)
    return {
        role: "；".join(values[:2])[:240]
        for role, values in list(descriptions.items())[:8]
    }


def _role_description(value: object) -> str:
    if isinstance(value, dict):
        return "；".join(
            f"{as_text(key)}：{as_text(child)}"
            for key, child in value.items()
            if as_text(key) and as_text(child)
        )[:240]
    return as_text(value)[:240]


def _pattern_role_slots(
    *,
    library: str,
    canonical_archetype: str,
    archetype_slots: dict[str, Any],
    observed_slots: dict[str, Any],
) -> dict[str, str]:
    template = CANONICAL_ROLE_SLOTS.get(canonical_archetype)
    if template:
        return dict(template)
    if archetype_slots:
        return {
            as_text(role): _role_description(description)
            for role, description in archetype_slots.items()
            if as_text(role) and _role_description(description)
        }
    if library == "EmotionRhythm":
        return dict(LIBRARY_FALLBACK_ROLE_SLOTS[library])
    if observed_slots:
        return {
            as_text(role): _role_description(description)
            for role, description in list(observed_slots.items())[:5]
            if as_text(role) and _role_description(description)
        }
    return dict(LIBRARY_FALLBACK_ROLE_SLOTS[library])


def _materialized_status(source: dict[str, Any]) -> tuple[str, str]:
    source_status = as_text(source.get("pattern_status")).lower()
    supported_book_count = int(source.get("supported_book_count") or 0)
    if "universal" in source_status:
        return "universal_pattern", "universal"
    if supported_book_count >= 3:
        return "emerging_pattern", "multi_book_candidate"
    if supported_book_count == 2:
        return "emerging_pattern", "cross_book_candidate"
    return "book_evidence", "book_evidence"


def _overgeneralization_risk(source: dict[str, Any], spec: dict[str, Any]) -> str:
    book_count = int(source.get("supported_book_count") or 0)
    instance_count = int(source.get("registered_instance_count") or 0)
    if book_count >= 3 and instance_count >= 8:
        return "low"
    if not spec.get("source_defined") and len(as_list(spec.get("specificity_anchor"))) >= 3:
        return "low"
    if book_count >= 2:
        return "medium"
    if book_count <= 1 and instance_count <= 1:
        return "high"
    return "medium"


def _instance_grounded_focus(
    library: str,
    source: dict[str, Any],
    instances: list[dict[str, Any]],
) -> dict[str, Any]:
    representative = _representative_instance(instances)
    mechanism = as_mapping(representative.get("mechanism"))
    trigger = _first_text(source.get("trigger"), mechanism.get("trigger"), source.get("definition"))
    pressure = _first_text(source.get("pressure"), mechanism.get("pressure"), trigger)
    actions = _action_chain(source, mechanism)
    state_change = _first_text(source.get("state_change"), mechanism.get("state_change"), source.get("core_mechanism"))
    reader_effect = _first_text(source.get("reader_effect"), mechanism.get("reader_effect"), state_change)

    existing: dict[str, Any] = {}
    for field in LIBRARY_SPECS[library]["focus_fields"]:
        value = source.get(field)
        if value not in (None, "", [], {}):
            existing[field] = value

    if library == "EventsLibrary":
        derived = {
            "event_trigger": trigger,
            "event_action_sequence": actions,
            "event_consequence": state_change,
            "state_change": state_change,
        }
    elif library == "PayoffAngst":
        derived = {
            "pressure_setup": "；".join(value for value in (trigger, pressure) if value),
            "delay_mechanism": _delay_mechanism(pressure, actions),
            "release_or_damage_action": "；".join(actions[-2:]) if actions else state_change,
            "reader_reward_or_pain": reader_effect,
            "required_emotional_setup": as_list(source.get("required_conditions"))[:4] or [pressure],
        }
    elif library == "CharacterArc":
        initial_state, final_state = _state_endpoints(state_change)
        derived = {
            "arc_scope": _infer_arc_scope(source),
            "initial_state": initial_state or trigger,
            "external_pressure": pressure,
            "turning_choice": _turning_choice(actions),
            "final_state": final_state or state_change,
            "arc_function": as_text(source.get("definition")) or state_change,
            "relationship_consequence": state_change,
        }
    elif library == "EmotionRhythm":
        derived = {
            "rhythm_scope": _first_text(
                source.get("rhythm_scope"),
                representative.get("rhythm_scope"),
                "plot_cycle",
            ),
            "emotion_start": trigger,
            "tension_accumulation": pressure,
            "delay_method": _delay_mechanism(pressure, actions),
            "release_position": actions[-1] if actions else state_change,
            "post_release_hook": state_change,
            "reader_state_change": reader_effect,
        }
    else:
        stable_rule = as_text(source.get("core_mechanism")) or state_change
        observed_roles = {
            **_aggregate_instance_role_slots(instances),
            **as_mapping(representative.get("role_slots")),
            **as_mapping(source.get("role_slots")),
        }
        who_benefits, who_is_constrained = _worldview_role_sides(observed_roles)
        enforcement = _first_text(
            source.get("enforcement_mechanism"),
            mechanism.get("enforcement_mechanism"),
            _joined_actions(source, mechanism),
        )
        derived = {
            "stable_rule": stable_rule,
            "rule_scope": _first_text(
                source.get("rule_scope"),
                mechanism.get("rule_scope"),
                _infer_worldview_scope(stable_rule, observed_roles),
            ),
            "resource_or_permission": trigger,
            "constraint": pressure,
            "enforcement_mechanism": enforcement,
            "cost": state_change,
            "affected_choices": _first_text(
                source.get("affected_choices"),
                mechanism.get("state_change"),
                stable_rule,
            ),
            "repeatability": f"由 {len(instances)} 个跨情节实例支持" if instances else "等待跨情节实例支持",
            "resource_distribution_logic": _first_text(
                source.get("resource_distribution_logic"),
                mechanism.get("resource_distribution_logic"),
                (
                    f"{who_benefits}掌握规则执行或资源准入，{who_is_constrained}只能在其约束下行动"
                    if who_benefits and who_is_constrained
                    else trigger
                ),
            ),
            "cost_model": _first_text(source.get("cost_model"), mechanism.get("cost_model"), state_change, pressure),
            "who_benefits": _first_text(source.get("who_benefits"), who_benefits),
            "who_is_constrained": _first_text(source.get("who_is_constrained"), who_is_constrained),
            "story_conflicts_enabled": as_list(source.get("story_conflicts_enabled"))
            or [value for value in (pressure, state_change) if value],
        }
    return {
        field: existing.get(field, value)
        for field, value in derived.items()
    }


def _representative_instance(instances: list[dict[str, Any]]) -> dict[str, Any]:
    return max(
        instances,
        key=lambda row: (_score(row.get("confidence")), len(as_text(as_mapping(row.get("mechanism")).get("state_change")))),
        default={},
    )


def _action_chain(source: dict[str, Any], mechanism: dict[str, Any]) -> list[str]:
    actions = [as_text(value) for value in as_list(source.get("action_chain")) if as_text(value)]
    if not actions:
        actions = [as_text(value) for value in as_list(mechanism.get("action_chain")) if as_text(value)]
    return actions[:8]


def _delay_mechanism(pressure: str, actions: list[str]) -> str:
    if len(actions) >= 3:
        return f"在{'、'.join(actions[:-2])}期间维持压力，延迟最终释放"
    if pressure:
        return f"压力持续存在，直到有效行动条件形成：{pressure}"
    return "有效反击或情绪确认条件尚未形成，释放被暂时延迟"


def _state_endpoints(value: str) -> tuple[str, str]:
    match = re.search(r"(?:从|由)(.+?)(?:转变为|转为|转向|到)(.+)", value)
    if not match:
        return "", ""
    return match.group(1).strip(" ，。；"), match.group(2).strip(" ，。；")


def _turning_choice(actions: list[str]) -> str:
    choice_terms = ("主动", "拒绝", "接受", "坦白", "维护", "承诺", "公开", "选择", "决定")
    for action in reversed(actions):
        if any(term in action for term in choice_terms):
            return action
    return actions[-1] if actions else "角色做出改变原有状态的关键选择"


def _infer_arc_scope(source: dict[str, Any]) -> str:
    text = " ".join(
        [
            as_text(source.get("pattern_name")),
            as_text(source.get("canonical_archetype")),
            as_text(source.get("archetype_family")),
            as_text(source.get("core_mechanism")),
        ]
    ).lower()
    if any(term in text for term in ("leader", "leadership", "authority", "指挥官", "领袖", "领导", "实权")):
        return "leadership_arc"
    if any(term in text for term in ("relationship", "bond", "attachment", "关系", "依恋", "互依", "唤醒者")):
        return "relationship_arc"
    if any(term in text for term in ("ability", "capability", "能力", "策略觉醒")):
        return "ability_growth_arc"
    return "protagonist_arc"


def _joined_actions(source: dict[str, Any], mechanism: dict[str, Any]) -> str:
    actions = _action_chain(source, mechanism)
    return "；".join(actions)


def _infer_worldview_scope(stable_rule: str, role_slots: dict[str, Any]) -> str:
    text = f"{stable_rule} {' '.join(role_slots)}"
    if any(term in text for term in ("轮回", "旧神", "新神", "宇宙", "世界", "神权")):
        return "cosmic_cycle"
    if any(term in text for term in ("神经", "身体", "植入", "芯片", "感知", "运动指令")):
        return "individual_body"
    if any(term in text for term in ("公司", "宗门", "学院", "法律", "组织", "机构")):
        return "institution"
    return "society_system"


def _worldview_role_sides(role_slots: dict[str, Any]) -> tuple[str, str]:
    authority_terms = ("操控", "掌控", "控制", "权威", "旧神", "高维", "主持", "管理", "制定", "执行者", "规则执行")
    constrained_terms = ("目标", "轮回者", "参与者", "受限", "普通人", "被")
    authorities = [role for role in role_slots if any(term in role for term in authority_terms)]
    constrained = [role for role in role_slots if any(term in role for term in constrained_terms)]
    return "、".join(authorities[:3]), "、".join(constrained[:3])


def _first_text(*values: object) -> str:
    for value in values:
        text = as_text(value)
        if text:
            return text
    return ""


def _descriptive_slug(name: str, source_pattern_id: str) -> str:
    remaining = name
    tokens: list[str] = []
    for phrase, token in SLUG_TERMS:
        if phrase in remaining and token not in tokens:
            tokens.append(token)
            remaining = remaining.replace(phrase, " ")
    if tokens:
        return "_".join(tokens[:5])
    if name and re.fullmatch(r"[A-Za-z0-9 _\-]+", name):
        readable = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        if readable and not readable.startswith(("candidate_", "emerging_")):
            return readable[:80]
    suffix = re.sub(r"[^a-z0-9]+", "_", source_pattern_id.lower()).strip("_")
    return suffix or "source_defined_pattern"


def _source_refs(instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in instances:
        source_ref = as_mapping(row.get("source_ref"))
        chunk_ids = [as_text(value) for value in as_list(source_ref.get("bridge_chunk_ids")) if as_text(value)]
        key = "|".join(chunk_ids) or as_text(row.get("object_id"))
        if not key or key in seen:
            continue
        seen.add(key)
        refs.append(
            {
                "book_id": row.get("book_id", ""),
                "book_slug": row.get("book_slug", ""),
                "plot_id": row.get("plot_id", ""),
                "object_id": row.get("object_id", ""),
                "bridge_chunk_ids": chunk_ids,
                "fit_score": row.get("fit_score", row.get("confidence", 0.0)),
            }
        )
    return refs[:24]


def _score(value: object) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _taxonomy(
    library: str,
    slug: str,
    *,
    name: str = "",
    source: dict[str, Any] | None = None,
) -> tuple[str, str]:
    source = source or {}
    source_canonical = _stable_taxonomy_slug(source.get("canonical_archetype"))
    source_family = _stable_taxonomy_slug(source.get("archetype_family"))
    if source_canonical:
        return source_canonical, _normalized_family(
            library,
            source_canonical,
            source_family or _default_taxonomy_family(library),
        )
    for required_terms, canonical, family in TAXONOMY_RULES.get(library, ()):
        if all(term in slug for term in required_terms):
            return canonical, _normalized_family(library, canonical, family)
    stable_slug = slug.strip("_")
    if not stable_slug or re.fullmatch(r"(?:emerging_)?(?:event|payoff|arc|emotion|worldview)_\d+", stable_slug):
        basis = "|".join(
            [
                library,
                name,
                as_text(source.get("core_mechanism")),
                as_text(source.get("definition")),
            ]
        )
        digest = hashlib.sha1(basis.encode("utf-8")).hexdigest()[:8]
        stable_slug = f"specific_mechanism_{digest}"
    stable_slug = re.sub(r"^(?:candidate_|emerging_)+", "", stable_slug)
    return stable_slug, _normalized_family(library, stable_slug, _default_taxonomy_family(library))


def _stable_taxonomy_slug(value: object) -> str:
    raw = as_text(value).lower().strip()
    if not raw or re.search(r"[^a-z0-9_\-\s]", raw):
        return ""
    slug = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    if not slug or slug.startswith(("candidate_", "emerging_")):
        return ""
    return slug[:80]


def _default_taxonomy_family(library: str) -> str:
    family_defaults = {
        "EventsLibrary": "event_mechanism",
        "PayoffAngst": "reader_reward_and_pain",
        "CharacterArc": "character_state_transition",
        "EmotionRhythm": "emotion_pressure_release",
        "Worldview": "world_system_mechanism",
    }
    return family_defaults.get(library, "narrative_mechanism")


def _normalized_family(library: str, canonical: str, family: str) -> str:
    if library != "PayoffAngst":
        return family
    if any(term in canonical for term in ("sacrifice", "sacrificial", "revival_with_cost")):
        return "sacrifice_and_consequence"
    if any(term in canonical for term in ("legacy", "grief")):
        return "grief_and_legacy"
    if any(term in canonical for term in ("power_reveal", "power_awakening", "ability")):
        return "power_awakening"
    return family


def _library_boundary_review(pattern: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    library = as_text(pattern.get("library"))
    issues: list[dict[str, str]] = []
    focus_fields = LIBRARY_SPECS[library]["focus_fields"]
    missing = [field for field in focus_fields if pattern.get(field) in (None, "", [], {})]
    if missing:
        issues.append(
            {
                "code": "missing_focus_fields",
                "severity": "needs_review",
                "detail": ",".join(missing),
            }
        )
    if not as_mapping(pattern.get("role_slots")):
        issues.append(
            {
                "code": "missing_pattern_role_slots",
                "severity": "needs_review",
                "detail": "缺少可供生成与实例映射使用的稳定角色槽位。",
            }
        )

    mechanism_text = " ".join(
        [
            as_text(pattern.get("core_mechanism")),
            *[as_text(pattern.get(field)) for field in focus_fields],
        ]
    )
    event_steps = as_list(pattern.get("event_action_sequence"))
    if library == "PayoffAngst":
        release = as_text(pattern.get("release_or_damage_action"))
        if len(release) > 220 or len(re.split(r"[；;→]", release)) > 5:
            issues.append(
                {
                    "code": "payoff_contains_long_event_flow",
                    "severity": "needs_review",
                    "detail": "释放动作包含过长事件流程，可能混入 EventsLibrary。",
                }
            )
    elif library == "EventsLibrary":
        payoff_terms = sum(term in mechanism_text for term in ("爽感", "痛感", "读者", "情绪回报", "释放期待"))
        if payoff_terms >= 3 and len(event_steps) < 2:
            issues.append(
                {
                    "code": "event_dominated_by_reader_payoff",
                    "severity": "contaminated",
                    "detail": "条目强调读者回报，但缺少可执行事件链。",
                }
            )
    elif library == "CharacterArc":
        initial = as_text(pattern.get("initial_state"))
        final = as_text(pattern.get("final_state"))
        choice = as_text(pattern.get("turning_choice"))
        if not initial or not final or initial == final or not choice:
            issues.append(
                {
                    "code": "arc_lacks_state_transition",
                    "severity": "needs_review",
                    "detail": "人物弧缺少可区分的初态、关键选择或终态。",
                }
            )
        if as_text(pattern.get("arc_scope")) not in {
            "protagonist_arc",
            "relationship_arc",
            "leadership_arc",
            "ability_growth_arc",
        }:
            issues.append(
                {
                    "code": "arc_scope_missing_or_invalid",
                    "severity": "needs_review",
                    "detail": "人物弧缺少稳定 arc_scope。",
                }
            )
    elif library == "EmotionRhythm":
        required = ("tension_accumulation", "delay_method", "release_position", "post_release_hook")
        absent = [field for field in required if pattern.get(field) in (None, "", [], {})]
        if absent:
            issues.append(
                {
                    "code": "rhythm_lacks_pressure_delay_release_hook",
                    "severity": "contaminated",
                    "detail": ",".join(absent),
                }
            )
        if len(mechanism_text) > 900 and sum(mechanism_text.count(term) for term in ("随后", "接着", "最终", "然后")) >= 5:
            issues.append(
                {
                    "code": "rhythm_contains_excessive_event_actions",
                    "severity": "needs_review",
                    "detail": "情绪节奏包含过多具体事件动作，可能混入 EventsLibrary。",
                }
            )
        release = as_text(pattern.get("release_position"))
        hook = as_text(pattern.get("post_release_hook"))
        if release and hook and re.sub(r"\s+", "", release) == re.sub(r"\s+", "", hook):
            issues.append(
                {
                    "code": "release_position_equals_post_release_hook",
                    "severity": "needs_review",
                    "detail": "释放位置与释放后钩子相同，需要重新区分节奏功能。",
                }
            )
        payoff_proximity = sum(
            term in mechanism_text
            for term in ("死亡", "复活", "牺牲", "代价", "救赎", "爽点", "痛感", "情绪回报")
        )
        if payoff_proximity >= 2:
            issues.append(
                {
                    "code": "rhythm_near_payoff_boundary",
                    "severity": "needs_review",
                    "detail": "该节奏包含明显痛感或回报机制；保留为 ER 前需确认核心仍是压力、释放与后续钩子的排列。",
                }
            )

    if any(issue["severity"] == "contaminated" for issue in issues):
        return "contaminated", issues
    if issues:
        return "needs_review", issues
    return "clean", []


def normalize_instance(row: dict[str, Any], *, materialized_id: str) -> dict[str, Any]:
    evidence = as_list(row.get("evidence_chunk_ids"))
    mechanism = as_mapping(row.get("mechanism"))
    library = as_text(row.get("library"))
    source_ref = build_source_ref(
        book_slug=as_text(row.get("book_slug")),
        evidence_chunk_ids=evidence,
        existing=row.get("source_ref"),
    )
    instance_card = normalize_instance_card(
        row.get("instance_card"),
        library=library,
        mechanism=mechanism,
        role_slots=row.get("role_slots"),
        failure_risks=row.get("failure_risks"),
        evidence_chunk_ids=evidence,
        library_context=row,
    )
    return {
        "schema_version": "pattern_instance.v3",
        "instance_id": row.get("instance_id", ""),
        "pattern_id": materialized_id,
        "source_pattern_id": row.get("pattern_id", ""),
        "library": library,
        "book_id": row.get("book_id", ""),
        "book_slug": row.get("book_slug", ""),
        "plot_id": source_ref.get("primary_plot_id", ""),
        "object_id": row.get("candidate_id", ""),
        "source_summary": row.get("candidate_name") or mechanism.get("state_change", ""),
        "mapped_slots": row.get("role_slots") if isinstance(row.get("role_slots"), dict) else {},
        "specific_variant": {
            "mechanism": mechanism,
            "variation_axes": as_list(row.get("variation_axes")),
        },
        "instance_card": instance_card,
        "arc_scope": row.get("arc_scope", ""),
        "rhythm_scope": row.get("rhythm_scope", ""),
        "rule_scope": row.get("rule_scope", ""),
        "fit_score": row.get("confidence", 0.0),
        "fit_reason": _fit_reason(row, mechanism),
        "source_ref": source_ref,
        "candidate_path": row.get("candidate_path", ""),
        "source_dependency_score": row.get("source_dependency_score", 0.4),
        "confidence": row.get("confidence", 0.0),
        "assignment_decision": row.get("assignment_decision", ""),
        "assignment_reason": row.get("assignment_reason", ""),
    }


def _fit_reason(row: dict[str, Any], mechanism: dict[str, Any]) -> str:
    assignment_reason = as_text(row.get("assignment_reason"))
    if assignment_reason:
        return assignment_reason
    trigger = as_text(mechanism.get("trigger"))
    state_change = as_text(mechanism.get("state_change"))
    actions = [as_text(value) for value in as_list(mechanism.get("action_chain")) if as_text(value)]
    parts = [
        f"包含触发条件：{trigger}" if trigger else "",
        f"包含关键行动：{'、'.join(actions[:3])}" if actions else "",
        f"产生状态变化：{state_change}" if state_change else "",
    ]
    return "；".join(part for part in parts if part) or "该实例由来源候选直接映射，并保留 Bridge 证据。"


def _promotion_readiness(
    pattern: dict[str, Any],
    variants: list[dict[str, Any]],
) -> dict[str, Any]:
    book_count = int(pattern.get("supported_book_count") or 0)
    instance_count = int(pattern.get("registered_instance_count") or 0)
    variant_count = len(variants)
    criteria = {
        "supported_books_at_least_3": book_count >= 3,
        "registered_instances_at_least_8": instance_count >= 8,
        "cross_context_variants_at_least_2": book_count >= 2 and variant_count >= 2,
        "review_issues_resolved": False,
    }
    return {
        "eligible": all(criteria.values()),
        "criteria": criteria,
        "current": {
            "supported_book_count": book_count,
            "registered_instance_count": instance_count,
            "concrete_variant_count": variant_count,
        },
    }


def _split_candidates(
    instances: list[dict[str, Any]],
    *,
    materialized_id: str,
) -> list[dict[str, Any]]:
    if len(instances) < 4:
        return []
    mechanisms = [as_mapping(as_mapping(row.get("specific_variant")).get("mechanism")) for row in instances]
    state_changes = {
        as_text(mechanism.get("state_change"))
        for mechanism in mechanisms
        if as_text(mechanism.get("state_change"))
    }
    term_sets = [_compact_terms(mechanism) for mechanism in mechanisms]
    pair_scores = [
        len(left & right) / max(1, len(left | right))
        for index, left in enumerate(term_sets)
        for right in term_sets[index + 1:]
        if left and right
    ]
    low_overlap_ratio = (
        sum(score < 0.08 for score in pair_scores) / len(pair_scores)
        if pair_scores
        else 0.0
    )
    if len(state_changes) < 3 or low_overlap_ratio < 0.65:
        return []
    return [
        {
            "candidate_id": f"split_{materialized_id}_mechanism_divergence",
            "status": "review_candidate",
            "automatic_action": False,
            "reason": "同一 pattern 内的实例状态变化差异较大，且多数实例对的机制词重合较低。",
            "signals": {
                "instance_count": len(instances),
                "distinct_state_change_count": len(state_changes),
                "low_pairwise_overlap_ratio": round(low_overlap_ratio, 4),
            },
            "review_instruction": "按触发条件、关键行动和状态变化复核是否存在两个以上稳定机制；仅题材差异不得拆分。",
        }
    ]


def _compact_terms(value: object) -> set[str]:
    text = "".join(_flatten_text(value))
    ascii_terms = {token.lower() for token in re.findall(r"[A-Za-z0-9_]{2,}", text)}
    chinese = "".join(char for char in text if "\u4e00" <= char <= "\u9fff")
    chinese_terms = {
        chinese[index:index + 2]
        for index in range(max(0, len(chinese) - 1))
    }
    return ascii_terms | chinese_terms


def _role_support(instances: list[dict[str, Any]]) -> dict[str, dict[str, float | int]]:
    counts: Counter[str] = Counter()
    for row in instances:
        counts.update(as_mapping(row.get("role_slots")).keys())
    total = max(1, len(instances))
    return {
        role: {"support_count": count, "support_ratio": round(count / total, 4)}
        for role, count in sorted(counts.items())
    }


def _prune_slots(
    old_slots: dict[str, Any],
    core_slots: dict[str, str],
    role_support: dict[str, dict[str, float | int]],
    instance_count: int,
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    optional: dict[str, str] = {}
    discarded: list[dict[str, Any]] = []
    for role, description in old_slots.items():
        if role in core_slots:
            continue
        support = role_support.get(role, {"support_count": 0, "support_ratio": 0.0})
        if instance_count and float(support["support_ratio"]) >= 0.5 and len(optional) < 2:
            optional[role] = as_text(description)
        else:
            discarded.append({"role": role, **support, "reason": "non_core_or_low_support"})
    return optional, discarded


def _example_variants(
    *,
    instances: list[dict[str, Any]],
    materialized_id: str,
    structured_axes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    seen: set[str] = set()
    for instance in instances:
        specific = as_mapping(instance.get("specific_variant"))
        mechanism = as_mapping(specific.get("mechanism"))
        instance_id = as_text(instance.get("instance_id"))
        if not instance_id or instance_id in seen:
            continue
        seen.add(instance_id)
        variant_name = as_text(instance.get("source_summary")) or f"来源实例变体 {len(variants) + 1}"
        axis_values = {
            as_text(axis.get("axis")): _instance_axis_value(axis, mechanism)
            for axis in structured_axes
            if as_text(axis.get("axis"))
        }
        variants.append(
            {
                "schema_version": "pattern_variant.v2",
                "pattern_id": materialized_id,
                "variant_id": f"{materialized_id}_V{len(variants) + 1:03d}",
                "variant_name": variant_name,
                "description": as_text(mechanism.get("state_change")) or variant_name,
                "axis_values": axis_values,
                "source_instance_ids": [instance_id],
                "variant_source_refs": [_instance_ref(instance)],
                "source_type": "source_instance_combination",
            }
        )
    return variants[:24]


def _instance_axis_value(axis: dict[str, Any], mechanism: dict[str, Any]) -> str:
    mechanism_text = " ".join(_flatten_text(mechanism))
    for value in as_list(axis.get("values")):
        if value and value in mechanism_text:
            return value
    axis_name = as_text(axis.get("axis"))
    trigger = as_text(mechanism.get("trigger"))
    pressure = as_text(mechanism.get("pressure"))
    state_change = as_text(mechanism.get("state_change"))
    reader_effect = as_text(mechanism.get("reader_effect"))
    actions = [as_text(value) for value in as_list(mechanism.get("action_chain")) if as_text(value)]
    if any(term in axis_name for term in ("结果", "后果", "反应", "程度", "终态")):
        selected = state_change or reader_effect
    elif any(term in axis_name for term in ("压力", "威胁", "阻力", "创伤", "延迟")):
        selected = pressure or trigger
    elif any(term in axis_name for term in ("方式", "行动", "解决", "介入", "调查", "声明", "选择")):
        selected = "；".join(actions[-2:]) if actions else state_change
    elif any(term in axis_name for term in ("情绪", "读者", "回报", "疼痛")):
        selected = reader_effect or state_change
    else:
        selected = trigger or pressure or state_change or (actions[0] if actions else "")
    return _compact_value(selected)


def _compact_value(value: str, *, limit: int = 72) -> str:
    text = re.sub(r"\s+", " ", value).strip(" ，。；")
    if not text:
        return "实例中未显式给出"
    return text if len(text) <= limit else f"{text[:limit].rstrip(' ，。；')}..."


def _instance_ref(instance: dict[str, Any]) -> dict[str, Any]:
    source_ref = as_mapping(instance.get("source_ref"))
    return {
        "book_id": instance.get("book_id", ""),
        "book_slug": instance.get("book_slug", ""),
        "plot_id": instance.get("plot_id", ""),
        "object_id": instance.get("object_id", ""),
        "bridge_chunk_ids": as_list(source_ref.get("bridge_chunk_ids")),
        "fit_score": instance.get("fit_score", 0.0),
    }


def _flatten_text(value: object) -> list[str]:
    if isinstance(value, dict):
        return [text for child in value.values() for text in _flatten_text(child)]
    if isinstance(value, list):
        return [text for child in value for text in _flatten_text(child)]
    text = as_text(value)
    return [text] if text else []
