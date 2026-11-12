/**
 * One submit is one message per chosen platform, once.
 *
 * Counted at the wire: what reaches the twitch socket, the kick relay and the
 * youtube bridge. The real sendMessage + pending tracker (input.js), kick's
 * sendKickMessage (kick-send.js), the twitch reconnect queue (auth-irc.js) and
 * the composer's keydown are carved out and run against stubbed bundle globals.
 *
 * What a second copy used to come from, and is pinned here:
 *  - retry sent every leg again, though the notice names the one that did not
 *    confirm: the leg that landed went out twice
 *  - a send written off as failed that landed afterwards (a queued line drains
 *    on reconnect) kept its retry button
 *  - kick's own retry re-posted after a 5xx / a dead worker, when the first
 *    post may well be in chat (no idempotency key)
 *  - two drains of the reconnect queue each sent its head and each shifted one
 *  - Enter that commits an IME candidate sent the half-typed text
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const INPUT = read('input.js')
const IRC = read('irc.js')
const KICK = read('kick-send.js')
const AUTH = read('auth-irc.js')

function between(src, a, b) {
  const s = src.indexOf(a)
  if (s === -1) throw new Error(`carve start not found: ${a}`)
  const e = src.indexOf(b, s + a.length)
  if (e === -1) throw new Error(`carve end not found: ${b}`)
  return src.slice(s, e)
}
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

const WORDS = `const DUP_BYPASS_CHAR = '\\u{E0000}'
${fn(IRC, 'stripDupBypass')}
${fn(INPUT, '_unkickEmotes')}
${fn(INPUT, '_echoTextMatches')}
${fn(INPUT, '_notOurLine')}`
const TRACKER = between(INPUT, 'const pendingSends = new Map()', '// Autocomplete state (Tab-only cycling')
const SEND = between(INPUT, 'async function sendQuoteThread(', '// The exact live video id')

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/**
 * A channel tab linked to twitch + kick + youtube. results: what each platform
 * answers (true = delivered). Returns the wire counts and the handles the tests
 * drive: submit, Enter, the pending tracker, the notices.
 */
function rig({
  results = {},
  channel = { id: 'chan1', twitch: 'chan1', kick: 'chan1k', youtube: 'https://youtube.com/@chan1' },
  self = [],
} = {}) {
  const wire = { twitch: [], kick: [], youtube: [] }
  const tracked = [] // sendId of every trackSentMessage
  const tagged = [] // [text, sendId] of every origin tag
  const notices = []
  const dismissed = []
  const timers = []
  const input = { value: '', style: {}, focus() {} }
  const scope = {
    input,
    document: { getElementById: (id) => (id === 'hs-mc-input' ? input : null) },
    window: {},
    quoteState: null,
    getInputText: () => input.value,
    convertEmojiShortcodes: (s) => s,
    autoAddInputEmotes: () => null,
    currentTab: channel.id,
    tabAcceptsInput: () => true,
    config: { channels: [channel] },
    getLiveChannel: () => null,
    hostPlatform: 'twitch',
    resolveSendTargets: (_st, linked) => linked,
    chatLockFor: () => null,
    chatLockHoldsSend: () => false,
    chatLockLabel: () => '',
    currentYoutubeVideoId: () => 'vid12345678',
    warnUnlinkedOwnEmotes: () => {},
    flashInputError: () => {},
    showToast: () => {},
    t: (k) => k,
    trackSentMessage: (_t, _h, _s, _e, _r, sendId) => tracked.push(sendId),
    hsNewSendId: (() => {
      let n = 0
      return () => `send-${++n}`
    })(),
    hsTagTwitchSend: (text, _ch, sendId) => tagged.push([text, sendId]),
    hsSentHistoryRecord: () => {},
    replyState: null,
    clearReplyState: () => {},
    ytReplyText: (s) => s,
    rememberOwnReply: () => {},
    kickifyEmoteText: (s) => s,
    wysiwygEnabled: false,
    pendingMessage: '',
    updateCharCount: () => {},
    settleComposerAfterSend: () => {},
    getTwitchAuthTokenAsync: async () => ({ token: 'tok', username: 'me' }),
    authState: { ws: { readyState: 1 }, ready: true, sendQueue: [] },
    log: () => {},
    sendIrcMessage: (_ch, text) => {
      wire.twitch.push(text)
      return Promise.resolve(results.twitch ?? true)
    },
    sendKickMessage: (_slug, text) => {
      wire.kick.push(text)
      return Promise.resolve(results.kick ?? true)
    },
    sendYoutubeMessage: (text) => {
      wire.youtube.push(text)
      return Promise.resolve(results.youtube ?? true)
    },
    updateInputPlaceholder: () => {},
    keepLiveTab: () => Promise.resolve(),
    showYtSendingRow: () => {},
    clearYtSendingRow: () => {},
    irc: null,
    kickChat: null,
    selfNamesFor: (p) => (self[p] ? self[p] : []),
    recycleAuthIrc: () => {},
    restoreWysiwygText: () => {},
    MC_DEBUG: false,
    HsNotifs: {
      emit: (type, data) => notices.push([type, data]),
      dismissByKey: (_t, key) => dismissed.push(key),
    },
    cleanup: {
      setPageTimeout: (cb, ms) => timers.push({ cb, ms }),
      clearTimeout: () => {},
    },
    setTimeout: () => 0,
  }
  const api = new Function(
    'scope',
    `with (scope) { ${WORDS}\n${TRACKER}\n${SEND}\nreturn { sendMessage, retryPendingSend, confirmPending, findPendingByEchoText, markPendingFailed, pendingSends } }`,
  )(scope)
  const submit = (text) => {
    input.value = text
    return api.sendMessage()
  }
  return { ...api, scope, wire, tracked, tagged, notices, dismissed, timers, input, submit }
}

