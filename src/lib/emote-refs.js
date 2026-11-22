// Single source of truth for building a message's `emote_refs` map.
//
// `emote_refs` is how a sender VOUCHES the emotes in their message so OTHER
// viewers — who may not own the emote — still render the image instead of raw
// text. It ships { name → {hash,url,name,provider,zeroWidth,width,height} }
// alongside the message; the render path (utils/helpers.js parseEmotes) resolves
// refs by hash or url so deleted/unowned emotes still appear.
//
// The natural size travels with the ref because the ref IS the emote for every
// viewer who does not own it — including the sender's own optimistic echo, which
// renders from refs and nothing else. helpers.js reserves an emote's line box
// from `width`/`height` (its `canReserve` block); a ref without them draws a
// zero-width box that grows the instant the image decodes, so a message you had
// just sent reflowed a frame after you pressed enter. The map entries have
// carried the dimensions all along — this was the one hop that dropped them.
//
// Three send paths used to hand-roll this and drifted out of sync — the omnibar
// (socket-manager), the chat tile, and media-attached sends (media-upload). The
// drift silently dropped emotes for other viewers: a lowercase-only lookup
// missed every cased name (PepeLaugh, KEKW), an unconditional trailing-0 strip
// broke emotes literally named "…0", and a \b\w+\b tokenizer skipped non-word
// emotes like ")))". This is the one correct implementation; every send path
// must call it so a fix lands everywhere at once.

// Case is exact (rule 5): KEKW and kekw are two emotes. The ONE exception is the
// user's own caseInsensitiveEmotes setting, which the renderer honours too — so
// every lowercase fallback below goes through these and asks the probe first.
// The probe is injected (the site wires its settingsManager; the extension keeps
// the exact-case default), so this file imports nothing and stays byte-mirrored.
let caseInsensitive = () => false

/** Wire the user's case setting: fn() -> true only when they turned it on. */
export function setCaseInsensitiveProbe(fn) {
  caseInsensitive = typeof fn === 'function' ? () => fn() === true : () => false
}

/** map.get(word), then — only with the setting on — the lowercase key. */
function getByName(map, word) {
  const hit = map?.get(word)
  if (hit !== undefined || !caseInsensitive()) return hit
  return map?.get(word.toLowerCase())
}

/** Same for a registry keyed by the emote's exact name. */
function getRegistered(registry, word) {
  const hit = registry.get(word)
  if (hit !== undefined || !caseInsensitive()) return hit
  const lower = word.toLowerCase()
  for (const [key, val] of registry) if (key.toLowerCase() === lower) return val
  return undefined
}

// A pick belongs to the message it was made in (emote law, send rule 2), and a
// message is written in one box. So picks are kept per box — keyed by its
// input element — never per page: a send or a clear in one composer cannot
// wipe, or borrow, what was picked in another. A box that goes away (an edit
// textarea) takes its picks with it; nothing has to remember to clear them.
//
// A draft holds two lists, both keyed by the emote's exact name:
//   picked — the exact record a Tab step, a picker tile or a chip chose. A name
//            can mean several emotes at once (the room's, yours, a global);
//            buildEmoteRefs honours the pick before any map.
//   remote — catalog emotes ("7tv search") that live in NO map. A url-only ref
//            (no hash) is fully valid: the server gate (emote-refs-sanitize.ts)
//            requires url + CDN allowlist, and SSR renders from url alone.
const drafts = new WeakMap()
// away: picks whose word left the box, kept only so an undo that brings the word back brings its pick back
const fresh = () => ({ picked: new Map(), remote: new Map(), away: new Map() })
// callers with no box to name (the extension's copy, a bare lookup)
let loose = fresh()

/**
 * The box's live draft. Hold it across a clear (see endDraftPicks) and it is
 * still that message's picks; a held draft can be passed wherever a box can.
 * @param {object} [owner] the box's input element, or a draft it once held
 */
export function draftPicks(owner) {
  if (!owner) return loose
  if (owner.picked) return owner
  let d = drafts.get(owner)
  if (!d) drafts.set(owner, d = fresh())
  return d
}

