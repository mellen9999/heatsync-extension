/**
 * The panel beside a stream shows other channels too, but the tab stays booked as its page's
 * channel. join_channel books the sender's tab, and the last one sent won: a kick tab with a
 * saved twitch channel was booked as that twitch channel (s3 e2e, 11-15). The worker side is
 * run in sw-message-routing.test.js; this runs the panel side.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const src = (f) => readFileSync(join(MC, f), 'utf8')

function sliceFn(text, name) {
  const s = text.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  return text.slice(s, text.indexOf('\n}\n', s) + 3)
}

/** ytSubscribe from social.js on a given host, with the messages it sends captured. */
function ytSubscribeOn(host) {
  const sent = []
  const fn = new Function(
    'gateAtBoot',
    'browser',
    'chrome',
    'hsYtOriginRoom',
    'safeSendMessage',
    'trackJoin',
    '_ytHistoryAsked',
    'hostPlatform',
    'location',
    `${sliceFn(src('social.js'), 'ytSubscribe')}; return ytSubscribe`,
  )(
    () => true,
    { runtime: { sendMessage: () => Promise.resolve() } },
    { runtime: { sendMessage: () => Promise.resolve() } },
    () => {},
    (m) => {
      sent.push(m)
      return Promise.resolve()
    },
    () => {},
    new Set(),
    host,
    { search: '' },
  )
  return { fn, joins: () => sent.filter((m) => m.type === 'join_channel') }
}

describe('panel joins never take the tab from its page', () => {
  test('a saved youtube channel loads its set without booking the tab', () => {
    for (const host of ['twitch', 'kick', 'yt']) {
      const { fn, joins } = ytSubscribeOn(host)
      fn('yt-lofi', 'https://www.youtube.com/@LofiGirl/live', 'yt-lofi')
      expect(joins()).toEqual([expect.objectContaining({ platform: 'youtube', channel: 'yt-lofi', book: false })])
    }
  })

  test("a twitch or kick page's linked youtube does not book the tab; the youtube page's own stream does", () => {
    for (const host of ['twitch', 'kick']) {
      const { fn, joins } = ytSubscribeOn(host)
      fn('__live_yt_auto__', 'https://www.youtube.com/@x/live', 'x')
      expect(joins()[0].book).toBe(false)
    }
    const { fn, joins } = ytSubscribeOn('yt')
    fn('__live_yt_auto__', 'https://www.youtube.com/watch?v=abcdefghijk', 'x')
    expect(joins()[0]).not.toHaveProperty('book')
  })

  test('no panel file books a tab with a saved twitch channel; they join as extras', () => {
    const files = readdirSync(MC).filter((f) => f.endsWith('.js'))
    for (const f of files) expect(src(f)).not.toMatch(/type: 'join_channel', platform: 'twitch'/)
    const extras = files.flatMap((f) => src(f).match(/joinExtraChannel\('twitch', /g) || [])
    expect(extras.length).toBeGreaterThanOrEqual(9)
  })
})
