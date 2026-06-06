from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from shared import detect_default_weights_root, resolve_model_source

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from transformers import GenerationConfig
except ImportError:  # pragma: no cover
    AutoModelForCausalLM = None
    AutoTokenizer = None
    GenerationConfig = None


@dataclass(slots=True)
class RuntimePlacement:
    requested_device_map: str = "auto"
    resolved_device_map: str = "auto"
    gpu_count: int = 0
    visible_gpus: list[str] | None = None
    max_memory: dict[Any, str] | None = None
    torch_dtype: str = "float32"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalChatModelRuntime:
    def __init__(
        self,
        *,
        model_name: str,
        weights_root: str | Path | None = None,
        family_dirs: list[str] | None = None,
        max_new_tokens: int = 2200,
        device_map: str = "auto",
        allow_fallback: bool = True,
        gpu_memory_utilization: float = 0.9,
        per_gpu_memory_gb: int | None = None,
    ) -> None:
        self.model_name = str(model_name or "").strip()
        self.weights_root = str(weights_root) if weights_root is not None else str(detect_default_weights_root())
        self.family_dirs = list(family_dirs or [])
        self.max_new_tokens = max(512, int(max_new_tokens))
        self.device_map = str(device_map or "auto")
        self.allow_fallback = allow_fallback
        self.gpu_memory_utilization = max(0.5, min(0.98, float(gpu_memory_utilization)))
        self.per_gpu_memory_gb = int(per_gpu_memory_gb) if per_gpu_memory_gb else None
        self._tokenizer = None
        self._model = None
        self.resolved_model_source = self._resolve_model_dir(self.model_name)
        self.model_available = bool(self.resolved_model_source and Path(self.resolved_model_source).exists())
        self.runtime_placement = self._build_runtime_placement()

    def generate_json_text(self, *, system_prompt: str, user_prompt: str) -> str:
        tokenizer = self.get_tokenizer()
        model = self.get_model()
        if hasattr(tokenizer, "apply_chat_template"):
            text = tokenizer.apply_chat_template(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                tokenize=False,
                add_generation_prompt=True,
            )
        else:
            text = f"{system_prompt}\n\n{user_prompt}"
        model_inputs = tokenizer(text, return_tensors="pt", truncation=True)
        model_inputs = self._move_inputs_to_model_device(model_inputs)
        generation_config = self._build_generation_config(tokenizer)
        outputs = model.generate(
            **model_inputs,
            generation_config=generation_config,
            do_sample=False,
            max_new_tokens=self.max_new_tokens,
            pad_token_id=tokenizer.eos_token_id,
        )
        input_length = model_inputs["input_ids"].shape[-1]
        generated_tokens = outputs[0][int(input_length):]
        return tokenizer.decode(generated_tokens, skip_special_tokens=True)

    def get_tokenizer(self):
        if AutoTokenizer is None:
            raise ImportError("transformers is required for generatemodel.")
        if not self.model_available:
            raise FileNotFoundError(f"Model directory not found: {self.model_name}")
        if self._tokenizer is None:
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.resolved_model_source,
                local_files_only=True,
                trust_remote_code=True,
            )
        return self._tokenizer

    def get_model(self):
        if AutoModelForCausalLM is None or torch is None:
            raise ImportError("transformers and torch are required for generatemodel.")
        if not self.model_available:
            raise FileNotFoundError(f"Model directory not found: {self.model_name}")
        if self._model is None:
            placement = self.runtime_placement
            load_kwargs: dict[str, Any] = {
                "torch_dtype": self._infer_torch_dtype(),
                "device_map": placement.resolved_device_map,
                "local_files_only": True,
                "trust_remote_code": True,
            }
            if placement.max_memory:
                load_kwargs["max_memory"] = placement.max_memory
            self._model = AutoModelForCausalLM.from_pretrained(
                self.resolved_model_source,
                **load_kwargs,
            )
            self._model.eval()
        return self._model

    def _resolve_model_dir(self, model_name: str) -> str:
        resolved = resolve_model_source(
            model_name,
            weights_root=self.weights_root,
            family_dirs=self.family_dirs,
        )
        source_path = Path(resolved).expanduser()
        if source_path.exists():
            return str(source_path)
        return ""

    def _build_runtime_placement(self) -> RuntimePlacement:
        visible_gpus = self._visible_gpu_ids()
        gpu_count = len(visible_gpus)
        resolved_device_map = self.device_map
        max_memory = None

        if resolved_device_map == "auto":
            resolved_device_map = "cpu" if gpu_count == 0 else "auto"
        elif resolved_device_map == "balanced" and gpu_count == 0:
            resolved_device_map = "cpu"

        if gpu_count > 0 and resolved_device_map in {"auto", "balanced", "balanced_low_0", "sequential"}:
            max_memory = self._infer_max_memory(gpu_count)

        return RuntimePlacement(
            requested_device_map=self.device_map,
            resolved_device_map=resolved_device_map,
            gpu_count=gpu_count,
            visible_gpus=visible_gpus,
            max_memory=max_memory,
            torch_dtype=str(self._infer_torch_dtype()).replace("torch.", ""),
        )

    def _infer_max_memory(self, gpu_count: int) -> dict[Any, str]:
        if gpu_count <= 0:
            return {"cpu": "96GiB"}
        memory_by_rank: dict[Any, str] = {}
        for rank in range(gpu_count):
            total_gb = self.per_gpu_memory_gb or self._query_gpu_memory_gb(rank) or 0
            if total_gb <= 0:
                continue
            usable_gb = max(4, int(total_gb * self.gpu_memory_utilization))
            memory_by_rank[rank] = f"{usable_gb}GiB"
        memory_by_rank["cpu"] = "96GiB"
        return memory_by_rank

    @staticmethod
    def _query_gpu_memory_gb(rank: int) -> int | None:
        if torch is None or not torch.cuda.is_available():
            return None
        try:
            props = torch.cuda.get_device_properties(rank)
        except Exception:
            return None
        total_bytes = getattr(props, "total_memory", 0)
        if not total_bytes:
            return None
        return max(1, int(total_bytes / (1024 ** 3)))

    @staticmethod
    def _visible_gpu_ids() -> list[str]:
        if torch is None or not torch.cuda.is_available():
            return []
        try:
            return [str(index) for index in range(torch.cuda.device_count())]
        except Exception:
            return []

    @staticmethod
    def _infer_torch_dtype():
        if torch is None:
            return "float32"
        if torch.cuda.is_available():
            return torch.float16
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.float16
        return torch.float32

    def _move_inputs_to_model_device(self, model_inputs):
        model = self.get_model()
        if hasattr(model, "device") and model.device is not None and str(model.device) != "cpu":
            return {key: value.to(model.device) for key, value in model_inputs.items()}
        return model_inputs

    def _build_generation_config(self, tokenizer):
        if GenerationConfig is None:
            return None
        model = self.get_model()
        base_config = getattr(model, "generation_config", None)
        eos_token_id = getattr(base_config, "eos_token_id", None) if base_config is not None else None
        if eos_token_id is None:
            eos_token_id = tokenizer.eos_token_id
        return GenerationConfig(
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
            eos_token_id=eos_token_id,
            use_cache=True,
        )
