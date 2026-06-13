from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from Jormungandr.softmodel.pipeline import DEFAULT_CHAPTER_BATCH_SIZE
from Jormungandr.softmodel.nuextract_extractor import NuExtractExtractor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark softmodel NuExtract vLLM extraction on cleaned chapters.",
    )
    parser.add_argument(
        "book_dir",
        help="Book directory under cleaned_chapters, e.g. Library/reference/facts/cleaned_chapters/book_0003",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="How many chapters to benchmark from the manifest. Default: 5.",
    )
    parser.add_argument(
        "--start-order",
        type=int,
        default=1,
        help="First chapter order to include. Default: 1.",
    )
    parser.add_argument(
        "--max-input-chars",
        type=int,
        default=6000,
        help="Maximum input characters passed to NuExtract.",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=768,
        help="Maximum new tokens for the main extraction pass.",
    )
    parser.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=0.85,
        help="vLLM GPU memory utilization.",
    )
    parser.add_argument(
        "--max-model-len",
        type=int,
        default=8192,
        help="vLLM max_model_len.",
    )
    parser.add_argument(
        "--enforce-eager",
        action="store_true",
        help="Enable vLLM eager mode.",
    )
    parser.add_argument(
        "--chapter-batch-size",
        type=int,
        default=DEFAULT_CHAPTER_BATCH_SIZE,
        help=f"How many chapters to batch together for extraction. Default: {DEFAULT_CHAPTER_BATCH_SIZE}.",
    )
    return parser


def load_manifest(book_dir: Path) -> list[dict]:
    index_payload = json.loads((book_dir / "index.json").read_text(encoding="utf-8"))
    manifest = index_payload.get("chapter_manifest") or []
    if not isinstance(manifest, list):
        raise ValueError(f"Invalid chapter_manifest in {book_dir / 'index.json'}")
    return manifest


def load_chapter(book_dir: Path, file_name: str) -> dict:
    return json.loads((book_dir / file_name).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    book_dir = Path(args.book_dir)
    manifest = [
        item for item in load_manifest(book_dir)
        if int(item.get("order") or 0) >= args.start_order
    ][: max(1, args.limit)]
    if not manifest:
        raise SystemExit("No chapters matched the requested range.")

    extractor = NuExtractExtractor(
        model_name="NuExtract_8B",
        model_variant="8b",
        inference_backend="vllm",
        max_input_chars=args.max_input_chars,
        max_new_tokens=args.max_new_tokens,
        vllm_tensor_parallel_size=1,
        vllm_gpu_memory_utilization=args.gpu_memory_utilization,
        vllm_max_model_len=args.max_model_len,
        vllm_enforce_eager=args.enforce_eager,
    )

    rows: list[dict] = []
    bench_start = time.perf_counter()
    batch_size = max(1, args.chapter_batch_size)
    for start in range(0, len(manifest), batch_size):
        batch_items = manifest[start:start + batch_size]
        batch_payloads = [load_chapter(book_dir, str(item["file_name"])) for item in batch_items]
        batch_inputs = [
            {
                "title": str(chapter.get("clean_title") or chapter.get("raw_title") or ""),
                "content": str(chapter.get("content") or ""),
            }
            for chapter in batch_payloads
        ]
        chapter_start = time.perf_counter()
        if len(batch_inputs) == 1:
            batch_features = [extractor.extract(**batch_inputs[0])]
        else:
            batch_features = extractor.extract_batch(batch_inputs)
        elapsed = time.perf_counter() - chapter_start
        batch_elapsed = elapsed / max(1, len(batch_items))
        for item, chapter, features in zip(batch_items, batch_payloads, batch_features, strict=True):
            content = str(chapter.get("content") or "")
            rows.append(
                {
                    "order": int(item.get("order") or 0),
                    "file_name": str(item["file_name"]),
                    "chars": len(content),
                    "seconds": batch_elapsed,
                    "batch_elapsed_seconds": elapsed,
                    "summary_len": len(features.summary),
                    "detail_points": len(features.detailed_summary),
                }
            )
    total_elapsed = time.perf_counter() - bench_start

    durations = [row["seconds"] for row in rows]
    chars = [row["chars"] for row in rows]
    total_chars = sum(chars)
    avg_seconds = statistics.mean(durations)
    median_seconds = statistics.median(durations)
    warm_durations = durations[1:] if len(durations) > 1 else durations
    warm_avg_seconds = statistics.mean(warm_durations)

    report = {
        "book_dir": str(book_dir),
        "chapter_count": len(rows),
        "total_elapsed_seconds": round(total_elapsed, 3),
        "total_chars": total_chars,
        "avg_seconds_per_chapter": round(avg_seconds, 3),
        "median_seconds_per_chapter": round(median_seconds, 3),
        "first_chapter_seconds": round(durations[0], 3),
        "warm_avg_seconds_per_chapter": round(warm_avg_seconds, 3),
        "avg_chars_per_chapter": round(statistics.mean(chars), 1),
        "chars_per_second_overall": round(total_chars / total_elapsed, 1) if total_elapsed else 0.0,
        "enforce_eager": args.enforce_eager,
        "chapter_batch_size": batch_size,
        "rows": rows,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
