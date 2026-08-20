/**
 * The callout token, for real — not by grep.
 *
 * decodeCalloutToken and fiberTokenScan are pure, so this suite lifts them out
 * of main.js (which has top-level side effects and cannot be imported) and runs
 * them against a fake fiber tree shaped like twitch's.
 *
 * The shape under test was measured live on a 107-month sub-anniversary
 * callout: the token is the react KEY of an element two fibers under the queue
 * container, and it is base64 of "<userId>:<channelId>:<count>:<kind>". Reading
 * props instead — under any name — finds nothing, which is what silently broke
 * sharing.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MAIN_SRC = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')

// Lift the two functions plus the regex they close over.
function lift() {
  const from = MAIN_SRC.indexOf('const CALLOUT_TOKEN_SHAPE')
  const declEnd = MAIN_SRC.indexOf('function fiberTokenScan')
  const scanEnd = MAIN_SRC.indexOf('\n  }', MAIN_SRC.indexOf('return out', declEnd)) + 4
  expect(from).toBeGreaterThan(-1)
  expect(declEnd).toBeGreaterThan(from)
  const matchFrom = MAIN_SRC.indexOf('function calloutTokenMatches')
  expect(matchFrom).toBeGreaterThan(-1)
  const src =
    MAIN_SRC.slice(from, MAIN_SRC.indexOf('\n  }', from) + 4) +
    MAIN_SRC.slice(matchFrom, MAIN_SRC.indexOf('\n  }', matchFrom) + 4) +
    MAIN_SRC.slice(declEnd, scanEnd)
  // getFiber is main.js's shared util; the tree here is already fibers.
  return new Function('getFiber', `${src}\nreturn { decodeCalloutToken, fiberTokenScan, calloutTokenMatches }`)(
    (n) => n?.__fiber || null,
  )
}
const { decodeCalloutToken, fiberTokenScan, calloutTokenMatches } = lift()

const tok = (u, c, n, k) => btoa(`${u}:${c}:${n}:${k}`)

describe('decodeCalloutToken', () => {
  test('accepts a real sub-anniversary token and splits it', () => {
    const got = decodeCalloutToken(tok('73266147', '29795919', 107, 'cumulative'))
    expect(got).toEqual({
      raw: tok('73266147', '29795919', 107, 'cumulative'),
      userId: '73266147',
      channelId: '29795919',
      count: 107,
      kind: 'cumulative',
    })
  })

  test('rejects every other string on the page', () => {
    // React keys are mostly plain ids, message uuids and ".0"-style paths.
    for (const s of [
      null,
      undefined,
      42,
      '',
      '.0',
      'abc',
      'chat-line-73266147',
      '3f8a1c92-0b41-4f0e-9a2f-1d6c7b2e5a10',
      btoa('not:a:token'),
      btoa('73266147:29795919:107'),
      btoa('73266147:29795919:107:cumulative:extra'),
      btoa('a:b:c:d'),
    ]) {
      expect(decodeCalloutToken(s)).toBeNull()
    }
  })

  test('rejects a base64 payload that is merely long', () => {
    expect(decodeCalloutToken(btoa('x'.repeat(300)))).toBeNull()
  })
})

describe('fiberTokenScan', () => {
  // container > child > child(key = token), the depth measured live.
  const tree = (key) => {
    const leaf = { key, child: null, sibling: null }
    const mid = { key: null, child: leaf, sibling: null }
    return { __fiber: { key: null, child: mid, sibling: null } }
  }

  test('finds the token twitch hides in a react key', () => {
    const t = tok('73266147', '29795919', 107, 'cumulative')
    expect(fiberTokenScan(tree(t))).toEqual({ token: t, channelId: '29795919', count: 107, kind: 'cumulative' })
  })

  test('reports nothing rather than guessing when the tree has no token', () => {
    expect(fiberTokenScan(tree('chat-line-1'))).toEqual({ token: null, channelId: null, count: 0, kind: null })
  })

  test('walks siblings — the queue renders callouts side by side', () => {
    const t = tok('1', '2', 9, 'streak')
    const el = tree('nope')
    el.__fiber.child.sibling = { key: t, child: null, sibling: null }
    expect(fiberTokenScan(el).token).toBe(t)
  })

  test('never crosses into the callout sitting next to it', () => {
    // A sub anniversary and a watch streak mount as sibling containers, each
    // with its own token. Following the root's sibling would hand back the
    // neighbour's — indistinguishable from our own to the caller.
    const el = tree('nope')
    el.__fiber.sibling = { key: tok('1', '2', 3, 'cumulative'), child: null, sibling: null }
    expect(fiberTokenScan(el).token).toBeNull()
  })

  test('never climbs out of the callout', () => {
    // A parent holding a token must NOT be reachable: climbing turns a two-step
    // lookup into a walk of the whole chat tree, and can pick up a token that
    // belongs to a different callout entirely.
    const el = tree('nope')
    el.__fiber.return = { key: tok('1', '2', 3, 'cumulative'), child: null, sibling: null }
    expect(fiberTokenScan(el).token).toBeNull()
  })

  test('terminates on a cyclic tree instead of hanging', () => {
    const el = tree('nope')
    el.__fiber.child.child.child = el.__fiber
    expect(fiberTokenScan(el).token).toBeNull()
  })

  test('survives an element react never mounted', () => {
    expect(fiberTokenScan({}).token).toBeNull()
    expect(fiberTokenScan(null)).toBeNull()
  })
})

describe('calloutTokenMatches', () => {
  // Behavioural, deliberately. The bug this replaces was a gate reading
  // `scan.count` off a scan that only ever set `scan.months`: always undefined,
  // always false, the whole watch-streak path dead — while the source-text test
  // asserting the gate "contains scan.count === streakCount" passed, because it
  // pinned the shape of the bug rather than its behaviour.
  const resub = { token: 'tok', kind: 'cumulative', count: 107 }
  const streak = { token: 'tok', kind: 'streak', count: 9 }

  test('a sub-anniversary token passes its own gate', () => {
    expect(calloutTokenMatches(resub, { kind: 'cumulative', count: 107 })).toBe(true)
  })

  test('a watch-streak token passes a count-only gate', () => {
    // The kind string a watch streak uses is not something we have observed, so
    // that gate asks about the count and nothing else.
    expect(calloutTokenMatches(streak, { count: 9 })).toBe(true)
  })

  test('the two never satisfy each other', () => {
    expect(calloutTokenMatches(streak, { kind: 'cumulative', count: 107 })).toBe(false)
    expect(calloutTokenMatches(resub, { count: 9 })).toBe(false)
  })

  test('a mismatched count is refused even with the right kind', () => {
    expect(calloutTokenMatches(resub, { kind: 'cumulative', count: 106 })).toBe(false)
  })

  test('no token is never a match, however loose the expectation', () => {
    expect(calloutTokenMatches({ token: null, count: 107 }, undefined)).toBe(false)
    expect(calloutTokenMatches(null, undefined)).toBe(false)
  })

  test('a real scan result satisfies the real gate end to end', () => {
    // The join the rename exists to protect: whatever fiberTokenScan names its
    // fields, the gate has to read the same ones.
    const t = tok('73266147', '29795919', 107, 'cumulative')
    const leaf = { key: t, child: null, sibling: null }
    const scan = fiberTokenScan({ __fiber: { key: null, child: leaf, sibling: null } })
    expect(calloutTokenMatches(scan, { kind: 'cumulative', count: 107 })).toBe(true)
  })
})
