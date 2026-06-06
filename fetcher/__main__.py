"""Allow running the fetcher as ``python -m fetcher``."""

from __future__ import annotations

from .scheduling import main

if __name__ == "__main__":
    raise SystemExit(main())
