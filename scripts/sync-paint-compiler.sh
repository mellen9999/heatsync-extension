#!/usr/bin/env bash
# Copy the name-paint compiler from the site repo, VERBATIM.
#
# src/lib/{paint-core,scene-spec,paint-spec}.js are not this repo's code: they
# are the site's client/utils files, byte for byte, so the extension compiles
# the exact same CSS the site does for the exact same spec. Hand-mirroring
# drifted 1,300 lines in three weeks; this script plus the parity test
# (tests/paint-compiler-parity.test.js, and the site's mirror of it) is what
# keeps that from happening again. biome.json leaves these files unformatted
# for the same reason — a formatter pass would break byte parity.
#
#   scripts/sync-paint-compiler.sh            # from ../heatsync (or $HS_SITE_DIR)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
site=${HS_SITE_DIR:-$(cd "$here/../.." 2>/dev/null && pwd)/heatsync}
[ -d "$site/client/utils" ] || site=${HS_SITE_DIR:-/home/mellen/projects/heatsync}
[ -f "$site/client/utils/paint-spec.js" ] || { echo "sync-paint-compiler: site repo not found at $site (set HS_SITE_DIR)" >&2; exit 1; }
for f in paint-core scene-spec paint-spec; do
  cp "$site/client/utils/$f.js" "$here/src/lib/$f.js"
  echo "synced src/lib/$f.js ← $site/client/utils/$f.js"
done
