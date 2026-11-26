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
# client/utils/emote-refs.js is the one builder of a message's `emote_refs` (the
# vouch that lets viewers who do not own an emote still see it). Feed posts from
# the extension use it so they carry the same refs a site post does.
#
# client/card/{card-time,card-model,card-render}.js + public/css/modules/card.css
# are the one user-card model/renderer/formatter/stylesheet, shared by every
# card surface on both the site and the extension (hover tooltip, overlay full
# card, profile page, popout). Same reasoning: a hand-mirrored second copy is
# how a card row (followage, note, relationship) renders differently on the
# extension than on heatsync.org the first time either side changes shape.
# card.css lands as a numbered styles/ fragment (see src/multichat/styles.js)
# rather than src/lib/ — it's CSS, not a JS module the bundle concatenates.
#
# shared/brand/tokens.gen.js + public/css/brand-tokens.css + public/css/modules/brand-rows.css are the
# ONE brand layer (palette, fills, row metrics, the filled-row styles) — generated from the site's
# shared/brand/tokens.json; the site and the extension render rows from the same bytes.
#
# client/cosmetics/animated-texture.js is the sprite rung: an animated emote decoded ONCE into a strip and
# played on the wall clock, so every copy of it shows the same frame. Its one import is a logger, so the
# build embeds it inside a function scope that hands it one (scripts/lib/scope-site-module.mjs) — the
# bundle shares one scope and the file's own top-level names (frameNow, build, layout...) would collide.
#
# scripts/lib/{inline-doctrine,strip-comments}.mjs → tests/lib/: the inline-css doctrine scanner,
# so the site and the extension judge js-built style by the same rules.
#
# tests/site-copy-parity.test.js (and the site's mirror of it) is what makes
# this stick; biome.json leaves these files unformatted so a formatter pass
# cannot break byte parity.
#
# shared/emote-law.{ts,vectors.json} + shared/emote-rank.ts are the emote law (docs/emote-law.md on the
# site): the one rule for "which emote is this word". The vectors are its contract; the extension
# runs every case against its own copy (tests/emote-law-vectors.test.ts, which builds its worlds with
# tests/helpers/emote-world.ts, copied too). They keep the site's shared/ layout so the helper's
# own imports resolve unchanged. build.js transpiles the .ts into the multichat bundle.
#
# shared/emote-mark.{ts,vectors.json} is the picker tile's who-sees-it mark and its one-name-one-tile
# rule as law data (docs/emote-law.md, offer + tile mark): the extension's picker, Tab and tile words
# read tileSays through the law bundle (`hsEmoteLaw.tileSays`), and tests/emote-mark-vectors.test.ts
# runs every case against that same bundle.
#
# shared/emote-mods.vectors.json is the modifier rule as data (docs/emote-law.md, modifiers): what
# the words add up to and which emote a word changes. tests/emote-mods-vectors.test.js runs every
# row through the real row renderer.
#
# shared/emote-only.{ts,vectors.json} is the big-emote-line rule (docs/emote-law.md, "big emote-only
# lines"): a chat line of nothing but 1 to 5 pictures is drawn twice as big. The rule reads the law's
# read of the line, so processEmotes feeds it from what it already drew; tests/emote-only-vectors.test.ts
# runs every case, tests/big-emote-lines.test.js runs the same lines through the real row renderer.
# build.js bundles the .ts beside the law (scripts/lib/emote-law-bundle.mjs).
#
#   scripts/sync-site-copies.sh            # from ../heatsync (or $HS_SITE_DIR)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
site=${HS_SITE_DIR:-$(cd "$here/../.." 2>/dev/null && pwd)/heatsync}
[ -d "$site/client/utils" ] || site=${HS_SITE_DIR:-/home/mellen/projects/heatsync}
[ -f "$site/client/utils/gif-search-remote.js" ] || { echo "sync-site-copies: site repo not found at $site (set HS_SITE_DIR)" >&2; exit 1; }
for pair in \
  client/utils/gif-search-remote.js:src/lib/gif-search-remote.js \
  client/utils/emote-refs.js:src/lib/emote-refs.js \
  client/utils/emote-refs-normalize.js:src/lib/emote-refs-normalize.js \
  client/utils/stream-event-text.js:src/lib/stream-event-text.js \
  client/cosmetics/animated-texture.js:src/lib/animated-texture.js \
  client/card/card-time.js:src/lib/card-time.js \
  client/card/card-model.js:src/lib/card-model.js \
  client/card/card-render.js:src/lib/card-render.js \
  public/css/modules/card.css:src/multichat/styles/20-card.css \
  public/css/brand-tokens.css:src/multichat/styles/01-brand-tokens.css \
  public/css/modules/brand-rows.css:src/multichat/styles/21-brand-rows.css \
  shared/brand/tokens.gen.js:src/lib/brand-tokens.js \
  scripts/lib/inline-doctrine.mjs:tests/lib/inline-doctrine.mjs \
  scripts/lib/strip-comments.mjs:tests/lib/strip-comments.mjs \
  shared/emote-law.ts:shared/emote-law.ts \
  shared/emote-rank.ts:shared/emote-rank.ts \
  shared/emote-usage.ts:shared/emote-usage.ts \
  shared/emote-mark.ts:shared/emote-mark.ts \
  shared/emote-law.vectors.json:shared/emote-law.vectors.json \
  shared/emote-mark.vectors.json:shared/emote-mark.vectors.json \
  shared/emote-mods.vectors.json:shared/emote-mods.vectors.json \
  shared/emote-only.ts:shared/emote-only.ts \
  shared/emote-only.vectors.json:shared/emote-only.vectors.json \
  tests/helpers/emote-world.ts:tests/helpers/emote-world.ts
do
  src_rel="${pair%%:*}"
  dst_rel="${pair##*:}"
  cp "$site/$src_rel" "$here/$dst_rel"
  echo "synced $dst_rel ← $site/$src_rel"
done
