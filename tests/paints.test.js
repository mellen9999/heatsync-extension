import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compilePaintCss,
  hashPaintSpec,
  paintMarkupMode,
  paintNeedsSpans,
  paintPhaseNow,
} from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'
import {
  applyHsPaintToElement,
  computeHsLetterSpans,
  evictOldestPaintEntry,
  getHsPaintClass,
  getHsPickedColor,
  hsUsernameColor,
  partitionPaintBatch,
  primeSelfHsCosmetics,
  setHsColorEntry,
  setHsPaintEntry,
  splitHsLettersHtml,
} from '../src/multichat/paints.js'

// Reference copy of the SHARED djb2 username-colour contract (website
// client/utils/color-utils.js usernameColor + server chat-log-permalinks.ts).
// The extension copy MUST match byte-for-byte so a chatter is the same colour
// in the overlay, on heatsync.org, and on SSR /logs pages.
const REF_USERNAME_PALETTE = [
  '#ff7a7a',
  '#ff9d4d',
  '#ffd24d',
  '#b3e833',
  '#5fd75f',
  '#33d9b2',
  '#5fbfd7',
  '#69a8ff',
  '#a675ff',
  '#d76bcb',
  '#ff6e9c',
  '#ff8fc0',
  '#e57373',
  '#f0a23a',
  '#7bc46c',
]
function refUsernameColor(username) {
  let h = 5381
  const s = String(username || '').toLowerCase()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return REF_USERNAME_PALETTE[Math.abs(h) % REF_USERNAME_PALETTE.length]
}

// Most of this file unit-tests pure/stateless helpers only — queuePaintLookup,
// flushHsPaintBatch, ensureHsPaintSheet etc. reach into the shared multichat
// bundle scope (cleanup, getSetting, safeSendMessage, document — all real
// globals once bundled into multichat-*.js, none of which exist when this
// file is imported standalone as an ES module for testing). That matches this
// repo's existing test convention (see filter-rules.test.js / mod-log.test.js)
// of unit-testing pure logic only, not the DOM/network-bound glue.
//
// splitHsLettersHtml DOES reach for one bundle-global (escapeHtml, from
// src/lib/utils.js) — stand it in on globalThis for the duration of this
// file (using the real implementation), same pattern as
// tests/user-notes.test.js does for its identity-graph globals.
//
// applyHsPaintToElement/setHsPaintEntry ARE exercised below (the "in-place
// application" describe block) — they need a `document` for the injected
// paint stylesheet, so a minimal fake stands in (a style-tag look-alike +
// a no-op head), and compilePaintCss/hashPaintSpec/paintNeedsSpans
// (normally bundle-globals from lib/paint-spec.js, per build.js's
// readMultichatModules) are the REAL implementations. The DOM elements
// applyHsPaintToElement itself operates on are duck-typed fakes (a real
// jsdom/happy-dom isn't a repo dependency) — just enough surface
// (classList/dataset/hasAttribute/removeAttribute/innerHTML/textContent)
// to prove the hardening behavior, no visual rendering involved.
beforeEach(() => {
  globalThis.escapeHtml = escapeHtml
  globalThis.compilePaintCss = compilePaintCss
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.paintMarkupMode = paintMarkupMode
  globalThis.paintPhaseNow = paintPhaseNow
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
})
afterEach(() => {
  globalThis.escapeHtml = undefined
  globalThis.compilePaintCss = undefined
  globalThis.hashPaintSpec = undefined
  globalThis.paintNeedsSpans = undefined
  globalThis.paintMarkupMode = undefined
  globalThis.paintPhaseNow = undefined
  globalThis.document = undefined
})

