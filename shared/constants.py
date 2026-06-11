from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIBRARY_ROOT = PROJECT_ROOT / "Library"
PROJECTS_ROOT = PROJECT_ROOT / "Projects"
RAWDATA_ROOT = LIBRARY_ROOT / "rawdata"
RAWDATA_NOVELS_ROOT = RAWDATA_ROOT / "novels"
RAWDATA_STORIES_ROOT = RAWDATA_ROOT / "stories"
RAWDATA_REVIEWS_ROOT = RAWDATA_ROOT / "reviews"
REFERENCE_ROOT = LIBRARY_ROOT / "reference"
FACTS_ROOT = REFERENCE_ROOT / "facts"
FACT_CLEANED_CHAPTERS_ROOT = FACTS_ROOT / "cleaned_chapters"
FACT_CHAPTER_FEATURES_ROOT = FACTS_ROOT / "chapter_features"
FACT_PLOT_SEGMENTS_ROOT = FACTS_ROOT / "plot_segments"
ABSTRACTIONS_ROOT = REFERENCE_ROOT / "abstractions"
IDEAS_ROOT = LIBRARY_ROOT / "ideas"
INDEXES_ROOT = LIBRARY_ROOT / "indexes"

# Compatibility aliases for older code. New code should prefer the explicit
# Library/Projects constants above.
YGGDRASIL_ROOT = LIBRARY_ROOT
DATA_ROOT = LIBRARY_ROOT
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