const total = (w) => `${w.twitch.length}/${w.kick.length}/${w.youtube.length}`

describe('one submit, one message per platform', () => {
  test('a triple send reaches each platform once, Enter held down and the button too', async () => {
    const r = rig()
    const first = r.submit('gm chat')
    // key repeat and a click on send, before anything has come back: the composer is already clear
    const repeat = r.sendMessage()
    const click = r.sendMessage({ type: 'click' })
    await Promise.all([first, repeat, click])
    await flush()
    expect(total(r.wire)).toBe('1/1/1')
    expect(r.wire.twitch).toEqual(['gm chat'])
  })

  test('every leg of one submit shares one send id, and twitch is tagged once under it', async () => {
    const r = rig()
    await r.submit('hello')
    await flush()
    expect(r.tracked).toEqual(['send-1'])
    expect(r.tagged).toEqual([['hello', 'send-1']])
  })
})

describe('retry sends only what did not confirm', () => {
  test('kick echoed, twitch never did: retry goes to twitch alone, under the same send', async () => {
    const r = rig({ channel: { id: 'chan1', twitch: 'chan1', kick: 'chan1k' } })
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    r.confirmPending(id, 'kick') // kick echoed back
    r.timers[0].cb() // 20s later twitch still has not
    expect(r.notices.map((n) => n[0])).toEqual(['send-pending'])
    expect(r.notices[0][1].platforms).toEqual(['twitch'])
    r.retryPendingSend(id)
    await flush()
    expect(total(r.wire)).toBe('2/1/0')
    expect(r.tracked).toEqual(['send-1', 'send-1']) // the retried leg folds into the row of the one that landed
  })

  test('nothing confirmed (both written off): retry sends both again', async () => {
    const r = rig({
      channel: { id: 'chan1', twitch: 'chan1', kick: 'chan1k' },
      results: { kick: 'send_failed', twitch: 'send_error' },
    })
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    expect(r.pendingSends.get(id).state).toBe('failed')
    r.retryPendingSend(id)
    await flush()
    expect(total(r.wire)).toBe('2/2/0')
  })

  test('youtube that did not confirm on a youtube-only send retries youtube alone', async () => {
    const r = rig({
      channel: { id: 'chan1', youtube: 'https://youtube.com/@chan1' },
      results: { youtube: 'send_failed' },
    })
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    r.retryPendingSend(id)
    await flush()
    expect(total(r.wire)).toBe('0/0/2')
  })

  test('a leg that is no longer linked leaves nothing to send, and never falls back to twitch', async () => {
    const channel = { id: 'chan1', twitch: 'chan1', kick: 'chan1k' }
    const r = rig({ channel })
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    r.confirmPending(id, 'twitch')
    r.timers[0].cb() // kick never confirmed
    delete channel.kick // and the kick link is gone before the retry
    r.retryPendingSend(id)
    await flush()
    expect(total(r.wire)).toBe('1/1/0')
  })

  test('the send button is a plain send: its click event is not a retry', async () => {
    const r = rig({ channel: { id: 'chan1', twitch: 'chan1', kick: 'chan1k' } })
    r.input.value = 'gm'
    await r.sendMessage({ type: 'click', only: 'kick' })
    await flush()
    expect(total(r.wire)).toBe('1/1/0')
  })
})

