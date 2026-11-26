// rule 3: channel ffz, 7tv, bttv; globals 7tv, bttv, ffz, twitch — one order on every path.
// rule 2: on native chat the sender's pick beats the room's same-name emote.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
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

test('background.js runs the lib file itself: no second order, no second ranker', () => {
  const bg = bgSource()
  const lib = read('src/lib/emote-tier.js').replace(/^export\s+/gm, '')
  expect(bg.split(lib).length - 1).toBe(1)
  expect(bg.match(/(?:const|let|var)\s+EMOTE_TIER_ORDER\b/g)).toHaveLength(1)
  expect(bg.match(/function\s+rankEmotePool\b/g)).toHaveLength(1)
})

test('one definition of the order and the ranker in the extension', () => {
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : [],
    )
  const hits = walk('src').filter((f) =>
    /(?:^|\n)\s*(?:export\s+)?(?:(?:const|let|var)\s+EMOTE_TIER_ORDER\b|function\s+rankEmotePool\b)/.test(read(f)),
  )
  expect(hits).toEqual(['src/lib/emote-tier.js'])
})

// native chat: which emote a word is on a row is tests/native-emote-law.test.ts (the law's order,
// proven against shared/emote-law.ts). What stays here: a block hits the exact picture only.
const src = read('src/content/content.js')

test('native: a block hits the exact hash only', () => {
  expect(src).toContain(':not([data-emote-hash])')
  expect(src).toContain('?.filter((v) => emote.inInventory || !v.inInventory)')
})

test('law: the streamer heatsync emote wins its name in the room; heatsync is last of the globals', () => {
  const hs = { source: 'heatsync', hash: 'hs' }
  expect(resolveEmoteProviderWinner(e('W', '7tv'), hs, EMOTE_TIER_ORDER.channel)).toBe(hs)
  expect(resolveEmoteProviderWinner(hs, e('W', 'ffz'), EMOTE_TIER_ORDER.channel)).toBe(hs)
  const g = e('W', 'ffz')
  expect(resolveEmoteProviderWinner(g, hs, EMOTE_TIER_ORDER.global)).toBe(g)
  expect(rankEmotePool([hs, e('W', 'twitch'), e('W', '7tv')], 'global').map((x) => x.source)).toEqual([
    '7tv',
    'twitch',
    'heatsync',
  ])
})
