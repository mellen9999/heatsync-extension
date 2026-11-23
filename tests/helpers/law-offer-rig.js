// emote-law-send.js + emote-law-offer.js as the bundle runs them, over maps a test owns: what Tab,
// the `:` list and the Tab list offer (findEmoteMatches) for the open tab's room.
// `rig.legs` is the room of each platform the open tab sends to; everything else a test may set is
// a plain field: frecency (name -> score), settings, blocked (name, entry) -> bool, people
// (lowercase name -> display), recency (lowercase name -> rank), usernames, emoji.
// `usage: true` runs the real usage store (emote-law-usage.js) over `rig.store`, a stand-in for the
// page's localStorage, in place of the frecency field: a send (rig.send) is then what Tab reads.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftPicks, endDraftPicks, pinPickedEmote, refOf } from '../../src/lib/emote-refs.js'
import { normalizeEmoteRefsForSend } from '../../src/lib/emote-refs-normalize.js'

const dir = join(import.meta.dir, '..', '..', 'src', 'multichat')
// the shipped picture-identity helper (…/emote/<id>/1x.avif and …/emote/<id>/2x.webp are one emote)
const INPUT = readFileSync(join(dir, 'input.js'), 'utf8')
const PIC = INPUT.slice(INPUT.indexOf('const _AC_PIC_RE ='), INPUT.indexOf('let _acRemoteToken = 0'))
const _acPicKey = new Function(`${PIC}; return _acPicKey`)()
const SRC = `${readFileSync(join(dir, 'emote-law-send.js'), 'utf8')}\n${readFileSync(join(dir, 'emote-law-offer.js'), 'utf8')}`
const USAGE = readFileSync(join(dir, 'emote-law-usage.js'), 'utf8')

export function lawOfferRig({
  viewerPersonalEmotes = new Map(),
  emoteCache = new Map(),
  channelEmoteCaches = {},
  usage = false,
} = {}) {
  const rig = {
    legs: { twitch: 'chan-a' },
    box: {},
    frecency: new Map(),
    settings: {},
    blocked: () => false,
    people: new Map(),
    recency: new Map(),
    store: new Map(),
    usernames: new Set(),
    emoji: [],
    viewerPersonalEmotes,
    emoteCache,
    channelEmoteCaches,
  }
  const scope = {
    hsEmoteLaw: globalThis.hsEmoteLaw,
    viewerPersonalEmotes,
    emoteCache,
    channelEmoteCaches,
    channelRoomNames: globalThis.channelRoomNames,
    draftPicks,
    pinPickedEmote,
    refOf,
    normalizeEmoteRefsForSend,
    document: { getElementById: () => rig.box },
    ...(usage
      ? {
          localStorage: {
            getItem: (k) => rig.store.get(k) ?? null,
            setItem: (k, v) => void rig.store.set(k, String(v)),
          },
        }
      : { loadEmoteFrecency: () => rig.frecency }),
    getSetting: (k) => rig.settings[k],
    _hsAcEmoteBlocked: (n, e) => rig.blocked(n, e),
    _acPicKey,
    getRecencyMap: () => rig.recency,
    _ucDisplay: rig.people,
    _isBlockedAnyPlat: () => false,
    usernameCache: rig.usernames,
    knownColors: new Map(),
    _hsUserColorCache: new Map(),
    hsPrefetchUserColors: () => {},
    hsModClassify: (w) => ({ kind: /^[a-z]!$/.test(w) ? 'modifier' : 'emote' }),
    EMOJI_DATA: rig.emoji,
  }
  const names = Object.keys(scope)
  const api = new Function(
    ...names,
    'rig',
    `${SRC}\n${usage ? USAGE : ''}\nlawOpenLegs = () => rig.legs\nreturn { findEmoteMatches, lawCatalogEmote, lawPickerSearch, lawChip, lawPin, lawBox, lawShip${usage ? ', lawNoteSent, lawRecentTiles, loadRecentEmotes, loadEmoteFrecency' : ''} }`,
  )(...names.map((k) => scope[k]), rig)
  // a line leaves the composer: shipped against the open tab's rooms, its emotes noted, the box cleared
  rig.send = (text) => {
    const shipped = api.lawShip(text, rig.legs, rig.box)
    api.lawNoteSent(shipped.used)
    endDraftPicks(rig.box)
    return shipped
  }
  rig.reset = () => {
    endDraftPicks(rig.box)
    rig.legs = { twitch: 'chan-a' }
  }
  return Object.assign(rig, api)
}
