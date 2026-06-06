from __future__ import annotations

import random
from typing import Any

from .generator import (
    DEFAULT_CRITIC_MODEL,
    DEFAULT_GENERATOR_MODEL,
    PlotChapterCritic,
    PlotChapterGenerator,
    build_generation_metadata,
)
from .schemas import GenerationCritique, SeedPlot


class GenerateModelPipeline:
    def __init__(
        self,
        *,
        generator: PlotChapterGenerator | None = None,
        critic: PlotChapterCritic | None = None,
        seed_plot_count: int = 3,
        max_revision_rounds: int = 2,
        target_chapter_count: int | None = None,
        min_target_chapters: int = 4,
        max_target_chapters: int = 12,
        random_seed: int | None = None,
    ) -> None:
        self.generator = generator or PlotChapterGenerator(model_name=DEFAULT_GENERATOR_MODEL)
        self.critic = critic or PlotChapterCritic(model_name=DEFAULT_CRITIC_MODEL)
        self.seed_plot_count = max(1, int(seed_plot_count))
        self.max_revision_rounds = max(1, int(max_revision_rounds))
        self.target_chapter_count = target_chapter_count
        self.min_target_chapters = max(3, int(min_target_chapters))
        self.max_target_chapters = max(self.min_target_chapters, int(max_target_chapters))
        self.random_seed = random_seed

    def process_library(self, library_bundle: dict[str, Any]) -> dict[str, Any]:
        source_book_id = str((library_bundle.get("book_metadata") or {}).get("book_id") or "generated_source")
        target_book_id = str(library_bundle.get("target_book_id") or f"{source_book_id}_generated")
        runtime_seed = library_bundle.get("runtime_seed", self.random_seed)
        generation_index = int(library_bundle.get("generation_index") or 1)
        generation_count = int(library_bundle.get("generation_count") or 1)
        rng = random.Random(runtime_seed if runtime_seed is not None else None)
        seed_plots = self._sample_seed_plots(library_bundle, rng=rng)
        target_chapter_count = self._resolve_target_chapter_count(seed_plots, rng=rng)

        critiques: list[GenerationCritique] = []
        candidate = self.generator.generate_candidate(
            seed_plots=seed_plots,
            target_book_id=target_book_id,
            target_chapter_count=target_chapter_count,
            rng=rng,
        )
        critique = self.critic.critique(seed_plots=seed_plots, candidate=candidate)
        critiques.append(critique)

        for _ in range(1, self.max_revision_rounds):
            if critique.approved:
                break
            candidate = self.generator.generate_candidate(
                seed_plots=seed_plots,
                target_book_id=target_book_id,
                target_chapter_count=len(candidate.get("chapters") or []) or target_chapter_count,
                critique=critique,
                current_candidate=candidate,
                rng=rng,
            )
            critique = self.critic.critique(seed_plots=seed_plots, candidate=candidate)
            critiques.append(critique)

        plot_payload = dict(candidate["plot"])
        plot_payload["confidence"] = critique.score
        if plot_payload.get("summary_coverage_quality") is None:
            plot_payload["summary_coverage_quality"] = critique.score
        if plot_payload.get("boundary_quality") is None:
            plot_payload["boundary_quality"] = max(0.5, critique.score - 0.08)

        metadata = build_generation_metadata(
            generator_model=self.generator,
            critic_model=self.critic,
            seed_plots=seed_plots,
            critique_rounds=critiques,
        )

        chapter_payloads = []
        for chapter in candidate["chapters"]:
            chapter = dict(chapter)
            chapter["extractor_metadata"] = dict(metadata)
            chapter_payloads.append(chapter)

        chapter_manifest = [
            {
                "order": chapter["chapter_context"]["order"],
                "chapter_id": chapter["chapter_context"]["chapter_id"],
                "clean_title": chapter["chapter_context"]["clean_title"],
                "file_name": f"{int(chapter['chapter_context']['order']):04d}.json",
            }
            for chapter in chapter_payloads
        ]
        plot_manifest = [
            {
                "plot_id": plot_payload["plot_id"],
                "plot_index": plot_payload["plot_index"],
                "start_order": plot_payload["start_order"],
                "end_order": plot_payload["end_order"],
                "chapter_count": len(plot_payload["chapter_ids"]),
                "boundary_quality": plot_payload["boundary_quality"],
                "summary_coverage_quality": plot_payload["summary_coverage_quality"],
                "chapter_ids": plot_payload["chapter_ids"],
                "chapter_titles": plot_payload["chapter_titles"],
                "file_name": f"{plot_payload['plot_id']}.json",
            }
        ]

        return {
            "book_metadata": {
                "book_id": target_book_id,
                "source_book_id": source_book_id,
                "chapter_count": len(chapter_payloads),
                "plot_count": 1,
                "synthetic_generation": True,
                "generation_index": generation_index,
                "generation_count": generation_count,
            },
            "source_feature_dir": library_bundle.get("source_feature_dir", ""),
            "source_cluster_dir": library_bundle.get("source_cluster_dir", ""),
            "chapter_manifest": chapter_manifest,
            "plot_manifest": plot_manifest,
            "chapters": chapter_payloads,
            "plots": [plot_payload],
            "generation_config": {
                "generator_model": self.generator.model_name,
                "generator_model_source": self.generator.resolved_model_source or self.generator.model_name,
                "generator_model_available": self.generator.model_available,
                "generator_weights_root": self.generator.weights_root,
                "generator_runtime": self.generator.runtime_placement.to_dict(),
                "generator_family_dirs": self.generator.family_dirs,
                "critic_model": self.critic.model_name,
                "critic_model_source": self.critic.resolved_model_source or self.critic.model_name,
                "critic_model_available": self.critic.model_available,
                "critic_weights_root": self.critic.weights_root,
                "critic_runtime": self.critic.runtime_placement.to_dict(),
                "critic_family_dirs": self.critic.family_dirs,
                "seed_plot_count": self.seed_plot_count,
                "max_revision_rounds": self.max_revision_rounds,
                "target_chapter_count": len(chapter_payloads),
                "min_target_chapters": self.min_target_chapters,
                "max_target_chapters": self.max_target_chapters,
                "random_seed": runtime_seed,
                "generation_index": generation_index,
                "generation_count": generation_count,
                "target_chapter_count_strategy": (
                    "explicit"
                    if self.target_chapter_count is not None
                    else "max_sampled_seed_plot_chapter_count"
                ),
                "allow_fallback": self.generator.allow_fallback and self.critic.allow_fallback,
                "critique_rounds": [critique.to_dict() for critique in critiques],
            },
        }

    def _sample_seed_plots(self, library_bundle: dict[str, Any], *, rng: random.Random) -> list[SeedPlot]:
        all_plots = list(library_bundle.get("plots") or [])
        if not all_plots:
            raise ValueError("No plot library entries available for generation.")
        sample_size = min(self.seed_plot_count, len(all_plots))
        return rng.sample(all_plots, sample_size)

    def _resolve_target_chapter_count(self, seed_plots: list[SeedPlot], *, rng: random.Random) -> int:
        if self.target_chapter_count is not None:
            return max(self.min_target_chapters, min(self.max_target_chapters, int(self.target_chapter_count)))
        counts = [len(plot.chapter_ids) for plot in seed_plots if plot.chapter_ids]
        if counts:
            return max(self.min_target_chapters, max(counts))
        return rng.randint(self.min_target_chapters, self.max_target_chapters)
