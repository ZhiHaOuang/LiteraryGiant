# Novel Agent Data Layout

This project now treats novel work as versioned artifacts rather than loose
stage folders. Legacy folders are kept for compatibility, while the canonical
layout lives under `Yggdrasil/`, `models/`, and `runs/`.

## Canonical Roots

- `Yggdrasil/sources/raw_text/`: imported or normalized source novels.
- `Yggdrasil/sources/imports/`: temporary imported files before normalization.
- `Yggdrasil/derived/chapters/`: chapter-level cleaned JSON artifacts.
- `Yggdrasil/derived/features/`: chapter-level semantic feature JSON artifacts.
- `Yggdrasil/derived/plots/`: plot-level cluster JSON artifacts.
- `Yggdrasil/derived/generations/`: generated outlines, chapters, and variants.
- `Yggdrasil/projects/`: per-book creative workspaces for new novels.
- `Yggdrasil/indexes/`: generated book registries and artifact indexes.
- `Yggdrasil/reference/`: reusable plot, trope, style, character, and setting libraries.
- `models/weights/`: local model snapshots and checkpoints.
- `models/configs/`: model routing and provider configs.
- `runs/`: per-run metrics, logs, temporary outputs, and API call records.

Real data under these roots is ignored by git by default. Directory placeholders
are tracked so future agents have stable locations to write into.

## Book Layout

Use a stable book slug for each novel:

```text
book_0001
book_0002
```

Canonical chapter files use stage-local names:

```text
Yggdrasil/derived/chapters/book_0001/chapter_0001.json
Yggdrasil/derived/features/book_0001/chapter_0001.json
Yggdrasil/derived/plots/book_0001/plot_0001.json
```

Every stage directory should contain `index.json`. The manifest in `index.json`
is authoritative for downstream correspondence.

## Project Workspace Layout

Use `Yggdrasil/projects/_template/` as the scaffold for each new writing project.
Real project files are ignored by git by default.

```text
Yggdrasil/projects/<project_id>/
  book.yaml
  bible/
    style.md
    worldview.md
    characters.yaml
    timeline.yaml
    clue_registry.yaml
    constraints.md
    reference_policy.yaml
  outlines/
    book_outline.md
    volume_outline.yaml
    arc_outline.yaml
    chapter_plans/
  drafts/
  reviews/
    continuity/
    style/
    plot/
  runs/
```

`projects` is the current-book workspace. It should reference `Yggdrasil/reference`
for reusable patterns and may follow source pointers back into `Yggdrasil/derived`
only when more evidence is needed.

## Required Identity Fields

Each artifact should preserve these IDs where applicable:

- `book_id`: stable novel id, such as `0001`.
- `chapter_id`: stable chapter id, such as `0001C0003`.
- `plot_id`: stable plot id from the plot clustering stage.
- `order`: numeric order inside the book.
- `file_name`: canonical file name inside the current stage.
- `legacy_file_name`: original file name when copied from legacy folders.
- `layout_version`: current canonical layout version.
- `artifact_stage`: `raw_text`, `chapters`, `features`, `plots`, or `generations`.

## Legacy Mapping

```text
RawData       -> Yggdrasil/sources/raw_text/
ProcessData   -> Yggdrasil/derived/chapters/
FeatureData   -> Yggdrasil/derived/features/
ClusterData   -> Yggdrasil/derived/plots/
GData         -> Yggdrasil/derived/generations/
TextM         -> Yggdrasil/sources/imports/ or Yggdrasil/reference/
WeightData    -> models/weights/
outputs/logs  -> runs/
```

Use `data-sync-legacy --book-id 0001` to copy the current test novel into the
canonical structure. Use `data-validate --book-id 0001` to check identity and
manifest consistency.