// Minimal duck-typed stand-in for an Anchor element — only the surface
// applyHsPaintToElement actually touches. `.style` is a tiny CSSStyleDeclaration
// look-alike backed by a Map, matching real DOM semantics closely enough for
// this file's purposes: setProperty/removeAttribute both live-reflect into the
// same backing store, so hasAttribute('style') tracks it exactly like a real
// element (a setProperty call after removeAttribute('style') DOES bring the
// attribute back — that's real browser behavior, not a test artifact).
function fakeAnchor(textContent, { existingClasses = [], style = null, splitAttr } = {}) {
  const classes = new Set(existingClasses)
  const dataset = {}
  if (splitAttr) dataset.hsPaintSplit = splitAttr
  const styleProps = new Map()
  if (style) {
    for (const decl of style.split(';')) {
      const [k, v] = decl.split(':')
      if (k && v) styleProps.set(k.trim(), v.trim())
    }
  }
  return {
    textContent,
    innerHTML: textContent,
    dataset,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    style: {
      getPropertyValue: (k) => styleProps.get(k) || '',
      setProperty: (k, v) => styleProps.set(k, v),
      removeProperty: (k) => styleProps.delete(k),
    },
    hasAttribute(name) {
      return name === 'style' && styleProps.size > 0
    },
    removeAttribute(name) {
      if (name === 'style') styleProps.clear()
    },
  }
}

const WAVE_SPEC = {
  base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] },
  effects: [{ id: 'wave', speed: 1 }],
}
const SOLID_SPEC = { base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] }, effects: [] }

describe('applyHsPaintToElement — in-place DOM application (BUG #3 hardening)', () => {
  const UID = 'u1'

  test('splits letter-per-span and marks dataset.hsPaintSplit for a needs-split (wave) paint', () => {
    setHsPaintEntry(UID, WAVE_SPEC)
    const cls = getHsPaintClass(UID)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    expect(el.classList.contains(cls)).toBe(true)
    expect(el.dataset.hsPaintSplit).toBe('1')
    expect(el.innerHTML).toContain('<span')
    expect(el.innerHTML.replace(/<[^>]+>/g, '')).toBe('@mellen')
  })

  test('does NOT split (no per-letter spans) for a solid paint that needs no split', () => {
    setHsPaintEntry(UID, SOLID_SPEC)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    expect(el.classList.contains(getHsPaintClass(UID))).toBe(true)
    expect(el.dataset.hsPaintSplit).toBeUndefined()
    expect(el.innerHTML).toBe('@mellen')
  })

  test('clears a pre-existing inline color decl (precedence: class-based paint must win), but re-adds the phase-lock mount stamp', () => {
    setHsPaintEntry(UID, SOLID_SPEC)
    const el = fakeAnchor('@mellen', { style: 'color:#fff' })
    expect(el.hasAttribute('style')).toBe(true)
    applyHsPaintToElement(el, UID)
    // The old inline color decl is gone — the class owns the fill now.
    expect(el.style.getPropertyValue('color')).toBe('')
    // But the style attribute isn't actually empty: applyHsPaintToElement
    // stamps --hsp-t (paint-spec.js syncDelayCalc) so this copy phase-locks
    // to the same wall-clock frame as every other copy of the paint — real
    // DOM semantics reflect that setProperty call right back into the
    // attribute, same as the site (client/chat/paint-cosmetics.js).
    expect(el.hasAttribute('style')).toBe(true)
    expect(el.style.getPropertyValue('--hsp-t')).toMatch(/^\d+(\.\d+)?s$/)
  })

  test('stamps --hsp-t (phase-lock mount time) on an element with no pre-existing style', () => {
    setHsPaintEntry(UID, SOLID_SPEC)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    expect(el.style.getPropertyValue('--hsp-t')).toMatch(/^\d+(\.\d+)?s$/)
  })

  test('never overwrites an already-stamped --hsp-t (idempotent mount time — a repaint must not re-phase an already-mounted copy)', () => {
    setHsPaintEntry(UID, SOLID_SPEC)
    const el = fakeAnchor('@mellen')
    el.style.setProperty('--hsp-t', '123.456s')
    applyHsPaintToElement(el, UID)
    expect(el.style.getPropertyValue('--hsp-t')).toBe('123.456s')
  })

  test('no-ops entirely when el is null/undefined', () => {
    setHsPaintEntry(UID, WAVE_SPEC)
    expect(() => applyHsPaintToElement(null, UID)).not.toThrow()
  })

  test('no-ops when the uid has no resolved paint', () => {
    setHsPaintEntry(UID, null)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    expect(el.innerHTML).toBe('@mellen')
    expect([...el.classList].length).toBe(0)
  })

  test('BUG #3: never innerHTML-assigns when textContent is already empty — a split of "" must never permanently wipe a node', () => {
    setHsPaintEntry(UID, WAVE_SPEC)
    const el = fakeAnchor('') // textContent already empty at apply-time (e.g. some other race emptied it first)
    applyHsPaintToElement(el, UID)
    // Class still applies (that part is safe/idempotent either way)...
    expect(el.classList.contains(getHsPaintClass(UID))).toBe(true)
    // ...but the node is NEVER marked "split" over empty content, and innerHTML
    // is left untouched — so a later real repaint (once text is actually
    // present) can still run the split instead of being permanently skipped.
    expect(el.dataset.hsPaintSplit).toBeUndefined()
    expect(el.innerHTML).toBe('')
  })

  test('is idempotent — calling twice on an already-split element does not re-split or double-escape', () => {
    setHsPaintEntry(UID, WAVE_SPEC)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    const firstHtml = el.innerHTML
    applyHsPaintToElement(el, UID)
    expect(el.innerHTML).toBe(firstHtml)
  })
})

