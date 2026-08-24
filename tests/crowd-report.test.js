/**
 * Crowd identity capture — the ext-side half of the 'crowd' youtube_source
 * pipeline. Twitch integrity-walls the socialMedias GQL query for the
 * server's DC IP, so only browsers can read a channel's published socials;
 * the ext reports them and the server verifies (yt about-page backlink +
 * multi-user quorum) before anything persists. These tests are tripwires on
 * the source: the safety gates here are what keep a single client from
 * turning a report into a fact.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const src = readFileSync(join(import.meta.dir, '../src/multichat/social.js'), 'utf8')
const fn = src.slice(
  src.indexOf('async function maybeCrowdReportSocials'),
  src.indexOf('// YT POLL SMOOTHING:')
)

describe('crowd report wiring', () => {
  test('hook fires only from the definitive no-link branch, twitch host only', () => {
    const hook = src.indexOf("hostPlatform === 'twitch') maybeCrowdReportSocials")
    expect(hook).toBeGreaterThan(-1)
    // it must sit inside the (p || ri?.notFound) definitive branch of
    // autoResolveLiveYt, not on the transient-failure path
    const branch = src.lastIndexOf('if (p || ri?.notFound)', hook)
    expect(branch).toBeGreaterThan(-1)
    expect(hook - branch).toBeLessThan(400)
  })

  test('function exists exactly once and never throws to its caller', () => {
    expect(fn.length).toBeGreaterThan(0)
    expect(src.split('async function maybeCrowdReportSocials').length).toBe(2)
    // whole body is wrapped: first statement after the opening brace is try
    expect(fn.replace(/\s+/g, ' ')).toContain('maybeCrowdReportSocials(urlCh) { try {')
  })

  test('requires a heatsync session — anonymous votes would gut the quorum', () => {
    expect(fn).toContain('if (!hsAuthToken) return')
  })

  test('login is validated before interpolation into the GQL query', () => {
    const check = fn.indexOf('/^[a-z0-9_]{2,25}$/.test(safe)')
    const query = fn.indexOf('socialMedias')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(query)
  })

  test('7d per-channel throttle stamps even when no link is found', () => {
    expect(fn).toContain('CROWD_REPORT_TTL_MS')
    expect(src).toContain('const CROWD_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000')
    // stamp happens before the `if (!yt) return` bail so "no socials" is
    // also throttled — otherwise every soft-nav re-runs the GQL query
    const stamp = fn.indexOf('map[safe] = Date.now()')
    const bail = fn.indexOf('if (!yt) return')
    expect(stamp).toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(bail)
  })

  test('storage map is capped so it cannot grow unbounded', () => {
    expect(src).toContain('const CROWD_REPORT_MAP_MAX = 200')
    expect(fn).toContain('CROWD_REPORT_MAP_MAX')
  })

  test('youtube link is matched by exact hostname, not substring', () => {
    // "myyoutube.com/x" must not pass a substring check — the picker parses
    // the URL and compares the hostname exactly
    expect(fn).toContain("h === 'youtube.com' || h === 'youtu.be'")
    expect(fn).not.toMatch(/url.*includes\(['"]youtube/)
  })

  test('a live-titled youtube link beats the first-listed main channel', () => {
    // kaicenat publishes "youtube" (VOD channel) before "Youtube Live" (the
    // live channel) — position must not win over the live-titled link
    expect(fn).toContain('/\\blive\\b/i.test(')
    expect(fn).toContain('|| ytLinks[0]')
  })

  test('report rides the BG api_fetch relay (CF walls content-script fetches)', () => {
    expect(fn).toContain("apiFetch('/api/identity/crowd-report'")
    expect(fn).toContain("method: 'POST'")
  })
})
