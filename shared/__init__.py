from .constants import (
    ABSTRACTIONS_ROOT,
    CANONICAL_WEIGHTS_ROOT,
    DATA_ROOT,
    FACTS_ROOT,
    FACT_CHAPTER_FEATURES_ROOT,
    FACT_CLEANED_CHAPTERS_ROOT,
    FACT_PLOT_SEGMENTS_ROOT,
    IDEAS_ROOT,
    INDEXES_ROOT,
    LEGACY_WEIGHTS_ROOT,
    LIBRARY_ROOT,
    MODELS_ROOT,
    PROJECT_ROOT,
    PROJECTS_ROOT,
    RAWDATA_NOVELS_ROOT,
    RAWDATA_REVIEWS_ROOT,
    RAWDATA_ROOT,
    RAWDATA_STORIES_ROOT,
    REFERENCE_ROOT,
    RUNS_ROOT,
    WEIGHTS_ROOT,
    YGGDRASIL_ROOT,
    detect_default_weights_root,
)
from .artifact_manifest import (
    ArtifactManifestError,
    load_chapters_from_manifest,
    validate_plot_payload,
)
from .json_parser import parse_json_payload
from .model_resolution import resolve_model_source
from .retrieval_tracker import PipelineState, compute_path_signature
from .text_utils import (
    collapse_blank_lines,
    is_blank_line,
    normalize_line,
    normalize_text,
)
from .type_helpers import (
    as_bool,
    as_clean_text,
    as_dict,
    as_float,
    as_int,
    as_list,
    as_mapping,
    as_text,
    dedupe_items,
    EMPTY_LIKE_STRINGS,
)
from .utils import canonical_book_slug, load_json, normalize_fs_name, serialize_payload

# Legacy underscore-prefixed aliases — kept so existing modules that use
# ``from shared import _as_text`` (etc.) continue to work without changes.
_as_text = as_text
_as_list = as_list
_as_dict = as_dict
_as_mapping = as_mapping
_as_int = as_int
_as_float = as_float
_as_bool = as_bool
_as_clean_text = as_clean_text
_dedupe_items = dedupe_items

__all__ = [
    # --- constants ---
    "ABSTRACTIONS_ROOT",
    "CANONICAL_WEIGHTS_ROOT",
    "DATA_ROOT",
    "FACTS_ROOT",
    "FACT_CHAPTER_FEATURES_ROOT",
    "FACT_CLEANED_CHAPTERS_ROOT",
    "FACT_PLOT_SEGMENTS_ROOT",
    "IDEAS_ROOT",
    "INDEXES_ROOT",
    "LEGACY_WEIGHTS_ROOT",
    "LIBRARY_ROOT",
    "MODELS_ROOT",
    "PROJECT_ROOT",
    "PROJECTS_ROOT",
    "RAWDATA_NOVELS_ROOT",
    "RAWDATA_REVIEWS_ROOT",
    "RAWDATA_ROOT",
    "RAWDATA_STORIES_ROOT",
    "REFERENCE_ROOT",
    "RUNS_ROOT",
    "WEIGHTS_ROOT",
    "YGGDRASIL_ROOT",
    "detect_default_weights_root",
    # --- artifact manifests ---
    "ArtifactManifestError",
    "load_chapters_from_manifest",
    "validate_plot_payload",
    # --- utils ---
    "load_json",
    "canonical_book_slug",
    "normalize_fs_name",
    "serialize_payload",
    # --- text utils ---
    "collapse_blank_lines",
    "is_blank_line",
    "normalize_line",
    "normalize_text",
    # --- json ---
    "parse_json_payload",
    # --- type helpers (public) ---
    "as_bool",
    "as_clean_text",
    "as_dict",
    "as_float",
    "as_int",
    "as_list",
    "as_mapping",
    "as_text",
    "dedupe_items",
    "EMPTY_LIKE_STRINGS",
    # --- type helpers (legacy aliases) ---
    "_as_bool",
    "_as_clean_text",
    "_as_dict",
    "_as_float",
    "_as_int",
    "_as_list",
    "_as_mapping",
    "_as_text",
    "_dedupe_items",
    # --- model resolution ---
    "resolve_model_source",
    # --- state tracking ---
    "PipelineState",
    "compute_path_signature",
]
