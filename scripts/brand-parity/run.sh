#!/usr/bin/env bash
# One command: render the same row matrix in the site renderer and in the real built
# extension, read computed styles per row type, fail on any undeclared difference.
#   HS_SITE_DIR=<site checkout/worktree> scripts/brand-parity/run.sh [outdir]
# Needs: the extension built (bun run build.js chrome --minify --no-test), the site's node_modules
# (vite), playwright-core (this repo's). ~2 min — the extension holds a went-live row for a 90s grace.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
site=${HS_SITE_DIR:-/home/mellen/projects/heatsync}
out=${1:-/tmp/brand-parity}; mkdir -p "$out"
export HS_PW=${HS_PW:-$here/node_modules/playwright-core}
[ -d "$HS_PW" ] || HS_PW=/home/mellen/projects/heatsync-extension/node_modules/playwright-core; export HS_PW
(cd "$site" && exec bunx vite --port 5199 --host 127.0.0.1 >"$out/vite.log" 2>&1) &
vite=$!
trap 'kill $vite 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -fs http://127.0.0.1:5199/robots.txt >/dev/null 2>&1 && break; sleep 0.5; done
node "$here/scripts/brand-parity/site.mjs" "$out/site.json" "$out/site.png"
(cd "$here" && bun scripts/brand-parity/ext.ts "$out/ext.json" "$out/ext.png")
node "$here/scripts/brand-parity/compare.mjs" "$out/site.json" "$out/ext.json"
