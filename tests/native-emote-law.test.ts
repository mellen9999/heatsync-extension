/**
 * The native page (twitch's and kick's own chat, overlay off) answers "which emote is this word"
 * with src/content/native-emote-law.js: plain tiered lookups, no law bundle in the content script.
 * This is the proof it is the law's answer and not a second rule: the law itself
 * (shared/emote-law.ts) is asked the same question over hundreds of generated rooms, and any word
 * the two answer differently fails here with its seed.
 *
 * What the native page cannot do is named at the bottom, each with a test that pins it.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Emote, type OwnSets, readWord, type Room, sendLine } from '../shared/emote-law'
import {
  hsNativeAnnounce,
  hsNativeReadTiers,
  hsPersonalOf,
  hsPicksOf,
  hsTieredEmotes,
  hsTrackPicks,
} from '../src/content/native-emote-law.js'
import { buildWorld, generate, randomText, rng } from './helpers/emote-world'

const SEEDS = 400
// the rooms a native page is: twitch's chat and kick's
const NATIVE_ROOMS = ['twitch:a', 'twitch:b', 'kick:x']

type Native = Emote & { hash: string; personal?: boolean }
/** the page's shape of an emote: its picture is its hash */
const shaped = new WeakMap<Emote, Native>()
const nat = (e: Emote): Native => {
  let n = shaped.get(e)
  if (!n) shaped.set(e, (n = { ...e, hash: e.key }))
  return n
}
const tier = (idx: ReadonlyMap<string, Emote>) => new Map([...idx].map(([n, e]) => [n, nat(e)]))
/** a sender's set as the background hands it over: one map, the personal half flagged, their heatsync emote over a personal one of its name */
const merged = (who: OwnSets) => {
  const out = new Map<string, Native>()
  for (const [n, e] of who.personal) out.set(n, { ...nat(e), personal: true })
  for (const [n, e] of who.inventory) out.set(n, nat(e))
  return out
}
/** the page's row read: the literal word through every tier, then the overlay reading (content.js replaceEmotesWithStacking) */
const rowWord = (tiers: { get(n: string): Native | undefined }, word: string) => {
  const lit = tiers.get(word)
  if (lit) return { key: lit.key, overlay: !!lit.zeroWidth }
  const base = word.length > 1 && word.endsWith('0') ? tiers.get(word.slice(0, -1)) : undefined
  return base ? { key: base.key, overlay: true } : null
}
/** a few of this person's own emotes, picked on purpose */
const somePicks = (who: OwnSets, rand: () => number) => {
  const picks = new Map<string, Emote>()
  for (const [n, e] of who.inventory) if (rand() < 0.3) picks.set(n, e)
  return picks
}
const words = (text: string) => text.split(/\s+/).filter(Boolean)

test("a native row draws the law's emote for every word: someone else's line and your own", () => {
  let asked = 0
  let drawn = 0
  const from: Record<string, number> = {}
  for (let seed = 0; seed < SEEDS; seed++) {
    const g = generate(seed)
    const w = buildWorld(g.emotes, g.world, rng(seed))
    const rand = rng(seed ^ 0x9e3779b9)
    const globals = tier(w.globals)
    for (const id of NATIVE_ROOMS) {
      const room = w.room(id) as Room
      const names = tier(room.names)
      for (const who of ['other', 'me'] as const) {
        const person = w.person(who) as OwnSets
        // a set where one name is both personal and their heatsync emote is the named gap below
        const own: OwnSets = {
          inventory: new Map([...person.inventory].filter(([n]) => !person.personal.has(n))),
          personal: person.personal,
          native: {},
        }
        const picks = somePicks(own, rand)
        const refs = Object.fromEntries(picks)
        const set = merged(own)
        const tiers =
          who === 'me'
            ? hsNativeReadTiers({ picks: tier(picks), sender: set, room: names, own: tier(own.inventory), globals })
            : hsNativeReadTiers({ picks: tier(picks), sender: set, room: names, globals })
        for (let i = 0; i < 4; i++) {
          for (const word of words(randomText(rand))) {
            const law = readWord(word, { room, refs, sender: own, globals: w.globals })
            const page = rowWord(tiers, word)
            asked++
            const want = law?.emote ? { key: law.emote.key, overlay: law.overlay } : null
            if (JSON.stringify(page) !== JSON.stringify(want)) {
              throw new Error(`seed ${seed} room ${id} ${who} word ${word}: page ${JSON.stringify(page)} law ${JSON.stringify(want)} (${law?.from})`)
            }
            if (law) {
              drawn++
              from[law.from] = (from[law.from] || 0) + 1
            }
          }
        }
      }
    }
  }
  // the worlds reach every tier, or this proves nothing
  expect(asked).toBeGreaterThan(20000)
  expect(drawn).toBeGreaterThan(5000)
  for (const t of ['pick', 'personal', 'room', 'sender', 'global']) expect(from[t] ?? 0).toBeGreaterThan(100)
})

