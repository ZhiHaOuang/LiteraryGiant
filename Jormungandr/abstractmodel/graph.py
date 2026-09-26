from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from shared import as_list, as_mapping, as_text, canonical_book_slug, dedupe_items

from .schemas import GRAPH_SCHEMA_VERSION, PlotSignature, field_texts, list_of_dicts


def _hash_id(prefix: str, text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


def _add_node(nodes: dict[str, dict[str, Any]], node_id: str, node_type: str, label: str, **attrs: Any) -> None:
    if node_id in nodes:
        return
    nodes[node_id] = {
        "node_id": node_id,
        "node_type": node_type,
        "label": label,
        **{key: value for key, value in attrs.items() if value not in ("", [], {}, None)},
    }


def _edge(edge_type: str, source: str, target: str, **attrs: Any) -> dict[str, Any]:
    return {
        "edge_type": edge_type,
        "source": source,
        "target": target,
        **{key: value for key, value in attrs.items() if value not in ("", [], {}, None)},
    }


def build_book_logic_graph(
    *,
    book_metadata: dict[str, Any],
    book_dir: str,
    plot_items: list[dict[str, Any]],
    signatures: list[PlotSignature],
) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    book_slug = (
        signatures[0].book_slug
        if signatures
        else canonical_book_slug(as_text(book_metadata.get("book_id")) or book_dir)
    )
    book_id = book_slug
    graph_id = f"{book_slug}__narrative_graph"
    _add_node(
        nodes,
        f"book:{book_slug}",
        "book",
        as_text(book_metadata.get("title")) or book_slug,
        book_id=book_id,
        book_slug=book_slug,
    )

    previous_plot_node = ""
    unresolved_question_nodes: dict[str, str] = {}
    for item, signature in zip(plot_items, signatures, strict=True):
        plot = item["payload"]
        plot_node = f"plot:{signature.plot_id}"
        _add_node(
            nodes,
            plot_node,
            "plot",
            signature.plot_id,
            plot_index=signature.plot_index,
            start_order=signature.start_order,
            end_order=signature.end_order,
            chapter_orders=signature.chapter_orders,
            plot_function=signature.plot_function,
            driving_force=signature.driving_force,
        )
        edges.append(_edge("contains_plot", f"book:{book_slug}", plot_node))
        if previous_plot_node:
            edges.append(_edge("next", previous_plot_node, plot_node))
        previous_plot_node = plot_node

        for event in list_of_dicts(plot.get("key_events")):
            event_text = as_text(event.get("event"))
            if not event_text:
                continue
            event_order = as_text(event.get("event_order")) or as_text(event.get("chapter_order"))
            event_node = _hash_id("event", f"{book_slug}:{signature.plot_id}:{event_order}:{event_text}")
            _add_node(
                nodes,
                event_node,
                "event",
                event_text,
                event_order=event_order,
                event_function=as_text(event.get("event_function")),
                chapter_order=event.get("chapter_order"),
            )
            edges.append(_edge("contains_event", plot_node, event_node))

        character_names = field_texts(list_of_dicts(plot.get("characters_involved")), "name")
        for change in list_of_dicts(plot.get("relationship_changes")):
            character_names.extend(as_list(change.get("characters")))
        for name in dedupe_items(character_names):
            character_node = _hash_id("character", f"{book_slug}:{name}")
            _add_node(nodes, character_node, "character", name)
            edges.append(_edge("involves_character", plot_node, character_node))

        for change in list_of_dicts(plot.get("relationship_changes")):
            characters = as_list(change.get("characters"))
            label = " / ".join(characters) or as_text(change.get("change_type")) or "relationship_change"
            relationship_node = _hash_id(
                "relationship",
                f"{book_slug}:{signature.plot_id}:{label}:{as_text(change.get('after'))}",
            )
            _add_node(
                nodes,
                relationship_node,
                "relationship_change",
                label,
                characters=characters,
                before=as_text(change.get("before")),
                after=as_text(change.get("after")),
                change_type=as_text(change.get("change_type")),
                cause=as_text(change.get("cause")),
            )
            edges.append(_edge("changes_relationship", plot_node, relationship_node))

        setup = as_mapping(plot.get("setup_and_resolution"))
        initial_question = as_text(setup.get("initial_question"))
        for question in [initial_question, *as_list(setup.get("new_questions_created")), *as_list(setup.get("unresolved_questions"))]:
            if not question:
                continue
            question_node = _hash_id("question", f"{book_slug}:{question}")
            _add_node(nodes, question_node, "question", question)
            unresolved_question_nodes.setdefault(question, question_node)
            edges.append(_edge("raises_question", plot_node, question_node))
        for question in as_list(setup.get("resolved_questions")):
            if not question:
                continue
            question_node = unresolved_question_nodes.get(question) or _hash_id("question", f"{book_slug}:{question}")
            _add_node(nodes, question_node, "question", question)
            edges.append(_edge("resolves_question", plot_node, question_node))

        payoff = as_mapping(plot.get("payoff_and_hook"))
        for hook in [*as_list(payoff.get("suspense_hooks")), as_text(payoff.get("ending_hook"))]:
            if not hook:
                continue
            hook_node = _hash_id("hook", f"{book_slug}:{signature.plot_id}:{hook}")
            _add_node(nodes, hook_node, "hook", hook)
            edges.append(_edge("creates_hook", plot_node, hook_node))
        for payoff_text in as_list(payoff.get("reader_payoffs")):
            payoff_node = _hash_id("payoff", f"{book_slug}:{signature.plot_id}:{payoff_text}")
            _add_node(nodes, payoff_node, "payoff", payoff_text)
            edges.append(_edge("delivers_payoff", plot_node, payoff_node))

    return {
        "schema_version": GRAPH_SCHEMA_VERSION,
        "graph_id": graph_id,
        "book_metadata": dict(book_metadata),
        "source_ref": {
            "book_id": book_id,
            "book_slug": book_slug,
            "bridge_plot_dir": book_dir,
            "plot_count": len(signatures),
        },
        "nodes": list(nodes.values()),
        "edges": edges,
        "stats": {
            "plot_count": len(signatures),
            "node_count": len(nodes),
            "edge_count": len(edges),
            "question_count": sum(1 for node in nodes.values() if node["node_type"] == "question"),
            "event_count": sum(1 for node in nodes.values() if node["node_type"] == "event"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "construction_note": (
            "BookNarrativeGraph v1: plot order, contained events, characters, "
            "questions, hooks, payoffs, and relationship changes. It is an index "
            "graph, not a final foreshadow/setup-payoff logic graph."
        ),
    }