describe('a twitch line queued for the reconnect', () => {
  test('a retry replaces the queued copy, so the socket coming back posts it once', async () => {
    const r = rig({ channel: { id: 'chan1', twitch: 'chan1' } })
    const q = r.scope.authState.sendQueue
    // what sendIrcMessage does with the socket down: queue it, answer 'queued'
    r.scope.sendIrcMessage = (ch, text) => {
      r.wire.twitch.push(text)
      q.push({ channel: ch, text })
      return Promise.resolve('queued')
    }
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    expect(q).toHaveLength(1)
    r.retryPendingSend(id)
    await flush()
    expect(r.wire.twitch).toEqual(['gm', 'gm']) // handed to the socket twice...
    expect(q).toHaveLength(1) // ...but one copy is waiting to post
  })
})

describe('a send written off that lands anyway', () => {
  const failTwitch = async () => {
    const r = rig({
      channel: { id: 'chan1', twitch: 'chan1' },
      results: { twitch: 'queued' },
      self: { twitch: ['me'] },
    })
    await r.submit('gm')
    await flush()
    const [id] = [...r.pendingSends.keys()]
    return { r, id }
  }

  test('its echo retires the retry notice: the button would send it a second time', async () => {
    const { r, id } = await failTwitch()
    expect(r.pendingSends.get(id).state).toBe('failed')
    const found = r.findPendingByEchoText('gm', { user: 'me', text: 'gm' }, 'twitch')
    expect(found).toBe(id)
    r.confirmPending(found, 'twitch')
    expect(r.pendingSends.has(id)).toBe(false)
    expect(r.dismissed).toContain(`send-pending:${id}`)
  })

  test("somebody else's identical words retire nothing", async () => {
    const { r, id } = await failTwitch()
    expect(r.findPendingByEchoText('gm', { user: 'rando', text: 'gm' }, 'twitch')).toBe(null)
    expect(r.pendingSends.get(id).state).toBe('failed')
  })

  test('a send still waiting for its echo is matched before a written-off one of the same words', async () => {
    const r = rig({ channel: { id: 'chan1', twitch: 'chan1' }, self: { twitch: ['me'] } })
    r.scope.sendIrcMessage = () => Promise.resolve('queued')
    await r.submit('gm')
    await flush()
    const [old] = [...r.pendingSends.keys()]
    r.scope.sendIrcMessage = () => Promise.resolve(true)
    await r.submit('gm')
    await flush()
    const fresh = [...r.pendingSends.keys()].find((k) => k !== old)
    expect(r.pendingSends.get(old).state).toBe('failed')
    expect(r.findPendingByEchoText('gm', { user: 'me', text: 'gm' }, 'twitch')).toBe(fresh)
  })
})

