from __future__ import annotations

from datetime import datetime, timezone

from .nuextract_extractor import NuExtractExtractor


class ChapterFeaturePipeline:
    def __init__(
        self,
        *,
        nuextract_extractor: NuExtractExtractor | None = None,
    ) -> None:
        self.nuextract_extractor = nuextract_extractor or NuExtractExtractor()

    def process_chapter(self, chapter_payload: dict, *, source_file: str, book_id: str) -> dict:
        chapter_context = self.build_chapter_context(
            chapter_payload=chapter_payload,
            source_file=source_file,
            book_id=book_id,
        )
        content = str(chapter_payload.get("content", ""))
        semantic = self.extract_semantic_features(
            title=str(chapter_payload.get("clean_title", "")),
            content=content,
        )

        return {
            "chapter_context": chapter_context,
            "source_ref": {
                "chapter_file": source_file,
            },
            "semantic_features": semantic.to_dict(),
            "extractor_metadata": {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "nuextract_model": self.nuextract_extractor.model_name,
                "nuextract_model_source": self.nuextract_extractor.resolved_model_source or self.nuextract_extractor.model_name,
            },
        }

    @staticmethod
    def build_chapter_context(*, chapter_payload: dict, source_file: str, book_id: str) -> dict:
        return {
            "book_id": book_id,
            "chapter_id": chapter_payload.get("chapter_id"),
            "order": chapter_payload.get("order"),
            "raw_title": chapter_payload.get("raw_title"),
            "clean_title": chapter_payload.get("clean_title"),
            "chapter_no": chapter_payload.get("chapter_no"),
            "volume_title": chapter_payload.get("volume_title"),
            "volume_no": chapter_payload.get("volume_no"),
            "char_count": chapter_payload.get("char_count"),
            "paragraph_count": chapter_payload.get("paragraph_count"),
            "dialogue_ratio": chapter_payload.get("dialogue_ratio"),
            "source_file": source_file,
        }

    def extract_semantic_features(self, *, title: str, content: str):
        return self.nuextract_extractor.extract(
            title=title,
            content=content,
        )