test('a native send tells the room exactly what the law ships that a reader cannot work out', () => {
  let lines = 0
  let told = 0
  let silent = 0
  for (let seed = 0; seed < SEEDS; seed++) {
    const g = generate(seed)
    const w = buildWorld(g.emotes, g.world, rng(seed))
    const rand = rng(seed ^ 0x51ed270b)
    const globals = tier(w.globals)
    const me = w.person('me') as OwnSets
    for (const id of NATIVE_ROOMS) {
      const room = w.room(id) as Room
      // the site's own box sends plain words: on kick nothing typed is kick-marked, so the law is
      // asked as a sender with no kick emotes of their own (the room's are in the room)
      const own: OwnSets = {
        inventory: new Map([...me.inventory].filter(([n]) => !me.personal.has(n))),
        personal: me.personal,
        native: room.platform === 'twitch' ? { twitch: me.native.twitch } : {},
      }
      const inventory = tier(own.inventory)
      for (let i = 0; i < 4; i++) {
        const text = randomText(rand)
        const picks = somePicks(own, rand)
        // the picker's notes for this draft: every pick, by picture
        const noted = new Map([...picks].map(([n, e]) => [n, { hash: e.key, seen: true }]))
        const shipped = sendLine(text, { room, own, globals: w.globals, picks }).refs
        // of what the law ships, a reader lacks only your own emotes (a pick is one of them)
        const want: Record<string, string> = {}
        for (const [k, r] of Object.entries(shipped)) {
          const e = r as Emote
          if (own.inventory.get(k) === e) want[k] = e.key
        }
        const got: Record<string, string> = {}
        for (const { name, emote } of hsNativeAnnounce(text, {
          native: room.platform === 'twitch' ? (own.native.twitch ?? null) : null,
          picks: hsPicksOf(noted, text, inventory),
          personal: hsPersonalOf(merged(own)),
          room: tier(room.names),
          inventory,
          globals,
        })) {
          got[name] = (emote as Native).key
        }
        lines++
        if (Object.keys(want).length) told++
        else silent++
        if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want).sort())) {
          throw new Error(`seed ${seed} room ${id} line "${text}": page ${JSON.stringify(got)} law ${JSON.stringify(want)}`)
        }
      }
    }
  }
  expect(lines).toBe(SEEDS * NATIVE_ROOMS.length * 4)
  expect(told).toBeGreaterThan(500)
  expect(silent).toBeGreaterThan(500)
})

// ── the bug this replaced, as cases ──────────────────────────────────────────

const e = (name: string, hash: string, more: object = {}) => ({ name, hash, url: `https://x/${hash}`, ...more })
const map = (...list: ReturnType<typeof e>[]) => new Map(list.map((x) => [x.name, x]))

test("a hand-typed word the channel has is the channel's: your saved copy of the name is not announced", () => {
  const room = map(e('KEKW', 'room'))
  const inventory = map(e('KEKW', 'mine'), e('Solo', 'solo'))
  const told = hsNativeAnnounce('KEKW Solo hi KEKW', { native: null, picks: null, room, inventory, globals: map() })
  expect(told).toEqual([{ name: 'Solo', emote: inventory.get('Solo') }])
})

