from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from shared import as_text, canonical_book_slug

from .book_aggregator import build_book_level_reference
from .extractor import PlotLevelExtractor
from .graph import build_book_logic_graph
from .quality import apply_quality_gate, build_quality_report, is_candidate_tier, split_by_quality
from .schemas import (
    BOOK_LOGIC_GRAPH,
    PLOT_LEVEL_LIBRARIES,
    PlotSignature,
    SCHEMA_VERSION,
)
from .template_registry import TemplateRegistry
from .validator import validate_processed_book


class AbstractModelPipeline:
    def __init__(
        self,
        *,
        plot_extractor: PlotLevelExtractor | None = None,
        template_registry: TemplateRegistry | None = None,
    ) -> None:
        self.template_registry = template_registry or TemplateRegistry()
        self.plot_extractor = plot_extractor or PlotLevelExtractor(template_registry=self.template_registry)

    def process_book(self, plot_book: dict[str, Any]) -> dict[str, Any]:
        book_metadata = plot_book.get("book_metadata") or {}
        book_slug = canonical_book_slug(as_text(book_metadata.get("book_id")))
        book_id = book_slug
        plot_items = plot_book.get("plots") or []
        signatures: list[PlotSignature] = []
        objects_by_library: dict[str, list[dict[str, Any]]] = defaultdict(list)
        raw_objects_by_library: dict[str, list[dict[str, Any]]] = defaultdict(list)
        plot_results: list[dict[str, Any]] = []

        for fallback_index, item in enumerate(plot_items, start=1):
            plot = item.get("payload") or {}
            source_file = as_text(item.get("source_file"))
            signature = PlotSignature.from_plot(
                plot,
                book_metadata=book_metadata,
                fallback_index=fallback_index,
            )
            signatures.append(signature)
            extracted = self.plot_extractor.extract(plot, signature, source_file=source_file)
            generated_objects: list[dict[str, str]] = []
            raw_generated_objects: list[dict[str, str]] = []
            rejected_objects: list[dict[str, str]] = []
            for library, objects in extracted.items():
                gated_objects = [apply_quality_gate(item) for item in objects]
                raw_objects_by_library[library].extend(gated_objects)
                accepted_objects = [item for item in gated_objects if is_candidate_tier(item)]
                objects_by_library[library].extend(accepted_objects)
                raw_generated_objects.extend(
                    {
                        "library": library,
                        "object_id": item["object_id"],
                        "quality_tier": item.get("quality_tier", ""),
                    }
                    for item in gated_objects
                )
                generated_objects.extend(
                    {
                        "library": library,
                        "object_id": item["object_id"],
                        "quality_tier": item.get("quality_tier", ""),
                    }
                    for item in accepted_objects
                )
                rejected_objects.extend(
                    {
                        "library": library,
                        "object_id": item["object_id"],
                        "quality_tier": item.get("quality_tier", ""),
                    }
                    for item in gated_objects
                    if item.get("quality_tier") == "rejected"
                )
            generated_libraries = {item["library"] for item in generated_objects}
            skipped_libraries = [
                library for library in PLOT_LEVEL_LIBRARIES
                if library not in generated_libraries
            ]
            plot_results.append(
                {
                    "plot_id": signature.plot_id,
                    "plot_index": signature.plot_index,
                    "source_ref": signature.source_ref(),
                    "routing_targets": list(signature.routing_targets),
                    "generated_objects": generated_objects,
                    "raw_generated_objects": raw_generated_objects,
                    "rejected_objects": rejected_objects,
                    "skipped_libraries": skipped_libraries,
                    "book_graph_node_created": True,
                    "book_logic_signal": signature.has_book_logic_signal,
                    "reason": "" if generated_objects else (
                        "all_candidates_below_quality_gate"
                        if raw_generated_objects
                        else (signature.low_abstraction_reason or "no_candidate_object")
                    ),
                }
            )

        book_graph = build_book_logic_graph(
            book_metadata=book_metadata,
            book_dir=plot_book.get("book_dir", ""),
            plot_items=plot_items,
            signatures=signatures,
        )
        graph_object = {
            "schema_version": "abstract_object.v1",
            "library": BOOK_LOGIC_GRAPH,
            "object_id": book_graph["graph_id"],
            "object_type": "book_narrative_graph",
            "source_ref": book_graph["source_ref"],
            "payload": {
                "graph_path_hint": f"BookLogicGraph/{book_slug}.graph.json",
                "node_count": book_graph["stats"]["node_count"],
                "edge_count": book_graph["stats"]["edge_count"],
                "plot_count": book_graph["stats"]["plot_count"],
                "construction_note": book_graph["construction_note"],
            },
            "confidence": 1.0,
        }
        objects_by_library[BOOK_LOGIC_GRAPH].append(graph_object)
        quality_layers = split_by_quality(dict(raw_objects_by_library))

        processed_book = {
            "schema_version": SCHEMA_VERSION,
            "book_id": book_id,
            "book_slug": book_slug,
            "book_metadata": book_metadata,
            "source_plot_dir": plot_book.get("book_dir", ""),
            "source_index": plot_book.get("index", {}),
            "signatures": [signature.to_dict() for signature in signatures],
            "plot_results": plot_results,
            "objects_by_library": dict(objects_by_library),
            "raw_objects_by_library": dict(raw_objects_by_library),
            "quality_layers": quality_layers,
            "book_graph": book_graph,
            "template_registry": self.template_registry.to_dict(),
            "abstractmodel_config": {
                "stage": "abstractmodel",
                "schema_profile": "abstractmodel.v2_candidate_factory",
                "strategy": (
                    "deterministic plot-level raw candidates + quality gate + "
                    "book-level aggregation + narrative graph"
                ),
                "quality_gate": {
                    "tiers": ["raw", "candidate", "local_pattern_seed", "rejected"],
                    "llm_review_band": [0.55, 0.75],
                    "llm_review_mode": "planned_structured_review_not_invoked_by_default",
                },
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
        }
        processed_book["book_level_reference"] = build_book_level_reference(processed_book)
        processed_book["quality_report"] = build_quality_report(processed_book)
        processed_book["validation"] = validate_processed_book(processed_book, strict=True)
        return processed_book
