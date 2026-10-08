// The extension must never cost you the stream.
//
// We reposition the host's video player so chat can dock top/bottom/left. Those
// rules race the platform's own layout code, and 17-platform-position.css
// documents that race being lost three separate times — the player collapsing
// to 0×0 or shrink-wrapping to half width. What shows through is the host's own
// background: black on a dark theme, a full white rectangle on a light one,
// which is exactly what a user reported as "the ext breaks the stream, it's
// just a white screen".
//
// player-guard watches the outcome and hands layout back to the platform when
// the player ends up unusable. These pin both halves of that: it fires when the
// player is genuinely broken, and — just as important — it stays out of the way
// in the several states where a zero-sized player is perfectly normal.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'player-guard.js'), 'utf8')

/**
 * Stand the guard up against a fake DOM. Non-module content-script globals in
 * one bundled scope, same approach as highlight-idempotent.test.js.
 */
function makeGuard({
  width,
  height,
  hidden = false,
  fullscreen = false,
  pip = false,
  bodyClasses = [],
  selector = '.persistent-player',
}) {
  const rect = { width, height }
  const classes = new Set(bodyClasses)
  const removedProps = []
  const logged = []

  const player = {
    isConnected: true,
    getBoundingClientRect: () => rect,
    style: { removeProperty: (p) => removedProps.push(p) },
  }

  const doc = {
    hidden,
    fullscreenElement: fullscreen ? {} : null,
    pictureInPictureElement: pip ? {} : null,
    querySelector: (sel) => (sel === selector ? player : null),
    body: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    },
  }

  const timers = []
  const api = new Function(
    'document',
    'ResizeObserver',
    'cleanup',
    'log',
    'setTimeout',
    'clearTimeout',
    `${SRC}
     return { check, disengage, playerGuardDisengaged, resetPlayerGuard, installPlayerGuard }`,
  )(
    doc,
    class {
      observe() {}
      disconnect() {}
    },
    { trackObserver() {} },
    (...a) => logged.push(a.join(' ')),
    (fn) => {
      timers.push(fn)
      return timers.length
    },
    () => {},
  )

  return {
    ...api,
    classes,
    removedProps,
    logged,
    rect,
    /** Run the pending confirm callback, as the real timer would. */
    fireConfirm: () => {
      for (const fn of timers) fn()
    },
  }
}

describe('player-guard — youtube', () => {
  test('measures #movie_player, so a healthy watch page is never flagged', () => {
    const g = makeGuard({ width: 925, height: 520, selector: '#movie_player' })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(false)
  })

  test('a collapsed #movie_player still releases our geometry', () => {
    const g = makeGuard({ width: 0, height: 0, selector: '#movie_player' })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(true)
  })
})

describe('player-guard — fires when the player is actually broken', () => {
  test('a collapsed player releases our geometry', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(true)
    expect(g.classes.has('hs-player-safe')).toBe(true)
  })

  test('a shrink-wrapped player counts as broken too, not just 0x0', () => {
    const g = makeGuard({ width: 12, height: 400 })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(true)
  })

  test('releasing strips the inline geometry we wrote', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.fireConfirm()
    for (const p of ['top', 'bottom', 'left', 'right', 'width', 'height']) {
      expect(g.removedProps).toContain(p)
    }
  })

  test('it says so out loud — a silent bail-out would hide the race', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.fireConfirm()
    expect(g.logged.join(' ')).toContain('player-guard')
  })

  test('a healthy player is left completely alone', () => {
    const g = makeGuard({ width: 1280, height: 720 })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(false)
    expect(g.classes.has('hs-player-safe')).toBe(false)
    expect(g.removedProps).toEqual([])
  })

  test('a collapse that recovers before the confirm window does nothing', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.rect.width = 1280
    g.rect.height = 720
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(false)
  })
})

describe('player-guard — stays out of the way when zero-size is legitimate', () => {
  const cases = [
    ['a hidden tab', { hidden: true }],
    ['fullscreen', { fullscreen: true }],
    ['picture-in-picture', { pip: true }],
    ['the browsing-away mini-player', { bodyClasses: ['hs-twitch-no-channel'] }],
  ]

  for (const [name, extra] of cases) {
    test(`does not fire during ${name}`, () => {
      const g = makeGuard({ width: 0, height: 0, ...extra })
      g.check()
      g.fireConfirm()
      expect(g.playerGuardDisengaged()).toBe(false)
      expect(g.classes.has('hs-player-safe')).toBe(false)
    })
  }
})

describe('player-guard — lifecycle', () => {
  test('bailing out twice is a no-op the second time', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.fireConfirm()
    const first = g.removedProps.length
    g.disengage('again')
    expect(g.removedProps.length).toBe(first)
  })

  test('navigating to a new page gives our layout another chance', () => {
    const g = makeGuard({ width: 0, height: 0 })
    g.check()
    g.fireConfirm()
    expect(g.playerGuardDisengaged()).toBe(true)

    g.resetPlayerGuard()
    expect(g.playerGuardDisengaged()).toBe(false)
    expect(g.classes.has('hs-player-safe')).toBe(false)
  })

  test('installing without a player present never throws', () => {
    const g = makeGuard({ width: 0, height: 0 })
    expect(() => g.installPlayerGuard()).not.toThrow()
  })
})

describe('the CSS kill-switch actually gates the player rules', () => {
  const CSS = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '17-platform-position.css'), 'utf8')

  test('every player-geometry selector is gated on :not(.hs-player-safe)', () => {
    const TARGETS = ['persistent-player', 'video-player', 'ytd-watch-flexy', 'full-bleed-container', 'ytd-miniplayer']
    const ungated = CSS.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('body.hs-platform') && TARGETS.some((t) => l.includes(t)))
    // Any selector still starting `body.hs-platform` while targeting the player
    // would keep applying after a bail-out, which is the whole thing we are
    // trying to switch off.
    expect(ungated).toEqual([])
  })

  test('the gate is actually present on player rules', () => {
    expect(CSS).toContain('body:not(.hs-player-safe).hs-platform')
  })
})
