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

function extractFn(src, name) {
  const marker = `function ${name}(`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

// pool: name -> entry, standing in for lookupEmoteRenderOrder's resolution.
function make(pool) {
  return new Function(
    'pool',
    `const KICK_EMOTE_ID_RE = ${String(EMOTES.match(/const KICK_EMOTE_ID_RE = (.+)/)[1])}
     const KICK_MAX_MESSAGE = 500
     const lookupEmoteRenderOrder = (n) => pool[n] || null
     ${extractFn(EMOTES, 'kickifyEmoteText')}
     return kickifyEmoteText`,
  )(pool)
}

const KICK = { source: 'kick', url: 'https://files.kick.com/emotes/37226/fullsize' }
const SEVENTV = { source: '7tv', url: 'https://cdn.7tv.app/emote/abc/2x.webp' }

describe('kickifyEmoteText', () => {
  const f = make({ KEKW: KICK, catJAM: SEVENTV })

  test('a kick emote becomes its wire token', () => {
    expect(f('hello KEKW')).toBe('hello [emote:37226:KEKW]')
  })

  test('non-kick emotes are left as words — they have no kick id', () => {
    expect(f('hello catJAM')).toBe('hello catJAM')
  })

  test('plain text is untouched', () => {
    expect(f('just a sentence')).toBe('just a sentence')
  })

  test('an already-written token is not double-wrapped', () => {
    expect(f('[emote:37226:KEKW] KEKW')).toBe('[emote:37226:KEKW] [emote:37226:KEKW]')
  })

  test('punctuation-attached names stay words (they are not emote names)', () => {
    expect(f('KEKW, yes')).toBe('KEKW, yes')
  })

  test('spacing is preserved exactly', () => {
    expect(f('a  KEKW   b')).toBe('a  [emote:37226:KEKW]   b')
  })

  test('empty and non-string inputs pass through', () => {
    expect(f('')).toBe('')
    expect(f(null)).toBe(null)
  })

  // Tokens are much longer than names — expanding must never turn a sendable
  // message into one kick rejects for length.
  test('expansion that would breach kick 500-char limit falls back to words', () => {
    const long = 'KEKW '.repeat(90).trim()
    expect(long.length).toBeLessThanOrEqual(500)
    const out = f(long)
    expect(out).toBe(long)
  })

  test('a message already over the limit is still expanded (kick rejects either way)', () => {
    const huge = ('KEKW ' + 'y'.repeat(100) + ' ').repeat(6).trim()
    expect(huge.length).toBeGreaterThan(500)
    expect(f(huge)).toContain('[emote:37226:KEKW]')
  })
})

describe('wiring', () => {
  test('only the kick leg is rewritten', () => {
    expect(INPUT).toContain('sendKickMessage(slug, kickifyEmoteText(restText), kickReply)')
    // twitch keeps the bare body (wrapped in CTCP ACTION for /me)
    expect(INPUT).toContain('const twitchText = meMatch ? `\\x01ACTION ${restText}\\x01` : text')
  })
})

// Rewriting kick emotes on send means the echo comes back in a form that no
// longer equals what we tracked. An echo that fails to match renders a second
// copy AND never confirms the pending send (20s "did not confirm" notif), so
// the comparators have to collapse tokens before comparing.
describe('echo matching survives the rewrite', () => {
  const mk = () =>
    new Function(`
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
    const fatal = SEND.split('\n').find((l) => l.startsWith('const KICK_FATAL_SEND_ERRORS'))
    const backoff = SEND.split('\n').find((l) => l.startsWith('const KICK_SEND_RETRY_BACKOFF_MS'))
    const fn = new Function(
      'seen',
      'responses',
      `${fatal}
       ${backoff}
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
    // (see chrome/content.js kickSendErrorCode) — the retry decision never
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
      { ok: false, error: 'kick server error (500)', status: 500 },
      { ok: false, error: 'kick server error (500)', status: 500 },
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
