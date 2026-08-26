/**
 * switchTab → surface-name mapping (src/multichat/main.js _reportSurfaceOpen).
 *
 * This is the only thing standing between "which tab did you open" and the
 * number the server counts, and a wrong mapping here produces a confident,
 * wrong answer to the one question the counter exists for — whether a live
 * install ever reaches the social surface. So the table is pinned rather than
 * eyeballed: uncounted tabs must stay silent, and every channel tab (anything
 * not on the static list) has to read as multichat.
 *
 * _reportSurfaceOpen is closure-local inside main.js's IIFE and can't be
 * imported, so this evaluates its real source text against a stub sender —
 * a behavioral test, not a source-grep.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceBetween(marker, endMarker) {
  const start = MAIN_SRC.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const end = MAIN_SRC.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(start, end)
}

const REPORT_SRC = sliceBetween(
  '  const _UNCOUNTED_TABS = new Set(',
  '\n  function switchTab(id) {',
)

function makeReporter() {
  const sent = []
  const factory = new Function(
    'safeSendMessage',
    `${REPORT_SRC}\nreturn _reportSurfaceOpen`,
  )
  return { report: factory((m) => sent.push(m)), sent }
}

describe('_reportSurfaceOpen', () => {
  test('the social surfaces map to their server names', () => {
    const { report, sent } = makeReporter()
    report('feed')
    report('whispers')
    report('mentions')
    expect(sent.map((m) => m.surface)).toEqual(['feed', 'dm', 'mentions'])
    expect(sent.every((m) => m.type === 'hs_surface_open')).toBe(true)
  })

  test('a channel tab reads as multichat', () => {
    const { report, sent } = makeReporter()
    report('live')
    report('twitch:kripp')
    expect(sent.map((m) => m.surface)).toEqual(['multichat', 'multichat'])
  })

  // These say nothing about whether anyone reached the social layer, and
  // counting them as multichat would inflate the denominator with people who
  // only opened a settings pane.
  test('the uncounted tabs send nothing', () => {
    const { report, sent } = makeReporter()
    for (const id of ['settings', 'discover', 'pinned', 'modlog', 'add']) report(id)
    expect(sent).toEqual([])
  })

  test('only ever sends names the server allowlist accepts', () => {
    const { report, sent } = makeReporter()
    for (const id of ['feed', 'whispers', 'mentions', 'live', 'kick:xqc', 'settings']) report(id)
    const allowed = new Set(['multichat', 'feed', 'dm', 'mentions'])
    expect(sent.every((m) => allowed.has(m.surface))).toBe(true)
  })

  test('a send failure cannot break a tab switch', () => {
    const factory = new Function('safeSendMessage', `${REPORT_SRC}\nreturn _reportSurfaceOpen`)
    const report = factory(() => {
      throw new Error('background gone')
    })
    expect(() => report('feed')).not.toThrow()
  })
})
