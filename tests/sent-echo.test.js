import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Echo-dedup tests — isSentEcho (src/multichat/input.js).
 *
 * Regression anchor: sending the same text twice within 10s dropped the 2nd
 * own message. The old newest-first scan locked both echoes onto ONE entry,
 * so the 2nd send's only echo counted as the 1st send's dual-send duplicate
 * and was suppressed. Fix: FIFO — the oldest send whose expected echo count
 * (one per target platform) isn't exhausted claims the echo.
 *
 * isSentEcho lives in the non-module content-script bundle, so it's carved
 * out of the source and evaluated standalone (same rationale as
 * mod-dedup.test.js / tab-complete-order.test.js).
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

function loadIsSentEcho() {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  // isSentEcho calls _echoTextMatches (reply-prefix tolerance), which in turn
  // calls _unkickEmotes (kick's [emote:id:name] wire form) — carve all three.
  const irc = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')
  const body = `const DUP_BYPASS_CHAR = '\\u{E0000}'\n${carve(irc, 'stripDupBypass')}\n${carve(src, '_unkickEmotes')}\n${carve(src, '_echoTextMatches')}\n${carve(src, '_echoPlatformKey')}\n${carve(src, 'isSentEcho')}`
  // Bind the module-scoped state the function closes over.
  return (entries) =>
    new Function('_recentSentMessages', 'SENT_DEDUP_WINDOW', `${body}; return isSentEcho`)(entries, 10000)
}

const makeIsSentEcho = loadIsSentEcho()
const now = () => Date.now()

test('single send: first echo renders', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a', echoes: 1 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false)
})

test('dual-send: first echo renders, duplicate suppressed, third-party copy renders', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a', echoes: 2 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false) // twitch echo
  expect(isSentEcho('hello', 'kick')).toBe(true) // kick duplicate
  expect(isSentEcho('hello', 'twitch')).toBe(false) // another user, same text
})

test('REGRESSION: same text sent twice within 10s — BOTH echoes render', () => {
  const t = now()
  const entries = [
    { text: 'hello', time: t - 200, synthId: 'a', echoes: 1 },
    { text: 'hello', time: t - 100, synthId: 'b', echoes: 1 },
  ]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false) // send #1's echo
  expect(isSentEcho('hello', 'twitch')).toBe(false) // send #2's echo — was dropped pre-fix
  expect(isSentEcho('hello', 'twitch')).toBe(false) // third-party copy still renders
})

test('dual-send twice: exactly two copies render out of four echoes', () => {
  const t = now()
  const entries = [
    { text: 'gg', time: t - 200, synthId: 'a', echoes: 2 },
    { text: 'gg', time: t - 100, synthId: 'b', echoes: 2 },
  ]
  const isSentEcho = makeIsSentEcho(entries)
  const results = ['twitch', 'kick', 'twitch', 'kick'].map((p) => isSentEcho('gg', p))
  expect(results.filter((suppressed) => !suppressed).length).toBe(2)
})

test('REGRESSION: reply dual-send — twitch echo carries "@login " prefix, still dedups', () => {
  // Typed "theres no way lol" as a reply, dual-send twitch+yt. Twitch echoes
  // "@coaoaba theres no way lol" (server-side prefix); yt echoes the raw text.
  // Pre-fix the prefixed echo missed the entry → BOTH rows rendered.
  const entries = [{ text: 'theres no way lol', time: now(), synthId: 'a', echoes: 2, reply: true }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('@coaoaba theres no way lol', 'twitch')).toBe(false) // first echo renders
  expect(isSentEcho('theres no way lol', 'youtube')).toBe(true) // yt duplicate suppressed
})

test('REGRESSION: yt reply leg carries a synthetic "@author " mention, still dedups', () => {
  // Reply sent to twitch+yt: twitch echoes raw text (no server prefix on a
  // plain PRIVMSG reply-tag path in this fixture), yt echoes back OUR OWN
  // synthetic "@author " prepend (ytReplyText, send-targets.js) since YT has
  // no native reply threading. The tracked entry.text is restText (no
  // prefix) — the existing reply-aware strip (built for Twitch's server-side
  // prefix) must also swallow our own synthetic one, or the yt echo renders
  // as a second, unsuppressed copy of the message.
  const entries = [{ text: 'gg well played', time: now(), synthId: 'a', echoes: 2, reply: true }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('gg well played', 'twitch')).toBe(false) // first echo renders
  expect(isSentEcho('@coaoaba gg well played', 'youtube')).toBe(true) // yt duplicate suppressed
})

