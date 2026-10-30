import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolveTypedModChannel } from '../src/lib/utils.js'

const B = ['live', 'feed', 'add']
const chans = [
  { id: 'xqc', twitch: 'xqc', kick: 'xqc-kick' },
  { id: 'dr-yt', twitch: '', kick: '', youtube: 'https://www.youtube.com/@dr/live' },
]

describe('resolveTypedModChannel', () => {
  test('live tab on twitch acts on the page channel, never "live"', () => {
    const r = resolveTypedModChannel('live', 'twitch', 'Shroud', [], B)
    expect(r).toMatchObject({ channel: 'shroud', twitch: 'shroud', kick: null })
  })
  test('live tab on kick acts as a kick slug', () => {
    const r = resolveTypedModChannel('live', 'kick', 'some-streamer', [], B)
    expect(r).toMatchObject({ channel: 'some-streamer', twitch: null, kick: 'some-streamer', platform: 'kick' })
  })
  test('live tab reuses the saved tab so linked legs fan out', () => {
    const r = resolveTypedModChannel('live', 'twitch', 'xqc', chans, B)
    expect(r).toMatchObject({ channel: 'xqc', twitch: 'xqc', kick: 'xqc-kick' })
  })
  test('live tab on yt acts on nothing', () => {
    expect(resolveTypedModChannel('live', 'yt', 'drdisrespect', [], B).channel).toBeNull()
  })
  test('dashed channel tab ids are accepted', () => {
    expect(resolveTypedModChannel('dr-yt', 'twitch', 'x', chans, B)).toMatchObject({ channel: 'dr-yt', twitch: null })
  })
  test('built-in tabs act on nothing', () => {
    expect(resolveTypedModChannel('feed', 'twitch', 'x', chans, B).channel).toBeNull()
  })
})

test('twitch-only commands no longer fall back to the live/host channel as a twitch login', () => {
  const src = readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8')
  expect(src).not.toMatch(/twitchLogin = getLiveChannel\(\)/)
  expect(src).not.toMatch(/login = getLiveChannel\(\)/)
})
