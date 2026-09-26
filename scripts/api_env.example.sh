#!/usr/bin/env bash
# Copy the relevant exports into your private shell profile or a local ignored
# env file. Do not put real API values in tracked project files.

# infermodel API. Prefer these names for isolated infermodel traffic.
export INFERMODEL_API_KEY="..."
export INFERMODEL_API_BASE_URL="https://api.deepseek.com/anthropic"
export INFERMODEL_API_MODEL="deepseek-v4-pro"
export INFERMODEL_API_PROVIDER="anthropic"
export INFERMODEL_API_USER_ID="literarygiant-infermodel-v1"

# abstractmodel / DeepSeek. Override the key if this stage uses a separate account.
export ABSTRACTMODEL_DEEPSEEK_API_KEY="${ABSTRACTMODEL_DEEPSEEK_API_KEY:-$INFERMODEL_API_KEY}"
export ABSTRACTMODEL_DEEPSEEK_BASE_URL="${ABSTRACTMODEL_DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}"
export ABSTRACTMODEL_DEEPSEEK_MODEL="${ABSTRACTMODEL_DEEPSEEK_MODEL:-deepseek-v4-pro}"

# infermodel / MiMO legacy fallback
export MIMO_API_KEY="..."

# Claude Code / DeepSeek, if your local Claude Code setup uses a DeepSeek proxy.
# Keep the real value in your shell environment or user-level Claude config.
# export DEEPSEEK_API_KEY="..."
# export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
# export ANTHROPIC_BASE_URL="..."
