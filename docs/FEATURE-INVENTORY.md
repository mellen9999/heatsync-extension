# heatsync extension — feature inventory & "what we already have"

> read this BEFORE auditing for gaps. on 2026-06-13 a 4-agent research sweep
> over-reported missing features and bugs that turned out to already exist or
> be intentional. this doc is the verified ground truth so future research
> doesn't re-pitch phantom gaps. verify against code before claiming anything
> is missing — `file:line` or it didn't happen.

## what it is

viewer emote sovereignty: a 5,000-slot personal emote inventory (uploaded on
heatsync.org) that renders in native twitch/kick/youtube chat — no streamer
approval, no sub required — plus a unified multichat overlay that aggregates
all three platforms. ~82k loc, zero runtime deps (esbuild is the only build
dep), tests green.

## already have — DO NOT re-report these as gaps

verified present in code on 2026-06-13:

- **chat search** — `#hs-mc-search-bar` + input/spinner/results, fully wired
  (`main.js:3409`+, styled `styles.js:6569`+). NOTE: currently queries the
  **server feed** (`/api/search?mode=messages`) and only shows on the
  **mentions** tab. it does NOT search the live in-memory buffer — see "real
  gaps".
- **kick native-chat emote rendering** — content.js renders heatsync/3p emotes
  into kick's own chat via the mixed-leaf path (`content.js:5404`,
  `span.font-normal` text leaves). not overlay-only.
- **block fails loud** — `pcToggleBlock` (`profile-card.js:1004`+) has
  optimistic UI + revert + `showToast('block failed…','error')` on real
  failure. it is NOT a silent-failure feature. (server endpoint existence is
  a separate heatsync-ash concern.)
- **cross-platform follow queues on failure** — `propagateFollow`
  (`cross-follow.js:195`) internally `_enqueue`s queueable failures
  (`:209,:233`) to `hs_pending_follows`, drained on next platform tab nav. the
  `.catch(()=>{})` at call sites is just a final safety net — not a dropped error.
- **no dead code / no TODOs** — gigantify, bigEmoji, autoAnchor, feedEngagement,
  heatReact all fully removed. no orphan remnants. zero TODO/FIXME/HACK markers.
- **xss paths are escaped** — chat `innerHTML` goes through
  `processEmotes(escapeHtml(...))`; postMessage handlers check origin; bg
  onMessage validates sender. `renderFeedContent` intentionally skips escape
  (server pre-escapes) — that's a documented trust boundary, not a live bug.

## feature inventory (grouped)

**emotes** — 5,000-slot server-side inventory; tab-complete + wysiwyg in native
twitch/kick/yt inputs; auto-add-on-send (ext only); zero-width/overlay stacking;
picker button beside native input (virtual-scroll grid, recent row, 7tv/bttv/ffz
search); per-emote right-click block/unblock (shift+right-click menu: block, remove
from set, provider links, copy); content-warning
category filters; animated/static toggle; size 1x/2x/4x.

**native chat decoration** — 7tv/bttv/ffz emotes in twitch+kick chat; 7tv paints;
bttv/ffz/chatterino badges; @mention tint; compact input; strikethrough deleted;
~25 css noise-hide toggles (channel points, hype train, bits, drops, polls,
predictions, upsells, etc); auto-claim channel points.

