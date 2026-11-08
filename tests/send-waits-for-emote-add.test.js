/**
 * A line that carries a just-picked emote goes out after the add/swap lands.
 *
 * The server stamps each chat line with the sender's emotes as they stand when
 * it fans the line out (emote-enrich enrichThirdPartyRefsSync), and that stamp
 * outranks everything for every viewer, for good. sendMessage fired the
 * platform legs straight after starting the auto-add, so the first line with a
 * freshly swapped IDK was stamped with the sender's OLD IDK for everyone.
 *
 * Now the legs wait for the add, bounded (a slow or failed add still sends the
 * text), the composer clears at once as before, and a line sent during the
 * wait queues behind it instead of overtaking it.
 *
 * Harness: sendMessage carved out of input.js and run against stubbed bundle
 * globals (twitch-only channel tab), capturing what reaches the IRC leg.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const from = INPUT.indexOf('async function sendQuoteThread(')
const to = INPUT.indexOf('// The exact live video id', from)
if (from === -1 || to === -1) throw new Error('carve markers not found in input.js')
const SRC = INPUT.slice(from, to)

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// autoAdd: what autoAddInputEmotes returns for each send, in order
function rig(autoAdds) {
  const sent = []
  const timers = []
  const input = { value: '', style: {}, focus() {} }
  const scope = {
    input,
    document: { getElementById: (id) => (id === 'hs-mc-input' ? input : null) },
    window: {},
    quoteState: null,
    getInputText: () => input.value,
    convertEmojiShortcodes: (s) => s,
    autoAddInputEmotes: () => autoAdds.shift() ?? null,
    currentTab: 'chan1',
    tabAcceptsInput: () => true,
    config: { channels: [{ id: 'chan1', twitch: 'chan1' }] },
    getLiveChannel: () => null,
    hostPlatform: 'twitch',
    resolveSendTargets: (_st, linked) => linked,
    chatLockFor: () => null,
    chatLockHoldsSend: () => false,
    chatLockLabel: () => '',
    currentYoutubeVideoId: () => '',
    warnUnlinkedOwnEmotes: () => {},
    flashInputError: () => {},
    showToast: () => {},
    t: (k) => k,
    registerPendingSend: () => 'synth',
    trackSentMessage: () => {},
    hsSentHistoryRecord: () => {},
    replyState: null,
    clearReplyState: () => {},
    ytReplyText: (s) => s,
    rememberOwnReply: () => {},
    wysiwygEnabled: false,
    pendingMessage: '',
    updateCharCount: () => {},
    settleComposerAfterSend: () => {},
    getTwitchAuthTokenAsync: async () => ({ token: 'tok', username: 'me' }),
    authState: { ws: { readyState: 1 }, ready: true, sendQueue: [] },
    log: () => {},
    sendIrcMessage: (_ch, text) => {
      sent.push(text)
      return Promise.resolve(true)
    },
    markPendingFailed: () => {},
    updateInputPlaceholder: () => {},
    HsNotifs: { emit: () => {} },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  }
  const { sendMessage } = new Function('scope', `with (scope) { ${SRC}\nreturn { sendMessage } }`)(scope)
  const send = (text) => {
    input.value = text
    return sendMessage()
  }
  const fireTimers = () => {
    for (const t of timers.splice(0)) t.fn()
  }
  // Enter again, whatever the composer holds now
  const press = () => sendMessage()
  return { send, press, sent, input, timers, fireTimers }
}

describe('a line carrying a pending add waits for it', () => {
  test('the platform leg goes out only after the swap lands; the composer clears at once', async () => {
    const add = deferred()
    const r = rig([add.promise])
    const done = r.send('IDK hello')
    await flush()
    expect(r.input.value).toBe('')
    expect(r.sent).toEqual([])
    add.resolve(['IDK'])
    await done
    expect(r.sent).toEqual(['IDK hello'])
  })

  test('a slow add does not hold the line past the bound', async () => {
    const r = rig([new Promise(() => {})])
    const done = r.send('IDK hello')
    await flush()
    expect(r.sent).toEqual([])
    const bound = r.timers.find((t) => t.ms > 0 && t.ms <= 1500)
    expect(bound).toBeTruthy()
    r.fireTimers()
    await done
    expect(r.sent).toEqual(['IDK hello'])
  })

  test('a failed add still sends the text', async () => {
    const failed = deferred()
    const r = rig([Promise.resolve([]), failed.promise])
    await r.send('IDK one')
    const two = r.send('IDK two')
    await flush()
    expect(r.sent).toEqual(['IDK one'])
    failed.reject(new Error('offline'))
    await two
    expect(r.sent).toEqual(['IDK one', 'IDK two'])
  })

  test('nothing pending: no wait, no timer', async () => {
    const r = rig([])
    await r.send('hello')
    expect(r.sent).toEqual(['hello'])
    expect(r.timers.length).toBe(0)
  })
})

describe('sending again during the wait', () => {
  test('Enter on the cleared composer sends nothing more', async () => {
    const add = deferred()
    const r = rig([add.promise])
    const done = r.send('IDK hello')
    await flush()
    await r.press()
    add.resolve(['IDK'])
    await done
    await flush()
    expect(r.sent).toEqual(['IDK hello'])
  })

  test('the next line queues behind the waiting one instead of overtaking it', async () => {
    const add = deferred()
    const r = rig([add.promise])
    const first = r.send('IDK hello')
    await flush()
    // same emote again, its add still in flight: autoAdd skips it (null)
    const second = r.send('IDK again')
    await flush()
    expect(r.sent).toEqual([])
    add.resolve(['IDK'])
    await Promise.all([first, second])
    expect(r.sent).toEqual(['IDK hello', 'IDK again'])
  })
})
