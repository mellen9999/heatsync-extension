// Kick celebration events (subs, gift subs, KICKs) off the Pusher tap.
//
// Three contracts are load-bearing and each one has failed silently before:
//   1. the tap's broadcast shape must equal the server webhook relay's, or the
//      overlay renders two different things depending on which transport won
//   2. the notice id must be one main.js's noticeKind() actually styles — it
//      was written against the server's long event names, and the short form
//      the relay sends matched nothing
//   3. a channel with BOTH transports must not render every celebration twice
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')
const IRC = readFileSync(join(ROOT, 'src', 'multichat', 'irc.js'), 'utf8')
const MAIN = mainSource()

function extractFn(src, name) {
  const marker = `function ${name}(`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted, update this test`)
  const end = src.indexOf('\n}', start)
  if (end === -1) throw new Error(`extractFn: "${name}" has no closing brace`)
  return src.slice(start, end + 2)
}

// Rebuild the BG handlers against stubs: a fixed chatroom→slug table and a
// broadcast sink. Keeps the test on the parsing/shaping logic, which is the
// part kick can break from their side.
function makeBg() {
  const sent = []
  const api = new Function(`
    const _kpEventStats = { subs: 0, gifts: 0, dropped: 0 }
    const sent = []
    function broadcastToTabs(m) { sent.push(m) }
    function _kpSlugForChatroom(id) { return id === 1279951 ? 'chessbrah' : null }
    ${extractFn(BG, '_kpEventParse')}
    ${extractFn(BG, '_kpEventSlug')}
    ${extractFn(BG, '_kpHandleSubEvent')}
    ${extractFn(BG, '_kpHandleGiftSubEvent')}
    return { _kpHandleSubEvent, _kpHandleGiftSubEvent, sent, stats: _kpEventStats }
  `)()
  api.sent.push = api.sent.push.bind(api.sent)
  return { ...api, sink: sent }
}

const frame = (data, channel = 'chatrooms.1279951.v2') => ({ channel, data: JSON.stringify(data) })

describe('_kpHandleSubEvent', () => {
  test('a first-month sub broadcasts eventType new', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ chatroom_id: 1279951, username: 'Glezzy1', months: 1 }))
    expect(bg.sent).toHaveLength(1)
    expect(bg.sent[0]).toMatchObject({
      type: 'kick_sub_event',
      channel: 'chessbrah',
      eventType: 'new',
      username: 'Glezzy1',
      message: 'Glezzy1 subscribed!',
    })
  })

  test('months > 1 is a renewal and says so', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ username: 'Glezzy1', months: 14 }))
    expect(bg.sent[0].eventType).toBe('renewal')
    expect(bg.sent[0].months).toBe(14)
    expect(bg.sent[0].message).toBe('Glezzy1 resubscribed for 14 months!')
  })

  test('a nested user object still resolves a username', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ user: { username: 'Nested' } }))
    expect(bg.sent[0].username).toBe('Nested')
  })

  test('no username → dropped and counted, never announced as "someone"', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ months: 3 }))
    expect(bg.sent).toHaveLength(0)
    expect(bg.stats.dropped).toBe(1)
  })

  test('an unknown chatroom is ignored (never leaks into another channel)', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ username: 'x' }, 'chatrooms.999.v2'))
    expect(bg.sent).toHaveLength(0)
  })

  test('the v1 chatroom channel resolves too', () => {
    const bg = makeBg()
    bg._kpHandleSubEvent(frame({ username: 'x' }, 'chatrooms.1279951'))
    expect(bg.sent).toHaveLength(1)
  })

  test('a malformed payload is swallowed, not thrown', () => {
    const bg = makeBg()
    expect(() => bg._kpHandleSubEvent({ channel: 'chatrooms.1279951.v2', data: '{oops' })).not.toThrow()
    expect(bg.sent).toHaveLength(0)
  })
})

describe('_kpHandleGiftSubEvent', () => {
  test('gifted_usernames drives both the count and the giftee list', () => {
    const bg = makeBg()
    bg._kpHandleGiftSubEvent(frame({ gifter_username: 'Big', gifted_usernames: ['a', 'b', 'c'] }))
    expect(bg.sent[0]).toMatchObject({
      type: 'kick_sub_event',
      eventType: 'gift',
      username: 'Big',
      gifter: 'Big',
      message: 'Big gifted 3 subs!',
    })
    expect(bg.sent[0].giftees).toEqual(['a', 'b', 'c'])
  })

  test('one gift is singular', () => {
    const bg = makeBg()
    bg._kpHandleGiftSubEvent(frame({ gifter_username: 'Big', gifted_usernames: ['solo'] }))
    expect(bg.sent[0].message).toBe('Big gifted 1 sub!')
  })

  test('giftees given as objects are flattened', () => {
    const bg = makeBg()
    bg._kpHandleGiftSubEvent(frame({ gifter: { username: 'Obj' }, giftees: [{ username: 'a' }, { username: 'b' }] }))
    expect(bg.sent[0].username).toBe('Obj')
    expect(bg.sent[0].giftees).toEqual(['a', 'b'])
  })

  test('an unknown gifter is anonymous, not a dropped event', () => {
    const bg = makeBg()
    bg._kpHandleGiftSubEvent(frame({ gifted_usernames: ['a'] }))
    expect(bg.sent[0].username).toBe('anonymous')
  })

  test('a gift we cannot size is dropped rather than announced as 0 subs', () => {
    const bg = makeBg()
    bg._kpHandleGiftSubEvent(frame({ gifter_username: 'Big', amount: 5 }))
    expect(bg.sent).toHaveLength(0)
    expect(bg.stats.dropped).toBe(1)
  })
})

describe('celebration dedup', () => {
  const { kickCelebrationFresh } = new Function(`
    ${IRC.slice(IRC.indexOf('const KICK_CELEBRATION_DEDUP_MS'), IRC.indexOf('const KICK_SUB_NOTICE_ID'))}
    return { kickCelebrationFresh }
  `)()

  test('the same celebration from both transports renders once', () => {
    const key = `s|chessbrah|gift|Big|0|3`
    expect(kickCelebrationFresh(key)).toBe(true)
    expect(kickCelebrationFresh(key)).toBe(false)
  })

  test('a different celebration in the same window still renders', () => {
    expect(kickCelebrationFresh('s|chessbrah|new|Alice|1|0')).toBe(true)
    expect(kickCelebrationFresh('s|chessbrah|new|Bob|1|0')).toBe(true)
  })
})

describe('notice id mapping', () => {
  const { KICK_SUB_NOTICE_ID } = new Function(
    `${IRC.slice(IRC.indexOf('const KICK_SUB_NOTICE_ID'), IRC.indexOf('}', IRC.indexOf('const KICK_SUB_NOTICE_ID')) + 1)}\nreturn { KICK_SUB_NOTICE_ID }`,
  )()

  // The bug this guards: main.js styles kick subs off the long webhook names,
  // the relay sends the short ones, so nothing matched and every kick sub
  // notice rendered with default styling.
  test('every mapped id is one main.js actually styles', () => {
    for (const id of Object.values(KICK_SUB_NOTICE_ID)) {
      expect(MAIN.includes(`'${id}'`)).toBe(true)
    }
  })

  test('covers all three relay event types', () => {
    expect(Object.keys(KICK_SUB_NOTICE_ID).sort()).toEqual(['gift', 'new', 'renewal'])
  })
})

describe('_kpHandlePinEvent', () => {
  function makePin() {
    return new Function(`
      const _kpEventStats = { subs: 0, gifts: 0, pins: 0, dropped: 0 }
      const sent = []
      function broadcastToTabs(m) { sent.push(m) }
      function _kpSlugForChatroom(id) { return id === 1279951 ? 'chessbrah' : null }
      ${extractFn(BG, '_kpEventParse')}
      ${extractFn(BG, '_kpEventSlug')}
      ${extractFn(BG, '_kpPinPlainText')}
      ${extractFn(BG, '_kpHandlePinEvent')}
      return { _kpHandlePinEvent, _kpPinPlainText, sent, stats: _kpEventStats }
    `)()
  }

  test('a pin carries sender and text', () => {
    const bg = makePin()
    bg._kpHandlePinEvent(frame({ message: { content: 'SPAM = BAN', sender: { username: 'Roi667' } } }), true)
    expect(bg.sent[0]).toMatchObject({ type: 'kick_pin_event', channel: 'chessbrah', pinned: true, sender: 'Roi667' })
    expect(bg.sent[0].text).toBe('SPAM = BAN')
  })

  // Live payload from kick: "SPAM = BAN [emote:37230:POLICE]". systemMsg is a
  // plain-text surface, so the raw token would have shipped as-is.
  test('kick emote tokens collapse to the emote name', () => {
    const bg = makePin()
    expect(bg._kpPinPlainText('SPAM = BAN [emote:37230:POLICE]')).toBe('SPAM = BAN POLICE')
  })

  test('an unpin needs no text', () => {
    const bg = makePin()
    bg._kpHandlePinEvent(frame({}), false)
    expect(bg.sent[0]).toMatchObject({ pinned: false, channel: 'chessbrah' })
  })

  test('an empty pin is dropped, not rendered as "pinned:"', () => {
    const bg = makePin()
    bg._kpHandlePinEvent(frame({ message: { content: '' } }), true)
    expect(bg.sent).toHaveLength(0)
    expect(bg.stats.dropped).toBe(1)
  })
})

// kick has no idempotency key on send, so an aborted POST that the server may
// already have processed must never be auto-retried — that is a double post in
// the user's chat, not a repair.
describe('kick send timeout is unconfirmed, never retried', () => {
  const SEND = readFileSync(join(ROOT, 'src', 'multichat', 'kick-send.js'), 'utf8')

  test('a timeout returns kick_unconfirmed after exactly one attempt', async () => {
    const counter = { n: 0 }
    const fatalLine = SEND.split('\n').find((l) => l.startsWith('const KICK_FATAL_SEND_ERRORS'))
    const backoffLine = SEND.split('\n').find((l) => l.startsWith('const KICK_SEND_RETRY_BACKOFF_MS'))
    const sendKickMessage = new Function(
      'counter',
      `${fatalLine}
       ${backoffLine}
       const resolveKickChannelId = async () => 1
       const _kickSendOnce = async () => { counter.n++; return { ok: false, error: 'timeout' } }
       const log = () => {}
       async ${extractFn(SEND, 'sendKickMessage')}
       return sendKickMessage`,
    )(counter)
    expect(await sendKickMessage('chessbrah', 'hi')).toBe('kick_unconfirmed')
    expect(counter.n).toBe(1)
  })

  test('the unconfirmed reason has honest copy wired in notifs', () => {
    const NOTIFS = readFileSync(join(ROOT, 'src', 'multichat', 'notifs.js'), 'utf8')
    expect(NOTIFS).toContain('kick_unconfirmed:')
    expect(NOTIFS).not.toMatch(/kick_unconfirmed: '[^']*failed/)
  })
})

// KICKs — kick's paid gift currency. Rides `channel_<channelId>`, NOT the
// chatroom channel, and the channel id is a different number from the chatroom
// id, so the tap never saw one and KICKs only rendered for the handful of
// channels the server webhook covers. Payload captured live 2026-07-21.
describe('_kpHandleKicksEvent', () => {
  function makeKicks() {
    return new Function(`
      const _kpEventStats = { subs: 0, gifts: 0, pins: 0, kicks: 0, dropped: 0 }
      const sent = []
      function broadcastToTabs(m) { sent.push(m) }
      function _kpSlugForChannelId(id) { return String(id) === '1286990' ? 'chessbrah' : null }
      ${extractFn(BG, '_kpEventParse')}
      ${extractFn(BG, '_kpHandleKicksEvent')}
      return { _kpHandleKicksEvent, sent, stats: _kpEventStats }
    `)()
  }
  const LIVE = {
    gift_transaction_id: '33fa75e2-d436-4da6-994b-843e9ab9f580',
    message: '',
    sender: { id: 86009526, username: 'EACreations', username_color: '#00F1FF' },
    gift: { gift_id: 'skull_emoji', name: 'Skull Emoji', amount: 50, type: 'BASIC', tier: 'BASIC' },
    created_at: '2026-07-21T21:31:24.055153734Z',
  }
  const chanFrame = (data, channel = 'channel_1286990') => ({ channel, data: JSON.stringify(data) })

  test('the real captured payload maps to the relay shape', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame(LIVE))
    expect(bg.sent[0]).toEqual({
      type: 'kick_kicks_event',
      channel: 'chessbrah',
      username: 'EACreations',
      amount: 50,
      giftName: 'Skull Emoji',
      message: '',
    })
  })

  test('an accompanying message rides along', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame({ ...LIVE, message: 'pog' }))
    expect(bg.sent[0].message).toBe('pog')
  })

  test('an unknown sender is anonymous, not dropped', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame({ ...LIVE, sender: null }))
    expect(bg.sent[0].username).toBe('anonymous')
  })

  test('a gift with no amount is dropped, never "gifted 0 KICKs"', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame({ ...LIVE, gift: { name: 'Mystery' } }))
    expect(bg.sent).toHaveLength(0)
    expect(bg.stats.dropped).toBe(1)
  })

  // The dot form is a different, real pusher channel carrying a duplicate of
  // the sub event — it must not be mistaken for the underscore one.
  test('the dot-form channel name is not accepted', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame(LIVE, 'channel.1286990'))
    expect(bg.sent).toHaveLength(0)
  })

  test('an unknown channel id is ignored', () => {
    const bg = makeKicks()
    bg._kpHandleKicksEvent(chanFrame(LIVE, 'channel_999'))
    expect(bg.sent).toHaveLength(0)
  })
})

describe('channel-scoped subscription plumbing', () => {
  test('join subscribes the channel-scoped pusher channel too', () => {
    expect(BG).toContain('_kpSubscribeChannelScoped(channelId)')
  })
  test('leave unsubscribes it', () => {
    expect(BG).toContain('_kpUnsubscribeChannelScoped(leftChannelId)')
  })
  // A reconnect that re-asserts only the chatroom subs would silently lose
  // KICKs for the rest of the session.
  test('reconnect re-asserts both subscription sets', () => {
    const reconnect = BG.slice(BG.indexOf('_kpConnected = true'), BG.indexOf('_kpConnected = true') + 700)
    expect(reconnect).toContain('_kpSubscribe(id)')
    expect(reconnect).toContain('_kpSubscribeChannelScoped(id)')
  })
  test('the channel id is captured from the resolve that already runs', () => {
    expect(BG).toContain('_kpChannelIdCache.set(slug, j.id)')
  })
})
