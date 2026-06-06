from __future__ import annotations

from pathlib import Path

from .constants import detect_default_weights_root


def resolve_model_source(
    model_name: str,
    *,
    weights_root: str | Path | None = None,
    family_dirs: list[str] | None = None,
) -> str:
    """Resolve a model name to a local directory path.

    If *model_name* is an existing path on disk it is returned as-is.
    Otherwise the function searches under *weights_root* (defaulting to the
    project's canonical ``models/weights`` directory, with legacy fallbacks),
    trying the bare name, the name's basename, and every combination with
    *family_dirs*.
    """
    raw = Path(model_name).expanduser()
    if raw.exists():
        return str(raw)

    if raw.is_absolute():
        return str(raw)

    root = (
        Path(weights_root).expanduser()
        if weights_root is not None
        else detect_default_weights_root()
    )
    base_name = model_name.rstrip("/").split("/")[-1]
    families = family_dirs or []

    candidates: list[Path] = [
        root / model_name,
        root / base_name,
    ]

    for family in families:
        candidates.append(root / family)
        candidates.append(root / family / model_name)
        candidates.append(root / family / base_name)

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return model_name
