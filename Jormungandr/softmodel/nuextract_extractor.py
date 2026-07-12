from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any

from shared import (
    PROJECT_ROOT,
    detect_default_weights_root,
    parse_json_payload,
    resolve_model_source,
)

from .schemas import SemanticFeatures


NUEXTRACT_MODEL_VARIANTS = {
    "2b": "NuExtract_2B",
    "4b": "NuExtract_4B",
    "8b": "NuExtract_8B",
}
DEFAULT_NUEXTRACT_VARIANT = "8b"
DEFAULT_NUEXTRACT_MODEL = NUEXTRACT_MODEL_VARIANTS[DEFAULT_NUEXTRACT_VARIANT]
DEFAULT_INFERENCE_BACKEND = "vllm"

DEFAULT_SCHEMA_TEMPLATE = {
    "summary": "",
    "detailed_summary": [],
    "protagonist": [],
    "current_scene": [],
    "current_goal_or_task": [],
    "supporting_characters": [],
    "items_and_props": [],
    "protagonist_current_state": [],
    "chapter_function": [],
    "key_scenes": [],
    "important_dialogue_topics": [],
    "conflicts": [],
    "foreshadowing": [],
    "clues": [],
    "ending_hook": "",
    "state_changes": [],
    "relationship_changes": [],
    "world_rules_or_system_changes": [],
    "tone": "",
    "open_questions": [],
}

MAIN_EXTRACTION_SCHEMA_TEMPLATE = {
    key: value for key, value in DEFAULT_SCHEMA_TEMPLATE.items() if key != "detailed_summary"
}

DEFAULT_ENTITY_ROLE_SCHEMA = {
    "主角": [],
    "当前场景": [],
    "当前目标和任务": [],
    "配角": [],
    "物体道具": [],
    "主角当前状态": [],
}

DEFAULT_STRUCTURAL_BACKFILL_SCHEMA = {
    "key_scenes": [],
    "conflicts": [],
    "foreshadowing": [],
    "clues": [],
    "ending_hook": "",
    "state_changes": [],
}

DEFAULT_DETAILED_SUMMARY_SCHEMA = {
    "summary": "",
}

ROLE_FIELD_MAP = {
    "主角": "protagonist",
    "当前场景": "current_scene",
    "当前目标和任务": "current_goal_or_task",
    "配角": "supporting_characters",
    "物体道具": "items_and_props",
    "主角当前状态": "protagonist_current_state",
}

ROLE_FIELD_ALIASES = {
    "主角": ["主角", "protagonist"],
    "当前场景": ["当前场景", "current_scene"],
    "当前目标和任务": ["当前目标和任务", "current_goal_or_task"],
    "配角": ["配角", "supporting_characters"],
    "物体道具": ["物体道具", "items_and_props"],
    "主角当前状态": ["主角当前状态", "protagonist_current_state"],
}


