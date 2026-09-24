#!/usr/bin/env bash
# Copy the name-paint compiler AND its runtime from the site repo, VERBATIM.
#
# src/lib/{paint-core,scene-spec,paint-spec,animation-phase}.js are not this
# repo's code: they are the site's files, byte for byte, so the extension
# compiles the exact same CSS the site does for the exact same spec and runs it
# on the same clock. Hand-mirroring drifted 1,300 lines in three weeks; this
# script plus the parity test (tests/paint-compiler-parity.test.js, and the
# site's mirror of it) is what keeps that from happening again. biome.json
# leaves these files unformatted for the same reason — a formatter pass would
# break byte parity.
#
# animation-phase.js joined the mirror because the compiler alone is not enough
# to make two copies of a paint agree. The compiled `animation-delay` only
# phase-locks an animation that has never been paused, and both sides pause
# offscreen names for CPU — so both sides need the same restore. The extension
# had the compiler and not the restore, and drifted a name by exactly how long
# it had been scrolled away.
#
# fill-layers.js + glyph-mask.js are the composited fill's runtime half (the
# `fill` block's moving layers, masked to the name's own letterform — see
# utils/paint-spec.js's compositedFillPlan/buildFillLayersCss). Both are
# dependency-free leaves on the site (glyph-mask.js takes its logger by
# injection, never by import — see setLogger there), which is exactly what
# lets the extension take them verbatim like the compiler.
#
#   scripts/sync-paint-compiler.sh            # from ../heatsync (or $HS_SITE_DIR)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
site=${HS_SITE_DIR:-$(cd "$here/../.." 2>/dev/null && pwd)/heatsync}
[ -d "$site/client/utils" ] || site=${HS_SITE_DIR:-/home/mellen/projects/heatsync}
[ -f "$site/client/utils/paint-spec.js" ] || { echo "sync-paint-compiler: site repo not found at $site (set HS_SITE_DIR)" >&2; exit 1; }
# Site-relative paths, not bare names: these do not share one directory there.
for pair in \
  client/utils/paint-core.js \
  client/utils/scene-spec.js \
  client/utils/paint-spec.js \
  client/utils/paint-authoring.js \
  client/cosmetics/animation-phase.js \
  client/cosmetics/fill-layers.js \
  client/cosmetics/glyph-mask.js \
  client/utils/plus-tenure.js
do
  cp "$site/$pair" "$here/src/lib/$(basename "$pair")"
  echo "synced src/lib/$(basename "$pair") ← $site/$pair"
done