test('non-reply entry never strips a stranger\'s "@you " prefix', () => {
  const entries = [{ text: 'same text', time: now(), synthId: 'a', echoes: 1 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('@mellen same text', 'twitch')).toBe(false) // stranger's reply renders
  expect(entries[0].seenPlatforms).toBeUndefined() // and never touched the entry
})

test('entries outside the 10s window are ignored', () => {
  const entries = [{ text: 'hello', time: now() - 60000, synthId: 'a', echoes: 2 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false)
  expect(entries[0].suppressed).toBeUndefined()
})

test('stale entry early in the array does not abort the scan (cross-tab merge disorder)', () => {
  const entries = [
    { text: 'hello', time: now() - 60000, synthId: 'old', echoes: 2 },
    { text: 'hello', time: now(), synthId: 'fresh', echoes: 2 },
  ]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false)
  expect(isSentEcho('hello', 'kick')).toBe(true) // claimed by the fresh entry
})

test('legacy entry without echoes field defaults to 1', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a' }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false)
  expect(isSentEcho('hello', 'twitch')).toBe(false) // exhausted → renders, not suppressed
})

test('exhausted entries stay in the array for peekSentHost badge attribution', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a', echoes: 2 }]
  const isSentEcho = makeIsSentEcho(entries)
  isSentEcho('hello', 'twitch')
  isSentEcho('hello', 'kick')
  expect(entries.length).toBe(1)
  expect(entries[0].seenPlatforms).toEqual(['twitch', 'kick'])
})

/**
 * The count-overrun class — reported 2026-07-30 as "double posting on K and T".
 *
 * `echoes` was the number of send targets the EXTENSION knew about
 * (sendToTwitch + sendToKick + sendToYoutube) at the moment it tracked the
 * send. Any echo it didn't predict — a leg fanned out server-side, a relay, a
 * target resolved after tracking — overran that count. The overrun echo fell
 * out of the loop unclaimed and rendered as a second copy of your own message,
 * one row tagged [T] and one tagged [K].
 *
 * Suppression is keyed on the platform the echo actually arrived from, so an
 * undercounted entry cannot leak a duplicate. These fixtures all set `echoes`
 * to the WRONG value on purpose; it must not matter.
 */
test('REGRESSION: undercounted send (echoes:1) still suppresses the second platform', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a', echoes: 1 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false) // first copy renders
  expect(isSentEcho('hello', 'kick')).toBe(true) // was rendering a 2nd row
})

test('REGRESSION: an entry with no echoes field at all still dedups across platforms', () => {
  const entries = [{ text: 'hello', time: now(), synthId: 'a' }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('hello', 'twitch')).toBe(false)
  expect(isSentEcho('hello', 'kick')).toBe(true)
})

test('three platforms, one row — even when the entry claims a single target', () => {
  const entries = [{ text: 'gg', time: now(), synthId: 'a', echoes: 1 }]
  const isSentEcho = makeIsSentEcho(entries)
  const rendered = ['twitch', 'kick', 'youtube'].filter((p) => !isSentEcho('gg', p))
  expect(rendered).toEqual(['twitch'])
})

test("'yt' and 'youtube' land in ONE bucket, not two", () => {
  // Call sites pass 'youtube' but msg.platform elsewhere says 'yt'. Left
  // unnormalised they read as two different platforms, so a redelivery under
  // the other spelling would be suppressed as if it were a second platform's
  // copy — and a genuine second send of the same text would vanish with it.
  // One bucket means the repeat falls through to a later entry instead.
  const entries = [{ text: 'gg', time: now(), synthId: 'a', echoes: 3 }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('gg', 'youtube')).toBe(false)
  expect(isSentEcho('gg', 'yt')).toBe(false) // same bucket → treated as a later send
  expect(entries[0].seenPlatforms).toEqual(['youtube']) // not ['youtube','yt']
})

test('a platform that echoes twice does not swallow a later identical send', () => {
  // Stale redelivery (kick has been seen re-broadcasting 20+ min later) must
  // not consume the echo credit belonging to a genuine second send of the
  // same text — that would silently drop the second send's only copy.
  const t = now()
  const entries = [
    { text: 'lol', time: t - 200, synthId: 'a', echoes: 1 },
    { text: 'lol', time: t - 100, synthId: 'b', echoes: 1 },
  ]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('lol', 'twitch')).toBe(false) // send #1 renders
  expect(isSentEcho('lol', 'twitch')).toBe(false) // send #2 renders
  expect(entries[0].seenPlatforms).toEqual(['twitch'])
  expect(entries[1].seenPlatforms).toEqual(['twitch'])
})

test('dual-send reply: undercounted, prefixed twitch echo, still one row', () => {
  // Composite of the two failure modes: the twitch leg arrives with a
  // server-side "@parent " prefix AND the entry undercounts its targets.
  const entries = [{ text: 'theres no way lol', time: now(), synthId: 'a', echoes: 1, reply: true }]
  const isSentEcho = makeIsSentEcho(entries)
  expect(isSentEcho('@coaoaba theres no way lol', 'twitch')).toBe(false)
  expect(isSentEcho('theres no way lol', 'kick')).toBe(true)
})
