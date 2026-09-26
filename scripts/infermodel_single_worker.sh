#!/bin/bash
# Launch one infermodel book worker. Usage: bash scripts/infermodel_single_worker.sh book_XXXX [workers]

set -uo pipefail

BOOK="${1:-}"
WORKERS="${2:-20}"

if [ -z "$BOOK" ]; then
    echo "usage: $0 book_XXXX [workers]" >&2
    exit 2
fi

cd /root/private_data/LiteraryGiant || exit 1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/api_env.sh" ]; then
    source "$SCRIPT_DIR/api_env.sh"
fi

SRC="Library/TaciturnRaw/03_ChapterAnalysis/$BOOK"
if [ ! -d "$SRC" ]; then
    echo "missing source: $SRC" >&2
    exit 2
fi

API_KEY="${INFERMODEL_API_KEY:-${MIMO_API_KEY:-}}"
API_BASE="${INFERMODEL_API_BASE_URL:-https://token-plan-cn.xiaomimimo.com/anthropic}"
API_MODEL="${INFERMODEL_API_MODEL:-mimo-v2.5-pro}"
API_PROVIDER="${INFERMODEL_API_PROVIDER:-anthropic}"
API_USER_ID="${INFERMODEL_API_USER_ID:-}"
API_TIMEOUT=120
API_RETRIES=8
FALLBACK_RETRY_ROUNDS=3

if [ -z "$API_KEY" ]; then
    echo "error: INFERMODEL_API_KEY or MIMO_API_KEY is not set." >&2
    echo "Create scripts/api_env.sh from scripts/api_env.example.sh, or export INFERMODEL_API_KEY." >&2
    exit 2
fi

export INFERMODEL_API_MAX_IN_FLIGHT="${INFERMODEL_API_MAX_IN_FLIGHT:-160}"
export INFERMODEL_API_START_INTERVAL="${INFERMODEL_API_START_INTERVAL:-0.05}"
export INFERMODEL_API_LIMIT_DIR="${INFERMODEL_API_LIMIT_DIR:-/root/private_data/LiteraryGiant/runs/infermodel_api_limit}"

exec python -u -m Jormungandr.infermodel "$SRC" \
    --output Library/Bridges/novels_plot \
    --api-key "$API_KEY" \
    --api-base-url "$API_BASE" \
    --api-model "$API_MODEL" \
    --api-provider "$API_PROVIDER" \
    --api-user-id "$API_USER_ID" \
    --max-workers "$WORKERS" \
    --api-timeout "$API_TIMEOUT" \
    --api-retries "$API_RETRIES" \
    --fallback-retry-rounds "$FALLBACK_RETRY_ROUNDS" \
    --max-auto-chapters 99999 \
    --min-auto-chapters 0 \
    --checkpoint
