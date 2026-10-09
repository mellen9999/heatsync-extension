/**
 * Regression tests for the "painted username renders blank" bug.
 *
 * Root cause (verified live in Chrome — see the repro at the bottom of this
 * comment): computeMessageText (main.js) runs a message's text through TWO
 * mention-highlighting passes back to back —
 *
 *   processEmotes()          (src/multichat/emotes.js ~3196)  then
 *   highlightMentionsInHtml() (src/multichat/main.js ~10751)
 *
 * processEmotes has its OWN plain "@name" → <a> wrapper (no uid, no paint —
 * it's the fallback mention-colorer for surfaces that never run
 * highlightMentionsInHtml afterward: whispers.js, twitch-api.js prediction
 * titles, main.js's compact/system-line render). Before this fix, chat
 * messages ALSO got that wrapper applied first, and then
 * highlightMentionsInHtml's tag-split regex matched the SAME "@name" text
 * again (it just sees a text segment between tags — it has no idea that
 * segment is already the entire content of an anchor) and wrapped it in a
 * SECOND <a>, nested inside the first:
 *
 *   <a class="hs-mc-user hs-mc-mention" ...>@mellen</a>          (pass 1)
 *   <a class="hs-mc-user hs-mc-mention" ...><a data-uid="…">@mellen</a></a>  (after pass 2)
 *
 * Nested <a> is invalid HTML5. Verified live in Chrome (javascript_tool,
 * heatsync.org tab) that assigning this exact markup via innerHTML produces:
 *   outer <a> (pass 1, no data-uid) → innerHTML "", textContent ""  — EMPTY
 *   inner <a> (pass 2, data-uid)    → becomes a SIBLING, keeps the real text
 * The browser's parser auto-closes the outer <a> the instant the inner <a>
 * opens (an <a> can't contain another <a>), so the outer one — which is
 * exactly `<a class="hs-mc-user hs-mc-mention" data-username="...">` with a
 * plain inline color style and NO hsp-* class / data-hs-paint-split attr,
 * because it was never resolved through _mentionIndex (no data-uid) — ends
 * up as a permanently blank DOM node. That is precisely the reported bug:
 * an empty `hs-mc-mention` anchor, no paint markers, a normal-looking
 * (but invisible, since there's no text) inline color.
 *
 * Fix: processEmotes gained a `skipMentions` param; computeMessageText now
 * passes true, so its own mention wrap never runs — highlightMentionsInHtml
 * is the SOLE mention-anchor author on this surface, so nesting is
 * structurally impossible. The other three processEmotes callers (which
 * never run highlightMentionsInHtml) keep the default `false` and are
 * unaffected.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { userKey } from '../src/lib/user-key.js'
import { escapeHtml, outsideTags } from '../src/lib/utils.js'

globalThis.escapeHtml = escapeHtml
// these transforms skip whole <a>…</a> spans via the shared helper
globalThis.outsideTags = outsideTags
// emotes.js's tokenizer (and its module-level scanDomForEmotes scheduler)
// reference a handful of main.js-scope globals as free variables (same
// pattern as tests/emote-precedence.test.js) — must be set BEFORE import
// since emotes.js calls cleanup.setIntervalIfVisible at module top level.
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
for (const [k, v] of Object.entries(mods)) globalThis[k] = v
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
// processEmotes reads the inventory-render toggle; undefined = schema default (on)
globalThis.getSetting = () => undefined
globalThis.knownColors = new Map()
globalThis.sanitizeColor = (c) => c || '#fff'
globalThis.mentionColor = () => '#fff' // shared stub — both processEmotes' fallback branch and highlightMentionsInHtml call this
// Deterministic stub — real paintPhaseNow (lib/paint-spec.js) is Date.now()-based,
// which this file doesn't test (see tests/paint-spec.test.js for that).
globalThis.paintPhaseNow = () => '1720000000.000s'
// The real one: it is a pure validator, and the painted-name styles below embed its output.
globalThis.hsNameColourDecl = (await import('../src/multichat/paints.js')).hsNameColourDecl

// ── processEmotes (real import — emotes.js is already ESM-importable) ───────
const { channelEmoteCaches, emoteCache, processEmotes } = await import('../src/multichat/emotes.js')

// ── highlightMentionsInHtml (main.js — not an ES module) ─────────────────────
// main.js is a single non-module script (chrome content-script bundling), so
// it can't be imported directly. Extract the exact source text via markers
// (same eval-harness pattern as tests/background-helpers.test.js) and run it
// in an isolated scope with its real free-variable dependencies stubbed.
const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const highlightSrc = sliceBetween(
  'function highlightMentionsInHtml(html, platform) {',
  '\n  // DOM-node twin of highlightHashtagsInHtml',
)

const { highlightMentionsInHtml } = new Function(
  `function highlightMentionsInHtml(html, platform) {${highlightSrc.slice(highlightSrc.indexOf('{') + 1)}\nreturn { highlightMentionsInHtml }`,
)()

globalThis.knownUserIds = new Map()
// taggedName is its own unit (bare-mention-gating.test.js); identity here
globalThis.taggedName = (n) => n
globalThis.userKey = userKey
globalThis.mcUserCosmetics = new Map()
globalThis.queueMcCosmeticsLookup = () => {}
globalThis.getMcPaintStyle = () => null
// Plus tenure ("+5mo"/"+3y") rides the same mention render site but is a
// separate signal — no active tenure in these double-anchor-bug tests
// (covered by the dedicated plus-tenure test file).
globalThis.getHsPlusTenureSince = () => null
globalThis.queuePlusTenureLookup = () => {}
globalThis.renderPlusTenureToken = () => ''

const TEST_UID = '73266147'
const TEST_LOWER = 'mellen'

/** A resolved letter-split HeatSync paint for TEST_UID; null for everyone else
 * — mirrors hsPaintRender's real contract (paints.js), stubbed here so this
 * file tests ONLY the double-render interaction, not paints.js's own cache
 * logic (already covered by tests/paints.test.js). */
