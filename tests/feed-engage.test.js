import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * feed-engage.js — upvote / bookmark / reaction state for feed posts. The
 * shipped source runs for real with stubbed globals (no DOM): the pure state
 * helpers directly, the network paths through a fake apiFetch.
 */
const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'feed-engage.js'), 'utf8')

function load({ auth = true, replies = () => ({ ok: true, data: {} }) } = {}) {
  const calls = []
  const toasts = []
  const g = {
    hsAuthToken: auth,
    apiFetch: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body })
      return replies(path, opts)
    },
    showToast: (m, k) => toasts.push([m, k]),
    t: (k) => k,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    clEmoteUrlAllowed: (u) => /^https:\/\/(cdn\.7tv\.app|heatsync\.org)\//.test(u),
    isOwnFeedPost: (m) => !!m.own,
    formatHeat: (h) => String(h),
    CSS: { escape: (s) => s },
    document: { querySelectorAll: () => [] },
  }
  const api = new Function(
    ...Object.keys(g),
    `${SRC}\nreturn { feedBookmarks, feedBookmarkSet, feedVoteOptimistic, feedVoteReconcile, feedVoteRollback, feedReactionApply, feedBookmarkUnknown, feedBookmarksLoad, feedBookmarkToggle, feedUpvote, feedReactionToggle, feedReactionsHtml, feedUpvoteHtml }`,
  )(...Object.values(g))
  return { ...api, calls, toasts }
}

describe('upvote state', () => {
  test('optimistic add then second click removes', () => {
    const { feedVoteOptimistic } = load()
    const m = { user_vote: null, vote_score: 3 }
    feedVoteOptimistic(m)
    expect([m.user_vote, m.vote_score]).toEqual([1, 4])
    feedVoteOptimistic(m)
    expect([m.user_vote, m.vote_score]).toEqual([null, 3])
  })
  test('rollback restores, reconcile takes the server numbers', () => {
    const { feedVoteOptimistic, feedVoteRollback, feedVoteReconcile } = load()
    const m = { user_vote: null, vote_score: 0, heat: 5 }
    const snap = feedVoteOptimistic(m)
    feedVoteRollback(m, snap)
    expect([m.user_vote, m.vote_score]).toEqual([null, 0])
    feedVoteReconcile(m, { user_vote: 1, score: 7, heat: 12 })
    expect([m.user_vote, m.vote_score, m.heat]).toEqual([1, 7, 12])
  })
  test('the ▲ is hidden when signed out and on your own post', () => {
    expect(load({ auth: false }).feedUpvoteHtml({ base36_id: 'a' })).toBe('')
    expect(load().feedUpvoteHtml({ base36_id: 'a', own: true })).toBe('')
    expect(load().feedUpvoteHtml({ base36_id: 'a', user_vote: 1 })).toContain('hs-feed-up on')
  })
  test('failure rolls back and surfaces the server error; 401 is the sign-in toast', async () => {
    const m = { base36_id: 'a', user_vote: null, vote_score: 1 }
    let e = load({ replies: () => ({ ok: false, status: 429, error: 'slow down' }) })
    await e.feedUpvote(m)
    expect([m.user_vote, m.vote_score]).toEqual([null, 1])
    expect(e.toasts).toEqual([['slow down', 'error']])
    e = load({ replies: () => ({ ok: false, status: 401, error: 'x' }) })
    await e.feedUpvote(m)
    expect(e.toasts).toEqual([['mc_social_login_first', 'error']])
    expect(e.calls[0]).toEqual({ path: '/api/messages/a/vote', method: 'POST', body: { vote_type: 1 } })
  })
})

