/**
 * A tab whose chat legs are still joining must say "connecting…", not
 * "no messages yet".
 *
 * Found 2026-08-05 in a logged-out smoke test (virgin profile, the exact path
 * a new installer takes): landing on a channel, the live tab sat empty for
 * ~15-25s while the bg irc join + history hydration completed, showing
 * "no messages yet" the whole time. That silence reads as a broken extension
 * at the one moment a first-time user decides whether to keep it.
 *
 * trackJoin is the state behind that copy, so the risky parts are tested here:
 * a rejected join must clear (else the tab is stranded on "connecting…"), a
 * promise that never settles must clear on the stall timer, and a
 * multi-platform tab must not clear on its first leg.
 *
 * Extraction mirrors tests/hashtag-in-url.test.js: slice the function source
 * out of main.js and eval it with its collaborators provided as globals. The
 * only thing fed to new Function() is this repo's own main.js read off disk —
 * test-time, no runtime path, no external input.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const FN_SRC = sliceBetween('function trackJoin(tabId, p) {', '\n/* Is this lowercase channel name live')

// Fresh scope per test: trackJoin closes over _tabJoining, currentTab,
// renderMessages and JOIN_STALL_MS in main.js.
function build({ currentTab = 'live', stallMs = 30000, graceMs = 5000 } = {}) {
  const joining = new Map()
  const settledAt = new Map()
  const rendered = []
  const factory = new Function(
    '_tabJoining',
    '_tabSettledAt',
    'currentTab',
    'renderMessages',
    'JOIN_STALL_MS',
    'CONNECT_GRACE_MS',
    `${FN_SRC}\nreturn trackJoin`,
  )
  const trackJoin = factory(joining, settledAt, currentTab, (id) => rendered.push(id), stallMs, graceMs)
  return { trackJoin, joining, settledAt, rendered }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('trackJoin — the state behind "connecting…"', () => {
  test('a pending join marks the tab, a resolved one clears it', async () => {
    const { trackJoin, joining } = build()
    let done
    trackJoin('live', new Promise((r) => (done = r)))
    expect(joining.get('live')).toBe(1)

    done()
    await tick()
    expect(joining.has('live')).toBe(false)
  })

  test('repaints on MARK, not only on settle', () => {
    // The panel paints before startNetwork issues the joins, so the visible tab
    // has already rendered "no messages yet" by the time trackJoin runs. Without
    // the mark-time repaint the copy never flips — verified live 2026-08-05.
    const { trackJoin, rendered } = build()
    trackJoin('live', new Promise(() => {}))
    expect(rendered).toEqual(['live'])
  })

  test('repaints again when the join settles, and once more when the grace ends', async () => {
    const { trackJoin, rendered } = build({ graceMs: 20 })
    trackJoin('live', Promise.resolve())
    await tick()
    expect(rendered).toEqual(['live', 'live'])
    await tick(120)
    // the third paint is what flips a silent channel to "no messages yet"
    expect(rendered).toEqual(['live', 'live', 'live'])
  })

  test('a REJECTED join clears too — a failed join must not strand the tab', async () => {
    const { trackJoin, joining } = build()
    trackJoin('live', Promise.reject(new Error('bg join failed')))
    expect(joining.get('live')).toBe(1)

    await tick()
    expect(joining.has('live')).toBe(false)
  })

  test('a join that never settles clears on the stall timer', async () => {
    const { trackJoin, joining } = build({ stallMs: 20 })
    trackJoin('live', new Promise(() => {}))
    expect(joining.get('live')).toBe(1)

    await tick(40)
    expect(joining.has('live')).toBe(false)
  })

  test('a twitch+kick tab stays "connecting…" until BOTH legs land', async () => {
    const { trackJoin, joining } = build({ currentTab: 'asmongold247' })
    let twitchDone, kickDone
    trackJoin('asmongold247', new Promise((r) => (twitchDone = r)))
    trackJoin('asmongold247', new Promise((r) => (kickDone = r)))
    expect(joining.get('asmongold247')).toBe(2)

    twitchDone()
    await tick()
    expect(joining.get('asmongold247')).toBe(1)

    kickDone()
    await tick()
    expect(joining.has('asmongold247')).toBe(false)
  })

  test('the stall timer cannot double-decrement an already-settled join', async () => {
    const { trackJoin, joining } = build({ stallMs: 10 })
    let a
    trackJoin('live', new Promise((r) => (a = r)))
    trackJoin('live', new Promise(() => {}))
    a()
    await tick(40)
    // both legs accounted for exactly once — never a negative/stuck count
    expect(joining.has('live')).toBe(false)
  })

  test('a background tab does not repaint the visible one', async () => {
    const { trackJoin, rendered } = build({ currentTab: 'live' })
    trackJoin('nl_kripp', Promise.resolve())
    await tick()
    expect(rendered).toEqual([])
  })

  test('no tabId is a no-op passthrough', () => {
    const { trackJoin, joining } = build()
    const p = Promise.resolve('x')
    expect(trackJoin(undefined, p)).toBe(p)
    expect(joining.size).toBe(0)
  })
})

describe('the empty state actually consults it', () => {
  test('renderMessages asks isTabConnecting before falling back to mc_no_messages', () => {
    const branch = sliceBetween('} else if (isTabConnecting(id)) {', 'msgsEl.appendChild(empty)')
    expect(branch).toContain("t('mc_connecting')")
    expect(branch.indexOf("t('mc_connecting')")).toBeLessThan(branch.indexOf("t('mc_no_messages')"))
  })

  test('the live tab join sites are tracked — the fresh-install path', () => {
    expect(MAIN_SRC).toContain("trackJoin('live', irc.join(twitchCh))")
    expect(MAIN_SRC).toContain("trackJoin('live', kickChat.join(kickCh))")
  })

  test('mc_connecting exists in the en catalog with no placeholders', () => {
    const en = JSON.parse(readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'))
    expect(en.mc_connecting?.message).toBe('connecting…')
    expect(en.mc_connecting.message).not.toMatch(/\$\w+\$/)
  })
})

describe('never-connected tabs', () => {
  test('an empty tab WITH legs that has never had a join settle reads as connecting', () => {
    // The marks land in startNetwork's idle slice, after the panel's first
    // paint — gating on _tabJoining alone left "no messages yet" on screen for
    // that whole window. Verified live on a throttled link 2026-08-05.
    const fn = sliceBetween('function isTabConnecting(id) {', '\n/* Mark a tab as joining')
    // never settled a leg on a tab that has legs => still connecting
    expect(fn).toContain('if (!settledAt) return true')
    // a settled join is not the same as chat arriving — hold the copy briefly
    expect(fn).toContain('Date.now() - settledAt < CONNECT_GRACE_MS')
  })

  test('a legless tab is genuinely empty, not "connecting…"', () => {
    const fn = sliceBetween('function tabHasChatLegs(id) {', '\n/* Mark a tab as joining')
    expect(fn).toContain("if (id === 'live') return !!getCurrentChannel() || !!getLiveChannel()")
    expect(fn).toContain('ch?.twitch || ch?.kick || ch?.youtube')
  })

  test('settling a join stamps when it landed', async () => {
    const { trackJoin, settledAt } = build()
    trackJoin('live', Promise.resolve())
    expect(settledAt.has('live')).toBe(false)
    await tick()
    expect(typeof settledAt.get('live')).toBe('number')
  })
})

describe('the panel skeleton', () => {
  test('paints "connecting…", not "no messages yet" — it renders before any join', () => {
    const skeleton = sliceBetween('function createOverlay() {', 'function switchTab')
    expect(skeleton).toContain('<div class="hs-mc-empty">${t(\'mc_connecting\')}</div>')
    expect(skeleton).not.toContain('<div class="hs-mc-empty">${t(\'mc_no_messages\')}</div>')
  })
})
