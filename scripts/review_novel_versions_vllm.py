"""Review potentially incomplete novel editions with bounded vLLM samples.

The reviewer never deletes files. It reads three small windows from the
candidate and preferred editions, requests strict JSON from an OpenAI-compatible
vLLM server, applies deterministic safety guards, and appends resumable JSONL.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any

import requests


DECISIONS = (
    "candidate_incomplete",
    "keep_both_complete",
    "candidate_distinct_content",
    "uncertain",
)
RESULT_KEYS = {
    "decision",
    "confidence",
    "candidate_has_ending",
    "preferred_has_additional_chapters",
    "evidence",
}
SPACE_RE = re.compile(r"\s+")


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"Queue row is not an object at {path}:{line_no}")
            review_id = str(row.get("review_id") or "")
            if not review_id or review_id in seen:
                raise ValueError(f"Missing/duplicate review_id at {path}:{line_no}")
            seen.add(review_id)
            rows.append(row)
    return rows


def _read_window(path: Path, fraction: float, *, max_chars: int) -> str:
    size = path.stat().st_size
    read_bytes = max(4096, max_chars * 4 + 32)
    offset = int(max(0, size - read_bytes) * min(1.0, max(0.0, fraction)))
    with path.open("rb") as handle:
        handle.seek(offset)
        payload = handle.read(read_bytes)
    text = payload.decode("utf-8", errors="ignore")
    text = SPACE_RE.sub(" ", text).strip()
    if fraction >= 1.0:
        return text[-max_chars:]
    return text[:max_chars]


def build_review_payload(row: dict[str, Any], *, sample_chars: int = 450) -> dict[str, Any]:
    def edition_payload(key: str) -> dict[str, Any]:
        edition = dict(row[key])
        path = Path(str(edition["source_file"]))
        return {
            "id": edition["canonical_id"],
            "title": edition["title"],
            "author": edition["author"],
            "characters": edition["characters"],
            "samples": {
                "opening": _read_window(path, 0.0, max_chars=sample_chars),
                "middle": _read_window(path, 0.5, max_chars=sample_chars),
                "ending": _read_window(path, 1.0, max_chars=sample_chars),
            },
        }

    return {
        "review_id": row["review_id"],
        "work_id": row["work_id"],
        "deterministic_disposition": row["disposition"],
        "length_ratio": row["length_ratio"],
        "deterministic_evidence": row.get("incomplete_evidence"),
        "candidate": edition_payload("candidate"),
        "preferred": edition_payload("preferred"),
    }


def _response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": sorted(RESULT_KEYS),
        "properties": {
            "decision": {"type": "string", "enum": list(DECISIONS)},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "candidate_has_ending": {"type": ["boolean", "null"]},
            "preferred_has_additional_chapters": {"type": ["boolean", "null"]},
            "evidence": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 5,
            },
        },
    }


def _system_prompt() -> str:
    return (
        "你是中文小说版本完整性审核器。候选版和首选版通常属于同一作品，但也可能只是书名相似。"
        "只根据给出的确定性证据、长度和正文抽样判断候选版是否残缺。开头或中段不同不能单独证明残缺；"
        "卷本、改写版、番外版、不同结局应保留为不同完整版本。只有候选结尾明显截断，或首选版在候选结尾"
        "之后继续出现同一叙事的章节，才能判断 candidate_incomplete。证据不足必须 uncertain。"
        "输出且只输出符合 schema 的 JSON，不要 Markdown，不要建议实际删除文件。"
    )


class VersionReviewClient:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        timeout: float,
        max_tokens: int,
    ) -> None:
        self.endpoint = base_url.rstrip("/")
        if not self.endpoint.endswith("/chat/completions"):
            self.endpoint += "/chat/completions" if self.endpoint.endswith("/v1") else "/v1/chat/completions"
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.local = threading.local()

    def _session(self) -> requests.Session:
        session = getattr(self.local, "session", None)
        if session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=0)
            session.mount("http://", adapter)
            self.local.session = session
        return session

    def review(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "novel_version_review",
                    "strict": True,
                    "schema": _response_schema(),
                },
            },
        }
        response = self._session().post(self.endpoint, json=body, timeout=self.timeout)
        response.raise_for_status()
        envelope = response.json()
        result = json.loads(envelope["choices"][0]["message"]["content"])
        if not isinstance(result, dict) or set(result) != RESULT_KEYS:
            raise ValueError(f"Model result has invalid keys: {result}")
        if result["decision"] not in DECISIONS:
            raise ValueError(f"Invalid model decision: {result['decision']}")
        confidence = float(result["confidence"])
        if not 0 <= confidence <= 1:
            raise ValueError(f"Invalid confidence: {confidence}")
        result["confidence"] = confidence
        return result


def guard_result(queue_row: dict[str, Any], model_result: dict[str, Any]) -> dict[str, Any]:
    decision = str(model_result["decision"])
    confidence = float(model_result["confidence"])
    direct = isinstance(queue_row.get("incomplete_evidence"), dict)
    if decision != "candidate_incomplete":
        action = "retain"
        guard_reason = "model_did_not_find_candidate_incomplete"
    elif (
        direct
        and confidence >= 0.85
        and model_result.get("preferred_has_additional_chapters") is True
    ):
        action = "recommend_remove_after_audit"
        guard_reason = "direct_containment_and_high_confidence_model_agree"
    elif confidence >= 0.85:
        action = "secondary_review"
        guard_reason = "model_only_incomplete_signal_cannot_delete"
    else:
        action = "retain_pending_review"
        guard_reason = "incomplete_confidence_below_guard_threshold"
    return {
        "guarded_action": action,
        "guard_reason": guard_reason,
        "automatic_delete": False,
    }


def _load_completed(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    completed: dict[str, dict[str, Any]] = {}
    for row in _load_jsonl(path):
        completed[str(row["review_id"])] = row
    return completed


def run_reviews(args: argparse.Namespace) -> dict[str, Any]:
    queue = _load_jsonl(Path(args.queue).resolve())
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results_path = output / "results.jsonl"
    completed = _load_completed(results_path)
    pending = [row for row in queue if row["review_id"] not in completed]
    if args.limit is not None:
        pending = pending[: args.limit]
    client = VersionReviewClient(
        base_url=args.base_url,
        model=args.model,
        timeout=args.timeout,
        max_tokens=args.max_tokens,
    )

    def process(row: dict[str, Any]) -> dict[str, Any]:
        started = time.monotonic()
        try:
            payload = build_review_payload(row, sample_chars=args.sample_chars)
            last_error = ""
            for attempt in range(1, args.retries + 2):
                try:
                    model_result = client.review(payload)
                    return {
                        "review_id": row["review_id"],
                        "work_id": row["work_id"],
                        "candidate_id": row["candidate"]["canonical_id"],
                        "preferred_id": row["preferred"]["canonical_id"],
                        "status": "complete",
                        "attempts": attempt,
                        "elapsed_seconds": round(time.monotonic() - started, 3),
                        "model_result": model_result,
                        **guard_result(row, model_result),
                    }
                except (OSError, requests.RequestException, ValueError, KeyError, json.JSONDecodeError) as exc:
                    last_error = f"{type(exc).__name__}: {exc}"
                    if attempt <= args.retries:
                        time.sleep(min(2.0, 0.25 * attempt))
            raise RuntimeError(last_error)
        except Exception as exc:
            return {
                "review_id": row["review_id"],
                "work_id": row["work_id"],
                "candidate_id": row["candidate"]["canonical_id"],
                "preferred_id": row["preferred"]["canonical_id"],
                "status": "failed",
                "elapsed_seconds": round(time.monotonic() - started, 3),
                "error": f"{type(exc).__name__}: {exc}",
                "automatic_delete": False,
            }

    mode = "a" if results_path.exists() else "x"
    new_results: list[dict[str, Any]] = []
    with results_path.open(mode, encoding="utf-8") as writer:
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            futures = {executor.submit(process, row): row for row in pending}
            for future in as_completed(futures):
                result = future.result()
                new_results.append(result)
                writer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
                if len(new_results) % args.flush_every == 0:
                    writer.flush()
                    os.fsync(writer.fileno())
        writer.flush()
        os.fsync(writer.fileno())

    all_results = _load_completed(results_path)
    statuses = Counter(str(row.get("status")) for row in all_results.values())
    actions = Counter(str(row.get("guarded_action")) for row in all_results.values() if row.get("guarded_action"))
    decisions = Counter(
        str(row.get("model_result", {}).get("decision"))
        for row in all_results.values()
        if isinstance(row.get("model_result"), dict)
    )
    summary = {
        "queue": len(queue),
        "completed_before": len(completed),
        "submitted": len(pending),
        "results": len(all_results),
        "remaining": len(queue) - len(all_results),
        "statuses": dict(sorted(statuses.items())),
        "model_decisions": dict(sorted(decisions.items())),
        "guarded_actions": dict(sorted(actions.items())),
        "automatic_deletions": 0,
        "concurrency": args.concurrency,
        "model": args.model,
    }
    temporary = output / f".summary.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, output / "summary.json")
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--model", default="novel-metadata")
    parser.add_argument("--concurrency", type=int, default=32)
    parser.add_argument("--sample-chars", type=int, default=450)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--flush-every", type=int, default=16)
    parser.add_argument("--limit", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.concurrency < 1 or args.sample_chars < 100 or args.max_tokens < 64:
        raise ValueError("Invalid concurrency/sample/max-token configuration")
    if args.flush_every < 1 or args.retries < 0 or (args.limit is not None and args.limit < 1):
        raise ValueError("Invalid flush/retry/limit configuration")
    summary = run_reviews(args)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["statuses"].get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
