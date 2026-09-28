# privacy policy

> **Canonical version:** https://heatsync.org/legal/privacy
> This file is a repo snapshot for offline review. The live version on
> heatsync.org is authoritative if the two ever differ.

**version 1.6 — september 2026**

## what we collect

the heatsync extension collects the following data:

- **authentication:** your heatsync account token (encrypted in browser storage)
- **user profile:** display name, user ID, multichat configuration
- **emotes:** your personal emote inventory and list of emotes you've blocked
- **channels:** names of Twitch, Kick, and YouTube channels you add to multichat
- **youtube video ids:** IDs of YouTube streams you join for real-time chat sync
- **ui preferences:** chat collapse state, tab order, visual settings
- **cosmetics:** cache of 7TV paints, FFZ/BTTV badges, and badge assignments for display purposes
- **health check-in:** a daily-rotating install id, your extension version, and which social surfaces (multichat/feed/dm/mentions) you've opened — sent with the periodic kill-switch poll, see "health / kill-switch poll" below

**we do not collect:** chat message content, browsing history, clickstream data, device identifiers, or any analytics/tracking beyond the aggregate health check-in described below.

## how it's used

- **emote sync:** your token is sent to heatsync.org to fetch your emotes and sync blocks across devices
- **cosmetics:** emote names and user IDs are sent to 7TV, FFZ, and BTTV to fetch visual styles and badges
- **username resolution:** channel or streamer names are sent to heatsync.org, which resolves them to numeric Twitch IDs server-side for cosmetic lookups
- **real-time chat:** channel names are sent to the heatsync WebSocket to enable live emote broadcasts
- **kick live chat:** your Kick chatroom ID is sent to Pusher (`wss://ws-us2.pusher.com`), Kick's real-time chat transport, to receive live messages
- **multichat routing:** YouTube video IDs help route live chat messages to the correct channel in your multichat panel
- **pronouns:** if enabled (on by default — toggle in settings → display → pronouns), a Twitch user's numeric ID is sent to pronoundb.org to fetch their self-declared pronouns for the profile card and hover tooltip. Twitch only; pronoundb has no Kick/YouTube platform

## health / kill-switch poll

every 5 minutes, and once when the browser starts the extension, it checks in with `heatsync.org/api/extension/health` — the kill switch that lets us disable a broken feature or force an update notice without waiting on a store review. the check-in sends:

- a random id that **rotates every UTC midnight** — it identifies your install for one day only and cannot be used to follow you across days
- your extension version
- the names of any surfaces (multichat/feed/dm/mentions) you opened since the last successful check-in

on firefox this is opt-in: it's listed under the optional "technical and interaction data" permission (about:addons → heatsync → permissions). without it the poll still runs — the kill switch has to — but sends no id, no version and no surfaces.

the server never stores the id itself: it's merged into a HyperLogLog (a data structure built to count distinct values without retaining the values that produced the count) and discarded. the resulting daily install/version/surface counts persist for 90 days, then auto-expire. no chat content, no browsing history, no cross-site identifier — just "how many installs checked in today" and "did any of them open the feed."

the extension acts on a third-party platform only when *you* explicitly initiate it — sending a chat message, setting your username color, creating a clip, following a channel, or (if you are a moderator) moderation actions like timeouts. it never acts autonomously or in the background, and never changes account settings you did not trigger.

## where it's stored

- **browser storage:** encrypted token, emote inventory, blocked emotes, channel names, video IDs, preferences — all stored in your browser's local extension storage using `browser.storage.local`
- **heatsync.org:** your account profile, emote inventory, and blocked emotes list (encrypted at rest)
- **7tv.io, frankerfacez.com, betterttv.net:** no storage — their APIs return cosmetics on-demand only
- **pusher (ws-us2.pusher.com):** no storage — Kick's real-time chat transport; receives your Kick chatroom ID to subscribe to live messages
- **pronoundb.org:** no storage on their end that we control; the extension caches the result in memory for 24h to avoid repeat lookups
- **heatsync.org (health check-in):** the rotating install id is never stored — it's folded into a HyperLogLog and discarded; only the resulting daily aggregate counts persist, for 90 days
- **twitch, kick:** no data collected — the extension reads Twitch/Kick's public chat DOM only
- **www.youtube.com:** YouTube channel handles and video IDs are sent only to fetch live-page metadata (oembed) so live-chat messages route to the correct multichat tab — no message content or viewer data is collected

