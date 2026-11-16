/**
 * A page tearing itself down never takes a saved channel's room or history from the other tabs.
 *
 * The rebuild path (fullSpaReinit: a popout, a page whose panel never mounted) destroyed the
 * page's kick client, and KickChat.destroy left every kick channel it held. The background
 * keeps one room per channel for every tab and, on a leave, drops it, its history and its
 * saved join: the other tabs' saved kick chats went silent and empty until a watchdog
 * rejoin 90s later. The youtube twin wiped the saved channel's history on the reinit's
 * unsubscribe. Runs the real KickChat.destroy and the real worker.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcKickSaved } from '../src/multichat/rejoin.js'
import { bootSw, disposeAll } from './harness/sw.js'

afterEach(disposeAll)

const IRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')
function sliceClass(name) {
  const s = IRC.indexOf(`class ${name} `)
  if (s === -1) throw new Error(`class not found: ${name}`)
  return IRC.slice(s, IRC.indexOf('\n}\n', s) + 3)
}

function kickPage(saved) {
  const sent = []
  const KickChat = new Function(
    'safeSendMessage',
    'chrome',
    'config',
    'mcKickSaved',
    'log',
    `${sliceClass('ChatClient')}\n${sliceClass('KickChat')}\nreturn KickChat`,
  )(
    (m) => sent.push(m),
    { runtime: { onMessage: { removeListener() {} } } },
    { channels: saved },
    mcKickSaved,
    () => {},
  )
  const kc = new KickChat()
  return { kc, sent }
}

describe('a page tearing down', () => {
  test('leaves only the kick channels nothing saved names', () => {
    const { kc, sent } = kickPage([{ id: 'mix', twitch: 'stableronaldo', kick: 'SXB' }])
    kc.channels.set('sxb', {}) // saved: every tab shows it
    kc.channels.set('lifeismizzy', {}) // this page's own channel, not saved
    kc.destroy()
    const left = sent.filter((m) => m.data?.type === 'channel:leave').map((m) => m.data.channel)
    expect(left).toEqual(['lifeismizzy'])
  })

  test('the worker keeps a saved youtube channel history through the reinit unsubscribe', async () => {
    const sw = await bootSw()
    sw.eval(
      `BG_YT.channels.set('yt-lofi', { getAll: () => [] }); youtubeChannelUrls['yt-lofi'] = 'https://www.youtube.com/@lofigirl'`,
    )
    await sw.send({ type: 'youtube_ws_unsubscribe', channelId: 'yt-lofi', videoId: 'abcdefghijk', keep: true })
    expect(sw.eval(`BG_YT.channels.has('yt-lofi')`)).toBe(true)
    expect(sw.eval(`youtubeChannelUrls['yt-lofi']`)).toBe('https://www.youtube.com/@lofigirl')
    // a real removal still clears it
    await sw.send({ type: 'youtube_ws_unsubscribe', channelId: 'yt-lofi', videoId: 'abcdefghijk' })
    expect(sw.eval(`BG_YT.channels.has('yt-lofi')`)).toBe(false)
  })

  test('the reinit marks every saved youtube unsubscribe keep', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'spa-nav.js'), 'utf8')
    const loop = src.slice(src.indexOf('for (const ch of config.channels) {', src.indexOf('function fullSpaReinit(')))
    expect(loop.slice(0, 400)).toContain('keep: true')
  })
})
