from shared import detect_default_weights_root, resolve_model_source

from .nuextract_extractor import NuExtractExtractor
from .pipeline import ChapterFeaturePipeline
from .processor import (
    discover_processed_books,
    load_book_bundle,
    process_book_dir,
    resolve_feature_output_dir,
    write_feature_book,
)

__all__ = [
    "NuExtractExtractor",
    "detect_default_weights_root",
    "resolve_model_source",
    "ChapterFeaturePipeline",
    "discover_processed_books",
    "load_book_bundle",
    "process_book_dir",
    "resolve_feature_output_dir",
    "write_feature_book",
]
