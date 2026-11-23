// The overlay's end of the law's SEND (docs/emote-law-map.md, shared/emote-law.ts): what a line
// ships. The law reads { key, name, provider, id } emotes, the overlay's maps hold { url, source,
// hash } entries, so a send normalizes what it needs once (a send is rare; a row is not): the
// room of each leg, your own sets, the globals and the box's picks.

const LAW_KICK_ID = /files\.kick\.com\/emotes\/(\d+)\//
const LAW_PROVIDER = { heatsync: 'hs', inventory: 'hs' }

/**
 * an overlay entry as the law's emote (the picture is `provider:id`). `raw` is the overlay's own
 * entry, so what the composer draws is the very object the caches hold (its state, its variants).
 */
function lawEmote(name, e) {
  const p = e.provider || e.source
  const provider = LAW_PROVIDER[p] || p || 'hs'
  const id = String(e.id || (provider === 'kick' && LAW_KICK_ID.exec(e.url || '')?.[1]) || e.hash || e.url || name)
  return { ...e, key: `${provider}:${id}`, name: e.name || name, provider, id, raw: e }
}

const LAW_NO_NAMES = new Map()
const LAW_ALL = new WeakMap()
/**
 * One of the overlay's maps as the law's emotes, for the walks an offer makes. Built once and kept
 * until the map really changes: same size and every name still holding the very entry it held. A
 * picture swapped under an old name is a change, and Tab pins the picture it shows, so a kept list
 * that missed the swap would ship the old one.
 */
function lawAll(map) {
  let c = LAW_ALL.get(map)
  let same = c?.size === map.size
  if (same) {
    for (const e of c.list) {
      if (map.get(e.name) !== e.raw) {
        same = false
        break
      }
    }
  }
  if (!same) {
    const list = []
    const byKey = new Map()
    for (const [n, raw] of map) {
      const e = lawEmote(n, raw)
      e.name = n
      // an offer's row is the word and the picture: one picture a second set files under another
      // name is its own row, the same word and picture in two sets is one
      e.key = `${e.key}\n${n}`
      list.push(e)
      byKey.set(e.key, e)
    }
    c = { size: map.size, list, byKey }
    LAW_ALL.set(map, c)
  }
  return c
}

/**
 * A name -> law-emote view over one of the overlay's maps. Nothing is copied: a lookup reads the
 * live map, so a set that changed a moment ago (an add, a swap, a 7tv event) is already the answer,
 * and asking per typed word costs one `get`. A send only calls `get` and reads `size`; an offer
 * walks `values()` and asks `at(key)` for the entry behind a picture.
 */
function lawView(map, only) {
  if (!map?.size) return LAW_NO_NAMES
  return {
    size: map.size,
    get(n) {
      const e = map.get(n)
      return e && (!only || only(e)) ? lawEmote(n, e) : undefined
    },
    *values() {
      for (const e of lawAll(map).list) if (!only || only(e.raw)) yield e
    },
    at: (key) => lawAll(map).byKey.get(key),
  }
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
  const rooms = []
  for (const platform of ['twitch', 'kick', 'youtube']) {
    const key = legs?.[platform]
    if (!key) continue
    // the room of THIS platform inside the channel's set: a kick leg never ships twitch's emote
    const set = channelRoomNames(caches[key] || caches[String(key).toLowerCase()], platform)
    rooms.push({ platform, channel: key, loaded: !!set, names: lawView(set) })
  }
  const held = picks && (picks.picked.size || picks.remote.size) ? new Map([...picks.remote, ...picks.picked]) : null
  return {
    room: rooms[0] || null,
    legs: rooms,
    own: {
      inventory: lawView(mine, (e) => e.source !== 'twitch' && e.source !== 'kick'),
      personal: LAW_NO_NAMES,
      native: {
        twitch: lawView(mine, (e) => e.source === 'twitch'),
        kick: lawView(mine, (e) => e.source === 'kick'),
      },
    },
    globals: lawView(globals),
    picks: held ? lawView(held) : null,
    fold: false,
  }
}

/** the composer: the one box a chat line is written in */
const lawBox = () => document.getElementById('hs-mc-input')

/**
 * The room of each platform a send from the open tab reaches, by cache key: the same resolution
 * the send makes (composerLegs), so the chip is judged against the room the line will go to.
 */
