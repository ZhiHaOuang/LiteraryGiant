from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from typing import Any

from .schemas import canonical_library_name


def _terms(value: object) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        return {value} if value else set()
    if isinstance(value, (list, tuple, set)):
        return {str(item) for item in value if str(item).strip()}
    return {str(value)} if str(value).strip() else set()


def _similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _source_key(source_ref: dict[str, Any] | None) -> str:
    if not source_ref:
        return ""
    parts = [
        str(source_ref.get("book_slug") or source_ref.get("book_id") or ""),
        str(source_ref.get("plot_id") or source_ref.get("plot_index") or ""),
        str(source_ref.get("bridge_plot_file") or ""),
    ]
    return "::".join(part for part in parts if part)


class TemplateRegistry:
    """In-run template consolidation.

    A candidate first tries to match an existing template in its own library
    namespace. If it cannot, the registry creates a new template from the
    candidate seed. This keeps template count data-driven instead of fixed.
    """

    def __init__(self, *, default_threshold: float = 0.72) -> None:
        self.default_threshold = default_threshold
        self._templates: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._counters: dict[str, int] = defaultdict(int)

    @classmethod
    def from_dict(
        cls,
        payload: dict[str, Any] | None,
        *,
        default_threshold: float = 0.72,
    ) -> "TemplateRegistry":
        registry = cls(default_threshold=default_threshold)
        if not isinstance(payload, dict):
            return registry
        for library, templates in payload.items():
            if not isinstance(templates, list):
                continue
            library_name = canonical_library_name(str(library))
            for template in templates:
                if not isinstance(template, dict):
                    continue
                copied = deepcopy(template)
                registry._templates[library_name].append(copied)
                registry._counters[library_name] = max(
                    registry._counters[library_name],
                    _template_number(copied.get("template_id")),
                )
            if registry._templates[library_name] and registry._counters[library_name] == 0:
                registry._counters[library_name] = len(registry._templates[library_name])
        return registry

    def resolve(
        self,
        library: str,
        seed: dict[str, Any],
        *,
        source_ref: dict[str, Any] | None = None,
        threshold: float | None = None,
    ) -> dict[str, Any]:
        seed_terms = _terms(seed.get("signature_terms"))
        macro = str(seed.get("macro_pattern") or "")
        best_template: dict[str, Any] | None = None
        best_similarity = 0.0
        for template in self._templates[library]:
            if macro and template.get("macro_pattern") and template.get("macro_pattern") != macro:
                continue
            score = _similarity(seed_terms, _terms(template.get("signature_terms")))
            if score > best_similarity:
                best_similarity = score
                best_template = template

        required = self.default_threshold if threshold is None else threshold
        if best_template is not None and best_similarity >= required:
            source_key = _source_key(source_ref)
            support_keys = set(_terms(best_template.get("support_source_keys")))
            if source_key and source_key in support_keys:
                should_increment = False
            else:
                should_increment = True
                if source_key:
                    support_keys.add(source_key)
                    best_template["support_source_keys"] = sorted(support_keys)
            if should_increment:
                best_template["support_count"] = int(best_template.get("support_count") or 0) + 1
            if source_ref is not None:
                examples = best_template.setdefault("example_source_refs", [])
                if len(examples) < 5:
                    examples.append(dict(source_ref))
            observed = set(best_template.get("observed_micro_patterns") or [])
            observed.update(_terms(seed.get("micro_pattern")))
            best_template["observed_micro_patterns"] = sorted(observed)
            return {
                **deepcopy(best_template),
                "template_match": {
                    "status": "reused",
                    "similarity": round(best_similarity, 4),
                    "threshold": required,
                },
            }

        self._counters[library] += 1
        template_id = f"{_library_prefix(library)}_template_{self._counters[library]:04d}"
        template = {
            "template_id": template_id,
            "template_name": seed.get("template_name") or template_id,
            "macro_pattern": macro,
            "micro_pattern": seed.get("micro_pattern") or "",
            "signature_terms": sorted(seed_terms),
            "support_count": 1,
            "support_source_keys": [_source_key(source_ref)] if _source_key(source_ref) else [],
            "observed_micro_patterns": sorted(_terms(seed.get("micro_pattern"))),
            "example_source_refs": [dict(source_ref)] if source_ref is not None else [],
        }
        self._templates[library].append(template)
        return {
            **deepcopy(template),
            "template_match": {
                "status": "created",
                "similarity": 0.0,
                "threshold": required,
            },
        }

    def to_dict(self) -> dict[str, list[dict[str, Any]]]:
        return {
            library: [deepcopy(template) for template in templates]
            for library, templates in sorted(self._templates.items())
        }


def _library_prefix(library: str) -> str:
    letters = [char.lower() if char.isalnum() else "_" for char in library]
    prefix = "".join(letters).strip("_")
    return prefix or "abstract"


def _template_number(value: object) -> int:
    text = str(value or "")
    if not text:
        return 0
    suffix = text.rsplit("_", 1)[-1]
    try:
        return int(suffix)
    except ValueError:
        return 0
