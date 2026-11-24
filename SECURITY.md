# security

## reporting a vulnerability

email **mellen@heatsync.org** with:

- a clear description of the issue
- steps to reproduce
- potential impact
- your preferred contact for follow-up

please don't open a public GitHub issue for security bugs. we'll acknowledge within 48 hours and aim to ship a fix within 7 days for critical issues.

## known design trade-offs

**MAIN world scripts** — five content-script groups run in the page's own JavaScript context, not the extension's isolated one: `early-inject-main.js` at `document_start` on twitch (it has to reach twitch's internals before react mounts), twitch's chat, autocomplete and callout hooks, kick's navigation and chat taps, youtube's keyboard guard, and youtube chat's data bridge (`src/manifests/chrome.json`, `"world": "MAIN"`). they share the page's scope and have no isolation from its scripts. we treat that as a known, intentional trade-off.

because a nonce cannot be kept secret in a realm shared with the page, the init nonce is frozen after its first setter (a page script cannot overwrite it to authenticate its own messages) and the privileged GraphQL proxies this script exposes are each constrained by an **explicit operation-name allowlist plus a per-window rate limit**. the allowlist covers only the extension's own actions — sending chat and announcements, ban / unban / delete, mod and vip changes, follow / unfollow, whispers, raids, followers-only mode, predictions, polls, channel-point claims and redeems, and sharing a resub. a message forged by a co-resident page script can therefore only replay one of those allowlisted operations, rate-limited, with the user's token — it cannot run an arbitrary GraphQL query or reach any operation outside the allowlist. every one of those actions is still gated server-side by the user's own session and permissions (a ban only lands if the user is already a mod in that channel), so a replay can do nothing the user couldn't already do by hand. the operation allowlists (GQL + Apollo) live in `src/content/early-inject-main.js`. clip creation is not part of this proxy — it goes through heatsync.org's own authenticated API.

## scope

extension-side processing happens in the browser. the extension talks to:

- **heatsync.org** — your account, inventory and settings sync; first-party proxies for username→id, recent messages, chatterino badges, pronouns, link previews and embeds; your kick follow list, mirrored into your heatsync follows; and, for a line you send through heatsync, its message id and the emotes it used (the text too on twitch, and on kick when the line has emotes — used to match twitch's echo or check the emotes, never stored), so other heatsync viewers see them and the [H] mark
- **7TV / FFZ / BTTV** directly, for emotes, paints and badges
- **twitch, kick and youtube** themselves — including kick's own chat socket (`wss://*.platform.kick.com`), opened from a hidden web.kick.com frame because kick only accepts that socket from a kick.com page

[the privacy policy](https://heatsync.org/legal/privacy) has the full data flow.

## permissions — and what we deliberately don't request

every permission maps to a specific feature; we request the minimum for a
cross-platform chat extension and nothing speculative.

| permission | why |
|---|---|
| `storage`, `unlimitedStorage` | keep settings, the emote inventory, the blocked-emote list and caches locally (the inventory can exceed the sync-storage per-item quota). display settings sit in `storage.sync`, which the browser's own sync carries between your devices if you have it on |
| `cookies` | read your *own* logins to act on your behalf: heatsync.org's httpOnly session (content scripts cannot read it), twitch and kick (send chat, follow, mod actions, set color), and youtube (mod actions are signed with your own session, the way youtube's page signs them). each platform's cookies go only to that platform, never to heatsync |
| `alarms` | run periodic work after the worker is evicted: emote refresh, live polling, follows refresh, socket watchdogs, the health check-in, kick follow sync, mute expiry |
| `notifications` | desktop notifications: a channel you follow going live, an @-mention (opt-in), and a heads-up when the signed-in account changes |
| `offscreen` (chrome only) | hosts the one hidden web.kick.com frame that opens kick's chat socket. it runs no other code, shows nothing, and closes when no kick channel is being read. firefox does the same from its background page |
| host permissions | inject the chat UI and fetch emote/cosmetic data on the platforms this extension is built for (twitch, kick, youtube, 7tv, ffz, bttv, heatsync.org) |

**we deliberately do NOT request:**

- `<all_urls>` — host access is an explicit allowlist, never "every site"
- `scripting` — no programmatic code injection; every content script is statically declared in the manifest and auditable
- `webRequest` — we never intercept, read, or modify your network traffic
- `tabs` — we do **not** hold the `tabs` permission. the tabs api is used to message our own content scripts, open notification links and the welcome page, and run the pinned background tab that relays a send to kick or youtube when no tab of theirs is open. reading a tab's url/title is granted by our host allowlist alone, so we can never see tabs outside twitch/kick/youtube/heatsync.
- `management` — we cannot see or disable your other extensions
- `history`, `bookmarks`, `geolocation`, `clipboardRead` — none requested

## content-script defenses

- **`escapeHtml()`** wraps every user-supplied value (chat text, display names, emote names, profile fields, feed metadata) before it can reach `innerHTML` or `insertAdjacentHTML`. enforced in `src/lib/utils.js`. exception: feed post body text is HTML-escaped server-side before storage and is rendered as-is — re-escaping would double-encode entities.
- **`safeUrl()`** gates every url assigned to a link `href` or an iframe / embed `src` — the sinks where a `javascript:` / `data:` scheme could execute; only `http(s):` passes. media (`img` / `video`) `src` additionally pass through `escapeHtml()`.
- **colors** — the panel's `sanitizeColor()` takes `#` + 3–6 hex digits and nothing else; native chat's `COLOR_RE` (`src/content/content.js`) takes hex, numeric `rgb()` / `rgba()` or a bare color word, so a color can never carry a second css declaration (`tests/content-color-gate.test.js`).
- **CSP**: extension pages declare `default-src 'self'; script-src 'self'; object-src 'none'` with explicit `connect-src` / `img-src` allowlists in both manifests, plus `require-trusted-types-for 'script'` on chrome — no inline eval, no remote scripts.
- **SSRF**: link previews and embeds are never fetched by the browser. `src/background/07-handle-message.js` (`fetch_link_preview` / `fetch_embed_resolve`) passes only `http(s):` urls on to heatsync.org, whose server fetches them behind a DNS-resolving private-address guard; link previews also refuse localhost / private hosts in the worker.

## secrets and server-driven actions

- **token at rest** — the heatsync token kept in `storage.local` is sealed with AES-GCM under a non-extractable key held in IndexedDB. a copy of `storage.local` on its own (a diagnostics dump, a bug-report export, a backup of that one store) holds nothing usable, and no api hands the key's bytes out. it does not stop code already running in the extension, or someone holding your whole browser profile folder (the key's store lives there too). the browser's cookie jar stays the source of truth for the login; the blob is only the fallback. blobs from older builds are decrypted once and re-sealed at startup.
- **twitch login** — off twitch, the twitch session cookie stays in the background worker: kick and youtube pages ask `twitch_auth_status` / `twitch_helix` and get an answer, not the token, and the one path that needs the raw login (the irc socket on those pages) is limited to this extension's own content scripts. on twitch.tv itself the page already holds the cookie, and our scripts there read it from `document.cookie` like twitch does.
- **relayed sends** — when heatsync.org asks this browser to post a chat line to kick or youtube (`kick:relay_send`, `yt:relay_send`; the server fans these out to all your devices, so a phone can post through your desktop), the line only goes out with a request id not seen before, no repeat of the same text to the same place within 10 s, and the length / rate caps in `src/background/05-ws.js`. every relay, sent or refused, is a line in the worker log and a row in a local log (`hs_relay_log`, last 50) counted in the popup's error copy. residual risk: a compromised server can still post up to those caps; the real fix is a device-pairing key, with each relay signed by the originating device.
- **html sinks** — `tests/html-sink-ratchet.test.js` reads every `innerHTML` / `insertAdjacentHTML` / `createContextualFragment` / `DOMParser` / `srcdoc` write in `src/` and fails on any it cannot prove is built from constants and the escape helpers. the few it can't prove are listed with a count and a reason; the list can only shrink.

## build pipeline guards

- post-build `node --check` over every output bundle (catches template-literal termination bugs before zip).
- the stylesheet is embedded with every backtick and `${` escaped, so css text can never close the template literal it rides in.
- minification runs `esbuild` with `keepNames: true` so stack traces in the wild are still legible.