const put = (map, key, val) => { if (val === undefined) map.delete(key); else map.set(key, val) }

/**
 * @param {{name?:string,url?:string,provider?:string,id?:string,animated?:boolean,zeroWidth?:boolean,width?:number,height?:number}} emote
 *        a catalog search result the user completed via Tab or clicked in the picker
 * @param {object} [owner] the box it was picked into
 */
export function registerRemoteEmoteRef(emote, owner) {
  // null is "there is no box" (the composer is not on the page): nothing to file
  if (!emote?.name || !emote?.url || owner === null) return
  draftPicks(owner).remote.set(emote.name, {
    name: emote.name,
    url: emote.url,
    provider: emote.provider,
    zeroWidth: !!emote.zeroWidth,
    // The provider's own id + whether it's animated — carried through so the
    // send path can build the durable, permanent per-message ref
    // (migrations/315, {p,id,a}) without re-deriving an id from the url.
    // Neither is used for rendering, only stored when present.
    ...(typeof emote.id === 'string' && emote.id ? { id: emote.id } : {}),
    ...(typeof emote.animated === 'boolean' ? { animated: emote.animated } : {}),
    ...naturalSize(emote),
  })
}

/**
 * @param {{name?:string,url?:string,hash?:string,provider?:string,id?:string,animated?:boolean,zeroWidth?:boolean,width?:number,height?:number}} emote
 *        the record a composer chip was drawn from (Tab, cycle or picker)
 * @param {object} [owner] the box it was picked into
 */
export function pinPickedEmote(emote, owner) {
  if (!emote?.name || !emote?.url || owner === null) return
  // a synthesized "name0" overlay variant resolves through its base word
  if (emote.zeroWidth && emote.name.length > 1 && emote.name.endsWith('0')) return
  const key = emote.name
  const d = draftPicks(owner)
  // The pin is the final word on this name. An earlier same-named catalog
  // registration (an FFZ "LICK" picked before the room's 7tv one) would
  // otherwise survive and the send's commit step would add THAT one to the
  // inventory in place of the pick.
  if (d.remote.get(key)?.url !== emote.url) d.remote.delete(key)
  d.picked.set(key, {
    name: emote.name,
    url: emote.url,
    ...(emote.hash ? { hash: emote.hash } : {}),
    provider: emote.provider,
    zeroWidth: !!emote.zeroWidth,
    ...(typeof emote.id === 'string' && emote.id ? { id: emote.id } : {}),
    ...(typeof emote.animated === 'boolean' ? { animated: emote.animated } : {}),
    ...naturalSize(emote),
  })
}

/**
 * The message this box held is gone (sent, replaced, or thrown away): its picks
 * go with it. A name typed by hand afterwards is a hand-typed word.
 * @param {object} [owner]
 * @returns {object} the ended draft — hand it to resumeDraftPicks if the same
 *          message comes back into the box (a refused send)
 */
export function endDraftPicks(owner) {
  const was = draftPicks(owner)
  if (owner) drafts.delete(owner)
  else loose = fresh()
  return was
}

/**
 * The message a draft belonged to is back in its box: so are its picks.
 * @param {object|null|undefined} was what endDraftPicks / draftPicks returned
 * @param {object} [owner]
 */
export function resumeDraftPicks(was, owner) {
  if (!was?.picked) return
  if (owner) drafts.set(owner, was)
  else loose = was
}

/**
 * The box's text changed: a pick whose word is no longer in it is over. This
 * is what stops a chip you deleted from deciding what the same name sends when
 * you type it by hand later in the same message — and an emptied box keeps none.
 *
 * An undo is the one way back: it restores the chip, so it restores the pick
 * the chip was drawn from. Typing the name back by hand does not.
 * @param {string|(() => string)} text the box's current text (a function is
 *        only called when there is a pick to check)
 * @param {object} [owner]
 * @param {boolean} [undo] the change was an undo or a redo
 */
