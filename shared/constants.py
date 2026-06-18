from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIBRARY_ROOT = PROJECT_ROOT / "Library"
PROJECTS_ROOT = PROJECT_ROOT / "Projects"
INDEXES_ROOT = LIBRARY_ROOT / "indexes"
TACITURN_RAW_ROOT = LIBRARY_ROOT / "TaciturnRaw"
TACITURN_NOVELS_RAW_ROOT = TACITURN_RAW_ROOT / "novels_raw"
TACITURN_STORIES_RAW_ROOT = TACITURN_RAW_ROOT / "stories_raw"
TACITURN_NOVELS_CLEANED_ROOT = TACITURN_RAW_ROOT / "novels_cleaned"
TACITURN_STORIES_CLEANED_ROOT = TACITURN_RAW_ROOT / "stories_cleaned"
TACITURN_NOVELS_CHAPTER_ROOT = TACITURN_RAW_ROOT / "novels_chapter"
BRIDGES_ROOT = LIBRARY_ROOT / "Bridges"
BRIDGE_NOVELS_PLOT_ROOT = BRIDGES_ROOT / "novels_plot"
BRIDGE_STORIES_PLOT_ROOT = BRIDGES_ROOT / "stories_plot"
ABSTRACT_LIBRARY_ROOT = LIBRARY_ROOT / "AbstractLibrary"
ABSTRACT_WORLDVIEW_ROOT = ABSTRACT_LIBRARY_ROOT / "Worldview"
ABSTRACT_EVENTS_LIBRARY_ROOT = ABSTRACT_LIBRARY_ROOT / "EventsLibrary"
ABSTRACT_CHARACTER_ARC_ROOT = ABSTRACT_LIBRARY_ROOT / "CharacterArc"
ABSTRACT_EMOTION_RHYTHM_ROOT = ABSTRACT_LIBRARY_ROOT / "EmotionRhythm"
ABSTRACT_PAYOFF_ANGST_ROOT = ABSTRACT_LIBRARY_ROOT / "Payoff_Angst"
ABSTRACT_MEMES_ROOT = ABSTRACT_LIBRARY_ROOT / "Memes"
ABSTRACT_BOOK_LOGIC_GRAPH_ROOT = ABSTRACT_LIBRARY_ROOT / "BookLogicGraph"

# Compatibility aliases for older code. New code should prefer the TaciturnRaw,
# Bridges, and AbstractLibrary constants above.
RAWDATA_ROOT = TACITURN_RAW_ROOT
RAWDATA_NOVELS_ROOT = TACITURN_NOVELS_RAW_ROOT
RAWDATA_STORIES_ROOT = TACITURN_STORIES_RAW_ROOT
RAWDATA_REVIEWS_ROOT = TACITURN_RAW_ROOT / "reviews_raw"
REFERENCE_ROOT = LIBRARY_ROOT
FACTS_ROOT = TACITURN_RAW_ROOT
FACT_CLEANED_CHAPTERS_ROOT = TACITURN_NOVELS_CLEANED_ROOT
FACT_CHAPTER_FEATURES_ROOT = TACITURN_NOVELS_CHAPTER_ROOT
FACT_PLOT_SEGMENTS_ROOT = BRIDGE_NOVELS_PLOT_ROOT
ABSTRACTIONS_ROOT = ABSTRACT_LIBRARY_ROOT
IDEAS_ROOT = ABSTRACT_LIBRARY_ROOT

# Legacy compatibility aliases.
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
