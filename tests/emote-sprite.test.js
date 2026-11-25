/**
 * The sprite rung in the extension's multichat: every copy of an animated emote shows the SAME frame.
 *
 * The bug (2026-11-25, nl_kripp): two rows drew the identical 7tv `67` url and animated out of phase
 * once the reader scrolled up to them. Two <img> with one src share a timeline only while both stay
 * mounted together; the idle gate parks offscreen rows on a static file and restores them, and each
 * restore restarts that img's own clock. The site fixed this for good (animated-texture.js, a strip
 * played from the wall clock); this pins the extension's side of the same contract, ported from the
 * site's tests/client/emote-sprite.test.js:
 *
 *  - one decode per source, however many rows ask for it (the dedupe claim);
 *  - a source that cannot be a strip is refused ONCE, and the row stays exactly as it was;
 *  - the <img> underneath keeps the reserved box and the hover target;
 *  - phase comes from the wall clock, so two copies mounted at different times show the same frame;
 *  - the hold-still reasons win: the setting, a hidden tab, offscreen.
 *
 * Real source throughout (see emote-sprite-rig.js); only the browser's decoder is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ANIM, makeRig } from './emote-sprite-rig.js'

let rig

beforeEach(() => {
  rig = makeRig()
})
afterEach(() => rig.reset())

/** Put a row on screen, let its strip build, and drive it again — the real shape of a first sighting. */
async function show(e) {
  rig.swap(e.row, false)
  await rig.flush()
  rig.swap(e.row, false)
}

describe('building a strip', () => {
  test('decodes a source ONCE however many rows ask for it', async () => {
    const rows = Array.from({ length: 20 }, () => rig.emote())
    for (const e of rows) rig.swap(e.row, false)
    await rig.flush()
    // THE DEDUPE CLAIM, as a number. Twenty rows, one decode, one fetch.
    expect(rig.s.decodeCalls).toHaveLength(1)
    expect(rig.s.fetchCalls).toHaveLength(1)
  })

  test('every copy gets the same strip url — one texture, not twenty', async () => {
    const rows = Array.from({ length: 3 }, () => rig.emote())
    for (const e of rows) await show(e)
    const urls = rows.map((e) => e.wrap.querySelector('.hs-sprite > i').style.backgroundImage)
    expect(new Set(urls).size).toBe(1)
    expect(urls[0]).toContain('blob:strip-1')
  })

  test('carries the frame count and period the decoder reported', async () => {
    const e = rig.emote()
    await show(e)
    const i = e.wrap.querySelector('.hs-sprite > i')
    expect(i.style.getPropertyValue('--hs-sp-cols')).toBe('4')
    expect(i.style.getPropertyValue('--hs-sp-rows')).toBe('1')
    // 4 frames x 50_000us = 200ms
    expect(i.style.getPropertyValue('--hs-sp-dur')).toBe('200ms')
    expect(i.style.animationTimingFunction).toBe('steps(4), steps(1)')
    expect(i.className).toContain('hs-sprite-run')
  })

  test('a row that rendered before the strip landed switches over by itself', async () => {
    const e = rig.emote()
    rig.swap(e.row, false)
    // Nothing yet: the row shows the animated img, which is today's behaviour and correct.
    expect(rig.spriteOf(e.wrap)).toBeNull()
    expect(e.img.getAttribute('src')).toBe(ANIM)
    await rig.flush()
    expect(rig.spriteOf(e.wrap)).toBeTruthy()
  })
})

// The delay is `-(now % period)` and a CSS animation reads it once, at start. The frame on screen
// at wall-clock time T is then (T - mountedAt + mountedAt % period) % period = T % period, whenever
// it was mounted: mount time cancels out, which is the whole of the feature.
const frameAt = (delayMs, mountedAt, T, period, frames) => {
  const local = (T - mountedAt - delayMs) % period
  return Math.floor(local / (period / frames))
}
const delayMs = (str) => Number.parseFloat(str)

