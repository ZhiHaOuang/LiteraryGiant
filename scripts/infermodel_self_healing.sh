#!/bin/bash
# Self-healing infermodel batch runner
# Usage: bash scripts/infermodel_self_healing.sh

set -uo pipefail

LOG_DIR="/root/private_data/LiteraryGiant/logs"
INPUT_ROOT="Library/TaciturnRaw/03_ChapterAnalysis"
OUTPUT_ROOT="Library/Bridges/novels_plot"
PID_FILE="/root/private_data/LiteraryGiant/runs/infermodel_batch.pid"
MAX_WORKERS=18
API_TIMEOUT=120
API_RETRIES=8
FALLBACK_RETRY_ROUNDS=3
MAX_AUTO_CHAPTERS=99999

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/api_env.sh" ]; then
    source "$SCRIPT_DIR/api_env.sh"
fi
API_KEY="${INFERMODEL_API_KEY:-${MIMO_API_KEY:-}}"
API_BASE="${INFERMODEL_API_BASE_URL:-https://token-plan-cn.xiaomimimo.com/anthropic}"
API_MODEL="${INFERMODEL_API_MODEL:-mimo-v2.5-pro}"
API_PROVIDER="${INFERMODEL_API_PROVIDER:-anthropic}"
API_USER_ID="${INFERMODEL_API_USER_ID:-}"
if [ -z "$API_KEY" ]; then
    echo "error: INFERMODEL_API_KEY or MIMO_API_KEY is not set. Create scripts/api_env.sh from api_env.example.sh" >&2
    exit 2
fi

restart_count=0

while true; do
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    LOG_FILE="$LOG_DIR/infermodel_batch_${TIMESTAMP}.log"

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] =========================================="
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] infermodel batch run #$((restart_count + 1))"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] log: $LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] =========================================="

    python -u -m Jormungandr.infermodel "$INPUT_ROOT" \
        --output "$OUTPUT_ROOT" \
        --api-key "$API_KEY" \
        --api-base-url "$API_BASE" \
        --api-model "$API_MODEL" \
        --api-provider "$API_PROVIDER" \
        --api-user-id "$API_USER_ID" \
        --max-workers "$MAX_WORKERS" \
        --api-timeout "$API_TIMEOUT" \
        --api-retries "$API_RETRIES" \
        --fallback-retry-rounds "$FALLBACK_RETRY_ROUNDS" \
        --max-auto-chapters "$MAX_AUTO_CHAPTERS" \
        --checkpoint \
        >> "$LOG_FILE" 2>&1 &

    PID=$!
    echo "$PID" > "$PID_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Started PID=$PID"

    wait "$PID" 2>/dev/null || true; EXIT_CODE=$?

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] PID=$PID exited code=$EXIT_CODE"

    if [ $EXIT_CODE -eq 0 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Normal exit. Checking for new books in 60s..."
        sleep 60
    else
        restart_count=$((restart_count + 1))
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Crash detected (restart #$restart_count). Restarting in 30s..."
        sleep 30
    fi
done
