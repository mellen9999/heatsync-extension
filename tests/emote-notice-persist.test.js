import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// 7TV emote add/remove notices must outlive reloads: a week of storage, a
// timed dupe check (not text-only), and a cap that sheds ordinary events first.
const SRC = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const a = SRC.indexOf('const STREAM_EVENTS_MAX')
const b = SRC.indexOf('let streamEventsLoaded')
const c = SRC.indexOf('const isEmoteEvent')
const d = SRC.indexOf('// Inject stream events into IRC buffers')
const { EMOTE_EVENT_TTL_MS, sameStreamEvent, pruneStreamEvents, STREAM_EVENTS_MAX } = new Function(
  `${SRC.slice(a, b)}\n${SRC.slice(c, d)}; return { EMOTE_EVENT_TTL_MS, sameStreamEvent, pruneStreamEvents, STREAM_EVENTS_MAX }`,
)()

const emote = (text, time) => ({ type: 'stream-event', eventClass: 'event-emote', text, time })
const other = (n) => ({ type: 'stream-event', eventClass: 'event-online', text: `live ${n}`, time: n })

describe('emote notice persistence', () => {
  test('keeps a week', () => expect(EMOTE_EVENT_TTL_MS).toBe(7 * 86400000))

  test('same removal days apart is a new notice, a replay of the same one is not', () => {
    const t = 1_000_000_000
    expect(sameStreamEvent(emote('x', t), emote('x', t))).toBe(true)
    expect(sameStreamEvent(emote('x', t), emote('x', t + 3 * 86400000))).toBe(false)
  })

  test('non-emote events still dedupe on text alone', () => {
    expect(sameStreamEvent(other(1), { ...other(1), time: 99 })).toBe(true)
  })

  test('over the cap, ordinary events go first', () => {
    const evs = [emote('keep', 1)]
    for (let i = 0; i < STREAM_EVENTS_MAX + 5; i++) evs.push(other(i))
    const out = pruneStreamEvents(evs)
    expect(out.length).toBe(STREAM_EVENTS_MAX)
    expect(out.some((e) => e.text === 'keep')).toBe(true)
  })
})