describe('phase comes from the wall clock', () => {
  test('two mounts at different times show the same frame at the same time', async () => {
    const real = Date.now
    try {
      // Prime the strip, then mount two copies 120ms apart on different frames.
      const warm = rig.emote()
      await show(warm)
      rig.swap(warm.row, true)

      rig.s.frame = 1000
      Date.now = () => 1_000_050
      const a = rig.emote()
      rig.swap(a.row, false)
      rig.s.frame = 1016
      Date.now = () => 1_000_170
      const b = rig.emote()
      rig.swap(b.row, false)

      const da = delayMs(rig.delayOf(a.wrap))
      const db = delayMs(rig.delayOf(b.wrap))
      // period 200ms, 4 frames: the two copies were mounted at different instants...
      expect(da).not.toBe(db)
      // ...and are on the same frame at every later instant we look.
      for (const T of [1_000_400, 1_000_433, 1_000_999, 1_003_141]) {
        const fa = frameAt(da, 1_000_050, T, 200, 4)
        const fb = frameAt(db, 1_000_170, T, 200, 4)
        expect(fb).toBe(fa)
        // and it is the frame the wall clock names, not one either row invented
        expect(fa).toBe(Math.floor((T % 200) / 50))
      }
    } finally {
      Date.now = real
    }
  })

  test('the delay is the formula, negative: it starts part-way in', async () => {
    const real = Date.now
    try {
      const warm = rig.emote()
      await show(warm)
      rig.swap(warm.row, true)
      rig.s.frame = 2000
      Date.now = () => 1_000_050
      const a = rig.emote()
      rig.swap(a.row, false)
      expect(rig.delayOf(a.wrap)).toBe('-50ms')
      rig.s.frame = 2016
      Date.now = () => 1_000_170
      const c = rig.emote()
      rig.swap(c.row, false)
      expect(rig.delayOf(c.wrap)).toBe('-170ms')
    } finally {
      Date.now = real
    }
  })

  test('an offscreen round trip puts the row back on the clock, not where it froze', async () => {
    const real = Date.now
    try {
      const e = rig.emote()
      await show(e)
      rig.s.frame = 3000
      Date.now = () => 5_000_030
      rig.swap(e.row, true)
      expect(rig.spriteOf(e.wrap)).toBeNull()
      // gone for 90ms, back mid-period
      rig.s.frame = 3016
      Date.now = () => 5_000_120
      rig.swap(e.row, false)
      expect(rig.delayOf(e.wrap)).toBe('-120ms')
    } finally {
      Date.now = real
    }
  })

  test('copies mounted in one frame share one clock read, whatever the loop costs', async () => {
    const real = Date.now
    try {
      const warm = rig.emote()
      await show(warm)
      rig.swap(warm.row, true)
      rig.s.frame = 4000
      let wall = 6_000_000
      Date.now = () => wall++
      const rows = [rig.emote(), rig.emote(), rig.emote()]
      for (const e of rows) {
        rig.swap(e.row, false)
        wall += 40
      }
      const [a, b, c] = rows.map((e) => rig.delayOf(e.wrap))
      expect(b).toBe(a)
      expect(c).toBe(a)
    } finally {
      Date.now = real
    }
  })

  test('a fresh mount is handed to the phase anchor, once', async () => {
    const e = rig.emote()
    await show(e)
    rig.swap(e.row, false)
    expect(rig.s.anchored.filter((w) => w === e.wrap)).toHaveLength(1)
  })
})