export function keepPicksIn(text, owner, undo) {
  const d = draftPicks(owner)
  if (!d.picked.size && !d.remote.size && !d.away.size) return
  const fold = caseInsensitive() ? s => s.toLowerCase() : s => s
  const words = new Set()
  for (const w of String((typeof text === 'function' ? text() : text) || '').split(/\s+/)) {
    words.add(fold(w))
    // an overlay is typed as "name0" and filed under "name"
    if (w.endsWith('0')) words.add(fold(w.slice(0, -1)))
  }
  for (const [key, held] of [...d.away]) {
    if (!words.has(fold(key))) continue
    d.away.delete(key)
    if (undo && !d.picked.has(key) && !d.remote.has(key)) {
      put(d.picked, key, held[0])
      put(d.remote, key, held[1])
    }
  }
  for (const key of new Set([...d.picked.keys(), ...d.remote.keys()])) {
    if (words.has(fold(key))) continue
    d.away.set(key, [d.picked.get(key), d.remote.get(key)])
    d.picked.delete(key)
    d.remote.delete(key)
  }
}

/**
 * What `name` holds in this draft right now. A Tab cycle takes this before it
 * files a step, and puts it back when the cycle moves on to another name — so
 * a step that was only looked at leaves the name exactly as it found it,
 * including an earlier pick of that name the message still shows.
 * @param {string} name
 * @param {object} [owner]
 * @returns {[object|undefined, object|undefined]}
 */
export function heldPick(name, owner) {
  const d = draftPicks(owner)
  return [d.picked.get(name), d.remote.get(name)]
}

/**
 * @param {string} name
 * @param {[object|undefined, object|undefined]} held from heldPick
 * @param {object} [owner]
 */
export function putBackPick(name, held, owner) {
  const d = draftPicks(owner)
  put(d.picked, name, held[0])
  put(d.remote, name, held[1])
}

/**
 * Take back one pick, and only that one: whatever was filed for `emote` goes
 * unless a different emote has since taken the name (a newer pick stays).
 * @param {{name?:string,url?:string}} emote
 * @param {object} [owner]
 */
export function dropPick(emote, owner) {
  const key = emote?.name
  if (!key) return
  const d = draftPicks(owner)
  if (d.picked.get(key)?.url === emote.url) d.picked.delete(key)
  if (d.remote.get(key)?.url === emote.url) d.remote.delete(key)
}

/**
 * Drop the pin on `name`. With a hash, only a pin of THAT emote goes — a newer
 * pick of a different emote under the same word stays. Called when an emote is
 * removed or swapped away: the word then resolves by the normal order (rule 8).
 * @param {string} name
 * @param {{hash?:string}} [opts]
 * @param {object} [owner]
 */
export function forgetPickedEmote(name, { hash } = {}, owner) {
  if (!name) return
  const d = draftPicks(owner)
  const pin = d.picked.get(name)
  if (pin && (!hash || pin.hash === hash)) d.picked.delete(name)
}

/**
 * The record the sender picked for exactly this word in this box (Tab, picker
 * or chip), or undefined. The composer chip asks it so the chip draws what
 * will send.
 * @param {string} word
 * @param {object} [owner]
 */
export function lookupPickedEmote(word, owner) {
  return word ? getRegistered(draftPicks(owner).picked, word) : undefined
}

/**
 * The natural box of an emote, as the two fields a ref carries — or nothing
 * when the source doesn't know it. Both or neither: helpers.js reserves a box
 * from the pair, so half an answer would draw a wrong one and hold it until
 * the image decoded, which is the reflow this exists to prevent.
 * @param {{width?:unknown, height?:unknown}|null|undefined} src
 * @returns {{width:number, height:number}|{}}
 */
function naturalSize(src) {
  const w = Number(src?.width)
  const h = Number(src?.height)
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? { width: w, height: h }
    : {}
}

/**
 * Match one whitespace-split word against a name→ref lookup, honoring the
 * one rule every emote-ref consumer needs: exact name first, lowercase
 * fallback, then — only when the full word isn't itself a real name — strip
 * a trailing overlay "0" and retry. buildEmoteRefs (below, the send path)
 * inlines this same order against its own two sources; this standalone form
 * is for read-side matchers (e.g. the live-vouch ingest in
 * channel-buffer-manager.js) that match words against a foreign map instead.
 * @param {string} word
 * @param {(name:string) => any} lookup
 * @returns {{name:string, ref:any}|null}
 */
