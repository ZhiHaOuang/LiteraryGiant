from __future__ import annotations

import json
import re
from typing import Any


def parse_json_payload(raw_text: str) -> dict[str, Any]:
    """Extract a JSON object from raw LLM output text.

    Handles markdown code fences (`` ```json `` / `` ``` ``), plain JSON,
    and JSON embedded inside other text.  Raises ``ValueError`` when no
    valid JSON object can be found.
    """
    cleaned = raw_text.strip()

    # Strip markdown code fences
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()

    # Try direct parse first
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Find JSON object boundaries
    start = cleaned.find("{")
    if start < 0:
        raise ValueError(f"Model output does not contain JSON. Raw: {raw_text[:500]}")

    candidate = cleaned[start:]

    # Defensive check: bail early if braces look unbalanced and likely truncated
    if candidate.count("{") > candidate.count("}"):
        raise ValueError(
            f"Model returned incomplete JSON (likely truncated). Raw: {raw_text[:500]}"
        )

    match = re.search(r"\{.*\}", candidate, flags=re.DOTALL)
    if not match:
        raise ValueError(f"Model output does not contain JSON object. Raw: {raw_text[:500]}")

    return json.loads(match.group(0))
