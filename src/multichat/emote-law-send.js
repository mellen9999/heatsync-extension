// The overlay's end of the law's SEND (docs/emote-law-map.md, shared/emote-law.ts): what a line
// ships. The law reads { key, name, provider, id } emotes, the overlay's maps hold { url, source,
// hash } entries, so a send normalizes what it needs once (a send is rare; a row is not): the
// room of each leg, your own sets, the globals and the box's picks.

const LAW_KICK_ID = /files\.kick\.com\/emotes\/(\d+)\//
const LAW_PROVIDER = { heatsync: 'hs', inventory: 'hs' }

/** an overlay entry as the law's emote (the picture is `provider:id`) */
function lawEmote(name, e) {
  const provider = e.provider || LAW_PROVIDER[e.source] || e.source || 'hs'
  const id = String(e.id || (provider === 'kick' && LAW_KICK_ID.exec(e.url || '')?.[1]) || e.hash || e.url || name)
  return { ...e, key: `${provider}:${id}`, name: e.name || name, provider, id }
}

function lawIndex(map, only) {
  const out = new Map()
  for (const [n, e] of map || []) if (e && (!only || only(e))) out.set(n, lawEmote(n, e))
  return out
}

/**
 * Everything a send reads against.
 * @param {object} p
 * @param {{twitch?:string,kick?:string,youtube?:string}} p.legs the cache key of each platform this send reaches, in send order
 * @param {Map} p.mine        your own set (inventory + the platform emotes you can use)
 * @param {Map} p.globals
 * @param {object} p.caches   channel caches by key
 * @param {{picked:Map,remote:Map}|null} p.picks this box's picks
 */
function lawSendCtx({ legs, mine, globals, caches, picks }) {
  const inventory = lawIndex(mine, (e) => e.source !== 'twitch' && e.source !== 'kick')
  const native = {
    twitch: lawIndex(mine, (e) => e.source === 'twitch'),
    kick: lawIndex(mine, (e) => e.source === 'kick'),
  }
  const rooms = []
  for (const platform of ['twitch', 'kick', 'youtube']) {
    const key = legs[platform]
    if (key) rooms.push({ platform, channel: key, loaded: !!caches[key], names: lawIndex(caches[key]) })
  }
  const held = picks ? new Map([...picks.remote, ...picks.picked]) : null
  return {
    room: rooms[0] || null,
    legs: rooms,
    own: { inventory, personal: new Map(), native },
    globals: lawIndex(globals),
    picks: held?.size ? lawIndex(held) : null,
    fold: false,
  }
}

/**
 * What a chat line ships, from the law: the text each leg receives and the refs that travel with
 * it. `legs` names the cache key of each platform reached; `box` is the input the line was typed in.
 * @returns {{wire:object, refs:object|undefined}}
 */
function lawShip(text, legs, box) {
  const ctx = lawSendCtx({
    legs,
    mine: viewerPersonalEmotes,
    globals: emoteCache,
    caches: channelEmoteCaches,
    picks: draftPicks(box),
  })
  const sent = hsEmoteLaw.sendLine(text, ctx)
  // a name can be anything, __proto__ included: file a ref by definition, never by `=`
  let refs
  for (const k in sent.refs) {
    refs ||= {}
    Object.defineProperty(refs, k, { value: refOf(sent.refs[k]), enumerable: true, writable: true, configurable: true })
  }
  return { wire: sent.wire, refs }
}