export function matchEmoteWord(word, lookup) {
  let ref = lookup(word) || (caseInsensitive() ? lookup(word.toLowerCase()) : undefined)
  if (ref) return { name: word, ref }
  if (word.endsWith('0') && word.length > 1) {
    const clean = word.slice(0, -1)
    ref = lookup(clean) || (caseInsensitive() ? lookup(clean.toLowerCase()) : undefined)
    if (ref) return { name: clean, ref }
  }
  return null
}

/**
 * @param {string} content - the raw outgoing message text
 * @param {Map<string, {hash?:string,url?:string,name?:string,provider?:string,zeroWidth?:boolean,width?:number,height?:number}>} emotesMap
 *        the sender's own emote map (keyed by exact name, lowercase fallback)
 * @param {Map<string, {url?:string,name?:string,provider?:string,zeroWidth?:boolean,id?:string,animated?:boolean,width?:number,height?:number}>} [channelMap]
 *        the room's own emotes (7tv/bttv/ffz/twitch). Last resort after the
 *        inventory and picks, so a name typed by heart ships its image too.
 * @param {object} [owner] the box the message was written in — its picks apply
 * @returns {Object} emote_refs keyed by the emote's name (overlay suffix stripped)
 */
export function buildEmoteRefs(content, emotesMap, channelMap, owner) {
  const emote_refs = {}
  if (!content) return emote_refs
  const { picked, remote } = draftPicks(owner)
  // Split on whitespace (not \b\w+\b) so non-word emotes like ")))" or "<3" are
  // considered too.
  for (const word of String(content).split(/\s+/).filter(Boolean)) {
    // Full name FIRST, exact case then lowercase — emotesMap is keyed by the
    // emote's real name. Only strip a trailing 0 (the overlay convention) when
    // the full word is NOT itself a real emote, so an emote literally named
    // "lerolero0" keeps its own ref and the renderer resolves it identically.
    // an explicit pick beats whatever the maps say the name means
    const pick = getRegistered(picked, word)
    if (pick) {
      // keyed by the word as typed — the renderer looks refs up by that
      emote_refs[word] = { ...pick }
      continue
    }
    let clean = word
    let ed = getByName(emotesMap, word)
    if (!ed && word.endsWith('0') && word.length > 1) {
      clean = word.slice(0, -1)
      ed = getByName(emotesMap, clean)
    }
    // hash is the primary render key; keep url/name/provider so a deleted or
    // unowned emote still renders for other viewers, and zeroWidth so overlay
    // stacking survives the round trip.
    //
    // Owned wins over a catalog registration for the SAME name — inventory is
    // where an explicit pick actually LANDS (chat-tile's
    // _addRemoteCatalogPicksToInventory auto-adds a pick before this runs,
    // and its own cross-check against lookupRemoteEmoteRef is what stops a
    // pre-existing, UNRELATED same-name owned emote from silently winning
    // instead — see that function's own comment. Flipping precedence HERE
    // was tried and reverted: it made every catalog registration shadow its
    // own just-added inventory copy for the rest of the session, which is a
    // worse bug (no hash, no natural-size box, on EVERY future send of that
    // word) than the narrow collision it was meant to fix.
    // Order a line draws in: your inventory, then the room's own emote, then
    // the rest of your map (twitch globals/subs, shared globals). A non-inventory
    // hit therefore yields to a room emote of the same name; a bare map entry
    // never outranks the channel.
    const roomHit = ed?.hash && ed.provider !== 'inventory'
      && getByName(channelMap, clean)?.url
    if (ed?.hash && !roomHit) {
      emote_refs[clean] = {
        hash: ed.hash,
        url: ed.url,
        name: ed.name,
        provider: ed.provider,
        zeroWidth: ed.zeroWidth,
        ...naturalSize(ed),
      }
      continue
    }
    // Catalog fallback — same full-name-first / strip-0 order as above.
    let r = getRegistered(remote, word)
    let rClean = word
    if (!r && word.endsWith('0') && word.length > 1) {
      rClean = word.slice(0, -1)
      r = getRegistered(remote, rClean)
    }
    if (r) {
      emote_refs[rClean] = {
        url: r.url,
        name: r.name,
        provider: r.provider,
        zeroWidth: r.zeroWidth,
        ...(r.id ? { id: r.id } : {}),
        ...(typeof r.animated === 'boolean' ? { animated: r.animated } : {}),
        ...naturalSize(r),
      }
      continue
    }
    // Room emotes typed by heart. Not in inventory or the catalog, so without
    // this the post carried no image and only viewers whose own room set
    // happened to load saw it.
    let ch = getByName(channelMap, word)
    let chClean = word
    if (!ch && word.endsWith('0') && word.length > 1) {
      chClean = word.slice(0, -1)
      ch = getByName(channelMap, chClean)
    }
    if (ch?.url) {
      emote_refs[chClean] = {
        url: ch.url,
        name: ch.name || chClean,
        provider: ch.provider,
        zeroWidth: !!ch.zeroWidth,
        ...(ch.id ? { id: ch.id } : {}),
        ...(typeof ch.animated === 'boolean' ? { animated: ch.animated } : {}),
        ...naturalSize(ch),
      }
    }
  }
  return emote_refs
}

