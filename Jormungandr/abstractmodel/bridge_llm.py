from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

import requests

from shared import parse_json_payload


@dataclass(frozen=True)
class BridgeLLMConfig:
    provider: str = "off"
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    api_protocol: str = "anthropic"
    max_tokens: int = 6144
    temperature: float = 0.0
    timeout: float = 180.0
    retries: int = 2

    @classmethod
    def resolved(
        cls,
        *,
        provider: str,
        api_key: str = "",
        base_url: str = "",
        model: str = "",
        api_protocol: str = "anthropic",
        max_tokens: int = 6144,
        temperature: float = 0.0,
        timeout: float = 180.0,
        retries: int = 2,
    ) -> "BridgeLLMConfig":
        provider = provider.strip().lower()
        if provider == "deepseek":
            base_url = (
                base_url
                or os.environ.get("ABSTRACTMODEL_DEEPSEEK_BASE_URL")
                or os.environ.get("ANTHROPIC_BASE_URL")
                or "https://api.deepseek.com/anthropic"
            )
            if api_protocol == "openai" and base_url.rstrip("/").endswith("/anthropic"):
                base_url = base_url.rstrip("/")[: -len("/anthropic")]
            model = (
                model
                or _clean_model(os.environ.get("ABSTRACTMODEL_DEEPSEEK_MODEL"))
                or _clean_model(os.environ.get("ANTHROPIC_MODEL"))
                or "deepseek-v4-pro"
            )
            api_key = api_key or _first_env(
                "ABSTRACTMODEL_DEEPSEEK_API_KEY",
                "DEEPSEEK_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_API_KEY",
            )
        elif provider == "mimo":
            base_url = base_url or "https://token-plan-cn.xiaomimimo.com/anthropic"
            model = model or "mimo-v2.5-pro"
            api_key = api_key or _first_env(
                "ABSTRACTMODEL_MIMO_API_KEY",
                "MIMO_API_KEY",
                "INFERMODEL_API_KEY",
                "ANTHROPIC_API_KEY",
            )
        elif provider == "custom":
            api_key = api_key or _first_env("ABSTRACTMODEL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")
            if not base_url or not model:
                raise ValueError("custom provider requires base_url and model")
        elif provider == "off":
            return cls(provider="off")
        else:
            raise ValueError("provider must be one of: off, deepseek, mimo, custom")
        if not api_key:
            raise ValueError(f"No API key available for abstractmodel provider={provider}")
        return cls(
            provider=provider,
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            model=model,
            api_protocol=api_protocol,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout=timeout,
            retries=retries,
        )


class BridgeLLMClient:
    def __init__(self, config: BridgeLLMConfig) -> None:
        if config.provider == "off":
            raise ValueError("Cannot create an LLM client with provider=off")
        self.config = config
        self.last_usage: dict[str, Any] = {}

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> tuple[dict[str, Any], str]:
        self.last_usage = {}
        last_error: Exception | None = None
        for attempt in range(max(1, self.config.retries)):
            try:
                raw, usage = self._request(system_prompt=system_prompt, user_prompt=user_prompt)
                self.last_usage = usage
                try:
                    return parse_json_payload(raw), raw
                except (json.JSONDecodeError, ValueError) as exc:
                    # A truncated response will not become complete by spending the same
                    # tokens again. Preserve it for diagnosis and let the pipeline move on.
                    raise BridgeLLMResponseError(str(exc), raw_response=raw, usage=usage) from exc
            except BridgeLLMResponseError:
                raise
            except requests.RequestException as exc:
                last_error = exc
                if attempt + 1 >= max(1, self.config.retries):
                    break
                time.sleep(min(8.0, 1.5 * (2**attempt)))
        assert last_error is not None
        raise last_error

    def _request(self, *, system_prompt: str, user_prompt: str) -> tuple[str, dict[str, Any]]:
        if self.config.api_protocol == "anthropic":
            return self._request_anthropic(system_prompt=system_prompt, user_prompt=user_prompt)
        if self.config.api_protocol == "openai":
            return self._request_openai(system_prompt=system_prompt, user_prompt=user_prompt)
        raise ValueError("api_protocol must be anthropic or openai")

    def _request_anthropic(self, *, system_prompt: str, user_prompt: str) -> tuple[str, dict[str, Any]]:
        response = requests.post(
            f"{self.config.base_url}/v1/messages",
            headers={
                "x-api-key": self.config.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": self.config.model,
                "max_tokens": self.config.max_tokens,
                "temperature": self.config.temperature,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
            },
            timeout=self.config.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        text = "".join(
            str(block.get("text", ""))
            for block in payload.get("content") or []
            if isinstance(block, dict)
        )
        return text, payload.get("usage") if isinstance(payload.get("usage"), dict) else {}

    def _request_openai(self, *, system_prompt: str, user_prompt: str) -> tuple[str, dict[str, Any]]:
        response = requests.post(
            f"{self.config.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.config.api_key}", "content-type": "application/json"},
            json={
                "model": self.config.model,
                "max_tokens": self.config.max_tokens,
                "temperature": self.config.temperature,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=self.config.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        text = str(((choices[0].get("message") or {}).get("content")) if choices else "")
        return text, payload.get("usage") if isinstance(payload.get("usage"), dict) else {}


def _first_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return ""


def _clean_model(value: str | None) -> str:
    return str(value or "").replace("[1m]", "").strip()


class BridgeLLMResponseError(ValueError):
    def __init__(self, message: str, *, raw_response: str, usage: dict[str, Any]) -> None:
        super().__init__(message)
        self.raw_response = raw_response
        self.usage = usage
