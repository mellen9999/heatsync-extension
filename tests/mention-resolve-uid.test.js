/**
 * Regression tests for "@mention / reply-context chip for a painted user
 * renders unpainted when the twitch uid isn't in knownUserIds at render time"
 * (multichat overlay).
 *
 * At render time, buildMessageDiv/highlightMentionsInHtml (src/multichat/main.js)
 * only knows a mentioned user's uid if it's already in knownUserIds — populated
 * from real chat activity. A user who hasn't spoken in the current channel
 * (e.g. mellen mentioned but not chatting) has no entry, so the anchor renders
 * with no data-uid, never gets hsPaintRender treatment, and — because
 * _indexMessageDiv only registers `a.hs-mc-mention[data-uid]` /
 * `a.hs-mc-reply-user[data-uid]` — can never be found by the retro-paint index
 * (_mentionIndex) even after the uid resolves. Live-verified: mellen's own
 * mention/reply anchors had data-uid entirely absent.
 *
 * resolveMentionColor already ran an async per-name color lookup
 * (hsResolveUserColor, src/multichat/input.js) via /api/profile/:username —
 * whose response already carries twitch_user_id (the same field
 * profile-card.js/tooltips.js read). The fix piggybacks that single lookup
 * (no new request): hsResolveUserColor now also caches the resolved uid in
 * _hsUserIdCache, and resolveMentionColor reads it once the color promise
 * settles, then:
 *   1. stamps data-uid on every live matching anchor (twitch-platform rows only
 *      — the id-space guard: a same-named Kick/YouTube chatter must never
 *      inherit a Twitch stranger's uid/cosmetics),
 *   2. registers them in _mentionIndex (and the row's cached _hsMentionEls,
 *      so a later trim's _unindexMessageDiv can find and clean them up),
 *   3. calls setKnownColor(..., uid, 'twitch') so the NEXT render of this name
 *      hits knownUserIds synchronously instead of taking this async detour
 *      again,
 *   4. calls queueMcCosmeticsLookup(uid) so the existing 7TV/HeatSync paint
 *      batches (which only act on indexed elements) retro-paint it.
 *
 * Both resolveMentionColor (main.js) and hsResolveUserColor (input.js) are
 * non-module content-script globals sharing one bundled scope — not
 * independently importable — so, per the same rationale as
 * tests/paint-precedence-restore.test.js and tests/background-helpers.test.js,
 * these are source-level structural guards rather than a live DOM harness.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

function fnBody(src, marker, span = 2400) {
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  return src.slice(start, start + span)
}

describe('hsResolveUserColor (input.js) — caches the Twitch uid from the same /api/profile/ lookup', () => {
  test('extracts twitch_user_id (with twitch_id fallback) from the profile response', () => {
    const body = fnBody(INPUT_SRC, 'function hsResolveUserColor(lower) {')
    expect(body).toContain('profile?.twitch_user_id || profile?.twitch_id')
  })
  test('caches it in _hsUserIdCache, keyed by the same lower name as _hsUserColorCache', () => {
    const body = fnBody(INPUT_SRC, 'function hsResolveUserColor(lower) {')
    expect(body).toContain('_hsUserIdCache.set(lower,')
  })
  test('only one apiFetch call in the function — no second request added for the uid', () => {
    const body = fnBody(INPUT_SRC, 'function hsResolveUserColor(lower) {', 4000)
    const count = (body.match(/apiFetch\(/g) || []).length
    expect(count).toBe(1)
  })
  test('_hsUserIdCache is declared at module scope (readable cross-file from main.js)', () => {
    expect(INPUT_SRC).toContain('const _hsUserIdCache = new Map()')
  })
})

describe('resolveMentionColor (main.js) — stamp + index + queue on resolve', () => {
  const body = fnBody(MAIN_SRC, 'function resolveMentionColor(lower) {', 4200)

  test('reads the uid from _hsUserIdCache (same cache hsResolveUserColor populated, not a new lookup)', () => {
    expect(body).toContain('_hsUserIdCache.get(lower)')
  })
  test('never re-stamps an anchor that already has a uid (render-time known, or already resolved once)', () => {
    expect(body).toContain('if (a.dataset.uid) continue')
  })
  test('id-space guard: only stamps anchors belonging to a twitch-platform row', () => {
    expect(body).toContain("row?._hsMsg?.platform || 'twitch'")
    expect(body).toMatch(/!==\s*'twitch'\)\s*continue/)
  })
  test('stamps data-uid on the anchor', () => {
    expect(body).toContain('a.dataset.uid = resolvedUid')
  })
  test("registers the anchor in _mentionIndex, mirroring _indexMessageDiv's Map<uid, Set<el>> convention", () => {
    expect(body).toContain('_mentionIndex.get(resolvedUid)')
    expect(body).toContain('_mentionIndex.set(resolvedUid, ms)')
    expect(body).toContain('ms.add(a)')
  })
  test("keeps the row's cached _hsMentionEls list in sync so _unindexMessageDiv can find it later", () => {
    expect(body).toContain('row._hsMentionEls.push(a)')
  })
  test('populates knownUserIds via the existing platform-keyed setKnownColor, not a bespoke write', () => {
    expect(body).toContain("setKnownColor(lower, knownColors.get(lower) || c || '#fff', resolvedUid, 'twitch')")
  })
  test('queues the paint/cosmetics batch via the sole choke point (queueMcCosmeticsLookup), never queuePaintLookup directly', () => {
    expect(body).toContain('queueMcCosmeticsLookup(resolvedUid)')
    expect(body).not.toContain('queuePaintLookup(')
  })
  test('the color-repaint pass still guards against stomping a resolved HeatSync or 7TV paint', () => {
    expect(body).toMatch(/if \(uid && \(getMcPaintStyle\(uid\) \|\| hasResolvedHsPaint\(uid\)\)\) return/)
  })
})
