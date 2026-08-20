/**
 * The retry helper both AMO clients now sit behind.
 *
 * It exists because a single 503 used to be fatal: on 2026-08-20 Mozilla served
 * `503 Backend.max_conn reached` for hours, and amo-fetch-signed.js would die on
 * the first one — inside its own fifteen-minute wait loop — while publish.js
 * threw before uploading anything. Retrying the retryable is the whole job, and
 * NOT retrying a 4xx matters just as much: a 401 is bad credentials, and
 * hammering it four times only delays saying so.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { amoFetchWithRetry, amoHealthy, isRetryableStatus } from '../scripts/lib/amo-retry.js'

// bun test shares one globalThis across files, and a stub left behind here
// would be inherited by every file that runs after — which is exactly how the
// release workflow wedged for six hours. Captured now, restored in afterAll.
const REAL_FETCH = globalThis.fetch
afterAll(() => {
  globalThis.fetch = REAL_FETCH
})

const res = (status) => new Response('', { status })
const quiet = () => {}
const fast = { baseDelayMs: 1, log: quiet }

describe('what counts as transient', () => {
  test('the statuses AMO actually served during the outage', () => {
    for (const s of [500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true)
    // Rate limiting and request timeouts are worth another go too.
    for (const s of [408, 425, 429]) expect(isRetryableStatus(s)).toBe(true)
  })

  test('nothing a retry could fix on our side', () => {
    for (const s of [200, 201, 301, 400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(s)).toBe(false)
    }
  })
})

describe('amoFetchWithRetry', () => {
  test('rides out a wobble and returns the eventual success', async () => {
    let n = 0
    const out = await amoFetchWithRetry(
      () => {
        n++
        return Promise.resolve(res(n < 3 ? 503 : 200))
      },
      { attempts: 4, ...fast },
    )
    expect(n).toBe(3)
    expect(out.status).toBe(200)
  })

  test('a 4xx comes straight back, unretried', async () => {
    let n = 0
    const out = await amoFetchWithRetry(
      () => {
        n++
        return Promise.resolve(res(401))
      },
      { attempts: 4, ...fast },
    )
    expect(n).toBe(1)
    expect(out.status).toBe(401)
  })

  test('an outage that never lifts returns the last response, not an exception', async () => {
    // Callers all check res.ok and raise their own error with context; throwing
    // here would lose which endpoint failed.
    let n = 0
    const out = await amoFetchWithRetry(
      () => {
        n++
        return Promise.resolve(res(503))
      },
      { attempts: 3, ...fast },
    )
    expect(n).toBe(3)
    expect(out.status).toBe(503)
  })

  test('network errors retry and then propagate', async () => {
    let n = 0
    await expect(
      amoFetchWithRetry(
        () => {
          n++
          return Promise.reject(new Error('ECONNRESET'))
        },
        { attempts: 3, ...fast },
      ),
    ).rejects.toThrow('ECONNRESET')
    expect(n).toBe(3)
  })

  test('a request that fails then recovers survives', async () => {
    let n = 0
    const out = await amoFetchWithRetry(
      () => {
        n++
        return n === 1 ? Promise.reject(new Error('socket hang up')) : Promise.resolve(res(200))
      },
      { attempts: 3, ...fast },
    )
    expect(out.status).toBe(200)
  })

  test('the request is rebuilt per attempt, not replayed', async () => {
    // AMO's JWTs expire in five minutes and a FormData body cannot be re-sent,
    // so the thunk has to be called again rather than a Request held onto.
    const seen = []
    await amoFetchWithRetry(
      () => {
        seen.push(Symbol('attempt'))
        return Promise.resolve(res(seen.length < 2 ? 503 : 200))
      },
      { attempts: 3, ...fast },
    )
    expect(seen.length).toBe(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('amoHealthy', () => {
  test('200 means go', async () => {
    globalThis.fetch = () => Promise.resolve(res(200))
    expect(await amoHealthy()).toBe(true)
  })

  test('the 503 mozilla served all morning means wait', async () => {
    globalThis.fetch = () => Promise.resolve(res(503))
    expect(await amoHealthy()).toBe(false)
  })

  test('a host that will not answer is false, never a throw', async () => {
    // curl reported 000 for long stretches; a health check that explodes is
    // worse than one that says no.
    globalThis.fetch = () => Promise.reject(new Error('fetch failed'))
    expect(await amoHealthy()).toBe(false)
  })
})