describe('evictOldestPaintEntry — pure LRU-ish eviction (mirrors monorepo evictOldest)', () => {
  test('evicts the oldest (first-inserted) entry once at capacity', () => {
    const m = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    evictOldestPaintEntry(m, 3)
    expect([...m.keys()]).toEqual(['b', 'c'])
  })

  test('does nothing below capacity', () => {
    const m = new Map([['a', 1]])
    evictOldestPaintEntry(m, 3)
    expect([...m.keys()]).toEqual(['a'])
  })

  test('no-ops on an empty map', () => {
    const m = new Map()
    expect(() => evictOldestPaintEntry(m, 3)).not.toThrow()
    expect(m.size).toBe(0)
  })
})

describe('partitionPaintBatch — pure batch/rest split, newest-queued first', () => {
  test('drains the newest N (end of insertion order) as the batch', () => {
    const { batch, rest } = partitionPaintBatch(['a', 'b', 'c', 'd', 'e'], 3)
    expect(batch).toEqual(['c', 'd', 'e'])
    expect(rest).toEqual(['a', 'b'])
  })

  test('returns everything as batch when under the cap', () => {
    const { batch, rest } = partitionPaintBatch(['a', 'b'], 50)
    expect(batch).toEqual(['a', 'b'])
    expect(rest).toEqual([])
  })

  test('accepts a Set as input (does not mutate it)', () => {
    const s = new Set(['x', 'y', 'z'])
    const { batch, rest } = partitionPaintBatch(s, 2)
    expect(batch).toEqual(['y', 'z'])
    expect(rest).toEqual(['x'])
    expect(s.size).toBe(3)
  })

  test("caps at the server's MAX_BATCH_IDS (50)", () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i))
    const { batch, rest } = partitionPaintBatch(ids, 50)
    expect(batch.length).toBe(50)
    expect(rest.length).toBe(70)
    // newest 50 (highest indices) go first
    expect(batch[0]).toBe('70')
    expect(batch[49]).toBe('119')
  })
})

