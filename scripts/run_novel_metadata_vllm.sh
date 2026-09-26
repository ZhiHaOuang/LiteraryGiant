#!/usr/bin/env bash
set -euo pipefail

# Optional metadata service for low-confidence titles/genres.  Exact and fuzzy
# content deduplication never calls this model.
MODEL_PATH="${1:-${NOVEL_METADATA_MODEL:-models/weights/Qwen_14B}}"
SERVED_NAME="${NOVEL_METADATA_SERVED_NAME:-novel-metadata}"
HOST="${NOVEL_METADATA_HOST:-127.0.0.1}"
PORT="${NOVEL_METADATA_PORT:-8000}"
GPU_MEMORY="${NOVEL_METADATA_GPU_MEMORY:-0.85}"
MAX_MODEL_LEN="${NOVEL_METADATA_MAX_MODEL_LEN:-8192}"

exec python -m vllm.entrypoints.openai.api_server \
  --model "${MODEL_PATH}" \
  --served-model-name "${SERVED_NAME}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --gpu-memory-utilization "${GPU_MEMORY}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --trust-remote-code
