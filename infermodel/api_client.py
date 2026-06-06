"""LLM API client for infermodel inference."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import requests


@dataclass
class ApiConfig:
    """Configuration for an LLM API backend."""

    api_key: str = ""
    base_url: str = "https://token-plan-cn.xiaomimimo.com/anthropic"
    model_name: str = "mimo-v2.5-pro"
    provider: str = "auto"
    max_tokens: int = 1400
    temperature: float = 0.0


def _resolve_api_key(api_key: str | None, *, env_var: str = "MIMO_API_KEY") -> str:
    """Resolve API key from argument or environment."""
    if api_key:
        return api_key
    env_key = (
        os.environ.get(env_var)
        or os.environ.get("MIMO_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if env_key:
        return env_key
    raise ValueError(
        "No API key provided. Set MIMO_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY."
    )


class ApiClient:
    """Small HTTP wrapper for Anthropic- and OpenAI-compatible chat APIs."""

    def __init__(self, config: ApiConfig, *, timeout: float = 120.0) -> None:
        self._config = config
        self._api_key = _resolve_api_key(config.api_key)
        self._provider = self._resolve_provider(config.provider, config.base_url)
        self._base_url = config.base_url.rstrip("/")
        self._model = config.model_name
        self._max_tokens = config.max_tokens
        self._timeout = timeout
        self._session = requests.Session()

    @staticmethod
    def _resolve_provider(provider: str, base_url: str) -> str:
        normalized = str(provider or "auto").strip().lower()
        if normalized in {"anthropic", "openai"}:
            return normalized
        if normalized != "auto":
            raise ValueError("api provider must be one of: auto, anthropic, openai")
        url = base_url.rstrip("/").lower()
        if url.endswith("/anthropic") or "/anthropic/" in url:
            return "anthropic"
        return "openai"

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> str:
        """Send a request and return the raw text response."""
        for attempt in range(2):
            try:
                if self._provider == "anthropic":
                    return self._generate_anthropic(system_prompt=system_prompt, user_prompt=user_prompt)
                return self._generate_openai(system_prompt=system_prompt, user_prompt=user_prompt)
            except requests.RequestException as exc:
                status_code = getattr(exc.response, "status_code", 0) if getattr(exc, "response", None) is not None else 0
                if attempt == 0 and (status_code >= 500 or status_code == 0):
                    continue
                raise

        raise RuntimeError("API call failed after retries")

    def _generate_anthropic(self, *, system_prompt: str, user_prompt: str) -> str:
        response = self._session.post(
            f"{self._base_url}/v1/messages",
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": self._model,
                "max_tokens": self._max_tokens,
                "temperature": self._config.temperature,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
            },
            timeout=self._timeout,
        )
        response.raise_for_status()
        payload = response.json()
        content = payload.get("content") or []
        return "".join(str(block.get("text", "")) for block in content if isinstance(block, dict))

    def _generate_openai(self, *, system_prompt: str, user_prompt: str) -> str:
        response = self._session.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "content-type": "application/json",
            },
            json={
                "model": self._model,
                "temperature": self._config.temperature,
                "max_tokens": self._max_tokens,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=self._timeout,
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") if isinstance(choices[0], dict) else {}
        return str((message or {}).get("content", ""))