class NuExtractExtractor:
    def __init__(
        self,
        model_name: str = DEFAULT_NUEXTRACT_MODEL,
        *,
        model_variant: str = DEFAULT_NUEXTRACT_VARIANT,
        weights_root: str | None = None,
        max_input_chars: int = 6000,
        max_new_tokens: int = 768,
        detailed_summary_chunk_chars: int = 300,
        detailed_summary_max_new_tokens: int = 96,
        device_map: str = "auto",
        inference_backend: str = DEFAULT_INFERENCE_BACKEND,
        vllm_tensor_parallel_size: int = 1,
        vllm_gpu_memory_utilization: float = 0.85,
        vllm_max_model_len: int = 8192,
        vllm_max_num_seqs: int | None = None,
        vllm_generate_batch_size: int | None = 16,
        vllm_enforce_eager: bool = False,
    ) -> None:
        self.model_variant = model_variant.lower()
        self.model_name = model_name
        self.weights_root = weights_root
        self.max_input_chars = max_input_chars
        self.max_new_tokens = max_new_tokens
        self.detailed_summary_chunk_chars = detailed_summary_chunk_chars
        self.detailed_summary_max_new_tokens = detailed_summary_max_new_tokens
        self.device_map = device_map
        self.inference_backend = str(inference_backend or DEFAULT_INFERENCE_BACKEND).strip().lower()
        self.vllm_tensor_parallel_size = max(1, int(vllm_tensor_parallel_size))
        self.vllm_gpu_memory_utilization = max(0.2, min(0.98, float(vllm_gpu_memory_utilization)))
        self.vllm_max_model_len = max(2048, int(vllm_max_model_len))
        self.vllm_max_num_seqs = max(1, int(vllm_max_num_seqs)) if vllm_max_num_seqs else None
        self.vllm_generate_batch_size = max(1, int(vllm_generate_batch_size)) if vllm_generate_batch_size else None
        self.vllm_enforce_eager = bool(vllm_enforce_eager)
        self._tokenizer = None
        self._model = None
        self._backend = "causal_lm"
        self._runtime_backend = "transformers"
        self.resolved_model_source: str | None = None
        self._config_data: dict[str, Any] = {}

    def extract_batch(self, chapters: list[dict[str, str]]) -> list[SemanticFeatures]:
        if not chapters:
            return []

        self.load()
        if self._runtime_backend != "vllm":
            return [
                self.extract(title=str(chapter.get("title", "")), content=str(chapter.get("content", "")))
                for chapter in chapters
            ]

        prepared: list[dict[str, Any]] = []
        for chapter in chapters:
            content = str(chapter.get("content", ""))
            prepared.append(
                {
                    "title": str(chapter.get("title", "")),
                    "content": content,
                    "base_content": content[: self.max_input_chars],
                }
            )

        schema = json.dumps(MAIN_EXTRACTION_SCHEMA_TEMPLATE, ensure_ascii=False, indent=2)
        prompts = [
            self._render_schema_chat_prompt(
                messages=[{"role": "user", "content": self._build_document_text(title=item["title"], content=item["base_content"])}],
                schema=schema,
            )
            for item in prepared
        ]

        generated_texts = self._generate_vllm_batch_from_rendered_prompts(
            prompts,
            max_new_tokens=self.max_new_tokens,
        )

        payloads: list[dict[str, Any] | None] = [None] * len(prepared)
        fallback_indexes: list[int] = []
        for index, generated_text in enumerate(generated_texts):
            try:
                payload = self.parse_json_payload(generated_text)
            except ValueError as exc:
                print(f"[NuExtract batch] main extraction failed for item {index}: {exc}")
                fallback_indexes.append(index)
                continue
            payloads[index] = self._postprocess_payload(self._normalize_payload(payload))

        for index in fallback_indexes:
            item = prepared[index]
            try:
                payloads[index] = self.extract(title=item["title"], content=item["content"]).to_dict()
            except ValueError as exc:
                print(f"[NuExtract batch] item {index} fell back to rule extraction: {exc}")
                payloads[index] = self._build_rule_fallback_features(
                    title=item["title"],
                    content=item["content"],
                    reason=str(exc),
                ).to_dict()

        assert all(payload is not None for payload in payloads)
        resolved_payloads = [dict(payload) for payload in payloads if payload is not None]

        structure_indexes = [
            index for index, payload in enumerate(resolved_payloads)
            if self._needs_structural_backfill(payload)
        ]
        if structure_indexes:
            structure_payloads = self.extract_structural_backfill_batch(
                [
                    {"title": prepared[index]["title"], "content": prepared[index]["content"]}
                    for index in structure_indexes
                ]
            )
            for index, backfill_payload in zip(structure_indexes, structure_payloads, strict=True):
                resolved_payloads[index] = self._merge_backfill_payload(
                    resolved_payloads[index],
                    backfill_payload,
                )

        detail_payloads = self.build_detailed_summary_batch(
            [
                {"title": item["title"], "content": item["content"]}
                for item in prepared
            ]
        )
        for index, detailed_summary in enumerate(detail_payloads):
            resolved_payloads[index]["detailed_summary"] = detailed_summary

        role_indexes = [
            index for index, payload in enumerate(resolved_payloads)
            if self._needs_role_field_backfill(payload)
        ]
        if role_indexes:
            role_payloads = self.extract_role_entities_batch(
                [
                    {"title": prepared[index]["title"], "content": prepared[index]["content"]}
                    for index in role_indexes
                ]
            )
            for index, role_payload in zip(role_indexes, role_payloads, strict=True):
                resolved_payloads[index] = self._merge_role_fields(
                    resolved_payloads[index],
                    role_payload,
                )

        return [SemanticFeatures.from_dict(payload) for payload in resolved_payloads]

    @property
    def requested_model_name(self) -> str:
        if self.model_name:
            return self.model_name
        return NUEXTRACT_MODEL_VARIANTS.get(self.model_variant, DEFAULT_NUEXTRACT_MODEL)

    def load(self) -> None:
        if self._model is not None and self._tokenizer is not None:
            return
        try:
            import transformers
        except ImportError as exc:
            raise RuntimeError(
                "transformers is not installed. Please install the Conda environment from "
                "environment.litcodex-gpu-cu124.yml before running part2."
            ) from exc
        try:
            import torch
        except ImportError:
            torch = None

        requested_model_name = self.requested_model_name
        self.resolved_model_source = resolve_model_source(
            requested_model_name,
            weights_root=self.weights_root,
            family_dirs=[
                "nuextract",
                "NuExtract",
                "Nuextract",
                "nuextract2",
                "NuExtract-2.0-2B",
                "NuExtract_2B",
                "NuExtract_4B",
                "NuExtract_8B",
            ],
        )
        source_path = Path(self.resolved_model_source).expanduser()
        is_local_dir = source_path.exists() and source_path.is_dir()
        config_data = self._read_local_config(source_path) if is_local_dir else {}
        self._config_data = config_data
        self._validate_nuextract_snapshot(source_path if is_local_dir else None, config_data)
        self._backend = self._detect_backend(source_path if is_local_dir else None, config_data)
        self._runtime_backend = self._resolve_runtime_backend()

        common_kwargs: dict[str, Any] = {
            "device_map": self.device_map,
            "dtype": torch.float16 if (torch is not None and torch.cuda.is_available()) else (torch.float32 if torch is not None else None),
        }
        if common_kwargs["dtype"] is None:
            common_kwargs.pop("dtype")
        tokenizer_kwargs: dict[str, Any] = {}

        if is_local_dir:
            common_kwargs["local_files_only"] = True
            tokenizer_kwargs["local_files_only"] = True

        print(
            f"[NuExtract] model_backend={self._backend} runtime_backend={self._runtime_backend} "
            f"source={self.resolved_model_source}"
        )

        self._tokenizer = self._load_tokenizer(transformers, tokenizer_kwargs, is_local_dir)

        if self._runtime_backend == "vllm":
            self._model = self._load_vllm_engine()
            return

        if self._backend == "phi3v_custom":
            auto_causal_lm_cls = getattr(transformers, "AutoModelForCausalLM", None)
            if auto_causal_lm_cls is None:
                raise RuntimeError(
                    "Current transformers version does not provide AutoModelForCausalLM."
                )
            missing_modules = self._missing_custom_code_files(source_path, config_data) if is_local_dir else []
            if missing_modules:
                missing_text = ", ".join(sorted(missing_modules))
                raise RuntimeError(
                    "Local NuExtract snapshot is missing custom code files required by config auto_map: "
                    f"{missing_text}. Download the full model repository, including those .py files, "
                    "into models/weights/NuExtract_*."
                )

            self._model = auto_causal_lm_cls.from_pretrained(
                self.resolved_model_source,
                trust_remote_code=True,
                **common_kwargs,
            )
            return

        if self._backend == "vision2seq":
            vision_model_cls = (
                getattr(transformers, "AutoModelForImageTextToText", None)
                or getattr(transformers, "AutoModelForVision2Seq", None)
                or getattr(transformers, "Qwen2VLForConditionalGeneration", None)
            )
            if vision_model_cls is None:
                raise RuntimeError(
                    "Current transformers version does not provide a compatible multimodal loader for NuExtract. "
                    "Expected one of AutoModelForImageTextToText, AutoModelForVision2Seq, "
                    "or Qwen2VLForConditionalGeneration."
                )

            self._model = vision_model_cls.from_pretrained(
                self.resolved_model_source,
                trust_remote_code=False,
                **common_kwargs,
            )
            return

        auto_causal_lm_cls = getattr(transformers, "AutoModelForCausalLM", None)
        if auto_causal_lm_cls is None:
            raise RuntimeError(
                "Current transformers version does not provide AutoModelForCausalLM."
            )

        self._model = auto_causal_lm_cls.from_pretrained(
            self.resolved_model_source,
            trust_remote_code=not is_local_dir,
            **common_kwargs,
        )

    def extract(self, *, title: str, content: str) -> SemanticFeatures:
        self.load()
        base_content = content[: self.max_input_chars]
        attempts = [
            (base_content, self.max_new_tokens),
            (base_content, min(max(self.max_new_tokens + 128, int(self.max_new_tokens * 1.5)), 1024)),
            (base_content[: max(1200, int(len(base_content) * 0.75))], min(max(self.max_new_tokens + 128, int(self.max_new_tokens * 1.5)), 1024)),
        ]
        last_error: Exception | None = None

        for attempt_index, (content_excerpt, max_new_tokens) in enumerate(attempts, start=1):
            try:
                if self._backend in {"vision2seq", "phi3v_custom"}:
                    return self._extract_with_vision2seq(
                        title=title,
                        content=content_excerpt,
                        max_new_tokens=max_new_tokens,
                    )
                return self._extract_with_causal_lm(
                    title=title,
                    content=content_excerpt,
                    max_new_tokens=max_new_tokens,
                )
            except ValueError as exc:
                last_error = exc
                print(
                    f"[NuExtract] retry {attempt_index}/{len(attempts)} failed: "
                    f"content_chars={len(content_excerpt)} max_new_tokens={max_new_tokens} reason={exc}"
                )
                continue

        if last_error is not None:
            print(f"[NuExtract] fallback to rule extraction after retries failed: {last_error}")
            return self._build_rule_fallback_features(
                title=title,
                content=content,
                reason=str(last_error),
            )
        raise RuntimeError("NuExtract extraction failed without a captured exception.")

    def _build_rule_fallback_features(self, *, title: str, content: str, reason: str = "") -> SemanticFeatures:
        sentences = self._split_fallback_sentences(content)
        summary = self._truncate_fallback_text("".join(sentences[:2]) or content, 180)
        detailed_summary = [
            self._truncate_fallback_text(sentence, 120)
            for sentence in sentences[:6]
            if self._truncate_fallback_text(sentence, 120)
        ]
        if not detailed_summary and summary:
            detailed_summary = [summary]

        protagonist = self._guess_fallback_names(content, limit=3)
        locations = self._guess_fallback_terms(
            content,
            suffixes=("城", "镇", "鎮", "村", "山", "谷", "厅", "廳", "楼", "樓", "街", "宫", "宮", "殿", "界", "域", "餐厅", "餐廳"),
            limit=3,
        )
        items = self._guess_fallback_terms(
            content,
            suffixes=("枪", "炮", "剑", "刀", "弹", "药剂", "炸弹", "徽章", "卷轴", "装置"),
            limit=4,
        )
        conflict_sentences = [
            self._truncate_fallback_text(sentence, 100)
            for sentence in sentences
            if any(keyword in sentence for keyword in ("杀", "战", "伤", "血", "逃", "爆", "枪", "冲突", "危"))
        ][:3]
        state_changes = [
            self._truncate_fallback_text(sentence, 100)
            for sentence in sentences
            if any(keyword in sentence for keyword in ("受伤", "死亡", "消失", "撤", "逃", "击中", "轰碎", "倒塌"))
        ][:3]
        ending_hook = self._truncate_fallback_text(sentences[-1], 120) if sentences else ""

        if reason:
            print(
                "[NuExtract fallback] rule-based SemanticFeatures generated "
                f"title={title!r} content_chars={len(content)} reason={reason[:240]}"
            )

        return SemanticFeatures(
            summary=summary,
            detailed_summary=detailed_summary,
            protagonist=protagonist,
            current_scene=locations,
            current_goal_or_task=[],
            supporting_characters=[],
            items_and_props=items,
            protagonist_current_state=[],
            chapter_function=["情节推进"] if summary else [],
            key_scenes=detailed_summary[:3],
            important_dialogue_topics=[],
            conflicts=conflict_sentences,
            foreshadowing=[],
            clues=[],
            ending_hook=ending_hook,
            state_changes=state_changes,
            relationship_changes=[],
            world_rules_or_system_changes=[],
            tone=self._guess_fallback_tone(content),
            open_questions=[],
        )

    @staticmethod
    def _split_fallback_sentences(content: str) -> list[str]:
        normalized = re.sub(r"\s+", " ", str(content).strip())
        if not normalized:
            return []
        parts = re.split(r"(?<=[。！？!?；;])\s*", normalized)
        sentences = [part.strip() for part in parts if len(part.strip()) >= 8]
        if sentences:
            return sentences
        return [normalized]

    @staticmethod
    def _truncate_fallback_text(text: str, limit: int) -> str:
        cleaned = " ".join(str(text).strip().split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[: max(0, limit - 1)].rstrip() + "…"

    @staticmethod
    def _guess_fallback_names(content: str, *, limit: int) -> list[str]:
        blocked = {
            "一個",
            "這個",
            "那個",
            "自己",
            "對方",
            "眾人",
            "男人",
            "女人",
            "年輕",
            "建築",
            "餐廳",
            "或者说",
            "或者說",
            "下意識",
            "雷屬性",
            "土屬性",
            "之間",
        }
        counts: dict[str, int] = {}
        for token in re.findall(r"[\u4e00-\u9fff·]{2,6}", content):
            token = token.strip("，。！？；：、“”‘’（）()")
            token = re.sub(r"[的了中內内后後前]+$", "", token)
            if len(token) < 2 or token in blocked:
                continue
            if re.search(r"\d", token) or token.startswith(("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")):
                continue
            if token.endswith(("之後", "之前", "起來", "下意識", "這種", "那種", "可以", "沒有")):
                continue
            counts[token] = counts.get(token, 0) + 1
        ranked = sorted(counts.items(), key=lambda item: (-item[1], len(item[0]), item[0]))
        return [name for name, _count in ranked[:limit]]

    @staticmethod
    def _guess_fallback_terms(content: str, *, suffixes: tuple[str, ...], limit: int) -> list[str]:
        suffix_pattern = "|".join(re.escape(suffix) for suffix in suffixes)
        pattern = rf"[\u4e00-\u9fff·]{{1,5}}(?:{suffix_pattern})"
        terms: list[str] = []
        seen: set[str] = set()
        for match in re.finditer(pattern, content):
            term = match.group(0).strip("，。！？；：、“”‘’（）()")
            term = re.sub(r"^(向|在|到|從|从|穿透|進入|进入|離開|离开|靠近)", "", term)
            if len(term) < 2 or len(term) > 8 or term in seen:
                continue
            if term.startswith(("出現", "來到", "離開", "所有", "這棟", "整棟", "隨時", "發射")):
                continue
            seen.add(term)
            terms.append(term)
            if len(terms) >= limit:
                break
        return terms

    @staticmethod
    def _guess_fallback_tone(content: str) -> str:
        tone_keywords = {
            "紧张": ("危", "逃", "追", "血", "伤", "殺", "杀"),
            "战斗": ("戰", "战", "枪", "爆", "轰", "击"),
            "悬疑": ("疑", "秘密", "线索", "不對", "不对"),
            "日常": ("笑", "宴會", "晚宴", "聊天"),
        }
        scores = {
            tone: sum(str(content).count(keyword) for keyword in keywords)
            for tone, keywords in tone_keywords.items()
        }
        tone, score = max(scores.items(), key=lambda item: item[1])
        return tone if score > 0 else "叙事"

    def extract_role_entities(self, *, title: str, content: str) -> dict[str, list[str]]:
        self.load()
        base_content = content[: self.max_input_chars]
        attempts = [
            (base_content, min(self.max_new_tokens, 512)),
            (base_content, min(max(self.max_new_tokens + 96, 384), 640)),
            (base_content[: max(1400, int(len(base_content) * 0.8))], min(max(self.max_new_tokens + 128, 448), 768)),
        ]
        last_error: Exception | None = None

        for attempt_index, (content_excerpt, max_new_tokens) in enumerate(attempts, start=1):
            try:
                prompt = self.build_entity_role_prompt(title=title, content=content_excerpt, force_fill=False)
                payload = self.generate_json_payload(prompt, max_new_tokens=max_new_tokens)
                processed = self._postprocess_entity_roles(payload)
                if any(processed.values()):
                    return processed

                prompt = self.build_entity_role_prompt(title=title, content=content_excerpt, force_fill=True)
                payload = self.generate_json_payload(prompt, max_new_tokens=min(max_new_tokens + 128, 896))
                processed = self._postprocess_entity_roles(payload)
                if any(processed.values()):
                    return processed
            except ValueError as exc:
                last_error = exc
                print(
                    f"[NuExtract entities] retry {attempt_index}/{len(attempts)} failed: "
                    f"content_chars={len(content_excerpt)} max_new_tokens={max_new_tokens} reason={exc}"
                )
                continue

        if last_error is not None:
            print(f"[NuExtract entities] fallback to empty role fields because extraction failed: {last_error}")
            return self.empty_role_fields()
        print("[NuExtract entities] fallback to empty role fields because all attempts returned empty payloads.")
        return self.empty_role_fields()

    def extract_role_entities_batch(self, chapters: list[dict[str, str]]) -> list[dict[str, list[str]]]:
        if not chapters:
            return []
        if self._runtime_backend != "vllm":
            return [
                self.extract_role_entities(title=str(chapter.get("title", "")), content=str(chapter.get("content", "")))
                for chapter in chapters
            ]

        base_contents = [str(chapter.get("content", ""))[: self.max_input_chars] for chapter in chapters]
        first_prompts = [
            self.build_entity_role_prompt(
                title=str(chapter.get("title", "")),
                content=content_excerpt,
                force_fill=False,
            )
            for chapter, content_excerpt in zip(chapters, base_contents, strict=True)
        ]
        outputs = self.generate_text_batch(first_prompts, max_new_tokens=min(self.max_new_tokens, 512))

        results: list[dict[str, list[str]] | None] = [None] * len(chapters)
        force_fill_indexes: list[int] = []
        force_fill_prompts: list[str] = []
        fallback_indexes: list[int] = []

        for index, output in enumerate(outputs):
            try:
                payload = self.parse_json_payload(output)
            except ValueError:
                fallback_indexes.append(index)
                continue
            processed = self._postprocess_entity_roles(payload)
            if any(processed.values()):
                results[index] = processed
            else:
                force_fill_indexes.append(index)
                force_fill_prompts.append(
                    self.build_entity_role_prompt(
                        title=str(chapters[index].get("title", "")),
                        content=base_contents[index],
                        force_fill=True,
                    )
                )

        if force_fill_prompts:
            force_fill_outputs = self.generate_text_batch(
                force_fill_prompts,
                max_new_tokens=min(max(self.max_new_tokens + 128, 640), 896),
            )
            for index, output in zip(force_fill_indexes, force_fill_outputs, strict=True):
                try:
                    payload = self.parse_json_payload(output)
                    results[index] = self._postprocess_entity_roles(payload)
                except ValueError:
                    fallback_indexes.append(index)

        for index in fallback_indexes:
            if results[index] is None:
                results[index] = self.extract_role_entities(
                    title=str(chapters[index].get("title", "")),
                    content=str(chapters[index].get("content", "")),
                )

        return [result or self.empty_role_fields() for result in results]

    def extract_structural_backfill(self, *, title: str, content: str) -> dict[str, Any]:
        self.load()
        base_content = content[: self.max_input_chars]
        attempts = [
            (base_content, min(self.max_new_tokens, 512)),
            (base_content[: max(1600, int(len(base_content) * 0.85))], min(max(self.max_new_tokens, 512), 768)),
        ]
        last_error: Exception | None = None

        for attempt_index, (content_excerpt, max_new_tokens) in enumerate(attempts, start=1):
            try:
                prompt = self.build_structural_backfill_prompt(title=title, content=content_excerpt)
                payload = self.generate_json_payload(prompt, max_new_tokens=max_new_tokens)
                processed = self._postprocess_structural_backfill(payload)
                if self._has_structural_backfill_content(processed):
                    return processed
            except ValueError as exc:
                last_error = exc
                print(
                    f"[NuExtract structure] retry {attempt_index}/{len(attempts)} failed: "
                    f"content_chars={len(content_excerpt)} max_new_tokens={max_new_tokens} reason={exc}"
                )
                continue

        if last_error is not None:
            print(f"[NuExtract structure] fallback to empty structural fields because extraction failed: {last_error}")
        else:
            print("[NuExtract structure] fallback to empty structural fields because all attempts returned empty payloads.")
        return {key: value if isinstance(value, list) else "" for key, value in DEFAULT_STRUCTURAL_BACKFILL_SCHEMA.items()}

    def extract_structural_backfill_batch(self, chapters: list[dict[str, str]]) -> list[dict[str, Any]]:
        if not chapters:
            return []
        if self._runtime_backend != "vllm":
            return [
                self.extract_structural_backfill(title=str(chapter.get("title", "")), content=str(chapter.get("content", "")))
                for chapter in chapters
            ]

        base_contents = [str(chapter.get("content", ""))[: self.max_input_chars] for chapter in chapters]
        prompts = [
            self.build_structural_backfill_prompt(
                title=str(chapter.get("title", "")),
                content=content_excerpt,
            )
            for chapter, content_excerpt in zip(chapters, base_contents, strict=True)
        ]
        outputs = self.generate_text_batch(prompts, max_new_tokens=min(self.max_new_tokens, 512))
        empty_payload = {key: value if isinstance(value, list) else "" for key, value in DEFAULT_STRUCTURAL_BACKFILL_SCHEMA.items()}

        results: list[dict[str, Any] | None] = [None] * len(chapters)
        fallback_indexes: list[int] = []
        for index, output in enumerate(outputs):
            try:
                payload = self.parse_json_payload(output)
                processed = self._postprocess_structural_backfill(payload)
            except ValueError:
                fallback_indexes.append(index)
                continue
            if self._has_structural_backfill_content(processed):
                results[index] = processed
            else:
                fallback_indexes.append(index)

        for index in fallback_indexes:
            if results[index] is None:
                results[index] = self.extract_structural_backfill(
                    title=str(chapters[index].get("title", "")),
                    content=str(chapters[index].get("content", "")),
                )

        return [result or dict(empty_payload) for result in results]

    def _extract_with_vision2seq(self, *, title: str, content: str, max_new_tokens: int) -> SemanticFeatures:
        document = self._build_document_text(title=title, content=content)
        schema = json.dumps(MAIN_EXTRACTION_SCHEMA_TEMPLATE, ensure_ascii=False, indent=2)
        messages = [{"role": "user", "content": document}]
        prompt = self._render_schema_chat_prompt(messages=messages, schema=schema)
        if self._runtime_backend == "vllm":
            generated_text = self._generate_vllm_from_rendered_prompt(prompt, max_new_tokens=max_new_tokens)
            payload = self.parse_json_payload(generated_text)
            payload = self._normalize_payload(payload)
            payload = self._postprocess_payload(payload)
            if self._needs_structural_backfill(payload):
                payload = self._merge_backfill_payload(
                    payload,
                    self.extract_structural_backfill(title=title, content=content),
                )
            payload["detailed_summary"] = self.build_detailed_summary(title=title, content=content)
            if self._needs_role_field_backfill(payload):
                payload = self._merge_role_fields(
                    payload,
                    self.extract_role_entities(title=title, content=content),
                )
            return SemanticFeatures.from_dict(payload)
        model_inputs = self._tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=self.resolve_tokenizer_max_length(),
        )
        model_inputs = self._move_inputs_to_model_device(model_inputs)

        outputs = self._model.generate(
            **model_inputs,
            **self.build_generation_kwargs(max_new_tokens=max_new_tokens),
        )
        prompt_length = model_inputs["input_ids"].shape[-1]
        generated_tokens = outputs[0][prompt_length:]
        generated_text = self._tokenizer.batch_decode(
            [generated_tokens],
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]
        payload = self.parse_json_payload(generated_text)
        payload = self._normalize_payload(payload)
        payload = self._postprocess_payload(payload)
        if self._needs_structural_backfill(payload):
            payload = self._merge_backfill_payload(
                payload,
                self.extract_structural_backfill(title=title, content=content),
            )
        payload["detailed_summary"] = self.build_detailed_summary(title=title, content=content)
        if self._needs_role_field_backfill(payload):
            payload = self._merge_role_fields(
                payload,
                self.extract_role_entities(title=title, content=content),
            )
        return SemanticFeatures.from_dict(payload)

    def _extract_with_causal_lm(self, *, title: str, content: str, max_new_tokens: int) -> SemanticFeatures:
        prompt = self.build_prompt(title=title, content=content)
        generated_text = self.generate_text(prompt, max_new_tokens=max_new_tokens)
        payload = self.parse_json_payload(generated_text)
        payload = self._normalize_payload(payload)
        payload = self._postprocess_payload(payload)
        if self._needs_structural_backfill(payload):
            payload = self._merge_backfill_payload(
                payload,
                self.extract_structural_backfill(title=title, content=content),
            )
        payload["detailed_summary"] = self.build_detailed_summary(title=title, content=content)
        if self._needs_role_field_backfill(payload):
            payload = self._merge_role_fields(
                payload,
                self.extract_role_entities(title=title, content=content),
            )
        return SemanticFeatures.from_dict(payload)

    @staticmethod
    def _read_local_config(source_path: Path) -> dict[str, Any]:
        config_path = source_path / "config.json"
        if not config_path.exists():
            return {}
        return json.loads(config_path.read_text(encoding="utf-8"))

    def _validate_nuextract_snapshot(self, source_path: Path | None, config_data: dict[str, Any]) -> None:
        if source_path is None:
            return

        model_type = str(config_data.get("model_type", "")).lower()
        source_name = source_path.name.lower()
        requested_name = self.requested_model_name.lower()
        is_nuextract_request = "nuextract" in source_name or "nuextract" in requested_name

        if is_nuextract_request and model_type == "phi3":
            raise RuntimeError(
                "The local models/weights/NuExtract_* snapshot looks inconsistent with the official "
                "NuExtract-2.0-2B release. Official NuExtract-2.0-2B is based on Qwen2-VL, but your "
                f"local config reports model_type={config_data.get('model_type')!r}. "
                "Please re-download the full official model snapshot into models/weights/NuExtract_*."
            )

    @staticmethod
    def _detect_backend(source_path: Path | None, config_data: dict[str, Any]) -> str:
        model_type = str(config_data.get("model_type", "")).lower()
        architectures = [str(item) for item in config_data.get("architectures", [])]
        auto_map = config_data.get("auto_map", {})
        auto_map_text = json.dumps(auto_map, ensure_ascii=False) if auto_map else ""

        if (
            any("Phi3V" in item for item in architectures)
            or "configuration_phi3_v" in auto_map_text
            or "modeling_phi3_v" in auto_map_text
        ):
            return "phi3v_custom"

        if (
            model_type in {"qwen2_vl", "qwen2.5_vl", "phi3_v", "phi3vision"}
            or any(tag in item for item in architectures for tag in ("Qwen2VL", "Qwen2_5_VL", "Phi3V", "Vision"))
            or "AutoProcessor" in auto_map_text
            or "Vision2Seq" in auto_map_text
        ):
            return "vision2seq"

        if source_path is not None:
            if (source_path / "preprocessor_config.json").exists():
                return "vision2seq"
            index_path = source_path / "model.safetensors.index.json"
            if index_path.exists():
                try:
                    index_data = json.loads(index_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    index_data = {}
                weight_map = index_data.get("weight_map", {})
                if any(str(key).startswith("visual.") for key in weight_map):
                    if "Phi3" in auto_map_text or any("Phi3" in item for item in architectures):
                        return "phi3v_custom"
                    return "vision2seq"
        return "causal_lm"

    @staticmethod
    def _missing_custom_code_files(source_path: Path, config_data: dict[str, Any]) -> list[str]:
        auto_map = config_data.get("auto_map", {})
        if not isinstance(auto_map, dict):
            return []

        required_modules: set[str] = set()
        for value in auto_map.values():
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, str) or "." not in item:
                    continue
                module_name = item.split(".", 1)[0]
                required_modules.add(f"{module_name}.py")

        return [filename for filename in required_modules if not (source_path / filename).exists()]

    @staticmethod
    def _build_document_text(*, title: str, content: str) -> str:
        if title.strip():
            return f"Chapter Title:\n{title}\n\nChapter Content:\n{content}"
        return f"Chapter Content:\n{content}"

    def _move_inputs_to_model_device(self, model_inputs):
        if self._model is None:
            return model_inputs
        if hasattr(self._model, "device"):
            return {key: value.to(self._model.device) for key, value in model_inputs.items()}
        return model_inputs

    def generate_text(self, prompt: str, *, max_new_tokens: int) -> str:
        rendered_prompt = self._render_prompt(prompt)
        if self._runtime_backend == "vllm":
            return self._generate_vllm_from_rendered_prompt(rendered_prompt, max_new_tokens=max_new_tokens)

        model_inputs = self._tokenizer(
            rendered_prompt,
            return_tensors="pt",
            truncation=True,
            max_length=self.resolve_tokenizer_max_length(),
        )
        model_inputs = self._move_inputs_to_model_device(model_inputs)
        outputs = self._model.generate(
            **model_inputs,
            **self.build_generation_kwargs(max_new_tokens=max_new_tokens),
        )
        prompt_length = model_inputs["input_ids"].shape[-1]
        generated_tokens = outputs[0][prompt_length:]
        return self._tokenizer.decode(generated_tokens, skip_special_tokens=True)

    def generate_json_payload(self, prompt: str, *, max_new_tokens: int) -> dict[str, Any]:
        generated_text = self.generate_text(prompt, max_new_tokens=max_new_tokens)
        return self.parse_json_payload(generated_text)

    def build_generation_kwargs(self, *, max_new_tokens: int) -> dict[str, Any]:
        generation_config = copy.deepcopy(getattr(self._model, "generation_config", None))
        if generation_config is not None:
            generation_config.do_sample = False
            for attr in ("temperature", "top_p", "top_k", "typical_p"):
                if hasattr(generation_config, attr):
                    setattr(generation_config, attr, None)
        return {
            "do_sample": False,
            "max_new_tokens": max_new_tokens,
            "generation_config": generation_config,
        }

    def build_detailed_summary(self, *, title: str, content: str) -> list[str]:
        return self.build_detailed_summary_batch([{"title": title, "content": content}])[0]

    def build_detailed_summary_batch(self, chapters: list[dict[str, str]]) -> list[list[str]]:
        if not chapters:
            return []

        chapter_segments: list[list[str]] = [
            self.split_for_detailed_summary(str(chapter.get("content", "")))
            for chapter in chapters
        ]
        flat_items: list[tuple[int, int, str, str]] = []
        for chapter_index, (chapter, segments) in enumerate(zip(chapters, chapter_segments, strict=True)):
            title = str(chapter.get("title", ""))
            for segment_index, segment in enumerate(segments):
                flat_items.append((chapter_index, segment_index, title, segment))

        if not flat_items:
            return [[] for _ in chapters]

        structured_prompts = [
            self.build_detailed_summary_prompt(title=title, content=segment)
            for _chapter_index, _segment_index, title, segment in flat_items
        ]
        structured_outputs = self.generate_text_batch(
            structured_prompts,
            max_new_tokens=self.detailed_summary_max_new_tokens,
        )

        raw_results: list[str] = [""] * len(flat_items)
        fallback_indexes: list[int] = []
        fallback_prompts: list[str] = []

        for index, output in enumerate(structured_outputs):
            try:
                payload = self.parse_json_payload(output)
            except ValueError as exc:
                print(f"[NuExtract detailed_summary] structured extraction failed: {exc}")
                fallback_indexes.append(index)
                fallback_prompts.append(
                    self.build_detailed_summary_fallback_prompt(
                        title=flat_items[index][2],
                        content=flat_items[index][3],
                    )
                )
                continue

            text = self.clean_detailed_summary_text(payload.get("summary", ""))
            if text:
                raw_results[index] = text
                continue

            fallback_indexes.append(index)
            fallback_prompts.append(
                self.build_detailed_summary_fallback_prompt(
                    title=flat_items[index][2],
                    content=flat_items[index][3],
                )
            )

        if fallback_prompts:
            fallback_outputs = self.generate_text_batch(
                fallback_prompts,
                max_new_tokens=self.detailed_summary_max_new_tokens,
            )
            for index, output in zip(fallback_indexes, fallback_outputs, strict=True):
                raw_results[index] = self.clean_detailed_summary_text(output)

        grouped_results: list[list[str]] = [[] for _ in chapters]
        for (chapter_index, _segment_index, _title, _segment), text in zip(flat_items, raw_results, strict=True):
            grouped_results[chapter_index].append(text)

        cleaned_results: list[list[str]] = []
        for chapter_texts in grouped_results:
            cleaned: list[str] = []
            seen: set[str] = set()
            for text in chapter_texts:
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if not text or len(normalized) <= 4 or normalized in seen:
                    continue
                seen.add(normalized)
                cleaned.append(text)
            cleaned_results.append(cleaned)
        return cleaned_results

    def extract_detailed_summary_segment(self, *, title: str, content: str) -> str:
        prompt = self.build_detailed_summary_prompt(title=title, content=content)
        try:
            payload = self.generate_json_payload(prompt, max_new_tokens=self.detailed_summary_max_new_tokens)
            text = self.clean_detailed_summary_text(payload.get("summary", ""))
            if text:
                return text
        except ValueError as exc:
            print(f"[NuExtract detailed_summary] structured extraction failed: {exc}")

        fallback_prompt = self.build_detailed_summary_fallback_prompt(title=title, content=content)
        fallback_text = self.generate_text(fallback_prompt, max_new_tokens=self.detailed_summary_max_new_tokens)
        return self.clean_detailed_summary_text(fallback_text)

    def split_for_detailed_summary(self, content: str) -> list[str]:
        text = content.strip()
        if not text:
            return []
        if len(text) <= self.detailed_summary_chunk_chars:
            return [text]

        segments: list[str] = []
        start = 0
        max_chars = self.detailed_summary_chunk_chars
        while start < len(text):
            end = min(len(text), start + max_chars)
            if end < len(text):
                window = text[start:end]
                candidates = [window.rfind(mark) for mark in "。！？!?；;\n"]
                split_at = max(candidates)
                if split_at >= max_chars // 2:
                    end = start + split_at + 1
            segment = text[start:end].strip()
            if segment:
                segments.append(segment)
            start = end
        return segments

    def build_detailed_summary_prompt(self, *, title: str, content: str) -> str:
        schema = json.dumps(DEFAULT_DETAILED_SUMMARY_SCHEMA, ensure_ascii=False, indent=2)
        return (
            "你是中文网文章节片段总结器。请阅读下面这段正文，只输出一个合法 JSON 对象。\n"
            "要求：\n"
            "- 只能输出 JSON，不要输出解释、前言、代码块、要求说明。\n"
            "- 只填写 summary 一个字段。\n"
            "- summary 用 1 到 2 句中文总结这一段实际发生了什么。\n"
            "- 只写具体情节，不要复述提示词，不要写“片段摘要”“要求”等字样。\n"
            "- 尽量点出人物、动作、结果或新信息。\n\n"
            f"JSON Schema:\n{schema}\n\n"
            f"章节标题：\n{title}\n\n"
            f"片段内容：\n{content}\n\n"
            "JSON："
        )

    @staticmethod
    def build_detailed_summary_fallback_prompt(*, title: str, content: str) -> str:
        return (
            "请只用1到2句中文，概括下面这一段实际发生的情节。\n"
            "不要重复题目，不要写要求，不要写“片段摘要”。\n\n"
            f"章节标题：{title}\n\n"
            f"片段内容：\n{content}\n\n"
            "答案："
        )

    @staticmethod
    def build_entity_role_prompt(*, title: str, content: str, force_fill: bool = False) -> str:
        schema = json.dumps(DEFAULT_ENTITY_ROLE_SCHEMA, ensure_ascii=False, indent=2)
        force_fill_text = (
            "- 主角、当前场景、当前目标和任务、主角当前状态是优先字段；只要正文里能找到依据，就至少各写 1 项，不要机械留空。\n"
            if force_fill
            else ""
        )
        return (
            "你是中文网文章节角色与场景抽取器。请阅读章节标题和正文，只输出一个合法 JSON 对象。\n"
            "要求：\n"
            "- 只能输出 JSON，不要输出解释、前言、代码块或要求复述。\n"
            "- 每个字段都只允许字符串列表，不要输出对象。\n"
            "- 不要整句照抄大段叙述，尽量提炼成短而具体的短语。\n"
            "- 没有明确依据就留空，不要臆造。\n"
            "- 主角：优先写明确主角姓名；没有姓名时再写最明确的主角指代。\n"
            "- 当前场景：写本章正在发生行动的地点、环境或局面，例如“出租屋客厅”“学校教室”“地下室通道”。\n"
            "- 当前目标和任务：写主角当前正在完成或必须面对的目标、任务、压力，例如“处理尸体并清理痕迹”“避免被警察发现”。\n"
            "- 配角：写本章出现并有作用的其他人物。\n"
            "- 物体道具：写本章反复出现或对情节有作用的具体物件，例如“菜刀”“保鲜膜”“手机”。\n"
            "- 主角当前状态：写主角当前的心理、认知、身体、立场或决策状态，例如“强迫自己冷静”“意识到时间错乱”“慌乱但维持理性”。\n"
            "- 每个字段尽量写 1 到 3 条短语，不要写成长句。\n"
            f"{force_fill_text}\n"
            f"JSON Schema:\n{schema}\n\n"
            f"章节标题：\n{title}\n\n"
            f"章节正文：\n{content}\n\n"
            "JSON："
        )

    @staticmethod
    def build_structural_backfill_prompt(*, title: str, content: str) -> str:
        schema = json.dumps(DEFAULT_STRUCTURAL_BACKFILL_SCHEMA, ensure_ascii=False, indent=2)
        return (
            "你是中文网文章节结构补全器。请阅读章节标题和正文，只补全下列结构字段，并只输出一个合法 JSON 对象。\n"
            "要求：\n"
            "- 只能输出 JSON，不要输出解释、前言、代码块。\n"
            "- key_scenes: 写 3 到 5 个具体场面，必须是实际发生的动作或画面。\n"
            "- conflicts: 写本章明确存在的压力、阻碍、危险或目标冲突。\n"
            "- foreshadowing: 只写本章新埋下且尚未解释清楚的伏笔。\n"
            "- clues: 只写明确线索、证据或可用于后续判断的信息。\n"
            "- ending_hook: 只写结尾留下的悬念、危机或期待点；没有就写空字符串。\n"
            "- state_changes: 写主角或关键人物在本章内发生的认知、情绪、决策或处境变化。\n"
            "- 没有依据就留空，不要臆造。\n\n"
            f"JSON Schema:\n{schema}\n\n"
            f"章节标题：\n{title}\n\n"
            f"章节正文：\n{content}\n\n"
            "JSON："
        )

    def generate_text_batch(self, prompts: list[str], *, max_new_tokens: int) -> list[str]:
        if not prompts:
            return []
        rendered_prompts = [self._render_prompt(prompt) for prompt in prompts]
        if self._runtime_backend == "vllm":
            return self._generate_vllm_batch_from_rendered_prompts(rendered_prompts, max_new_tokens=max_new_tokens)
        model_inputs = self._tokenizer(
            rendered_prompts,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=self.resolve_tokenizer_max_length(),
        )
        model_inputs = self._move_inputs_to_model_device(model_inputs)
        outputs = self._model.generate(
            **model_inputs,
            **self.build_generation_kwargs(max_new_tokens=max_new_tokens),
        )
        attention_mask = model_inputs.get("attention_mask")
        prompt_lengths = attention_mask.sum(dim=1).tolist() if attention_mask is not None else [model_inputs["input_ids"].shape[-1]] * len(prompts)
        generated_texts: list[str] = []
        for index, prompt_length in enumerate(prompt_lengths):
            generated_tokens = outputs[index][int(prompt_length):]
            text = self._tokenizer.decode(generated_tokens, skip_special_tokens=True)
            generated_texts.append(text)
        return generated_texts

    def _resolve_runtime_backend(self) -> str:
        backend = self.inference_backend or DEFAULT_INFERENCE_BACKEND
        if backend == "auto":
            backend = DEFAULT_INFERENCE_BACKEND
        if backend not in {"transformers", "vllm"}:
            raise ValueError(f"Unsupported NuExtract inference backend: {backend}")
        return backend

    def _load_tokenizer(self, transformers_module, tokenizer_kwargs: dict[str, Any], is_local_dir: bool):
        auto_tokenizer_cls = getattr(transformers_module, "AutoTokenizer", None)
        if auto_tokenizer_cls is None:
            raise RuntimeError("Current transformers version does not provide AutoTokenizer.")
        load_kwargs = dict(tokenizer_kwargs)
        load_kwargs["trust_remote_code"] = not is_local_dir and self._backend == "phi3v_custom"
        if self._backend == "vision2seq":
            load_kwargs["use_fast"] = False
        tokenizer = auto_tokenizer_cls.from_pretrained(
            self.resolved_model_source,
            **load_kwargs,
        )
        if hasattr(tokenizer, "padding_side"):
            tokenizer.padding_side = "left"
        return tokenizer

    def _load_vllm_engine(self):
        try:
            from vllm import LLM
        except ImportError as exc:
            raise RuntimeError("vLLM is not installed, but inference_backend='vllm' was requested.") from exc

        os.environ.setdefault("VLLM_WORKER_MULTIPROC_METHOD", "spawn")
        kwargs = {
            "model": self.resolved_model_source,
            "tokenizer": self.resolved_model_source,
            "trust_remote_code": False,
            "tensor_parallel_size": self.vllm_tensor_parallel_size,
            "gpu_memory_utilization": self.vllm_gpu_memory_utilization,
            "max_model_len": min(self.resolve_tokenizer_max_length(), self.vllm_max_model_len),
            "max_seq_len_to_capture": min(8192, self.vllm_max_model_len),
            "enforce_eager": self.vllm_enforce_eager,
            "disable_log_stats": True,
        }
        if self.vllm_max_num_seqs is not None:
            kwargs["max_num_seqs"] = self.vllm_max_num_seqs
        return LLM(**kwargs)

    def _render_prompt(self, prompt: str) -> str:
        if self._backend in {"vision2seq", "phi3v_custom"} and hasattr(self._tokenizer, "apply_chat_template"):
            messages = [{"role": "user", "content": prompt}]
            return self._tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        return prompt

    def _render_schema_chat_prompt(self, *, messages: list[dict[str, Any]], schema: str) -> str:
        if hasattr(self._tokenizer, "apply_chat_template"):
            return self._tokenizer.apply_chat_template(
                messages,
                template=schema,
                tokenize=False,
                add_generation_prompt=True,
            )
        return f"{schema}\n\n{messages[0]['content']}"

    def _build_sampling_params(self, *, max_new_tokens: int):
        try:
            from vllm import SamplingParams
        except ImportError as exc:
            raise RuntimeError("vLLM is not installed, but vLLM sampling was requested.") from exc
        return SamplingParams(
            temperature=0.0,
            max_tokens=max_new_tokens,
        )

    def _generate_vllm_from_rendered_prompt(self, prompt: str, *, max_new_tokens: int) -> str:
        outputs = self._model.generate([prompt], sampling_params=self._build_sampling_params(max_new_tokens=max_new_tokens))
        if not outputs or not outputs[0].outputs:
            return ""
        return outputs[0].outputs[0].text

    def _generate_vllm_batch_from_rendered_prompts(self, prompts: list[str], *, max_new_tokens: int) -> list[str]:
        batch_size = self.vllm_generate_batch_size or len(prompts)
        generated_texts: list[str] = []
        sampling_params = self._build_sampling_params(max_new_tokens=max_new_tokens)
        for start in range(0, len(prompts), batch_size):
            batch_prompts = prompts[start:start + batch_size]
            outputs = self._model.generate(batch_prompts, sampling_params=sampling_params)
            for output in outputs:
                if not output.outputs:
                    generated_texts.append("")
                    continue
                generated_texts.append(output.outputs[0].text)
        return generated_texts

    def resolve_tokenizer_max_length(self) -> int:
        model_max_length = getattr(self._tokenizer, "model_max_length", None)
        if isinstance(model_max_length, int) and 0 < model_max_length < 100000:
            return model_max_length
        return 32768

    @staticmethod
    def _normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
        return dict(payload)

    @staticmethod
    def build_prompt(*, title: str, content: str) -> str:
        schema = json.dumps(MAIN_EXTRACTION_SCHEMA_TEMPLATE, ensure_ascii=False, indent=2)
        return (
            "你是中文网文章节结构抽取器。阅读章节标题与正文，只输出一个合法 JSON 对象。\n"
            "输出要求：\n"
            "- 只能输出 JSON。\n"
            "- 列表字段只允许字符串项，不要输出对象。\n"
            "- 不要复述要求，不要解释，不要写代码块。\n"
            "- 没有依据就留空，不要臆造。\n"
            "- 不要把同一信息在多个字段里重复改写。\n\n"
            "字段说明：\n"
            "- summary：用 120 到 220 个中文字符概括本章主要情节，覆盖开端、推进、转折和结果。\n"
            "- protagonist：写本章主角姓名或最明确主角指代；有明确姓名时不要留空。\n"
            "- current_scene：写当前主要行动场景，通常 1 到 3 项。\n"
            "- current_goal_or_task：写主角当前正在完成或必须面对的目标、任务或压力，通常 1 到 3 项。\n"
            "- supporting_characters：写本章出现并对情节有作用的其他人物。\n"
            "- items_and_props：写本章反复出现或推动情节的具体道具和物件。\n"
            "- protagonist_current_state：写主角当前的心理、认知、身体或决策状态。\n"
            "- chapter_function：1 到 3 个简短标签，概括本章叙事功能；只要本章有推进就不要留空。\n"
            "- key_scenes：3 到 6 条具体场面，必须是实际发生的画面。\n"
            "- important_dialogue_topics：只有本章确实出现重要对话时才填写，写具体话题。\n"
            "- conflicts：写本章真实存在的冲突、障碍、危险、时间压力、暴露风险或目标对抗。\n"
            "- foreshadowing：写本章新埋下、暂未解释清楚的伏笔。\n"
            "- clues：写本章新增的明确线索、证据或可用于推理的信息。\n"
            "- ending_hook：只写章节结尾留下的悬念、危机或期待点；若结尾平稳则输出空字符串。\n"
            "- state_changes：写主角或关键人物的重要状态变化，用短句表达。\n"
            "- relationship_changes：只写人物关系在本章内发生的明确变化。\n"
            "- world_rules_or_system_changes：只写世界规则、系统机制、任务规则的新信息或变化。\n"
            "- tone：用 1 到 3 个词概括本章主要氛围。\n"
            "- open_questions：写本章读者自然会追问的未解问题，不要超过 3 条。\n"
            "- 不要输出 detailed_summary，这个字段会后续单独生成。\n\n"
            "优先保证这些字段尽量有内容：protagonist、current_scene、current_goal_or_task、protagonist_current_state、chapter_function、key_scenes、conflicts、state_changes。\n\n"
            f"JSON Schema:\n{schema}\n\n"
            f"章节标题：\n{title}\n\n"
            f"章节正文：\n{content}\n\n"
            "JSON："
        )

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
        if start == -1:
            raise ValueError(f"NuExtract did not return JSON. Raw output: {raw_text[:500]}")

        candidate = cleaned[start:]
        if candidate.count("{") > candidate.count("}"):
            raise ValueError(f"NuExtract returned incomplete JSON (likely truncated). Raw output: {raw_text[:500]}")

        match = re.search(r"\{.*\}", candidate, flags=re.DOTALL)
        if not match:
            raise ValueError(f"NuExtract did not return JSON. Raw output: {raw_text[:500]}")

        return json.loads(match.group(0))

    @staticmethod
    def _postprocess_payload(payload: dict[str, Any]) -> dict[str, Any]:
        processed = dict(payload)
        list_fields = [
            "protagonist",
            "current_scene",
            "current_goal_or_task",
            "supporting_characters",
            "items_and_props",
            "protagonist_current_state",
            "chapter_function",
            "key_scenes",
            "important_dialogue_topics",
            "conflicts",
            "foreshadowing",
            "clues",
            "state_changes",
            "relationship_changes",
            "world_rules_or_system_changes",
            "open_questions",
        ]
        for field in list_fields:
            values = processed.get(field)
            if not isinstance(values, list):
                continue
            deduped: list[str] = []
            seen: set[str] = set()
            for raw in values:
                text = NuExtractExtractor._normalize_list_item(field, raw)
                if not text:
                    continue
                if NuExtractExtractor._looks_like_prompt_leak(text):
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 1 or normalized in seen:
                    continue
                seen.add(normalized)
                deduped.append(text)
            processed[field] = deduped

        summary = " ".join(str(processed.get("summary", "")).strip().split())
        summary = NuExtractExtractor.clean_summary_text(summary)
        processed["summary"] = summary
        if not processed.get("chapter_function") and summary:
            processed["chapter_function"] = ["情节推进"]
        if not isinstance(processed.get("detailed_summary"), list):
            processed["detailed_summary"] = []
        else:
            cleaned_summaries: list[str] = []
            seen_summaries: set[str] = set()
            for item in processed["detailed_summary"]:
                text = NuExtractExtractor.clean_detailed_summary_text(str(item))
                if not text or NuExtractExtractor._looks_like_prompt_leak(text):
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 4 or normalized in seen_summaries:
                    continue
                seen_summaries.add(normalized)
                cleaned_summaries.append(text)
            processed["detailed_summary"] = cleaned_summaries
        hook = " ".join(str(processed.get("ending_hook", "")).strip().split())
        hook = NuExtractExtractor.clean_summary_text(hook)
        if hook.lower() in {"none", "null", "无", "没有"}:
            hook = ""
        processed["ending_hook"] = hook
        tone = " ".join(str(processed.get("tone", "")).strip().split())
        processed["tone"] = tone
        return processed

    @staticmethod
    def _postprocess_structural_backfill(payload: dict[str, Any]) -> dict[str, Any]:
        processed = dict(payload)
        for field in ("key_scenes", "conflicts", "foreshadowing", "clues", "state_changes"):
            values = processed.get(field, [])
            if not isinstance(values, list):
                values = [values] if values else []
            deduped: list[str] = []
            seen: set[str] = set()
            for raw in values:
                text = NuExtractExtractor._normalize_list_item(field, raw)
                if not text or NuExtractExtractor._looks_like_prompt_leak(text):
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 1 or normalized in seen:
                    continue
                seen.add(normalized)
                deduped.append(text)
            processed[field] = deduped

        hook = NuExtractExtractor.clean_summary_text(" ".join(str(processed.get("ending_hook", "")).strip().split()))
        if hook.lower() in {"none", "null", "无", "没有"}:
            hook = ""
        processed["ending_hook"] = hook
        return processed

    @staticmethod
    def clean_summary_text(text: str) -> str:
        cleaned = " ".join(str(text).strip().split())
        cleaned = re.sub(r"^(片段摘要|摘要|总结)[:：]\s*", "", cleaned)
        cleaned = re.sub(r"^(请根据上述内容[，,。；;:：]?用中文总结这段文字[。；;:：]?)", "", cleaned)
        cleaned = re.sub(r"^(要求)[:：].*$", "", cleaned)
        cleaned = re.sub(r"^(的)(?=[\u4e00-\u9fff])", "", cleaned)
        cleaned = re.sub(r"(请根据上述内容.*)$", "", cleaned)
        return cleaned.strip()

    @staticmethod
    def clean_detailed_summary_text(text: str) -> str:
        cleaned = " ".join(str(text).strip().split())
        markers = [
            "片段摘要：",
            "片段摘要:",
            "摘要：",
            "摘要:",
            "总结：",
            "总结:",
        ]
        for marker in markers:
            if marker in cleaned:
                cleaned = cleaned.split(marker)[-1].strip()

        cleaned = re.sub(r"^(要求|输出要求|格式要求)[:：].*$", "", cleaned)
        cleaned = re.sub(r"^-+\s*只写具体情节.*$", "", cleaned)
        cleaned = re.sub(r"^-+\s*不要写要求说明.*$", "", cleaned)
        cleaned = re.sub(r"^-+\s*不要复述.*$", "", cleaned)
        cleaned = re.sub(r"^(请阅读下面这段.*)$", "", cleaned)
        cleaned = re.sub(r"^(章节标题|片段内容|JSON Schema|Schema)[:：].*$", "", cleaned)
        cleaned = re.sub(r"(要求[:：].*)$", "", cleaned)
        cleaned = re.sub(r"(不要写要求说明.*)$", "", cleaned)
        cleaned = re.sub(r"(不要复述\s*schema.*)$", "", cleaned, flags=re.IGNORECASE)
        cleaned = NuExtractExtractor.clean_summary_text(cleaned)
        cleaned = re.sub(r"^[，。！？；：、“”‘’\-\s]+", "", cleaned)
        return cleaned.strip()

    @staticmethod
    def _postprocess_entity_roles(payload: dict[str, Any]) -> dict[str, list[str]]:
        processed: dict[str, list[str]] = {}
        for field in DEFAULT_ENTITY_ROLE_SCHEMA:
            raw_values: Any = []
            for alias in ROLE_FIELD_ALIASES[field]:
                candidate = payload.get(alias, [])
                if candidate:
                    raw_values = candidate
                    break
            if not isinstance(raw_values, list):
                raw_values = [raw_values]
            deduped: list[str] = []
            seen: set[str] = set()
            for raw in raw_values:
                text = " ".join(str(raw).strip().split())
                text = NuExtractExtractor.clean_summary_text(text)
                text = re.sub(r"^(的)(?=[\u4e00-\u9fff])", "", text)
                if not text or NuExtractExtractor._looks_like_prompt_leak(text):
                    continue
                if any(token in text for token in ("\n", "\t", "{", "}", "[", "]")):
                    continue
                if len(text) > 48:
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 1 or normalized in seen:
                    continue
                seen.add(normalized)
                deduped.append(text)
            processed[ROLE_FIELD_MAP[field]] = deduped
        return processed

    @staticmethod
    def empty_role_fields() -> dict[str, list[str]]:
        return {target_field: [] for target_field in ROLE_FIELD_MAP.values()}

    @staticmethod
    def _needs_role_field_backfill(payload: dict[str, Any]) -> bool:
        role_fields = [
            "protagonist",
            "current_scene",
            "current_goal_or_task",
            "supporting_characters",
            "items_and_props",
            "protagonist_current_state",
        ]
        return not any(payload.get(field) for field in role_fields)

    @staticmethod
    def _needs_structural_backfill(payload: dict[str, Any]) -> bool:
        priority_fields = [
            "key_scenes",
            "conflicts",
            "state_changes",
        ]
        missing = sum(1 for field in priority_fields if not payload.get(field))
        return missing >= 2 or not payload.get("ending_hook")

    @staticmethod
    def _has_structural_backfill_content(payload: dict[str, Any]) -> bool:
        return any(
            payload.get(field)
            for field in ("key_scenes", "conflicts", "foreshadowing", "clues", "ending_hook", "state_changes")
        )

    @staticmethod
    def _merge_role_fields(base_payload: dict[str, Any], role_payload: dict[str, list[str]]) -> dict[str, Any]:
        merged = dict(base_payload)
        for field, role_values in role_payload.items():
            base_values = merged.get(field, [])
            if not isinstance(base_values, list):
                base_values = [base_values] if base_values else []
            if not isinstance(role_values, list):
                role_values = [role_values] if role_values else []
            deduped: list[str] = []
            seen: set[str] = set()
            for value in [*base_values, *role_values]:
                text = NuExtractExtractor._normalize_list_item(field, value)
                if not text:
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 1 or normalized in seen:
                    continue
                seen.add(normalized)
                deduped.append(text)
            merged[field] = deduped[:4]
        return merged

    @staticmethod
    def _merge_backfill_payload(base_payload: dict[str, Any], backfill_payload: dict[str, Any]) -> dict[str, Any]:
        merged = dict(base_payload)
        for field in ("key_scenes", "conflicts", "foreshadowing", "clues", "state_changes"):
            base_values = merged.get(field, [])
            if not isinstance(base_values, list):
                base_values = [base_values] if base_values else []
            extra_values = backfill_payload.get(field, [])
            if not isinstance(extra_values, list):
                extra_values = [extra_values] if extra_values else []
            deduped: list[str] = []
            seen: set[str] = set()
            for value in [*base_values, *extra_values]:
                text = NuExtractExtractor._normalize_list_item(field, value)
                if not text:
                    continue
                normalized = re.sub(r"[，。！？；：、“”‘’\s]+", "", text)
                if len(normalized) <= 1 or normalized in seen:
                    continue
                seen.add(normalized)
                deduped.append(text)
            merged[field] = deduped[:6]

        if not merged.get("ending_hook") and backfill_payload.get("ending_hook"):
            merged["ending_hook"] = backfill_payload["ending_hook"]
        return merged

    @staticmethod
    def _normalize_list_item(field: str, raw: Any) -> str:
        if isinstance(raw, dict):
            if field == "key_scenes":
                scene = " ".join(str(raw.get("scene", "")).strip().split())
                description = " ".join(str(raw.get("description", "")).strip().split())
                if scene and description and description != scene:
                    return f"{scene}：{description}"
                return scene or description
            if field == "state_changes":
                state = " ".join(str(raw.get("state", "")).strip().split())
                change = " ".join(str(raw.get("change", "")).strip().split())
                before = " ".join(str(raw.get("before", "")).strip().split())
                after = " ".join(str(raw.get("after", "")).strip().split())
                if state and change:
                    return f"{state}：{change}"
                if before and after:
                    return f"从{before}变为{after}"
                return change or state
            if field == "relationship_changes":
                pair = " ".join(str(raw.get("pair", "")).strip().split())
                change = " ".join(str(raw.get("change", "")).strip().split())
                return f"{pair}：{change}".strip("：") if (pair or change) else ""
            if field in {"conflicts", "foreshadowing", "clues", "open_questions", "important_dialogue_topics"}:
                primary_parts = [
                    NuExtractExtractor._stringify_nested(raw.get(key, ""))
                    for key in ("content", "conflict", "question", "topic", "clue", "foreshadowing")
                ]
                primary = " ".join(part for part in primary_parts if part).strip()
                if primary:
                    return primary
            return " ".join(
                part for part in (NuExtractExtractor._stringify_nested(value) for value in raw.values()) if part
            ).strip()
        return NuExtractExtractor._stringify_nested(raw)

    @staticmethod
    def _stringify_nested(value: Any) -> str:
        if isinstance(value, dict):
            parts = [NuExtractExtractor._stringify_nested(item) for item in value.values()]
            return " ".join(part for part in parts if part).strip()
        if isinstance(value, list):
            parts = [NuExtractExtractor._stringify_nested(item) for item in value]
            return " ".join(part for part in parts if part).strip()
        return " ".join(str(value).strip().split())

    @staticmethod
    def _looks_like_prompt_leak(text: str) -> bool:
        leak_markers = (
            "请根据上述内容",
            "用中文总结",
            "schema",
            "字段要求",
            "json schema",
            "章节正文",
            "章节标题",
            "只输出",
            "不要复述",
            "片段摘要",
            "只写具体情节",
            "不要写要求说明",
            "要求：",
        )
        lowered = text.lower()
        return any(marker in text or marker in lowered for marker in leak_markers)
