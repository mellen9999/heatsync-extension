/**
 * SW idle-death gate — the BG IRC reader and the two 30s lifeline alarms
 * must stay platform-tab-gated (chrome/background.js).
 *
 * Regression anchor (2026-08-03): the reader connected unconditionally in the
 * boot IIFE on EVERY SW wake; its 20s heartbeat extended the SW lifetime
 * forever (Chrome 116+ WS-activity rule), and the 'keepalive' +
 * 'hs-ws-watchdog' alarms (0.5min period — each fire resets the idle timer)
 * pinned it even with all sockets closed. Net effect: the whole BG heap
 * (channel ring buffers, emote caches, cosmetics) stayed resident for users
 * with zero chat tabs open. The gate lives inside the boot IIFE and
 * scheduleWsIdleCheck — not separately callable — so it's pinned at source
 * level like the other reader-loop wiring tests.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

// Carve scheduleWsIdleCheck's body so the assertions can't be satisfied by
// stray matches elsewhere in the 13k-line file.
const idleStart = BG_SRC.indexOf('function scheduleWsIdleCheck()')
const idleEnd = BG_SRC.indexOf('browser.tabs.onRemoved.addListener(scheduleWsIdleCheck)', idleStart)
const IDLE_CHECK = BG_SRC.slice(idleStart, idleEnd)

describe('scheduleWsIdleCheck gates the SW lifelines on platform tabs', () => {
  test('carve markers found', () => {
    expect(idleStart).toBeGreaterThan(-1)
    expect(idleEnd).toBeGreaterThan(idleStart)
  })

  test('zero-tabs branch parks the BG IRC reader', () => {
    expect(IDLE_CHECK).toContain('bgIrcIdleClose()')
  })

  test('zero-tabs branch clears both 30s lifeline alarms', () => {
    expect(IDLE_CHECK).toContain("clear?.('keepalive')")
    expect(IDLE_CHECK).toContain("clear?.('hs-ws-watchdog')")
  })

  test('tabs-present branch re-arms the alarms and the reader', () => {
    expect(IDLE_CHECK).toContain("ensureAlarm('keepalive'")
    expect(IDLE_CHECK).toContain("ensureAlarm('hs-ws-watchdog'")
    expect(IDLE_CHECK).toContain('BG_IRC.idleClosed')
    expect(IDLE_CHECK).toContain('bgIrcConnect()')
  })

  // The lifelines alone weren't the whole story: the tab-serving periodic
  // alarms (1-2min periods) fire <30s apart COMBINED, which kept the SW
  // permanently resident with zero tabs (measured in real Chrome, 08-04).
  test('zero-tabs branch clears the tab-gated periodic alarms; tabs-present re-arms them', () => {
    expect(IDLE_CHECK).toContain('Object.keys(TAB_GATED_ALARMS)')
    expect(IDLE_CHECK).toContain('Object.entries(TAB_GATED_ALARMS)')
  })

  test('TAB_GATED_ALARMS covers the sub-idle-period offenders, never the tab-less features', () => {
    const defStart = BG_SRC.indexOf('const TAB_GATED_ALARMS = {')
    expect(defStart).toBeGreaterThan(-1)
    // Entries are arrow functions containing '}' — carve to the alarm
    // registration that follows the object literal, not the first brace.
    const defEnd = BG_SRC.indexOf("ensureAlarm('refresh-global-emotes'", defStart)
    expect(defEnd).toBeGreaterThan(defStart)
    const DEF = BG_SRC.slice(defStart, defEnd)
    for (const name of ['refresh-emote-inventory', 'prune-expired-mutes', 'hs-7tv-watchdog', 'hs-bridge-sweep']) {
      expect(DEF).toContain(`'${name}'`)
    }
    // went-live notifications + kill-switch recovery must keep running tab-less
    for (const name of ['live-poll', 'refresh-followed-users', 'hs-health-poll', 'hs-kick-follow-sync']) {
      expect(DEF).not.toContain(`'${name}'`)
    }
  })

  test('boot reconciles state even when woken by a non-tab event', () => {
    // A bare top-level call after the listeners — the alarm-woken SW with no
    // platform tabs must still tear its lifelines down.
    expect(BG_SRC.slice(idleEnd, idleEnd + 400)).toContain('scheduleWsIdleCheck()')
  })
})

describe('BG IRC reader boot + reopen wiring', () => {
  test('boot IIFE checks platform tabs before connecting', () => {
    const bootStart = BG_SRC.indexOf('// Boot — restore + connect on SW startup')
    expect(bootStart).toBeGreaterThan(-1)
    const boot = BG_SRC.slice(bootStart, BG_SRC.indexOf('})()', bootStart))
    expect(boot).toContain('browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })')
    expect(boot).toContain('BG_IRC.idleClosed = true')
  })

  test('bgIrcIdleClose stops heartbeat, timers, and socket', () => {
    const fnStart = BG_SRC.indexOf('function bgIrcIdleClose()')
    expect(fnStart).toBeGreaterThan(-1)
    const fn = BG_SRC.slice(fnStart, BG_SRC.indexOf('\nfunction', fnStart + 10))
    expect(fn).toContain('bgIrcStopHeartbeat()')
    expect(fn).toContain('BG_IRC.idleClosed = true')
    expect(fn).toContain('BG_IRC.ws = null')
  })

  test('bgIrcConnect un-parks the reader', () => {
    const fnStart = BG_SRC.indexOf('function bgIrcConnect()')
    const fn = BG_SRC.slice(fnStart, fnStart + 300)
    expect(fn).toContain('BG_IRC.idleClosed = false')
  })

  test('bg_irc_join lazily connects a parked reader', () => {
    const joinStart = BG_SRC.indexOf("message.type === 'bg_irc_join'")
    expect(joinStart).toBeGreaterThan(-1)
    const join = BG_SRC.slice(joinStart, joinStart + 1200)
    expect(join).toContain('if (!BG_IRC.ws && !BG_IRC.reconnectTimer) bgIrcConnect()')
  })
})
