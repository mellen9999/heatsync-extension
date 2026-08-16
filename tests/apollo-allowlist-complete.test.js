import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every Apollo mutation the extension calls must be in the MAIN-world allowlist.
 *
 * apolloMutate posts a searchTerm to early-inject-main.js, which refuses
 * anything not on ALLOWED_MUTATIONS. The allowlist is a real security control —
 * the nonce is observable in MAIN world, so without it a forged message could
 * proxy ANY cached operation with the user's OAuth + integrity token. It stays.
 *
 * But it is maintained by hand in a different file from its callers, and it has
 * silently broken a shipped feature FOUR times, each found by a user rather
 * than by us:
 *
 *   1. Chat_BanUserFromChatRoom / UnbanUser / DeleteChatMessage — every mod
 *      action no-oped.
 *   2. AcceptPredictionTerms — the predictions tab wedged on the ToS step.
 *   3. SendAnnouncementMessage — /announce silently dead, burning the full
 *      apolloMutate timeout first.
 *   4. CreatePredictionEvent / Lock / Resolve / Cancel — the broadcaster could
 *      not run a prediction at all, while MakePrediction (the viewer's bet) was
 *      allowed, so it looked like a permissions problem.
 *
 * Failure mode is always the same and always invisible: apolloMutate resolves
 * with "mutation not allowed", the rawQuery fallback is dead for mutations, and
 * the caller reports a generic failure. Nothing throws.
 *
 * So: derive the required set from the CALLERS and diff it against the list.
 */

const ROOT = join(import.meta.dir, '..')

const ALLOWLIST_FILE = join(ROOT, 'chrome', 'early-inject-main.js')

function allowedMutations() {
  const src = readFileSync(ALLOWLIST_FILE, 'utf8')
  const start = src.indexOf('const ALLOWED_MUTATIONS = [')
  if (start === -1) throw new Error('ALLOWED_MUTATIONS not found in early-inject-main.js')
  const end = src.indexOf(']', start)
  const body = src.slice(start, end).replace(/\/\/[^\n]*/g, '')
  return new Set([...body.matchAll(/'([A-Za-z_][\w]*)'/g)].map((m) => m[1]))
}

/**
 * searchTerms the extension actually sends. Two call shapes:
 *   apolloMutate({ searchTerm: 'X', … })
 *   predictionMutation('X', 'resultField', 'mutation…', vars)
 * Both are matched literally — a searchTerm built from a variable would not be
 * checkable here, and there are none.
 */
function calledSearchTerms() {
  const out = new Map()
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!name.endsWith('.js')) continue
      if (/^multichat-(twitch|kick|youtube)\.js$/.test(name)) continue // build output
      const src = readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '')
      const rel = p.slice(ROOT.length + 1)
      for (const m of src.matchAll(/searchTerm:\s*'([A-Za-z_][\w]*)'/g)) out.set(m[1], rel)
      for (const m of src.matchAll(/predictionMutation\(\s*'([A-Za-z_][\w]*)'/g)) out.set(m[1], rel)
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out
}

describe('apollo mutation allowlist', () => {
  test('both sides are actually found (guard against a parser that matches nothing)', () => {
    expect(allowedMutations().size).toBeGreaterThan(10)
    expect(calledSearchTerms().size).toBeGreaterThan(5)
  })

  test('every mutation the extension calls is allowed', () => {
    const allowed = allowedMutations()
    const missing = [...calledSearchTerms().entries()]
      .filter(([op]) => !allowed.has(op))
      .map(([op, where]) => `${op} (called from ${where})`)
    expect(missing).toEqual([])
  })

  test("the broadcaster's prediction verbs are all there, not just the viewer's bet", () => {
    const allowed = allowedMutations()
    // Pinned by name: MakePrediction being present while these were absent is
    // exactly what made the bug read as "you're not the broadcaster".
    for (const op of [
      'CreatePredictionEvent',
      'LockPredictionEvent',
      'ResolvePredictionEvent',
      'CancelPredictionEvent',
      'MakePrediction',
    ]) {
      expect(allowed.has(op), `${op} missing from ALLOWED_MUTATIONS`).toBe(true)
    }
  })
})
