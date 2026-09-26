"""Optional LLM classifier for weak noise windows.

The rule-based cleaner builds small weak-noise windows. This module lets a
small local chat model decide which candidates should be discarded, without
letting the model rewrite text or decide chapter boundaries.
"""

from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
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
            "输出 JSON 数组，不要解释。必须使用候选里的 candidate_id，不要从 0 重新编号；如果遗漏，将按候选顺序解释。\n"
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
                if "d" in parsed or "t" in parsed:
                    discard_ids = parsed.get("d") or []
                    trims = parsed.get("t") or []
                    candidates = [
                        {"candidate_id": candidate_id, "action": "drop"}
                        for candidate_id in discard_ids
                    ]
                    candidates.extend(
                        [trim[0], "t", trim[1]]
                        for trim in trims
                        if isinstance(trim, (list, tuple)) and len(trim) >= 2
                    )
                else:
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
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                candidate_id = QwenWeakNoiseClassifier._optional_int(item[0])
                if candidate_id not in valid_id_set:
                    continue
                compact_action = str(item[1] or "").strip().lower()
                action = {
                    "k": "keep",
                    "keep": "keep",
                    "d": "drop",
                    "drop": "drop",
                    "t": "trim",
                    "trim": "trim",
                }.get(compact_action)
                if action is None:
                    continue
                normalized = {"candidate_id": candidate_id, "action": action}
                if action == "trim" and len(item) >= 3:
                    normalized["cleaned_line"] = str(item[2] or "").strip()
                result.append(normalized)
                continue
            if isinstance(item, dict):
                candidate_id = QwenWeakNoiseClassifier._optional_int(item.get("candidate_id"))
                if (
                    (candidate_id is None or candidate_id not in valid_id_set)
                    and position < len(ordered_ids)
                ):
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
        max_new_tokens: int = 384,
        temperature: float = 0.0,
        timeout: float = 120.0,
        max_concurrency: int = 1,
        max_batch_characters: int = 12_000,
    ) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.model_name = model_name
        self.batch_size = max(1, int(batch_size))
        self.max_new_tokens = max(16, int(max_new_tokens))
        self.temperature = float(temperature)
        self.timeout = float(timeout)
        self.max_concurrency = max(1, int(max_concurrency))
        self.max_batch_characters = max(1_000, int(max_batch_characters))
        self._thread_local = threading.local()

    def __call__(self, candidates: list[dict[str, Any]]) -> list[Any]:
        batches = self._build_batches(candidates)
        if self.max_concurrency <= 1 or len(batches) <= 1:
            actions = []
            for batch in batches:
                actions.extend(self._classify_batch(batch))
            return QwenWeakNoiseClassifier._dedupe_actions(actions)

        actions: list[Any] = []
        workers = min(self.max_concurrency, len(batches))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(self._classify_batch, batch) for batch in batches]
            for future in as_completed(futures):
                try:
                    actions.extend(future.result())
                except Exception:
                    # Keep candidates from failed requests.  The rule cleaner is
                    # intentionally conservative when the model path is flaky.
                    continue
        return QwenWeakNoiseClassifier._dedupe_actions(actions)

    def _get_session(self) -> requests.Session:
        session = getattr(self._thread_local, "session", None)
        if session is None:
            session = requests.Session()
            session.trust_env = False
            self._thread_local.session = session
        return session

    def _classify_batch(self, batch: list[dict[str, Any]]) -> list[Any]:
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是保守的中文网文清洗器，只判断候选行是否为正文外噪声。"
                        "小说正文、对白、人物心理、世界观设定和系统提示一律保留。"
                        "正文中谈论广告、推广、支持、收藏、二维码或公众号不算噪声；"
                        "含求订阅字样的章节标题也必须保留。"
                        "默认keep并省略所有keep项，只输出一个JSON对象，不得解释。"
                        "格式严格为{\"d\":[整行删除的id],"
                        "\"t\":[[id,\"应保留的原文连续子串\"]]}。"
                    ),
                },
                {"role": "user", "content": self._build_prompt(batch)},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_new_tokens,
            "response_format": {"type": "json_object"},
        }
        response = self._get_session().post(
            f"{self.api_base_url}/chat/completions",
            json=payload,
            timeout=self.timeout,
        )
        if response.status_code == 400 and len(batch) > 1:
            midpoint = max(1, len(batch) // 2)
            return self._classify_batch(batch[:midpoint]) + self._classify_batch(batch[midpoint:])
        if response.status_code == 400:
            # A pathological single line can exceed the model context even
            # after surrounding context has been compacted.  The conservative
            # fallback is keep, not failing every other candidate in the book.
            return []
        response.raise_for_status()
        data = response.json()
        choice = data["choices"][0]
        raw_text = choice["message"]["content"]
        if choice.get("finish_reason") == "length" and len(batch) > 1:
            midpoint = max(1, len(batch) // 2)
            return self._classify_batch(batch[:midpoint]) + self._classify_batch(batch[midpoint:])
        return QwenWeakNoiseClassifier._parse_actions(
            raw_text,
            [int(item["candidate_id"]) for item in batch],
        )

    @staticmethod
    def _build_prompt(batch: list[dict[str, Any]]) -> str:
        compact = [VLLMWeakNoiseClassifier._compact_row(item) for item in batch]
        return (
            "判定规则系统仍不确定的行。默认keep，keep项必须省略。"
            "情节或对白中提到广告、推广、支持、收藏、二维码、公众号时必须keep；"
            "章节标题即使带求订阅、求月票也必须keep。"
            "整行是广告、站点提示、作者题外话、求票收藏、读者群、更新或导航提示时，"
            "把id加入d；仅首尾含噪声时，把[id,\"应保留的原文连续子串\"]加入t。"
            "不得改写正文。字段依次为"
            "[id,line,before,after,prose,frequency,noise,zone,reason]。"
            "只输出{\"d\":[],\"t\":[]}格式的JSON对象。输入："
            f"{json.dumps(compact, ensure_ascii=False, separators=(',', ':'))}"
        )

    def _build_batches(
        self,
        candidates: list[dict[str, Any]],
    ) -> list[list[dict[str, Any]]]:
        """Pack batches by both item count and serialized character budget.

        Fixed 32-item batches varied from a few hundred to more than 15k
        tokens on the raw corpus.  A cheap character budget keeps requests near
        the vLLM context limit without loading a tokenizer in every CPU worker;
        the HTTP 400 split remains a final exact-token safety net.
        """
        batches: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        current_characters = 0
        for candidate in candidates:
            row_characters = len(
                json.dumps(
                    self._compact_row(candidate),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            if current and (
                len(current) >= self.batch_size
                or current_characters + row_characters > self.max_batch_characters
            ):
                batches.append(current)
                current = []
                current_characters = 0
            current.append(candidate)
            current_characters += row_characters
        if current:
            batches.append(current)
        return batches

    @staticmethod
    def _compact_row(item: dict[str, Any]) -> list[Any]:
        before = ""
        after = ""
        for context_item in item.get("context") or []:
            if not isinstance(context_item, dict):
                continue
            role = str(context_item.get("role") or "")
            text = str(context_item.get("text") or "")
            if role == "before":
                before = text[-240:]
            elif role == "after" and not after:
                after = text[:240]
        return [
            item.get("candidate_id"),
            item.get("line"),
            before,
            after,
            item.get("prose_score"),
            item.get("pattern_frequency_score"),
            item.get("noise_score"),
            item.get("boundary_zone"),
            item.get("weak_reason"),
        ]
