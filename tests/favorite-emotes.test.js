// Favorite emotes (emote-favorites.js; the law's favorites, site docs/emote-law.md): a pinned
// picture leads the picker and Tab, the list is the account's (heatsync.org's `emoteFavorites`
// setting, so the site and every overlay show one list), and a favorite is the picture, never the
// name. The shipped module runs over the shipped law; only storage and the network are stand-ins.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const stv = (id, more) => ({ url: `https://cdn.7tv.app/emote/${id}/2x.webp`, source: '7tv', state: 'global', ...more })
const own = (h) => ({ url: `https://cdn.heatsync.org/uploads/${h}.webp`, source: 'heatsync', state: 'owned', hash: h })
const m = (o) => new Map(Object.entries(o))
const tick = () => new Promise((r) => setTimeout(r, 0))
const TOOK = { ok: true, ts: 1 }

function world({ room = {}, mine = {}, globals = {} } = {}) {
  const rig = lawOfferRig({
    viewerPersonalEmotes: m(mine),
    emoteCache: m(globals),
    channelEmoteCaches: { 'chan-a': m(room), 'chan-k': new Map() },
  })
  rig.pools = () => [rig.channelEmoteCaches['chan-a']]
  rig.where = () => [rig.viewerPersonalEmotes, ...rig.pools(), rig.emoteCache]
  rig.fetch = () => TOOK
  rig.kv.set('auth_token', 'x')
  rig.kv.set('user_info', { id: 7 })
  return rig
}
const tab = (rig, typed) => rig.findEmoteMatches(typed).map((x) => `${x.name} ${x.url}`)
const tiles = (rig) => rig.hsFavTiles(rig.where()).map(([n, e]) => `${n} ${e.url} ${e.state}`)

describe('a favorite leads', () => {
  test('Tab: a pinned name that starts with what you typed comes before the room and what you use', () => {
    const rig = world({ room: { PogA: stv('A') }, globals: { PogZ: stv('Z'), Pig: stv('P') } })
    rig.frecency.set('PogA', 9)
    expect(tab(rig, 'Po')[0]).toBe(`PogA ${stv('A').url}`)
    expect(rig.hsToggleFavorite('PogZ', stv('Z'))).toBe('added')
    expect(tab(rig, 'Po').slice(0, 2)).toEqual([`PogZ ${stv('Z').url}`, `PogA ${stv('A').url}`])
    // only where the name starts with it: a favorite never jumps a closer match
    expect(tab(rig, 'og')[0]).toBe(`PogA ${stv('A').url}`)
  })

  test("Tab: a favorite and a name you use lead the room's people, whoever holds them", () => {
    const rig = world({ room: { PogA: stv('A') }, globals: { PogZ: stv('Z'), PogU: stv('U') } })
    rig.people.set('pogfan', 'pogfan')
    const names = () => rig.findEmoteMatches('pog').map((x) => x.name)
    expect(names()).toEqual(['PogA', 'pogfan', 'PogU', 'PogZ'])
    expect(rig.hsToggleFavorite('PogZ', stv('Z'))).toBe('added')
    expect(names()).toEqual(['PogZ', 'PogA', 'pogfan', 'PogU'])
    rig.frecency.set('PogU', 9)
    expect(names()).toEqual(['PogZ', 'PogU', 'PogA', 'pogfan'])
  })

  test('the picker: favorites are the first section, in the order pinned, and gone when empty', () => {
    const rig = world({ room: { PogA: stv('A') }, globals: { PogZ: stv('Z') } })
    expect(rig.hsFavSection(rig.where())).toBe(null)
    rig.hsToggleFavorite('PogZ', stv('Z'))
    rig.hsToggleFavorite('PogA', stv('A'))
    const sec = rig.hsFavSection(rig.where())
    expect(sec.key).toBe('favorite')
    expect(sec.emotes.map(([n]) => n)).toEqual(['PogZ', 'PogA'])
    // the tile is the tab's own entry: its state, its sizes
    expect(sec.emotes[1][1]).toBe(rig.channelEmoteCaches['chan-a'].get('PogA'))
    expect(rig.hsToggleFavorite('PogZ', stv('Z'))).toBe('removed')
    expect(rig.hsFavSection(rig.where()).emotes.map(([n]) => n)).toEqual(['PogA'])
  })

  test('emotes.js asks for the section first and input.js opens the menu with the favorites row', () => {
    const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
    const group = src('emotes.js')
    const at = group.indexOf('function groupEmotes')
    const body = group.slice(at, group.indexOf('\n}\n', at))
    expect(body.indexOf('hsFavSection(')).toBeGreaterThan(body.indexOf('buildRecentSection()'))
    expect(body).toContain('if (fav) sections.unshift(fav)')
    expect(group).toContain('const remote = hsRemoteTile(name, img.dataset.variant)')
    expect(src('input.js')).toContain(
      'const items = hsFavMenuItems({ emoteName, emoteUrl, source, targetEl, wrapper })',
    )
    expect(src('main.js')).toContain('hsInitFavorites()')
  })
})

