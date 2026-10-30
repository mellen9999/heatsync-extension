// A streamer banned on twitch who only streams on youtube goes live on YOUTUBE.
// The event always carried platform 'youtube'; the page used to drop it, so the
// "went live" row linked to twitch.tv, the hover card looked the name up as a
// twitch login (no user, no avatar), and the tab it opened enabled twitch only.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hsLiveChannelEntry, streamEventPlatform, streamEventUrl } from '../src/lib/utils.js'

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

describe('streamEventPlatform', () => {
  test('youtube / yt / kick map through, anything else is twitch', () => {
    expect(streamEventPlatform('youtube')).toBe('youtube')
    expect(streamEventPlatform('YT')).toBe('youtube')
    expect(streamEventPlatform('kick')).toBe('kick')
    expect(streamEventPlatform('twitch')).toBe('twitch')
    expect(streamEventPlatform(undefined)).toBe('twitch')
    expect(streamEventPlatform('weird')).toBe('twitch')
  })
})

describe('streamEventUrl', () => {
  test('twitch is unchanged', () => {
    expect(streamEventUrl('twitch', 'xqc')).toBe('https://twitch.tv/xqc#hs-live')
    expect(streamEventUrl(undefined, 'xqc')).toBe('https://twitch.tv/xqc#hs-live')
  })
  test('youtube opens the live stream by handle', () => {
    expect(streamEventUrl('youtube', 'drdisrespect')).toBe('https://www.youtube.com/@drdisrespect/live#hs-live')
    expect(streamEventUrl('youtube', '@drdisrespect')).toBe('https://www.youtube.com/@drdisrespect/live#hs-live')
  })
  test('kick opens kick, and the handle is encoded', () => {
    expect(streamEventUrl('kick', 'trainwreckstv')).toBe('https://kick.com/trainwreckstv#hs-live')
    expect(streamEventUrl('youtube', 'a/b')).toBe('https://www.youtube.com/@a%2Fb/live#hs-live')
  })
})

describe('hsLiveChannelEntry enables only the platform the page is on', () => {
  test('youtube page: youtube live url, no twitch/kick', () => {
    expect(hsLiveChannelEntry('yt', 'drdisrespect')).toEqual({
      id: 'drdisrespect',
      twitch: '',
      kick: '',
      youtube: 'https://www.youtube.com/@drdisrespect/live',
    })
  })
  test('twitch and kick pages are unchanged', () => {
    expect(hsLiveChannelEntry('twitch', 'xqc')).toEqual({ id: 'xqc', twitch: 'xqc', kick: '', youtube: '' })
    expect(hsLiveChannelEntry('kick', 'xqc')).toEqual({ id: 'xqc', twitch: '', kick: 'xqc', youtube: '' })
  })
})

describe('the page keeps the event platform end to end', () => {
  test('all three go-live producers stamp the platform onto the row', () => {
    expect(MAIN.match(/\.\.\.eventPlatformField\(/g)?.length).toBe(3)
  })
  test('the row links, labels and opens by event platform, not a hardcoded twitch', () => {
    const branch = MAIN.slice(
      MAIN.indexOf("if (m.type === 'stream-event') {"),
      MAIN.indexOf("if (m.type === 'feed-post') {"),
    )
    expect(branch).not.toContain('https://twitch.tv/')
    expect(branch).toContain('streamEventUrl(evtPlat, ch)')
    expect(branch).toContain('data-platform="${evtPlat}"')
  })
  test('#hs-live builds the tab from the host platform', () => {
    expect(MAIN).toContain('hsLiveChannelEntry(plat, cur)')
    expect(MAIN).not.toContain("location.hostname.includes('kick.com') ? 'kick' : 'twitch'\n        if (cur")
  })
})