describe('computeHsLetterSpans — pure per-letter split data', () => {
  test('computes 0-based index per letter and midpoint = (len-1)/2', () => {
    const { mid, letters } = computeHsLetterSpans('abcd')
    expect(mid).toBe(1.5)
    expect(letters).toEqual([
      { ch: 'a', i: 0 },
      { ch: 'b', i: 1 },
      { ch: 'c', i: 2 },
      { ch: 'd', i: 3 },
    ])
  })

  test('handles a single character (mid = 0)', () => {
    const { mid, letters } = computeHsLetterSpans('x')
    expect(mid).toBe(0)
    expect(letters).toEqual([{ ch: 'x', i: 0 }])
  })

  test('handles empty string', () => {
    const { mid, letters } = computeHsLetterSpans('')
    expect(mid).toBe(-0.5)
    expect(letters).toEqual([])
  })

  test('handles null/undefined gracefully', () => {
    expect(computeHsLetterSpans(null).letters).toEqual([])
    expect(computeHsLetterSpans(undefined).letters).toEqual([])
  })

  test('includes the leading @ as its own letter for mention/reply anchors', () => {
    const { letters } = computeHsLetterSpans('@bob')
    expect(letters[0]).toEqual({ ch: '@', i: 0 })
    expect(letters.length).toBe(4)
  })
})

describe('splitHsLettersHtml — escapes each glyph individually', () => {
  test('wraps each character in a span with --i/--mid custom props', () => {
    const html = splitHsLettersHtml('ab')
    expect(html).toBe('<span style="--i:0;--mid:0.5">a</span><span style="--i:1;--mid:0.5">b</span>')
  })

  test('HTML-escapes glyphs that are themselves markup-shaped (defense in depth)', () => {
    const html = splitHsLettersHtml('<>')
    expect(html).not.toContain('<>')
    expect(html).toContain('&lt;')
    expect(html).toContain('&gt;')
  })
})

// ── ID-space guard: structural invariant, not a value-based check ───────────
//
// Paints are keyed by heatsync-side ids in per-platform NAMESPACES: bare
// numeric ids are twitch-space; kick-origin ids are `kick_<kickid>` (server
// migration 200, 2026-07-05). Bare kick/twitch numeric ids collide in VALUE
// (see heatsync_userid_collision_kick_twitch in project memory — both are
// bare numeric, indistinguishable by shape), so the safety here is
// architectural: queuePaintLookup must be called from exactly TWO places —
// queueMcCosmeticsLookup (twitch-space: native twitch id, or a RESOLVED
// linked-twitch-id for kick/YouTube via flushYtNameLookups — never a bare
// kick/yt id) and flushKickNameLookups (kick-space: always the `kick_`-
// namespaced string, never the bare numeric kick id on its own). A third
// call site, or either of these two accepting an unnamespaced platform-native
// id, would be a silent way to reintroduce the collision trap — asserted
// directly against the source rather than left to convention.
describe('paint lookup id-space guard — structural invariant', () => {
  // Both call sites live in cosmetics.js (split out of main.js)
  const cosmeticsJs = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'cosmetics.js'), 'utf8')

  test('queuePaintLookup is called from exactly two places in cosmetics.js', () => {
    const calls = cosmeticsJs.match(/\bqueuePaintLookup\(/g) || []
    expect(calls.length).toBe(2)
  })

  test('one call site is inside queueMcCosmeticsLookup, the same choke point 7TV cosmetics uses', () => {
    const fnStart = cosmeticsJs.indexOf('function queueMcCosmeticsLookup(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = cosmeticsJs.slice(fnStart, fnStart + 600)
    expect(fnBody).toContain('queuePaintLookup(userId)')
  })

  test('the other call site is inside flushKickNameLookups and only ever queues a kick_-namespaced id', () => {
    const fnStart = cosmeticsJs.indexOf('async function flushKickNameLookups(')
    const fnEnd = cosmeticsJs.indexOf('function queueMcCosmeticsLookup(')
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const fnBody = cosmeticsJs.slice(fnStart, fnEnd)
    expect(fnBody).toContain('queuePaintLookup(paintUid)')
    // The raw numeric kick id must never reach queuePaintLookup on its own —
    // only wrapped in the kick_ namespace template literal.
    expect(fnBody).not.toMatch(/queuePaintLookup\(c\.kickId\)/)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text (the kick_ template literal), not writing a real template string
    expect(fnBody).toContain('`kick_${c.kickId}`')
  })
})

