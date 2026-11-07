import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// a channel-less page opens on the feed (heap budget: twitch /directory): the first paint builds
// one screenful, not the whole 30-post page, and scrolling builds the rest before asking the server
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}

describe('feed first paint', () => {
  test('renderFeed builds the first screenful only', () => {
    expect(fn('renderFeed')).toMatch(/feedMessages\.slice\(0, Math\.max\(feedRendered, FEED_FIRST_PAINT\)\)/)
    expect(SRC).toMatch(/const FEED_FIRST_PAINT = (\d|1[0-2])\n/)
  })

  test('a fresh (non-append) fetch resets the rendered count', () => {
    expect(fn('fetchFeed')).toMatch(/feedPage = 1\n\s+feedRendered = 0/)
  })

  function make(buffered, hasMore) {
    const calls = []
    const env = new Function(
      'calls',
      `
      let feedMessages = new Array(${buffered}).fill(0)
      let feedRendered = 8
      let feedHasMore = ${hasMore}
      let feedLoading = false
      const FEED_REVEAL_STEP = 12
      const renderFeedAppend = (from, step) => { calls.push(['append', from, step]); feedRendered = Math.min(feedMessages.length, from + step) }
      const fetchFeed = (append) => calls.push(['fetch', append])
      ${fn('feedMore')}
      return feedMore
    `,
    )(calls)
    return { feedMore: env, calls }
  }

  test('scrolling builds the buffered rows before it fetches', () => {
    const { feedMore, calls } = make(30, true)
    feedMore()
    feedMore()
    expect(calls).toEqual([
      ['append', 8, 12],
      ['append', 20, 12],
    ])
    expect(feedMore()).toBe(true)
    expect(calls.at(-1)).toEqual(['fetch', true])
  })

  test('nothing buffered and nothing more on the server does nothing', () => {
    const { feedMore, calls } = make(8, false)
    expect(feedMore()).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('feed fill', () => {
  const run = (el) => {
    const calls = []
    new Function(
      'calls',
      'el',
      `
      const mcSignal = null, activeThread = null, document = { getElementById: () => el }
      let currentTab = 'feed'
      const requestAnimationFrame = () => {}
      const feedMore = () => { calls.push('more'); return true }
      ${fn('feedFillPane')}
      feedFillPane()
    `,
    )(calls, el)
    return calls
  }
  const el = (clientHeight, scrollHeight) => ({ clientHeight, scrollHeight, querySelector: () => ({}) })

  test('a pane with no height builds nothing (hidden or collapsed)', () => expect(run(el(0, 0))).toEqual([]))
  test('a tall pane with room left builds more rows', () => expect(run(el(600, 400))).toEqual(['more']))
  test('a pane already overflowing waits for the scroll', () => expect(run(el(300, 900))).toEqual([]))
})
