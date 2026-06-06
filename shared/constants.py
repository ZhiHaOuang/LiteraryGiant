from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
YGGDRASIL_ROOT = PROJECT_ROOT / "Yggdrasil"
# Compatibility alias for older code. New code should prefer YGGDRASIL_ROOT.
DATA_ROOT = YGGDRASIL_ROOT
MODELS_ROOT = PROJECT_ROOT / "models"
RUNS_ROOT = PROJECT_ROOT / "runs"
CANONICAL_WEIGHTS_ROOT = MODELS_ROOT / "weights"
LEGACY_WEIGHTS_ROOT = PROJECT_ROOT / "WeightData"
WEIGHTS_ROOT = CANONICAL_WEIGHTS_ROOT


def detect_default_weights_root() -> Path:
    """Return the first populated weights directory under the project root.

    Prefer the canonical ``models/weights`` directory, then fall back to legacy
    ``weightdata`` and ``WeightData`` directories for compatibility.
    """
    candidates = [
        CANONICAL_WEIGHTS_ROOT,
        PROJECT_ROOT / "weightdata",
        LEGACY_WEIGHTS_ROOT,
    ]
    for candidate in candidates:
        if candidate.exists() and any(candidate.iterdir()):
            return candidate
    return candidates[-1]
