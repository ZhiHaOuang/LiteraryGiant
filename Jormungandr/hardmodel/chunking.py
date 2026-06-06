"""Text-chunking primitives for long-form novel chapters.

Provides the :class:`ChunkRecord` dataclass and helper functions for
splitting chapter text into overlapping character-level chunks suitable
for downstream LLM consumption.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(slots=True)
class ChunkRecord:
    """A single chunk of text within a chapter."""

    chunk_id: str
    chapter_id: str
    index: int
    start_char: int
    end_char: int
    text: str

    def to_dict(self) -> dict:
        return asdict(self)


def split_paragraphs(text: str) -> list[str]:
    """Split *text* into non-empty paragraphs."""
    return [part.strip() for part in text.split("\n") if part.strip()]


def take_overlap(paragraphs: list[str], overlap_chars: int) -> list[str]:
    """Return the tail of *paragraphs* whose combined length covers at least
    *overlap_chars* characters."""
    if overlap_chars <= 0 or not paragraphs:
        return []
    picked: list[str] = []
    total = 0
    for paragraph in reversed(paragraphs):
        picked.append(paragraph)
        total += len(paragraph)
        if total >= overlap_chars:
            break
    return list(reversed(picked))


def build_chunks(
    paragraphs: list[str],
    *,
    chapter_id: str,
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
) -> list[ChunkRecord]:
    """Build overlapping chunks from a list of paragraphs."""
    if not paragraphs:
        return []

    chunks: list[ChunkRecord] = []
    bucket: list[str] = []
    bucket_length = 0
    start_char = 0
    chunk_index = 1

    for paragraph in paragraphs:
        paragraph_length = len(paragraph)
        if bucket and bucket_length + paragraph_length > chunk_size:
            chunk_text = "\n".join(bucket)
            end_char = start_char + len(chunk_text)
            chunks.append(
                ChunkRecord(
                    chunk_id=f"{chapter_id}-ck-{chunk_index:03d}",
                    chapter_id=chapter_id,
                    index=chunk_index,
                    start_char=start_char,
                    end_char=end_char,
                    text=chunk_text,
                )
            )
            chunk_index += 1
            overlap_bucket = take_overlap(bucket, chunk_overlap)
            start_char = max(0, end_char - len("\n".join(overlap_bucket)))
            bucket = overlap_bucket[:]
            bucket_length = len("\n".join(bucket))

        bucket.append(paragraph)
        bucket_length = len("\n".join(bucket))

    if bucket:
        chunk_text = "\n".join(bucket)
        end_char = start_char + len(chunk_text)
        chunks.append(
            ChunkRecord(
                chunk_id=f"{chapter_id}-ck-{chunk_index:03d}",
                chapter_id=chapter_id,
                index=chunk_index,
                start_char=start_char,
                end_char=end_char,
                text=chunk_text,
            )
        )
    return chunks
