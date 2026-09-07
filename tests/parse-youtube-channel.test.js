/**
 * D2: youtube.com/channel/<UCid>/live had no branch in getCurrentChannel —
 * it fell through to null, so the live tab never auto-subscribed on a
 * channel-id URL (only @handle, ?v=, and /live/<videoId> worked). This is
 * the pure URL-parsing core, extracted so the four shapes are testable
 * without a real `location`.
 */

import { describe, expect, test } from 'bun:test'
import { parseYoutubeChannel } from '../src/lib/utils.js'

describe('parseYoutubeChannel', () => {
  test('@handle page → lowercased handle', () => {
    expect(parseYoutubeChannel('/@SomeStreamer', '')).toBe('somestreamer')
    expect(parseYoutubeChannel('/@SomeStreamer/live', '')).toBe('somestreamer')
  })
  test('/watch?v= → the raw videoId, case preserved', () => {
    expect(parseYoutubeChannel('/watch', '?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  test('/live/<videoId> → the raw videoId, case preserved', () => {
    expect(parseYoutubeChannel('/live/dQw4w9WgXcQ', '')).toBe('dQw4w9WgXcQ')
  })
  test('/channel/<UCid> and /channel/<UCid>/live → the raw channel id, case preserved', () => {
    const id = 'UCuAXFkgsw1L7xaCfnd5JJOw'
    expect(parseYoutubeChannel(`/channel/${id}`, '')).toBe(id)
    expect(parseYoutubeChannel(`/channel/${id}/live`, '')).toBe(id)
  })
  test('a non-UC /channel/ path is not treated as a channel id', () => {
    expect(parseYoutubeChannel('/channel/notarealid/live', '')).toBeNull()
  })
  test('handle wins over a ?v= param on the same URL (handle checked first)', () => {
    expect(parseYoutubeChannel('/@somestreamer', '?v=dQw4w9WgXcQ')).toBe('somestreamer')
  })
  test('home/search/directory pages → null', () => {
    expect(parseYoutubeChannel('/', '')).toBeNull()
    expect(parseYoutubeChannel('/results', '?search_query=x')).toBeNull()
    expect(parseYoutubeChannel('/feed/subscriptions', '')).toBeNull()
  })
})
