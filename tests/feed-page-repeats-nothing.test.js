/**
 * The feed asks for older posts by page number, counted from the newest post. A post that arrives
 * while the reader is on page one moves every older post down a place, so page two began with the
 * post page one ended on, and the reader saw it twice.
 *
 * Runs the real fetchFeed against a server that holds a list of posts and pages it by offset.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const from = SRC.indexOf('async function fetchFeed(')
const FETCH = SRC.slice(from, SRC.indexOf('\n}\n', from) + 3)

function feed(count) {
  const post = (n) => ({ base36_id: `p${n}`, username: 'someone', created_at: new Date(1e12 + n * 1000).toISOString() })
  // newest first, as the server sorts them
  const server = Array.from({ length: count }, (_, i) => post(count - i))
  const asked = []
  const scope = {
    feedMessages: [],
    feedLoaded: false,
    feedLoading: false,
    feedPage: 1,
    feedRendered: 0,
    feedHasMore: true,
    feedLastFetch: 0,
    feedFromHotFallback: false,
    feedFallbackIsCold: false,
    currentTab: 'feed',
    isOpMsg: () => true,
    log() {},
    noteSeenEvent() {},
    feedBookmarksLoad() {},
    renderFeed() {},
    renderFeedAppend() {},
    hsPaneTaken: () => false,
    apiFetch: async (path) => {
      asked.push(path)
      const q = new URLSearchParams(path.split('?')[1])
      const limit = Number(q.get('limit'))
      const at = (Number(q.get('page')) - 1) * limit
      const messages = server.slice(at, at + limit)
      return { ok: true, data: { messages, pagination: { hasMore: at + limit < server.length } } }
    },
  }
  const fetchFeed = new Function('scope', `with (scope) { ${FETCH}\n return fetchFeed }`)(scope)
  return { scope, server, asked, fetchFeed, arrive: (n) => server.unshift(post(n)) }
}

test('a post that arrives between two pages does not put the last row of the first page on screen twice', async () => {
  const f = feed(100)
  await f.fetchFeed()
  expect(f.scope.feedMessages.length).toBe(30)
  f.arrive(101)
  f.arrive(102)
  await f.fetchFeed(true)
  const ids = f.scope.feedMessages.map((m) => m.base36_id)
  expect(new Set(ids).size).toBe(ids.length)
  // the two repeats are dropped, the 28 older ones kept, in order
  expect(ids.length).toBe(58)
  expect(ids[29]).toBe('p71')
  expect(ids[30]).toBe('p70')
  expect(ids.at(-1)).toBe('p43')
  expect(f.scope.feedPage).toBe(2)
  expect(f.scope.feedHasMore).toBe(true)
})

test('with nothing new in between, a page is taken whole', async () => {
  const f = feed(100)
  await f.fetchFeed()
  await f.fetchFeed(true)
  expect(f.scope.feedMessages.map((m) => m.base36_id)).toEqual(f.server.slice(0, 60).map((m) => m.base36_id))
  expect(f.asked.map((p) => new URLSearchParams(p.split('?')[1]).get('page'))).toEqual(['1', '2'])
})
