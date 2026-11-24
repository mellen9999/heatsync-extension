# AMO review notes (paste-ready)

Reference for the Firefox Add-ons (AMO) submission. `scripts/publish.js` sends the
reproducible-build steps as approval notes on every release; the **Notes for Reviewers**
block below is for a manual submission or a reviewer's question, and the tables answer
per-permission prompts. Keep this in sync with `src/manifests/chrome.json` +
`src/manifests/firefox.json` when permissions change.

---

## Notes for Reviewers (paste verbatim)

```
heatsync is open source (MIT). The reviewed bundle can be reproduced, byte for
byte, from the attached heatsync-source-X.Y.Z.zip or the public repo at tag vX.Y.Z:

  repo:  https://github.com/mellen9999/heatsync-extension
  needs: bun, node and zip on the path
  build: bun install --frozen-lockfile
         bun run build.js firefox --package   # → dist/firefox/ + dist/heatsync-firefox-X.Y.Z.zip

NO REMOTE CODE. The shipped bundle contains no eval, new Function, importScripts,
or remotely-loaded scripts. Every third-party response (Twitch/Kick/YouTube,
7TV/BTTV/FFZ, chat-log APIs) is consumed strictly as DATA — JSON metadata,
images, and on kick.com the page's own stylesheet text (re-applied as CSS to
keep kick's layout intact) — never executed as code. (The only eval/new Function in the repository
live under tests/ and are not part of the package.)

DATA CATEGORIES (data_collection_permissions, Firefox 140+ so the built-in
consent covers every user). Required, because the extension cannot do its job
without them, and each leaves the browser on its own rather than on one command:
- authenticationInfo: the heatsync.org session and account, and the account
  data synced to it (emote inventory, blocked emotes, channel list, settings, private profile
  notes).
- personalCommunications: heatsync DMs (/api/dm), Twitch whispers sent through
  heatsync.org (/api/twitch/whisper), heatsync feed posts and replies, and the
  sent-line report described below.
- browsingActivity: which Twitch/Kick/YouTube channel is open, so heatsync.org
  can serve that channel's emotes, cosmetics, recent messages and live status
  and archive its public chat. Nothing outside those three sites.
- websiteContent: links posted in chat, sent for a link preview or embed.
Optional: technicalAndInteraction, the check-in below.

DATA HANDLING. No third-party tracking, no ad networks, no analytics SDK. We do
not collect browsing history outside the open channel, clickstream, or device
identifiers. Chat: the
public chat of channels the user opens is archived by heatsync.org's own server
(the browser never uploads it); for a line the user sends through heatsync, the
extension reports its message id and the emotes in it (on Twitch the text too,
to match Twitch's own echo; on Kick the text with the emotes, which the server
re-checks; neither text is stored), so other heatsync viewers see the user's emotes. One first-party
usage signal: a health/kill-switch poll to
heatsync.org (every 5 min + on startup) sends a rotating install id (changes
daily, cannot be joined across days), extension version, a rough install-age range (first day/week/month/older,
computed on-device), and which of
multichat/feed/dm/mentions were opened — merged server-side into a HyperLogLog
and discarded, aggregate counts kept 90 days. On Firefox the id and surfaces
are sent only with the optional technicalAndInteraction permission; without it
the poll still runs (the kill-switch must not depend on consent) but carries
neither. Full detail in the privacy policy
(https://heatsync.org/legal/privacy, "the extension check-in"). The user's emote
inventory, preferences, blocked-emote list and channel/tab list are stored in
browser.storage.local and, when signed in, synced to heatsync.org; display
preferences also sit in browser.storage.sync (Firefox Sync, if the user has it
on). The heatsync auth token is sealed with a non-extractable key. Twitch, Kick
and YouTube session cookies are read locally and sent only to their own site.
The user's Kick follow list is mirrored into their heatsync follows.
Also first-party: a chat link you hover or click is sent to heatsync.org
(/api/link-preview?url=), which fetches it server-side so your IP never reaches
the linked site. The extension also tells heatsync.org which channels are open
(twitch:chat:relay {channel}) so the public chat archive knows what to record.

WHY THE PERMISSIONS (summary; details below):
- cookies: read the user's EXISTING twitch.tv / kick.com / youtube.com /
  heatsync.org session cookies, to act on their behalf in chat (send messages,
  mod actions) and load their emote inventory — no second login; each site's
  cookies go only to that site.
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
| `storage` | persist the user's emote inventory, preferences, blocked-emote list, and channel/tab state (`browser.storage.local`; display preferences in `browser.storage.sync`). Synced to heatsync.org when signed in. |
| `unlimitedStorage` | an emote inventory holds up to 5,000 emotes plus cached image metadata and chat history, which can outgrow the default quota; keeps the browser from evicting the user's inventory. |
| `cookies` | read the user's EXISTING session cookies for **twitch.tv, kick.com, youtube.com and heatsync.org only**, to act on their behalf in chat (send messages, mod actions; YouTube mod actions are signed with the user's own session the way youtube.com signs them) and load their inventory without a second login. `cookies.onChanged` detects logout to clear local session state. Each site's cookies are sent only to that site. |
| `alarms` | periodic background work that survives the worker being unloaded: emote refresh, live polling, followed-users refresh, socket watchdogs, the health check-in, Kick follow sync, mute expiry. |
| `notifications` | desktop notifications: a followed channel going live, an @-mention (opt-in), and a heads-up when the signed-in heatsync account changes. |
| `offscreen` (Chrome only) | hosts one hidden web.kick.com frame that opens Kick's public chat socket (Kick only accepts it from a kick.com page); Firefox does the same from its background page. |

## Host permission justifications

| host(s) | why |
|---|---|
| `*.twitch.tv`, `api.twitch.tv` | read the public Twitch chat DOM, send chat/mod actions as the user. (native Twitch emote images load from `static-cdn.jtvnw.net` under the CSP's `img-src`, not a host permission.) |
| `kick.com`, `*.kick.com` | read public Kick chat, send chat/mod actions, render emotes. |
| `www.youtube.com` (incl. `/live_chat*`) | read public YouTube live-chat DOM for the multichat panel, fetch public oEmbed metadata to route chat to the correct tab, and send chat / mod actions as the user through youtube.com itself. |
| `heatsync.org` | sync the user's own emote inventory + account, and first-party proxy for recent-message history, chat-log archives, chatterino badges, pronouns, link previews and embeds (so those requests aren't made from the user's IP). |
| `7tv.io`, `api.7tv.app`, `api.betterttv.net`, `api.frankerfacez.com` | read-only public APIs for emote sets, paints, and badges. Only emote names and numeric user ids are sent (see the privacy policy). |

---

## Pre-submit checklist
- [ ] `src/manifests/firefox.json` version == the version being submitted (build.js guards this).
- [ ] attach `dist/heatsync-source-X.Y.Z.zip` (produced by `bun run build.js --package`).
- [ ] permissions in the tables above still match both manifests.
- [ ] data-collection form: MUST match `src/manifests/firefox.json` → `data_collection_permissions` and the DATA CATEGORIES list above: required authentication info, personal communications, browsing activity and website content; optional technical and interaction data (the check-in). All first-party to heatsync.org, none shared or sold, no third-party analytics. Never "no data collected". Twitch/Kick/YouTube cookies are read locally and never sent to us.
