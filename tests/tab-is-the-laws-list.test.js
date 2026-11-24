// Tab, the `:` list and the Tab list are the emote law's one ranked offer (emote-law-offer.js):
// the exact name, names you use, the room, yours, globals, not loaded yet, emoji. The room is the
// one the open tab's line goes to. Before this the overlay had its own comparator and its own
// merged map, and Tab's first answer for a name could differ from what typing it sent.
import { describe, expect, test } from 'bun:test'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const e = (id, source = '7tv', more = {}) => ({
  url: `https://cdn.test/${source}/${id}.webp`,
  source,
  id,
  state: 'global',
  ...more,
})
const mine = (id, more = {}) => e(id, 'heatsync', { hash: `h-${id}`, id: undefined, state: 'owned', ...more })
const m = (o) => new Map(Object.entries(o))
const names = (list) => list.map((x) => x.name)
const urls = (list) => list.map((x) => x.url)

function world({ room = {}, own = {}, globals = {} } = {}) {
  return lawOfferRig({
    viewerPersonalEmotes: m(own),
    emoteCache: m(globals),
    channelEmoteCaches: { 'chan-a': m(room) },
  })
}

describe('one name, several pictures', () => {
  test("a fully typed name: the room's copy, then yours, then the global", () => {
    const rig = world({ room: { KEKW: e('room') }, own: { KEKW: mine('mine') }, globals: { KEKW: e('glob', 'bttv') } })
    const list = rig.findEmoteMatches('KEKW')
    expect(urls(list)).toEqual([e('room').url, mine('mine').url, e('glob', 'bttv').url])
    expect(list.map((x) => x.tier)).toEqual([0, 1, 2])
  })

  test("Tab's first answer for a typed name is what typing it sends (the chip)", () => {
    const rig = world({
      room: { KEKW: e('room') },
      own: { KEKW: mine('mine'), Mine1: mine('m1') },
      globals: { Kappa: e('k', 'twitch') },
    })
    for (const word of ['KEKW', 'Mine1', 'Kappa']) {
      expect(rig.findEmoteMatches(word)[0].url).toBe(rig.lawChip(word).e.url)
    }
  })

  test('the spelling typed leads its case twin', () => {
    const rig = world({ room: { KEKW: e('upper') }, globals: { kekw: e('lower', 'bttv') } })
    expect(names(rig.findEmoteMatches('kekw'))).toEqual(['kekw', 'KEKW'])
    expect(names(rig.findEmoteMatches('KEKW'))).toEqual(['KEKW', 'kekw'])
  })
})

describe("the platform's own emote of a name", () => {
  test('your twitch emote leads on a twitch room, and the other copies are marked: they will not show there', () => {
    const rig = world({ room: { Pog: e('room') }, own: { Pog: e('sub', 'twitch', { subscription: true }) } })
    const list = rig.findEmoteMatches('Pog')
    expect(list.map((x) => [x.source, !!x.shadowed])).toEqual([
      ['twitch', false],
      ['7tv', true],
    ])
  })
})

describe('the tiers', () => {
  test('room, then yours, then globals; starts-with before word-start before inside', () => {
    const rig = world({
      room: { PogU: e('r1'), MegaPog: e('r2'), xpogx: e('r3') },
      own: { Pogey: mine('o1') },
      globals: { PogChamp: e('g1', 'twitch') },
    })
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['PogU', 'MegaPog', 'xpogx', 'Pogey', 'PogChamp'])
  })

  test('a name you use jumps the room only when what you typed starts it', () => {
    const rig = world({ room: { PogU: e('r1') }, own: { Pogey: mine('o1'), MegaPog: mine('o2') } })
    rig.frecency.set('Pogey', 3).set('MegaPog', 9)
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['Pogey', 'PogU', 'MegaPog'])
  })

  test('the order never depends on which emote loaded first', () => {
    const room = { PogU: e('r1'), Pogger: e('r2'), PogO: e('r3') }
    const globals = { PogChamp: e('g1', 'twitch'), Poggies: e('g2', 'bttv') }
    const flip = (o) => Object.fromEntries(Object.entries(o).reverse())
    const a = names(world({ room, globals }).findEmoteMatches('pog'))
    const b = names(world({ room: flip(room), globals: flip(globals) }).findEmoteMatches('pog'))
    expect(b).toEqual(a)
  })

  test('"suggest my emotes" off: an inventory-only name is not offered, a twitch emote of yours still is', () => {
    const rig = world({
      room: { PogU: e('r1') },
      own: { Pogey: mine('o1'), PogSub: e('sub', 'twitch', { subscription: true }) },
    })
    rig.settings.suggestInventoryEmotes = false
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['PogU', 'PogSub'])
  })

  test('the room is the one the line goes to, never another loaded channel', () => {
    const rig = world({ room: { PogU: e('r1') } })
    rig.channelEmoteCaches['chan-b'] = m({ PogB: e('b1') })
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['PogU'])
    rig.legs = { twitch: 'chan-b' }
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['PogB'])
  })
})

