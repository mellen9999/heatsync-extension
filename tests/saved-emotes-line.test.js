/**
 * The saved-emotes line: the background says which of 7tv/bttv/ffz a room draws from a saved
 * copy, the pane prints "7tv is down — showing saved emotes" on the status strip while that
 * holds, and fresh data clears it. (src/background/04-emotes.js, src/multichat/emote-outage.js)
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const OUT = readFileSync(join(ROOT, 'src', 'multichat', 'emote-outage.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const SRC = bgSource()

const fill = (key, p) => EN[key].message.replace(/\$P(\d)\$/g, (_, n) => p[n - 1])

function pane({ legs = { twitch: 'streamer' } } = {}) {
  const els = new Map()
  const bar = { appendChild: (e) => els.set(e.id, e) }
  const doc = {
    getElementById: (id) => (id === 'hs-mc-statusbar' ? bar : els.get(id) || null),
    createElement: () => ({ setAttribute() {}, hidden: false, id: '', textContent: '' }),
  }
  const api = new Function('document', 't', 'lawOpenLegs', `${OUT}; return { noteEmoteOutage, openEmoteOutage }`)(
    doc,
    fill,
    () => legs,
  )
  return {
    ...api,
    line: () => (els.get('hs-mc-emote-outage')?.hidden === false ? els.get('hs-mc-emote-outage').textContent : ''),
  }
}

test('one provider down reads like the site', () => {
  const p = pane()
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'Streamer', stale: ['7tv'] })
  expect(p.line()).toBe('7tv is down — showing saved emotes')
})

test('two and three providers use the plural lines', () => {
  const p = pane()
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer', stale: ['7tv', 'bttv'] })
  expect(p.line()).toBe('7tv and bttv are down — showing saved emotes')
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer', stale: ['7tv', 'bttv', 'ffz'] })
  expect(p.line()).toBe('7tv, bttv and ffz are down — showing saved emotes')
})

test('fresh data clears the line', () => {
  const p = pane()
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer', stale: ['ffz'] })
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer', stale: [] })
  expect(p.line()).toBe('')
})

test('a message with no stale field (older background) is fresh', () => {
  const p = pane()
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer', stale: ['ffz'] })
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'streamer' })
  expect(p.line()).toBe('')
})

test("another room's outage does not show on this tab", () => {
  const p = pane()
  p.noteEmoteOutage({ platform: 'twitch', channelOwner: 'someoneelse', stale: ['7tv'] })
  expect(p.line()).toBe('')
})

test('the background files the salvaged providers and broadcasts them with every set', () => {
  const part = SRC.slice(SRC.indexOf('async function fetchChannelOwnerEmotes('))
  expect(part).toContain('salvaged.add(src)')
  expect(part).toContain('channelEmotesStale[key] = outageProviders(salvaged)')
  expect((part.match(/type: 'channel_emotes_update'/g) || []).length).toBeGreaterThanOrEqual(3)
  expect((part.match(/stale: /g) || []).length).toBeGreaterThanOrEqual(3)
  expect(SRC).toContain('channelEmotesStale[key] = outageProviders(new Set(row.stale))') // boot restore
})

test('every locale has all three lines', () => {
  for (const code of readdirSync(join(ROOT, 'src', '_locales'))) {
    const loc = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', code, 'messages.json'), 'utf8'))
    for (const n of [1, 2, 3]) {
      const m = loc[`mc_emote_outage_${n}`]
      expect(m?.message, `${code} ${n}`).toContain(`$P${n}$`)
      expect(Object.keys(m.placeholders)).toHaveLength(n)
    }
  }
})

test('a whole failed read names no provider — it can be our own network', () => {
  const i = SRC.indexOf('Channel emotes fetch failed')
  expect(i).toBeGreaterThan(-1)
  const tail = SRC.slice(i, SRC.indexOf('} else {', i))
  expect(tail).not.toMatch(/channelEmotesStale\[key\]\s*=/)
})