describe('picked name colour + youtube hash fallback', () => {
  test('hsUsernameColor matches the shared website/server contract', () => {
    for (const name of ['mellen', 'xQc', 'ASKITTLEZ', 'a', 'UC1234567890abcdefghijkl', '日本語user', '']) {
      expect(hsUsernameColor(name)).toBe(refUsernameColor(name))
    }
  })

  test('hsUsernameColor is case-insensitive and always a palette colour', () => {
    expect(hsUsernameColor('MELLEN')).toBe(hsUsernameColor('mellen'))
    expect(REF_USERNAME_PALETTE).toContain(hsUsernameColor('somechatter'))
  })

  test('hsUsernameColor handles null/undefined without throwing', () => {
    expect(REF_USERNAME_PALETTE).toContain(hsUsernameColor(undefined))
    expect(REF_USERNAME_PALETTE).toContain(hsUsernameColor(null))
  })

  test('setHsColorEntry only stores valid #RRGGBB, else null', () => {
    setHsColorEntry('yt_UCaaaaaaaaaaaaaaaaaaaaaa', '#FF8700')
    expect(getHsPickedColor('yt_UCaaaaaaaaaaaaaaaaaaaaaa')).toBe('#FF8700')
    setHsColorEntry('kick_999', 'red; content:url(x)')
    expect(getHsPickedColor('kick_999')).toBeNull()
    setHsColorEntry('kick_998', null)
    expect(getHsPickedColor('kick_998')).toBeNull()
  })

  test('getHsPickedColor returns null for an unseen uid', () => {
    expect(getHsPickedColor('yt_UCneverseen00000000000')).toBeNull()
  })
})

// The viewer's own name used to render the djb2 placeholder colour and wait
// behind the whole channel's backlog for its paint ("why is my name pink while
// it loads"). Priming seeds the picked colour synchronously and puts every id
// you can speak as into the priority lane.
describe('primeSelfHsCosmetics — own identity seeds instantly', () => {
  beforeEach(() => {
    // paints.js resolves `cleanup` from the bundle scope; stub it for the
    // standalone-module import used by these tests.
    globalThis.cleanup = { setTimeout: () => 0 }
  })

  test('seeds the picked name colour with no network round trip', () => {
    primeSelfHsCosmetics({ id: 'self-seed-1', color: '#ff8700' })
    expect(getHsPickedColor('self-seed-1')).toBe('#ff8700')
  })

  test('primes every identity under its own paint-id namespace', () => {
    primeSelfHsCosmetics({
      id: 'yt_UCbbbbbbbbbbbbbbbbbbbbbb',
      twitch_id: '90210001',
      kick_id: '90210002',
      youtube_channel_id: 'UCbbbbbbbbbbbbbbbbbbbbbb',
      color: '#00ff87',
    })
    expect(getHsPickedColor('90210001')).toBe('#00ff87')
    expect(getHsPickedColor('kick_90210002')).toBe('#00ff87')
    expect(getHsPickedColor('yt_UCbbbbbbbbbbbbbbbbbbbbbb')).toBe('#00ff87')
  })

  test('never clobbers a colour the server already resolved', () => {
    setHsColorEntry('self-seed-2', '#d70000')
    primeSelfHsCosmetics({ id: 'self-seed-2', color: '#ffffff' })
    expect(getHsPickedColor('self-seed-2')).toBe('#d70000')
  })

  test('no identity ids — no throw, no seed', () => {
    expect(() => primeSelfHsCosmetics({})).not.toThrow()
    expect(() => primeSelfHsCosmetics(null)).not.toThrow()
  })
})
