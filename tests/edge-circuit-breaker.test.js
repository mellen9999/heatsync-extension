/**
 * Edge-block circuit breaker — chrome/background.js.
 *
 * Regression anchor (2026-07-20): a Cloudflare rate-limit ban (429 / 1015)
 * never expired because the extension kept retrying hot — blocked requests
 * still count toward CF's rate rule, so the retries re-tripped it every
 * window. The breaker wraps the SW's global fetch for heatsync.org hosts only:
 * while open, calls fail fast with a synthetic 429 and NOTHING reaches the
 * network, so the edge counter drains and the ban actually ends.
 *
 * Carved from the plain-script background.js and evaluated standalone.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()
const start = BG_SRC.indexOf('const _hsEdge = { blockedUntil: 0, streak: 0 }')
const end = BG_SRC.indexOf('// Link preview via heatsync.org server proxy')
if (start === -1 || end === -1 || end <= start) throw new Error('edge-breaker carve markers not found')

function build({ upstream }) {
  const calls = []
  const fakeSelf = {
    fetch: async (input, init) => {
      calls.push(typeof input === 'string' ? input : input?.url)
      return upstream(input, init)
    },
  }
  const state = new Function('self', 'log', `${BG_SRC.slice(start, end)}; return _hsEdge`)(fakeSelf, () => {})
  return { fetch: (...a) => fakeSelf.fetch(...a), calls, state }
}

const ok = () => new Response('{}', { status: 200 })
const blocked = () => new Response('rate limited', { status: 429 })

describe('scope', () => {
  test('non-heatsync hosts always pass through, even while the circuit is open', async () => {
    let status = 429
    const b = build({ upstream: async () => new Response(null, { status }) })
    await b.fetch('https://heatsync.org/api/x') // opens the circuit
    status = 200
    const res = await b.fetch('https://api.twitch.tv/helix/streams')
    expect(res.status).toBe(200)
    expect(b.calls.filter((u) => u.includes('twitch')).length).toBe(1)
  })
})

describe('open circuit', () => {
  test('a 429 opens the cooldown; the next heatsync call never reaches the network', async () => {
    const b = build({ upstream: async () => blocked() })
    await b.fetch('https://heatsync.org/api/users/emotes/batch')
    const before = b.calls.length
    const res = await b.fetch('https://heatsync.org/api/auth/check')
    expect(res.status).toBe(429)
    expect(res.statusText).toBe('hs-edge-cooldown')
    expect(b.calls.length).toBe(before) // fail-fast, no network
  })

  test('consecutive blocks double the window up to the cap', async () => {
    const b = build({ upstream: async () => blocked() })
    const waits = []
    for (let i = 0; i < 7; i++) {
      b.state.blockedUntil = 0 // simulate the previous window elapsing
      const t0 = Date.now()
      await b.fetch('https://heatsync.org/api/x')
      waits.push(b.state.blockedUntil - t0)
    }
    expect(waits[0]).toBeGreaterThanOrEqual(20_000)
    expect(waits[1]).toBeGreaterThanOrEqual(40_000)
    expect(Math.max(...waits)).toBeLessThanOrEqual(300_000 + 50)
    // capped, no runaway: both windows sit at the cap and stop doubling.
    // measured wait = cap + (internal Date.now() − t0), a sub-ms clock drift ≥ 0,
    // so assert "both at the cap" rather than exact equality (which is racy).
    expect(waits[5]).toBeGreaterThanOrEqual(300_000)
    expect(waits[6]).toBeGreaterThanOrEqual(300_000)
    expect(Math.abs(waits[6] - waits[5])).toBeLessThanOrEqual(2)
  })
})

describe('recovery', () => {
  test('a successful response closes the circuit and resets the streak', async () => {
    let mode = 'blocked'
    const b = build({ upstream: async () => (mode === 'blocked' ? blocked() : ok()) })
    await b.fetch('https://heatsync.org/api/x')
    expect(b.state.streak).toBe(1)
    b.state.blockedUntil = 0
    mode = 'ok'
    const res = await b.fetch('https://heatsync.org/api/x')
    expect(res.status).toBe(200)
    expect(b.state.streak).toBe(0)
    expect(b.state.blockedUntil).toBe(0)
  })

  test('a 5xx neither opens the circuit nor clears an existing streak', async () => {
    let status = 429
    const b = build({ upstream: async () => new Response(null, { status }) })
    await b.fetch('https://heatsync.org/api/x')
    expect(b.state.streak).toBe(1)
    b.state.blockedUntil = 0
    status = 503 // origin trouble is not edge recovery
    await b.fetch('https://heatsync.org/api/x')
    expect(b.state.streak).toBe(1)
    expect(b.state.blockedUntil).toBe(0) // and 5xx alone never opens it
  })
})
