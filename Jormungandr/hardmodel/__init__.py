from .chapter_cleaner import ChapterRecord, ChunkRecord, RawNovelBook
from .manifest_writer import (
    materialize_source_chapters,
    resolve_output_dir,
    write_result_file,
)
from .processor import (
    discover_txt_files,
    process_txt_file,
)
from .source_resolver import BookSource, ChapterSource, resolve_input

__version__ = "0.1.0"

__all__ = [
    "BookSource",
    "ChapterRecord",
    "ChapterSource",
    "ChunkRecord",
    "RawNovelBook",
    "discover_txt_files",
    "process_txt_file",
    "resolve_input",
    "resolve_output_dir",
    "materialize_source_chapters",
    "write_result_file",
]
