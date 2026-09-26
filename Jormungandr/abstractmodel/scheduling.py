"""Compatibility entry point for the Bridge-first incremental AbstractModel."""

from .bridge_cli import build_parser, main

__all__ = ["build_parser", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
