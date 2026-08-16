import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reply bar on your OWN echoed message, on every platform.
 *
 * Replying and then watching your own message come back bare was the report.
 * Cause: rememberOwnReply was gated on the twitch leg (`replyParentId &&
 * sendToTwitch`) and only the twitch message handler ever read it back. Kick's
 * echo of our own send carries no reply payload and youtube has no reply
 * threading at all, so on those legs there was nothing to render a bar from —
 * the send-time memory IS the only source, and it was never written.
 *
 * The key is also restText now, not twitchText: `/me` wraps twitchText in CTCP
 * ACTION, which no echo carries back (irc.js unwraps it before the handler
 * sees it), so a `/me` reply missed its own bar even on twitch.
 *
 * Carved out of the content-script bundle the same way sent-echo.test.js does.
 */
function carve(src, name) {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`${name} not found in input.js`)
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return src.slice(start, end)
}

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

function load() {
  const body = [
    carve(SRC, '_unkickEmotes'),
    carve(SRC, '_echoTextMatches'),
    carve(SRC, 'rememberOwnReply'),
    carve(SRC, 'peekOwnReply'),
    carve(SRC, 'restoreOwnReplyBar'),
  ].join('\n')
  return new Function(
    'SENT_DEDUP_WINDOW',
    `let _recentOwnReplies = []; ${body}; return { rememberOwnReply, peekOwnReply, restoreOwnReplyBar }`,
  )(10000)
}

const PARENT = { user: 'dongblob', text: 'na, he streaming early', id: 'abc-123', userId: '42' }

describe('own-reply bar', () => {
  test('twitch echo — the platform prepends "@login ", the bar survives it', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('he is offline', PARENT)
    const msg = { text: '@dongblob he is offline' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toEqual(PARENT)
  })

  test('kick echo — the emote wire form still matches', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('lol KEKW', PARENT)
    // kickifyEmoteText rewrites the send; the echo carries the wire form back.
    const msg = { text: 'lol [emote:37226:KEKW]' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toEqual(PARENT)
  })

  test('youtube echo — the @mention prepend is all that ships, and it is enough', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('he is offline', PARENT)
    // ytReplyText prepends the author; youtube has no reply field at all.
    const msg = { text: '@dongblob he is offline' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo?.user).toBe('dongblob')
  })

  test('a /me reply is remembered as the unwrapped text, so its echo matches', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    // The send path keys on restText. irc.js strips \x01ACTION …\x01 before the
    // handler runs, so the echo is the bare text — keying on the CTCP-wrapped
    // twitchText could never match it.
    rememberOwnReply('waves', PARENT)
    const msg = { text: 'waves' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toEqual(PARENT)
  })

  test('never overwrites a reply the transport actually carried', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('he is offline', PARENT)
    const real = { user: 'someoneelse', text: 'x', id: 'zzz', userId: '9' }
    const msg = { text: 'he is offline', replyTo: real }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toBe(real)
  })

  test('a different message gets no bar', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('he is offline', PARENT)
    const msg = { text: 'completely unrelated' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toBeUndefined()
  })

  test('a reply with no resolvable author is not remembered — an empty bar is worse than none', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('he is offline', { user: '', text: '', id: 'abc', userId: '' })
    const msg = { text: 'he is offline' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toBeUndefined()
  })

  test('the newest send wins when the same text was replied to twice', () => {
    const { rememberOwnReply, restoreOwnReplyBar } = load()
    rememberOwnReply('same text', PARENT)
    const second = { user: 'otherperson', text: 'y', id: 'def-456', userId: '7' }
    rememberOwnReply('same text', second)
    const msg = { text: 'same text' }
    restoreOwnReplyBar(msg)
    expect(msg.replyTo).toEqual(second)
  })
})

describe('the send path', () => {
  test('remembers on every leg, not just twitch', () => {
    const block = SRC.slice(SRC.indexOf('// Stash the parent context for the own-echo reply bar'))
    const guard = block.slice(0, block.indexOf('rememberOwnReply('))
    expect(guard).toContain('if (replyParentId) {')
    expect(guard).not.toContain('sendToTwitch')
  })

  test('keys the memory on restText, not the CTCP-wrapped twitchText', () => {
    expect(SRC).toContain('rememberOwnReply(restText, {')
  })
})

describe('every handler restores it', () => {
  const handler = (file) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', file), 'utf8')

  test('twitch and kick both call the shared helper', () => {
    const main = handler('main.js')
    expect(main.match(/restoreOwnReplyBar\(msg\)/g)?.length).toBe(2)
  })

  test('youtube calls it too', () => {
    expect(handler('social.js')).toContain('restoreOwnReplyBar(ytMsg)')
  })
})