describe('a favorite is the picture', () => {
  test('the same picture at another size or format is the same favorite, kept at one url', () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    rig.hsToggleFavorite('Wlol', { url: 'https://cdn.7tv.app/emote/W/1x_static.avif', source: '7tv' })
    expect(rig.favorites()).toEqual([{ name: 'Wlol', url: stv('W').url, provider: '7tv', id: 'W' }])
    expect(rig.hsIsFavorite('Wlol', { url: 'https://cdn.7tv.app/emote/W/4x.webp' })).toBe(true)
    expect(rig.hsToggleFavorite('Wlol', { url: 'https://cdn.7tv.app/emote/W/3x.gif' })).toBe('removed')
    expect(rig.favorites()).toEqual([])
  })

  test('one of our own uploads is the same favorite at any rung, and under either host by its hash', () => {
    const rig = world({ mine: { Mine: own('abc') } })
    rig.hsToggleFavorite('Mine', { ...own('abc'), url: 'https://cdn.heatsync.org/uploads/abc-2x.webp' })
    expect(rig.favorites()[0]).toMatchObject({ url: own('abc').url, provider: 'hs', hash: 'abc' })
    expect(rig.hsIsFavorite('Mine', { url: 'https://cdn.heatsync.org/uploads/abc-1x.webp' })).toBe(true)
    expect(rig.hsIsFavorite('Mine', { url: 'https://heatsync.org/uploads/abc.webp', hash: 'abc' })).toBe(true)
    expect(rig.hsIsFavorite('Mine', { url: 'https://heatsync.org/uploads/zzz.webp', hash: 'zzz' })).toBe(false)
  })

  test('another emote of the same name is not the favorite, and never stands in for it', () => {
    const rig = world({ room: { Wlol: stv('ROOM') }, globals: { Wlol: stv('GLOB') } })
    rig.hsToggleFavorite('Wlol', stv('GLOB'))
    expect(rig.hsIsFavorite('Wlol', stv('ROOM'))).toBe(false)
    expect(tiles(rig)).toEqual([`Wlol ${stv('GLOB').url} global`])
    // typing the whole name still sends the room's: a favorite orders the offer, it is not a pick
    expect(tab(rig, 'Wlol')[0]).toBe(`Wlol ${stv('ROOM').url}`)
    expect(rig.lawChip('Wlol').e.url).toBe(stv('ROOM').url)
  })
})

