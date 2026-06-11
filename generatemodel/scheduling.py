from __future__ import annotations

import argparse
from pathlib import Path

from shared import (
    FACT_CHAPTER_FEATURES_ROOT,
    FACT_PLOT_SEGMENTS_ROOT,
    PROJECTS_ROOT,
    detect_default_weights_root,
)

from .generator import (
    CRITIC_MODEL_VARIANTS,
    DEFAULT_CRITIC_MODEL,
    DEFAULT_GENERATOR_MODEL,
    GENERATOR_MODEL_VARIANTS,
    PlotChapterCritic,
    PlotChapterGenerator,
)
from .pipeline import GenerateModelPipeline
from .processor import discover_cluster_books, process_and_write_cluster_book_dir_multiple


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="generatemodel-run",
        description="Generate new plot/chapter JSON files from existing plot and chapter libraries with generator-critic refinement.",
    )
    parser.add_argument(
        "input",
        help=f"Input {FACT_PLOT_SEGMENTS_ROOT} root or one cluster book directory.",
    )
    parser.add_argument(
        "--feature-root",
        default=None,
        help=(
            f"Optional {FACT_CHAPTER_FEATURES_ROOT} root. Used when plot index.json "
            "does not contain a valid source_feature_dir."
        ),
    )
    parser.add_argument(
        "--weights-root",
        default=str(detect_default_weights_root()),
        help="Local weights root directory. Defaults to ./models/weights when populated, with legacy fallback.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help=f"Output root directory. Defaults to {PROJECTS_ROOT / '_generated'}.",
    )
    parser.add_argument(
        "--target-book-id",
        default=None,
        help="Optional generated book id. Defaults to <source_book_id>_generated.",
    )
    parser.add_argument(
        "--generator-model",
        default=DEFAULT_GENERATOR_MODEL,
        help="Local generator model directory name or explicit path. Default: Qwen_14B.",
    )
    parser.add_argument(
        "--generator-family-dirs",
        default="Qwen,qwen,QWEN",
        help="Comma-separated subdirectories searched under weights root for the generator model.",
    )
    parser.add_argument(
        "--generator-size",
        choices=sorted(GENERATOR_MODEL_VARIANTS.keys()),
        default=None,
        help="Generator model size alias loaded from models/weights, such as 8b, 14b, or 32b.",
    )
    parser.add_argument(
        "--critic-model",
        default=DEFAULT_CRITIC_MODEL,
        help="Local critic model directory name or explicit path. Default: DeepSeek_14B.",
    )
    parser.add_argument(
        "--critic-family-dirs",
        default="DeepSeek,deepseek,DEEPSEEK",
        help="Comma-separated subdirectories searched under weights root for the critic model.",
    )
    parser.add_argument(
        "--critic-size",
        choices=sorted(CRITIC_MODEL_VARIANTS.keys()),
        default=None,
        help="Critic model size alias loaded from models/weights, such as 8b, 14b, or 32b.",
    )
    parser.add_argument(
        "--seed-plot-count",
        type=int,
        default=3,
        help="Number of plots randomly sampled from the plot library as generation skeleton.",
    )
    parser.add_argument(
        "--generation-count",
        type=int,
        default=1,
        help="How many independent generated outputs to create for each input cluster book.",
    )
    parser.add_argument(
        "--target-chapter-count",
        type=int,
        default=None,
        help="Optional fixed number of generated chapters. By default it uses the longest plot chapter count among the sampled seed plots.",
    )
    parser.add_argument(
        "--min-target-chapters",
        type=int,
        default=4,
        help="Minimum number of generated chapters.",
    )
    parser.add_argument(
        "--max-target-chapters",
        type=int,
        default=12,
        help="Maximum number of generated chapters.",
    )
    parser.add_argument(
        "--max-revision-rounds",
        type=int,
        default=2,
        help="Maximum generator-critic refinement rounds.",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=2200,
        help="Maximum new tokens for both generator and critic models.",
    )
    parser.add_argument(
        "--device-map",
        default="auto",
        help="Transformers device_map passed to model loading.",
    )
    parser.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=0.9,
        help="Fraction of each visible GPU memory reserved for automatic weight placement.",
    )
    parser.add_argument(
        "--per-gpu-memory-gb",
        type=int,
        default=None,
        help="Optional manual per-GPU memory size in GiB used to build max_memory instead of probing via torch.",
    )
    parser.add_argument(
        "--random-seed",
        type=int,
        default=None,
        help="Optional random seed for plot sampling and fallback generation.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write compact JSON instead of pretty JSON.",
    )
    parser.add_argument(
        "--allow-fallback",
        dest="allow_fallback",
        action="store_true",
        default=True,
        help="Allow rule-based fallback generation when local models are missing or generation fails. Enabled by default.",
    )
    parser.add_argument(
        "--strict-local-models",
        dest="allow_fallback",
        action="store_false",
        help="Require both local models to load and run successfully; fail instead of falling back.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    resolved_generator_model = GENERATOR_MODEL_VARIANTS.get(args.generator_size, args.generator_model)
    resolved_critic_model = CRITIC_MODEL_VARIANTS.get(args.critic_size, args.critic_model)
    generator_family_dirs = [item.strip() for item in str(args.generator_family_dirs).split(",") if item.strip()]
    critic_family_dirs = [item.strip() for item in str(args.critic_family_dirs).split(",") if item.strip()]

    generator = PlotChapterGenerator(
        model_name=resolved_generator_model,
        weights_root=args.weights_root,
        family_dirs=generator_family_dirs,
        max_new_tokens=args.max_new_tokens,
        device_map=args.device_map,
        allow_fallback=args.allow_fallback,
        gpu_memory_utilization=args.gpu_memory_utilization,
        per_gpu_memory_gb=args.per_gpu_memory_gb,
    )
    critic = PlotChapterCritic(
        model_name=resolved_critic_model,
        weights_root=args.weights_root,
        family_dirs=critic_family_dirs,
        max_new_tokens=args.max_new_tokens,
        device_map=args.device_map,
        allow_fallback=args.allow_fallback,
        gpu_memory_utilization=args.gpu_memory_utilization,
        per_gpu_memory_gb=args.per_gpu_memory_gb,
    )
    if not args.allow_fallback:
        missing: list[str] = []
        if not generator.model_available:
            missing.append(
                f"generator={generator.model_name} weights_root={generator.weights_root} resolved={generator.resolved_model_source or 'NOT_FOUND'}"
            )
        if not critic.model_available:
            missing.append(
                f"critic={critic.model_name} weights_root={critic.weights_root} resolved={critic.resolved_model_source or 'NOT_FOUND'}"
            )
        if missing:
            raise FileNotFoundError(
                "Strict local model mode requires all local model directories to exist:\n- " + "\n- ".join(missing)
            )
    pipeline = GenerateModelPipeline(
        generator=generator,
        critic=critic,
        seed_plot_count=args.seed_plot_count,
        max_revision_rounds=args.max_revision_rounds,
        target_chapter_count=args.target_chapter_count,
        min_target_chapters=args.min_target_chapters,
        max_target_chapters=args.max_target_chapters,
        random_seed=args.random_seed,
    )

    pretty = not args.compact
    books = discover_cluster_books(args.input)
    written_dirs: list[Path] = []

    for cluster_book_dir in books:
        output_dirs = process_and_write_cluster_book_dir_multiple(
            cluster_book_dir,
            pipeline=pipeline,
            generation_count=args.generation_count,
            feature_root=args.feature_root,
            output_root=args.output,
            target_book_id=args.target_book_id,
            pretty=pretty,
        )
        written_dirs.extend(output_dirs)
        for output_dir in output_dirs:
            print(f"[OK] {cluster_book_dir} -> {output_dir}")

    print(f"Finished. Wrote {len(written_dirs)} generated book folder(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
