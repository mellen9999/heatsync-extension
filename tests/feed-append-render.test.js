/**
 * Feed infinite-scroll append path:
 *  1. fetchFeed(append) routes to renderFeedAppend — a full renderFeed() there
 *     rebuilt all 150 rows (tearing down every embed iframe) and reset
 *     scrollTop to 0, yanking the reader back to the top on every "load more".
 *  2. renderFeedAppend never clears the container and never touches scrollTop.
 *  3. feedHasMore goes false at the 150 cap — the clamp discards everything
 *     further fetches return, so leaving hasMore true made the scroll sentinel
 *     fetch-and-drop forever.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOCIAL_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

function sliceFn(name) {
  const s = SOCIAL_SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  const e = SOCIAL_SRC.indexOf('\nfunction ', s + 1)
  return SOCIAL_SRC.slice(s, e === -1 ? undefined : e)
}

describe('feed append render', () => {
  const fetchFeedSrc = sliceFn('fetchFeed')
  const appendSrc = sliceFn('renderFeedAppend')

  test('fetchFeed append path calls renderFeedAppend, not full renderFeed', () => {
    expect(fetchFeedSrc).toMatch(/if \(append\) renderFeedAppend\(appendStart\)/)
    expect(fetchFeedSrc).toMatch(/else renderFeed\(\)/)
  })

  test('renderFeedAppend never clears the container or touches scroll position', () => {
    expect(appendSrc).not.toContain('msgsEl.textContent')
    expect(appendSrc).not.toContain('innerHTML')
    expect(appendSrc).not.toContain('scrollTop')
  })

  test('renderFeedAppend removes and re-adds the loader sentinel', () => {
    expect(appendSrc).toContain(".querySelector('.hs-feed-loader')?.remove()")
    expect(appendSrc).toContain('hs-feed-loader')
  })

  test('renderFeedAppend continues zebra parity from startIndex', () => {
    expect(appendSrc).toMatch(/startIndex \+ i \+ 1\) % 2 === 0/)
  })

  test('feedHasMore goes false at the 150 cap', () => {
    expect(fetchFeedSrc).toMatch(/usedHotFallback \|\| feedMessages\.length >= 150/)
  })

  test('full renderFeed still resets scroll (fresh-load behavior unchanged)', () => {
    const renderFeedSrc = sliceFn('renderFeed')
    expect(renderFeedSrc).toContain('msgsEl.scrollTop = 0')
  })
})
