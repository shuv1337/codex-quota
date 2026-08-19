#!/usr/bin/env bash
set -euo pipefail

# shuvquota is a zero-dependency project — no install step needed.
# Verify bun is available for testing.
command -v bun >/dev/null 2>&1 || { echo "bun is required but not installed"; exit 1; }

echo "Environment ready. Runtime: $(node --version), Test runner: $(bun --version)"
