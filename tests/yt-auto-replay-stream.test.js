/**
 * The live tab's youtube slot (__live_yt_auto__) only ever shows the stream on screen.
 *
 * The background keeps one buffer for that slot and replays it to every page that subscribes. Its
 * rows used to be stored and replayed without a videoId, and the page's stream gate let any row
 * without one through. Watch a livestream, open a vod in the same tab: the old stream's chat
 * replayed into the vod's live tab, counted as chat flowing, and the panel stayed up beside a
 * video that has no chat at all.
 *
 * handleYoutubeChatMsg (social.js) and bgYtIngest / ytReplayMessageFor (10-kick-yt.js) are lifted
 * out of the bundle and run for real against a recording scope, like yt-replay-no-alerts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const lift = (file, head) => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', ...file.split('/')), 'utf8')
  const from = src.indexOf(head)
  if (from < 0) throw new Error(`${head} not found in ${file}`)
  return src.slice(from, src.indexOf('\n}\n', from) + 2)
}
const HANDLE = lift('multichat/social.js', 'function handleYoutubeChatMsg(msg) {')
const INGEST = lift('background/10-kick-yt.js', 'function bgYtIngest(payload) {')
const REPLAY = lift('background/10-kick-yt.js', 'function ytReplayMessageFor(channelId, m) {')

const BUILTINS = new Set(['undefined', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Date', 'Math', 'JSON'])
const BUILTINS_MORE = new Set(['RegExp', 'Set', 'Map', 'Promise', 'Error', 'console'])

function inScope(given, body) {
  const calls = []
  const rec =
    (name) =>
    (..._a) => {
      calls.push(name)
    }
  const scope = new Proxy(given, {
    has: (t, k) => typeof k === 'string' && (k in t || !(BUILTINS.has(k) || BUILTINS_MORE.has(k))),
    get: (t, k) => (k in t ? t[k] : rec(String(k))),
  })
  const out = new Function('scope', `with (scope) { ${body} }`)(scope)
  return { calls, out }
}

const VOD = 'jNQXAC9IVRw'
const STREAM = 'jfKfPfyJRdk'

function onWatchPage(msg) {
  const given = {
    config: { channels: [] },
    hostPlatform: 'yt',
    location: { href: `https://www.youtube.com/watch?v=${VOD}` },
    currentTab: 'live',
    ytSubscribedUrls: new Map([['__live_yt_auto__', `https://youtube.com/watch?v=${VOD}`]]),
    _autoYtVideoId: VOD,
    isYtDuplicate: () => false,
    isSentEcho: () => false,
    peekSentHost: () => null,
    isSelf: () => false,
    evaluateFilterRules: () => ({ hide: false, sound: null, notify: false }),
    isMention: () => false,
    ruleAlertsMention: () => false,
    appendMessage: () => true,
    __msg: msg,
  }
  return inScope(given, `${HANDLE}\n handleYoutubeChatMsg(__msg)`).calls
}

const row = (extra) => ({ channelId: '__live_yt_auto__', user: 'lofi', text: 'hi', time: 1, id: 'yt1', ...extra })
const took = (calls) => calls.includes('ingestReplayYtMsg') || calls.includes('enqueueYtForPacing')

describe("the live tab's youtube slot on a watch page", () => {
  test('a replayed row from the stream on screen is taken', () => {
    expect(took(onWatchPage(row({ replay: true, videoId: VOD })))).toBe(true)
  })

  test('a replayed row from the stream an earlier page had open is not', () => {
    expect(took(onWatchPage(row({ replay: true, videoId: STREAM })))).toBe(false)
  })

  test('a replayed row that cannot say which stream it came from is not', () => {
    expect(took(onWatchPage(row({ replay: true })))).toBe(false)
  })

  test('live chat for the stream on screen still flows', () => {
    expect(took(onWatchPage(row({ videoId: VOD })))).toBe(true)
  })
})

describe('the background buffer keeps the stream a row came from', () => {
  test('a stored row replays with its videoId', () => {
    const given = {
      BG_YT: { channels: new Map() },
      BGCircularBuffer: class {
        constructor() {
          this.a = []
        }
        push(m) {
          this.a.push(m)
        }
        getAll() {
          return this.a
        }
      },
      MAX_BG_YT_CHANNELS: 50,
      BG_YT_PERSIST_MAX: 200,
    }
    const { out } = inScope(
      given,
      `${INGEST}\n${REPLAY}
       bgYtIngest({ channelId: '__live_yt_auto__', videoId: '${STREAM}', id: 'x', user: 'u', text: 't', time: 1 })
       const kept = BG_YT.channels.get('__live_yt_auto__').getAll()[0]
       return ytReplayMessageFor('__live_yt_auto__', kept)`,
    )
    expect(out.videoId).toBe(STREAM)
    expect(out.replay).toBe(true)
  })

  test('the server relay hands the batch videoId to the buffer', () => {
    const ws = readFileSync(join(import.meta.dir, '..', 'src', 'background', '05-ws.js'), 'utf8')
    expect(ws).toContain('bgYtIngest({ channelId, videoId: msg.videoId, ...item })')
  })
})
