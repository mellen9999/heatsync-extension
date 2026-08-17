# heatsync punch list — 2026-07-19 (rev 6, post-1.7.29)

rev 6 (daylight session): soak watch FIRED and got fixed — nightly 03:30
snapshot's 28M-row chat_archive scan starved the flush ~15min (spill
valve engaged 03:30-03:44, ~110k rows, all replayed, dir empty). snapshot
now reads ingest-time rollups (archive_day_counts sum + flush-fed redis
chatter HLL with coverage tripwire; exact scan survives as loud fallback)
— site fe5faa3f. the 23:59-00:46 spill window was the supervised w27
offload (known, lossless). yt innertube fallback tap LANDED (ext 6f22ab7):
the parked wip branch turned out to be a complete sw-side implementation
(memory undersold it — impl lives in chrome/background.js), 44 unit tests,
cherry-picked + built clean. unused-var triage DONE: 295 warnings → 2 real
(dead tab-cycle recency check removed; 7tv sub-ack log completed). best-of
SEO pages (play #3) verified LIVE in prod. chrome eyeball of the new build
skipped — chrome closed on heatpc; queued behind next chrome session.

rev 5 (overnight autonomous session): lint gate GREEN (pre-push unblocked;
correctness tier fixed, style tier deliberately skipped). cross-platform
follow bugs CLOSED — and the dig found a real privacy hole: secondary-handle
profile lookups leaked private twitch↔kick linkage via row identity; gated
server-side with regression tests (site 63752f5f). chatter-rollup had a
silent-gap bug — 07-16/07-17 failed during the io incident and 07-16 fell
out of the fixed d-1/d-2 retry window forever; job now sweeps all pending
days (site 5d8a057a, heals on deploy + tonight's 09:30). emotes-as-text
mid-session root-caused: 7tv latency spikes past the fetch timeout at ttl
refetch stripped the 7tv slot from the consolidated set; refresh now
salvages failed providers' stale entries (ext c156254). /heapstats verified
admin-gated 401 externally — stale observation, closed. kick-reap drained
to 0 orphans, passes in seconds. best-of SEO pages (play #3) in flight.

rev 4 (late night): the three prod blockers from rev 3 are all shipped —
offload rewrite (banked resume + archive-volume staging + best-effort io +
sequential export pipeline; pg_dump 301s vs 6h starved), archive overflow
now SPILLS TO DISK lossless instead of dropping, kick-reap deletes batched
50/call (6 api calls per pass, not 300). plus nav link SHIPPED + e2e
verified. w27 offload run in flight under supervision.

state: 1.7.29 on main, repo clean, all worktrees merged, tests green.
since rev 2: thread-view OP-fetch fix (the >>2a bug — /api/thread + media
absolutize + composer desync), lint gate cleared on touched files, automod
watches live (organic e2e pending), archive backfill + yt reply PROVEN.
rev 2's 1.7.27 gate is history — 1.7.29 shipped.

prod check tonight (20:xx): both workers up, redis healthy, disk fine.
BUT: active data loss (below). load 10 on 4 cores, 310Mi free.

---

## P0 — prod data integrity (FIXED same night — 359cca30, watches below)

- ~~archive ingest flush stall~~ — FIXED: root cause was max_wal_size=1GB
  → back-to-back checkpoints → FPW amplification → IO saturation → 1.2s
  inserts → one unbounded flush pass held flushRunning for hours. shipped:
  bounded drain (2000/pass) + crash requeue + prepare guard + 30min
  dead-man + regression test; pg tuned (wal 8GB, ckpt 15min, zstd).
  verified: 0 overflow warns, 18k inserts/min.
- ~~offload FAILED~~ — REWRITTEN (dd3e1889): 3 straight nights died on
  w27. root causes found: idle-class io starves forever under 24/7 ingest
  writes (24min cpu in 6h); staging on / would have ENOSPC'd (~80G peak vs
  64G free); ndjson export rode the partial index = random reads across
  50GB. now: per-partition banked staging (canonical.ok/serve.ok markers,
  scrub invalidates), staging on /mnt/archive-hot with 2x-heap preflight,
  best-effort/7 io, seq-scan → day spools → external sort pipeline,
  pg_dump --compress=0 + zstd -T2, stage timing logs. proof: pg_dump 301s.
  WATCH: supervised run completing tonight; then 04:41 timer no-ops clean.
- ~~kick-reap 429 starvation~~ — FIXED (bf381024): deletes batched 50 ids
  per call (kick delete takes repeated id params) — full 300-orphan pass
  = 6 paced calls, not 300 × 8s. per-id fallback if a batch 400s.
  WATCH: "reap in Xs" lines — should be seconds; 429 rate should decay.
- ~~archive drops~~ — overflow now SPILLS TO DISK (fec19d83): every
  buffer-cap drop site writes ndjson spill files, replayed through the
  normal insert path (claim-released, dedup-safe). 256MB rotation, 2GB
  cap then loud drop. "dropped N oldest" can no longer happen silently.
  WATCH: any "[archive-spill] spilled" line during soak = flush stalled
  again (lossless now, but find the cause).
- ~~bulk multi-row INSERT in flushRows~~ — shipped earlier same day
  (chunk-tx VALUES, async commit); regression tests green.
- ~~/heapstats refused~~ — verified 07-19: 401 externally (adminRequired,
  fail-closed) — the 404 was a pre-deploy build; intended exposure, closed.

## P0 — extension

- ~~render-storm "twitching"~~ — SHIPPED: scheduleRenderMessages()
  trailing debounce (80ms window, 400ms max-wait, channel/live-only
  fire guard); 5 irc.js hydration sites converted; chrome-verified,
  needs mellen's eyeball on next natural reload.
- ~~o7 emote-as-text~~ — root-caused + FIXED same night: collect POST
  failed silent (no emote_add_failed listener; auth empty right after
  ext reload) → toast wired; bare-word Enter now exact-match collects.
  deferred (named): retry-on-auth-restore queue. mellen: re-click o7 in
  picker while logged in — with the toast a failure is now visible.
- ~~bug-hunt pass, >>2a class~~ — DONE: 2-agent sweep found 7 siblings,
  all fixed + deployed (site 9c86aceb, ext 72f09c6): POST/WS media never
  absolutized (live images broken for every ext viewer) · /hot + /pinned
  media · ssr short >>refs dead text · bookmarked replies opened as
  orphan fake-OPs · bookmark linkify. plus the ~30min emote-refresh
  flash (TTL partial-broadcast race) — refreshes now broadcast once.
  WATCH: flash fix needs a 30min-open window to prove.

## watches (no code until they fire)

- snapshot rollup fix — tomorrow 03:30 UTC must log "chat stats from
  rollups" with ZERO spill lines. first night post-deploy falls back to
  the exact scan by design (HLL only covers from deploy time — coverage
  tripwire correctly rejects it); night 2 is the real proof.
- yt innertube tap — first organic firing during a yt transport outage
  (dbg_yt_tap snapshot / __hsYtTapStats in sw console).
- automod organic e2e — 2 watches live (own channel + nl_kripp); next real
  hold completes it.
- scroll-smear recurrence — will-change fix holding; escalation ladder in
  rev 2 stands. never re-add content-visibility.
- prod 09:30/10:15 UTC jobs — verify both run clean 2 consecutive days.
- kick mode banner on a live mode flip.

## mellen-gated (blocked on human)

- kick picker channel-tab eyeball on a real kick page tab.
- chrome restart → verify hw video decode restored (chrome://gpu).
- play-approval execution on google email (playbook ready: banner,
  recruitment kit, 12×14d).

## P1 — product (in-hand)

- ~~plus discoverability~~ — SHIPPED (c4a7c361): orange plus link in
  primary nav, native navigation, all 33 locales keyed. e2e verified in
  prod chrome (renders, clicks through to /plus).
- capture-posture design call (opt-out default + erase-rate tripwire rec).
- ~~native-tap resilience fallback kick/yt~~ — DONE: kick shipped earlier;
  yt innertube tap landed rev 6 (ext 6f22ab7). WATCH: first organic firing
  (dbg_yt_tap / __hsYtTapStats in sw console during a yt transport outage).
- ~~cross-platform follow bugs~~ — CLOSED 07-19: bug1 was pre-fixed, bug2's
  privacy call settled (redaction kept + toast), bug3 got the queued toast.
  BONUS: secondary-handle lookup privacy gate (site 63752f5f) — see memory
  `project_cross_platform_follow_bugs_2026_07_05` for the linkage-oracle trap.
- opera gx — send wollip the bisect steps.
- yt-only persona send e2e (needs unlinked test account).
- ~~lint-debt sweep~~ — DONE 07-19: gate GREEN (was 2 format errors);
  parseInt-radix/Number.isNaN/isFinite/node:-protocol fixed (a27fcaa).
  DELIBERATE SKIP: 729 useTemplate + 244 optionalChain + 73 literalKeys
  style warnings — churn without runtime value, conflict risk; they don't
  fail the gate. 299 unused-var warnings triaged separately for real bugs.

## growth track — world domination (GATED on prod green)

order matters: fix pipes → make findable → then shout.

1. prod stable 48h (archive lossless, offload clean, load sane) — CLOCK
   STARTS when the w27 supervised run lands + first quiet night. lossless
   is now structural (spill valve); watch for zero spill lines + clean
   04:41 no-op + load off the ceiling.
2. ~~plus nav link~~ shipped. remaining: archive SEO play #3 (per-channel
   best-of/leaderboard pages — programmatic, plays #1/#2 shipped).
   landing+/compare de-cringed 07-18: competitor table killed — done.
3. **reddit/launch post** — gate: 48h green from tonight. drafts ready (kept in
   the private server repo, not here — launch sequencing is not something to
   publish next to the thing being launched). SEO play #3 is nice-to-have, not
   a gate.
4. play store 12×14d on approval → production listing.
5. moments loop content cold-start needs real users — post drives this.

## P2 — deferred tech debt (carried from rev 2, unchanged)

- audit remainders ranked: bulk-ban multi-select · cross-channel search
  n/N · bot-command autocomplete · pronouns.
- perf quartet: eventsub whispers→SW · active-tab ordering ·
  reprocessEmoteTextInPlace freeze · native-badge epoch jank.
- twitch chat-mode GQL hashes (/slow /emoteonly /subscribers /unique).
- user_emotes.user_id VARCHAR migration.
- omegaverify P1 remainders: yt send any-tab fallback · cosmetics drift ·
  whisper echo-dedup · processEmotes double-escape.
- heat anti-abuse P1: badge-weighted heat · persist isFirstMsg · P2
  bot-score to retire ARCHIVE_SKIP_CHANNELS.
- W2/W3 megamission cluster · yt-bridge design · gql-data nonce ·
  moment CF exemption · stream-event flash probe (act on capture only).

## P3 — architecture (explicit sign-off before starting)

- tier-2 refactor + main.js god-split · @heatsync/chat-core subtree.

---

## recommended sequence

1. ~~prod archive stall + dead offload~~ · ~~render-storm~~ · ~~>>2a
   sweep~~ · ~~plus nav link~~ — all shipped.
2. soak: w27 run lands → 48h green watch (spills, 04:41, reap times,
   load).
3. lint sweep (daylight) + kick picker eyeball + SEO play #3 during soak.
4. growth gate check → reddit post (r/kick dry-run first).