## third-party services

the extension communicates with the following services. **no personal data is sold or shared.**

| service | data sent | purpose |
|---------|-----------|---------|
| heatsync.org | auth token, emote names, blocked IDs | fetch and sync your emotes |
| heatsync.org | channel names | real-time emote broadcasts via WebSocket |
| heatsync.org | chat/feed link URLs you hover or that appear in feed posts | proxy link previews and embed metadata so the request isn't made from your IP |
| 7tv.io | twitch/kick user IDs, emote names | fetch paint gradients and badges |
| api.7tv.app | search query string | resolve unknown emote names typed in tab-complete |
| frankerfacez.com (FFZ) | emote names (batch query) | fetch badge metadata |
| betterttv.net (BTTV) | emote names (batch query) | fetch badge metadata |
| heatsync.org | channel / streamer names, usernames | first-party proxy — resolves usernames→Twitch ID, fetches recent chat history, per-user log history, and Chatterino contributor badges server-side, so these requests aren't made from your IP (previously direct to decapi.me / robotty / ivr.fi / chatterino) |
| pusher (ws-us2.pusher.com) | Kick chatroom ID | Kick's real-time chat transport — receive live Kick chat messages |
| twitch.tv, kick.com | none — extension reads DOM only | display overlays in chat |
| www.youtube.com | YouTube channel handles + video IDs | fetch live-page metadata (oembed) to resolve channels and route live-chat messages |
| pronoundb.org | Twitch numeric user ID | look up self-declared pronouns for the profile card + hover tooltip (Twitch only). on by default — toggle off in settings → display → pronouns |
| heatsync.org | rotating daily install id, extension version, opened surface names (multichat/feed/dm/mentions) | health/kill-switch check-in, every 5 min — counts distinct installs and surface usage in aggregate; see "health / kill-switch poll" above for retention |

## what we don't collect

we **explicitly do not** collect:

- chat message text or user messages
- your browsing history or URLs visited
- cross-site or third-party ad tracking, tracking pixels, or tracking cookies
- device hardware specs, OS info, or system details
- Twitch, Kick, or YouTube account credentials

the one exception is the aggregate health check-in above (rotating daily id, version, opened surfaces) — it exists to run the kill switch and count installs, not to profile you, and the id can't be joined across days.

## user rights

**login/logout:** sign in to heatsync.org via the extension popup. signing out clears your token and disables emote sync.

**data export:** visit heatsync.org to export your account data (GDPR Article 20 right to portability).

**delete account:** visit heatsync.org account settings to request permanent deletion of your profile, emotes, and blocks.

**right to object:** you can block individual emotes per-channel or globally via the extension UI.

## data retention

- **token:** stored until you sign out; deleted automatically when extension is uninstalled
- **emote cache:** refreshed every 60 seconds; not persisted between browser sessions beyond what extension storage retains
- **cosmetics cache:** global cosmetics refreshed every 24 hours; channel cosmetics refreshed on-demand
- **chat history:** multichat messages are cached in memory only during your session; not written to disk
- **pronoun lookups:** cached in memory for 24h, then re-fetched on next hover
- **health check-in id:** never stored — merged into a daily HyperLogLog and discarded immediately; the resulting install/version/surface counts persist 90 days then auto-expire
- **server-side:** heatsync.org retains account data until you delete your account; see heatsync.org privacy policy for server retention details

## contact

**questions or concerns?** email **mellen@heatsync.org** or open a GitHub issue at [github.com/mellen9999/heatsync-extension](https://github.com/mellen9999/heatsync-extension/issues).

**report a privacy issue?** see [SECURITY.md](../SECURITY.md) for responsible disclosure.

## changes

we may update this policy. changes take effect immediately upon publication. continued use of the extension after changes means you accept the updated policy.
