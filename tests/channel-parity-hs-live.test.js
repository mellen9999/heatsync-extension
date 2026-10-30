import { describe, expect, test } from 'bun:test'
import { fillHsLiveLeg, parseYoutubeChannelType, ytHandleLiveUrl } from '../src/lib/utils.js'

describe('fillHsLiveLeg', () => {
  test('a twitch-only tab gains the youtube leg from a youtube row', () => {
    const e = { id: 'drdisrespect', twitch: 'drdisrespect', kick: '', youtube: '' }
    expect(fillHsLiveLeg(e, 'yt', 'drdisrespect')).toBe(true)
    expect(e.youtube).toBe('https://www.youtube.com/@drdisrespect/live')
    expect(e.twitch).toBe('drdisrespect')
  })
  test('never overwrites an existing leg', () => {
    const e = { id: 'x', twitch: 'x', kick: '', youtube: 'https://www.youtube.com/@other/live' }
    expect(fillHsLiveLeg(e, 'yt', 'x')).toBe(false)
    expect(e.youtube).toBe('https://www.youtube.com/@other/live')
  })
  test('fills kick', () => {
    const e = { id: 'x', twitch: 'x', kick: '', youtube: '' }
    expect(fillHsLiveLeg(e, 'kick', 'x')).toBe(true)
    expect(e.kick).toBe('x')
  })
})

describe('ytHandleLiveUrl', () => {
  test('binds /@handle/live', () => {
    expect(ytHandleLiveUrl('/@DrDisrespect/live')).toBe('https://www.youtube.com/@drdisrespect/live')
    expect(ytHandleLiveUrl('/@drdisrespect/live/')).toBe('https://www.youtube.com/@drdisrespect/live')
  })
  test('ignores other pages', () => {
    expect(ytHandleLiveUrl('/@drdisrespect')).toBe('')
    expect(ytHandleLiveUrl('/@drdisrespect/streams')).toBe('')
    expect(ytHandleLiveUrl('/watch')).toBe('')
    expect(parseYoutubeChannelType('/@a/live', '')).toBe('handle')
  })
})