describe("kick's own retry never posts a second copy of a line that may be in chat", () => {
  const KICK_SRC = [
    between(KICK, 'const KICK_FATAL_SEND_ERRORS', '// Exceeds the relay POST'),
    between(KICK, 'const KICK_SEND_TIMEOUT_MS', 'async function resolveKickChannelId'),
    between(KICK, 'function _kickSendOnce', '// ─── Kick chat modes'),
  ].join('\n')
  const kick = (answers) => {
    const posts = []
    const scope = {
      safeSendMessage: (m) => {
        posts.push(m.content)
        const a = answers[Math.min(posts.length - 1, answers.length - 1)]
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
      },
      kickChannelIdCache: new Map([['chan', 99]]),
      resolveKickChannelId: async () => 99,
      log: () => {},
      _unkickEmotes: (s) => s,
      // the backoff is the point of nothing here: run it at once
      setTimeout: (cb, ms) => (ms < 5000 ? setImmediate(cb) : 0),
      clearTimeout: () => {},
    }
    const { sendKickMessage } = new Function('scope', `with (scope) { ${KICK_SRC}\nreturn { sendKickMessage } }`)(scope)
    return { send: () => sendKickMessage('chan', 'gm'), posts }
  }

  test('a 502 may have posted: one post, answered as unconfirmed', async () => {
    const k = kick([{ ok: false, error: 'kick server error (502)', status: 502 }])
    expect(await k.send()).toBe('kick_unconfirmed')
    expect(k.posts).toHaveLength(1)
  })

  test('a worker that answered nothing may have posted too', async () => {
    const k = kick([null])
    expect(await k.send()).toBe('kick_unconfirmed')
    expect(k.posts).toHaveLength(1)
    const port = kick([new Error('The message port closed before a response was received.')])
    expect(await port.send()).toBe('kick_unconfirmed')
    expect(port.posts).toHaveLength(1)
  })

  test('a refusal never posted, so asking again cannot double it', async () => {
    const k = kick([{ ok: false, error: 'you are banned from this channel', status: 403 }])
    expect(await k.send()).toBe('you are banned from this channel')
    expect(k.posts).toHaveLength(3)
  })

  test('a post that never reached kick is tried again, and lands once', async () => {
    const k = kick([{ ok: false, error: 'Failed to fetch' }, { ok: true }])
    expect(await k.send()).toBe(true)
    expect(k.posts).toHaveLength(2)
  })

  test('rate-limited is a refusal that did not post: tried again, three posts at most', async () => {
    const k = kick([{ ok: false, error: 'kick rate limited — wait a moment', status: 429 }])
    expect(await k.send()).toBe('kick rate limited — wait a moment')
    expect(k.posts).toHaveLength(3)
  })

  test('a timeout still stops at one', async () => {
    const k = kick([{ ok: false, error: 'timeout' }])
    expect(await k.send()).toBe('kick_unconfirmed')
    expect(k.posts).toHaveLength(1)
  })
})

describe('the twitch reconnect queue', () => {
  const DRAIN = between(AUTH, '// One drain at a time.', 'async function sendIrcMessage')
  test('two drains at once send each queued line once, in order', async () => {
    const frames = []
    const authState = {
      ws: { readyState: 1, send: (f) => frames.push(f) },
      ready: true,
      joined: new Set(),
      sendQueue: [
        { channel: 'chan', text: 'one' },
        { channel: 'chan', text: 'two' },
        { channel: 'chan', text: 'three' },
      ],
    }
    const scope = {
      authState,
      WebSocket: { OPEN: 1 },
      authIrcAlive: () => true,
      // the join takes a moment: both drains peek the head before either has shifted it
      joinChannel: async (c) => {
        await new Promise((r) => setImmediate(r))
        authState.joined.add(c)
        return true
      },
      twitchWireText: (_c, t) => t,
      lastWireByChannel: new Map(),
      log: () => {},
    }
    const { drainSendQueue } = new Function('scope', `with (scope) { ${DRAIN}\nreturn { drainSendQueue } }`)(scope)
    await Promise.all([drainSendQueue(), drainSendQueue()])
    expect(frames).toEqual(['PRIVMSG #chan :one\r\n', 'PRIVMSG #chan :two\r\n', 'PRIVMSG #chan :three\r\n'])
    expect(authState.sendQueue).toEqual([])
  })
})

describe('Enter', () => {
  const KEYDOWN = fn(INPUT, 'handleInputKeydown')
  const press = (ev) => {
    let sends = 0
    const scope = {
      handleInputKeydownInner: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) sends++
      },
      sendMessage: () => sends++,
      log: () => {},
    }
    const { handleInputKeydown } = new Function('scope', `with (scope) { ${KEYDOWN}\nreturn { handleInputKeydown } }`)(
      scope,
    )
    handleInputKeydown({ target: {}, stopPropagation() {}, preventDefault() {}, shiftKey: false, ...ev })
    return sends
  }
  test('Enter sends', () => expect(press({ key: 'Enter' })).toBe(1))
  test('Enter that commits an IME candidate is not a send', () => {
    expect(press({ key: 'Enter', isComposing: true })).toBe(0)
    expect(press({ key: 'Enter', keyCode: 229 })).toBe(0)
  })
})
