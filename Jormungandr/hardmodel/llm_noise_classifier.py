"""Optional LLM classifier for weak noise windows.

The rule-based cleaner builds small weak-noise windows. This module lets a
small local chat model decide which candidates should be discarded, without
letting the model rewrite text or decide chapter boundaries.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import requests


class QwenWeakNoiseClassifier:
    """Batch weak-noise window classifier backed by a local Qwen model."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        batch_size: int = 32,
        max_new_tokens: int = 128,
        device_map: str = "auto",
    ) -> None:
        self.model_path = str(Path(model_path).expanduser().resolve())
        self.batch_size = max(1, int(batch_size))
        self.max_new_tokens = max(16, int(max_new_tokens))
        self.device_map = device_map
        self._load_model()

    def _load_model(self) -> None:
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("Qwen weak-noise classification requires torch and transformers.") from exc

        dtype = torch.bfloat16 if torch.cuda.is_available() else "auto"
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_path, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_path,
            torch_dtype=dtype,
            device_map=self.device_map,
            trust_remote_code=True,
        )
        self.model.eval()

    def __call__(self, candidates: list[dict[str, Any]]) -> list[Any]:
        actions: list[Any] = []
        for start in range(0, len(candidates), self.batch_size):
            batch = candidates[start : start + self.batch_size]
            actions.extend(self._classify_batch(batch))
        return self._dedupe_actions(actions)

    def _classify_batch(self, batch: list[dict[str, Any]]) -> list[Any]:
        prompt = self._build_prompt(batch)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是中文网文清洗器。只判断候选行是否是正文外噪声。"
                    "不要删除小说正文、对白、人物心理、世界观设定或系统提示。"
                    "只输出 JSON 数组。每项格式为 "
                    "{\"candidate_id\":0,\"action\":\"keep|drop|trim\",\"cleaned_line\":\"...\"}。"
                ),
            },
            {"role": "user", "content": prompt},
        ]
        if hasattr(self.tokenizer, "apply_chat_template"):
            text = self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        else:
            text = "\n".join(f"{item['role']}: {item['content']}" for item in messages)

        inputs = self.tokenizer(text, return_tensors="pt")
        inputs = {key: value.to(self.model.device) for key, value in inputs.items()}
        output_ids = self.model.generate(
            **inputs,
            max_new_tokens=self.max_new_tokens,
            do_sample=False,
            temperature=None,
            top_p=None,
            pad_token_id=self.tokenizer.eos_token_id,
        )
        generated = output_ids[0][inputs["input_ids"].shape[-1] :]
        raw_text = self.tokenizer.decode(generated, skip_special_tokens=True)
        return self._parse_actions(raw_text, [int(item["candidate_id"]) for item in batch])

    def _build_prompt(self, batch: list[dict[str, Any]]) -> str:
        compact = []
        for item in batch:
            compact.append(
                {
                    "candidate_id": item.get("candidate_id"),
                    "line": item.get("line"),
                    "context": item.get("context"),
                    "position_score": item.get("position_score"),
                    "pattern_frequency_score": item.get("pattern_frequency_score"),
                    "prose_score": item.get("prose_score"),
                    "prose_reasons": item.get("prose_reasons"),
                    "noise_score": item.get("noise_score"),
                    "boundary_zone": item.get("boundary_zone"),
                    "weak_reason": item.get("weak_reason"),
                    "allowed_actions": item.get("allowed_actions") or ["keep", "drop", "trim"],
                }
            )
        return (
            "下面是 hardmodel 规则系统拿不准的 weak-noise 小窗口。\n"
            "请为每个候选返回 candidate_id 和 action：keep、drop 或 trim。\n"
            "drop：整行都是广告、求票、求收藏、站点提示、作者题外话、读者群、更新安排、导航提示。\n"
            "trim：只有前缀或后缀是噪声，正文部分应保留；cleaned_line 必须原文截取，不得改写正文。\n"
            "keep：小说正文、对白、动作、心理活动、世界观设定、系统面板、角色真正说出的话。\n"
            "输出 JSON 数组，不要解释。必须包含 candidate_id；如果遗漏，将按候选顺序解释。\n"
            f"候选：\n{json.dumps(compact, ensure_ascii=False)}"
        )

    @staticmethod
    def _parse_actions(raw_text: str, valid_ids: set[int] | list[int]) -> list[Any]:
        ordered_ids = list(valid_ids)
        valid_id_set = set(ordered_ids)
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
            cleaned = re.sub(r"```$", "", cleaned).strip()
        candidates: list[Any] = []
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, list):
                candidates = parsed
            elif isinstance(parsed, dict):
                candidates = (
                    parsed.get("actions")
                    or parsed.get("decisions")
                    or parsed.get("discard_ids")
                    or parsed.get("discard_candidate_ids")
                    or []
                )
        except json.JSONDecodeError:
            match = re.search(r"\[[^\]]*\]", cleaned)
            if match:
                try:
                    candidates = json.loads(match.group(0))
                except json.JSONDecodeError:
                    candidates = []
        result: list[Any] = []
        for position, item in enumerate(candidates):
            if isinstance(item, dict):
                candidate_id = QwenWeakNoiseClassifier._optional_int(item.get("candidate_id"))
                if candidate_id is None and position < len(ordered_ids):
                    candidate_id = ordered_ids[position]
                if candidate_id not in valid_id_set:
                    continue
                action = str(item.get("action") or "").strip().lower()
                if action not in {"keep", "drop", "trim"}:
                    continue
                normalized = {"candidate_id": candidate_id, "action": action}
                if action == "trim":
                    normalized["cleaned_line"] = str(item.get("cleaned_line") or "").strip()
                result.append(normalized)
                continue
            try:
                value = int(item)
            except (TypeError, ValueError):
                continue
            if value in valid_id_set:
                result.append(value)
        return result

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _dedupe_actions(actions: list[Any]) -> list[Any]:
        seen: set[tuple[str, int]] = set()
        result: list[Any] = []
        for action in actions:
            if isinstance(action, dict):
                candidate_id = QwenWeakNoiseClassifier._optional_int(action.get("candidate_id"))
                if candidate_id is None:
                    continue
                key = (str(action.get("action") or ""), candidate_id)
            else:
                try:
                    key = ("drop", int(action))
                except (TypeError, ValueError):
                    continue
            if key in seen:
                continue
            seen.add(key)
            result.append(action)
        return result

    # Backward-compatible alias for older tests/callers.
    _parse_discard_ids = _parse_actions