describe('bookmarks', () => {
  test('one batched check per 100 unknown ids, none for known', async () => {
    const e = load({
      replies: (_p, o) => ({
        ok: true,
        data: { bookmarked: Object.fromEntries(o.body.message_ids.map((i) => [i, i === 'id1'])) },
      }),
    })
    const msgs = Array.from({ length: 150 }, (_, i) => ({ base36_id: `id${i}` }))
    await e.feedBookmarksLoad(msgs)
    expect(e.calls.map((c) => c.body.message_ids.length)).toEqual([100, 50])
    expect(e.feedBookmarks.get('id1')).toBe(true)
    expect(e.feedBookmarks.get('id2')).toBe(false)
    await e.feedBookmarksLoad(msgs)
    expect(e.calls.length).toBe(2)
  })
  test('signed out makes no request', async () => {
    const e = load({ auth: false })
    await e.feedBookmarksLoad([{ base36_id: 'a' }])
    expect(e.calls.length).toBe(0)
  })
  test('toggle posts then deletes and tracks state', async () => {
    const e = load()
    await e.feedBookmarkToggle('a')
    await e.feedBookmarkToggle('a')
    expect(e.calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect(e.feedBookmarks.get('a')).toBe(false)
  })
  test('a failed toggle leaves state alone', async () => {
    const e = load({ replies: () => ({ ok: false, status: 500, error: 'boom' }) })
    await e.feedBookmarkToggle('a')
    expect(e.feedBookmarks.has('a')).toBe(false)
    expect(e.toasts[0]).toEqual(['boom', 'error'])
  })
})

describe('reactions', () => {
  const mk = () => ({
    base36_id: 'a',
    reactions: [
      { emote_id: 1, emote_name: 'kappa', emote_url: 'https://cdn.7tv.app/k.webp', count: 2, reacted: true },
      { emote_id: 2, emote_name: 'pog', emote_url: 'https://cdn.7tv.app/p.webp', count: 1, reacted: false },
    ],
  })
  test('apply flips mine and the count; zero drops the chip', () => {
    const { feedReactionApply } = load()
    const m = mk()
    feedReactionApply(m, 2, true)
    expect(m.reactions.find((r) => r.emote_id === 2)).toMatchObject({ count: 2, reacted: true })
    feedReactionApply(m, 1, false)
    expect(m.reactions.find((r) => r.emote_id === 1)).toMatchObject({ count: 1, reacted: false })
    const solo = { reactions: [{ emote_id: 9, count: 1, reacted: true }] }
    feedReactionApply(solo, 9, false)
    expect(solo.reactions).toEqual([])
  })
  test('chip click on a reacted chip DELETEs, on another POSTs the emote_id', async () => {
    const e = load()
    const m = mk()
    await e.feedReactionToggle(m, 1)
    await e.feedReactionToggle(m, 2)
    expect(e.calls).toEqual([
      { path: '/api/messages/a/react/1', method: 'DELETE', body: undefined },
      { path: '/api/messages/a/react', method: 'POST', body: { emote_id: 2 } },
    ])
  })
  test('a refused reaction (not in inventory) rolls back and shows the server text', async () => {
    const e = load({
      replies: () => ({ ok: false, status: 403, error: 'you can only react with emotes from your inventory' }),
    })
    const m = mk()
    await e.feedReactionToggle(m, 2)
    expect(m.reactions.find((r) => r.emote_id === 2)).toMatchObject({ count: 1, reacted: false })
    expect(e.toasts[0][0]).toContain('inventory')
  })
  test('chips escape names and drop non-https images; empty list renders nothing', () => {
    const { feedReactionsHtml } = load()
    expect(feedReactionsHtml({ reactions: [] })).toBe('')
    const html = feedReactionsHtml({
      reactions: [
        { emote_id: 3, emote_name: '"><b>', emote_url: 'https://evil.example/x.png', count: 4, reacted: true },
      ],
    })
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<img')
    expect(html).toContain('hs-feed-chip on')
  })
})

describe('review fixes', () => {
  test('chips only show images from the emote CDN hosts, https only', () => {
    const { feedReactionsHtml } = load()
    const html = feedReactionsHtml({
      reactions: [
        { emote_id: 1, emote_name: 'a', emote_url: 'http://cdn.7tv.app/a.webp', count: 1 },
        { emote_id: 2, emote_name: 'b', emote_url: 'https://evil.example/b.webp', count: 1 },
        { emote_id: 3, emote_name: 'c', emote_url: 'https://cdn.7tv.app/c.webp', count: 1 },
      ],
    })
    expect(html.match(/<img/g)?.length).toBe(1)
    expect(html).toContain('https://cdn.7tv.app/c.webp')
  })
  test('the bookmark map is capped, oldest dropped, re-set refreshes', () => {
    const e = load()
    for (let i = 0; i < 2005; i++) e.feedBookmarkSet(`id${i}`, true)
    expect(e.feedBookmarks.size).toBe(2000)
    expect(e.feedBookmarks.has('id0')).toBe(false)
    expect(e.feedBookmarks.has('id2004')).toBe(true)
    e.feedBookmarkSet('id5', false)
    expect([...e.feedBookmarks.keys()].pop()).toBe('id5')
  })
  test('a second click while a vote is in flight is ignored', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const e = load({ replies: async () => (await gate, { ok: true, data: { success: true, score: 1, user_vote: 1 } }) })
    const m = { base36_id: 'a', user_vote: null, vote_score: 0 }
    const first = e.feedUpvote(m)
    await e.feedUpvote(m)
    expect(e.calls.length).toBe(1)
    release()
    await first
    expect(m.user_vote).toBe(1)
    await e.feedUpvote(m)
    expect(e.calls.length).toBe(2)
  })
})

describe('wiring', () => {
  test('module is bundled before social.js and menu rows read the same state', () => {
    const build = readFileSync(join(ROOT, 'build.js'), 'utf8')
    expect(build.indexOf("'feed-engage.js'")).toBeGreaterThan(0)
    expect(build.indexOf("'feed-engage.js'")).toBeLessThan(build.indexOf("'social.js'"))
    const input = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
    expect(input).toContain('feedBookmarkToggle(feedMsg.base36_id)')
    // the optional rows come after the core ones: the numbered menu caps at 9
    const at = (needle) => input.indexOf(needle)
    expect(at("label: 'reply'")).toBeGreaterThan(0)
    expect(at("label: 'view profile'")).toBeLessThan(at("'mc_feed_upvote_remove'"))
    expect(at("'edit note' : 'add note'")).toBeLessThan(at("'mc_feed_upvote_remove'"))
    expect(at("'mc_paint_hide'")).toBeGreaterThan(at("'mc_feed_bookmark_remove'"))
    expect(at("label: 'reply'")).toBeLessThan(at("'mc_feed_upvote_remove'"))
  })
})
