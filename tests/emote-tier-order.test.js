// rule 3: channel ffz, 7tv, bttv; globals 7tv, bttv, ffz, twitch — one order on every path.
// rule 2: on native chat the sender's pick beats the room's same-name emote.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMOTE_TIER_ORDER, rankEmotePool, resolveEmoteProviderWinner } from '../src/lib/utils.js'
import { bgSource } from './bg-src.js'

const root = join(import.meta.dir, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const e = (name, source) => ({ name, source, hash: `${source}-${name}` })

test('channel pool: owner set first, then ffz, 7tv, bttv, then natives', () => {
  const out = rankEmotePool(
    [e('W', 'bttv'), { name: 'W', hash: 'owner' }, e('W', '7tv'), e('W', 'kick'), e('W', 'ffz'), e('W', 'twitch')],
    'channel',
  )
  expect(out.map((x) => x.hash)).toEqual(['owner', 'ffz-W', '7tv-W', 'bttv-W', 'twitch-W', 'kick-W'])
})

test('global pool: 7tv, bttv, ffz, twitch', () => {
  const out = rankEmotePool([e('W', 'twitch'), e('W', 'ffz'), e('W', 'bttv'), e('W', '7tv')], 'global')
  expect(out.map((x) => x.source)).toEqual(['7tv', 'bttv', 'ffz', 'twitch'])
})

test('multichat pool merge picks the same winner as the order', () => {
  for (const tier of ['channel', 'global']) {
    const order = EMOTE_TIER_ORDER[tier]
    const a = order.filter((p) => ['ffz', '7tv', 'bttv'].includes(p))
    let slot = null
    for (const p of [...a].reverse()) slot = resolveEmoteProviderWinner(slot, e('W', p), order)
    expect(slot.source).toBe(a[0])
    slot = null
    for (const p of a) slot = resolveEmoteProviderWinner(slot, e('W', p), order)
    expect(slot.source).toBe(a[0])
  }
})

test('background.js carries the same two orders as lib', () => {
  const bg = bgSource()
  const m = bg.match(/const EMOTE_TIER_ORDER = \{\s*channel: (\[[^\]]*\]),\s*global: (\[[^\]]*\]),?\s*\}/)
  expect(m).not.toBeNull()
  expect(JSON.parse(m[1].replace(/'/g, '"'))).toEqual(EMOTE_TIER_ORDER.channel)
  expect(JSON.parse(m[2].replace(/'/g, '"'))).toEqual(EMOTE_TIER_ORDER.global)
})

// native chat: the sender's pick is the line's pick
const src = read('src/content/content.js')
const fnSrc = (name) => {
  const i = src.indexOf(`  function ${name}(`)
  return src.slice(i, src.indexOf('\n  }\n', i) + 4)
}
const layeredEmoteMap = new Function(`${fnSrc('layeredEmoteMap')}; return layeredEmoteMap`)()

test('native layers: broadcast > sender set > channel > globals', () => {
  const bc = new Map([['W', 'broadcast']])
  const sender = new Map([
    ['W', 'sender'],
    ['S', 'sender-only'],
  ])
  const channel = new Map([
    ['W', 'channel'],
    ['C', 'channel-only'],
  ])
  const base = new Map([
    ['W', 'global'],
    ['G', 'global-only'],
  ])
  const m = layeredEmoteMap([bc, sender, channel, base])
  expect(m.get('W')).toBe('broadcast')
  expect(layeredEmoteMap([null, sender, channel, base]).get('W')).toBe('sender')
  expect(layeredEmoteMap([null, null, channel, base]).get('W')).toBe('channel')
  expect(m.get('C')).toBe('channel-only')
  expect(m.get('G')).toBe('global-only')
  expect(m.has('S')).toBe(true)
  expect(m.has('nope')).toBe(false)
})

test('native content.js builds its sender-vs-channel layers in that order', () => {
  expect(src).toContain('layeredEmoteMap([userBroadcasts, senderSet, cachedChannelEmotes, baseMap])')
})

test('native: your own line is your inventory pick, a block hits the exact hash only', () => {
  expect(src).toContain('cachedOwnEmotes.set(name, variants[0])')
  expect(src).toContain(':not([data-emote-hash])')
  expect(src).toContain('?.filter((v) => emote.inInventory || !v.inInventory)')
})