describe('what is never offered', () => {
  test('an emote you blocked is hidden, and no catalog look-alike takes its name', () => {
    const rig = world({ room: { PogU: e('r1'), Pogger: e('r2') } })
    rig.blocked = (n) => n === 'PogU'
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['Pogger'])
    const cat = [
      rig.lawCatalogEmote({ name: 'PogU', url: 'https://cdn.test/7tv/other.webp', id: 'other', provider: '7tv' }),
    ]
    // the catalog entry itself is refused by the block on its name
    expect(cat[0]).toBe(null)
  })

  test('a modifier token never completes', () => {
    const rig = world({ room: { 'w!': e('r1') } })
    expect(rig.findEmoteMatches('w!')).toEqual([])
  })
})

describe('a picture swapped under a name it already had', () => {
  test('Tab offers the new picture (same name, same count)', () => {
    const rig = world({ room: { PogU: e('old') } })
    expect(rig.findEmoteMatches('pogu')[0].url).toBe(e('old').url)
    rig.channelEmoteCaches['chan-a'].set('PogU', e('new'))
    expect(rig.findEmoteMatches('pogu')[0].url).toBe(e('new').url)
  })
})

describe('the catalog arrives late', () => {
  const hit = (rig, name, id, uses = 0) =>
    rig.lawCatalogEmote({ name, url: `https://cdn.test/7tv/${id}.webp`, id, provider: '7tv', uses })

  test('it joins after the cursor and nothing up to the cursor moves', () => {
    const rig = world({ room: { PogU: e('r1'), Pogger: e('r2') }, globals: { PogChamp: e('g1', 'twitch') } })
    const before = rig.findEmoteMatches('pog')
    expect(names(before)).toEqual(['PogU', 'Pogger', 'PogChamp'])
    const after = rig.findEmoteMatches('pog', {
      catalog: [hit(rig, 'pog', 'c1'), hit(rig, 'PogTasty', 'c2')],
      prev: before,
      cursor: 1,
    })
    expect(names(after.slice(0, 2))).toEqual(['PogU', 'Pogger'])
    expect(after[0]).toBe(before[0])
    // a search answer is not what typing it sends: the exact one leads the catalog, after the globals
    expect(names(after.slice(2))).toEqual(['PogChamp', 'pog', 'PogTasty'])
    expect(after[3].remote).toBe(true)
  })

  test('one copy of a name (the most carried), and none of a name something loaded answers to', () => {
    const rig = world({ room: { PogU: e('r1') } })
    const before = rig.findEmoteMatches('pog')
    const cat = [hit(rig, 'PogU', 'c0', 99), hit(rig, 'PogTasty', 'c1', 5), hit(rig, 'PogTasty', 'c2', 50)]
    const after = rig.findEmoteMatches('pog', { catalog: cat, prev: before, cursor: 0 })
    expect(names(after)).toEqual(['PogU', 'PogTasty'])
    expect(after[1].url).toContain('c2')
  })

  test('nothing local matched: the catalog is the whole list', () => {
    const rig = world()
    const after = rig.findEmoteMatches('pog', { catalog: [hit(rig, 'PogTasty', 'c1')], prev: [], cursor: -1 })
    expect(names(after)).toEqual(['PogTasty'])
    expect(after[0]).toMatchObject({ type: 'emote', source: '7tv', id: 'c1', remote: true })
  })
})

describe('people', () => {
  test('@ = people only, recent talkers first', () => {
    const rig = world({ room: { poggers: e('r1') } })
    for (const u of ['pogman', 'pogfan']) rig.usernames.add(u)
    rig.recency.set('pogfan', 0)
    expect(names(rig.findEmoteMatches('@pog'))).toEqual(['@pogfan', '@pogman'])
  })

  test('a bare word: the exact emote, the person typed whole, the room, the other people, the rest', () => {
    const rig = world({ room: { pog: e('r0'), PogU: e('r1') }, globals: { PogChamp: e('g1', 'twitch') } })
    rig.people.set('pog', 'Pog').set('pogfan', 'pogfan')
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['pog', 'Pog', 'PogU', 'pogfan', 'PogChamp'])
  })
})

describe('name0 and the colon', () => {
  test('"name0" offers the base emote as an overlay when nothing is literally named that', () => {
    const rig = world({ room: { TriHard: e('r1') } })
    const list = rig.findEmoteMatches('TriHard0')
    expect(list[0]).toMatchObject({ name: 'TriHard0', url: e('r1').url, _synthOverlay: true })
  })

  test('an emote literally named "name0" is itself, with no overlay beside it', () => {
    const rig = world({ room: { TriHard: e('r1'), TriHard0: e('r2') } })
    const list = rig.findEmoteMatches('TriHard0')
    expect(list[0]).toMatchObject({ name: 'TriHard0', url: e('r2').url })
    expect(list.some((x) => x._synthOverlay)).toBe(false)
  })

  test('":word" lists emotes first, then emoji', () => {
    const rig = world({ room: { smileW: e('r1') } })
    rig.emoji.push({ name: 'smile', emoji: '😄' }, { name: 'unsmiling', emoji: '😐' }, { name: 'cat', emoji: '🐱' })
    const list = rig.findEmoteMatches(':smi')
    expect(names(list)).toEqual(['smileW', ':smile:', ':unsmiling:'])
    expect(list[1]).toMatchObject({ type: 'emoji', emoji: '😄' })
  })
})

