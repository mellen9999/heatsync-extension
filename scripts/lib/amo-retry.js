// AMO goes down, and when it does it goes down in pieces.
//
// 2026-08-20: addons.mozilla.org served `503 Backend.max_conn reached` for
// hours. The read API recovered first, then the upload endpoint started
// answering, while VALIDATION was still dead — so every "is it back yet?"
// probe except AMO's own heartbeat said yes while signing still failed. Three
// CI runs were spent learning that.
//
// Every AMO client we have treated any non-2xx as fatal, so a single 503 killed
// a fifteen-minute wait loop and a whole release. These helpers make transient
// failures transient: 5xx and network errors are retried with backoff, 4xx
// still fails fast (a 401 is bad credentials, not weather).

/** AMO's own health endpoint — the only probe that matched reality. */
export const AMO_HEARTBEAT = 'https://addons.mozilla.org/__heartbeat__'

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export const isRetryableStatus = (status) => RETRYABLE_STATUS.has(status)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * fetch() that survives an AMO wobble.
 *
 * Retries network errors and retryable statuses with exponential backoff,
 * returning the Response either way — callers still decide what a 4xx means,
 * because that differs per endpoint (a 404 from the version lookup means "not
 * registered yet", a 404 from source-attach means we got the id wrong).
 *
 * @param {() => Promise<Response>} doFetch fresh request per attempt — AMO's
 *   JWTs live five minutes and a FormData body cannot be replayed, so the
 *   caller rebuilds rather than us holding one hostage across a long backoff.
 */
export async function amoFetchWithRetry(doFetch, opts = {}) {
  const { attempts = 4, baseDelayMs = 5_000, label = 'amo', log = console.error } = opts
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await doFetch()
      if (!isRetryableStatus(res.status) || i === attempts) return res
      log(`  ${label}: HTTP ${res.status} (attempt ${i}/${attempts}) — retrying`)
    } catch (e) {
      lastErr = e
      if (i === attempts) throw e
      log(`  ${label}: ${e?.message || e} (attempt ${i}/${attempts}) — retrying`)
    }
    await sleep(baseDelayMs * 2 ** (i - 1))
  }
  // Unreachable: the loop either returns or throws on its final attempt.
  throw lastErr || new Error(`${label}: exhausted ${attempts} attempts`)
}

/** True once AMO's heartbeat answers 200. Never throws — a dead host is a `false`. */
export async function amoHealthy(timeoutMs = 20_000) {
  try {
    const res = await fetch(AMO_HEARTBEAT, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status === 200
  } catch {
    return false
  }
}
