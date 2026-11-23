// The picker with nothing typed is the emote law's browse of the open tab (emote-law-offer.js
// lawBrowseSections). Before this it kept one tile per NAME (yours hid the room's emote of that
// name, the room's hid the global), filed the room's emotes under their providers beside the
// globals, and listed everything in the order it had loaded.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const e = (id, source = '7tv', more = {}) => ({
  url: `https://cdn.test/${source}/${id}.webp`,
  source,
  id,
  state: 'global',
  ...more,
})
const mine = (id) => e(id, 'heatsync', { hash: `h-${id}`, id: undefined, state: 'owned' })
const m = (o) => new Map(Object.entries(o))
const LABELS = { set: 'inventory', channel: 'channel', '7tv': '7TV', bttv: 'BTTV' }

function world({ room = {}, own = {}, globals = {}, other = {} } = {}) {
  const rig = lawOfferRig({
    viewerPersonalEmotes: m(own),
    emoteCache: m(globals),
    channelEmoteCaches: { 'chan-a': m(room), 'chan-b': m(other) },
  })
  const sections = (pools = [rig.channelEmoteCaches['chan-a']]) =>
    Object.fromEntries(
      rig.lawBrowseSections(pools, LABELS).map((s) => [s.key, s.emotes.map(([n, x]) => `${n} ${x.url}`)]),
    )
  return { rig, sections }
}
const tile = (n, x) => `${n} ${x.url}`

describe('the untyped picker', () => {
  test("every copy of a name keeps its tile: yours, the room's and the global", () => {
    const { sections } = world({
      room: { KEKW: e('room') },
      own: { KEKW: mine('mine') },
      globals: { KEKW: e('glob', 'bttv') },
    })
    expect(sections()).toEqual({
      set: [tile('KEKW', mine('mine'))],
      channel: [tile('KEKW', e('room'))],
      bttv: [tile('KEKW', e('glob', 'bttv'))],
    })
  })

  test("the room's emotes are one section, whatever provider each came from, and never mixed into the globals", () => {
    const { sections } = world({
      room: { Bee: e('rb', 'bttv'), Ant: e('ra', '7tv') },
      globals: { Cat: e('gc', '7tv') },
    })
    expect(sections()).toEqual({
      channel: [tile('Ant', e('ra', '7tv')), tile('Bee', e('rb', 'bttv'))],
      '7tv': [tile('Cat', e('gc', '7tv'))],
    })
  })

  test('a section is the same list in any load order: most used first, then a-z', () => {
    const a = world({ room: { Zed: e('z'), Ant: e('a'), Mid: e('m') } })
    const b = world({ room: { Mid: e('m'), Zed: e('z'), Ant: e('a') } })
    expect(a.sections().channel).toEqual([tile('Ant', e('a')), tile('Mid', e('m')), tile('Zed', e('z'))])
    expect(b.sections().channel).toEqual(a.sections().channel)
    a.rig.frecency.set('Zed', 5)
    expect(a.sections().channel).toEqual([tile('Zed', e('z')), tile('Ant', e('a')), tile('Mid', e('m'))])
  })

  test("a tab that spans a second channel lists that channel's emotes after the room's, the same picture once", () => {
    const { rig, sections } = world({
      room: { Ant: e('a') },
      other: { Zoo: e('z2'), Ant: e('a'), Bat: e('b2'), Ant2: e('a') },
    })
    const pools = [rig.channelEmoteCaches['chan-a'], rig.channelEmoteCaches['chan-b']]
    expect(sections(pools).channel).toEqual([
      tile('Ant', e('a')),
      tile('Ant2', e('a')),
      tile('Bat', e('b2')),
      tile('Zoo', e('z2')),
    ])
  })

  test('a blocked emote keeps its tile (that is where it is unblocked), and your set shows with suggestions off', () => {
    const { rig, sections } = world({ room: { Ant: e('a') }, own: { Mine: mine('m1') } })
    rig.blocked = () => true
    rig.settings.suggestInventoryEmotes = false
    expect(sections()).toEqual({ set: [tile('Mine', mine('m1'))], channel: [tile('Ant', e('a'))] })
  })

  test('emotes.js draws exactly this, under favorites and recents', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
    const at = src.indexOf('function groupEmotes')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    expect(body).toContain('lawBrowseSections(activeTabEmotePools(),')
    expect(src).not.toContain('pickerBaseEmotes')
    expect(src.match(/groupEmotes\(\)/g)?.length).toBe(3)
  })
})
