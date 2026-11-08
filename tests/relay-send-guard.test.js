/**
 * The server asks, the browser decides: relayed kick / youtube sends.
 *
 * kick:relay_send and yt:relay_send let heatsync.org's server post through the
 * user's own platform login. The legit flow is: a person presses Enter in the
 * heatsync.org composer, the server's own API route cannot send, so it asks
 * their browser. Nothing in that frame is verifiable, so the extension now
 * refuses anything that is not (1) within seconds of a trusted keypress/tap on
 * heatsync.org in this browser, (2) a fresh request id, (3) not the same text to
 * the same place again, (4) within a per-place gap and per-minute caps.
 *
 * The real source runs here: the guard from 05-ws.js and the two `case` blocks
 * that call it, against a fake storage, fake platform senders and a fake clock.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
const EXT_ID = 'hsextensionidhsextensionidhsextens'

const GUARD_START = SRC.indexOf('const RELAY_DUP_MS')
const GUARD_END = SRC.indexOf('async function connectWebSocket() {')
if (GUARD_START < 0 || GUARD_END < GUARD_START) throw new Error('relay guard markers missing')
const GUARD = SRC.slice(GUARD_START, GUARD_END)

const CASES_START = SRC.indexOf("      case 'yt:relay_send':")
const CASES_END = SRC.indexOf("      case 'kick-sub-event':")
if (CASES_START < 0 || CASES_END < CASES_START) throw new Error('relay case blocks missing')
const CASES = SRC.slice(CASES_START, CASES_END)

const YT_VIDEO_ID_LINE = SRC.match(/^const YT_VIDEO_ID = .*$/m)?.[0]
if (!YT_VIDEO_ID_LINE) throw new Error('YT_VIDEO_ID missing')

const T0 = Date.parse('2026-11-08T12:00:00Z')
afterEach(() => setSystemTime())

function fakeArea(seed = {}) {
  const data = { ...seed }
  return {
    data,
    get: async (k) => (typeof k === 'string' ? (k in data ? { [k]: data[k] } : {}) : { ...data }),
    set: async (o) => void Object.assign(data, o),
  }
}

function load({ local = fakeArea(), session = fakeArea(), platform = {} } = {}) {
  const sent = { kick: [], yt: [] }
  const acks = []
  const logs = []
  const timers = []
  const browser = { runtime: { id: EXT_ID }, storage: { local, session } }
  const stubs = {
    sendYoutubeChat:
      platform.yt ||
      (async (a) => {
        sent.yt.push(a)
        return { ok: true, ytUsername: 'ytme' }
      }),
    resolveKickChannelIdBg: platform.resolve || (async () => ({ channelId: 777 })),
    sendKickMessageViaTab:
      platform.kick ||
      (async (id, text) => {
        sent.kick.push({ id, text })
        return { ok: true }
      }),
  }
  const make = new Function(
    'browser',
    'log',
    'setTimeout',
    'sendYoutubeChat',
    'resolveKickChannelIdBg',
    'sendKickMessageViaTab',
    'wsSendDirect',
    `${YT_VIDEO_ID_LINE}
${GUARD}
async function handle(msg) {
  switch (msg.type) {
${CASES}
  }
}
return { admitRelay, runGuardedRelay, relayDiagSummary, relayLog, handle, _relay }`,
  )
  const api = make(
    browser,
    (...a) => logs.push(a.join(' ')),
    (fn, ms) => timers.push({ fn, ms }),
    stubs.sendYoutubeChat,
    stubs.resolveKickChannelIdBg,
    stubs.sendKickMessageViaTab,
    (m) => acks.push(m),
  )
  const flushLog = () => {
    for (const t of timers.splice(0)) t.fn()
  }
  // handle() starts the async work and returns; wait for the ack
  const relay = async (msg) => {
    const ackFor = () => acks.filter((a) => a.reqId === msg.reqId).pop()
    const had = acks.filter((a) => a.reqId === msg.reqId).length
    await api.handle(msg)
    for (let i = 0; i < 400 && acks.filter((a) => a.reqId === msg.reqId).length === had; i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    return ackFor()
  }
  return { ...api, sent, acks, logs, local, session, flushLog, relay }
}

const VID = 'abcdefghijk'
let n = 0
const kick = (channel, text, over = {}) => ({ type: 'kick:relay_send', reqId: `kick-${++n}`, channel, text, ...over })
const yt = (videoId, text, over = {}) => ({ type: 'yt:relay_send', reqId: `yt-${++n}`, videoId, text, ...over })

describe('the legitimate flow still goes through', () => {
  test('a keypress on heatsync.org, then the server relays: kick posts and acks ok', async () => {
    setSystemTime(T0)
    const h = load()
    const ack = await h.relay(kick('SomeChannel', 'hello chat'))
    expect(ack).toMatchObject({ type: 'kick:relay_ack', ok: true })
    expect(ack.reqId).toMatch(/^kick-/)
    expect(h.sent.kick).toEqual([{ id: 777, text: 'hello chat' }])
  })

  test('youtube: posts through the tab and hands back the account that sent', async () => {
    setSystemTime(T0)
    const h = load()
    const ack = await h.relay(yt(VID, 'hi from the site'))
    expect(ack).toMatchObject({ type: 'yt:relay_ack', ok: true, ytUsername: 'ytme' })
    expect(h.sent.yt).toEqual([{ videoId: VID, text: 'hi from the site' }])
  })

  test('a merged tab sends kick and youtube at the same instant: both go', async () => {
    setSystemTime(T0)
    const h = load()
    const [a, b] = await Promise.all([
      h.relay(kick('chan', 'one line to two rooms')),
      h.relay(yt(VID, 'one line to two rooms')),
    ])
    expect([a.ok, b.ok]).toEqual([true, true])
  })

  test('the next line a few seconds later goes, and so does the same text after the repeat window', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'first'))).ok).toBe(true)
    setSystemTime(T0 + 2500)
    expect((await h.relay(kick('chan', 'second'))).ok).toBe(true)
    setSystemTime(T0 + 13_000)
    expect((await h.relay(kick('chan', 'first'))).ok).toBe(true)
    expect(h.sent.kick.map((s) => s.text)).toEqual(['first', 'second', 'first'])
  })

  test('a person typing for a long while keeps the window open (a report every 5 s is enough)', async () => {
    setSystemTime(T0)
    const h = load()
    for (let s = 0; s <= 60; s += 5) {
      setSystemTime(T0 + s * 1000)
    }
    setSystemTime(T0 + 60_000 + 1500)
    expect((await h.relay(kick('chan', 'finally sent'))).ok).toBe(true)
  })

  test('a send that failed (no kick tab) reports the platform error, and the same text may be tried again at once', async () => {
    setSystemTime(T0)
    let n2 = 0
    const h = load({
      platform: {
        kick: async (_id, text) => {
          if (++n2 === 1) return { ok: false, error: 'no_kick_tab' }
          h.sent.kick.push({ text })
          return { ok: true }
        },
      },
    })
    const first = await h.relay(kick('chan', 'try me twice'))
    expect(first).toMatchObject({ ok: false, error: 'no_kick_tab' })
    setSystemTime(T0 + 1200)
    expect((await h.relay(kick('chan', 'try me twice'))).ok).toBe(true)
  })

  test('the platform helper throwing becomes a failed ack, never an unhandled rejection', async () => {
    setSystemTime(T0)
    const h = load({
      platform: {
        yt: async () => {
          throw new Error('tab exploded')
        },
      },
    })
    expect(await h.relay(yt(VID, 'boom'))).toMatchObject({ ok: false, error: 'tab exploded' })
  })

  test('a kick channel that will not resolve says no_channel', async () => {
    setSystemTime(T0)
    const h = load({ platform: { resolve: async () => ({ error: 'kick api 404' }) } })
    expect(await h.relay(kick('nosuchchan', 'hello'))).toMatchObject({ ok: false, error: 'no_channel' })
  })
})

describe('no keypress needed (a phone types, the desktop browser posts)', () => {
  test('a relay frame with no local keypress ever goes through, on both platforms', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'typed on the phone'))).ok).toBe(true)
    expect((await h.relay(yt(VID, 'typed on the phone'))).ok).toBe(true)
    expect(h.sent.kick).toHaveLength(1)
    expect(h.sent.yt).toHaveLength(1)
  })

  test('caps and the repeat guard still block with no keypress in play', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'same words'))).ok).toBe(true)
    setSystemTime(T0 + 2000)
    expect(await h.relay(kick('chan', 'same words'))).toMatchObject({ ok: false, error: 'duplicate_message' })
    expect(await h.relay(kick('chan', 'x', { reqId: 'fixed' }))).toMatchObject({ ok: true })
    expect(await h.relay(kick('chan', 'y', { reqId: 'fixed' }))).toMatchObject({
      ok: false,
      error: 'duplicate_request',
    })
    setSystemTime(T0 + 2100)
    expect(await h.relay(kick('chan', 'too soon'))).toMatchObject({ ok: false, error: 'rate_limited' })
    expect(await h.relay(kick('chan', 'z'.repeat(501)))).toMatchObject({ ok: false, error: 'invalid_text' })
  })
})

describe('replays, repeats and floods', () => {
  test('the same request id twice posts once', async () => {
    setSystemTime(T0)
    const h = load()
    const frame = kick('chan', 'once only')
    expect((await h.relay(frame)).ok).toBe(true)
    setSystemTime(T0 + 3000)
    expect(await h.relay({ ...frame })).toMatchObject({ ok: false, error: 'duplicate_request' })
    expect(h.sent.kick).toHaveLength(1)
  })

  test('identical text to the same place inside 10 s is refused; case and spacing do not dodge it', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'buy my thing'))).ok).toBe(true)
    setSystemTime(T0 + 2000)
    expect(await h.relay(kick('chan', 'buy my thing'))).toMatchObject({ ok: false, error: 'duplicate_message' })
    setSystemTime(T0 + 4000)
    expect(await h.relay(kick('CHAN', '  Buy   my THING '))).toMatchObject({ ok: false, error: 'duplicate_message' })
    expect(h.sent.kick).toHaveLength(1)
  })

  test('the same text to another place, or other text to the same place, is fine', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'gg'))).ok).toBe(true)
    expect((await h.relay(kick('other', 'gg'))).ok).toBe(true)
    setSystemTime(T0 + 2000)
    expect((await h.relay(kick('chan', 'gg!'))).ok).toBe(true)
  })

  test('two to the same place less than a second apart: the second is refused', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(kick('chan', 'a'))).ok).toBe(true)
    setSystemTime(T0 + 400)
    expect(await h.relay(kick('chan', 'b'))).toMatchObject({ ok: false, error: 'rate_limited' })
    setSystemTime(T0 + 1100)
    expect((await h.relay(kick('chan', 'b'))).ok).toBe(true)
  })

  test('15 a minute to one place is the ceiling; the 16th waits for the minute to turn', async () => {
    setSystemTime(T0)
    const h = load()
    for (let i = 0; i < 15; i++) {
      setSystemTime(T0 + i * 1100)
      expect((await h.relay(kick('chan', `line ${i}`))).ok).toBe(true)
    }
    setSystemTime(T0 + 15 * 1100)
    expect(await h.relay(kick('chan', 'line 15'))).toMatchObject({ ok: false, error: 'rate_limited' })
    setSystemTime(T0 + 61_000)
    expect((await h.relay(kick('chan', 'line 15'))).ok).toBe(true)
  })

  test('20 a minute overall, across any number of places', async () => {
    setSystemTime(T0)
    const h = load()
    for (let i = 0; i < 20; i++) {
      setSystemTime(T0 + i * 1000)
      expect((await h.relay(kick(`chan${i}`, `hi ${i}`))).ok).toBe(true)
    }
    setSystemTime(T0 + 20_500)
    expect(await h.relay(kick('chan99', 'one too many'))).toMatchObject({ ok: false, error: 'rate_limited' })
    expect(h.sent.kick).toHaveLength(20)
  })

  test('a server hammering frames with keypress cover is held to the caps', async () => {
    setSystemTime(T0)
    const h = load()
    let landed = 0
    for (let i = 0; i < 300; i++) {
      setSystemTime(T0 + i * 100) // 10 frames a second for 30 s
      if ((await h.relay(kick(`c${i % 7}`, `spam ${i}`))).ok) landed++
    }
    expect(landed).toBeLessThanOrEqual(20)
  })
})

describe('malformed frames are refused before anything runs', () => {
  const bad = [
    ['a video id that is not 11 characters', () => yt('short', 'hi'), 'invalid_video_id'],
    ['a video id with a slash', () => yt('abc/../defgh', 'hi'), 'invalid_video_id'],
    ['no video id', () => yt(undefined, 'hi'), 'invalid_video_id'],
    ['an array for a video id', () => yt([VID], 'hi'), 'invalid_video_id'],
    ['a channel with a path in it', () => kick('../../api/v2/users', 'hi'), 'invalid_channel'],
    ['no channel', () => kick(undefined, 'hi'), 'invalid_channel'],
    ['an object for a channel', () => kick({ toString: () => 'chan' }, 'hi'), 'invalid_channel'],
    ['empty text', () => kick('chan', '   '), 'invalid_text'],
    ['text that is not a string', () => kick('chan', { a: 1 }), 'invalid_text'],
    ['youtube text over 200', () => yt(VID, 'x'.repeat(201)), 'invalid_text'],
    ['kick text over 500', () => kick('chan', 'x'.repeat(501)), 'invalid_text'],
    ['no request id', () => kick('chan', 'hi', { reqId: undefined }), 'invalid_request'],
    ['an oversized request id', () => kick('chan', 'hi', { reqId: 'r'.repeat(65) }), 'invalid_request'],
  ]
  for (const [name, make, error] of bad) {
    test(name, async () => {
      setSystemTime(T0)
      const h = load()
      expect(await h.relay(make())).toMatchObject({ ok: false, error })
      expect(h.sent.kick).toEqual([])
      expect(h.sent.yt).toEqual([])
    })
  }

  test('the length limits are inclusive: 200 on youtube, 500 on kick go', async () => {
    setSystemTime(T0)
    const h = load()
    expect((await h.relay(yt(VID, 'y'.repeat(200)))).ok).toBe(true)
    expect((await h.relay(kick('chan', 'k'.repeat(500)))).ok).toBe(true)
  })
})

describe('the record the user can read', () => {
  test('every outcome is written: sent, failed and refused', async () => {
    setSystemTime(T0)
    const h = load({ platform: { kick: async () => ({ ok: false, error: 'no_kick_tab' }) } })
    await h.relay(kick('chan', '   '))
    await h.relay(yt(VID, 'goes'))
    setSystemTime(T0 + 2000)
    await h.relay(kick('chan', 'fails'))
    h.flushLog()
    const rows = h.local.data.hs_relay_log
    expect(rows.map((r) => [r.p, r.to, r.r])).toEqual([
      ['kick', 'chan', 'refused:invalid_text'],
      ['youtube', VID, 'sent'],
      ['kick', 'chan', 'failed:no_kick_tab'],
    ])
    expect(rows[1]).toMatchObject({ n: 4, x: 'goes' })
  })

  test('a flood of refusals folds into one counted row instead of burying the real entries', async () => {
    setSystemTime(T0)
    const h = load()
    await h.relay(kick('chan', 'a real one'))
    setSystemTime(T0 + 90_000)
    for (let i = 0; i < 400; i++) await h.relay(kick('chan', ' ')) // every frame below is refused
    h.flushLog()
    const rows = h.local.data.hs_relay_log
    expect(rows).toHaveLength(2)
    expect(rows[0].r).toBe('sent')
    expect(rows[1]).toMatchObject({ r: 'refused:invalid_text', c: 400 })
  })

  test('the log never holds more than 50 rows and survives a restart', async () => {
    setSystemTime(T0)
    const h = load()
    for (let i = 0; i < 80; i++) {
      setSystemTime(T0 + i * 100_000)
      await h.relay(kick(`chan${i}`, `line ${i}`))
    }
    h.flushLog()
    expect(h.local.data.hs_relay_log).toHaveLength(50)
    const reborn = load({ local: h.local })
    expect((await reborn.relayDiagSummary()).recent).toHaveLength(10)
  })

  test('the diag copy carries counts and places, never the text', async () => {
    setSystemTime(T0)
    const h = load()
    await h.relay(kick('chan', 'a private-ish sentence'))
    setSystemTime(T0 + 2000)
    await h.relay(kick('chan', 'another one', { reqId: 'x' }))
    const d = await h.relayDiagSummary()
    expect(d.outcomes).toEqual({ sent: 2 })
    expect(d.recent[0]).toMatchObject({ p: 'kick', to: 'chan', r: 'sent' })
    expect(JSON.stringify(d)).not.toContain('sentence')
  })
})
