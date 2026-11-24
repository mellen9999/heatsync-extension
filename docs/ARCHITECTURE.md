# architecture

one page: what runs where, how `src/` becomes what the browser loads, and which
files are shared with heatsync.org.

## four places code runs

| where | what | talks to |
|---|---|---|
| background (`background.js` — a service worker on chrome, a background page on firefox) | the heatsync websocket (`src/background/05-ws.js`), twitch irc (`09-irc.js`), kick + youtube (`10-kick-yt.js`), auth, emotes, cosmetics, push | the content scripts through `chrome.runtime` messages; the network |
| isolated world (content scripts) | the multichat panel (`multichat-core.js`), native-chat changes (`content.js`), the heatsync button, vi mode, the youtube native surface | the background; the page through `window.postMessage`, custom events and data attributes on shared nodes |
| main world (page scripts) | what has to touch the site's own js: twitch's internals (`early-inject-main.js`), chat client (`twitch-chat-intercept.js`), callouts (`twitch-callout-token.js`) and autocomplete (`autocomplete-hook.js`), kick's chat and navigation (`kick-chat-intercept.js`, `kick-nav-watcher.js`), youtube's keys (`youtube-keyboard-guard.js`) and chat data (`yt-data-bridge.js`) | the isolated world through `window.postMessage`, custom events and data attributes |
| kick socket frame | `kick-socket-host.js` in one hidden web.kick.com frame (chrome: `offscreen.html`; firefox: the background page) — kick only accepts its chat socket from a kick.com page | the background through a `runtime.connect` port |

`src/manifests/chrome.json` (and `firefox.json`) say which file runs in which world, at which `run_at`, on which host. order inside one world and one `run_at` is manifest order — `emoji-data.iso.js` comes before `multichat-core.js` so the bundle can read `EMOJI_DATA` without embedding it.

## from src/ to dist/

```
src/
  background/   01-core.js … 11-boot.js → concatenated, in BG_PARTS order, into background.js
  multichat/    the panel: modules + main-*.js parts + *-host.js + main.js, styles/*.css
  content/      hand-written page and popup scripts (one file each)
  lib/          shared code, concatenated into bundles (LIB_ORDER, LIB_EXTRAS, the lists in readMultichatModules); the site copies that import have it stripped
  data/         emoji-data.js — the one dataset both shipped emoji-data copies are generated from
  chat/, utils/ module-resolution shims so tests can import site copies by their site paths; never shipped
  _locales/     34 languages — the source; build copies them out
  manifests/    chrome.json, firefox.json
chrome/         static html/css/icons + the generated manifest and _locales
dist/<browser>/ what the browser loads — build output only, never edited
```

`bun run build.js chrome` (or `firefox`) runs the source guards (versions, manifest parity, scope collisions, the parity checks below, no runtime deps, no dynamic code), then the unit tests (`--no-test` skips them, never with `--package`), then builds into `dist/<browser>.staging` and swaps it in only when every bundle parses.

- **one scope per bundle.** a bundle is files concatenated, not modules imported: `stripExports` removes `import`/`export`, so a later file sees an earlier file's top-level names. load order is file order — a part may read an earlier part's constants at load time, never a later one's. the build fails when a lib file and a multichat file both declare a `const`/`let` of the same name (`checkScopeCollisions`; a function/var clash only warns), and when a file in `src/multichat/` or `src/background/` is missing from its list.
- **`multichat-core.js`** — one bundle for twitch, kick and youtube: the lib it needs (the paint compiler, card libs, emote law and gif search among it), the multichat modules (`styles.js` among them, carrying the css from `styles/*.css`), the three hosts, `MAIN_PARTS`, then `main.js` (`CORE_MODULES` in `build.js`).
- **the thin content scripts** (`content.js`, `heatsync-button.js`, `youtube-content.js`, `autocomplete-hook.js`, `chat-injector.js`) get the core lib (`LIB_CORE`) plus only the lib files they name (`LIB_EXTRAS`). `verifyLibSlim` fails the build when a script starts using a lib file it does not embed. `ENTRY_MODULES` lets one embed a self-contained module the panel also uses — the filter rules engine, the close × glyph — so there is one copy of the logic.
- **`background.js`** cannot import lib/, so the few things it shares with content scripts (error scrubbing, the sync blocklist, user keys, reserved paths) are inlined and held equal by parity guards in `build.js`.
- **`--minify`** gives the release-sized bundle; `--package` turns it on. `bun scripts/check-bundle-budget.ts` holds every bundle under `scripts/bundle-budgets.json`; a raise carries its reason in the commit.

## shared with heatsync.org

these files are byte-for-byte copies of the site's. edit them in the site repo (private), then run `scripts/sync-site-copies.sh` or `scripts/sync-paint-compiler.sh` — the two scripts are the full list. `tests/site-copy-parity.test.js`, `tests/paint-compiler-parity.test.js` and their twins on the site fail when a copy drifts (in ci, or with `HS_REQUIRE_SITE=1`; a clone with no site beside it skips them).

| site | extension |
|---|---|
| `client/utils/gif-search-remote.js` | `src/lib/gif-search-remote.js` |
| `client/utils/emote-refs{,-normalize}.js` | `src/lib/emote-refs{,-normalize}.js` |
| `client/utils/stream-event-text.js` | `src/lib/stream-event-text.js` |
| `client/card/card-{time,model,render}.js` | `src/lib/card-{time,model,render}.js` |
| `public/css/modules/card.css` | `src/multichat/styles/20-card.css` |
| `public/css/brand-tokens.css` · `modules/brand-rows.css` | `src/multichat/styles/01-brand-tokens.css` · `21-brand-rows.css` |
| `shared/brand/tokens.gen.js` | `src/lib/brand-tokens.js` |
| `scripts/lib/{inline-doctrine,strip-comments}.mjs` | `tests/lib/…` (test helpers) |
| `shared/emote-{law,rank,usage}.ts`, `shared/emote-{law,mods}.vectors.json` | `shared/…` (the emote law and its vectors) |
| `tests/helpers/emote-world.ts` | `tests/helpers/emote-world.ts` |
| `client/utils/{paint-core,scene-spec,paint-spec,paint-authoring,plus-tenure,badge-catalogue}.js`, `client/cosmetics/{animation-phase,fill-layers,glyph-mask}.js`, `client/chat/stv-paint-css.js` | `src/lib/…` (the paint compiler and its runtime) |

four files go the other way: `src/multichat/{slash-registry,filter-rules,filter-rules-legacy,name-marks}.js` are ours, and the site vendors them with its `scripts/sync-ext-copies.sh`. the pre-push hook names the twin to land when one changes.

the server is the other shared surface: the extension and the site sync settings through one blob (`docs/SETTINGS-SYNC-MAP.md` in the site repo has the key map).

## where to look

- a guard failed in `build.js` → its message names the rule; the comment above the check says why it exists
- a test failed → `tests/` (bun test; `HS_SITE_DIR=<site checkout>` for the parity tests)
- what shipped when → `CHANGELOG.md`
