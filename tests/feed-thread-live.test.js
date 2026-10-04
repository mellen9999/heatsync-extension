import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Live thread frames: the content-side join/leave state machine, the frame →
 * cached post update, and the background's one-room-per-tab ledger.
 */
const ROOT = join(import.meta.dir, '..')
const ENGAGE = readFileSync(join(ROOT, 'src', 'multichat', 'feed-engage.js'), 'utf8')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')

function load(posts = {}) {
  const sent = []
  const painted = []
  const timers = []
  const cleared = []
  const g = {
    hsAuthToken: true,
    hsCurrentUserId: '7',
    safeSendMessage: async (m) => sent.push(m),
    feedFindMsg: (id) => posts[id] || null,
    apiFetch: async () => ({ ok: true, data: {} }),
    showToast: () => {},
    t: (k) => k,
    escapeHtml: (s) => String(s),
    clEmoteUrlAllowed: (u) => /^https:\/\/cdn\.7tv\.app\//.test(u),
    cleanup: {
      setIntervalIfVisible: (fn, ms) => (timers.push([fn, ms]), timers.length),
      clearInterval: (id) => cleared.push(id),
    },
    isOwnFeedPost: () => false,
    formatHeat: (h) => String(h),
    CSS: { escape: (s) => s },
    document: { querySelectorAll: () => [] },
  }
  const api = new Function(
    ...Object.keys(g),
    `${ENGAGE.replace('function feedPaintReactions', 'function _unusedPaintReactions').replace(
      'function feedPaintVote',
      'function _unusedPaintVote',
    )}
    function feedPaintReactions(m) { __painted.push(['r', m.base36_id]) }
    function feedPaintVote(m) { __painted.push(['v', m.base36_id]) }
    return { feedThreadSync, feedThreadRoomFor, feedFrameApply, feedOnFrame, room: () => feedThreadRoom }`,
  )
  const bound = new Function('__painted', `return (...a) => (${api.toString()})(...a)`)(painted)
  return { ...bound(...Object.values(g)), sent, painted, timers, cleared }
}

describe('join / leave state machine', () => {
  test('open joins, same thread is a no-op, switching names the new room, close leaves', () => {
    const e = load()
    e.feedThreadSync('Abc12')
    e.feedThreadSync('abc12')
    expect(e.sent).toEqual([{ type: 'feed_thread', room: 'thread:abc12' }])
    e.feedThreadSync('zz9')
    e.feedThreadSync(null)
    e.feedThreadSync(null)
    expect(e.sent.map((m) => m.room)).toEqual(['thread:abc12', 'thread:zz9', null])
    expect(e.room()).toBeNull()
  })
  test('ids the server would refuse never leave the tab', () => {
    const e = load()
    e.feedThreadSync('toolongid99')
    e.feedThreadSync('a b')
    expect(e.sent.length).toBe(0)
    expect(e.feedThreadRoomFor('12345678')).toBe('thread:12345678')
  })
})

