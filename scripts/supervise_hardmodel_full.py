"""Keep the canonical HardModel runner and its local vLLM service alive.

The runner is journaled per canonical ID.  Restarting it with the same run
directory skips ``written`` and ``preexisting`` rows and retries everything
else.  The supervisor stops the runner after repeated vLLM health failures so
that an outage cannot silently publish books whose weak-noise windows were
never classified.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Sequence
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_event(path: Path, event: str, **details: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {"time": utc_now(), "event": event, **details}
    with path.open("a", encoding="utf-8", buffering=1) as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def pid_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
        if state == "Z":
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            return False
    except (OSError, IndexError):
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def write_pid(path: Path, pid: int) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(f"{pid}\n", encoding="utf-8")
    os.replace(temporary, path)


def terminate_group(pid: int | None, *, timeout: float = 20.0) -> None:
    if not pid_alive(pid):
        return
    assert pid is not None
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.5)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def vllm_healthy(url: str, *, timeout: float = 3.0) -> bool:
    try:
        with urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def spawn(
    command: Sequence[str],
    *,
    log_path: Path,
    pid_path: Path,
) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        list(command),
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={
            **os.environ,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "PYTHONUNBUFFERED": "1",
        },
    )
    log_handle.close()
    write_pid(pid_path, process.pid)
    return process.pid


def completed_successfully(summary_path: Path) -> bool:
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    counters = summary.get("counters") or {}
    return (
        summary.get("status") == "complete"
        and int(summary.get("remaining") or 0) == 0
        and int(counters.get("failed") or 0) == 0
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-dir",
        default="runs/hardmodel-canonical-full-20260724",
    )
    parser.add_argument("--poll-seconds", type=float, default=10.0)
    parser.add_argument("--health-failures", type=int, default=3)
    args = parser.parse_args()

    run_dir = (ROOT / args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    event_log = run_dir / "supervisor.jsonl"
    supervisor_pid = run_dir / "supervisor.pid"
    vllm_pid_path = run_dir / "vllm.pid"
    runner_pid_path = run_dir / "runner.pid"
    write_pid(supervisor_pid, os.getpid())

    vllm_command = [
        "python",
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        "models/weights/Qwen_14B",
        "--served-model-name",
        "novel-metadata",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
        "--gpu-memory-utilization",
        "0.92",
        "--max-model-len",
        "8192",
        "--max-num-seqs",
        "64",
        "--max-num-batched-tokens",
        "32768",
        "--enable-prefix-caching",
        "--generation-config",
        "vllm",
        "--disable-log-requests",
        "--trust-remote-code",
    ]
    runner_command = [
        "python",
        "-u",
        "scripts/run_hardmodel_parallel.py",
        "--raw-root",
        "Library/TaciturnRaw/01_RawData",
        "--output-root",
        "Library/TaciturnRaw/02_CleanedData",
        "--run-dir",
        str(run_dir),
        "--mapping-manifest",
        "Library/indexes/taciturn_hardmodel_gate.json",
        "--allow-live-output",
        "--workers",
        "28",
        "--model",
        "novel-metadata",
        "--base-url",
        "http://127.0.0.1:8000/v1",
        "--batch-size",
        "64",
        "--max-batch-characters",
        "12000",
        "--max-new-tokens",
        "384",
        "--timeout",
        "300",
        "--llm-concurrency",
        "1",
        "--llm-min-windows",
        "1",
        "--minimum-free-gib",
        "256",
    ]

    append_event(event_log, "supervisor_started", pid=os.getpid())
    consecutive_health_failures = 0
    vllm_start_deadline = 0.0
    while True:
        if (run_dir / "STOP").exists():
            append_event(event_log, "stop_marker_seen")
            terminate_group(read_pid(runner_pid_path))
            terminate_group(read_pid(vllm_pid_path))
            return 0

        runner_pid = read_pid(runner_pid_path)
        vllm_pid = read_pid(vllm_pid_path)
        runner_alive = pid_alive(runner_pid)
        service_alive = pid_alive(vllm_pid)
        healthy = vllm_healthy("http://127.0.0.1:8000/health")
        consecutive_health_failures = (
            0 if healthy else consecutive_health_failures + 1
        )

        if completed_successfully(run_dir / "summary.json"):
            append_event(event_log, "run_complete")
            terminate_group(vllm_pid)
            return 0

        if (
            runner_alive
            and consecutive_health_failures >= max(1, args.health_failures)
        ):
            append_event(
                event_log,
                "runner_stopped_for_vllm_outage",
                runner_pid=runner_pid,
                vllm_pid=vllm_pid,
            )
            terminate_group(runner_pid)
            terminate_group(vllm_pid)
            runner_alive = False
            service_alive = False

        if not service_alive:
            vllm_pid = spawn(
                vllm_command,
                log_path=run_dir / "vllm.log",
                pid_path=vllm_pid_path,
            )
            append_event(event_log, "vllm_started", pid=vllm_pid)
            consecutive_health_failures = 0
            vllm_start_deadline = time.monotonic() + 240.0
        elif (
            not healthy
            and not runner_alive
            and consecutive_health_failures >= max(1, args.health_failures)
            and vllm_start_deadline
            and time.monotonic() >= vllm_start_deadline
        ):
            append_event(event_log, "vllm_start_timeout", pid=vllm_pid)
            terminate_group(vllm_pid)
            vllm_pid = spawn(
                vllm_command,
                log_path=run_dir / "vllm.log",
                pid_path=vllm_pid_path,
            )
            append_event(event_log, "vllm_started", pid=vllm_pid)
            consecutive_health_failures = 0
            vllm_start_deadline = time.monotonic() + 240.0

        if healthy and not runner_alive:
            runner_pid = spawn(
                runner_command,
                log_path=run_dir / "runner.log",
                pid_path=runner_pid_path,
            )
            append_event(event_log, "runner_started", pid=runner_pid)

        time.sleep(max(2.0, args.poll_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
