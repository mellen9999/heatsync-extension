/**
 * fetchWithTimeout settles error bodies and backs off a 429ing third party
 * (chrome/background.js).
 *
 * Regression anchor (2026-10-13): the sender-emote lookups drop non-OK replies
 * unread (`r.ok ? r.json() : null`). An unread response pins its network pipe —
 * a 2MB shared-memory buffer — until the SW garbage-collects it, which a small
 * SW heap almost never does: three busy twitch tabs held 900+ (1.8GB) in under
 * a minute, and near the /tmp quota every renderer's compositor died on it.
 * Errored lookups aren't cached, so a 429 was asked again on every message:
 * 1,600 BTTV 429s in 45s. Peak after: ~235MB, ~15 429s.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const fn = (name) => {
  const at = BG.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} not found — source drifted`)
  const start = BG.lastIndexOf('\n', at) + 1
  return BG.slice(start, BG.indexOf('\n}', at) + 2)
}
const settleErrorBody = new Function(`${fn('settleErrorBody')}\nreturn settleErrorBody`)()

describe('settleErrorBody', () => {
  test('an error reply comes back fully read, same status/headers/body', async () => {
    const r = await settleErrorBody(new Response('{"e":1}', { status: 404, headers: { 'retry-after': '7' } }))
    expect(r.status).toBe(404)
    expect(r.ok).toBe(false)
    expect(r.headers.get('retry-after')).toBe('7')
    expect(await r.json()).toEqual({ e: 1 })
  })

  test('the original body is consumed, so its pipe is released', async () => {
    const orig = new Response('x', { status: 500 })
    await settleErrorBody(orig)
    expect(orig.bodyUsed).toBe(true)
  })

  test('a large error body is cancelled, not buffered', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      cancel: () => {
        cancelled = true
      },
    })
    const r = await settleErrorBody(new Response(stream, { status: 502, headers: { 'content-length': '999999' } }))
    expect(cancelled).toBe(true)
    expect(r.status).toBe(502)
  })

  test('an OK reply passes through untouched', async () => {
    const ok = new Response('y', { status: 200 })
    expect(await settleErrorBody(ok)).toBe(ok)
  })
})

describe('fetchWithTimeout', () => {
  const body = fn('fetchWithTimeout')
  test('every network reply goes through settleErrorBody', () => {
    expect(body).toContain('settleErrorBody(await fetch(')
  })
  test('a third-party 429 parks that host for Retry-After (default 30s)', () => {
    expect(body).toContain('thirdPartyBackoffUntil.set(host')
    expect(body).toMatch(
      /thirdParty && Date\.now\(\) < \(thirdPartyBackoffUntil\.get\(host\) \|\| 0\)\) return fakeBackoffResponse\(\)/,
    )
  })
})
