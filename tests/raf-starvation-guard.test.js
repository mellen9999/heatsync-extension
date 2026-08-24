// rAF starvation guard — the inverse visibility wedge.
//
// 2026-08-23: popout chat froze (again) with document.hidden === false. On
// wayland/tiling WMs the compositor stops frame callbacks for a covered
// surface WITHOUT chromium ever delivering visibilitychange — so rAF dies
// while the visibility API swears the page is visible. Every render path
// riding a bare cleanup.raf() then swallows its callback forever: the
// multi-platform batch pinned behind _multiPlatformRenderTimer, the scroll
// pin behind _scrollPinRaf, chunked rebuilds mid-loop. Page stays fully
// interactive; chat is just frozen. The BG visibility oracle can't help —
// its nudge handler bails when !document.hidden ("tracking agrees").
//
// The fix: rafOrTimeout races every believed-visible rAF against a watchdog
// timer. rAF wins → timer cleared, zero cost. Timer wins → _rafStarved, all
// render scheduling degrades to timers until a probe rAF fires again.
// These pins keep the render paths routed through that chokepoint.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const bg = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')

describe('rAF starvation guard (inverse visibility wedge)', () => {
  test('rafOrTimeout races believed-visible rAF against a watchdog', () => {
    expect(main).toContain('_rafStarved = true')
    expect(main).toContain("hsDiagLog('raf_starved'")
    expect(main).toContain("hsDiagLog('raf_recovered'")
    // recovery probe exists and clears the flag
    expect(main).toContain('function _probeRafRecovery')
  })

  test('genuinely hidden tabs keep the free rAF pause (no timer burn)', () => {
    // the hidden && !focus && !wedged branch must still return a bare raf —
    // a timer fallback there burns 1Hz renders in every background tab (measured)
    expect(main).toMatch(/return cleanup\.raf\(fn\) \/\/ genuinely hidden/)
  })

  test('render paths route through rafOrTimeout, not bare cleanup.raf', () => {
    expect(main).toContain('_multiPlatformRenderTimer = rafOrTimeout(')
    expect(main).toContain('_scrollPinRaf = rafOrTimeout(')
    expect(main).toContain('rafOrTimeout(() => processChunk(end))')
    // programmatic-scroll settle lowers its flag even when frames never come
    expect(main).toMatch(/if \(document\.hidden \|\| _rafStarved\) \{\n\s*\/\/ No frames coming/)
  })

  test('scroll pin honors the starved flag like the wedge flag', () => {
    expect(main).toContain('if (_rafStarved || (document.hidden && (document.hasFocus() || _visWedged)))')
  })
})

describe('bg irc authed upgrade is not dropped mid-CONNECTING', () => {
  test('set_auth upgrade force-reconnects (plain connect early-returns on CONNECTING)', () => {
    const i = bg.indexOf('upgrading reader to authed connection')
    expect(i).toBeGreaterThan(-1)
    expect(bg.slice(i, i + 400)).toContain('bgIrcForceReconnect()')
  })
})
