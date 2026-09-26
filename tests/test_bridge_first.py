from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from Jormungandr.abstractmodel.bridge_llm import BridgeLLMResponseError
from Jormungandr.abstractmodel.bridge_pipeline import _emotion_book_task, _emotion_book_window, _reconcile_with_subdivision
from Jormungandr.abstractmodel.bridge_prompts import extraction_prompt, reconciliation_prompt
from Jormungandr.abstractmodel.instance_cards import (
    normalize_instance_card,
    resolve_source_chunks,
    upgrade_reference_instance,
)
from Jormungandr.abstractmodel.materializer import _cross_library_relations, _neighbor_score, materialize_abstract_library
from Jormungandr.abstractmodel.pattern_refinement import (
    _library_boundary_review,
    classify_archetype,
    refine_pattern,
    taxonomy_for_pattern,
)
from Jormungandr.abstractmodel.pattern_store import commit_validated_decisions, validate_reconciliation
from Jormungandr.abstractmodel.review_apply import apply_review_results
from Jormungandr.abstractmodel.run_cache import compact_completed_book_cache
from Jormungandr.abstractmodel.semantic_compaction import _apply_groups, _remap_instances, _validated_groups
from Jormungandr.abstractmodel.variation import clean_variation_axes


class ReconciliationGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.candidate = {
            "candidate_id": "candidate_1",
            "library": "EventsLibrary",
            "candidate_name": "候选事件",
            "mechanism": {"trigger": "触发", "state_change": "状态改变"},
            "evidence_chunk_ids": ["book_0001:plot1"],
        }
        self.existing = {
            "EventsLibrary": [
                {
                    "pattern_id": "event_1",
                    "library": "EventsLibrary",
                    "pattern_name": "已有事件",
                    "definition": "已有结构",
                    "core_mechanism": "不同的已有因果机制",
                }
            ]
        }

    def test_create_new_requires_two_structural_dimensions(self) -> None:
        response = {
            "decisions": [
                {
                    "candidate_id": "candidate_1",
                    "library": "EventsLibrary",
                    "decision": "create_new",
                    "nearest_pattern_id": "event_1",
                    "novelty_dimensions": ["core_mechanism"],
                    "nearest_pattern_differences": ["因果链不同"],
                    "proposed_pattern": {"pattern_name": "新事件", "core_mechanism": "新机制"},
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[self.candidate], existing=self.existing)
        self.assertEqual(result["decisions"][0]["decision"], "needs_more_evidence")

    def test_minimal_create_new_is_completed_from_candidate(self) -> None:
        response = {
            "decisions": [
                {
                    "candidate_id": "candidate_1",
                    "library": "EventsLibrary",
                    "decision": "create_new",
                    "nearest_pattern_id": "event_1",
                    "novelty_dimensions": ["causal_order", "state_change_type"],
                    "nearest_pattern_differences": ["因果顺序不同"],
                    "proposed_pattern": {"pattern_name": "新事件", "core_mechanism": "新机制"},
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[self.candidate], existing=self.existing)
        proposed = result["decisions"][0]["proposed_pattern"]
        self.assertEqual(result["decisions"][0]["decision"], "create_new")
        self.assertEqual(proposed["definition"], "新机制")
        self.assertIn("required_conditions", proposed)

    def test_setting_differences_do_not_count_as_novelty(self) -> None:
        response = {
            "decisions": [
                {
                    "candidate_id": "candidate_1",
                    "library": "EventsLibrary",
                    "decision": "create_new",
                    "nearest_pattern_id": "event_1",
                    "novelty_dimensions": ["setting", "genre"],
                    "nearest_pattern_differences": ["场景不同"],
                    "proposed_pattern": {"pattern_name": "新事件", "core_mechanism": "新机制"},
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[self.candidate], existing=self.existing)
        self.assertEqual(result["decisions"][0]["decision"], "needs_more_evidence")

    def test_valid_merge_keeps_existing_target(self) -> None:
        response = {
            "decisions": [
                {
                    "candidate_id": "candidate_1",
                    "library": "EventsLibrary",
                    "decision": "merge_existing",
                    "target_pattern_id": "event_1",
                    "evidence_chunk_ids": ["book_0001:plot1"],
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[self.candidate], existing=self.existing)
        self.assertEqual(result["decisions"][0]["decision"], "merge_existing")
        self.assertEqual(result["decision_counts"], {"merge_existing": 1})

    def test_worldview_rejects_two_plot_event_without_stable_system_rule(self) -> None:
        candidate = {
            "candidate_id": "worldview_1",
            "library": "Worldview",
            "candidate_name": "强势保护者介入",
            "mechanism": {"trigger": "高权力人物介入一次骚扰事件"},
            "evidence_chunk_ids": ["book_0001:plot27", "book_0001:plot51"],
        }
        response = {
            "decisions": [
                {
                    "candidate_id": "worldview_1",
                    "library": "Worldview",
                    "decision": "create_new",
                    "novelty_dimensions": ["causal_order", "role_power_structure"],
                    "proposed_pattern": {"pattern_name": "保护者介入", "core_mechanism": "一次事件"},
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[candidate], existing={})
        decision = result["decisions"][0]
        self.assertEqual(decision["decision"], "needs_more_evidence")
        self.assertIn(
            "worldview_missing_stable_rule_permission_or_resource_mechanism",
            decision["validation_reasons"],
        )

    def test_worldview_accepts_two_high_confidence_rule_evidence_chunks(self) -> None:
        candidate = {
            "candidate_id": "worldview_rule_1",
            "library": "Worldview",
            "candidate_name": "周期性神权筛选法则",
            "mechanism": {
                "trigger": "每百年启动神权筛选周期",
                "pressure": "旧神被强制淘汰，参与者承担牺牲代价",
                "state_change": "新旧神权按稳定法则更替",
            },
            "required_conditions": ["规则跨情节反复约束角色选择"],
            "evidence_chunk_ids": ["book_0679:plot1", "book_0679:plot51"],
            "confidence": 0.9,
        }
        response = {
            "decisions": [
                {
                    "candidate_id": "worldview_rule_1",
                    "library": "Worldview",
                    "decision": "create_new",
                    "novelty_dimensions": ["周期性筛选操控规则", "参与者承担牺牲代价"],
                    "proposed_pattern": {
                        "pattern_name": "周期性神权筛选法则",
                        "core_mechanism": "周期规则强制更替神权，并以参与者牺牲作为执行成本。",
                    },
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[candidate], existing={})
        self.assertEqual(result["decisions"][0]["decision"], "create_new")

    def test_worldview_accepts_structured_novelty_dimensions(self) -> None:
        candidate = {
            "candidate_id": "worldview_rule_2",
            "library": "Worldview",
            "candidate_name": "神经芯片干预规则",
            "mechanism": {
                "trigger": "植入物持续控制神经权限",
                "pressure": "干预精度和失败代价反复约束人物选择",
                "state_change": "资源掌控者能够改变参与者行动权限",
            },
            "required_conditions": ["规则跨情节重复执行"],
            "evidence_chunk_ids": ["book_0696:plot1", "book_0696:plot18"],
            "confidence": 0.91,
        }
        response = {
            "decisions": [
                {
                    "candidate_id": "worldview_rule_2",
                    "library": "Worldview",
                    "decision": "create_new",
                    "novelty_dimensions": [
                        {"dimension": "干预性质", "difference": "直接接管，而非环境间接筛选"},
                        {"dimension": "权力来源", "difference": "可操作设备，而非超自然系统"},
                    ],
                    "proposed_pattern": {
                        "pattern_name": "神经芯片干预规则",
                        "core_mechanism": "资源掌控者通过植入物持续改变参与者的行动权限。",
                    },
                }
            ]
        }
        result = validate_reconciliation(response, candidates=[candidate], existing={})
        self.assertEqual(result["decisions"][0]["decision"], "create_new")

    def test_source_taxonomy_is_preserved_when_stable(self) -> None:
        source = {
            "pattern_id": "emerging_arc_0001",
            "library": "CharacterArc",
            "pattern_name": "自定义人物弧",
            "canonical_archetype": "dependency_to_independent_agency",
            "archetype_family": "autonomy_recovery",
            "core_mechanism": "角色从依赖转向独立决策。",
        }
        _, canonical, family, spec = taxonomy_for_pattern(
            "CharacterArc",
            "自定义人物弧",
            source=source,
        )
        self.assertEqual(canonical, "dependency_to_independent_agency")
        self.assertEqual(family, "autonomy_recovery")
        self.assertEqual(spec["slug"], "dependency_to_independent_agency")

    def test_commit_adds_one_idempotent_instance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library_root = root / "EventsLibrary"
            library_root.mkdir(parents=True)
            pattern = dict(self.existing["EventsLibrary"][0])
            (library_root / "emerging_patterns.jsonl").write_text(
                json.dumps(pattern, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            (library_root / "universal_patterns.jsonl").write_text("", encoding="utf-8")
            decision = {
                "candidate_id": "candidate_1",
                "library": "EventsLibrary",
                "decision": "merge_existing",
                "target_pattern_id": "event_1",
                "reason": "same mechanism",
                "candidate": self.candidate,
            }
            first = commit_validated_decisions([decision], abstract_library_root=root, book_id="0001")
            second = commit_validated_decisions([decision], abstract_library_root=root, book_id="0001")
            instances = [
                json.loads(line)
                for line in (library_root / "instances.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            updated = json.loads((library_root / "emerging_patterns.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(first["instances_added"], 1)
            self.assertEqual(second["instances_added"], 0)
            self.assertEqual(second["instances_duplicate"], 1)
            self.assertEqual(len(instances), 1)
            self.assertEqual(updated["registered_instance_count"], 1)
            self.assertEqual(updated["supported_books"], ["id000001"])

    def test_incomplete_reconciliation_is_subdivided_without_omissions(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.last_usage = {}

            def generate_json(self, *, system_prompt: str, user_prompt: str):
                del system_prompt
                payload = json.loads(user_prompt)
                candidates = payload["candidates"]
                self.last_usage = {"input_tokens": 10, "output_tokens": 5}
                if len(candidates) > 2:
                    raise BridgeLLMResponseError(
                        "truncated",
                        raw_response="{",
                        usage=dict(self.last_usage),
                    )
                response = {
                    "decisions": [
                        {
                            "candidate_id": row["candidate_id"],
                            "library": row["library"],
                            "decision": "needs_more_evidence",
                        }
                        for row in candidates
                    ]
                }
                return response, json.dumps(response)

        candidates = [
            {"candidate_id": f"candidate_{index}", "library": "EventsLibrary"}
            for index in range(6)
        ]
        parsed, _, status, error, usage = _reconcile_with_subdivision(
            client=FakeClient(),
            book_id="0001",
            reconcile_id="test",
            candidates=candidates,
            shortlist={"EventsLibrary": []},
        )
        self.assertEqual(status, "ok")
        self.assertEqual(error, "")
        self.assertEqual(len(parsed["decisions"]), 6)
        self.assertEqual(usage["output_tokens"], 20)

    def test_same_book_candidate_is_reassigned_instead_of_duplicated(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library_root = root / "EventsLibrary"
            library_root.mkdir(parents=True)
            patterns = [
                {"pattern_id": "event_1", "library": "EventsLibrary", "pattern_name": "旧归类"},
                {"pattern_id": "event_2", "library": "EventsLibrary", "pattern_name": "新归类"},
            ]
            (library_root / "emerging_patterns.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in patterns) + "\n",
                encoding="utf-8",
            )
            (library_root / "universal_patterns.jsonl").write_text("", encoding="utf-8")
            first = {
                "candidate_id": "candidate_1",
                "library": "EventsLibrary",
                "decision": "merge_existing",
                "target_pattern_id": "event_1",
                "candidate": self.candidate,
            }
            second = {**first, "target_pattern_id": "event_2"}
            commit_validated_decisions([first], abstract_library_root=root, book_id="0001")
            result = commit_validated_decisions([second], abstract_library_root=root, book_id="0001")
            instances = [
                json.loads(line)
                for line in (library_root / "instances.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(result["instances_reassigned"], 1)
            self.assertEqual(len(instances), 1)
            self.assertEqual(instances[0]["pattern_id"], "event_2")

    def test_richer_instance_card_upgrades_same_source_without_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library_root = root / "EventsLibrary"
            library_root.mkdir(parents=True)
            pattern = dict(self.existing["EventsLibrary"][0])
            (library_root / "emerging_patterns.jsonl").write_text(
                json.dumps(pattern, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            (library_root / "universal_patterns.jsonl").write_text("", encoding="utf-8")
            base_decision = {
                "candidate_id": "candidate_1",
                "library": "EventsLibrary",
                "decision": "merge_existing",
                "target_pattern_id": "event_1",
                "candidate": self.candidate,
            }
            commit_validated_decisions([base_decision], abstract_library_root=root, book_id="0001")
            rich_candidate = {
                **self.candidate,
                "instance_card": {
                    "portable_core": ["绝境启用高风险资源", "新资源同时制造追踪风险"],
                    "implementation_details": ["角色利用短暂能力发现突破口"],
                    "source_locked_details": ["原作专属装置名"],
                    "fusion_hooks": ["可连接追捕事件"],
                    "scene_context": {
                        "before_state": "角色处于弱势逃亡状态",
                        "immediate_goal": "离开封锁区",
                        "active_obstacle": "出口由敌对势力控制",
                        "stakes": "失败将失去行动自由",
                        "available_resources": ["来源不明的高风险装置"],
                    },
                    "causal_chain": [
                        {
                            "step": 1,
                            "action": "角色决定启用装置",
                            "cause": "常规路线被切断",
                            "effect": "获得短暂感知能力并暴露信号",
                            "decision_owner": "能力获得者",
                        }
                    ],
                    "turning_point": {
                        "event": "角色主动用新能力反击",
                        "why_it_changes_direction": "从逃避代价转为主动承担",
                        "new_information_or_resource": "确认能力可干扰敌方感知",
                    },
                    "after_state": {
                        "overall_change": "弱势逃亡者成为被追踪的能力持有者",
                        "power_change": "获得初步异常感知",
                        "new_hook": "追捕因信号暴露而升级",
                    },
                },
            }
            upgraded = commit_validated_decisions(
                [{**base_decision, "candidate": rich_candidate}],
                abstract_library_root=root,
                book_id="0001",
            )
            instances = [
                json.loads(line)
                for line in (library_root / "instances.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(upgraded["instances_enriched"], 1)
            self.assertEqual(len(instances), 1)
            self.assertEqual(instances[0]["schema_version"], "reference_pattern_instance.v2")
            self.assertEqual(instances[0]["instance_card"]["grounding_mode"], "llm_grounded")
            self.assertEqual(instances[0]["source_ref"]["primary_plot_id"], "plot1")

    def test_reconciliation_prompt_excludes_instance_card_payload(self) -> None:
        candidate = {
            **self.candidate,
            "instance_card": {
                "portable_core": ["可迁移机制"],
                "causal_chain": [{"step": 1, "action": "行动"}],
            },
        }
        window = {
            "book_id": "0001",
            "window_id": "book_0001:w0001",
            "chunk_ids": ["book_0001:plot1"],
            "evidence": [],
        }
        extraction_payload = json.loads(
            extraction_prompt(window, libraries=["EventsLibrary"], candidate_budget=1)
        )
        reconciliation_payload = json.loads(
            reconciliation_prompt(
                book_id="0001",
                window_id="reconcile_1",
                candidates=[candidate],
                existing_patterns={"EventsLibrary": []},
            )
        )
        self.assertIn("scene_context", extraction_payload["instance_card_schema_by_library"]["EventsLibrary"])
        self.assertNotIn("instance_card", reconciliation_payload["candidates"][0])


class MaterializerTest(unittest.TestCase):
    def test_instance_roles_and_missing_axis_values_are_materialized(self) -> None:
        source = {
            "pattern_id": "emerging_event_0001",
            "library": "EventsLibrary",
            "pattern_name": "未注册事件",
            "core_mechanism": "角色受压后采取行动并改变外部局势。",
            "variation_axes": ["危机强度"],
            "supported_books": ["book_0001"],
            "supported_book_count": 1,
            "registered_instance_count": 1,
        }
        instances = [
            {
                "instance_id": "one",
                "pattern_id": "emerging_event_0001",
                "library": "EventsLibrary",
                "book_id": "0001",
                "book_slug": "book_0001",
                "candidate_id": "candidate_one",
                "role_slots": {"行动者": "启动行动的一方", "阻碍者": "维持原状的一方"},
                "mechanism": {"trigger": "危机", "action_chain": ["行动"], "state_change": "局势改变"},
                "evidence_chunk_ids": ["book_0001:plot1"],
            }
        ]
        pattern, *_ = refine_pattern(source, materialized_id="EL_0001_test", instances=instances)
        self.assertTrue(pattern["role_slots"])
        self.assertTrue(all(axis["values"] for axis in pattern["variation_axes"]))

    def test_two_book_pattern_is_cross_book_candidate(self) -> None:
        source = {
            "pattern_id": "emerging_payoff_0001",
            "library": "PayoffAngst",
            "pattern_name": "遗志继承痛感释放",
            "canonical_archetype": "legacy_inheritance_grief_release",
            "archetype_family": "grief_and_legacy",
            "core_mechanism": "牺牲留下遗志，幸存者把悲恸转化为行动。",
            "supported_books": ["book_0001", "book_0002"],
            "supported_book_count": 2,
            "registered_instance_count": 2,
        }
        pattern, *_ = refine_pattern(source, materialized_id="PA_0001_test", instances=[])
        self.assertEqual(pattern["pattern_status"], "emerging_pattern")
        self.assertEqual(pattern["evidence_tier"], "cross_book_candidate")
        self.assertTrue(pattern["cross_book_candidate"])

    def test_emotion_book_window_requests_stage_and_book_curves(self) -> None:
        chunks = [
            {
                "book_slug": "book_0001",
                "book_id": "0001",
                "plot_index": index,
                "chunk_id": f"book_0001:plot{index}",
                "quality_tier": "rich",
                "summary": "危机转折与情绪释放",
            }
            for index in range(1, 21)
        ]
        window = _emotion_book_window(chunks)
        task = _emotion_book_task(chunks, candidate_budget=1)
        self.assertEqual(window["requested_rhythm_scopes"], ["stage_curve", "book_curve"])
        self.assertLessEqual(len(window["chunk_ids"]), 16)
        self.assertEqual(task["candidate_budget_per_library"], 2)

    def test_materializes_pattern_first_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source"
            source_library = source / "EventsLibrary"
            source_library.mkdir(parents=True)
            source_pattern = {
                "pattern_id": "emerging_event_001",
                "library": "EventsLibrary",
                "pattern_name": "证据翻盘后主角夺回话语权",
                "core_mechanism": "旧版兼容字段。",
                "role_slots": {"protagonist": "主角"},
                "required_conditions": ["存在证据"],
                "variation_axes": ["候选变体：公开场合证据展示"],
                "failure_risks": ["证据无效"],
                "supported_books": ["book_0001"],
                "supported_book_count": 1,
            }
            (source_library / "emerging_patterns.jsonl").write_text(
                json.dumps(source_pattern, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            source_instance = {
                "instance_id": "EventsLibrary:book_0001:emerging_event_001:book_0001_plot1",
                "pattern_id": "emerging_event_001",
                "library": "EventsLibrary",
                "book_id": "0001",
                "book_slug": "book_0001",
                "candidate_id": "candidate_001",
                "candidate_name": "证据翻盘",
                "mechanism": {
                    "trigger": "公开指控造成名誉损害",
                    "pressure": "错误评价持续扩散",
                    "action_chain": ["收集证据", "公开证据", "裁决者改判"],
                    "state_change": "评价权由指控者转向主角",
                    "reader_effect": "读者获得评价反转爽感",
                },
                "variation_axes": ["证据类型：记录或证人"],
                "evidence_chunk_ids": ["book_0001:plot1"],
                "confidence": 0.9,
            }
            (source_library / "instances.jsonl").write_text(
                json.dumps(source_instance, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            output = Path(temp_dir) / "output"
            result = materialize_abstract_library(source_root=source, output_root=output)
            self.assertEqual(result["pattern_count"], 1)
            self.assertTrue((output / "pattern_index.jsonl").exists())
            self.assertTrue((output / "library_index.json").exists())
            self.assertTrue((output / "cross_library_relations.jsonl").exists())
            self.assertTrue((output / "_routing" / "abstractmodel_manifest.json").exists())
            self.assertTrue((output / "_routing" / "pattern_instance_index.jsonl").exists())
            self.assertTrue((output / "quality_reports" / "pattern_support_report.json").exists())
            self.assertTrue((output / "quality_reports" / "relation_quality_report.json").exists())
            self.assertTrue((output / "quality_reports" / "merge_candidate_report.json").exists())
            self.assertTrue((output / "quality_reports" / "worldview_threshold_report.json").exists())
            folders = list((output / "EventsLibrary" / "patterns").iterdir())
            self.assertEqual(len(folders), 1)
            expected = {"pattern.json", "instances.jsonl", "variants.jsonl", "counterexamples.jsonl", "review.json"}
            self.assertTrue(all(expected.issubset({path.name for path in folder.iterdir()}) for folder in folders))
            pattern = json.loads((folders[0] / "pattern.json").read_text(encoding="utf-8"))
            self.assertEqual(pattern["event_trigger"], "公开指控造成名誉损害")
            self.assertEqual(pattern["event_action_sequence"], ["收集证据", "公开证据", "裁决者改判"])
            self.assertEqual(pattern["source_quality_score"], 0.9)
            self.assertEqual(pattern["source_refs"][0]["bridge_chunk_ids"], ["book_0001:plot1"])
            self.assertTrue(pattern["canonical_archetype"])
            self.assertFalse(pattern["canonical_archetype"].startswith("candidate_"))
            self.assertTrue(pattern["archetype_family"])
            self.assertIn("source_archetype", pattern)
            self.assertIsInstance(pattern["variation_axes"][0], dict)
            self.assertEqual(set(pattern["variation_axes"][0]), {"axis", "values", "function"})
            variant = json.loads((folders[0] / "variants.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(variant["schema_version"], "pattern_variant.v2")
            self.assertEqual(variant["source_instance_ids"], [source_instance["instance_id"]])
            instance = json.loads((folders[0] / "instances.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertTrue(instance["fit_reason"])
            self.assertEqual(instance["schema_version"], "pattern_instance.v3")
            self.assertEqual(instance["instance_card"]["grounding_mode"], "legacy_derived")
            self.assertEqual(instance["source_ref"]["primary_plot_id"], "plot1")
            self.assertEqual(
                instance["source_ref"]["bridge_index_path"],
                "Library/BridgeIndex/books/book_0001.jsonl",
            )
            review = json.loads((folders[0] / "review.json").read_text(encoding="utf-8"))
            self.assertIn("merge_candidates", review)
            self.assertIn("split_candidates", review)
            self.assertIn("promote_to_universal_when", review)
            self.assertIn("library_boundary_status", review)
            self.assertIn("variation_cleaning_log", review)
            self.assertIn("should_merge", review)
            self.assertIn("should_split", review)
            self.assertFalse(review["promotion_readiness"]["eligible"])
            self.assertTrue((output / "instance_index.jsonl").exists())

    def test_library_specific_instance_cards_and_deep_source_lookup(self) -> None:
        cards = {
            "PayoffAngst": {"emotional_setup": {"release_beat": "公开兑现回报"}},
            "CharacterArc": {"arc_path": {"turning_choice": "主动承担责任"}},
            "EmotionRhythm": {
                "emotion_beats": [
                    {"beat_index": 1, "reader_emotion": "焦虑", "intensity": 4, "tension_delta": 1}
                ]
            },
            "Worldview": {
                "rule_application": {
                    "rule_statement": "身份等级决定资源准入",
                    "event_examples": [{"chunk_id": "book_0001:plot1", "application": "低等级角色被拒绝"}],
                }
            },
        }
        expected_fields = {
            "PayoffAngst": "emotional_setup",
            "CharacterArc": "arc_path",
            "EmotionRhythm": "emotion_beats",
            "Worldview": "rule_application",
        }
        for library, raw in cards.items():
            card = normalize_instance_card(
                raw,
                library=library,
                mechanism={"trigger": "规则触发", "action_chain": ["行动"], "state_change": "状态改变"},
                evidence_chunk_ids=["book_0001:plot1"],
            )
            self.assertEqual(card["grounding_mode"], "llm_grounded")
            self.assertIn(expected_fields[library], card)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            book_path = root / "books" / "book_0001.jsonl"
            book_path.parent.mkdir(parents=True)
            book_path.write_text(
                "\n".join(
                    json.dumps({"chunk_id": f"book_0001:plot{index}", "summary": f"情节{index}"}, ensure_ascii=False)
                    for index in (1, 2)
                )
                + "\n",
                encoding="utf-8",
            )
            resolved = resolve_source_chunks(
                {"bridge_chunk_ids": ["book_0001:plot2"]},
                bridge_index_root=root,
            )
            self.assertEqual([row["chunk_id"] for row in resolved], ["book_0001:plot2"])

    def test_reference_instance_upgrade_is_idempotent(self) -> None:
        legacy = {
            "schema_version": "reference_pattern_instance.v1",
            "instance_id": "one",
            "library": "EventsLibrary",
            "book_slug": "book_0001",
            "mechanism": {
                "trigger": "危机触发",
                "pressure": "出口受阻",
                "action_chain": ["寻找证据", "公开反击"],
                "state_change": "评价权改变",
            },
            "evidence_chunk_ids": ["book_0001:plot1", "book_0001:plot2"],
        }
        once = upgrade_reference_instance(legacy)
        twice = upgrade_reference_instance(once)
        self.assertEqual(once, twice)
        self.assertEqual(once["schema_version"], "reference_pattern_instance.v2")
        self.assertEqual(once["source_ref"]["supporting_plot_ids"], ["plot2"])

    def test_legacy_rhythm_fallback_does_not_treat_post_release_hook_as_release(self) -> None:
        card = normalize_instance_card(
            None,
            library="EmotionRhythm",
            mechanism={
                "action_chain": [
                    "复活牺牲同伴，读者获得希望释放",
                    "复活者却陷入疯狂并制造新危机",
                ]
            },
        )
        self.assertEqual(card["emotion_beats"][0]["reader_emotion"], "希望或释然")
        self.assertEqual(card["emotion_beats"][0]["release_delta"], 1)
        self.assertEqual(card["emotion_beats"][1]["reader_emotion"], "紧张与不安")
        self.assertEqual(card["emotion_beats"][1]["release_delta"], 0)

    def test_unknown_archetype_becomes_source_defined_pattern(self) -> None:
        archetype, spec = classify_archetype(
            "EventsLibrary",
            "尚未注册的新事件机制",
            source={
                "core_mechanism": "特定触发改变行动权限，并产生不可逆后果。",
                "required_conditions": ["必须存在不可逆权限变化"],
                "role_slots": {"actor": "采取行动的一方"},
            },
        )
        self.assertTrue(archetype.startswith("source_defined_"))
        self.assertTrue(spec["source_defined"])
        self.assertNotEqual(spec["slug"], "custom_pattern")
        self.assertEqual(spec["core_mechanism"], "特定触发改变行动权限，并产生不可逆后果。")

    def test_cross_library_relations_use_shared_bridge_evidence(self) -> None:
        patterns = {
            "EL_0001": {
                "pattern_id": "EL_0001",
                "pattern_name": "公开反击事件",
                "library": "EventsLibrary",
                "core_mechanism": "证据进入公开场域并改变裁决",
                "source_refs": [{"bridge_chunk_ids": ["book_0001:plot1"]}],
            },
            "PA_0001": {
                "pattern_id": "PA_0001",
                "pattern_name": "公开评价反转爽点",
                "library": "PayoffAngst",
                "core_mechanism": "公开压力延迟后由证据释放",
                "source_refs": [{"bridge_chunk_ids": ["book_0001:plot1"]}],
            },
        }
        relations = _cross_library_relations(patterns)
        self.assertEqual(len(relations), 1)
        self.assertEqual(relations[0]["relation_type"], "event_can_trigger_payoff")
        self.assertEqual(relations[0]["relation_basis"]["shared_bridge_chunk_ids"], ["book_0001:plot1"])
        self.assertIn(relations[0]["relation_status"], {"strong", "weak", "needs_review", "rejected"})
        self.assertIn("shared_mechanism", relations[0])
        self.assertIn("why_this_relation", relations[0])

    def test_worldview_can_form_grounded_cross_plot_relation(self) -> None:
        patterns = {
            "WV_0001": {
                "pattern_id": "WV_0001",
                "pattern_name": "神经控制规则",
                "library": "Worldview",
                "stable_rule": "芯片可以持续接管目标神经行动权限",
                "constraint": "目标失去自由行动能力",
                "core_mechanism": "芯片控制神经权限",
                "supported_books": ["book_0001"],
                "source_refs": [{"bridge_chunk_ids": ["book_0001:plot1"]}],
            },
            "EL_0001": {
                "pattern_id": "EL_0001",
                "pattern_name": "芯片能力觉醒事件",
                "library": "EventsLibrary",
                "event_trigger": "角色激活神经芯片",
                "event_consequence": "角色获得行动控制能力",
                "core_mechanism": "激活芯片获得神经控制能力",
                "supported_books": ["book_0001"],
                "source_refs": [{"bridge_chunk_ids": ["book_0001:plot2"]}],
            },
        }
        relations = _cross_library_relations(patterns)
        relation = next(row for row in relations if row["relation_type"] == "worldview_can_enable_event")
        self.assertTrue(relation["shared_mechanism"])
        self.assertIn("规则", relation["why_this_relation"])

    def test_sacrifice_payoffs_are_reported_as_siblings_not_automatic_merge(self) -> None:
        basis = _neighbor_score(
            {
                "pattern_id": "PA_1",
                "library": "PayoffAngst",
                "pattern_name": "牺牲倒计时释放",
                "canonical_archetype": "sacrifice_countdown_release",
                "archetype_family": "sacrifice_and_consequence",
                "core_mechanism": "角色在死亡倒计时中完成目标后牺牲。",
            },
            {
                "pattern_id": "PA_2",
                "library": "PayoffAngst",
                "pattern_name": "牺牲复活代价之痛",
                "canonical_archetype": "sacrificial_revival_with_cost",
                "archetype_family": "sacrifice_and_consequence",
                "core_mechanism": "角色复活同伴但立即付出精神代价。",
            },
        )
        self.assertEqual(basis["shared_sibling_theme"], "sacrifice_death_legacy")
        self.assertFalse(basis["same_canonical_archetype"])

    def test_semantic_compaction_preserves_instances_and_evidence(self) -> None:
        rows = [
            {"pattern_id": "emerging_event_0001", "library": "EventsLibrary", "pattern_name": "旧名一", "core_mechanism": "旧机制", "supported_books": ["book_0001"]},
            {"pattern_id": "emerging_event_0002", "library": "EventsLibrary", "pattern_name": "旧名二", "core_mechanism": "旧机制二", "supported_books": ["book_0001"]},
        ]
        groups = [{"member_pattern_ids": ["emerging_event_0001", "emerging_event_0002"], "reason": "same skeleton", "canonical_pattern": {"pattern_name": "统一事件", "core_mechanism": "统一机制"}}]
        compacted, mapping = _apply_groups("EventsLibrary", rows, groups)
        instances = _remap_instances(
            [{"instance_id": "EventsLibrary:book_0001:emerging_event_0002:plot2", "pattern_id": "emerging_event_0002", "evidence_chunk_ids": ["book_0001:plot2"]}],
            mapping,
        )
        self.assertEqual(len(compacted), 1)
        self.assertEqual(compacted[0]["pattern_name"], "统一事件")
        self.assertEqual(instances[0]["pattern_id"], "emerging_event_0001")
        self.assertIn("emerging_event_0001", instances[0]["instance_id"])

    def test_semantic_compaction_only_accepts_cross_book_one_to_one_groups(self) -> None:
        rows = [
            {"pattern_id": "event_1", "supported_books": ["book_0001"]},
            {"pattern_id": "event_2", "supported_books": ["book_0001"]},
            {"pattern_id": "event_3", "supported_books": ["book_0002"]},
        ]
        canonical = {"pattern_name": "统一事件", "core_mechanism": "同一机制"}
        same_book = _validated_groups(
            {"groups": [{"member_pattern_ids": ["event_1", "event_2"], "canonical_pattern": canonical}]},
            rows,
        )
        cross_book = _validated_groups(
            {"groups": [{"member_pattern_ids": ["event_1", "event_3"], "canonical_pattern": canonical}]},
            rows,
        )
        self.assertTrue(all(len(group["member_pattern_ids"]) == 1 for group in same_book))
        self.assertIn(["event_1", "event_3"], [group["member_pattern_ids"] for group in cross_book])

    def test_variation_cleaning_removes_noise_duplicates_and_broken_values(self) -> None:
        cleaned, discarded, log = clean_variation_axes(
            [
                ". 解决方式：法律手段/法律手段/物理边界（空间入侵",
                "解决方式：其他/协商",
                "场域：会议/直播/审判/宴会/学校/公司/家庭/宗门/法庭",
            ]
        )
        self.assertEqual(cleaned[0]["axis"], "解决方式")
        self.assertEqual(cleaned[0]["values"], ["法律手段", "物理边界（空间入侵）"])
        self.assertTrue(any(row["reason"] == "duplicate_axis" for row in discarded))
        self.assertTrue(any(row["reason"] == "axis_value_limit" for row in discarded))
        self.assertTrue(any(row["action"] == "repaired_parentheses" for row in log))

    def test_library_boundary_marks_rhythm_without_release_structure(self) -> None:
        status, issues = _library_boundary_review(
            {
                "library": "EmotionRhythm",
                "core_mechanism": "角色执行一连串追捕动作。",
                "rhythm_scope": "plot_cycle",
                "emotion_start": "紧张",
                "tension_accumulation": "追捕升级",
                "delay_method": "",
                "release_position": "",
                "post_release_hook": "",
                "reader_state_change": "",
            }
        )
        self.assertEqual(status, "contaminated")
        self.assertTrue(any(row["code"] == "rhythm_lacks_pressure_delay_release_hook" for row in issues))

    def test_review_apply_records_merge_plan_without_mutating_patterns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "AbstractLibrary"
            root.mkdir(parents=True)
            patterns = [
                {"pattern_id": "EL_0001_one"},
                {"pattern_id": "EL_0002_two"},
            ]
            (root / "pattern_index.jsonl").write_text(
                "\n".join(json.dumps(row) for row in patterns) + "\n",
                encoding="utf-8",
            )
            (root / "cross_library_relations.jsonl").write_text("", encoding="utf-8")
            review_path = Path(temp_dir) / "review.jsonl"
            review_path.write_text(
                json.dumps(
                    {
                        "review_id": "review_test_1",
                        "action": "merge",
                        "pattern_id": "EL_0001_one",
                        "target_pattern_id": "EL_0002_two",
                        "reason": "same core mechanism",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            result = apply_review_results(review_results=review_path, abstract_library_root=root)
            self.assertEqual(result["pending_action_count"], 1)
            pending = json.loads(
                (root / "_routing" / "pending_split_merge_actions.jsonl").read_text(encoding="utf-8").strip()
            )
            self.assertEqual(pending["execution_status"], "pending_manual_orchestrated_apply")
            self.assertEqual(
                json.loads((root / "pattern_index.jsonl").read_text(encoding="utf-8").splitlines()[0]),
                patterns[0],
            )

    def test_completed_run_cache_keeps_evidence_and_drops_raw_replay_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            extraction = {
                "status": "ok",
                "parsed_response": {"candidates": [{"candidate_id": "one"}]},
                "raw_response": "large duplicate payload",
            }
            reconciliation = {
                "status": "ok",
                "parsed_response": {"decisions": []},
                "validated_response": {"decisions": [{"candidate_id": "one"}]},
                "raw_response": "large duplicate payload",
                "existing_pattern_shortlist": {"EventsLibrary": []},
            }
            (root / "extractions.jsonl").write_text(json.dumps(extraction) + "\n", encoding="utf-8")
            (root / "reconciliations.jsonl").write_text(json.dumps(reconciliation) + "\n", encoding="utf-8")
            (root / "tasks.jsonl").write_text("{}\n", encoding="utf-8")
            result = compact_completed_book_cache(root)
            compact_extraction = json.loads((root / "extractions.jsonl").read_text(encoding="utf-8"))
            compact_reconciliation = json.loads((root / "reconciliations.jsonl").read_text(encoding="utf-8"))
            self.assertNotIn("raw_response", compact_extraction)
            self.assertIn("parsed_response", compact_extraction)
            self.assertNotIn("raw_response", compact_reconciliation)
            self.assertNotIn("parsed_response", compact_reconciliation)
            self.assertIn("validated_response", compact_reconciliation)
            self.assertFalse((root / "tasks.jsonl").exists())
            self.assertTrue(result["removed_task_file"])


if __name__ == "__main__":
    unittest.main()
