from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from shared import BRIDGE_NOVELS_PLOT_ROOT, as_text, load_json, serialize_payload


PREFLIGHT_SCHEMA_VERSION = "abstractmodel_preflight.v1"
CORE_FIELDS = (
    "plot_function",
    "driving_force",
    "key_events",
    "characters_involved",
    "conflict_model",
    "payoff_and_hook",
    "abstraction_hint",
)
OPTIONAL_FIELDS = ("relationship_changes",)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="abstractmodel-preflight",
        description="Classify Bridges plot books for abstractmodel readiness without writing abstract outputs.",
    )
    parser.add_argument("input", nargs="?", default=str(BRIDGE_NOVELS_PLOT_ROOT))
    parser.add_argument("--report", default="", help="Optional JSON report path.")
    parser.add_argument("--max-samples", type=int, default=5)
    parser.add_argument("--direct-fallback-threshold", type=float, default=0.20)
    parser.add_argument("--caution-fallback-threshold", type=float, default=0.35)
    parser.add_argument("--direct-core-threshold", type=float, default=0.80)
    parser.add_argument("--partial-core-threshold", type=float, default=0.60)
    return parser


def classify_books(
    input_path: str | Path,
    *,
    max_samples: int = 5,
    direct_fallback_threshold: float = 0.20,
    caution_fallback_threshold: float = 0.35,
    direct_core_threshold: float = 0.80,
    partial_core_threshold: float = 0.60,
) -> dict[str, Any]:
    root = Path(input_path)
    books = _discover_books(root)
    rows = [
        classify_book(
            book,
            max_samples=max_samples,
            direct_fallback_threshold=direct_fallback_threshold,
            caution_fallback_threshold=caution_fallback_threshold,
            direct_core_threshold=direct_core_threshold,
            partial_core_threshold=partial_core_threshold,
        )
        for book in books
    ]
    tiers = {tier: [row["book_slug"] for row in rows if row["tier"] == tier] for tier in _tiers()}
    return {
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "input": str(root),
        "book_count": len(rows),
        "tier_counts": {tier: len(values) for tier, values in tiers.items()},
        "tiers": tiers,
        "thresholds": {
            "max_samples": max_samples,
            "direct_fallback_threshold": direct_fallback_threshold,
            "caution_fallback_threshold": caution_fallback_threshold,
            "direct_core_threshold": direct_core_threshold,
            "partial_core_threshold": partial_core_threshold,
        },
        "books": rows,
    }


