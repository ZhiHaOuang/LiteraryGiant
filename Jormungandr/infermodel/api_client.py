"""LLM API client for infermodel inference."""

from __future__ import annotations

import contextlib
import fcntl
import os
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests


@dataclass
class ApiConfig:
    """Configuration for an LLM API backend."""

    api_key: str = ""
    base_url: str = "https://token-plan-cn.xiaomimimo.com/anthropic"
    model_name: str = "mimo-v2.5-pro"
    provider: str = "auto"
    max_tokens: int = 6144
    temperature: float = 0.0
    timeout: float = 90.0
    max_retries: int = 2
    user_id: str = ""


def _resolve_api_key(api_key: str | None, *, env_var: str = "INFERMODEL_API_KEY") -> str:
    """Resolve API key from argument or environment."""
    if api_key:
        return api_key
    env_key = (
        os.environ.get(env_var)
        or os.environ.get("INFERMODEL_API_KEY")
        or os.environ.get("MIMO_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if env_key:
        return env_key
    raise ValueError(
        "No API key provided. Set INFERMODEL_API_KEY, MIMO_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY."
    )


def _resolve_user_id(user_id: str | None) -> str:
    """Resolve and validate optional provider-side user isolation id."""
    resolved = str(user_id or os.environ.get("INFERMODEL_API_USER_ID") or "").strip()
    if not resolved:
        return ""
    if len(resolved) > 512 or re.fullmatch(r"[a-zA-Z0-9\-_]+", resolved) is None:
        raise ValueError("INFERMODEL_API_USER_ID must match [a-zA-Z0-9\\-_]+ and be at most 512 chars.")
    return resolved


class ApiClient:
    """Small HTTP wrapper for Anthropic- and OpenAI-compatible chat APIs."""

    def __init__(self, config: ApiConfig, *, timeout: float | None = None) -> None:
        self._config = config
        self._api_key = _resolve_api_key(config.api_key)
        self._provider = self._resolve_provider(config.provider, config.base_url)
        self._base_url = config.base_url.rstrip("/")
        self._model = config.model_name
        self._max_tokens = config.max_tokens
        self._timeout = float(config.timeout if timeout is None else timeout)
        self._user_id = _resolve_user_id(config.user_id)

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

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def max_tokens(self) -> int:
        return self._max_tokens

    @property
    def timeout(self) -> float:
        return self._timeout

    @property
    def user_id(self) -> str:
        return self._user_id

    def generate_json(self, *, system_prompt: str, user_prompt: str) -> str:
        """Send a request and return the raw text response."""
        attempts = max(1, int(self._config.max_retries))
        for attempt in range(attempts):
            try:
                with self._global_api_slot():
                    self._throttle_request_start()
                    if self._provider == "anthropic":
                        return self._generate_anthropic(system_prompt=system_prompt, user_prompt=user_prompt)
                    return self._generate_openai(system_prompt=system_prompt, user_prompt=user_prompt)
            except requests.RequestException as exc:
                status_code = getattr(exc.response, "status_code", 0) if getattr(exc, "response", None) is not None else 0
                if attempt < attempts - 1 and self._is_retryable_status(status_code):
                    time.sleep(self._retry_delay(exc, attempt=attempt, status_code=status_code))
                    continue
                raise

        raise RuntimeError("API call failed after retries")

    @contextlib.contextmanager
    def _global_api_slot(self):
        limit = self._env_int("INFERMODEL_API_MAX_IN_FLIGHT", 0)
        if limit <= 0:
            yield
            return

        limit_dir = self._limit_dir()
        slot_file = None
        while slot_file is None:
            for index in range(limit):
                candidate = (limit_dir / f"slot_{index:04d}.lock").open("a+")
                try:
                    fcntl.flock(candidate.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    slot_file = candidate
                    break
                except BlockingIOError:
                    candidate.close()
            if slot_file is None:
                time.sleep(random.uniform(0.05, 0.25))

        try:
            yield
        finally:
            fcntl.flock(slot_file.fileno(), fcntl.LOCK_UN)
            slot_file.close()

    def _throttle_request_start(self) -> None:
        interval = self._env_float("INFERMODEL_API_START_INTERVAL", 0.0)
        if interval <= 0:
            return
        lock_path = self._limit_dir() / "request_start.lock"
        with lock_path.open("a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                lock_file.seek(0)
                raw_value = lock_file.read().strip()
                try:
                    last_start = float(raw_value)
                except ValueError:
                    last_start = 0.0
                now = time.time()
                wait_seconds = last_start + interval - now
                if wait_seconds > 0:
                    time.sleep(wait_seconds)
                    now = time.time()
                lock_file.seek(0)
                lock_file.truncate()
                lock_file.write(str(now))
                lock_file.flush()
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _env_int(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "") or default)
        except ValueError:
            return default

    @staticmethod
    def _env_float(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, "") or default)
        except ValueError:
            return default

    @staticmethod
    def _limit_dir() -> Path:
        path = Path(os.environ.get("INFERMODEL_API_LIMIT_DIR") or "/tmp/literarygiant_infermodel_api_limit")
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _is_retryable_status(status_code: int) -> bool:
        return status_code == 0 or status_code == 408 or status_code == 429 or status_code >= 500

    @staticmethod
    def _retry_delay(exc: requests.RequestException, *, attempt: int, status_code: int) -> float:
        response = getattr(exc, "response", None)
        retry_after = response.headers.get("Retry-After") if response is not None else None
        if retry_after:
            try:
                return min(120.0, max(1.0, float(retry_after)))
            except ValueError:
                pass
        base_delay = 6.0 if status_code == 429 else 1.0
        jitter = random.uniform(0.25, 1.25)
        return min(120.0, base_delay * (2 ** attempt) + jitter)

    def _generate_anthropic(self, *, system_prompt: str, user_prompt: str) -> str:
        payload = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "temperature": self._config.temperature,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        }
        if self._user_id:
            payload["metadata"] = {"user_id": self._user_id}
        response = requests.post(
            f"{self._base_url}/v1/messages",
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=self._timeout,
        )
        response.raise_for_status()
        payload = response.json()
        content = payload.get("content") or []
        return "".join(str(block.get("text", "")) for block in content if isinstance(block, dict))

    def _generate_openai(self, *, system_prompt: str, user_prompt: str) -> str:
        payload = {
            "model": self._model,
            "temperature": self._config.temperature,
            "max_tokens": self._max_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if self._user_id:
            payload["user_id"] = self._user_id
        response = requests.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "content-type": "application/json",
            },
            json=payload,
            timeout=self._timeout,
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") if isinstance(choices[0], dict) else {}
        return str((message or {}).get("content", ""))
