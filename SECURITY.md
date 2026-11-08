# security

## reporting a vulnerability

email **mellen@heatsync.org** with:

- a clear description of the issue
- steps to reproduce
- potential impact
- your preferred contact for follow-up

please don't open a public GitHub issue for security bugs. we'll acknowledge within 48 hours and aim to ship a fix within 7 days for critical issues.

## known design trade-offs

**MAIN world script** — `early-inject-main.js` runs at `document_start` in the page's JavaScript context (not the extension's isolated context) on twitch.tv. this is required to intercept twitch internals before react mounts. it means the script shares the page's JS scope and has no isolation from page scripts. we treat it as a known, intentional trade-off.

because a nonce cannot be kept secret in a realm shared with the page, the init nonce is frozen after its first setter (a page script cannot overwrite it to authenticate its own messages) and the privileged GraphQL proxies this script exposes are each constrained by an **explicit operation-name allowlist plus a per-window rate limit**. the allowlist covers only the extension's own actions — chat modes, send, ban / unban / delete, follow / unfollow, whisper, predictions, polls, and point redeems. a message forged by a co-resident page script can therefore only replay one of those allowlisted operations, rate-limited, with the user's token — it cannot run an arbitrary GraphQL query or reach any operation outside the allowlist. every one of those actions is still gated server-side by the user's own session and permissions (a ban only lands if the user is already a mod in that channel), so a replay can do nothing the user couldn't already do by hand. the operation allowlists (GQL + Apollo) live in `chrome/early-inject-main.js`. clip creation is not part of this proxy — it goes through heatsync.org's own authenticated API.

## scope

extension-side processing happens locally in the browser tab. the extension communicates with heatsync.org (emote sync, plus first-party proxying of username→id, recent-messages, and chatterino-badge lookups), directly with 7TV / FFZ / BTTV for cosmetics, and with pusher (`wss://ws-us2.pusher.com`) for kick's live-chat transport — see [the privacy policy](https://heatsync.org/legal/privacy) for the full data flow.

## permissions — and what we deliberately don't request

every permission maps to a specific feature; we request the minimum for a
cross-platform chat extension and nothing speculative.

| permission | why |
|---|---|
| `storage`, `unlimitedStorage` | store settings, emote inventory, and blocked-emote list locally (inventory can exceed the sync-storage per-item quota) |
| `cookies` | read your *own* httpOnly auth token on heatsync.org / twitch / kick to act on your behalf (send chat, follow, set color); content scripts cannot read httpOnly cookies, so this is the only mechanism |
| `alarms` | keep the background service worker's periodic tasks (emote refresh, live polling) alive after the SW is evicted |
| `notifications` | live-stream alerts you opt into |
| host permissions | inject the chat UI and fetch emote/cosmetic data on the platforms this extension is built for (twitch, kick, youtube, 7tv, ffz, bttv, heatsync.org) |

**we deliberately do NOT request:**

- `<all_urls>` — host access is an explicit allowlist, never "every site"
- `scripting` — no programmatic code injection; every content script is statically declared in the manifest and auditable
- `webRequest` — we never intercept, read, or modify your network traffic
- `tabs` — we call the tabs API only to message our own content scripts and open notification links; we do **not** hold the `tabs` permission. reading a tab's url/title is granted by our host allowlist alone, so we can never see tabs outside twitch/kick/youtube/heatsync.
- `management` — we cannot see or disable your other extensions
- `history`, `bookmarks`, `geolocation`, `clipboardRead` — none requested

## content-script defenses

- **`escapeHtml()`** wraps every user-supplied value (chat text, display names, emote names, profile fields, feed metadata) before it can reach `innerHTML` or `insertAdjacentHTML`. enforced in `src/lib/utils.js`. exception: feed post body text is HTML-escaped server-side before storage and is rendered as-is — re-escaping would double-encode entities.
- **`safeUrl()`** gates every url assigned to a link `href` or an iframe / embed `src` — the sinks where a `javascript:` / `data:` scheme could execute; only `http(s):` passes. media (`img` / `video`) `src` additionally pass through `escapeHtml()`.
- **`sanitizeColor()`** restricts user-supplied colors to `#rrggbb` / `#rgb` hex.
- **CSP**: extension pages declare `script-src 'self'; object-src 'none'` in both MV3 (`extension_pages`) and MV2 manifests — no inline eval, no remote scripts.
- **SSRF guard**: urls the content script asks the background to fetch (link previews, feed embeds) are validated in `chrome/background.js` (`fetch_link_preview` / `fetch_embed_resolve`) — `http(s):`-only, with a localhost / private-IP blocklist so the proxy can't be aimed at the local network.

## secrets and server-driven actions

- **token at rest** — the heatsync token kept in `storage.local` is sealed with AES-GCM under a non-extractable key held in IndexedDB. a copy of `storage.local` on its own (a diagnostics dump, a bug-report export, a backup of that one store) holds nothing usable, and no api hands the key's bytes out. it does not stop code already running in the extension, or someone holding your whole browser profile folder (the key's store lives there too). the browser's cookie jar stays the source of truth for the login; the blob is only the fallback. blobs from older builds are decrypted once and re-sealed at startup.
- **twitch login** — the twitch session cookie stays in the background worker. pages ask `twitch_auth_status` / `twitch_helix` and get an answer, not the token; the one path that still needs the raw login (the irc socket on kick / youtube pages) is limited to this extension's own content scripts on twitch, kick and youtube pages.
- **relayed sends** — when heatsync.org asks this browser to post a chat line to kick or youtube (`kick:relay_send`, `yt:relay_send`; the server fans these out to all your devices, so a phone can post through your desktop), the line only goes out with a request id not seen before, no repeat of the same text to the same place within 10 s, and the length / rate caps in `src/background/05-ws.js`. every relay, sent or refused, is a line in the worker log and a row in a local log (`hs_relay_log`, last 50) counted in the popup's error copy. residual risk: a compromised server can still post up to those caps; the real fix is a device-pairing key, with each relay signed by the originating device.
- **html sinks** — `tests/html-sink-ratchet.test.js` reads every `innerHTML` / `insertAdjacentHTML` / `createContextualFragment` / `DOMParser` / `srcdoc` write in `src/` and `chrome/*.js` and fails on any it cannot prove is built from constants and the escape helpers. the few it can't prove are listed with a count and a reason; the list can only shrink.

## build pipeline guards

- post-build `node --check` over every output bundle (catches template-literal termination bugs before zip).
- explicit backtick-count assertion on `src/multichat/styles.js` (its giant CSS template literal is a known foot-gun).
- minification runs `esbuild` with `keepNames: true` so stack traces in the wild are still legible.