/**
 * What word-for-word catalog registration currently says about `word` — the
 * same full-name/lowercase/overlay-0 match buildEmoteRefs' fallback uses, but
 * exposed standalone so a caller can ask "what was explicitly picked here"
 * independently of whether an owned entry also exists. The one consumer is
 * chat-tile's _addRemoteCatalogPicksToInventory: it needs to tell "the sender
 * already owns exactly this pick" from "the sender owns something else under
 * the same name" — buildEmoteRefs alone can't distinguish those once an owned
 * entry exists, because it stops looking the moment one does.
 * @param {string} word
 * @param {object} [owner]
 * @returns {{name:string,url:string,provider?:string,zeroWidth?:boolean,width?:number,height?:number,id?:string,animated?:boolean}|undefined}
 */
export function lookupRemoteEmoteRef(word, owner) {
  if (!word) return undefined
  const { remote } = draftPicks(owner)
  let r = getRegistered(remote, word)
  if (!r && word.endsWith('0') && word.length > 1) {
    r = getRegistered(remote, word.slice(0, -1))
  }
  return r
}

/**
 * Fold one leg's emote_refs into another's, by name.
 *
 * Every caller is merging two legs of the SAME message — a local echo and its
 * platform echo, two fan-out legs of one send, or a history row and the live
 * one. They cannot disagree about what a name means, so the only question is
 * which names survive. It used to be `if (!a.emote_refs && b.emote_refs)`:
 * whole-object fill, all-or-nothing. A single name on the target was enough to
 * discard every name on the source.
 *
 * That is not theoretical. The sender's local echo builds refs from their own
 * emotesMap and is COMPLETE; the platform echo gets its refs from
 * _resolveNativeEmoteRefs, which runs first and whose sources are all partial
 * by construction — server enrichment is cache-only and warms on miss, the
 * live vouch is 90s, the sender batch gates on inventory time. So a message
 * with two inventory emotes where only one was enriched arrived with one ref,
 * and the complete pair from the echo was dropped wholesale: on the sender's
 * own screen, the one place with perfect information, the other emote went out
 * as text.
 *
 * Additive, never overwriting — same rule as _upgradeMessagesForSenders: a
 * rendered row does not downgrade.
 *
 * @param {{emote_refs?:Object}|null|undefined} target - mutated in place
 * @param {{emote_refs?:Object}|null|undefined} source
 * @returns {boolean} true if target gained at least one name
 */
export function mergeEmoteRefs(target, source) {
  const from = source?.emote_refs
  if (!target || !from) return false
  let gained = false
  for (const [name, ref] of Object.entries(from)) {
    if (!ref) continue
    if (target.emote_refs?.[name]) continue
    if (!target.emote_refs) target.emote_refs = {}
    target.emote_refs[name] = ref
    gained = true
  }
  return gained
}
