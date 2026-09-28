# AMO review notes (paste-ready)

Reference for the Firefox Add-ons (AMO) submission. Paste the **Notes for Reviewers**
block below into the submission, and use the permission/host tables to answer any
per-permission prompts. Keep this in sync with `src/manifests/chrome.json` +
`src/manifests/firefox.json` when permissions change.

---

## Notes for Reviewers (paste verbatim)

```
heatsync is open source (MIT). The reviewed bundle can be reproduced from the
included source zip or the public repo:

  repo:  https://github.com/mellen9999/heatsync-extension
  build: bun install
         bun run build.js firefox      # → dist/firefox/
  (the matching dist/heatsync-source-X.Y.Z.zip is attached to this submission)

NO REMOTE CODE. The shipped bundle contains no eval, new Function, importScripts,
or remotely-loaded scripts. Every third-party response (Twitch/Kick/YouTube,
7TV/BTTV/FFZ, chat-log APIs) is consumed strictly as DATA — JSON metadata and
images — never executed as code. (The only eval/new Function in the repository
live under tests/ and are not part of the package.)

DATA HANDLING. No third-party tracking, no ad networks, no analytics SDK. We do
not collect chat message content, browsing history, clickstream, or device
identifiers. One first-party exception: a health/kill-switch poll to
heatsync.org (every 5 min + on startup) sends a rotating install id (changes
daily, cannot be joined across days), extension version, and which of
multichat/feed/dm/mentions were opened — merged server-side into a HyperLogLog
and discarded, aggregate counts kept 90 days. Full detail in PRIVACY.md
("health / kill-switch poll"). The user's emote inventory, preferences,
blocked-emote list, channel/tab list, and an ENCRYPTED auth token are stored
locally in browser.storage.local. Session cookies are read locally and never
transmitted to anyone other than their originating first party.

WHY THE PERMISSIONS (summary; details below):
- cookies: read the user's EXISTING twitch.tv / kick.com / heatsync.org session
  cookies only, to act on their behalf in chat (send messages, mod actions) and
  load their emote inventory — no second login, never sent off-device.
- tabs: coordinate the multichat panel across the user's own open stream tabs
  (query stream tabs, route chat to the right content script, clean up on close).
- broad hosts: render the user's emotes + read PUBLIC chat on Twitch/Kick/YouTube,
  and fetch emote/badge assets from public emote-provider CDNs (read-only).

Test account / how to exercise: install, then open any twitch.tv or kick.com
channel — emotes + the multichat panel work with no login (watch-only). To test
the emote inventory, sign in with the free Twitch/Kick OAuth at heatsync.org.
```

---

## Permission justifications

| permission | why it's needed |
|---|---|
| `storage` | persist the user's emote inventory, preferences, blocked-emote list, and channel/tab state locally (`browser.storage.local`). Nothing leaves the device. |
| `unlimitedStorage` | an emote inventory holds up to 5,000 emotes plus cached image metadata, which can exceed the 5 MB default quota; prevents the browser from evicting the user's inventory. |
| `tabs` | coordinate the multichat overlay across the user's own open stream tabs — `tabs.query` to find open Twitch/Kick/YouTube tabs, `tabs.sendMessage` to route chat to the right content script, `tabs.onRemoved` to tear down panel state when a stream tab closes. Not used to read history or unrelated tab content. |
| `cookies` | read the user's EXISTING first-party session cookies for **twitch.tv, kick.com, heatsync.org only**, to act on their behalf in chat (send messages, mod actions) and load their inventory without a second login. `cookies.onChanged` detects logout to clear local session state. Cookies are never transmitted off-device. |
| `alarms` | schedule periodic MV3 service-worker work (auth-token refresh, emote-cache refresh, websocket reconnect backoff) where `setInterval` is unavailable. |
| `notifications` | optional, user-controllable desktop notifications for @-mentions and whispers. |

## Host permission justifications

| host(s) | why |
|---|---|
| `*.twitch.tv`, `api.twitch.tv`, `static-cdn.jtvnw.net` | read the public Twitch chat DOM, send chat/mod actions as the user, load native Twitch emote images. |
| `kick.com`, `*.kick.com` | read public Kick chat, send chat/mod actions, render emotes. |
| `www.youtube.com` (incl. `/live_chat*`) | read public YouTube live-chat DOM for the multichat panel and fetch public oEmbed metadata to route chat to the correct tab. No YouTube cookies/auth used. |
| `heatsync.org` | sync the user's own emote inventory + account (first-party companion service). |
| `7tv.io`, `events.7tv.io`, `api.7tv.app`, `cdn.7tv.app`, `api.betterttv.net`, `cdn.betterttv.net`, `api.frankerfacez.com` | read-only public APIs/CDNs to fetch emote images, sets, paints, and badges. No user data sent. |
| `recent-messages.robotty.de`, `logs.ivr.fi`, `logs.zonian.dev`, `logs.spanix.team`, `decapi.me`, `api.chatterino.com/badges` | read-only public endpoints for recent-message history, channel chat-log archives, and community badges. Only public channel/user names are sent; no viewer data. |

---

## Pre-submit checklist
- [ ] `src/manifests/firefox.json` version == the version being submitted (build.js guards this).
- [ ] attach `dist/heatsync-source-X.Y.Z.zip` (produced by `bun run build.js --package`).
- [ ] permissions in the tables above still match both manifests.
- [ ] data-collection form: MUST match `src/manifests/firefox.json` → `data_collection_permissions` (declares `authenticationInfo`). Declare **authentication info collected + transmitted** to first-party heatsync.org for emote/account sync, plus synced account data (emote inventory, blocked emotes, channel names, ui prefs). Do NOT declare "no data collected" — the extension transmits the heatsync account token + inventory to heatsync.org and retains it server-side (see PRIVACY.md / table above, heatsync.org row). Also declare **technical and interaction data**, required, for the rotating-id health/kill-switch check-in (PRIVACY.md "health / kill-switch poll") — first-party, not shared. No third-party sharing, no third-party analytics/telemetry. Twitch/Kick cookies are read locally for identity and never sent to us.
