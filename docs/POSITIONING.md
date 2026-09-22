# positioning — verified competitive claims (vs 7tv et al)

Source of truth for any public framing: store listings, reddit launch, replies, README.
Every claim here was verified 2026-07-11 (code, live CWS/AMO pages, 7tv.app). External
claims drift — **recheck anything marked ⏳ before publishing**, ours are stable per release.

## rules

- **facts only, never drama** — no 7tv ownership/finance/scandal talk anywhere public,
  ever. we win on product, not on kicking a competitor. positive-sum tone: "runs
  alongside", "adds what they don't do".
- never claim we "replace" 7tv — we *render* their ecosystem (emotes, paints, badges)
  and add a layer on top. their emote hosting + network is theirs.
- every number below is checkable by anyone; don't round up, don't embellish.

## verified claims — ours (v1.7.21)

⛔ **"no third-party calls" was in this table and it was FALSE.** The manifest
declares `api.betterttv.net`, `api.frankerfacez.com`, `7tv.io`, `api.7tv.app`
and `pronoundb.org`, and `docs/PRIVACY.md` documents exactly what goes to each.
This file is public, MIT, and we tell people to audit the repo — so a claim the
manifest disproves is the first comment on any launch thread, and it costs the
one thing the privacy posture is for. The true claim is narrower and stronger:
**no analytics, no trackers, no ad networks, nothing about you leaves for our
benefit.** Cosmetics come from the emote providers because that is how emotes
render. Say that; never round it up to "no third-party calls".

⚠ The version stamps below are pinned to **v1.7.21**; the extension ships
**1.7.75**. Re-measure before quoting any of the build-derived rows (package
size, test count) — do not refresh them by guessing.

| claim | value | proof |
|---|---|---|
| emote slots | 5000, free | `src/lib/config.js` MAX_EMOTES_PER_SOURCE, shipped copy since 1.6.8 |
| renders 7tv/bttv/ffz | emotes + paints + badges, native twitch+kick chat | `chrome/content.js` (processEmotes), `src/multichat/paints.js` |
| platforms | twitch + kick + youtube (yt = overlay + autocomplete + send) | manifests, `chrome/youtube-content.js` |
| multichat | cross-platform tabbed panel, no account to read | `src/multichat/main.js` |
| runtime deps | zero (vanilla js) | `package.json` — no dependencies key |
| package size | 1.68 MiB zipped | `dist/heatsync-chrome-1.7.21.zip` |
| tests | 1148 cases / 48 files | `bun test` |
| telemetry | none — no analytics, no trackers, no ad networks, local-only error buffer | grep clean; `src/lib/error-reporter.js` |
| third-party calls | yes, and named: 7tv, bttv, ffz, pronoundb for cosmetics; pusher for kick chat. no data is sold or shared | `chrome/manifest.json` host_permissions; `docs/PRIVACY.md` |
| permissions | 5 (storage, unlimitedStorage, cookies, alarms, notifications) + host allowlist | `chrome/manifest.json`; justifications in AMO-REVIEW-NOTES.md |
| locales | 34 | `src/_locales/` |
| license | MIT, open source | LICENSE |

## verified claims — 7tv (checked live 2026-07-11) ⏳

| claim | value | source |
|---|---|---|
| free slots | 1000 ("Everyone gets 1000 customizable channel emote slots, all for free.") | 7tv.app |
| platforms | twitch + kick only — youtube not mentioned | CWS listing (v3.1.23) |
| package size | 3.55 MiB | CWS listing |
| users | 2,000,000+ (CWS display tier), 4.5★ / 8.1K ratings | CWS listing |
| multichat | none in the extension (chatterino7 is a separate desktop app) | CWS listing + github.com/SevenTV |
| social layer | none — site is emote/cosmetic management | 7tv.app |
| subscription | €3.99/mo · €39.99/yr | 7tv.app/store (rendered in-browser, first-party) |
| personal emotes | subscriber perk, not free (benefits list: animated pfp, personal emotes, nametag paints, sub badge) | 7tv.app/store |

note: do NOT claim 7tv zero-width emotes are paid — not in their listed sub benefits,
unconfirmed. channel zero-width appears free. blogs saying otherwise were wrong.

## permission surface — measured 2026-07-25 (installed builds, this machine)

| ext | permissions | host_permissions |
|---|---|---|
| 7TV v7.7.25 | `scripting`, `activeTab` | `*.twitch.tv` (+ `*.youtube.com` optional) |
| FFZ v4.80.4 | `unlimitedStorage` | `*.twitch.tv`, `*.frankerfacez.com` |
| heatsync v1.7.36 | `storage`, `unlimitedStorage`, `cookies`, `alarms`, `notifications` | **11 hosts** |

**Rule: never market permissions, "minimal code", or security anywhere public.** Chrome's
install prompt is generated from host count — theirs reads "twitch.tv", ours reads "…and 8
other sites". Raising the subject invites the one comparison we lose, on the exact surface a
user sees at the decision moment. Trust copy is a footer line (`open source · no trackers`),
never a headline, never a bullet, never a launch angle.

Most of the gap is honest — kick + youtube *are* the product — but 6 of 11 hosts are
shavable, tracked as hygiene, not marketing:
`api.twitch.tv` and `kick.com` are redundant (covered by `*.twitch.tv` / `*.kick.com`); the
7tv/bttv/ffz/pronoundb hosts can route through heatsync.org like decapi/robotty/ivr/chatterino
already do. `cookies` is load-bearing (twitch `auth-token` for IRC, kick `session_token` +
`XSRF-TOKEN` for send) but droppable — read `document.cookie` from the MAIN-world script
already injected on both sites, which is how 7tv avoids the permission.

## the pitch skeleton

wedge (lead with what only we do — and what pays off with zero coordination):
> twitch, kick and youtube live chat in one panel — read every stream you follow and
> reply into any of them without alt-tabbing. nobody else has to install anything.

support (the emote layer, second — never the headline):
> plus your own emotes in any channel: 5000 free slots, no streamer setup needed.

why multichat leads: an emote only you can see is worth less than one the room sees, so
emote copy implicitly asks the reader to recruit their chat. multichat is complete for a
party of one, and it is the one thing 7tv's extension does not do at all.

compatibility (disarm the "but i have 7tv" objection):
> 7tv, bttv and ffz emotes, paints and badges all render automatically — with or
> without those extensions installed. nothing to give up.

## who we sell to (settled 2026-07-25)

**Simulcasting streamers first.** They physically cannot read twitch + kick + youtube chat at
once, they say so publicly, and one adopting broadcasts the tool to their whole audience —
no favor asked, no relationship spent. Landing page for them: `/for-streamers`.

Never: recruiting friends, or pitching in a single channel's offline chat. Both are the
smallest possible audience at the highest possible personal cost, and a "no" there is
expensive. Strangers with the stated pain only.

## reddit launch angles (pick one per post, don't stack)

1. **the multichat angle** — "i built a panel that puts twitch, kick and youtube live
   chat in one place" — leads with the thing no extension does; emotes are the bonus.
   **This is the default. Use it unless there is a specific reason not to.**
2. **the emote-sovereignty angle** — "your emotes in any channel, whether or not the
   streamer set anything up" — 5000 free slots vs the 1000 everyone knows.
3. ~~the lightweight angle~~ — **retired 2026-07-25.** Invites the permission comparison
   we lose (see permission surface above).

never post a "heatsync vs 7tv" comparison thread ourselves. if commenters compare,
answer with facts from the tables above, friendly, and always include "it runs
alongside 7tv fine".
