/**
 * The chip, what ships and your own row are one answer (docs/emote-law-map.md, SEND).
 *
 * A send keeps the refs it shipped on its tracked entry. The echo of that very send draws
 * them (stampSentHost), kick's echo files them with the server (its only witness for a
 * browser send), and twitch's tag carries them in the shape the server stores: {p,id,a},
 * never a url. The same words typed again later, natively, inherit nothing.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeEmoteRefsForSend } from '../src/lib/emote-refs-normalize.js'
import { platformMark } from '../src/lib/palette.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const INPUT = readFileSync(join(MC, 'input.js'), 'utf8')
const IRC = readFileSync(join(MC, 'irc.js'), 'utf8')
const LAW_SEND = readFileSync(join(MC, 'emote-law-send.js'), 'utf8')
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

// the real tracker: its entries, the echo match, the peek
let entries = []
const peekSentRefs = new Function(
  'entries',
  `const DUP_BYPASS_CHAR = '\\u{E0000}'
   const SENT_REFS_WINDOW = ${/const SENT_REFS_WINDOW = (\d+)/.exec(INPUT)[1]}
   ${fn(IRC, 'stripDupBypass')}
   ${fn(INPUT, '_unkickEmotes')}
   ${fn(INPUT, '_echoTextMatches')}
   ${fn(INPUT, 'peekSentRefs').replaceAll('_recentSentMessages', 'entries()')}
   return peekSentRefs`,
)(() => entries)
const lawStored = new Function('normalizeEmoteRefsForSend', `${fn(LAW_SEND, 'lawStored')}\nreturn lawStored`)(
  normalizeEmoteRefsForSend,
)

const posted = []
Object.assign(globalThis, {
  platformMark,
  peekSentRefs,
  lawStored,
  safeSendMessage: (m) => {
    posted.push(m)
    return Promise.resolve({ ok: true })
  },
})
const { stampSentHost, hsWitnessOwnEcho } = await import('../src/multichat/hs-origins.js')
afterAll(() => {
  for (const k of ['platformMark', 'peekSentRefs', 'lawStored', 'safeSendMessage']) delete globalThis[k]
})
beforeEach(() => {
  entries = []
  posted.length = 0
})

const STV = '60ae958e229664e8667aea38'
const pick = { name: 'KEKW', url: `https://cdn.7tv.app/emote/${STV}/2x.webp`, provider: '7tv', zeroWidth: false }
const owned = {
  name: 'Mine',
  url: 'https://heatsync.org/e/abc.webp',
  hash: 'deadbeef01',
  provider: 'hs',
  zeroWidth: false,
}
// a tracked send: `picked` names the refs that are this message's picks (default: all of them)
const sentNow = (text, refs, ago = 0, picked = refs && Object.keys(refs)) =>
  entries.push({ text, time: Date.now() - ago, sendId: 's1', ...(refs ? { refs, picked } : null) })

test('the echo of your send draws the picks that send shipped', () => {
  sentNow('gm KEKW', { KEKW: pick })
  const m = { text: 'gm KEKW', time: Date.now() }
  stampSentHost(m, 'twitch')
  expect(m.hsEmotes).toEqual({ KEKW: pick })
})

test('what you shipped wins over a name the server matched; other names the server sent stay', () => {
  sentNow('gm KEKW other', { KEKW: pick })
  const m = {
    text: 'gm KEKW other',
    time: Date.now(),
    hsEmotes: { KEKW: { url: 'x', nm: 1 }, other: { url: 'y', nm: 1 } },
  }
  stampSentHost(m, 'kick')
  expect(m.hsEmotes.KEKW).toEqual(pick)
  expect(m.hsEmotes.other).toEqual({ url: 'y', nm: 1 })
})

test('a word the room or your set answers is left to the row: only a pick is handed over', () => {
  sentNow('gm KEKW Mine', { KEKW: pick, Mine: owned }, 0, ['KEKW'])
  const m = { text: 'gm KEKW Mine', time: Date.now() }
  stampSentHost(m, 'twitch')
  expect(m.hsEmotes).toEqual({ KEKW: pick })
})

test('a send with emotes but no picks stamps nothing', () => {
  sentNow('gm Mine', { Mine: owned }, 0, null)
  const m = { text: 'gm Mine', time: Date.now() }
  stampSentHost(m, 'twitch')
  expect('hsEmotes' in m).toBe(false)
})

test('a reload keeps them: the row is matched on its own time, not on the clock', () => {
  sentNow('gm KEKW', { KEKW: pick }, 3 * 60 * 60 * 1000)
  const m = { text: 'gm KEKW', time: Date.now() - 3 * 60 * 60 * 1000 + 800 }
  stampSentHost(m, 'twitch')
  expect(m.hsEmotes).toEqual({ KEKW: pick })
})

test('the same words typed again later inherit nothing', () => {
  sentNow('gm KEKW', { KEKW: pick }, 5 * 60 * 1000)
  const m = { text: 'gm KEKW', time: Date.now() }
  stampSentHost(m, 'twitch')
  expect(m.hsEmotes).toBeUndefined()
})

test('a send with no emotes stamps nothing', () => {
  sentNow('gm')
  const m = { text: 'gm', time: Date.now() }
  stampSentHost(m, 'twitch')
  expect('hsEmotes' in m).toBe(false)
})

test('kick: the echo files the refs in the stored shape, against the words as typed', () => {
  sentNow('gm KEKW Mine', { KEKW: pick, Mine: owned })
  // kick echoes its own emotes in wire form: the witness sends the typed words, which the refs name
  hsWitnessOwnEcho('kick', 'Room', 'k-1', 's1', 'gm KEKW Mine')
  expect(posted[0].body).toEqual({
    platform: 'kick',
    channel: 'room',
    message_id: 'k-1',
    origin: 'heatsync',
    send_id: 's1',
    refs: { KEKW: { p: '7tv', id: STV }, Mine: { p: 'hs', id: 'deadbeef01' } },
    text: 'gm KEKW Mine',
  })
})

test('kick: a line with nothing storable posts the origin alone; youtube never carries refs', () => {
  sentNow('gm', null)
  hsWitnessOwnEcho('kick', 'room', 'k-2', 's1', 'gm')
  sentNow('yo KEKW', { KEKW: pick })
  hsWitnessOwnEcho('youtube', 'room', 'y-1', 's1', 'yo KEKW')
  expect('refs' in posted[0].body || 'text' in posted[0].body).toBe(false)
  expect('refs' in posted[1].body || 'text' in posted[1].body).toBe(false)
})

test('stored shape: a provider id is read from the cdn path, a hash means yours, a url never travels', () => {
  expect(lawStored({ KEKW: pick, Mine: owned })).toEqual({
    KEKW: { p: '7tv', id: STV },
    Mine: { p: 'hs', id: 'deadbeef01' },
  })
  // twitch and kick mark their own emotes; an unknown host has nothing the server can check
  expect(
    lawStored({ a: { name: 'a', url: 'https://files.kick.com/emotes/1/fullsize', provider: 'kick' } }),
  ).toBeUndefined()
  expect(lawStored(undefined)).toBeUndefined()
})

test('the send hands its refs to the tracker, and the kick echo hands the witness its text', () => {
  expect(INPUT).toContain('!!replyState?.msgId, _sendId, shipped)')
  expect(readFileSync(join(MC, 'main.js'), 'utf8')).toContain(
    "hsWitnessOwnEcho('kick', msg.channel, msg.id, peekSentId(msg.text), msg.text)",
  )
})
