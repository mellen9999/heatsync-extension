#!/usr/bin/env bash
# Copy the site's own modules that the extension SHIPS, verbatim.
#
# Sibling of scripts/sync-paint-compiler.sh, which does the same job for the
# name-paint compiler and its runtime. Separate lists because they are separate
# contracts with separate reasons to exist — one script that syncs "some files"
# would tell a reader nothing about why any of them is here.
#
# src/lib/gif-search-remote.js is heatsync.org's gifs-tab fetch layer: the
# record shape the /api/gifs routes answer with, the TTL'd search cache, and the
# grid's keyboard model. The extension paints the same corpus in the same grid,
# so a hand-written second copy would be two answers to "what is a gif record"
# and one of them would go stale the first time the payload gained a field.
# The only seam is `base` — '' on the site, https://heatsync.org here.
#
# tests/site-copy-parity.test.js (and the site's mirror of it) is what makes
# this stick; biome.json leaves these files unformatted so a formatter pass
# cannot break byte parity.
#
#   scripts/sync-site-copies.sh            # from ../heatsync (or $HS_SITE_DIR)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
site=${HS_SITE_DIR:-$(cd "$here/../.." 2>/dev/null && pwd)/heatsync}
[ -d "$site/client/utils" ] || site=${HS_SITE_DIR:-/home/mellen/projects/heatsync}
[ -f "$site/client/utils/gif-search-remote.js" ] || { echo "sync-site-copies: site repo not found at $site (set HS_SITE_DIR)" >&2; exit 1; }
for pair in \
  client/utils/gif-search-remote.js
do
  cp "$site/$pair" "$here/src/lib/$(basename "$pair")"
  echo "synced src/lib/$(basename "$pair") ← $site/$pair"
done
