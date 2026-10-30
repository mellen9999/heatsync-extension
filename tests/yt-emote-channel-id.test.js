import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// resolveYtChannelId lives in chrome/background.js (not importable) — slice + eval with stubs.
const src = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const a = src.indexOf('async function resolveYtChannelId')
const b = src.indexOf('let twitchIdPersistTimer')
if (a < 0 || b < a) throw new Error('resolveYtChannelId markers moved')
const body = src.slice(a, b)

function make() {
  const calls = { handle: [], fetched: [] }
  const fn = new Function(
    'getYtChannelHandle',
    'fetchWithTimeout',
    'ytChannelIdCache',
    'YT_CHANNEL_ID_CACHE_MAX',
    'log',
    `${body}; return resolveYtChannelId`,
  )(
    async (id) => {
      calls.handle.push(id)
      return id === 'AbCdEfGhIjK' ? 'somehandle' : null
    },
    async (url) => {
      calls.fetched.push(url)
      return { ok: true, text: async () => '"externalId":"UCabcdefghijklmnopqrstuv"', body: { cancel() {} } }
    },
    new Map(),
    300,
    () => {},
  )
  return { fn, calls }
}

test('a mixed-case videoId resolves through oEmbed with its case intact', async () => {
  const { fn, calls } = make()
  expect(await fn('AbCdEfGhIjK')).toBe('UCabcdefghijklmnopqrstuv')
  expect(calls.handle).toEqual(['AbCdEfGhIjK'])
  expect(calls.fetched[0]).toBe('https://www.youtube.com/@somehandle')
})

test('an @handle hint still wins over the name', async () => {
  const { fn, calls } = make()
  await fn('AbCdEfGhIjK', 'https://www.youtube.com/@drdisrespect/live')
  expect(calls.handle).toEqual([])
  expect(calls.fetched[0]).toBe('https://www.youtube.com/@drdisrespect')
})

test('a bare handle is used directly', async () => {
  const { fn, calls } = make()
  await fn('drdisrespect')
  expect(calls.fetched[0]).toBe('https://www.youtube.com/@drdisrespect')
})

// ── native chat emotes stay on this chat's channel ──────────────────────────
const yc = readFileSync(new URL('../chrome/youtube-content.js', import.meta.url), 'utf8')

test('native yt chat merges only its own channel owner set', () => {
  expect(yc).toContain('if (ownedByMe(owner) && Array.isArray(ownerEmotes)) take(ownerEmotes, 0)')
  expect(yc).not.toContain('Object.values(channelEmotesByOwner)')
})

test('the background tells the iframe which owner is its own', () => {
  expect(src).toContain('sendResponse({ received: true, channelKey: ytChanKey })')
  expect(yc).toContain('myOwnerKey = String(resp.channelKey)')
})

test('owner matching ignores @ and case but never matches an empty key', () => {
  const m = yc.match(/const normOwner =[\s\S]*?const ownedByMe = [^\n]+/)
  const f = new Function('myOwnerKey', `${m[0]}; return ownedByMe`)
  expect(f('')('@abc')).toBe(false)
  expect(f('@DrDisrespect')('drdisrespect')).toBe(true)
  expect(f('AbCdEfGhIjK')('zzzzzzzzzzz')).toBe(false)
})
