/**
 * The worker's per-channel history rings: past the cap, only a ring nothing shows may go.
 *
 * Each store (twitch 100, kick 50, youtube 30 rings) dropped its oldest ring, and the
 * oldest is the channel shown longest: a saved channel restored at boot, the stream
 * open all evening. Once enough others had passed through in one worker's life, that
 * channel's history went and every tab opened after showed it empty. Same shape as the
 * emote-cache cap (96a04361). Runs the real ingest paths in the real worker.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll } from './harness/sw.js'

afterEach(disposeAll)

const kickLine = (ch, i) =>
  `bgKickIngest({ channel: '${ch}', id: '${ch}-${i}', time: Date.now(), username: 'u', content: 'hi' })`

describe('history rings past the cap', () => {
  test('kick: a saved channel keeps its ring however many others pass through', async () => {
    const sw = await bootSw()
    sw.eval(`joinedExtraChannels.add('kick/saved')`)
    sw.eval(kickLine('saved', 0))
    for (let i = 0; i < 60; i++) sw.eval(kickLine(`pass${i}`, 0))
    expect(sw.eval(`BG_KICK.channels.has('saved')`)).toBe(true)
    expect(sw.eval(`BG_KICK.channels.size`)).toBe(50)
    // the passers-by go oldest first
    expect(sw.eval(`BG_KICK.channels.has('pass0')`)).toBe(false)
    expect(sw.eval(`BG_KICK.channels.has('pass59')`)).toBe(true)
  })

  test('kick: a channel a tab is booked on keeps its ring', async () => {
    const sw = await bootSw()
    sw.eval(`tabChannels.set(7, { channel: 'kick/onpage', channelOwner: null })`)
    sw.eval(kickLine('onpage', 0))
    for (let i = 0; i < 55; i++) sw.eval(kickLine(`pass${i}`, 0))
    expect(sw.eval(`BG_KICK.channels.has('onpage')`)).toBe(true)
  })

  test('kick: every ring in use, the store goes over cap and the new ring stays', async () => {
    const sw = await bootSw()
    for (let i = 0; i < 52; i++) {
      sw.eval(`joinedExtraChannels.add('kick/s${i}')`)
      sw.eval(kickLine(`s${i}`, 0))
    }
    sw.eval(kickLine('newcomer', 0))
    expect(sw.eval(`BG_KICK.channels.size`)).toBe(53)
    expect(sw.eval(`BG_KICK.channels.get('newcomer').getAll().length`)).toBe(1)
  })

  test('youtube: a subscribed channel keeps its ring', async () => {
    const sw = await bootSw()
    sw.eval(`youtubeChannelUrls['UCsaved-Ab_1'] = 'https://www.youtube.com/@saved'`)
    sw.eval(`bgYtIngest({ channelId: 'UCsaved-Ab_1', id: 'y0', text: 'hi' })`)
    for (let i = 0; i < 35; i++) sw.eval(`bgYtIngest({ channelId: 'UCpass${i}', id: 'p${i}', text: 'hi' })`)
    expect(sw.eval(`BG_YT.channels.has('UCsaved-Ab_1')`)).toBe(true)
    expect(sw.eval(`BG_YT.channels.size`)).toBe(30)
  })

  test('twitch: the stream a tab is reading keeps its ring', async () => {
    const sw = await bootSw()
    sw.eval(`BG_IRC.channelTabs.set('watched', new Set([7])); bgIrcEnsureChannel('watched')`)
    for (let i = 0; i < 105; i++) sw.eval(`bgIrcEnsureChannel('pass${i}')`)
    expect(sw.eval(`BG_IRC.channels.has('watched')`)).toBe(true)
    expect(sw.eval(`BG_IRC.channels.size`)).toBe(100)
  })
})
