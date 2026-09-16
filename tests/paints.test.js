import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compilePaintCss,
  hashPaintSpec,
  NAME_BOX_CLASS,
  paintMarkupMode,
  paintNameHtmlFor,
  paintNeedsSpans,
  paintPhaseNow,
} from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'
import {
  applyHsPaintToElement,
  clearHsPaintSheet,
  evictOldestPaintEntry,
  getHsPaintClass,
  getHsPickedColor,
  hsUsernameColor,
  partitionPaintBatch,
  primeSelfHsCosmetics,
  reinjectHsPaintSheet,
  setHsColorEntry,
  setHsPaintEntry,
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
// The per-letter splitter used to be a local copy reaching for a bundle-global
// escapeHtml; it is lib/paint-spec.js's own now, like the rest of the markup.
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
let fakeHead = []
beforeEach(() => {
  globalThis.escapeHtml = escapeHtml
  globalThis.compilePaintCss = compilePaintCss
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.paintMarkupMode = paintMarkupMode
  // The bundle hands these over as free variables (build.js embeds
  // lib/paint-spec.js ahead of this module); the markup and the box class both
  // come from there now instead of a local copy.
  globalThis.paintNameHtmlFor = paintNameHtmlFor
  globalThis.NAME_BOX_CLASS = NAME_BOX_CLASS
  globalThis.paintPhaseNow = paintPhaseNow
  // Records appended nodes so the per-paint rule lifecycle (one <style> per
  // hash, removed when the LRU drops its last user) is observable.
  fakeHead = []
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      id: '',
      textContent: '',
      dataset: {},
      parentNode: null,
      removeChild(child) {
        const i = fakeHead.indexOf(child)
        if (i !== -1) fakeHead.splice(i, 1)
        child.parentNode = null
      },
    }),
    head: {
      appendChild(node) {
        node.parentNode = this
        fakeHead.push(node)
        return node
      },
      removeChild(node) {
        const i = fakeHead.indexOf(node)
        if (i !== -1) fakeHead.splice(i, 1)
        node.parentNode = null
      },
    },
  }
})
afterEach(() => {
  globalThis.escapeHtml = undefined
  globalThis.compilePaintCss = undefined
  globalThis.hashPaintSpec = undefined
  globalThis.paintNeedsSpans = undefined
  globalThis.paintMarkupMode = undefined
  globalThis.paintNameHtmlFor = undefined
  globalThis.NAME_BOX_CLASS = undefined
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

  test('a solid paint gets the name box, and no per-letter spans', () => {
    // This asserted `innerHTML === '@mellen'` — bare text under the paint
    // class — and passed for three days while that was exactly the bug: every
    // compiled rule addresses `.hsp-<hash>>.hs-name`, so a solid or gradient
    // paint matched none of its own and rendered as plain text. A test that
    // pins the defect is worse than no test, because it defends it.
    setHsPaintEntry(UID, SOLID_SPEC)
    const el = fakeAnchor('@mellen')
    applyHsPaintToElement(el, UID)
    expect(el.classList.contains(getHsPaintClass(UID))).toBe(true)
    expect(el.dataset.hsPaintSplit, 'no per-letter shape to protect').toBeUndefined()
    expect(el.innerHTML).toBe('<span class="hs-name">@mellen</span>')
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

// ── paint rule lifecycle ────────────────────────────────────────────────────
//
// The CSS for a paint used to be appended to one shared <style> with
// `textContent +=` — a full re-serialize and reparse of every paint seen so
// far, on each new one — and it was never removed, so the stylesheet outgrew
// the LRU cache that described it. Now each paint owns a <style> node that is
// dropped when the cache drops its last user.
//
// paints.js module state (the injected-hash set, the node map, the paint cache)
// is shared across every test in this file, so each test starts by clearing the
// sheet and uses uids of its own.
describe('paint rule lifecycle', () => {
  const mkSpec = (color) => ({
    base: { type: 'solid', angle: 0, stops: [{ color, pos: 0 }] },
    effects: [],
  })

  /** Rule nodes only — ensureHsPaintSheet appends the base sheet here too. */
  const ruleNodes = () => fakeHead.filter((n) => n.dataset?.hsPaint)
  const hashesInHead = () => new Set(ruleNodes().map((n) => n.dataset.hsPaint))

  beforeEach(() => {
    clearHsPaintSheet()
    fakeHead.length = 0
  })

  test('one style node per distinct paint, not one growing sheet', () => {
    setHsPaintEntry('lc-a', mkSpec('#ff0000'))
    setHsPaintEntry('lc-b', mkSpec('#00ff00'))
    const nodes = ruleNodes()
    expect(nodes).toHaveLength(2)
    // Each node carries only its own rule — that is what makes an insert cost
    // its own CSS instead of re-serializing the whole sheet.
    expect(nodes[0].textContent.length).toBeGreaterThan(0)
    expect(nodes[1].textContent.length).toBeGreaterThan(0)
    expect(nodes[0].textContent).not.toBe(nodes[1].textContent)
  })

  test('the same paint on two users injects one rule', () => {
    setHsPaintEntry('lc-same1', mkSpec('#0000ff'))
    const after1 = hashesInHead().size
    setHsPaintEntry('lc-same2', mkSpec('#0000ff'))
    expect(hashesInHead().size).toBe(after1)
    expect(after1).toBe(1)
  })

  test('clearHsPaintSheet removes every rule node', () => {
    setHsPaintEntry('lc-c', mkSpec('#111111'))
    setHsPaintEntry('lc-d', mkSpec('#222222'))
    expect(ruleNodes().length).toBeGreaterThan(0)
    clearHsPaintSheet()
    expect(ruleNodes()).toHaveLength(0)
  })

  test('evicting one wearer of a shared paint keeps the rule for the others', () => {
    // Two users wearing the same paint share one rule. The LRU evicts uids, not
    // paints, so dropping the older wearer must not un-style the younger one —
    // that would leave a row carrying an hsp- class with no CSS behind it.
    setHsPaintEntry('lc-shared-old', mkSpec('#0f0f0f'))
    setHsPaintEntry('lc-shared-new', mkSpec('#0f0f0f'))
    const shared = [...hashesInHead()][0]
    expect(shared).toBeTruthy()

    // Push past HS_PAINT_CACHE_MAX (500) so the two shared uids age out one at
    // a time, oldest first.
    for (let i = 0; i < 499; i++)
      setHsPaintEntry(`lc-filler-${i}`, mkSpec(`#${(i + 4096).toString(16).padStart(6, '0')}`))
    // lc-shared-old is gone by now, lc-shared-new is not — the rule must stand.
    expect(getHsPaintClass('lc-shared-old')).toBe('')
    expect(getHsPaintClass('lc-shared-new')).toBe(`hsp-${shared}`)
    expect(hashesInHead().has(shared)).toBe(true)

    // Age out the last wearer too — now the rule may go.
    for (let i = 0; i < 60; i++)
      setHsPaintEntry(`lc-filler2-${i}`, mkSpec(`#${(i + 8192).toString(16).padStart(6, '0')}`))
    expect(getHsPaintClass('lc-shared-new')).toBe('')
    expect(hashesInHead().has(shared)).toBe(false)
  })

  test('reinject restores the rule for a cached paint', () => {
    setHsPaintEntry('lc-e', mkSpec('#abcdef'))
    const hash = [...hashesInHead()][0]
    expect(hash).toBeTruthy()
    clearHsPaintSheet()
    fakeHead.length = 0
    reinjectHsPaintSheet()
    expect(hashesInHead().has(hash)).toBe(true)
  })
})

/**
 * THE MARKUP THE EXTENSION RENDERS MUST MATCH THE CSS IT COMPILES.
 *
 * lib/paint-spec.js is mirrored from the site byte for byte, and the parity
 * test fences exactly those three lib/ files — so the COMPILER can never drift,
 * while the runtime that feeds it is local and hand-written. That is the gap,
 * and it has now been walked through twice:
 *
 *   - the local markup builder compared `mode === 'wrap'` exactly, and missed
 *     when the site's compiler started emitting `wrap+9`;
 *   - the site gave the name its own box and moved EVERY compiled rule onto
 *     `.hsp-<hash>>.hs-name`. The local builder never emitted that box, so from
 *     2026-09-13 every heatsync name paint in the extension rendered as plain
 *     text. It shipped that way in 1.7.73.
 *
 * Byte-parity on the compiler cannot see either one. This reads what the sheet
 * asks for BELOW the host element and checks the rendered string carries it.
 * There is no DOM engine in this repo, so it is a string check and not a real
 * selector match — it still fails on both bugs above, which is the bar.
 */
describe('a compiled paint can select the markup the extension emits', () => {
  const SPECS = {
    'solid (the common case)': { base: { type: 'solid', angle: 0, stops: [{ color: '#FFB000', pos: 0 }] } },
    gradient: {
      base: {
        stops: [
          { color: '#ff8700', pos: 0 },
          { color: '#ffffff', pos: 100 },
        ],
      },
    },
    'per-letter motion': { base: { stops: [{ color: '#ff8700', pos: 0 }] }, effects: [{ id: 'wave' }] },
  }

  /** Every selector the sheet carries, from the `.hsp-` onward. */
  function compiledSelectors(css) {
    const out = new Set()
    for (const m of css.matchAll(/(\.hsp-[a-z0-9]+[^{},@]*?)\s*\{/g)) {
      const sel = m[1].trim()
      if (/hs-masked|hs-paint-offscreen/.test(sel)) continue
      out.add(sel.replace(/::?[a-z-]+(\([^)]*\))?/g, '').trim())
    }
    return [...out].filter(Boolean)
  }

  for (const [label, spec] of Object.entries(SPECS)) {
    test(`${label}: the sheet addresses nothing the markup lacks`, () => {
      const hash = hashPaintSpec(spec)
      const selectors = compiledSelectors(compilePaintCss(spec, `.hsp-${hash}`, { hash }))
      expect(selectors.length).toBeGreaterThan(0)

      const html = paintNameHtmlFor('ennortix', paintMarkupMode(spec))

      // Every class the sheet names UNDER the host has to exist in the markup.
      const needed = new Set()
      for (const sel of selectors) {
        const below = sel.slice(sel.indexOf('>') + 1)
        if (below === sel) continue
        for (const m of below.matchAll(/\.([a-z][\w-]*)/g)) needed.add(m[1])
      }
      expect(needed.has('hs-name'), 'the compiler puts the fill on the name box').toBe(true)
      for (const cls of needed) expect(html).toContain(`class="${cls}"`)

      // ...and when it addresses spans under the box, the markup needs them.
      if (selectors.some((sel) => /\.hs-name>span/.test(sel))) {
        expect(html).toMatch(/<span class="hs-name"><span/)
      }
    })
  }

  test('the extension builds its markup with the mirrored builder, not a copy', () => {
    // A copy of a contract is a copy that drifts. This one drifted twice.
    const src = readFileSync(join(import.meta.dir, '../src/multichat/paints.js'), 'utf8')
    expect(src).toContain('return paintNameHtmlFor(rawText, paintMarkupMode(spec))')
    expect(
      /function splitHsLettersHtml/.test(src),
      'the local per-letter splitter was a second copy of the same contract',
    ).toBe(false)
  })

  test('the in-place applier asks whether the box is THERE, not whether letters are needed', () => {
    // applyHsPaintToElement is where a name drawn before its paint resolved
    // gets it — most of them, on a cold pane. paintNeedsSpans answers a
    // different question and is false for a solid or gradient paint, so it
    // added the class over bare text and the name stayed unpainted.
    const src = readFileSync(join(import.meta.dir, '../src/multichat/paints.js'), 'utf8')
    const fn = src.slice(src.indexOf('function applyHsPaintToElement'))
    expect(fn).toContain('NAME_BOX_CLASS')
    expect(
      /paintNeedsSpans\(spec\)[^\n]*!el\.dataset\.hsPaintSplit/.test(fn),
      'the shaping guard must not be keyed on per-letter need',
    ).toBe(false)
  })
})
