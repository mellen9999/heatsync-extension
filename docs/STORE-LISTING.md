# Store listing — source of truth (CWS + AMO)

Paste-ready copy + the per-store gotchas. Keep in sync with `chrome/_locales/en/messages.json`
(`manifest_name`, `manifest_description`) and the live dashboards. See
[AMO-REVIEW-NOTES.md](./AMO-REVIEW-NOTES.md) for reviewer notes + permission justifications.
Competitive claims (slots, size, platform gaps vs 7tv/bttv/ffz) come from
[POSITIONING.md](./POSITIONING.md) — verified facts only, recheck externals before use.

## Positioning rule (2026-07-25) — multichat leads, always
Store search is keyword-driven off name + short description. "heatsync" alone matches nothing
anyone types. Every listing field now carries `twitch`, `kick`, `youtube`, `chat`.

Multichat leads because it is the only claim that pays off **with zero coordination** — one
user alone gets the full value on install. Portable emotes are real but partly social: an
emote only you can see is worth less than one the room sees, so it cannot carry the headline.
Multichat is also the one thing 7tv's extension does not do at all (see POSITIONING.md).

**Never market permissions, code quality, or security.** We lose that comparison on the only
surface a user sees — see POSITIONING.md "permission surface". Trust copy stays a footer line.

## Name (localized — `manifest_name`, all 34 locales, CWS max 75)
Toolbar/UI name stays bare `heatsync` via manifest `short_name` in both MV3 + MV2 — the long
name is store-facing only.
```
heatsync — twitch, kick + youtube in one chat
```

## Short description (localized — `manifest_description`, 120 chars)
Used as the Chrome Web Store short description (CWS limit 132 — this fits) and the
Firefox add-on manifest description. **Current en value:**
```
one panel for twitch, kick + youtube live chat. plus a free 5,000-slot emote inventory that follows you into any channel
```

## AMO Summary (dashboard, ≤250 — 224 chars, paste-ready)
```
twitch, kick + youtube live chat in one tabbed panel — per-channel tabs, mentions, whispers, no account needed to read. plus your own emotes in any channel: 5,000 free slots, one-click 7tv/bttv/ffz import. free, open source.
```

## AMO / CWS Description (long — timeless; identical for both stores. refined 2026-07-11, paste-ready)
No versions, sizes, or dates in copy — only claims that hold across releases
(5,000 comes from `src/lib/config.js`, stable). Verified against POSITIONING.md.
```
twitch, kick + youtube live chat in one panel — read every stream you follow and reply into any of them without alt-tabbing. nobody else has to install anything. plus your own emotes in any channel: 5,000 free slots, no sub, no streamer setup. free.

• cross-platform multichat — twitch, kick + youtube live chat in one tabbed panel: per-channel tabs, mentions, twitch whispers, resizable + dockable to any edge. no account needed to read.

• your emotes, any channel — upload or import any emote (7tv, bttv, ffz, or your own) into a free 5,000-slot inventory. tab-complete a name and send — it renders in twitch + kick native chat and the overlay, any channel. one click imports a whole channel's emotes.

• 7tv / bttv / ffz — emotes, paints + badges render automatically, channel and global. runs alongside those extensions — this adds the portable emotes and cross-platform chat they don't do.

• keyboard-first — vim keybindings on twitch, kick + the panel, wysiwyg emote composer, message history, reply threading, instant filter of the live buffer by text or user.

• moderation + profiles — hover mod toolbar (ban/timeout/unban/delete), client-side automod, mute or block that carries a user across twitch and kick, profile cards with a searchable chat-log archive, one-click twitch clips.

free · open source (MIT) · no trackers, no analytics · your emotes stay yours
```

## Tags / categories
- Category: Social & Communication
- **Tags — add `kick`, `emotes`, `7tv` (kick is a core platform but is currently missing):**
```
chat, streaming, twitch, kick, youtube, emotes, 7tv
```

## Known issues / decisions
- **AMO listing APPROVED + live; copy applied 2026-07-11:** refined en-US summary +
  description above are LIVE on the public page (verified). Tags = `chat, social media,
  streaming, twitch, youtube` — AMO tags are a fixed vocabulary; `kick`/`emotes`/`7tv`
  don't exist, this is the best available set. Non-en AMO summaries still carry the older
  framing (only en-US updated).

  **RESOLVED 2026-08-25 — the two paragraphs that used to sit here were both stale
  and one of them cost an audit a false finding. Do not reinstate them.**

  This said "listed version still 1.6.8". It is not. The live AMO API reports the
  listed add-on `heatsync-chat` on **1.7.64**, matching the shipped manifest:

  ```
  curl -s "https://addons.mozilla.org/api/v5/addons/search/?q=heatsync&app=firefox"
  # heatsync-chat | ver 1.7.64 | users 2 | ratings 0
  ```

  It also carried a **GOTCHA** claiming release.yml burns the clean version number
  on the unlisted channel so it "can never become the listed version". release.yml
  has since been reworked to prevent exactly that — it signs the self-distributed
  build as `X.Y.Z.1` specifically to reserve `X.Y.Z` for the listed channel
  (see its own comment block). Nothing is blocking a listed submission.

  **What is actually true:** the listing is current, and it is not the problem —
  2 average daily users and 0 ratings against a correct, up-to-date store page is a
  reach problem, not a listing one. That is what Act III exists to fix; see
  `heatsync/docs/shelf-submissions.md`.
- **Repositioned multichat-first (2026-07-25):** all 34 locales' `manifest_name` +
  `manifest_description` rewritten to lead with multichat (was emote-first). Each verified
  ≤132 chars (name ≤75), valid JSON, brand tokens present (Twitch/Kick/YouTube/5000).
  Machine-authored from each locale's existing vocabulary — a native spot-check on the
  non-Latin scripts (ar, he, hi, th) before the tag is prudent but not blocking.
  `manifest_name` is no longer bare "heatsync": store search reads the name field, and the
  toolbar/UI name is already pinned to "heatsync" by `short_name` in both MV3 and MV2, so the
  long name costs nothing in-product. Supersedes the 2026-06-23 "leave it bare" call.
  Non-en AMO/CWS dashboard summaries still carry the old emote-first framing — en only.
- AMO listed version is behind: submit **current release** (1.7.21 as of 2026-07-11; listing was on 1.6.8).

## Pre-release / pre-submit checklist
- [ ] `bun run build.js --package` green (build + node --check + zips + source zip + tests) — verified 1.7.5: 552 tests pass.
- [ ] CWS: short description auto-from manifest (118 chars, OK); paste long description above; set tags.
- [ ] AMO: submit 1.7.5; attach `dist/heatsync-source-1.7.5.zip`; paste AMO-REVIEW-NOTES "Notes for Reviewers"; add `kick`/`emotes`/`7tv` tags; data form must MATCH the manifest `data_collection_permissions` (declares `authenticationInfo`) — declare **authentication info collected + transmitted** to first-party heatsync.org for emote/account sync; plus the synced account data (emote inventory, blocked emotes, channel names, ui prefs). NOT "no data collected" — that contradicts the manifest + PRIVACY.md (server-side retention). no third-party sharing, no analytics/telemetry. twitch/kick cookies are read locally and never sent to us.
