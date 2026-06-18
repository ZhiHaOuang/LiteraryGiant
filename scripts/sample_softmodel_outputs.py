from __future__ import annotations

import argparse
import json
from pathlib import Path

from Jormungandr.softmodel.nuextract_extractor import NuExtractExtractor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run softmodel extraction on one or more cleaned chapter JSON files and print the outputs.",
    )
    parser.add_argument("chapters", nargs="+", help="Chapter JSON file(s) under novels_cleaned.")
    parser.add_argument("--max-input-chars", type=int, default=6000)
    parser.add_argument("--max-new-tokens", type=int, default=768)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    extractor = NuExtractExtractor(
        model_name="NuExtract_8B",
        model_variant="8b",
        inference_backend="vllm",
        max_input_chars=args.max_input_chars,
        max_new_tokens=args.max_new_tokens,
    )

    for chapter_path in args.chapters:
        path = Path(chapter_path)
        payload = json.loads(path.read_text(encoding="utf-8"))
        title = str(payload.get("clean_title") or payload.get("raw_title") or "")
        content = str(payload.get("content") or "")
        features = extractor.extract(title=title, content=content)
        print(f"=== SAMPLE {path.as_posix()} ===")
        print(json.dumps(features.to_dict(), ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
