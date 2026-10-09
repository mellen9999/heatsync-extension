/**
 * Regression tests for the "quote/reply reference row missing HeatSync name
 * paint" bug (multichat overlay).
 *
 * The overlay's inline feed-post row — the `>>1w [OP] mellen: ...` quote row
 * that appears in twitch/kick/youtube chat when a followed user posts on the
 * HeatSync following feed (src/multichat/main.js, `m.type === 'feed-post'`
 * branch inside buildMessageDiv) — rendered the poster's name with a flat
 * `sanitizeColor(m.color)` and nothing else. Every other username surface
 * (sender row, inline @mention, reply-context bar — main.js ~10420/~10580/
 * ~10825) resolves a HeatSync name paint first and only falls back to plain
 * color when none is cached. The quote row was the one surface skipped.
 *
 * Fix: buildFeedQuoteUserLink (main.js, hoisted just above buildMessageDiv)
 * is the same precedence every other surface uses — HeatSync paint (already-
 * resolved `hsPaint` object from hsPaintRender) wins, then a resolved 7TV
 * `paintStyle` string, then the plain per-post color — extracted as a pure
 * function (no DOM/cache/network) so it's unit-testable in isolation. The
 * caller resolves the uid via the exact same chokepoint every other site
 * uses (knownUserIds, populated only from real chat activity — see
 * tests/paints.test.js's id-space guard) and registers the anchor for
 * retro-apply for free: it carries the same `hs-mc-mention` class + data-uid
 * pair main.js's generic _indexMessageDiv already scans for on every rendered
 * row, so a paint that resolves after this row painted still lands via
 * updateHsPaintsInPlace with no bespoke registration code.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml } from '../src/lib/utils.js'

globalThis.escapeHtml = escapeHtml
globalThis.sanitizeColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#fff')
// Deterministic stub — real paintPhaseNow (lib/paint-spec.js) is Date.now()-based,
// which this file doesn't test (see tests/paint-spec.test.js for that).
globalThis.paintPhaseNow = () => '1720000000.000s'
// The real one: it is a pure validator, and the painted-name styles below embed its output.
globalThis.hsNameColourDecl = (await import('../src/multichat/paints.js')).hsNameColourDecl

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const fnSrc = sliceBetween(
  'function buildFeedQuoteUserLink(feedUser, uid, hsPaint, paintStyle, color) {',
  '\n  function buildMessageDiv(m, tabId) {',
)

const { buildFeedQuoteUserLink } = new Function(
  `function buildFeedQuoteUserLink(feedUser, uid, hsPaint, paintStyle, color) {${fnSrc.slice(fnSrc.indexOf('{') + 1)}\nreturn { buildFeedQuoteUserLink }`,
)()

/** A resolved letter-split HeatSync paint, mirroring hsPaintRender's real
 * contract (paints.js) — stubbed so this file tests only buildFeedQuoteUserLink's
 * own precedence/escaping logic, not paints.js's cache/split internals
 * (already covered by tests/paints.test.js). */
const SOME_HS_PAINT = { cls: 'hsp-abc123', html: '<span>@</span><span>m</span>', splitAttr: ' data-hs-paint-split="1"' }

describe('buildFeedQuoteUserLink — inline feed-post quote row username anchor', () => {
  test('no uid, no paint: falls back to plain per-post color, name escaped', () => {
    const html = buildFeedQuoteUserLink('mellen', '', null, '', '#ff8700')
    expect(html).toContain('class="hs-mc-user hs-mc-mention"')
    expect(html).not.toContain('data-uid')
    expect(html).toContain('style="color:#ff8700"')
    expect(html).toContain('>mellen<')
  })

  test('uid resolved but no paint cached yet: still plain color, but data-uid is present so a later paint retro-applies', () => {
    const html = buildFeedQuoteUserLink('mellen', '73266147', null, '', '#ff8700')
    expect(html).toContain('data-uid="73266147"')
    expect(html).toContain('style="color:#ff8700"')
    expect(html).not.toContain('hsp-')
  })

  test('HeatSync paint resolved: wins over color, adds the hsp-* class, clears inline style, uses paint html', () => {
    const html = buildFeedQuoteUserLink('mellen', '73266147', SOME_HS_PAINT, '', '#ff8700')
    expect(html).toContain('class="hs-mc-user hs-mc-mention hsp-abc123"')
    expect(html).toContain('data-uid="73266147"')
    expect(html).toContain(' data-hs-paint-split="1"')
    expect(html).toContain('style="--hsp-t:1720000000.000s;--hs-name-c:#ff8700;"')
    expect(html).toContain('<span>@</span><span>m</span>')
  })

  test('7TV paint style resolved but no HeatSync paint: 7TV style wins over the plain per-post color', () => {
    const html = buildFeedQuoteUserLink('mellen', '73266147', null, 'color:#ff0000;text-shadow:0 0 2px #fff', '#ff8700')
    expect(html).toContain('style="color:#ff0000;text-shadow:0 0 2px #fff"')
    expect(html).not.toContain('#ff8700')
  })

  test('HeatSync paint still wins even when a 7TV paintStyle is also present (precedence)', () => {
    const html = buildFeedQuoteUserLink('mellen', '73266147', SOME_HS_PAINT, 'color:#ff0000', '#ff8700')
    expect(html).toContain('style="--hsp-t:1720000000.000s;--hs-name-c:#ff8700;"')
    expect(html).not.toContain('#ff0000')
  })

  test('falls back to "anon" when feedUser is empty/missing', () => {
    const html = buildFeedQuoteUserLink('', '', null, '', '#fff')
    expect(html).toContain('>anon<')
    expect(html).toContain('data-username="anon"')
  })

  test('HTML-escapes a markup-shaped username (defense in depth) when unpainted', () => {
    const html = buildFeedQuoteUserLink('<script>', '', null, '', '#fff')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ── source-level regression guards ──────────────────────────────────────────
describe('feed-post quote row wiring — structural invariants', () => {
  test('the feed-post branch resolves uid through knownUserIds (the same chokepoint as the mention/reply-bar sites), never a new lookup path', () => {
    const idx = MAIN_SRC.indexOf("if (m.type === 'feed-post') {")
    expect(idx).toBeGreaterThan(-1)
    const chunk = MAIN_SRC.slice(idx, idx + 3200)
    expect(chunk).toContain("knownUserIds.get(userKey((m.feedUser || '').toLowerCase(), 'twitch'))")
    expect(chunk).toContain('hsPaintRender(feedUid')
    expect(chunk).toContain('buildFeedQuoteUserLink(')
  })

  test('the feed-post branch never calls queuePaintLookup directly (queueMcCosmeticsLookup stays the sole choke point)', () => {
    const idx = MAIN_SRC.indexOf("if (m.type === 'feed-post') {")
    const chunk = MAIN_SRC.slice(idx, idx + 3200)
    expect(chunk).not.toContain('queuePaintLookup(')
    expect(chunk).toContain('queueMcCosmeticsLookup(feedUid)')
  })
})
