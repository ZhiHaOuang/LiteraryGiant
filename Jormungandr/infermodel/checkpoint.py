from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import load_json, serialize_payload

from .schemas import GlobalPlot, PlotWindow, WindowAnalysis


class InferModelCheckpoint:
    """Incremental, resumable checkpoint storage for one infermodel book run."""

    def __init__(self, output_dir: str | Path, *, pretty: bool = True) -> None:
        self.output_dir = Path(output_dir)
        self.root = self.output_dir / ".infermodel_checkpoint"
        self.windows_dir = self.root / "windows"
        self.boundaries_dir = self.root / "boundaries"
        self.plots_dir = self.root / "plots"
        self.pretty = pretty
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {}
        self.context: dict[str, Any] = {}
        self.context_hash = ""
        self.windows_dir.mkdir(parents=True, exist_ok=True)
        self.boundaries_dir.mkdir(parents=True, exist_ok=True)
        self.plots_dir.mkdir(parents=True, exist_ok=True)

    def configure(self, context: dict[str, Any]) -> None:
        self.context = dict(context)
        encoded = json.dumps(self.context, ensure_ascii=False, sort_keys=True, default=str)
        self.context_hash = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        self.update_state(
            status="configured",
            context_hash=self.context_hash,
            context=self.context,
        )

    def update_state(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)
            self._state["updated_at"] = self._now()
            self._state.setdefault("checkpoint_schema", "infermodel.checkpoint.v1")
            self._atomic_write(self.root / "state.json", self._state)

    def load_window(self, window: PlotWindow, *, mode: str) -> WindowAnalysis | None:
        path = self._window_path(window, mode=mode)
        try:
            payload = load_json(path)
        except Exception:
            return None
        if not self._context_matches(payload):
            return None
        result = WindowAnalysis.from_dict(payload)
        if result.window_id != window.window_id:
            return None
        if result.chapter_orders != list(window.chapter_orders):
            return None
        if result.start_order != window.start_order or result.end_order != window.end_order:
            return None
        return result

    def write_window(self, result: WindowAnalysis, *, mode: str) -> None:
        path = self._window_result_path(result, mode=mode)
        payload = result.to_dict()
        payload.update(self._artifact_metadata("window", mode=mode))
        self._atomic_write(path, payload)

    def load_plot_for_orders(self, chapter_orders: list[int]) -> GlobalPlot | None:
        orders = [int(order) for order in chapter_orders]
        if not orders:
            return None
        path = self._plot_path_for_orders(orders)
        try:
            payload = load_json(path)
        except Exception:
            return None
        if not self._context_matches(payload):
            return None
        plot = GlobalPlot.from_dict(payload)
        if plot.chapter_orders != orders:
            return None
        if plot.start_order != orders[0] or plot.end_order != orders[-1]:
            return None
        return plot

    def write_plot_for_orders(self, plot: GlobalPlot) -> None:
        if not plot.chapter_orders:
            return
        payload = plot.to_dict()
        payload.update(self._artifact_metadata("plot"))
        self._atomic_write(self._plot_path_for_orders(plot.chapter_orders), payload)

    def load_boundary_assessment(self, left_orders: list[int], right_orders: list[int]) -> dict[str, Any] | None:
        path = self._boundary_path(left_orders, right_orders)
        try:
            payload = load_json(path)
        except Exception:
            return None
        if not self._context_matches(payload):
            return None
        if payload.get("left_orders") != list(left_orders) or payload.get("right_orders") != list(right_orders):
            return None
        assessment = payload.get("assessment")
        return dict(assessment) if isinstance(assessment, dict) else None

    def write_boundary_assessment(self, left_orders: list[int], right_orders: list[int], assessment: dict[str, Any]) -> None:
        payload = {
            "left_orders": list(left_orders),
            "right_orders": list(right_orders),
            "assessment": dict(assessment),
        }
        payload.update(self._artifact_metadata("boundary"))
        self._atomic_write(self._boundary_path(left_orders, right_orders), payload)

    def _artifact_metadata(self, artifact_type: str, **extra: Any) -> dict[str, Any]:
        return {
            "checkpoint_artifact_type": artifact_type,
            "checkpoint_context_hash": self.context_hash,
            "checkpoint_updated_at": self._now(),
            **extra,
        }

    def _context_matches(self, payload: dict) -> bool:
        if not self.context_hash:
            return True
        return payload.get("checkpoint_context_hash") == self.context_hash

    def _window_path(self, window: PlotWindow, *, mode: str) -> Path:
        return self.windows_dir / self._window_file_name(
            mode=mode,
            window_id=window.window_id,
            start_order=window.start_order,
            end_order=window.end_order,
        )

    def _window_result_path(self, result: WindowAnalysis, *, mode: str) -> Path:
        return self.windows_dir / self._window_file_name(
            mode=mode,
            window_id=result.window_id,
            start_order=result.start_order,
            end_order=result.end_order,
        )

    @staticmethod
    def _window_file_name(*, mode: str, window_id: str, start_order: int, end_order: int) -> str:
        safe_mode = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in str(mode or "window"))
        safe_window_id = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in str(window_id or "window"))
        return f"{safe_mode}_{safe_window_id}_{int(start_order):06d}_{int(end_order):06d}.json"

    def _plot_path_for_orders(self, chapter_orders: list[int]) -> Path:
        return self.plots_dir / f"plot_{int(chapter_orders[0]):06d}_{int(chapter_orders[-1]):06d}.json"

    def _boundary_path(self, left_orders: list[int], right_orders: list[int]) -> Path:
        left = [int(order) for order in left_orders]
        right = [int(order) for order in right_orders]
        left_part = f"{left[0]:06d}_{left[-1]:06d}" if left else "none"
        right_part = f"{right[0]:06d}_{right[-1]:06d}" if right else "none"
        return self.boundaries_dir / f"boundary_{left_part}__{right_part}.json"

    def _atomic_write(self, path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            tmp_path.write_text(serialize_payload(payload, pretty=self.pretty), encoding="utf-8")
            tmp_path.replace(path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
