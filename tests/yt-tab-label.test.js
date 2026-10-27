// A youtube channel added by pasting a /watch?v= link had no @handle in its
// URL and no resolved channelName (that only arrives via youtube_status for a
// stream that is actually connected), so the tab label fell all the way
// through to the URL guts and read "watch?v=VGe-dpUmnos" — permanently, for an
// offline channel. These guard the two halves of the fix.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const MAIN = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')
const MGMT = readFileSync(join(ROOT, 'src', 'multichat', 'channel-mgmt.js'), 'utf8')

// The exact regex the label path uses to pull a videoId out of a stored url.
const VID_RE = /[?&]v=([\w-]{11})|\/live\/([\w-]{11})/
const vid = (u) => {
  const m = u.match(VID_RE)
  return m ? m[1] || m[2] : ''
}

describe('videoId extraction for the tab label', () => {
  test('watch url', () => expect(vid('https://www.youtube.com/watch?v=VGe-dpUmnos')).toBe('VGe-dpUmnos'))
  test('live url', () => expect(vid('https://www.youtube.com/live/VGe-dpUmnos')).toBe('VGe-dpUmnos'))
  // The repo's own trap: yt ids contain hyphens and underscores, and a regex
  // that forgets them drops half of all real ids.
  test('ids with hyphens and underscores survive', () => {
    expect(vid('https://www.youtube.com/watch?v=a-b_c-d_e-f')).toBe('a-b_c-d_e-f')
  })
  test('a handle url yields nothing (that branch is handled earlier)', () => {
    expect(vid('https://www.youtube.com/@ShirakamiFubuki/live')).toBe('')
  })
})

describe('wiring', () => {
  test('the label path asks for a resolve', () => {
    expect(MAIN).toContain('resolveYtTabLabel(ch.id, videoId)')
  })
  test('the resolver only ever fires once per videoId', () => {
    expect(MAIN).toContain('_ytLabelTried')
    expect(MAIN).toMatch(/_ytLabelTried\.has\(videoId\)/)
    // Recorded BEFORE the request, so a null answer cannot re-fetch forever.
    const fn = MAIN.slice(MAIN.indexOf('function resolveYtTabLabel'))
    expect(fn.indexOf('_ytLabelTried.add')).toBeLessThan(fn.indexOf('safeSendMessage'))
  })
  test('background answers yt_channel_handle and validates the id', () => {
    expect(BG).toContain("message.type === 'yt_channel_handle'")
    expect(BG).toMatch(/\^\[\\w-\]\{11\}\$/)
  })
  // The website syncs a youtube-only tab as { id: 'tab-<ts>-<rand>', youtube: 'lofigirl' }
  // — a bare handle, and an id that is generated, not a name.
  test('a bare synced handle labels the tab, and a tab-<ts> id never does', () => {
    expect(MAIN).toContain('ch.youtube.match(/^([\\w.-]+)$/)')
    expect(MAIN).toContain('(linked|yt|kick|twitch|tab)[-_]\\d+')
    const handle = (y) => (y.match(/@([^/?]+)/) || y.match(/^([\w.-]+)$/))?.[1]
    expect(handle('lofigirl')).toBe('lofigirl')
    expect(handle('https://www.youtube.com/@lofigirl/live')).toBe('lofigirl')
    expect(handle('https://www.youtube.com/watch?v=VGe-dpUmnos')).toBeUndefined()
  })
  test('youtube now has a duplicate guard like twitch and kick', () => {
    expect(MGMT).toContain('c.youtube === ytVal')
  })
})