describe('frame → cached post', () => {
  const post = () => ({
    base36_id: 'p',
    reactions: [{ emote_id: 1, emote_name: 'k', emote_url: 'https://x/k.webp', count: 2, reacted: true }],
  })
  test('someone else reacting bumps or adds a chip; removing drops it at zero', () => {
    const e = load()
    const m = post()
    expect(e.feedFrameApply(m, { type: 'reaction:added', user_id: 9, emote_id: 1 }, '7')).toBe('reactions')
    expect(m.reactions[0]).toMatchObject({ count: 3, reacted: true })
    e.feedFrameApply(
      m,
      { type: 'reaction:added', user_id: 9, emote_id: 2, emote_name: 'p', emote_url: 'https://cdn.7tv.app/p.webp' },
      '7',
    )
    expect(m.reactions[1]).toMatchObject({
      emote_id: 2,
      count: 1,
      reacted: false,
      emote_url: 'https://cdn.7tv.app/p.webp',
    })
    e.feedFrameApply(m, { type: 'reaction:removed', user_id: 9, emote_id: 2 }, '7')
    expect(m.reactions.map((r) => r.emote_id)).toEqual([1])
  })
  test('my own reaction frames are ignored (the click already applied them)', () => {
    const e = load()
    const m = post()
    expect(e.feedFrameApply(m, { type: 'reaction:added', user_id: 7, emote_id: 1 }, '7')).toBeNull()
    expect(m.reactions[0].count).toBe(2)
  })
  test('a nsfw / content-warned new chip carries the name, not the image', () => {
    const e = load()
    const m = { reactions: [] }
    e.feedFrameApply(
      m,
      {
        type: 'reaction:added',
        user_id: 9,
        emote_id: 5,
        emote_name: 'x',
        emote_url: 'https://cdn.7tv.app/y',
        nsfw: true,
      },
      '7',
    )
    e.feedFrameApply(
      m,
      {
        type: 'reaction:added',
        user_id: 9,
        emote_id: 6,
        emote_name: 'z',
        emote_url: 'https://cdn.7tv.app/z',
        cw_cats: ['gore'],
      },
      '7',
    )
    expect(m.reactions.map((r) => r.emote_url)).toEqual(['', ''])
  })
  test('vote frames set the absolute score and heat (idempotent, own included)', () => {
    const e = load()
    const m = { vote_score: 1, heat: 2 }
    expect(e.feedFrameApply(m, { type: 'vote:updated', score: 4, heat: 9, upvotes: 4 }, '7')).toBe('vote')
    e.feedFrameApply(m, { type: 'vote:updated', score: 4, heat: 9 }, '7')
    expect([m.vote_score, m.heat]).toEqual([4, 9])
  })
  test('onFrame repaints only the post it names; unknown posts and junk are ignored', () => {
    const m = post()
    const e = load({ p: m })
    e.feedOnFrame({ type: 'reaction:added', user_id: 9, emote_id: 1, message_id: 'p' })
    e.feedOnFrame({ type: 'vote:updated', score: 1, message_id: 'p' })
    e.feedOnFrame({ type: 'reaction:added', user_id: 9, emote_id: 1, message_id: 'nope' })
    e.feedOnFrame(null)
    expect(e.painted).toEqual([
      ['r', 'p'],
      ['v', 'p'],
    ])
  })
})

describe('review fixes', () => {
  test('an open thread re-announces its room on a timer (re-registers after a bg restart); close stops it', () => {
    const e = load()
    e.feedThreadSync('abc')
    expect(e.timers.length).toBe(1)
    e.timers[0][0]()
    expect(e.sent.at(-1)).toEqual({ type: 'feed_thread', room: 'thread:abc' })
    e.feedThreadSync(null)
    expect(e.cleared.length).toBe(1)
    const n = e.sent.length
    e.timers[0][0]()
    expect(e.sent.length).toBe(n)
  })
  test('a frame emote from outside the CDN hosts shows as a name only', () => {
    const e = load()
    const m = { reactions: [] }
    e.feedFrameApply(
      m,
      { type: 'reaction:added', user_id: 9, emote_id: 8, emote_name: 'q', emote_url: 'https://evil.example/q' },
      '7',
    )
    expect(m.reactions[0].emote_url).toBe('')
  })
  test('a tab that reloads leaves its room, and a fresh content script clears one', () => {
    expect(BG).toContain("if (changeInfo.status === 'loading') feedThreadSet(tabId, null)")
    const social = readFileSync(join(ROOT, 'src', 'multichat', 'social.js'), 'utf8')
    expect(social).toContain("safeSendMessage({ type: 'feed_thread', room: null })")
  })
})

describe('background wiring', () => {
  test('one room per tab, joined direct, re-joined in the connect burst, dropped on tab close', () => {
    expect(BG).toContain('const feedThreadTabs = new Map()')
    expect(BG).toContain("if (!after.has(r)) wsSendDirect({ type: 'feed:leave', feed: r })")
    expect(BG).toContain(
      "for (const room of new Set(feedThreadTabs.values())) burst.push({ type: 'feed:join', feed: room })",
    )
    expect(BG).toContain('feedThreadSet(tabId, null)')
    expect(BG).toContain("message.type === 'feed_thread'")
  })
  test('the three frames reach the tabs', () => {
    for (const t of ['reaction:added', 'reaction:removed', 'vote:updated']) expect(BG).toContain(`case '${t}':`)
  })
  test('every place the open thread is dropped also leaves the room', () => {
    const social = readFileSync(join(ROOT, 'src', 'multichat', 'social.js'), 'utf8')
    const main = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')
    const spa = readFileSync(join(ROOT, 'src', 'multichat', 'spa-nav.js'), 'utf8')
    for (const src of [social, main, spa]) {
      for (const m of src.matchAll(/activeThread = null\n(\s*)(\S+)/g)) expect(m[2]).toBe('feedThreadSync(null)')
    }
    expect(social).toContain('feedThreadSync(msgId)')
  })
})