class VLLMWeakNoiseClassifier:
    """Weak-noise classifier using a vLLM OpenAI-compatible chat endpoint."""

    def __init__(
        self,
        *,
        api_base_url: str = "http://127.0.0.1:8000/v1",
        model_name: str = "Qwen_8B",
        batch_size: int = 16,
        max_new_tokens: int = 192,
        temperature: float = 0.0,
        timeout: float = 120.0,
    ) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.model_name = model_name
        self.batch_size = max(1, int(batch_size))
        self.max_new_tokens = max(16, int(max_new_tokens))
        self.temperature = float(temperature)
        self.timeout = float(timeout)
        self._session = requests.Session()
        self._session.trust_env = False

    def __call__(self, candidates: list[dict[str, Any]]) -> list[Any]:
        actions: list[Any] = []
        for start in range(0, len(candidates), self.batch_size):
            batch = candidates[start : start + self.batch_size]
            actions.extend(self._classify_batch(batch))
        return QwenWeakNoiseClassifier._dedupe_actions(actions)

    def _classify_batch(self, batch: list[dict[str, Any]]) -> list[Any]:
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是中文网文清洗器。只判断候选行是否是正文外噪声。"
                        "不要删除小说正文、对白、人物心理、世界观设定或系统提示。"
                        "必须只输出 JSON 数组，不要解释。每项格式为 "
                        "{\"candidate_id\":0,\"action\":\"keep|drop|trim\",\"cleaned_line\":\"...\"}。"
                    ),
                },
                {"role": "user", "content": self._build_prompt(batch)},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_new_tokens,
        }
        response = self._session.post(
            f"{self.api_base_url}/chat/completions",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = response.json()
        raw_text = data["choices"][0]["message"]["content"]
        return QwenWeakNoiseClassifier._parse_actions(
            raw_text,
            [int(item["candidate_id"]) for item in batch],
        )

    @staticmethod
    def _build_prompt(batch: list[dict[str, Any]]) -> str:
        compact = []
        for item in batch:
            compact.append(
                {
                    "candidate_id": item.get("candidate_id"),
                    "line": item.get("line"),
                    "context": item.get("context"),
                    "position_score": item.get("position_score"),
                    "pattern_frequency_score": item.get("pattern_frequency_score"),
                    "prose_score": item.get("prose_score"),
                    "prose_reasons": item.get("prose_reasons"),
                    "noise_score": item.get("noise_score"),
                    "boundary_zone": item.get("boundary_zone"),
                    "weak_reason": item.get("weak_reason"),
                    "allowed_actions": item.get("allowed_actions") or ["keep", "drop", "trim"],
                }
            )
        return (
            "下面是 hardmodel 规则系统拿不准的 weak-noise 小窗口。\n"
            "请为每个候选返回 candidate_id 和 action：keep、drop 或 trim。\n"
            "drop：整行都是广告、求票、求收藏、站点提示、作者题外话、读者群、更新安排、导航提示。\n"
            "trim：只有前缀或后缀是噪声，正文部分应保留；cleaned_line 必须原文截取，不得改写正文。\n"
            "keep：小说正文、对白、动作、心理活动、世界观设定、系统面板、角色真正说出的话。\n"
            "输出 JSON 数组，不要解释。必须包含 candidate_id；如果遗漏，将按候选顺序解释。\n"
            f"候选：\n{json.dumps(compact, ensure_ascii=False)}"
        )