test('picked on purpose, your copy is announced; the same picture as the channel says nothing', () => {
  const room = map(e('KEKW', 'room'), e('Same', 'same'))
  const inventory = map(e('KEKW', 'mine'), e('Same', 'same'))
  const noted = new Map([
    ['KEKW', { hash: 'mine', seen: true }],
    ['Same', { hash: 'same', seen: true }],
  ])
  const picks = hsPicksOf(noted, 'KEKW Same', inventory)
  expect(hsNativeAnnounce('KEKW Same', { native: null, picks, room, inventory, globals: map() })).toEqual([
    { name: 'KEKW', emote: inventory.get('KEKW') },
  ])
})

test("a pick of the channel's own tile, or of an emote you no longer hold, is no pick", () => {
  const inventory = map(e('KEKW', 'mine'))
  expect(hsPicksOf(new Map([['KEKW', { hash: 'room', seen: true }]]), 'KEKW', inventory)).toBeNull()
  expect(hsPicksOf(new Map([['Gone', { hash: 'gone', seen: true }]]), 'Gone', inventory)).toBeNull()
  // and a pick whose word is not in the line that leaves
  expect(hsPicksOf(new Map([['KEKW', { hash: 'mine', seen: true }]]), 'hello', inventory)).toBeNull()
})

test('a pick ends when its word leaves the box, never before the paste has landed', () => {
  const picks = new Map([['KEKW', { hash: 'mine', seen: false }]])
  // the note is taken before the paste: an edit that does not hold the word yet ends nothing
  hsTrackPicks(picks, 'hello')
  expect(picks.has('KEKW')).toBe(true)
  hsTrackPicks(picks, 'hello KEKW ')
  expect(picks.get('KEKW')?.seen).toBe(true)
  // as an overlay it is still the pick's word
  hsTrackPicks(picks, 'hello KEKW0')
  expect(picks.has('KEKW')).toBe(true)
  hsTrackPicks(picks, 'hello KEK')
  expect(picks.has('KEKW')).toBe(false)
  // typed again by hand: a hand-typed word
  hsTrackPicks(picks, 'hello KEKW')
  expect(picks.size).toBe(0)
})

test("twitch marks its own emote on the exact word only: Kappa is twitch's, Kappa0 is your overlay", () => {
  const inventory = map(e('Kappa', 'mine'))
  const ctx = { native: new Set(['Kappa']), picks: null, room: map(), inventory, globals: map() }
  expect(hsNativeAnnounce('Kappa', ctx)).toEqual([])
  expect(hsNativeAnnounce('Kappa Kappa0', ctx)).toEqual([{ name: 'Kappa', emote: inventory.get('Kappa') }])
})

test("someone else's saved emote draws only where the channel has none of that name", () => {
  const sender = map(e('KEKW', 'theirs'), e('Solo', 'solo'), e('Paid', 'paid', { personal: true }))
  const room = map(e('KEKW', 'room'), e('Paid', 'roompaid'))
  const tiers = hsNativeReadTiers({ picks: null, sender, room, globals: map(e('Solo', 'global')) })
  expect(tiers.get('KEKW')?.hash).toBe('room')
  expect(tiers.get('Solo')?.hash).toBe('solo')
  // their 7tv personal emote is above the room, as in 7tv's own apps
  expect(tiers.get('Paid')?.hash).toBe('paid')
  // and what their app announced for the line is above everything
  const picked = hsNativeReadTiers({ picks: map(e('KEKW', 'theirs')), sender, room, globals: map() })
  expect(picked.get('KEKW')?.hash).toBe('theirs')
})

test('tiers: the first that holds the name answers, an absent tier is skipped', () => {
  const t = hsTieredEmotes([null, map(e('A', '1')), undefined, map(e('A', '2'), e('B', '3'))])
  expect(t.get('A')?.hash).toBe('1')
  expect(t.get('B')?.hash).toBe('3')
  expect(t.has('C')).toBe(false)
  expect(t.size).toBe(3)
})

