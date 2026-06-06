"""Chapter splitting entry points for cleaned or whole-book text."""

from __future__ import annotations

from pathlib import Path

from .chapter_cleaner import ChapterRecord, RawNovelBook
from .source_resolver import BookSource


def split_clean_text(
    text: str,
    *,
    book_id: str = "unknown_book",
    source_path: str | Path = "memory.txt",
) -> list[ChapterRecord]:
    """Split already-normalized and cleaned text into chapter records."""
    book = RawNovelBook(source_path, book_id=book_id)
    return book.split_chapters(text)


def process_source(source: BookSource, **kwargs) -> dict:
    """Process a resolved source into cleaned chapter artifacts in memory."""
    book = RawNovelBook.from_book_source(source, **kwargs)
    return book.process()
