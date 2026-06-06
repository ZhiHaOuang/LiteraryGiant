# Novel Agent Framework

The target architecture is a file-operating agent specialized by project
structure, instructions, hooks, subagents, and validation scripts.

## Agent Roles

- `data-curator`: owns data layout, manifests, naming, and migrations.
- `plot-architect`: owns plot hierarchy, conflicts, reveals, reversals, and pacing.
- `continuity-checker`: checks character, setting, timeline, and cause-effect consistency.
- `style-editor`: checks prose style, rhythm, dialogue, and tone.
- `reference-librarian`: maintains abstract plot/trope/style reference libraries.

## Hooks

Hooks should enforce deterministic rules that must not depend on model judgment:

- After data writes: run `python -m scripts.validate_data_layout --book-id 0001`.
- Before destructive shell operations: block unapproved deletes or bulk moves.
- After generated chapters: run continuity and manifest checks.
- Before long API runs: check API key source, output run folder, and logging config.

## Commands

Project commands should wrap repeatable workflows:

- `data-sync-legacy --book-id 0001`
- `data-validate --book-id 0001`
- future: `novel-plan`, `novel-draft`, `novel-check-continuity`, `novel-build-reference`

## Creative Workspaces

New books should live under `Yggdrasil/projects/<project_id>/`, using
`Yggdrasil/projects/_template/` as the scaffold. Treat each project workspace as the
source of truth for the current book's style, timeline, clue registry, outline,
drafts, and reviews. It should consume `Yggdrasil/reference/` by reference and only
look back into `Yggdrasil/derived/` through explicit source pointers.

## Current Test Book

Book `0001` remains the smoke-test path for the end-to-end pipeline. It is used
to validate that legacy data, canonical data, MiMO inference, and plot outputs
stay aligned before scaling to more novels.
