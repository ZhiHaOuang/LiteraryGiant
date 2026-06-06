#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if command -v conda >/dev/null 2>&1; then
  conda run -n LitCodex python -m scripts.validate_data_layout --book-id 0001
else
  python -m scripts.validate_data_layout --book-id 0001
fi
