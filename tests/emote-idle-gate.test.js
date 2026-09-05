/**
 * Offscreen idle gate for animateEmotes:'always'. Hover/never already render
 * static srcs (staticEmoteSrc short-circuits 'always' only), so a busy
 * channel at DOM_RENDER_CAP=500 kept ~470 offscreen rows' animated webp/avif
 * decoders running forever — nothing ever paused them. An IntersectionObserver
 * (same rootMargin discipline as paints.js's viewport gate) swaps each
 * offscreen row's emote imgs to their static variant and swaps back with
 * enough runway that a scroll never uncovers a frozen frame.
 *
 * emotes.js pulls in bundle-only globals at module scope (cleanup,
 * HS_MOD_TOKENS, ...) so it can't be imported standalone (see
 * chunk-observer-root.test.js's note on the same file) — extract the
 * functions under test via source slicing + `new Function`, same technique
 * as tests/badge-not-lazy.test.js's badgeBgStyle.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

// Fake IntersectionObserver — captures the ctor options and lets tests fire
// intersection changes by hand; jsdom/happy-dom isn't a repo dependency
// (same call as paints.test.js's duck-typed DOM elements) so real geometry
// is out of scope — the contract under test is the wiring, not the browser.
function makeFakeIO() {
  const instances = []
  class FakeIntersectionObserver {
    constructor(cb, opts) {
      this.cb = cb
      this.opts = opts
      this.observed = new Set()
      instances.push(this)
    }
    observe(t) {
      this.observed.add(t)
    }
    unobserve(t) {
      this.observed.delete(t)
    }
    disconnect() {
      this.observed.clear()
    }
    fire(entries) {
      this.cb(entries)
    }
  }
  return { FakeIntersectionObserver, instances }
}

function loadIdleGateModule({ IntersectionObserver, documentImpl, raf } = {}) {
  const start = SRC.indexOf("let emoteAnimationMode = 'always'")
  const end = SRC.indexOf('\n// Scroll is when visibility changes')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const body = SRC.slice(start, end)
  const factory = new Function(
    'IntersectionObserver',
    'document',
    'requestAnimationFrame',
    `${body}
    return {
      deriveStaticEmoteSrc, staticEmoteSrc, hsSwapRowEmotesForIdle,
      ensureHsEmoteIdleObserver, reapHsIdleEmoteRows, discoverHsIdleEmoteRows,
      sweepHsEmoteIdleRows, scheduleHsEmoteIdleSweep, teardownHsEmoteIdleGate,
      setMode: (m) => { emoteAnimationMode = m },
      getObserved: () => hsIdleEmoteRows,
    }`,
  )
  return factory(IntersectionObserver, documentImpl, raf)
}

// ── deriveStaticEmoteSrc / staticEmoteSrc ───────────────────────────────────

describe('deriveStaticEmoteSrc — mode-independent static-url derivation', () => {
  const mod = loadIdleGateModule()

  test('7TV: Nx.webp/avif/gif → Nx_static', () => {
    expect(mod.deriveStaticEmoteSrc('https://cdn.7tv.app/emote/abc123/3x.webp')).toBe(
      'https://cdn.7tv.app/emote/abc123/3x_static.webp',
    )
    expect(mod.deriveStaticEmoteSrc('https://cdn.7tv.app/emote/abc123/2x.avif')).toBe(
      'https://cdn.7tv.app/emote/abc123/2x_static.avif',
    )
  })

  test('Twitch native: /default/ → /static/', () => {
    expect(mod.deriveStaticEmoteSrc('https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/3.0')).toBe(
      'https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0',
    )
  })

  test('BTTV: /emote/{id}/{size} → /emote/{id}/static/{size}', () => {
    expect(mod.deriveStaticEmoteSrc('https://cdn.betterttv.net/emote/abc123/3x.webp')).toBe(
      'https://cdn.betterttv.net/emote/abc123/static/3x.webp',
    )
  })

  test('Kick: routes through the emote proxy with static=1', () => {
    const url = 'https://files.kick.com/emotes/12345/fullsize'
    expect(mod.deriveStaticEmoteSrc(url)).toBe(
      `https://heatsync.org/api/emote-proxy?url=${encodeURIComponent(url)}&static=1`,
    )
  })

  test('generic animated gif/webp with no CDN static form → proxy fallback', () => {
    const url = 'https://example.com/some-emote.gif'
    expect(mod.deriveStaticEmoteSrc(url)).toBe(
      `https://heatsync.org/api/emote-proxy?url=${encodeURIComponent(url)}&static=1`,
    )
  })

  test('already static (png/jpg) URL is returned unchanged', () => {
    expect(mod.deriveStaticEmoteSrc('https://example.com/emote.png')).toBe('https://example.com/emote.png')
  })

  test('already-proxied url is returned unchanged (no double-proxy)', () => {
    const url = 'https://heatsync.org/api/emote-proxy?url=x&static=1'
    expect(mod.deriveStaticEmoteSrc(url)).toBe(url)
  })

  test('empty/falsy url is a no-op', () => {
    expect(mod.deriveStaticEmoteSrc('')).toBe('')
    expect(mod.deriveStaticEmoteSrc(null)).toBe(null)
  })
})

describe("staticEmoteSrc — gates on emoteAnimationMode, 'always' is the one mode deriveStaticEmoteSrc bypasses", () => {
  const mod = loadIdleGateModule()

  test("'always' mode returns the url unchanged even though a static variant exists", () => {
    mod.setMode('always')
    const url = 'https://cdn.7tv.app/emote/abc123/3x.webp'
    expect(mod.staticEmoteSrc(url)).toBe(url)
  })

  test("'hover' and 'never' both derive the static variant", () => {
    const url = 'https://cdn.7tv.app/emote/abc123/3x.webp'
    const expected = 'https://cdn.7tv.app/emote/abc123/3x_static.webp'
    mod.setMode('hover')
    expect(mod.staticEmoteSrc(url)).toBe(expected)
    mod.setMode('never')
    expect(mod.staticEmoteSrc(url)).toBe(expected)
  })
})

// ── hsSwapRowEmotesForIdle — the row-level src swap ─────────────────────────

// Duck-typed row: a set of {img, wrapper} pairs. querySelectorAll returns the
// imgs; each img.closest('.hs-mc-emote-wrapper') returns its own wrapper —
// enough surface for hsSwapRowEmotesForIdle, no real DOM needed.
function fakeRow(emotes) {
  const imgs = emotes.map(({ src, emoteUrl }) => {
    const wrapper = { dataset: { emoteUrl } }
    const img = {
      _src: src,
      get src() {
        return this._src
      },
      set src(v) {
        this._src = v
      },
      closest: (sel) => (sel === '.hs-mc-emote-wrapper' ? wrapper : null),
    }
    return img
  })
  return {
    imgs,
    querySelectorAll: (sel) => (sel === 'img.hs-mc-emote' ? imgs : []),
  }
}

describe('hsSwapRowEmotesForIdle — offscreen swap and restore', () => {
  const mod = loadIdleGateModule()

  test('going idle swaps an animated img to its static variant', () => {
    const url = 'https://cdn.7tv.app/emote/abc/3x.webp'
    const row = fakeRow([{ src: url, emoteUrl: url }])
    mod.hsSwapRowEmotesForIdle(row, true)
    expect(row.imgs[0].src).toBe('https://cdn.7tv.app/emote/abc/3x_static.webp')
  })

  test('coming back into view restores the original animated src', () => {
    const url = 'https://cdn.7tv.app/emote/abc/3x.webp'
    const row = fakeRow([{ src: url, emoteUrl: url }])
    mod.hsSwapRowEmotesForIdle(row, true)
    mod.hsSwapRowEmotesForIdle(row, false)
    expect(row.imgs[0].src).toBe(url)
  })

  test('a row with multiple emotes swaps every one independently', () => {
    const url1 = 'https://cdn.7tv.app/emote/aaa/3x.webp'
    const url2 = 'https://cdn.betterttv.net/emote/bbb/3x.webp'
    const row = fakeRow([
      { src: url1, emoteUrl: url1 },
      { src: url2, emoteUrl: url2 },
    ])
    mod.hsSwapRowEmotesForIdle(row, true)
    expect(row.imgs[0].src).toBe('https://cdn.7tv.app/emote/aaa/3x_static.webp')
    expect(row.imgs[1].src).toBe('https://cdn.betterttv.net/emote/bbb/static/3x.webp')
  })

  test('an img already showing a fallback (avif/static-fell) is left alone, not clobbered', () => {
    const url = 'https://cdn.7tv.app/emote/abc/3x.webp'
    // src no longer equals data-emote-url — e.g. hsAvifFell already rewrote it
    const row = fakeRow([{ src: 'https://cdn.7tv.app/emote/abc/3x.avif', emoteUrl: url }])
    mod.hsSwapRowEmotesForIdle(row, true)
    expect(row.imgs[0].src).toBe('https://cdn.7tv.app/emote/abc/3x.avif')
  })

  test('an emote with no static CDN variant (already static image) is left alone', () => {
    const url = 'https://example.com/emote.png'
    const row = fakeRow([{ src: url, emoteUrl: url }])
    mod.hsSwapRowEmotesForIdle(row, true)
    expect(row.imgs[0].src).toBe(url)
  })

  test('an img with no wrapper (no data-emote-url) is skipped, never throws', () => {
    const img = { src: 'x', closest: () => null }
    const row = { querySelectorAll: () => [img] }
    expect(() => mod.hsSwapRowEmotesForIdle(row, true)).not.toThrow()
    expect(img.src).toBe('x')
  })
})

// ── observer lifecycle: mode gate, reap, teardown ───────────────────────────

describe('sweepHsEmoteIdleRows — mode-gated, hover/never do nothing', () => {
  test("does not create an observer outside 'always' mode", () => {
    const { FakeIntersectionObserver, instances } = makeFakeIO()
    const fakeDoc = { querySelectorAll: () => [] }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('hover')
    mod.sweepHsEmoteIdleRows(true)
    mod.setMode('never')
    mod.sweepHsEmoteIdleRows(true)
    expect(instances.length).toBe(0)
  })

  test("'always' mode creates one observer with a 150% rootMargin", () => {
    const { FakeIntersectionObserver, instances } = makeFakeIO()
    const fakeDoc = { querySelectorAll: () => [] }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('always')
    mod.sweepHsEmoteIdleRows(true)
    expect(instances.length).toBe(1)
    expect(instances[0].opts.rootMargin).toBe('150% 0px')
  })

  test('discovers every .hs-mc-msg row not yet observed, once each', () => {
    const { FakeIntersectionObserver, instances } = makeFakeIO()
    const rowA = { isConnected: true }
    const rowB = { isConnected: true }
    const fakeDoc = { querySelectorAll: () => [rowA, rowB] }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('always')
    mod.sweepHsEmoteIdleRows(true)
    mod.sweepHsEmoteIdleRows(true)
    expect(instances[0].observed.size).toBe(2)
    expect(mod.getObserved().size).toBe(2)
  })

  test('reaps rows that left the DOM (hidden-tab shed / trim-to-cap)', () => {
    const { FakeIntersectionObserver, instances } = makeFakeIO()
    const rowA = { isConnected: true }
    const rowB = { isConnected: true }
    // Mirrors real document.querySelectorAll: a detached row is never
    // returned, only reap ever sees it (via the still-held Set/IO target).
    const fakeDoc = { querySelectorAll: () => [rowA, rowB].filter((r) => r.isConnected) }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('always')
    mod.sweepHsEmoteIdleRows(true)
    expect(mod.getObserved().size).toBe(2)
    rowB.isConnected = false // e.g. trimMessagesEl dropped it
    mod.sweepHsEmoteIdleRows(true)
    expect(mod.getObserved().size).toBe(1)
    expect(instances[0].observed.has(rowB)).toBe(false)
  })
})

describe('teardownHsEmoteIdleGate — settings change out of always tears down cleanly', () => {
  test('disconnects the observer and forgets every observed row', () => {
    const { FakeIntersectionObserver, instances } = makeFakeIO()
    const row = fakeRow([])
    const fakeDoc = { querySelectorAll: () => [row] }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('always')
    mod.sweepHsEmoteIdleRows(true)
    expect(mod.getObserved().size).toBe(1)
    mod.teardownHsEmoteIdleGate()
    expect(mod.getObserved().size).toBe(0)
    expect(instances[0].observed.size).toBe(0)
  })

  test('restores any row still mid-swap to its animated src before disconnecting', () => {
    const { FakeIntersectionObserver } = makeFakeIO()
    const url = 'https://cdn.7tv.app/emote/abc/3x.webp'
    const row = fakeRow([{ src: url, emoteUrl: url }])
    const fakeDoc = { querySelectorAll: () => [row] }
    const mod = loadIdleGateModule({ IntersectionObserver: FakeIntersectionObserver, documentImpl: fakeDoc })
    mod.setMode('always')
    mod.sweepHsEmoteIdleRows(true)
    // simulate the IO having marked this row idle
    mod.hsSwapRowEmotesForIdle(row, true)
    expect(row.imgs[0].src).not.toBe(url)
    mod.teardownHsEmoteIdleGate()
    expect(row.imgs[0].src).toBe(url)
  })

  test('a no-op teardown (observer never created) does not throw', () => {
    const mod = loadIdleGateModule()
    expect(() => mod.teardownHsEmoteIdleGate()).not.toThrow()
  })
})

// ── wiring contract (source-level, same technique as chunk-observer-root) ──

describe('emote idle gate wiring', () => {
  test('the IO callback only writes class/src — no layout read that would fight the scroll-pin', () => {
    const at = SRC.indexOf('function ensureHsEmoteIdleObserver(')
    const body = SRC.slice(at, at + 700)
    expect(body).not.toMatch(/getBoundingClientRect|offsetTop|offsetHeight|scrollTop/)
  })

  test('the observer watches rows, not individual emote imgs', () => {
    const at = SRC.indexOf('function discoverHsIdleEmoteRows(')
    const body = SRC.slice(at, at + 400)
    expect(body).toMatch(/querySelectorAll\(['"]\.hs-mc-msg['"]\)/)
  })

  test('the scroll listener is capture+passive, same as paints.js viewport gate', () => {
    const at = SRC.indexOf("document.addEventListener('scroll', () => scheduleHsEmoteIdleSweep")
    expect(at).toBeGreaterThan(-1)
    expect(SRC.slice(at, at + 200)).toContain('{ capture: true, passive: true }')
  })

  test('main.js wires the setting applier to arm on always / teardown otherwise', () => {
    const at = MAIN.indexOf('emoteAnimation: (v, _def, onLoad) => {')
    expect(at).toBeGreaterThan(-1)
    const body = MAIN.slice(at, at + 900)
    expect(body).toContain('scheduleHsEmoteIdleSweep(true)')
    expect(body).toContain('teardownHsEmoteIdleGate()')
  })
})
