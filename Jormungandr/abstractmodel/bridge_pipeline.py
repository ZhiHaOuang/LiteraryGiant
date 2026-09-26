from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shared import as_text

from .bridge_index import build_book_bridge_index, build_evidence_windows
from .bridge_llm import BridgeLLMClient, BridgeLLMResponseError
from .bridge_prompts import (
    BRIDGE_EXTRACTION_SYSTEM_PROMPT,
    RECONCILIATION_SYSTEM_PROMPT,
    extraction_prompt,
    reconciliation_prompt,
)
from .pattern_store import load_existing_patterns, shortlist_patterns, validate_reconciliation


def run_bridge_first_book(
    book_dir: str | Path,
    *,
    bridge_index_root: str | Path,
    extracted_root: str | Path,
    abstract_library_root: str | Path,
    libraries: list[str],
    client: BridgeLLMClient | None,
    mode: str,
    plots_per_window: int,
    overlap: int,
    max_windows: int,
    shortlist_size: int,
    candidate_budget: int,
    reconcile_batch_size: int,
    extraction_layout: str,
    force: bool,
    max_in_flight: int,
) -> dict[str, Any]:
    index = build_book_bridge_index(book_dir)
    book_slug = index["book_slug"]
    index_path = Path(bridge_index_root) / "books" / f"{book_slug}.jsonl"
    _write_jsonl(index_path, index["chunks"])
    stats_path = Path(bridge_index_root) / "books" / f"{book_slug}.stats.json"
    _write_json(
        stats_path,
        {key: value for key, value in index.items() if key != "chunks"},
    )
    windows = build_evidence_windows(
        index["chunks"],
        plots_per_window=plots_per_window,
        overlap=overlap,
        max_windows=max_windows,
    )
    book_root = Path(extracted_root) / book_slug
    scheduled_tasks = _scheduled_tasks(
        windows,
        libraries=libraries,
        candidate_budget=candidate_budget,
        extraction_layout=extraction_layout,
    )
    if "EmotionRhythm" in libraries:
        scheduled_tasks.append(_emotion_book_task(index["chunks"], candidate_budget=candidate_budget))
    if "Worldview" in libraries:
        scheduled_tasks.append(_worldview_book_task(index["chunks"], candidate_budget=candidate_budget))
    active_task_ids = {as_text(row.get("task_id")) for row in scheduled_tasks}
    _write_jsonl(book_root / "tasks.jsonl", sorted(scheduled_tasks, key=lambda row: as_text(row.get("task_id"))))
    existing_extractions = _read_jsonl(book_root / "extractions.jsonl")
    extraction_by_task = {
        as_text(row.get("task_id")): row for row in existing_extractions if as_text(row.get("task_id"))
    }
    reconciliations: list[dict[str, Any]] = _read_jsonl(book_root / "reconciliations.jsonl")
    usage: list[dict[str, Any]] = []
    existing = load_existing_patterns(abstract_library_root)

    if mode in {"extract", "all"}:
        if client is None:
            raise ValueError("LLM client is required for mode=extract/all")
        window_by_id = {window["window_id"]: window for window in windows}
        special_windows = {
            window["window_id"]: window
            for window in (
                _emotion_book_window(index["chunks"]),
                _worldview_window(index["chunks"]),
            )
        }
        pending_tasks: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for task in scheduled_tasks:
            task_id = task["task_id"]
            previous = extraction_by_task.get(task_id)
            if previous and previous.get("status") == "ok" and not force:
                continue
            window = special_windows.get(task["window_id"]) or window_by_id[task["window_id"]]
            pending_tasks.append((task, window))
        if max_in_flight > 1:
            with ThreadPoolExecutor(max_workers=max_in_flight) as executor:
                futures = [
                    executor.submit(
                        _extract_task,
                        task=task,
                        window=window,
                        client_config=client.config,
                        book_id=index["book_id"],
                        book_slug=book_slug,
                        candidate_budget=candidate_budget,
                    )
                    for task, window in pending_tasks
                ]
                for future in as_completed(futures):
                    task_id, row, task_usage = future.result()
                    extraction_by_task[task_id] = row
                    usage.append({"stage": "extraction", "window_id": row["window_id"], **task_usage})
                    _write_jsonl(
                        book_root / "extractions.jsonl",
                        [
                            extraction_by_task[active_id]
                            for active_id in sorted(active_task_ids)
                            if active_id in extraction_by_task
                        ],
                    )
        else:
            for task, window in pending_tasks:
                task_id, row, task_usage = _extract_task(
                    task=task,
                    window=window,
                    client_config=client.config,
                    book_id=index["book_id"],
                    book_slug=book_slug,
                    candidate_budget=candidate_budget,
                )
                extraction_by_task[task_id] = row
                usage.append({"stage": "extraction", "window_id": row["window_id"], **task_usage})
                _write_jsonl(
                    book_root / "extractions.jsonl",
                    [
                        extraction_by_task[active_id]
                        for active_id in sorted(active_task_ids)
                        if active_id in extraction_by_task
                    ],
                )

    extractions = [
        extraction_by_task[task_id]
        for task_id in sorted(active_task_ids)
        if task_id in extraction_by_task
    ]

    if mode in {"reconcile", "all"}:
        if client is None:
            raise ValueError("LLM client is required for mode=reconcile/all")
        candidate_groups = _candidate_batches(extractions, libraries=libraries, batch_size=reconcile_batch_size)
        active_reconciliation_signatures = {
            _reconciliation_signature(
                library,
                [as_text(row.get("candidate_id")) for row in candidates],
            )
            for library, _, candidates in candidate_groups
        }
        reconciliation_by_signature = {
            _reconciliation_signature(
                as_text(row.get("library")),
                [as_text(value) for value in row.get("candidate_ids") or []],
            ): row
            for row in reconciliations
            if as_text(row.get("library"))
        }
        for library, batch_index, candidates in candidate_groups:
            candidate_ids = [as_text(row.get("candidate_id")) for row in candidates]
            signature = _reconciliation_signature(library, candidate_ids)
            previous = reconciliation_by_signature.get(signature)
            if previous and previous.get("status") == "ok" and not force:
                previous_validation = previous.get("validated_response") if isinstance(previous.get("validated_response"), dict) else {}
                if previous_validation.get("schema_version") == "bridge_reconciliation_validated.v3":
                    continue
                previous = dict(previous)
                previous["validated_response"] = validate_reconciliation(
                    previous.get("parsed_response") if isinstance(previous.get("parsed_response"), dict) else {},
                    candidates=candidates,
                    existing=existing,
                )
                previous["validation_rechecked_at"] = datetime.now(timezone.utc).isoformat()
                reconciliation_by_signature[signature] = previous
                continue
            shortlist = shortlist_patterns(candidates, existing, top_k=shortlist_size)
            reconcile_id = f"{book_slug}:reconcile:{library}:{batch_index:04d}"
            parsed, raw, status, error, reconciliation_usage = _reconcile_with_subdivision(
                client=client,
                book_id=index["book_id"],
                reconcile_id=reconcile_id,
                candidates=candidates,
                shortlist=shortlist,
            )
            client.last_usage = reconciliation_usage
            validated = validate_reconciliation(parsed, candidates=candidates, existing=existing)
            row = {
                "schema_version": "bridge_llm_reconciliation.v1",
                "book_id": index["book_id"],
                "book_slug": book_slug,
                "window_id": reconcile_id,
                "library": library,
                "candidate_ids": candidate_ids,
                "provider": client.config.provider,
                "model": client.config.model,
                "usage": dict(client.last_usage),
                "status": status,
                "error": error,
                "existing_pattern_shortlist": shortlist,
                "parsed_response": parsed,
                "validated_response": validated,
                "raw_response": raw,
            }
            reconciliation_by_signature[signature] = row
            usage.append({"stage": "reconciliation", "window_id": reconcile_id, **dict(client.last_usage)})
            _write_jsonl(
                book_root / "reconciliations.jsonl",
                [
                    reconciliation_by_signature[active_signature]
                    for active_signature in sorted(active_reconciliation_signatures)
                    if active_signature in reconciliation_by_signature
                ],
            )
        reconciliations = [
            reconciliation_by_signature[signature]
            for signature in sorted(active_reconciliation_signatures)
            if signature in reconciliation_by_signature
        ]

    if extractions:
        _write_jsonl(book_root / "extractions.jsonl", extractions)
    if reconciliations:
        _write_jsonl(book_root / "reconciliations.jsonl", reconciliations)
    manifest = {
        "schema_version": "bridge_first_book_manifest.v1",
        "book_id": index["book_id"],
        "book_slug": book_slug,
        "source_book_dir": str(book_dir),
        "mode": mode,
        "libraries": libraries,
        "extraction_layout": extraction_layout,
        "plot_count": index["plot_count"],
        "window_count": len(windows),
        "scheduled_task_count": len(scheduled_tasks),
        "extraction_count": len(extractions),
        "reconciliation_count": len(reconciliations),
        "candidate_count": sum(
            len(_dict_rows((row.get("parsed_response") or {}).get("candidates"))) for row in extractions
        ),
        "decision_counts": _decision_counts(reconciliations),
        "usage": usage,
        "complete_book": (
            max_windows == 0
            and all(
                (extraction_by_task.get(task["task_id"]) or {}).get("status") == "ok"
                for task in scheduled_tasks
            )
        ),
        "bridge_index_path": str(index_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    _write_json(book_root / "manifest.json", manifest)
    return manifest


def validated_decisions(reconciliations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        decision
        for row in reconciliations
        for decision in _dict_rows((row.get("validated_response") or {}).get("decisions"))
        if isinstance(decision, dict)
    ]


def _task_brief(
    window: dict[str, Any],
    *,
    libraries: list[str],
    candidate_budget: int,
    layout: str,
) -> dict[str, Any]:
    library_key = "+".join(libraries)
    chunk_key = f"p{window['plot_range'][0]}-{window['plot_range'][1]}"
    return {
        "schema_version": "bridge_llm_task.v1",
        "task_id": f"extract:{window['window_id']}:{chunk_key}:{library_key}",
        "book_id": window["book_id"],
        "window_id": window["window_id"],
        "plot_range": window["plot_range"],
        "chunk_ids": window["chunk_ids"],
        "libraries": libraries,
        "candidate_budget_per_library": candidate_budget,
        "extraction_layout": layout,
        "evidence_location": f"BridgeIndex/books/{window['book_slug']}.jsonl",
    }


def _scheduled_tasks(
    windows: list[dict[str, Any]],
    *,
    libraries: list[str],
    candidate_budget: int,
    extraction_layout: str,
) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for window in windows:
        relevant = [library for library in libraries if library != "Worldview" and _window_relevant(window, library)]
        if extraction_layout == "joint":
            if relevant:
                tasks.append(
                    _task_brief(
                        window,
                        libraries=relevant,
                        candidate_budget=candidate_budget,
                        layout=extraction_layout,
                    )
                )
        elif extraction_layout == "paired":
            for pair in (("EventsLibrary", "PayoffAngst"), ("CharacterArc", "EmotionRhythm")):
                selected = [library for library in pair if library in relevant]
                if selected:
                    tasks.append(
                        _task_brief(
                            window,
                            libraries=selected,
                            candidate_budget=candidate_budget,
                            layout=extraction_layout,
                        )
                    )
        else:
            tasks.extend(
                _task_brief(
                    window,
                    libraries=[library],
                    candidate_budget=candidate_budget,
                    layout=extraction_layout,
                )
                for library in relevant
            )
    return tasks


def _worldview_book_task(chunks: list[dict[str, Any]], *, candidate_budget: int) -> dict[str, Any]:
    selected = _worldview_window(chunks)
    return {
        "schema_version": "bridge_llm_task.v1",
        "task_id": f"extract:{selected['window_id']}:Worldview",
        "task_kind": "worldview_book",
        "book_id": selected["book_id"],
        "window_id": selected["window_id"],
        "plot_range": selected["plot_range"],
        "chunk_ids": selected["chunk_ids"],
        "libraries": ["Worldview"],
        "candidate_budget_per_library": candidate_budget,
        "extraction_layout": "book_level",
        "evidence_location": f"BridgeIndex/books/{selected['book_slug']}.jsonl",
    }


def _emotion_book_task(chunks: list[dict[str, Any]], *, candidate_budget: int) -> dict[str, Any]:
    selected = _emotion_book_window(chunks)
    return {
        "schema_version": "bridge_llm_task.v1",
        "task_id": f"extract:{selected['window_id']}:EmotionRhythm",
        "task_kind": "emotion_book",
        "book_id": selected["book_id"],
        "window_id": selected["window_id"],
        "plot_range": selected["plot_range"],
        "chunk_ids": selected["chunk_ids"],
        "libraries": ["EmotionRhythm"],
        "candidate_budget_per_library": max(2, candidate_budget),
        "extraction_layout": "book_level",
        "evidence_location": f"BridgeIndex/books/{selected['book_slug']}.jsonl",
    }


def _emotion_book_window(chunks: list[dict[str, Any]]) -> dict[str, Any]:
    anchor_count = min(12, len(chunks))
    anchor_indexes = {
        round(position * (len(chunks) - 1) / max(1, anchor_count - 1))
        for position in range(anchor_count)
    }
    signal_terms = ("转折", "危机", "死亡", "背叛", "揭露", "释放", "高潮", "牺牲", "反转")
    scored = sorted(
        (
            (sum(term in json.dumps(chunk, ensure_ascii=False) for term in signal_terms), index)
            for index, chunk in enumerate(chunks)
        ),
        key=lambda row: (-row[0], row[1]),
    )
    selected_indexes = set(anchor_indexes)
    selected_indexes.update(index for score, index in scored[:4] if score)
    selected = [chunks[index] for index in sorted(selected_indexes)[:16]]
    return {
        "schema_version": "bridge_evidence_window.v1",
        "window_id": f"{selected[0]['book_slug']}:emotion_book",
        "book_id": selected[0]["book_id"],
        "book_slug": selected[0]["book_slug"],
        "plot_range": [selected[0]["plot_index"], selected[-1]["plot_index"]],
        "chunk_ids": [item["chunk_id"] for item in selected],
        "quality_tiers": [item["quality_tier"] for item in selected],
        "requested_rhythm_scopes": ["stage_curve", "book_curve"],
        "scope_guidance": {
            "stage_curve": "identify one reusable multi-plot emotional phase structure",
            "book_curve": "identify the whole-book pressure, release, reversal, and terminal compensation skeleton",
        },
        "evidence": selected,
    }


def _worldview_window(chunks: list[dict[str, Any]]) -> dict[str, Any]:
    stable_rule_terms = ("规则", "法则", "制度", "权限", "等级", "系统", "宗门", "门派", "契约", "修炼", "资源分配", "代价", "惩罚")
    scored: list[tuple[int, dict[str, Any]]] = []
    for chunk in chunks:
        text = json.dumps(chunk, ensure_ascii=False)
        score = sum(term in text for term in stable_rule_terms)
        if score:
            scored.append((score, chunk))
    selected = [row for _, row in sorted(scored, key=lambda pair: (-pair[0], pair[1]["plot_index"]))[:6]]
    selected.sort(key=lambda row: row["plot_index"])
    if not selected:
        selected = chunks[: min(6, len(chunks))]
    return {
        "schema_version": "bridge_evidence_window.v1",
        "window_id": f"{selected[0]['book_slug']}:worldview_book",
        "book_id": selected[0]["book_id"],
        "book_slug": selected[0]["book_slug"],
        "plot_range": [selected[0]["plot_index"], selected[-1]["plot_index"]],
        "chunk_ids": [item["chunk_id"] for item in selected],
        "quality_tiers": [item["quality_tier"] for item in selected],
        "evidence": selected,
    }


def _extract_task(
    *,
    task: dict[str, Any],
    window: dict[str, Any],
    client_config,
    book_id: str,
    book_slug: str,
    candidate_budget: int,
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    client = BridgeLLMClient(client_config)
    try:
        parsed, raw = client.generate_json(
            system_prompt=BRIDGE_EXTRACTION_SYSTEM_PROMPT,
            user_prompt=extraction_prompt(
                window,
                libraries=task["libraries"],
                candidate_budget=int(task.get("candidate_budget_per_library") or candidate_budget),
            ),
        )
        status = "ok"
        error = ""
    except BridgeLLMResponseError as exc:
        parsed, raw = {}, exc.raw_response
        status = "incomplete_json"
        error = str(exc)
        client.last_usage = exc.usage
    except Exception as exc:  # noqa: BLE001 - API failures belong in the per-window artifact.
        parsed, raw = {}, ""
        status = "error"
        error = f"{type(exc).__name__}: {exc}"
    usage = dict(client.last_usage)
    row = {
        "schema_version": "bridge_llm_extraction.v1",
        "book_id": book_id,
        "book_slug": book_slug,
        "task_id": task["task_id"],
        "window_id": window["window_id"],
        "libraries": task["libraries"],
        "plot_range": window["plot_range"],
        "provider": client.config.provider,
        "model": client.config.model,
        "usage": usage,
        "status": status,
        "error": error,
        "parsed_response": parsed,
        "raw_response": raw,
    }
    return task["task_id"], row, usage


def _reconcile_with_subdivision(
    *,
    client: BridgeLLMClient,
    book_id: str,
    reconcile_id: str,
    candidates: list[dict[str, Any]],
    shortlist: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any], str, str, str, dict[str, Any]]:
    try:
        parsed, raw = client.generate_json(
            system_prompt=RECONCILIATION_SYSTEM_PROMPT,
            user_prompt=reconciliation_prompt(
                book_id=book_id,
                window_id=reconcile_id,
                candidates=candidates,
                existing_patterns=shortlist,
            ),
        )
        return parsed, raw, "ok", "", dict(client.last_usage)
    except BridgeLLMResponseError as exc:
        if len(candidates) <= 1:
            return {}, exc.raw_response, "incomplete_json", str(exc), dict(exc.usage)
        midpoint = len(candidates) // 2
        parts = [candidates[:midpoint], candidates[midpoint:]]
        results = [
            _reconcile_with_subdivision(
                client=client,
                book_id=book_id,
                reconcile_id=f"{reconcile_id}:part{index}",
                candidates=part,
                shortlist=shortlist,
            )
            for index, part in enumerate(parts, start=1)
        ]
        parsed = {
            "book_id": book_id,
            "window_id": reconcile_id,
            "decisions": [
                decision
                for part_parsed, _, _, _, _ in results
                for decision in _dict_rows(part_parsed.get("decisions"))
            ],
        }
        statuses = [status for _, _, status, _, _ in results]
        status = "ok" if all(value == "ok" for value in statuses) else "partial"
        errors = [error for _, _, _, error, _ in results if error]
        raw = json.dumps(
            {"subresponses": [part_raw for _, part_raw, _, _, _ in results]},
            ensure_ascii=False,
        )
        return parsed, raw, status, " | ".join(errors), _merge_usage([usage for _, _, _, _, usage in results])
    except Exception as exc:  # noqa: BLE001 - API failures belong in the per-window artifact.
        return {}, "", "error", f"{type(exc).__name__}: {exc}", dict(client.last_usage)


def _merge_usage(rows: list[dict[str, Any]]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for row in rows:
        for key, value in row.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                merged[key] = merged.get(key, 0) + value
            elif key not in merged:
                merged[key] = value
    return merged


def _valid_candidates(value: object, *, libraries: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    if not isinstance(value, list):
        return rows
    for index, raw in enumerate(value, start=1):
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        library = as_text(row.get("library"))
        if library not in libraries:
            continue
        candidate_id = as_text(row.get("candidate_id")) or f"candidate_{index:03d}"
        if candidate_id in seen:
            candidate_id = f"{candidate_id}_{index:03d}"
        row["candidate_id"] = candidate_id
        seen.add(candidate_id)
        rows.append(row)
    return rows


def _candidate_batches(
    extractions: list[dict[str, Any]],
    *,
    libraries: list[str],
    batch_size: int,
) -> list[tuple[str, int, list[dict[str, Any]]]]:
    by_library = {library: [] for library in libraries}
    for extraction in extractions:
        parsed = extraction.get("parsed_response") if isinstance(extraction.get("parsed_response"), dict) else {}
        window_id = as_text(extraction.get("window_id"))
        for row in _valid_candidates(parsed.get("candidates"), libraries=libraries):
            row = dict(row)
            local_id = as_text(row.get("candidate_id"))
            row["candidate_id"] = f"{window_id}:{local_id}"
            by_library[row["library"]].append(row)
    batches: list[tuple[str, int, list[dict[str, Any]]]] = []
    for library, rows in by_library.items():
        for start in range(0, len(rows), max(1, batch_size)):
            batches.append((library, start // max(1, batch_size) + 1, rows[start:start + max(1, batch_size)]))
    return batches


def _reconciliation_signature(library: str, candidate_ids: list[str]) -> str:
    return f"{library}|{'|'.join(candidate_ids)}"


def _window_relevant(window: dict[str, Any], library: str) -> bool:
    evidence = window.get("evidence") if isinstance(window.get("evidence"), list) else []
    if library == "EventsLibrary":
        return any(item.get("key_events") or item.get("conflict") for item in evidence if isinstance(item, dict))
    if library == "PayoffAngst":
        return any(item.get("payoff_and_hook") for item in evidence if isinstance(item, dict))
    if library == "CharacterArc":
        return any(item.get("characters") or item.get("relationship_changes") for item in evidence if isinstance(item, dict))
    if library == "EmotionRhythm":
        return any(item.get("conflict") or item.get("payoff_and_hook") for item in evidence if isinstance(item, dict))
    if library == "Worldview":
        stable_rule_terms = ("规则", "法则", "制度", "权限", "等级", "系统", "宗门", "门派", "契约", "修炼", "资源分配", "代价机制")
        text = json.dumps(evidence, ensure_ascii=False)
        return sum(term in text for term in stable_rule_terms) >= 2
    return False


def _decision_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        for decision in _dict_rows((row.get("validated_response") or {}).get("decisions")):
            key = as_text(decision.get("decision")) or "unknown"
            counts[key] = counts.get(key, 0) + 1
    return counts


def _dict_rows(value: object) -> list[dict[str, Any]]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    text = "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows)
    temp.write_text(text + ("\n" if text else ""), encoding="utf-8")
    temp.replace(path)
