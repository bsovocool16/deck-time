#!/bin/bash
# Runs Ollama with its models stored in this project's models/ollama (e.g. on an external disk).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
export OLLAMA_MODELS="$DIR/models/ollama"
export OLLAMA_HOST="127.0.0.1:11434"
export OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0
mkdir -p "$OLLAMA_MODELS"
exec "$(command -v ollama || echo /opt/homebrew/bin/ollama)" serve
