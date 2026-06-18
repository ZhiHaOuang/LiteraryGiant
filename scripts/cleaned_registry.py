from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from shared import CLEANED_BOOKS_REGISTRY_PATH, LIBRARY_ROOT, CleanedBookRegistry


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cleaned-registry",
        description="Inspect and manage the cleaned corpus registry.",
    )
    parser.add_argument(
        "--registry",
        default=str(CLEANED_BOOKS_REGISTRY_PATH),
        help=f"Registry path. Default: {CLEANED_BOOKS_REGISTRY_PATH}.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="List active cleaned book assignments.")

    delete_parser = subparsers.add_parser(
        "delete",
        help="Mark a cleaned book as deleted and free its numeric slot.",
    )
    delete_parser.add_argument("clean_slug", help="Cleaned slug, e.g. book_0005.")
    delete_parser.add_argument("--reason", default="", help="Optional delete reason.")
    delete_parser.add_argument(
        "--remove-artifacts",
        action="store_true",
        help="Also remove the novels_cleaned directory recorded in the registry.",
    )
    return parser


def _cmd_list(registry: CleanedBookRegistry) -> int:
    entries = registry.active_entries()
    if not entries:
        print("No active cleaned books.")
        return 0
    for entry in entries:
        raw = entry.get("raw", {})
        print(
            f"{entry.get('clean_slug', ''):10s} "
            f"<- {raw.get('raw_book_slug', ''):10s} "
            f"{entry.get('title', '')}"
        )
    return 0


def _cmd_delete(
    registry: CleanedBookRegistry,
    *,
    clean_slug: str,
    reason: str,
    remove_artifacts: bool,
) -> int:
    snapshot = registry.mark_deleted(clean_slug, reason=reason)
    artifact_path = snapshot.get("paths", {}).get("cleaned_chapters", "")
    if remove_artifacts and artifact_path:
        target = Path(artifact_path)
        if not target.is_absolute():
            target = LIBRARY_ROOT / target
        if target.exists():
            shutil.rmtree(target)
    print(f"Deleted {snapshot.get('clean_slug', clean_slug)}; slot can be reused.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    registry = CleanedBookRegistry(args.registry)
    if args.command == "list":
        return _cmd_list(registry)
    if args.command == "delete":
        return _cmd_delete(
            registry,
            clean_slug=args.clean_slug,
            reason=args.reason,
            remove_artifacts=args.remove_artifacts,
        )
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
