// twitchPageKind: the one answer to "what is this twitch url". A VOD is never a channel.
import { describe, expect, test } from 'bun:test'
import { twitchPageKind, twitchVodId } from '../src/lib/reserved-paths.js'

describe('twitchPageKind', () => {
  test('a channel, its sub-pages and its popout are channels', () => {
    for (const p of [
      '/nl_kripp',
      '/nl_kripp/',
      '/nl_kripp/videos',
      '/nl_kripp/about',
      '/popout/nl_kripp/chat',
      '/embed/xqc/chat',
    ])
      expect([p, twitchPageKind(p)]).toEqual([p, 'channel'])
  })
  test('/videos/<id> is a vod, with or without a query-less trailing slash', () => {
    expect(twitchPageKind('/videos/2934223993')).toBe('vod')
    expect(twitchPageKind('/videos/2934223993/')).toBe('vod')
    expect(twitchVodId('/videos/2934223993')).toBe('2934223993')
  })
  test('a clip is a clip, on the channel path and on the clips host', () => {
    expect(twitchPageKind('/nl_kripp/clip/FunnySlug-abc123')).toBe('clip')
    expect(twitchPageKind('/FunnySlug-abc123', 'clips.twitch.tv')).toBe('clip')
  })
  test('reserved paths and the vod list are neither channel nor vod', () => {
    for (const p of ['/', '/directory', '/videos', '/videos/abc', '/settings', '/popout/directory/chat', '/p/legal'])
      expect([p, twitchPageKind(p)]).toEqual([p, 'other'])
    expect(twitchVodId('/videos')).toBe('')
    expect(twitchVodId('/nl_kripp')).toBe('')
  })
})
