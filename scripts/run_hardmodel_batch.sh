#!/bin/bash
# Hardmodel batch cleaning script — unbuffered output for live monitoring.
set -euo pipefail

LOG_FILE="${1:-/tmp/hardmodel_batch.log}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "=== Batch started at $TIMESTAMP ===" | tee -a "$LOG_FILE"

NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
python -u -m Jormungandr.hardmodel /root/private_data/LiteraryGiant/Library/rawdata/novels \
  --compact \
  --use-clean-registry \
  --pending-fetches \
  --noise-classifier-backend vllm \
  --noise-classifier-model Qwen_8B \
  --noise-classifier-url http://127.0.0.1:8000/v1 \
  --noise-classifier-batch-size 8 \
  --noise-classifier-max-new-tokens 512 \
  --noise-classifier-temperature 0 \
  --noise-classifier-timeout 180 \
  --noise-classifier-concurrency 4 \
  2>&1 | tee -a "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Batch finished at $TIMESTAMP (exit=$EXIT_CODE) ===" | tee -a "$LOG_FILE"
exit $EXIT_CODE
