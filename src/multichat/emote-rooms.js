// Each platform's own emote list inside a channel set, and the room a row of that platform reads
// (emote law, read 3: the row's own room). A twitch channel and a kick channel of one name share
// one set in channelEmoteCaches, because every consumer reads the bare name; the lists are kept
// beside it, keyed by the set itself, so a youtube alias (the same Map under a second key) and an
// eviction need no second bookkeeping. Concatenated into the multichat bundle (build.js).

const CHANNEL_LEGS = new WeakMap()
const CHANNEL_PLATFORMS = ['twitch', 'kick', 'youtube']

/** the platform a list is filed under; null for one a set does not split by */
function channelLeg(platform) {
  const p = platform === 'yt' ? 'youtube' : platform
  return CHANNEL_PLATFORMS.includes(p) ? p : null
}

/**
 * What a row of `platform` reads in a channel set. This is what keeps a kick row from drawing the
 * twitch channel's emote of a shared name, or a name only the other platform has. A platform whose
 * list has not landed reads nothing of the other's: its row draws when its own list arrives. No
 * platform named, or a set with no per-platform lists (the page scan's, a fixture): the set is one
 * room.
 * @param {Map|null|undefined} set a channelEmoteCaches entry
 * @param {string} [platform] twitch | kick | youtube (yt)
 * @returns {Map|null}
 */
function channelRoomNames(set, platform) {
  if (!set) return null
  const legs = CHANNEL_LEGS.get(set)
  const p = channelLeg(platform)
  if (!legs || !p) return set
  return legs.rooms[p] || legs.held.scan
}

/**
 * File a platform's whole list and re-read the set from its lists, in place (callers hold the
 * Map): twitch's names, then kick's, then youtube's, then what the page scan found.
 * @param {Map} set
 * @param {string} platform a channelLeg() answer
 * @param {Map} list name -> entry
 */
function channelLegPut(set, platform, list) {
  let legs = CHANNEL_LEGS.get(set)
  if (!legs) {
    // whatever is already here came from the page scan: it stays, under every platform's list
    legs = { held: { scan: new Map(set) }, rooms: {} }
    CHANNEL_LEGS.set(set, legs)
  }
  legs.held[platform] = list
  set.clear()
  legs.rooms = {}
  for (const p of CHANNEL_PLATFORMS) {
    const own = legs.held[p]
    if (!own) continue
    const room = new Map(own)
    for (const [n, e] of legs.held.scan) if (!room.has(n)) room.set(n, e)
    legs.rooms[p] = room
    for (const [n, e] of own) if (!set.has(n)) set.set(n, e)
  }
  for (const [n, e] of legs.held.scan) if (!set.has(n)) set.set(n, e)
}

/** an emote the page scan found: the set's, under every platform's own list */
function channelScanPut(set, name, entry) {
  set.set(name, entry)
  const legs = CHANNEL_LEGS.get(set)
  if (!legs) return
  legs.held.scan.set(name, entry)
  for (const p in legs.rooms) if (!legs.rooms[p].has(name)) legs.rooms[p].set(name, entry)
}
