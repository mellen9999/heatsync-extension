# architecture

one page: what runs where, how `src/` becomes what the browser loads, and which
files are shared with heatsync.org.

## three places code runs

| where | what | talks to |
|---|---|---|
| service worker (`background.js`) | the heatsync websocket (`src/background/05-ws.js`), twitch irc (`09-irc.js`), kick + youtube (`10-kick-yt.js`), auth, emotes, cosmetics, push | the content scripts through `chrome.runtime` messages; the network |
| isolated world (content scripts) | the multichat panel (`multichat-core.js`), native-chat changes (`content.js`), the heatsync button, vi mode, the youtube native surface | the service worker; the page through `window.postMessage` |
| main world (page scripts) | what has to touch the site's own js: twitch's chat client (`twitch-chat-intercept.js`), kick's (`kick-chat-intercept.js`), youtube's data (`yt-data-bridge.js`), native autocomplete (`autocomplete-hook.js`) | the isolated world through `window.postMessage` only |

`src/manifests/chrome.json` (and `firefox.json`) say which file runs in which world, at which `run_at`, on which host. order inside one world and one `run_at` is manifest order — `emoji-data.iso.js` comes before `multichat-core.js` so the bundle can read `EMOJI_DATA` without embedding it.

## from src/ to dist/

```
src/
  background/   01-core.js … 11-boot.js → concatenated, in BG_PARTS order, into background.js
  multichat/    the panel: modules + main-*.js parts + *-host.js + main.js, styles/*.css
  content/      hand-written page and popup scripts (one file each)
  lib/          shared code with no imports, concatenated into bundles (LIB_ORDER)
  _locales/     34 languages — the source; build copies them out
  manifests/    chrome.json, firefox.json
chrome/         static html/css/icons + the generated manifest and _locales
dist/<browser>/ what the browser loads — build output only, never edited
```

`bun run build.js chrome` (or `firefox`) runs the tests, the source guards, then builds into `dist/<browser>.staging` and swaps it in only when every bundle parses.

- **one scope per bundle.** a bundle is files concatenated, not modules imported: `stripExports` removes `import`/`export`, so a later file sees an earlier file's top-level names. load order is file order — a part may read an earlier part's constants at load time, never a later one's. the build fails on a name declared twice (`checkScopeCollisions`) and on a file in a source dir that no list names.
- **`multichat-core.js`** — one bundle for twitch, kick and youtube: the full lib, the multichat modules, the css from `styles/*.css`, `MAIN_PARTS`, the three hosts, then `main.js`.
- **the thin content scripts** (`content.js`, `heatsync-button.js`, `youtube-content.js`, `autocomplete-hook.js`, `chat-injector.js`) get the core lib (`LIB_CORE`) plus only the lib files they name (`LIB_EXTRAS`). `verifyLibSlim` fails the build when a script starts using a lib file it does not embed. `ENTRY_MODULES` lets one embed a self-contained module the panel also uses — the filter rules engine, the close × glyph — so there is one copy of the logic.
- **`background.js`** cannot import lib/, so the few things it shares with content scripts (error scrubbing, the sync blocklist, user keys, reserved paths) are inlined and held equal by parity guards in `build.js`.
- **`--minify`** is the release build. `bun scripts/check-bundle-budget.ts` holds every bundle under `scripts/bundle-budgets.json`; a raise carries its reason in the commit.

## shared with heatsync.org

these files are byte-for-byte copies of the site's. edit them in the site repo, then run `scripts/sync-site-copies.sh` (the paint compiler: `scripts/sync-paint-compiler.sh`). `tests/site-copy-parity.test.js` and its twin on the site fail when a copy drifts.

| site | extension |
|---|---|
| `client/utils/gif-search-remote.js` | `src/lib/gif-search-remote.js` |
| `client/utils/emote-refs.js` | `src/lib/emote-refs.js` |
| `client/utils/stream-event-text.js` | `src/lib/stream-event-text.js` |
| `client/card/card-{time,model,render}.js` | `src/lib/card-{time,model,render}.js` |
| `public/css/modules/card.css` | `src/multichat/styles/20-card.css` |
| `public/css/brand-tokens.css` · `modules/brand-rows.css` | `src/multichat/styles/01-brand-tokens.css` · `21-brand-rows.css` |
| `shared/brand/tokens.gen.js` | `src/lib/brand-tokens.js` |
| `scripts/lib/{inline-doctrine,strip-comments}.mjs` | `tests/lib/…` (test helpers) |

the server is the other shared surface: the extension and the site sync settings through one blob (`docs/SETTINGS-SYNC-MAP.md` in the site repo has the key map).

## where to look

- a guard failed in `build.js` → its message names the rule; the comment above the check says why it exists
- a test failed → `tests/` (bun test; `HS_SITE_DIR=<site checkout>` for the parity tests)
- what shipped when → `CHANGELOG.md`
