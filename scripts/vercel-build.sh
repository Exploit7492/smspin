#!/usr/bin/env bash
# Vercel build entrypoint. Keep the Node work in scripts/vercel-build.mjs so it
# is testable locally with plain `node`.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/vercel-build.mjs
