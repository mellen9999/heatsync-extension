// resolveTwitchChannelId returned null for THREE unrelated cases — channel
// genuinely absent, GQL threw, and the 6s ceiling — and every mod action
// rendered all three as "channel not found". A mod hit a 4s network blip mid
// raid and was told the channel doesn't exist. resolveTwitchChannelIdEx now
// tags whether null is transient; these prove the tag is right per path.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const API = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-api.js'), 'utf8')

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

// Rebuild the inner resolver against injected transports. Cache pre-seeded empty.
function makeInner({ gql, relay }) {
  return new Function(
    'gqlProxy',
    'browser',
    `const _twChannelIdCache = new Map()
     const _cacheChannelId = (id) => _twChannelIdCache.set('x', { id, ts: Date.now() })
     async ${extractFn(API, '_resolveTwitchChannelIdInner')}
     return _resolveTwitchChannelIdInner`,
  )(gql, { runtime: { sendMessage: relay } })
}

const throws = () => {
  throw new Error('GQL proxy timeout')
}

describe('_resolveTwitchChannelIdInner transient tagging', () => {
  test('GQL returns an id → found, not transient', async () => {
    const inner = makeInner({ gql: async () => ({ data: { user: { id: '123' } } }), relay: async () => ({}) })
    expect(await inner('xqc')).toEqual({ id: '123', transient: false })
  })

  test('GQL clean null, relay clean empty → DEFINITIVE not found', async () => {
    const inner = makeInner({ gql: async () => ({ data: { user: null } }), relay: async () => ({}) })
    expect(await inner('ghost')).toEqual({ id: null, transient: false })
  })

  test('GQL throws, relay empty → TRANSIENT (the bug: was rendered "not found")', async () => {
    const inner = makeInner({ gql: throws, relay: async () => ({}) })
    expect(await inner('xqc')).toEqual({ id: null, transient: true })
  })

  test('GQL throws, relay throws → transient', async () => {
    const inner = makeInner({ gql: throws, relay: throws })
    expect(await inner('xqc')).toEqual({ id: null, transient: true })
  })

  test('GQL throws but relay resolves → found (fallback recovered)', async () => {
    const inner = makeInner({ gql: throws, relay: async () => ({ id: '999' }) })
    expect(await inner('xqc')).toEqual({ id: '999', transient: false })
  })

  test('empty login is not a transient failure', async () => {
    const inner = makeInner({ gql: throws, relay: throws })
    expect(await inner('')).toEqual({ id: null, transient: false })
  })

  // The dangerous asymmetry: a clean GQL null must WIN over a later relay throw,
  // or a genuinely-absent channel gets mislabeled transient and a mod is told
  // "try again" forever on a channel that will never resolve.
  test('GQL clean null then relay throws → still definitive not found', async () => {
    const inner = makeInner({ gql: async () => ({ data: { user: null } }), relay: throws })
    expect(await inner('ghost')).toEqual({ id: null, transient: false })
  })
})

describe('mod action error copy', () => {
  test('all five mod verbs split transient from not-found', () => {
    for (const fn of [
      'banTwitchUser',
      'timeoutTwitchUser',
      'unbanTwitchUser',
      'announceTwitchChat',
      'deleteTwitchMessage',
    ]) {
      const body = extractFn(API, fn)
      expect(body, fn).toContain("transient ? 'twitch unreachable — try again' : 'channel not found'")
    }
  })

  test('the string wrapper still returns a bare id for value consumers', () => {
    expect(API).toContain('return (await resolveTwitchChannelIdEx(channelLogin)).id')
  })
})
