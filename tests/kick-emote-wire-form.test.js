// Kick-native emotes only exist on the wire as [emote:<id>:<name>]. Sending the
// bare name posts literal text to every kick client — and HeatSync's own
// renderer paints bare names, so the sender saw an emote and nobody else did.
// Proven live 2026-07-21: a pool emote sent from the composer archived as the
// plain word with no emote ref.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
const IRCSRC = readFileSync(join(ROOT, 'src', 'multichat', 'irc.js'), 'utf8')

function extractFn(src, name) {
  const marker = `function ${name}(`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

// the wire form itself is the law's (tests/emote-law-send.test.js, shared/emote-law.vectors.json);
// this file keeps what only the overlay can get wrong: which text reaches kick, and the echo
describe('wiring', () => {
  test('only the kick leg is rewritten, from the law', () => {
    expect(INPUT).toContain('sendKickMessage(slug, shipped.wire.kick ?? restText, kickReply)')
    // twitch keeps the bare body (wrapped in CTCP ACTION for /me)
    expect(INPUT).toContain('const twitchText = meMatch ? `\\x01ACTION ${restText}\\x01` : text')
  })
  test('the old resolvers are gone', () => {
    expect(EMOTES).not.toContain('function kickifyEmoteText')
    expect(EMOTES).not.toContain('function lookupEmoteWireOrder')
  })
})

// Rewriting kick emotes on send means the echo comes back in a form that no
// longer equals what we tracked. An echo that fails to match renders a second
// copy AND never confirms the pending send (20s "did not confirm" notif), so
// the comparators have to collapse tokens before comparing.
describe('echo matching survives the rewrite', () => {
  const mk = () =>
    new Function(`
      const DUP_BYPASS_CHAR = '\\u{E0000}'
      ${extractFn(IRCSRC, 'stripDupBypass')}
      ${extractFn(INPUT, '_unkickEmotes')}
      ${extractFn(INPUT, '_echoTextMatches')}
      return { _unkickEmotes, _echoTextMatches }
    `)()

  test('tracked bare words match the tokenised echo', () => {
    const { _echoTextMatches } = mk()
    expect(_echoTextMatches({ text: 'hello KEKW' }, 'hello [emote:37226:KEKW]')).toBe(true)
  })

  test('identical text still matches', () => {
    const { _echoTextMatches } = mk()
    expect(_echoTextMatches({ text: 'plain words' }, 'plain words')).toBe(true)
  })

  test('a different message still does not match', () => {
    const { _echoTextMatches } = mk()
    expect(_echoTextMatches({ text: 'hello KEKW' }, 'hello LULW')).toBe(false)
  })

  test('reply echoes keep their @prefix tolerance alongside tokens', () => {
    const { _echoTextMatches } = mk()
    expect(_echoTextMatches({ text: 'hi KEKW', reply: true }, '@someone hi [emote:37226:KEKW]')).toBe(true)
  })

  test('the quoted line of a reply shows a kick emote by its name, in the row and in its hover title', () => {
    const { _unkickEmotes } = mk()
    expect(_unkickEmotes('lol [emote:37226:KEKW] true [emote:1:OMEGALUL]')).toBe('lol KEKW true OMEGALUL')
    const MSGS = readFileSync(join(ROOT, 'src', 'multichat', 'main-messages.js'), 'utf8')
    expect(MSGS).toContain("const replyText = _unkickEmotes(m.replyTo?.text || '')")
    expect(MSGS).toContain('<span class="hs-mc-reply-snippet">: ${escapeHtml(replyText)}</span>')
    expect(MSGS).toContain('title="${escapeHtml(m.replyTo.user)}: ${escapeHtml(replyText)}"')
    expect(MSGS).not.toContain('escapeHtml(m.replyTo.text')
  })

  test('token-free strings are returned untouched', () => {
    const { _unkickEmotes } = mk()
    expect(_unkickEmotes('nothing here')).toBe('nothing here')
    expect(_unkickEmotes(null)).toBe('')
  })
})

// Kick VALIDATES emote tokens server-side and 400s the WHOLE message on a bad
// one — INVALID_EMOTE_ERROR, confirmed live 2026-07-21 (a made-up id 400s, the
// real id 3753119 for asmonSmash returns 200 with the token intact). So the
// outgoing rewrite can turn a message that used to send as plain words into one
// that doesn't send at all — strictly worse. It must degrade, not fail.
describe('INVALID_EMOTE degrades to plain words', () => {
  const SEND = readFileSync(join(ROOT, 'src', 'multichat', 'kick-send.js'), 'utf8')

  function makeSender(responses) {
    const seen = []
    // a multi-line statement: from its const to the closing `])`
    const fatalAt = SEND.indexOf('const KICK_FATAL_SEND_ERRORS')
    const fatal = SEND.slice(fatalAt, SEND.indexOf('])', fatalAt) + 2)
    const backoff = SEND.split('\n').find((l) => l.startsWith('const KICK_SEND_RETRY_BACKOFF_MS'))
    const neverLanded = SEND.split('\n').find((l) => l.startsWith('const KICK_NEVER_LANDED'))
    const fn = new Function(
      'seen',
      'responses',
      `${fatal}
       ${backoff}
       ${neverLanded}
       const _unkickEmotes = (s) => String(s).replace(/\\[emote:\\d+:([^\\]]+)\\]/g, '$1')
       const resolveKickChannelId = async () => 84407
       const _kickSendOnce = async (id, body, reply) => { seen.push({ body, reply }); return responses.shift() }
       const log = () => {}
       async ${extractFn(SEND, 'sendKickMessage')}
       return sendKickMessage`,
    )(seen, responses)
    return { fn, seen }
  }

  test('a rejected emote is stripped and the message still delivers', async () => {
    // code is the machine-readable field the relay sets from kick's raw body
    // (see src/content/content.js kickSendErrorCode) — the retry decision never
    // parses the human-readable `error` text.
    const { fn, seen } = makeSender([
      { ok: false, error: 'kick rejected the message (400)', status: 400, code: 'invalid_emote' },
      { ok: true },
    ])
    expect(await fn('mellen', 'hi [emote:999:Ghost] there')).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[0].body).toBe('hi [emote:999:Ghost] there')
    // the resend carries the bare name — message delivered, just no image
    expect(seen[1].body).toBe('hi Ghost there')
  })

  test('the de-tokenized resend does not consume a retry slot', async () => {
    const { fn, seen } = makeSender([
      { ok: false, error: 'kick rejected the message (400)', status: 400, code: 'invalid_emote' },
      { ok: false, error: 'kick rate limited — wait a moment', status: 429 },
      { ok: false, error: 'kick rate limited — wait a moment', status: 429 },
      { ok: true },
    ])
    expect(await fn('mellen', 'x [emote:1:A]')).toBe(true)
    expect(seen).toHaveLength(4)
  })

  test('a message with no tokens is not looped on INVALID_EMOTE', async () => {
    // nothing to strip — must fall through to normal retry, never spin
    const { fn, seen } = makeSender([
      { ok: false, error: 'kick rejected the message (400)', status: 400, code: 'invalid_emote' },
      { ok: true },
    ])
    expect(await fn('mellen', 'plain words')).toBe(true)
    expect(seen[1].body).toBe('plain words')
  })

  test('other 4xx errors are untouched by the emote path', async () => {
    const { fn } = makeSender([{ ok: false, error: 'kick_not_logged_in' }])
    expect(await fn('mellen', 'hi [emote:1:A]')).toBe('kick_not_logged_in')
  })
})