function lawOpenLegs() {
  let ch = null
  if (currentTab === 'live') {
    const live = String(getLiveChannel() || '')
    const lower = live.toLowerCase()
    ch = lower
      ? config.channels.find((c) => c.twitch?.toLowerCase() === lower || c.kick?.toLowerCase() === lower) || null
      : null
    if (!ch) {
      return {
        twitch: hostPlatform === 'twitch' ? live : '',
        kick: hostPlatform === 'kick' ? live : '',
        youtube: hostPlatform === 'yt' ? live : '',
      }
    }
  } else {
    ch = config.channels.find((c) => c.id === currentTab) || null
  }
  if (!ch) return {}
  const st = resolveSendTargets(ch.sendTargets, { twitch: !!ch.twitch, kick: !!ch.kick, youtube: !!ch.youtube })
  return {
    twitch: ch.twitch && st.twitch ? ch.twitch : '',
    kick: ch.kick && st.kick ? ch.kick : '',
    youtube: ch.youtube && st.youtube ? lawYtKey(ch.youtube) : '',
  }
}

/** the cache key of a youtube room: its @handle, filed with or without the @ */
function lawYtKey(url) {
  const h = typeof url === 'string' ? url.match(/\/@([^/?]+)/)?.[1] : null
  if (!h) return ''
  return channelEmoteCaches[`@${h}`] ? `@${h}` : h
}

/**
 * A Tab step, a picker tile or a clicked emote is this message's pick of that name (send rule 1):
 * filed on the composer's own draft, so it dies with the message and never reaches another.
 * @param {string} name
 * @param {{url?:string, source?:string, provider?:string, id?:string, hash?:string, zeroWidth?:boolean, animated?:boolean}} e
 */
function lawPin(name, e) {
  const box = lawBox()
  if (!box || !name || !e?.url) return
  // refOf (inside the pin) keeps only what is really there: a hash, a string id, a boolean animated
  const { url, zeroWidth, hash, id, animated } = e
  pinPickedEmote({ name, url, provider: e.provider || e.source, zeroWidth, hash, id, animated }, box)
}

/** a pick as an overlay entry, for a picture no cache holds (a catalog hit) */
const LAW_SOURCE = { hs: 'heatsync' }
function lawPickEntry(e) {
  return {
    url: e.url,
    source: LAW_SOURCE[e.provider] || e.provider || 'heatsync',
    state: 'global',
    zeroWidth: !!e.zeroWidth,
    ...(e.hash ? { hash: e.hash } : {}),
  }
}

/**
 * What a word draws in the composer: the answer a send from the open tab would give (the law's
 * sendWord), so the chip, what ships and your own row are one answer.
 * @param {string} word as typed
 * @param {object|null} [legs] default: the open tab's
 * @returns {{e:object, overlay:boolean, key:string, from:string}|null} `e` is the overlay's own entry
 */
function lawChip(word, legs) {
  const hit = hsEmoteLaw.sendWord(
    word,
    lawSendCtx({
      legs: legs || lawOpenLegs(),
      mine: viewerPersonalEmotes,
      globals: emoteCache,
      caches: channelEmoteCaches,
      picks: draftPicks(lawBox()),
    }),
  )
  if (!hit) return null
  const e = hit.emote
  // a pick is a bare record: draw the cache's own entry when it is that very picture, else the pick
  const own = e.raw && e.raw.state ? e.raw : lawPickEntry(e)
  return { e: own, overlay: hit.overlay, key: hit.key, from: hit.from }
}

/**
 * What a chat line ships, from the law: the text each leg receives and the refs that travel with
 * it. `legs` names the cache key of each platform reached; `box` is the input the line was typed in.
 * A ref carries only what is true of the picture: the provider's own id (never the key the law made
 * up for an entry that holds none) and a hash only for a copy you own, since a hash is how the
 * server checks "the sender owns this". `picked` names the refs that are this message's picks: the
 * ones your own row cannot read back from the room or your set, so the echo is handed them. `used`
 * is every emote the line carries, by name and picture: what a send counts as used (lawNoteSent).
 * @returns {{wire:object, refs:object|undefined, picked:string[]|undefined, used:Array<{name:string,url:string}>}}
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
  let picked
  const used = []
  for (const k in sent.refs) {
    const e = sent.refs[k]
    if (e.url) used.push({ name: e.name, url: e.url })
    if (hsEmoteLaw.sendWord(k, ctx)?.from === 'pick') (picked ||= []).push(k)
    const yours = viewerPersonalEmotes.get(k)
    const hash = yours?.hash && yours.url === e.url ? yours.hash : undefined
    refs ||= {}
    Object.defineProperty(refs, k, {
      // the row and the wire speak the overlay's own source names ('heatsync'), not the law's ('hs')
      value: refOf({ ...e, provider: e.raw?.provider || e.raw?.source || e.provider, hash, id: e.raw?.id }),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { wire: sent.wire, refs, picked, used }
}

/** a line's refs in the shape the server stores ({p,id,a}); undefined when none of them can be stored */
function lawStored(refs) {
  if (!refs) return undefined
  const out = normalizeEmoteRefsForSend(refs)
  for (const _ in out) return out
  return undefined
}
