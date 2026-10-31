/**
 * A painted name is put on the clock when its animations START — not when
 * something happens to scroll.
 *
 * HTML-built rows were only ever found by discovery, and discovery ran on
 * scroll. A pane held still under the cursor (or scrolled up) still takes new
 * rows; none were anchored or gated, so each kept the error of the frame that
 * mounted it — measured live on twitch, every @mention of one paint on its own
 * phase, 117 to 508ms apart, until the reader scrolled.
 *
 * paints.js pulls in bundle-only globals at module scope, so the handler is
 * sliced out of the source and run against stand-ins — same technique as
 * tests/paint-idle-gate-phase.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')

function slice(head) {
  const start = SRC.indexOf(head)
  expect(start, `${head} vanished from paints.js`).toBeGreaterThan(-1)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) break
  }
  return SRC.slice(start, i + 1)
}

class FakeElement {
  constructor(host) {
    this.host = host
    this.isConnected = true
  }
  closest() {
    return this.host
  }
}

function rig() {
  const frames = []
  const observed = []
  const anchored = []
  const hsObservedNames = new Set()
  const io = { observe: (el) => observed.push(el) }
  const make = new Function(
    'Element',
    'requestAnimationFrame',
    'ensureHsVisibilityObserver',
    'hsObservedNames',
    'anchorSoon',
    'hsPlanFor',
    'applyHsGlyphMasks',
    `const hsStartedHosts = new Set()
     ${slice('function adoptHsPaintedName(')}
     ${slice('function onHsAnimationStart(')}
     return onHsAnimationStart`,
  )
  const onStart = make(
    FakeElement,
    (fn) => frames.push(fn),
    () => io,
    hsObservedNames,
    (el) => anchored.push(el),
    () => null,
    () => {},
  )
  const frame = () => {
    for (const fn of frames.splice(0)) fn()
  }
  return { onStart, frame, observed, anchored, hsObservedNames }
}

describe('animationstart puts a painted name on the clock', () => {
  test('a name nothing has seen is adopted the frame it starts — no scroll needed', () => {
    const r = rig()
    const name = new FakeElement(null)
    name.host = name
    const glyph = new FakeElement(name)
    // a name starts a dozen animations at once: host, glyphs, scene planes
    for (let i = 0; i < 12; i++) r.onStart({ animationName: `hsp_abc_${i}`, target: i % 2 ? glyph : name })
    expect(r.observed).toEqual([])
    r.frame()
    expect(r.observed).toEqual([name])
    expect(r.anchored).toEqual([name])
  })

  test('a restart on a name already adopted re-anchors it, once a frame', () => {
    const r = rig()
    const name = new FakeElement(null)
    name.host = name
    r.hsObservedNames.add(name)
    for (let i = 0; i < 5; i++) r.onStart({ animationName: 'hsq_abc_front0', target: name })
    r.frame()
    expect(r.observed).toEqual([])
    expect(r.anchored).toEqual([name])
  })

  test('animations that are not a paint are left alone', () => {
    const r = rig()
    const name = new FakeElement(null)
    name.host = name
    r.onStart({ animationName: 'spin', target: name })
    r.onStart({ animationName: 'hsp_abc', target: new FakeElement(null) })
    r.frame()
    expect(r.observed).toEqual([])
    expect(r.anchored).toEqual([])
  })

  test('a name gone before its frame is not adopted', () => {
    const r = rig()
    const name = new FakeElement(null)
    name.host = name
    r.onStart({ animationName: 'hsp_abc', target: name })
    name.isConnected = false
    r.frame()
    expect(r.observed).toEqual([])
  })

  test('the listener is on the document, in capture', () => {
    expect(SRC).toMatch(
      /document\.addEventListener\('animationstart', onHsAnimationStart, \{ capture: true, passive: true \}\)/,
    )
  })
})
