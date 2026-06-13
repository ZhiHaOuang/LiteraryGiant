"""Compatibility CLI for ``python -m softmodel``."""

from Jormungandr.softmodel.__main__ import main


if __name__ == "__main__":
    raise SystemExit(main())