describe('one picture under two names', () => {
  test('each name is its own row; the same name and picture in two sets is one', () => {
    const pic = e('same')
    const rig = world({ room: { PogA: pic, PogB: { ...pic } }, own: { PogA: { ...pic } } })
    expect(names(rig.findEmoteMatches('pog'))).toEqual(['PogA', 'PogB'])
  })
})

describe("the picker's search", () => {
  const seven = (id, size = '2x.webp') => `https://cdn.7tv.app/emote/${id}/${size}`
  const hit = (name, id, more = {}) => ({ name, url: seven(id, '1x.avif'), id, provider: '7tv', ...more })
  const tiles = (list) => list.map((x) => [x.name, x.raw.url, x.remote])

  test("the law's list leads: the first tile is what typing the word sends", () => {
    const rig = world({ room: { KEKW: e('room') }, own: { KEKW: mine('mine') } })
    const list = rig.lawPickerSearch('KEKW', [], false)
    expect(list[0].raw.url).toBe(rig.lawChip('KEKW').e.url)
    expect(tiles(list)).toEqual([
      ['KEKW', e('room').url, false],
      ['KEKW', mine('mine').url, false],
    ])
  })

  test('every other picture the search returned follows: another KEKW can be picked on purpose', () => {
    const rig = world({ room: { KEKW: { url: seven('ROOM'), source: '7tv', state: 'global' } } })
    const list = rig.lawPickerSearch('kekw', [hit('KEKW', 'B'), hit('KEKW', 'C'), hit('kekwait', 'D')], false)
    expect(tiles(list)).toEqual([
      ['KEKW', seven('ROOM'), false],
      ['kekwait', seven('D', '1x.avif'), true],
      ['KEKW', seven('B', '1x.avif'), true],
      ['KEKW', seven('C', '1x.avif'), true],
    ])
  })

  test("the room's own emote coming back from the search is not a second tile, in any size or format", () => {
    const rig = world({ room: { KEKW: { url: seven('ROOM'), source: '7tv', state: 'global' } } })
    const list = rig.lawPickerSearch('kekw', [hit('KEKW', 'ROOM'), hit('KEKW', 'B')], false)
    expect(tiles(list)).toEqual([
      ['KEKW', seven('ROOM'), false],
      ['KEKW', seven('B', '1x.avif'), true],
    ])
  })

  test('"exact" keeps only the name typed, any case: the room copy leads the search answer', () => {
    const rig = world({ room: { KEKW: e('room'), KEKWait: e('wait') } })
    const list = rig.lawPickerSearch('kekw', [hit('kekw', 'B'), hit('KEKWow', 'C')], true)
    expect(list.map((x) => x.name)).toEqual(['KEKW', 'kekw'])
  })

  test('a blocked name is not found again through the search', () => {
    const rig = world({ room: { KEKW: e('room') } })
    rig.blocked = (n) => n === 'KEKW'
    expect(rig.lawPickerSearch('kekw', [hit('KEKW', 'B')], false)).toEqual([])
  })
})

describe('a search result clicked in the picker', () => {
  test("is this message's pick before it is pasted, and joins your set only when the line is sent", async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
    const a = src.indexOf("if (img.dataset.state === 'remote') {")
    const b = src.indexOf('pasteEmoteToInput(name)', a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    const click = src.slice(a, b)
    // trackCompletionForAutoAdd pins the pick (lawPin) and registers it for the send's add
    expect(click).toContain('trackCompletionForAutoAdd({')
    expect(click).toContain('remote: true')
    // a click used to add the emote to your set at once: a pick you deleted again had still changed what you own
    expect(click).not.toContain('addEmoteToInventory(')
    expect(click).not.toContain('viewerPersonalEmotes.set(')
  })

  test("the pin makes the chip that very picture, over the room's emote of the name", () => {
    const rig = world({ room: { KEKW: e('room') } })
    expect(rig.lawChip('KEKW').e.url).toBe(e('room').url)
    rig.lawPin('KEKW', { url: 'https://cdn.7tv.app/emote/OTHER/1x.avif', source: '7tv', id: 'OTHER' })
    expect(rig.lawChip('KEKW')).toMatchObject({ from: 'pick', e: { url: 'https://cdn.7tv.app/emote/OTHER/1x.avif' } })
    rig.reset()
    expect(rig.lawChip('KEKW').e.url).toBe(e('room').url)
  })
})