function stubHsPaintRender(uid, rawText) {
  if (uid !== TEST_UID) return null
  const html = [...String(rawText)].map((ch) => `<span>${escapeHtml(ch)}</span>`).join('')
  return { cls: 'hsp-abc123', html, splitAttr: ' data-hs-paint-split="1"' }
}

function resetGlobals() {
  globalThis.knownUserIds = new Map([[userKey(TEST_LOWER, 'twitch'), TEST_UID]])
  globalThis.mcUserCosmetics = new Map()
  globalThis.knownColors = new Map()
  globalThis.hsPaintRender = stubHsPaintRender
  channelEmoteCaches['chan-a'] = new Map([['SomeEmote', { url: 'x' }]]) // any non-empty cache is enough to defeat processEmotes' all-plain-text fast path
  emoteCache.clear()
}

/** True when `html` contains an <a ...> opened before a prior <a ...> closed
 * — i.e. structurally nested anchors. This is the exact defect that gets
 * "corrected" by the browser into a blank outer anchor (verified live in
 * Chrome; see file header). */
const NESTED_ANCHOR_RE = /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<a\b/

describe('processEmotes + highlightMentionsInHtml double-render (blank painted username bug)', () => {
  // Was a RED test asserting the historical defect still reproduced through the
  // old call shape. It doesn't any more: highlightMentionsInHtml now skips whole
  // <a>…</a> spans (the same fix that stopped a url's "#fragment" being eaten by
  // the hashtag pass), so an already-anchored mention is left alone and nesting
  // is impossible from EITHER direction. skipMentions is still the right call
  // — one anchor author, no wasted pass — this is just defence in depth.
  test('an already-anchored mention is never re-wrapped, even via the old call shape', () => {
    resetGlobals()
    const passOne = processEmotes(escapeHtml('@mellen'), 'chan-a', null, null, null) // old call shape — skipMentions defaults false
    expect(passOne).toContain('<a ') // sanity: processEmotes really did wrap it
    const final = highlightMentionsInHtml(passOne, 'twitch')
    expect(final).not.toMatch(NESTED_ANCHOR_RE)
    expect(final).toBe(passOne) // untouched — the anchor span is skipped whole
  })

  test('GREEN (the fix): skipMentions=true means processEmotes never wraps @mentions, so highlightMentionsInHtml is the only anchor author and nesting is impossible', () => {
    resetGlobals()
    const passOne = processEmotes(escapeHtml('@mellen'), 'chan-a', null, null, null, true)
    expect(passOne).toBe('@mellen') // plain text — no anchor at all from this pass
    const final = highlightMentionsInHtml(passOne, 'twitch')
    expect(final).not.toMatch(NESTED_ANCHOR_RE)
    // The single anchor produced carries the real uid + paint — the username
    // text is never lost, and the HeatSync paint still applies.
    expect(final).toContain('data-uid="73266147"')
    expect(final).toContain('hsp-abc123')
    expect(final).toContain('data-hs-paint-split="1"')
    // Letter-split: the real text survives as per-glyph spans, not lost.
    expect(final).toContain('<span>@</span>')
    expect(final.replace(/<[^>]+>/g, '')).toBe('@mellen')
    // Exactly one anchor for the mention — no orphaned empty sibling.
    expect((final.match(/<a\b/g) || []).length).toBe(1)
  })

  test('a plain unpainted @mention still renders through cleanly with the fix (no regression for the common case)', () => {
    resetGlobals()
    globalThis.hsPaintRender = () => null // no paint cached yet — the pre-paint-resolution state
    const passOne = processEmotes(escapeHtml('@mellen'), 'chan-a', null, null, null, true)
    const final = highlightMentionsInHtml(passOne, 'twitch')
    expect(final).not.toMatch(NESTED_ANCHOR_RE)
    expect(final).toContain('@mellen')
    expect((final.match(/<a\b/g) || []).length).toBe(1)
  })

  test('a message with no emotes loaded anywhere never even reaches the tokenizer (fast-path return) — @mention still gets exactly one anchor from highlightMentionsInHtml', () => {
    resetGlobals()
    delete channelEmoteCaches['chan-a']
    const passOne = processEmotes(escapeHtml('@mellen'), 'chan-a', null, null, null, true)
    expect(passOne).toBe('@mellen') // fast-path returned the raw text untouched
    const final = highlightMentionsInHtml(passOne, 'twitch')
    expect((final.match(/<a\b/g) || []).length).toBe(1)
  })
})

// ── source-level regression guard ───────────────────────────────────────────
// Asserts the actual wiring in main.js, not just the primitives above — this
// is what actually prevents the bug in production, so pin it directly against
// the source the same way tests/paints.test.js pins queuePaintLookup's single
// call site.
describe('computeMessageText call-site guard — structural invariant', () => {
  test('the processEmotes call inside computeMessageText passes skipMentions=true', () => {
    // Whitespace-insensitive: the formatter may wrap this call across lines.
    const flat = MAIN_SRC.replace(/\s+/g, ' ')
    const marker =
      'let processedText = processEmotes( escapeHtml(m.text), m.emoteChannel || m.channel, twitchExtra, senderEmotes, m.time, true, hsMsgRefs, )'
    expect(flat.includes(marker) || flat.includes(marker.replace('( ', '(').replace(', )', ')'))).toBe(true)
  })

  test('highlightMentionsInHtml still runs right after, in the same function (mention rendering is not silently dropped)', () => {
    const idx = MAIN_SRC.indexOf('let processedText = processEmotes(')
    const nextChunk = MAIN_SRC.slice(idx, idx + 800)
    expect(nextChunk).toContain('highlightMentionsInHtml(processedText, m.platform)')
  })
})