describe('a favorite this tab does not hold', () => {
  test('is drawn from its record, picked like a search result, and offered by Tab as one', () => {
    const rig = world({ globals: { Other: stv('O') } })
    rig.hsFavStorageChanged(
      { emote_favorites: { newValue: [{ name: 'Away', url: stv('AWAY').url, provider: '7tv', id: 'AWAY' }] } },
      'local',
    )
    expect(tiles(rig)).toEqual([`Away ${stv('AWAY').url} remote`])
    const [, tile] = rig.hsFavTiles(rig.where())[0]
    expect(rig.hsRemoteTile('Away', tile.variant)).toEqual({
      url: stv('AWAY').url,
      provider: '7tv',
      id: 'AWAY',
      zeroWidth: false,
    })
    const hit = rig.findEmoteMatches('Aw')[0]
    expect(hit).toMatchObject({ name: 'Away', url: stv('AWAY').url, remote: true })
  })

  test('two away favorites of one name are two tiles, and each tile is its own picture', () => {
    const rig = world()
    const recs = ['ONE', 'TWO'].map((id) => ({ name: 'Twin', url: stv(id).url, provider: '7tv', id }))
    rig.hsFavStorageChanged({ emote_favorites: { newValue: recs } }, 'local')
    const got = rig.hsFavTiles(rig.where()).map(([n, e]) => rig.hsRemoteTile(n, e.variant).id)
    expect(got).toEqual(['ONE', 'TWO'])
    // a tile from an older list means nothing once the list moved under it
    expect(rig.hsRemoteTile('Other', 'fav0')).toBeUndefined()
    expect(rig.hsRemoteTile('Twin', 'fav9')).toBeUndefined()
  })

  test('a search result of that name still resolves through the search index', () => {
    const rig = world()
    rig.remote.set('Found#abc', { url: stv('F').url, provider: '7tv', id: 'abc' })
    expect(rig.hsRemoteTile('Found', 'abc').url).toBe(stv('F').url)
  })

  test("a platform's own emote is shown and offered only where that platform hands it to you", () => {
    const sub = {
      url: 'https://static-cdn.jtvnw.net/emoticons/v2/555/default/dark/2.0',
      source: 'twitch',
      state: 'global',
    }
    const rig = world({ mine: { subPog: sub } })
    rig.hsToggleFavorite('subPog', { ...sub, url: sub.url.replace('/2.0', '/1.0').replace('/default/', '/static/') })
    expect(rig.favorites()[0]).toMatchObject({ provider: 'twitch' })
    expect(tiles(rig)).toEqual([`subPog ${sub.url} global`])
    expect(tab(rig, 'sub')[0]).toBe(`subPog ${sub.url}`)
    // a kick room: twitch does not mark the word there, so it could only go out as text
    rig.legs = { kick: 'chan-k' }
    expect(tab(rig, 'sub').filter((x) => x.startsWith('subPog'))).toEqual([])
    // and on a device that does not hold it at all, no tile
    rig.viewerPersonalEmotes.clear()
    expect(tiles(rig)).toEqual([])
  })
})

