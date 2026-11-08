/**
 * Regression: a transient failure in fetchChannelOwnerEmotes must never
 * orphan a channel from live 7TV updates.
 *
 * The bug (nl_kripp 'clop' incident, 2026-08-02): the catch path deleted the
 * channel's seventvEmoteSetIds mapping. With the mapping gone the channel had
 * no EventAPI subscription AND was invisible to the fallback poll (which
 * iterates seventvEmoteSetIds), while the WS itself stayed "healthy" — so
 * emote adds/removes never arrived again for that channel until a tab rejoin.
 * Nothing retried: the only refetch trigger was a new channel join.
 *
 * background.js cannot be imported (top-level chrome.* listeners; see
 * tests/background-helpers.test.js), so per house pattern these are
 * marker-based source-text invariants that fail loudly on drift.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

/** Slice a top-level function's full source text by name. */
function extractFn(name) {
  for (const marker of [`async function ${name}(`, `function ${name}(`]) {
    const start = BG_SRC.indexOf(marker)
    if (start === -1) continue
    const end = BG_SRC.indexOf('\n}', start)
    if (end === -1) break
    return BG_SRC.slice(start, end + 2)
  }
  throw new Error(`marker for ${name} not found in background.js — regression test is stale`)
}

describe('channel emote fetch failure path', () => {
  const fn = extractFn('fetchChannelOwnerEmotes')

  test('catch path no longer deletes the 7TV set mapping', () => {
    // Splitting on 'catch' isolates the failure branch. The old code ran
    // seventvEmoteSetIds.delete(key) + release7TVEmoteSet there.
    const catchIdx = fn.lastIndexOf('} catch')
    expect(catchIdx).toBeGreaterThan(-1)
    const catchBlock = fn.slice(catchIdx)
    expect(catchBlock.includes('seventvEmoteSetIds.delete')).toBe(false)
    expect(catchBlock.includes('release7TVEmoteSet')).toBe(false)
  })

  test('catch path schedules a retry', () => {
    const catchBlock = fn.slice(fn.lastIndexOf('} catch'))
    expect(catchBlock.includes('scheduleEmoteRefetch()')).toBe(true)
  })

  test('partial-failure path (anyFailed) schedules a retry', () => {
    const idx = fn.indexOf('if (anyFailed)')
    expect(idx).toBeGreaterThan(-1)
    // Retry scheduled within the anyFailed handling, before the eviction loop.
    const after = fn.slice(idx, fn.indexOf('channelKeys', idx))
    expect(after.includes('scheduleEmoteRefetch()')).toBe(true)
  })
})

describe('hs-emote-refetch alarm', () => {
  test('scheduleEmoteRefetch arms a one-shot chrome alarm (survives SW eviction)', () => {
    const fn = extractFn('scheduleEmoteRefetch')
    expect(fn.includes("'hs-emote-refetch'")).toBe(true)
    expect(fn.includes('delayInMinutes')).toBe(true)
  })

  test('alarm handler refetches active tab channels', () => {
    const idx = BG_SRC.indexOf("alarm.name === 'hs-emote-refetch'")
    expect(idx).toBeGreaterThan(-1)
    const handler = BG_SRC.slice(idx, idx + 1200)
    expect(handler.includes('tabChannels.values()')).toBe(true)
    expect(handler.includes('fetchChannelOwnerEmotes(')).toBe(true)
  })

  test('alarm handler lives inside the onAlarm listener', () => {
    const listenerIdx = BG_SRC.indexOf('onAlarm?.addListener')
    const handlerIdx = BG_SRC.indexOf("alarm.name === 'hs-emote-refetch'")
    expect(listenerIdx).toBeGreaterThan(-1)
    expect(handlerIdx).toBeGreaterThan(listenerIdx)
  })
})
