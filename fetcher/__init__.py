"""Web novel fetcher — crawl novels from supported sites.

Chapters are staged to ``runs/fetch/<run_id>/`` and promoted to
``Library/TaciturnRaw/01_RawData/<category>/<content_id>/`` after validation.  All text
cleaning is deferred to :mod:`Jormungandr.hardmodel`.

Public API::

    from fetcher import FetcherEngine, BookRegistry, get_adapter_for_url

    adapter_cls = get_adapter_for_url("https://www.ibiquge.com/444")
    engine = FetcherEngine(adapter_cls(), max_chapters=10)
    canonical_path = engine.fetch_novel("https://www.ibiquge.com/444")
"""

from __future__ import annotations

from .adapters import (
    ADAPTER_REGISTRY,
    BaseAdapter,
    ChapterEntry,
    IbiqugeAdapter,
    TrxsAdapter,
    WuyouShuchengAdapter,
    get_adapter_for_url,
)
from .engine import FetcherEngine
from .local_archive import (
    DedupeThresholds,
    SourceSnapshot,
    apply_plan,
    default_archive_root,
    enrich_low_confidence_metadata,
    plan_catalog,
    revalidate_quarantined_literals,
    scan_sources,
    snapshot_sources,
    source_snapshot_from_dict,
    verify_plan,
)
from .local_catalog import LocalNovelCatalog
from .local_fingerprint import (
    FINGERPRINT_VERSION,
    FileFingerprint,
    compare_fingerprints,
    fingerprint_file,
)
from .local_metadata import (
    BookNameMetadata,
    GenreClassification,
    VLLMMetadataClient,
    canonical_name_key,
    classify_genre,
    clean_aliases,
    clean_author,
    clean_title,
    extract_metadata_from_file,
    parse_book_filename,
)
from .registry import BookRegistry

__version__ = "0.1.0"

__all__ = [
    "ADAPTER_REGISTRY",
    "BaseAdapter",
    "BookRegistry",
    "ChapterEntry",
    "FetcherEngine",
    "FINGERPRINT_VERSION",
    "FileFingerprint",
    "BookNameMetadata",
    "GenreClassification",
    "IbiqugeAdapter",
    "TrxsAdapter",
    "WuyouShuchengAdapter",
    "LocalNovelCatalog",
    "VLLMMetadataClient",
    "DedupeThresholds",
    "SourceSnapshot",
    "apply_plan",
    "canonical_name_key",
    "classify_genre",
    "clean_aliases",
    "clean_author",
    "clean_title",
    "compare_fingerprints",
    "extract_metadata_from_file",
    "fingerprint_file",
    "default_archive_root",
    "enrich_low_confidence_metadata",
    "get_adapter_for_url",
    "parse_book_filename",
    "plan_catalog",
    "revalidate_quarantined_literals",
    "scan_sources",
    "snapshot_sources",
    "source_snapshot_from_dict",
    "verify_plan",
]