**multichat overlay** — tabbed panel (feed/whispers/mentions/pinned/live);
per-tab platform filters; resizable + dockable 4 edges; `\` toggle; font picker
(cozette 13px / gohu 14px / mono / platform / custom); density/zebra/timestamps/
avatars/[T][K][Y] row badges; first-chatter glow; readable-names; dom-row cap
100–1500 (default 500); 1500-entry circular buffer.

**social feed** — heatsync posts from follows + heat-sorted discovery; composer
(text+yt/twitch/kick embeds); like/reply/pin; trending tags+profiles; heat-score
display (6 tiers); went-live moment alerts; cross-follow propagation (twitch gql
+ kick relay).

**twitch events** — inline banners (live/offline/game/raid/hypetrain/giftsubs/
redeems/predictions/polls, each toggleable); predictions+polls UIs; tab-title
flash + desktop notif on mention; mention sound (webaudio); seen-state synced
server-side across tabs/devices; hermes eventsub ws intercept.

**whispers** — full twitch whisper timeline via eventsub ws; irc+eventsub dedup;
500-cap; unread badge; seen-state synced.

**moderation** — hover mod toolbar (delete/timeout tiers/ban/unban, configurable);
unified right-click ctx menu (mute/block/block-emote/profile/logs/copy); user
mute (kick↔twitch alias cross-mute, timed, ws-synced); user block; client automod
(caps + custom regex); hide bots/commands/dupes/keywords; show-cleared-messages.

**profile cards** — rich card (banner/avatar/subs/stats/linked accounts/
follow); clip creation; chat-logs panel (paginated archive, search-within,
permalinks); quick-links (sub/clip/popout/modview/dashboard deep-links).

**chat archive** — recent-messages load on join (robotty, 1k); historical log
viewer (justlog multi-host fallback ivr.fi→zonian→spanix).

**input** — wysiwyg emote composer; msg history (50, up/down); vi-mode (normal/
insert, motions w/b/e/f/t, operators d/c/y, counts, `.` repeat, undo/redo) on all
inputs; reply threading [RE]; kick send via bg tab relay; twitch send via auth
irc (25 NOTICE→toast codes); anonymous presence mode.

**stream stats** — per-channel msg/mention/chatter/emote counters; summary card
on stream:offline.

**settings** — 7 subtabs (display/chat/notifs/mod/filters/tweaks/system);
declarative schema (`settings-schema.js`, pure data); 5 presets (minimal/
power-user/emotes-only/moderator/low-ram); subsystem disable panel; keyword
search; local error ring-buffer; i18n 35 langs + rtl.

## platform depth

| platform | depth |
|---|---|
| twitch | deep — native render, wysiwyg tab-complete, picker, slate autocomplete hook, hermes eventsub (predictions/polls/raids/subs/redeems), irc read + auth send, profile cards + gql, clips, auto-claim points, mod toolbar, archive |
| kick | medium-deep — native render (mixed-leaf), kick autocomplete hook, ws chat in overlay, send via bg relay (xsrf+cookie), 7tv-by-kick-id, nav watcher, profile cards |
| youtube | shallow-med — live_chat iframe content script, emote overlay, autocomplete, dom extraction, pace-smoothing, send relay; no event banners |
| heatsync.org | oauth handoff (auth_token query param → bg) |

## integrations

heatsync.org (ws primary: inventory/mutes/seen-state/stream events/heat moments/
settings/killswitch + many rest endpoints incl `/api/search`, `/api/7tv` proxy,
`/api/link-preview`, `/api/embed/resolve`) · 7tv (v3 rest+gql+ws, proxied when
ip-blocked) · bttv · ffz · twitch helix+gql (existing page integrity tokens, no
client secret) · kick v2 api+ws · chatterino badges · robotty recent-messages ·
justlog archives · decapi.me (id fallback).

## real gaps (verified, ranked) — the actual grind backlog

1. **live-buffer search + filter-by-user** — ✅ SHIPPED 2026-06-13, verified on
   live twitch chat. search bar shows on live + per-channel tabs and filters the
   in-memory buffer instantly (no server call); `@name` scopes to one user.
   `main.js` `matchesLiveSearch`/`liveSearchQuery` + the filter in
   `renderMessages`. keyboard-first: `/` focuses the filter (ignored while
   typing), Esc clears + blurs. right-click any chatter → "filter to <user>"
   (sets `@name`). NOT mirrored to the site repo (heatsync.org /live chat-tile)
   yet — needs its own session.
2. **functional test coverage near-zero** — tests cover utils/settings-schema/
   build only. irc parser, emote inventory mutations, bg message router, auth,
   adapters all untested. bulletproofing opportunity.
3. **god-file splits** — main.js 13.7k, content.js 10.4k, bg 8.6k, styles.js 8.3k.
   clean seams exist (content.js emote cluster ~5196–6152 is the lowest-risk
   extraction). pure refactor, medium risk, deferred.
4. **server-blocked** (spec lives in the private server repo) — hs block endpoint,
   twitch follow import, twitch block proxy, ws live-status push (still 60s poll).
   client code mostly already written; blocked on server.
5. **styles.js hardcoded colors** — #fff×279, #000×233, #ff8700×91, #808080×96.
   css-var consolidation is possible but LOW value (palette is fixed, theming not
   a goal); skip unless theming becomes a goal.

## verified fixes this session (2026-06-13)

- gql fallback fetches (`twitch-api.js` claimCommunityPoints ~2948, votePoll
  ~3057) now have `AbortSignal.timeout(8000)` — previously could hang forever.
