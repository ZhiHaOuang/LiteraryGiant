from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIBRARY_ROOT = PROJECT_ROOT / "Library"
# Large, uncurated local TXT imports are isolated under Library/Noise. They
# must pass the organizer's review/dedup gates before promotion to TaciturnRaw.
NOVEL_NOISE_ROOT = LIBRARY_ROOT / "Noise"
# Compatibility name used by the local organizer's first implementation.
NOVEL_IMPORTS_ROOT = NOVEL_NOISE_ROOT
PROJECTS_ROOT = PROJECT_ROOT / "Projects"
INDEXES_ROOT = LIBRARY_ROOT / "indexes"
TACITURN_RAW_ROOT = LIBRARY_ROOT / "TaciturnRaw"
# Physical v2 layout.  Keep the older public constant names as aliases so
# callers do not need a flag day when the on-disk names change.
TACITURN_STORIES_ROOT = TACITURN_RAW_ROOT / "00_Stories"
TACITURN_RAW_DATA_ROOT = TACITURN_RAW_ROOT / "01_RawData"
TACITURN_CLEANED_DATA_ROOT = TACITURN_RAW_ROOT / "02_CleanedData"
TACITURN_CHAPTER_ANALYSIS_ROOT = TACITURN_RAW_ROOT / "03_ChapterAnalysis"

TACITURN_NOVELS_RAW_ROOT = TACITURN_RAW_DATA_ROOT
TACITURN_STORIES_RAW_ROOT = TACITURN_STORIES_ROOT
TACITURN_NOVELS_CLEANED_ROOT = TACITURN_CLEANED_DATA_ROOT
TACITURN_NOVELS_CHAPTER_ROOT = TACITURN_CHAPTER_ANALYSIS_ROOT

# There is no stories-cleaned stage in the v2 layout.  The compatibility
# constant deliberately points at the retired legacy location so old readers
# tolerate an absent directory without accidentally treating 00_Stories as
# cleaned output.
TACITURN_STORIES_CLEANED_ROOT = TACITURN_RAW_ROOT / "stories_cleaned"

# Read-only names used solely by the one-time source migration.  Runtime code
# must use the v2 constants above and never consult an old->new ID map.
TACITURN_LEGACY_STORIES_RAW_ROOT = TACITURN_RAW_ROOT / "stories_raw"
TACITURN_LEGACY_NOVELS_RAW_ROOT = TACITURN_RAW_ROOT / "novels_raw"
TACITURN_LEGACY_NOVELS_CLEANED_ROOT = TACITURN_RAW_ROOT / "novels_cleaned"
TACITURN_LEGACY_NOVELS_CHAPTER_ROOT = TACITURN_RAW_ROOT / "novels_chapter"
BRIDGES_ROOT = LIBRARY_ROOT / "Bridges"
BRIDGE_NOVELS_PLOT_ROOT = BRIDGES_ROOT / "novels_plot"
BRIDGE_STORIES_PLOT_ROOT = BRIDGES_ROOT / "stories_plot"
ABSTRACT_LIBRARY_ROOT = LIBRARY_ROOT / "AbstractLibrary"
ABSTRACT_WORLDVIEW_ROOT = ABSTRACT_LIBRARY_ROOT / "Worldview"
ABSTRACT_EVENTS_LIBRARY_ROOT = ABSTRACT_LIBRARY_ROOT / "EventsLibrary"
ABSTRACT_CHARACTER_ARC_ROOT = ABSTRACT_LIBRARY_ROOT / "CharacterArc"
ABSTRACT_EMOTION_RHYTHM_ROOT = ABSTRACT_LIBRARY_ROOT / "EmotionRhythm"
ABSTRACT_PAYOFFANGST_ROOT = ABSTRACT_LIBRARY_ROOT / "PayoffAngst"
ABSTRACT_PAYOFF_ANGST_ROOT = ABSTRACT_PAYOFFANGST_ROOT
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