def classify_book(
    book_dir: Path,
    *,
    max_samples: int,
    direct_fallback_threshold: float,
    caution_fallback_threshold: float,
    direct_core_threshold: float,
    partial_core_threshold: float,
) -> dict[str, Any]:
    plots = sorted(book_dir.glob("plot*.json"), key=_plot_num)
    counts = _window_status_counts(book_dir / "window_results.json")
    total_windows = sum(counts.values())
    fallback = counts.get("fallback", 0)
    api = counts.get("api", 0)
    fallback_ratio = fallback / total_windows if total_windows else None
    samples = _sample_plot_files(plots, max_samples=max_samples)
    field_hits = {field: 0 for field in [*CORE_FIELDS, *OPTIONAL_FIELDS]}
    core_complete = 0
    any_core = 0
    parsed = 0
    parse_errors = 0
    qualities: list[float] = []
    for path in samples:
        try:
            payload = load_json(path)
        except Exception:
            parse_errors += 1
            continue
        if not isinstance(payload, dict):
            parse_errors += 1
            continue
        parsed += 1
        core_hits = 0
        for field in [*CORE_FIELDS, *OPTIONAL_FIELDS]:
            if _nonempty(payload.get(field)):
                field_hits[field] += 1
                if field in CORE_FIELDS:
                    core_hits += 1
        if core_hits == len(CORE_FIELDS):
            core_complete += 1
        if core_hits:
            any_core += 1
        quality = payload.get("summary_coverage_quality")
        if isinstance(quality, (int, float)):
            qualities.append(float(quality))

    core_sample_ratio = core_complete / parsed if parsed else 0.0
    any_core_ratio = any_core / parsed if parsed else 0.0
    index_ok = (book_dir / "index.json").exists()
    done_ok = (book_dir / ".infermodel.done").exists()
    if not plots or not index_ok or not total_windows:
        tier = "bad_missing"
        reason = "missing_plots_or_index_or_window_results"
    elif core_sample_ratio >= direct_core_threshold and fallback_ratio is not None and fallback_ratio <= direct_fallback_threshold:
        tier = "direct"
        reason = "schema_complete_low_fallback"
    elif core_sample_ratio >= direct_core_threshold and fallback_ratio is not None and fallback_ratio <= caution_fallback_threshold:
        tier = "usable_caution"
        reason = "schema_complete_moderate_fallback"
    elif any_core_ratio >= partial_core_threshold and fallback_ratio is not None and fallback_ratio <= caution_fallback_threshold:
        tier = "partial_caution"
        reason = "partial_schema_low_fallback"
    else:
        tier = "skip_now"
        reason = "sparse_schema_or_high_fallback"

    return {
        "book_slug": book_dir.name,
        "book_dir": str(book_dir),
        "tier": tier,
        "reason": reason,
        "plot_count": len(plots),
        "index_exists": index_ok,
        "infermodel_done": done_ok,
        "window_count": total_windows,
        "api_window_count": api,
        "fallback_window_count": fallback,
        "fallback_ratio": round(fallback_ratio, 4) if fallback_ratio is not None else None,
        "sample_count": parsed,
        "sample_parse_errors": parse_errors,
        "core_sample_ratio": round(core_sample_ratio, 4),
        "any_core_ratio": round(any_core_ratio, 4),
        "field_hits": field_hits,
        "avg_summary_coverage_quality": round(sum(qualities) / len(qualities), 4) if qualities else None,
    }


def _discover_books(root: Path) -> list[Path]:
    book_re = re.compile(r"^id\d{6}$")
    if root.is_dir() and book_re.match(root.name):
        return [root]
    if not root.exists():
        raise FileNotFoundError(f"Input path does not exist: {root}")
    return sorted(path for path in root.iterdir() if path.is_dir() and book_re.match(path.name))


def _window_status_counts(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    try:
        payload = load_json(path)
    except Exception:
        return {}
    rows = payload.get("window_results") if isinstance(payload, dict) else payload if isinstance(payload, list) else []
    counts: dict[str, int] = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        status = as_text(row.get("analysis_status") or row.get("status")) or "unknown"
        counts[status] = counts.get(status, 0) + 1
    return counts


def _sample_plot_files(paths: list[Path], *, max_samples: int) -> list[Path]:
    if not paths or max_samples <= 0:
        return []
    if len(paths) <= max_samples:
        return paths
    indexes = sorted({round(i * (len(paths) - 1) / (max_samples - 1)) for i in range(max_samples)})
    return [paths[index] for index in indexes]


def _plot_num(path: Path) -> int:
    match = re.search(r"(\d+)$", path.stem)
    return int(match.group(1)) if match else 0


def _nonempty(value: object) -> bool:
    if isinstance(value, (list, dict)):
        return bool(value)
    return bool(as_text(value))


def _tiers() -> tuple[str, ...]:
    return ("direct", "usable_caution", "partial_caution", "skip_now", "bad_missing")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = classify_books(
        args.input,
        max_samples=args.max_samples,
        direct_fallback_threshold=args.direct_fallback_threshold,
        caution_fallback_threshold=args.caution_fallback_threshold,
        direct_core_threshold=args.direct_core_threshold,
        partial_core_threshold=args.partial_core_threshold,
    )
    if args.report:
        path = Path(args.report)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialize_payload(report, pretty=True), encoding="utf-8")
    print(
        "abstractmodel preflight: "
        + " ".join(f"{tier}={report['tier_counts'].get(tier, 0)}" for tier in _tiers())
        + f" total={report['book_count']}"
    )
    for tier in ("direct", "usable_caution", "partial_caution"):
        values = report["tiers"].get(tier, [])
        print(f"{tier}: {','.join(values)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