// ── wiring: content.js reads and sends through the module ───────────────────

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const BTN = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'heatsync-button.js'), 'utf8')
const BUILD = readFileSync(join(import.meta.dir, '..', 'build.js'), 'utf8')

test('content.js rows and sends go through the module, and it is built into the bundle', () => {
  expect(BUILD).toContain("'content/native-emote-law.js',")
  // every row that is not one of the two ready maps reads the law's tiers
  expect(SRC.match(/hsNativeReadTiers\(\{/g)?.length).toBe(2)
  expect(SRC).toContain('const told = hsNativeAnnounce(message, {')
  // the old send: one announce per saved emote whose name is anywhere in the line
  expect(SRC).not.toContain('emoteInventory.forEach((emote) => {\n            const regex = createEmoteRegex(emote.name)')
  expect(SRC.match(/type: 'emote_sent'/g)?.length).toBe(1)
  // the viewer's saved emotes are in no map another sender's row reads
  expect(SRC).toContain('cachedNonInventoryEmotes = new Map([...cachedGlobalEmotes, ...cachedRoomEmotes])')
  expect(SRC).toContain(
    'cachedOwnEmotes = new Map([...cachedGlobalEmotes, ...cachedInventoryEmotes, ...cachedRoomEmotes])',
  )
})

test("the streamer's own heatsync emotes are in the room (they were skipped: no `source`)", () => {
  const i = SRC.indexOf("rankEmotePool(channelEmotes, 'channel').forEach((emote) => {")
  expect(i).toBeGreaterThan(0)
  expect(SRC.slice(i, i + 400)).not.toContain('if (!emote.source) return')
})

test('every picker tile that pastes an emote notes the pick first', () => {
  // the paste itself takes the note, so no tile can paste without one
  expect(BTN).toContain('function insertEmoteIntoChat(emoteName, hash) {\n      window.__hsNativePick?.(emoteName, hash)')
  // emoji are not emotes: `:name:` pastes with no picture, which is no pick
  const calls = (BTN.match(/insertEmoteIntoChat\([^)]*\)/g) || []).filter((c) => !c.includes('emoteName'))
  expect(calls.sort()).toEqual([
    'insertEmoteIntoChat(`:${e.name}:`)',
    'insertEmoteIntoChat(e.name, e.hash)',
    'insertEmoteIntoChat(e.name, e.hash)',
    'insertEmoteIntoChat(e.name, e.hash)',
    'insertEmoteIntoChat(emote.name, emote.hash)',
  ])
  expect(SRC).toContain('window.__hsNativePick = (name, hash) => {')
})

// ── what the native page cannot do, named ───────────────────────────────────

test('named gap: one name in both a sender\'s personal set and their heatsync emotes reads as their heatsync emote', () => {
  // the background merges the two into one map and their heatsync emote takes the name
  // (src/background/07-handle-message.js get_sender_emotes), so the personal one is not there to
  // read. The law: personal, above the room. Here: theirs, below the room.
  const own = { personal: map(e('KEKW', 'paid')), inventory: map(e('KEKW', 'saved')) }
  const set = new Map<string, object>()
  for (const [n, x] of own.personal) set.set(n, { ...x, personal: true })
  for (const [n, x] of own.inventory) set.set(n, x)
  const tiers = hsNativeReadTiers({ picks: null, sender: set, room: map(e('KEKW', 'room')), globals: map() })
  expect(tiers.get('KEKW')?.hash).toBe('room')
})

test('named gap: the case setting and take-downs are not read on native rows', () => {
  // case is exact here whatever the setting (the overlay reads it); a withdrawn pick has no
  // message to arrive in: the room is told a name and a picture, never "gone"
  const tiers = hsNativeReadTiers({ picks: null, sender: null, room: map(e('KEKW', 'room')), globals: map() })
  expect(tiers.get('kekw')).toBeUndefined()
})
