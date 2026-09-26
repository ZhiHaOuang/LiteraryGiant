from __future__ import annotations

import argparse

from shared import ABSTRACT_LIBRARY_ROOT

from .materializer import materialize_abstract_library


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="abstractmodel-materialize",
        description="Materialize compatibility pattern JSONL into a pattern-first reference library.",
    )
    parser.add_argument("--source", default=str(ABSTRACT_LIBRARY_ROOT))
    parser.add_argument("--output", default=str(ABSTRACT_LIBRARY_ROOT))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = materialize_abstract_library(source_root=args.source, output_root=args.output)
    print(
        "Finished abstractmodel materialize. "
        f"patterns={result['pattern_count']} instances={result['instance_count']} "
        f"relations={result['relation_count']} output={result['output_root']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