describe("the list is the account's", () => {
  test('a pin is kept on this device and sent; the mark clears when the account says it took it', async () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    rig.hsToggleFavorite('Wlol', stv('W'))
    expect(rig.dirty).toBe(1)
    await tick()
    expect(rig.kv.get('emote_favorites')).toEqual([{ name: 'Wlol', url: stv('W').url, provider: '7tv', id: 'W' }])
    expect(rig.kv.get('emote_favorites_owner')).toBe('7')
    expect(rig.calls).toEqual([
      { path: '/api/settings', method: 'PUT', body: { patches: { emoteFavorites: rig.favorites() } } },
    ])
    expect(rig.kv.has('emote_favorites_unsent')).toBe(false)
  })

  test('a server that does not know the setting yet answers ok and stores nothing: the pin stays unsent and goes again', async () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    rig.fetch = () => ({ ok: true })
    rig.hsToggleFavorite('Wlol', stv('W'))
    await tick()
    expect(rig.kv.get('emote_favorites_unsent')).toBe(true)
    rig.calls.length = 0
    rig.fetch = () => TOOK
    await rig.hsLoadFavorites()
    expect(rig.calls.map((c) => c.method)).toEqual(['PUT'])
    expect(rig.kv.has('emote_favorites_unsent')).toBe(false)
    expect(rig.favorites()).toHaveLength(1)
  })

  test('offline: the pin stays, unsent, and the next load sends it instead of taking the older list', async () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    rig.fetch = () => ({ ok: false, error: 'Failed to fetch' })
    rig.hsToggleFavorite('Wlol', stv('W'))
    await tick()
    expect(rig.kv.get('emote_favorites_unsent')).toBe(true)
    rig.fetch = (_p, o) => (o.method === 'PUT' ? TOOK : { ok: true, data: { settings: { emoteFavorites: [] } } })
    await rig.hsLoadFavorites()
    expect(rig.favorites()).toHaveLength(1)
  })

  test("a list the account refuses is dropped for the account's", async () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    const theirs = [{ name: 'Kept', url: stv('K').url, provider: '7tv', id: 'K' }]
    rig.fetch = (_p, o) =>
      o.method === 'PUT'
        ? { ok: false, status: 400, error: 'no' }
        : { ok: true, data: { settings: { emoteFavorites: theirs } } }
    rig.hsToggleFavorite('Wlol', stv('W'))
    await tick()
    await tick()
    expect(rig.favorites()).toEqual(theirs)
    expect(rig.kv.has('emote_favorites_unsent')).toBe(false)
    expect(rig.kv.get('emote_favorites')).toEqual(theirs)
  })

  test("a load takes the account's list, and an account that never had one leaves this device's alone", async () => {
    const rig = world()
    const theirs = [{ name: 'Kept', url: stv('K').url, provider: '7tv', id: 'K' }]
    rig.fetch = () => ({ ok: true, data: { settings: { emoteFavorites: theirs }, updated_at: null } })
    await rig.hsLoadFavorites()
    expect(rig.favorites()).toEqual(theirs)
    expect(rig.kv.get('emote_favorites')).toEqual(theirs)
    rig.fetch = () => ({ ok: true, data: { settings: {} } })
    await rig.hsLoadFavorites()
    expect(rig.favorites()).toEqual(theirs)
    expect(rig.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  test("a list another account left here is dropped and never sent as this account's", async () => {
    const rig = world()
    rig.kv.set('emote_favorites', [{ name: 'Theirs', url: stv('T').url, provider: '7tv', id: 'T' }])
    rig.kv.set('emote_favorites_unsent', true)
    rig.kv.set('emote_favorites_owner', '99')
    rig.fetch = () => ({ ok: true, data: { settings: {} } })
    await rig.hsLoadFavorites()
    expect(rig.favorites()).toEqual([])
    expect(rig.kv.has('emote_favorites')).toBe(false)
    expect(rig.kv.get('emote_favorites_owner')).toBe('7')
    expect(rig.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  test('an unsent change waits until this device knows who is signed in', async () => {
    const rig = world()
    rig.kv.delete('user_info')
    rig.kv.set('emote_favorites', [{ name: 'Mine', url: stv('M').url, provider: '7tv', id: 'M' }])
    rig.kv.set('emote_favorites_unsent', true)
    await rig.hsLoadFavorites()
    expect(rig.calls).toEqual([])
    expect(rig.favorites()).toHaveLength(1)
    // the person arrives: the load runs again, and it is theirs to send
    rig.kv.set('user_info', { id: 7 })
    rig.kv.set('emote_favorites_owner', '7')
    rig.hsFavStorageChanged({ user_info: { newValue: { id: 7 } } }, 'local')
    await tick()
    await tick()
    expect(rig.calls.map((c) => c.method)).toEqual(['PUT'])
  })

  test('signed out there is no list: nothing shown, nothing pinned, no menu row, nothing asked', async () => {
    const rig = world({ globals: { Wlol: stv('W') } })
    rig.kv.set('emote_favorites', [{ name: 'Wlol', url: stv('W').url, provider: '7tv', id: 'W' }])
    rig.kv.delete('auth_token')
    rig.sign(false)
    await rig.hsLoadFavorites()
    expect(rig.favorites()).toEqual([])
    expect(rig.hsToggleFavorite('Wlol', stv('W'))).toBe(null)
    expect(
      rig.hsFavMenuItems({ emoteName: 'Wlol', emoteUrl: stv('W').url, source: '7tv', wrapper: { dataset: {} } }),
    ).toEqual([])
    expect(rig.calls).toEqual([])
  })

  test('a pin made on the site or another device lands here: the stored list changing is the list changing', () => {
    const rig = world()
    rig.hsFavStorageChanged(
      { emote_favorites: { newValue: [{ name: 'Far', url: stv('F').url, provider: '7tv' }] } },
      'local',
    )
    expect(rig.favorites().map((f) => f.name)).toEqual(['Far'])
    expect(rig.dirty).toBe(1)
    // the same list again redraws nothing; another storage area is not ours
    rig.hsFavStorageChanged(
      { emote_favorites: { newValue: [{ name: 'Far', url: stv('F').url, provider: '7tv' }] } },
      'local',
    )
    rig.hsFavStorageChanged({ emote_favorites: { newValue: [] } }, 'sync')
    expect(rig.dirty).toBe(1)
    // signing out wipes the store: the list goes with it
    rig.hsFavStorageChanged({ emote_favorites: { oldValue: [] } }, 'local')
    expect(rig.favorites()).toEqual([])
  })
})

describe('what is kept is bounded and never trusted', () => {
  test('the 33rd pin is refused and changes nothing', async () => {
    const rig = world()
    for (let i = 0; i < 32; i++) expect(rig.hsToggleFavorite(`E${i}`, stv(`ID${i}`))).toBe('added')
    await tick()
    rig.calls.length = 0
    expect(rig.hsToggleFavorite('Over', stv('OVER'))).toBe('full')
    expect(rig.favorites()).toHaveLength(32)
    await tick()
    expect(rig.calls).toEqual([])
    const items = rig.hsFavMenuItems({
      emoteName: 'Over',
      emoteUrl: stv('OVER').url,
      source: '7tv',
      wrapper: { dataset: {} },
    })
    items[0].fn()
    expect(rig.toasts).toEqual(['mc_fav_full'])
  })

  test('a stored list is cleaned: junk dropped, unknown providers ours, extra fields gone, 32 at most', () => {
    const rig = world()
    const good = {
      name: 'Ok',
      url: stv('OK').url,
      provider: '7tv',
      id: 'OK',
      zeroWidth: true,
      animated: false,
      width: 99,
    }
    const out = rig.hsFavClean([
      good,
      null,
      'x',
      { name: '', url: stv('A').url },
      { name: 'NoPic' },
      { name: 'Http', url: 'http://cdn.7tv.app/emote/A/2x.webp' },
      { name: 'Js', url: 'javascript:alert(1)' },
      { name: 'Odd', url: stv('ODD').url, provider: 'evil', zeroWidth: 1, id: 7 },
    ])
    expect(out).toEqual([
      { name: 'Ok', url: stv('OK').url, provider: '7tv', id: 'OK', zeroWidth: true, animated: false },
      { name: 'Odd', url: stv('ODD').url, provider: 'hs' },
    ])
    expect(rig.hsFavClean('nope')).toEqual([])
    expect(rig.hsFavClean(Array.from({ length: 40 }, (_, i) => ({ name: `N${i}`, url: stv(i).url })))).toHaveLength(32)
  })
})

describe('the menu row', () => {
  test("a picker tile's sized url pins the tab's real entry; pinned, the row unpins", () => {
    const real = stv('W', { animated: true })
    const rig = world({ room: { Wlol: real } })
    const info = {
      emoteName: 'Wlol',
      emoteUrl: 'https://cdn.7tv.app/emote/W/1x_static.avif',
      source: '7tv',
      wrapper: null,
    }
    const add = rig.hsFavMenuItems(info)
    expect(add.map((x) => x.label || x)).toEqual(['mc_fav_add', 'sep'])
    add[0].fn()
    expect(rig.favorites()).toEqual([{ name: 'Wlol', url: real.url, provider: '7tv', id: 'W', animated: true }])
    const del = rig.hsFavMenuItems(info)
    expect(del[0].label).toBe('mc_fav_remove')
    del[0].fn()
    expect(rig.favorites()).toEqual([])
  })

  test('an emote on a chat row no map here holds is pinned from the row; a bare image with no row is not', () => {
    const rig = world()
    const row = {
      emoteName: 'Seen',
      emoteUrl: stv('SEEN').url,
      source: '7tv',
      wrapper: { dataset: { emoteHash: 'hh' } },
    }
    rig.hsFavMenuItems(row)[0].fn()
    expect(rig.favorites()).toEqual([{ name: 'Seen', url: stv('SEEN').url, provider: '7tv', id: 'SEEN', hash: 'hh' }])
    expect(rig.hsFavMenuItems({ emoteName: 'Bare', emoteUrl: stv('B').url, source: '7tv', wrapper: null })).toEqual([])
  })

  test('an away favorite is unpinned from its own tile', () => {
    const rig = world()
    rig.hsFavStorageChanged(
      { emote_favorites: { newValue: [{ name: 'Away', url: stv('AWAY').url, provider: '7tv', id: 'AWAY' }] } },
      'local',
    )
    const [, tile] = rig.hsFavTiles(rig.where())[0]
    const img = { dataset: { state: 'remote', variant: tile.variant } }
    const targetEl = { closest: () => ({ querySelector: () => img }) }
    const items = rig.hsFavMenuItems({ emoteName: 'Away', emoteUrl: tile.url, source: '7tv', wrapper: null, targetEl })
    expect(items[0].label).toBe('mc_fav_remove')
    items[0].fn()
    expect(rig.favorites()).toEqual([])
  })
})

describe('the background', () => {
  const WS = readFileSync(join(import.meta.dir, '..', 'src', 'background', '05-ws.js'), 'utf8')
  const at = WS.indexOf("case 'site-settings:patch': {")
  const body = WS.slice(at + "case 'site-settings:patch': {".length, WS.indexOf('break', at))
  const run = async (msg, kv) => {
    const local = {
      get: async (k) => (kv.has(k) ? { [k]: kv.get(k) } : {}),
      set: async (o) => {
        for (const [k, v] of Object.entries(o)) kv.set(k, v)
      },
    }
    new Function('msg', 'browser', body)(msg, { storage: { local } })
    await tick()
  }

  test("the account's change lands in the overlay's store; any other site setting is not the extension's", async () => {
    expect(at).toBeGreaterThan(-1)
    const kv = new Map()
    await run({ type: 'site-settings:patch', patches: { emoteFavorites: [{ name: 'A' }], theme: 'x' } }, kv)
    expect([...kv]).toEqual([['emote_favorites', [{ name: 'A' }]]])
    await run({ type: 'site-settings:patch', patches: { theme: 'y', emoteFavorites: 'junk' } }, kv)
    await run({ type: 'site-settings:patch' }, kv)
    expect([...kv]).toEqual([['emote_favorites', [{ name: 'A' }]]])
  })

  test('a change this device has not sent yet is not overwritten', async () => {
    const kv = new Map([
      ['emote_favorites', [{ name: 'Mine' }]],
      ['emote_favorites_unsent', true],
    ])
    await run({ patches: { emoteFavorites: [] } }, kv)
    expect(kv.get('emote_favorites')).toEqual([{ name: 'Mine' }])
  })

  test('signing out wipes the list with the rest of the account', () => {
    const auth = readFileSync(join(import.meta.dir, '..', 'src', 'background', '02-auth-live.js'), 'utf8')
    const wipe = auth.slice(auth.indexOf('Auth cookie removed'), auth.indexOf("type: 'auth_changed', loggedIn: false"))
    for (const k of ['emote_favorites', 'emote_favorites_unsent', 'emote_favorites_owner'])
      expect(wipe).toContain(`'${k}'`)
  })
})
