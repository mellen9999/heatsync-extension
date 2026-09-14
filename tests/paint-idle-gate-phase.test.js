/**
 * The viewport gate must hand a name back on the phase the wall clock says,
 * not on the phase it froze at.
 *
 * `.hs-mc-idle { animation-play-state: paused }` freezes an animation's
 * currentTime; resuming ticks on from that frozen value. The negative
 * `animation-delay` the paint compiler emits (syncDelayCalc) is what makes
 * twenty copies of one paint show one animation, and it is consumed ONCE, when
 * the animation starts — it is never re-read on resume. So before this gate
 * called regateInPhase, every name that scrolled off came back offset by
 * exactly how long it had been away, permanently and independently of every
 * other name.
 *
 * Two contracts, tested separately because they fail separately:
 *   1. the WIRING — the observer partitions entries and writes the class only
 *      through regateInPhase's callbacks (a plain classList.toggle pauses
 *      without ever recording a phase, which is the shape this replaced);
 *   2. the RESTORE — the real lib/animation-phase.js, driven through that
 *      wiring, brings a paused copy back in step with one that never paused.
 *
 * paints.js pulls in bundle-only globals at module scope, so the observer is
 * extracted by source slicing + `new Function` — same technique as
 * tests/emote-idle-gate.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')

/** Slice `function ensureHsVisibilityObserver() { … }` out of paints.js. */
function sliceObserverFactory() {
  const start = SRC.indexOf('function ensureHsVisibilityObserver()')
  expect(start, 'ensureHsVisibilityObserver vanished from paints.js').toBeGreaterThan(-1)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) break
  }
  expect(i, 'unbalanced braces slicing ensureHsVisibilityObserver').toBeLessThan(SRC.length)
  return SRC.slice(start, i + 1)
}

function makeGate(regateInPhase) {
  const instances = []
  class FakeIntersectionObserver {
    constructor(cb, opts) {
      this.cb = cb
      this.opts = opts
      instances.push(this)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const factory = new Function(
    'IntersectionObserver',
    'regateInPhase',
    `let hsVisibilityObserver = null
     ${sliceObserverFactory()}
     return ensureHsVisibilityObserver()`,
  )
  const observer = factory(FakeIntersectionObserver, regateInPhase)
  return { observer, instances }
}

function fakeEl() {
  const set = new Set()
  return {
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      // Present on purpose: a reverted gate would reach for toggle, and the
      // wiring test asserts it is never called.
      toggle: () => {
        throw new Error('the gate toggled the class directly — the phase was never recorded')
      },
    },
    getAnimations: () => [],
  }
}

describe('the viewport gate goes through regateInPhase', () => {
  test('non-intersecting entries pause, intersecting entries resume', () => {
    const calls = []
    const { instances } = makeGate((groups, hooks) => calls.push({ groups, hooks }))
    const off = fakeEl()
    const on = fakeEl()
    instances[0].cb([
      { target: off, isIntersecting: false },
      { target: on, isIntersecting: true },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].groups.pause).toEqual([off])
    expect(calls[0].groups.resume).toEqual([on])
  })

  test('the class is written only through the pause/resume hooks', () => {
    let seen = null
    const { instances } = makeGate((_groups, hooks) => {
      seen = hooks
    })
    const off = fakeEl()
    const on = fakeEl()
    on.classList.add('hs-mc-idle')
    instances[0].cb([
      { target: off, isIntersecting: false },
      { target: on, isIntersecting: true },
    ])
    // Nothing has moved yet — the hooks are the only writer.
    expect(off.classList.contains('hs-mc-idle')).toBe(false)
    seen.onPause(off)
    seen.onResume(on)
    expect(off.classList.contains('hs-mc-idle')).toBe(true)
    expect(on.classList.contains('hs-mc-idle')).toBe(false)
  })

  test('a screenful of runway either side, so a scroll never uncovers a frozen name', () => {
    const { instances } = makeGate(() => {})
    expect(instances[0].opts.rootMargin).toBe('150% 0px')
  })
})

/** Real Web Animations pause/resume semantics: pausing holds currentTime and
 *  nulls startTime, resuming re-bases startTime off the held value. A gate with
 *  no restore therefore drifts by exactly the time spent paused. */
class FakeAnimation {
  constructor(timeline, startTime, duration) {
    this.timeline = timeline
    this.startTime = startTime
    this.effect = { getTiming: () => ({ duration, delay: 0, direction: 'normal' }) }
    this._hold = 0
    this._paused = false
  }
  get currentTime() {
    return this._paused ? this._hold : this.timeline.currentTime - this.startTime
  }
  set currentTime(v) {
    if (this._paused) this._hold = v
    else this.startTime = this.timeline.currentTime - v
  }
  pause() {
    this._hold = this.currentTime
    this.startTime = null
    this._paused = true
  }
  play() {
    this.startTime = this.timeline.currentTime - this._hold
    this._paused = false
  }
}

describe('a name that scrolled away comes back in step', () => {
  test('three seconds off screen costs zero drift', async () => {
    const { regateInPhase } = await import('../src/lib/animation-phase.js')
    const timeline = { currentTime: 0 }
    const prevDoc = globalThis.document
    globalThis.document = { timeline }

    const mk = () => {
      const anim = new FakeAnimation(timeline, 0, 4000)
      const el = fakeEl()
      el.getAnimations = () => [anim]
      el.style = { getPropertyValue: () => '' }
      return { el, anim }
    }
    const stayed = mk()
    const left = mk()
    const hooks = {
      onPause: (el) => {
        el.classList.add('hs-mc-idle')
        for (const a of el.getAnimations()) a.pause()
      },
      onResume: (el) => {
        el.classList.remove('hs-mc-idle')
        for (const a of el.getAnimations()) a.play()
      },
    }

    try {
      timeline.currentTime = 1000
      regateInPhase({ pause: [left.el] }, hooks)
      expect(left.el.classList.contains('hs-mc-idle')).toBe(true)

      timeline.currentTime = 4000
      regateInPhase({ resume: [left.el] }, hooks)
      expect(left.el.classList.contains('hs-mc-idle')).toBe(false)

      // The one that never left is the reference: both must read the same
      // phase, and on a 4000ms loop a naive resume is 3000ms out — most of a
      // full cycle, which is the visible complaint.
      expect(left.anim.currentTime).toBe(stayed.anim.currentTime)
      expect(left.anim.currentTime).toBe(4000)
    } finally {
      if (prevDoc === undefined) delete globalThis.document
      else globalThis.document = prevDoc
    }
  })
})