describe('what must NOT become a sprite', () => {
  test('a single-frame image is refused and the img is left alone', async () => {
    rig.s.frameCount = 1
    const e = rig.emote()
    await show(e)
    expect(rig.spriteOf(e.wrap)).toBeNull()
    expect(e.img.getAttribute('src')).toBe(ANIM)
  })

  test('refuses a source ONCE, not once per row — and says nothing loud', async () => {
    rig.s.contentType = 'text/html'
    const rows = Array.from({ length: 10 }, () => rig.emote())
    for (const e of rows) rig.swap(e.row, false)
    await rig.flush()
    for (const e of rows) rig.swap(e.row, false)
    await rig.flush()
    expect(rig.s.fetchCalls).toHaveLength(1)
    expect(rig.s.warned).toHaveLength(1)
    for (const e of rows) expect(e.img.getAttribute('src')).toBe(ANIM)
  })

  test('a cdn that sends no CORS header is never asked (bttv)', async () => {
    const url = 'https://cdn.betterttv.net/emote/54fa8f1401e468494b85b537/2x.webp'
    const e = rig.emote(url)
    await show(e)
    expect(rig.s.fetchCalls).toHaveLength(0)
    expect(rig.spriteOf(e.wrap)).toBeNull()
  })

  test('an emote nothing says is animated is not decoded for nothing', async () => {
    const e = rig.emote(ANIM, { animated: false })
    await show(e)
    expect(rig.s.fetchCalls).toHaveLength(0)
    expect(rig.spriteOf(e.wrap)).toBeNull()
  })

  test('modifier, overlay and cropped emotes keep their own <img>', async () => {
    const mod = rig.emote(ANIM, { wrapAttrs: { 'data-hs-mods': 'w!' } })
    const fx = rig.emote(ANIM, { imgCls: 'hs-fx-party' })
    const overlay = rig.emote(ANIM, { imgCls: 'hs-mc-overlay-emote' })
    const crop = rig.emote(ANIM, { wrapCls: 'hs-kick-crop' })
    for (const e of [mod, fx, overlay, crop]) await show(e)
    for (const e of [mod, fx, overlay, crop]) expect(rig.spriteOf(e.wrap)).toBeNull()
  })

  test('a blocked emote is not played over its block', async () => {
    const e = rig.emote()
    e.wrap.dataset.state = 'blocked'
    await show(e)
    expect(rig.spriteOf(e.wrap)).toBeNull()
  })
})

describe('the hold-still reasons win', () => {
  test("only 'always' animates: hover and never leave the img alone", async () => {
    rig.gate.setMode('hover')
    const e = rig.emote()
    await show(e)
    expect(rig.spriteOf(e.wrap)).toBeNull()
    expect(rig.s.fetchCalls).toHaveLength(0)
  })

  test('leaving the screen takes the sprite off, coming back puts it on', async () => {
    const e = rig.emote()
    await show(e)
    expect(rig.spriteOf(e.wrap)).toBeTruthy()
    rig.swap(e.row, true)
    expect(rig.spriteOf(e.wrap)).toBeNull()
    rig.swap(e.row, false)
    expect(rig.spriteOf(e.wrap)).toBeTruthy()
  })

  test('a hidden tab drops every sprite and the return puts them back', async () => {
    const e = rig.emote()
    await show(e)
    rig.visibility(true)
    expect(rig.spriteOf(e.wrap)).toBeNull()
    rig.visibility(false)
    expect(rig.spriteOf(e.wrap)).toBeTruthy()
  })

  test('a row that left the screen while the tab was hidden does not come back with it', async () => {
    const e = rig.emote()
    await show(e)
    rig.visibility(true)
    rig.swap(e.row, true)
    rig.visibility(false)
    expect(rig.spriteOf(e.wrap)).toBeNull()
  })

  test('switching the setting off tears every sprite down', async () => {
    const e = rig.emote()
    await show(e)
    rig.gate.setMode('never')
    rig.gate.teardownHsEmoteIdleGate()
    expect(rig.spriteOf(e.wrap)).toBeNull()
  })
})

describe('the img underneath', () => {
  test('is never removed, and is parked on the cdn static file while the sprite plays', async () => {
    const e = rig.emote()
    await show(e)
    expect(e.img.isConnected).toBe(true)
    expect(e.img.style.display).not.toBe('none')
    expect(e.img.getAttribute('src')).toBe('https://cdn.7tv.app/emote/abc/2x_static.webp')
    // hidden only once the strip is proven to paint, one decode later
    await rig.flush()
    expect(e.wrap.classList.contains('hs-sprite-on')).toBe(true)
  })

  test('is restored to the animated file when the sprite goes and nothing replaces it', async () => {
    const e = rig.emote()
    await show(e)
    rig.gate.setMode('never')
    rig.gate.teardownHsEmoteIdleGate()
    expect(e.img.getAttribute('src')).toBe(ANIM)
    expect(e.wrap.classList.contains('hs-sprite-on')).toBe(false)
  })

  test('a heatsync-proxied static frame is never fetched just to sit under a sprite', async () => {
    const url = 'https://files.kick.com/emotes/37226/fullsize'
    const e = rig.emote(url)
    await show(e)
    expect(rig.spriteOf(e.wrap)).toBeTruthy()
    expect(e.img.getAttribute('src')).toBe(url)
  })
})
