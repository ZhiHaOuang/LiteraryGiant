from __future__ import annotations

import argparse

from shared import ABSTRACT_LIBRARY_ROOT

from .review_apply import apply_review_results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="abstractmodel-apply-review",
        description="Record LLM review results and stage split/merge plans without mutating patterns.",
    )
    parser.add_argument("--review-results", required=True)
    parser.add_argument("--abstract-library-root", default=str(ABSTRACT_LIBRARY_ROOT))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = apply_review_results(
        review_results=args.review_results,
        abstract_library_root=args.abstract_library_root,
    )
    print(
        "Finished abstractmodel review apply. "
        f"accepted={result['accepted_count']} recorded={result['newly_recorded_count']} "
        f"pending={result['pending_action_count']} rejected={result['rejected_count']}"
    )
    return 0 if not result["rejected_count"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
