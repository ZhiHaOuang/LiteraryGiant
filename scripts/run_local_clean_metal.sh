#!/bin/sh
# Usage: sh scripts/run_local_clean_metal.sh /path/to/inference/bin/vllm /path/to/Qwen_14B
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: run_local_clean_metal.sh VLLM_EXECUTABLE MODEL_DIRECTORY' >&2
  exit 2
fi
export VLLM_NO_USAGE_STATS=1
export DO_NOT_TRACK=1
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export GLOO_SOCKET_IFNAME=lo0
exec "$1" serve "$2" \
  --served-model-name lg-clean-qwen14b \
  --host 127.0.0.1 --port 18080 \
  --max-model-len 8192 --max-num-seqs 4 \
  --gpu-memory-utilization 0.55 --disable-log-requests
