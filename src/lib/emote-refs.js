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

// Session registry of catalog emotes ("7tv search" Tab completions). They
// live in NO map — not inventory, channel, or global — so the emotesMap
// lookup below can never find them and the sent message degraded to plain
// text for every viewer, sender included. A url-only ref (no hash) is fully
// valid: the server gate (emote-refs-sanitize.ts) requires url + CDN
// allowlist and treats hash as optional passthrough, and SSR
// (applyEmoteTokens) renders from url alone. Keyed lowercase; capped FIFO so
// a marathon session can't grow it unbounded.
const remoteCompleted = new Map()
const REMOTE_COMPLETED_MAX = 200

/**
 * @param {{name?:string,url?:string,provider?:string,id?:string,animated?:boolean,zeroWidth?:boolean,width?:number,height?:number}} emote
 *        a catalog search result the user completed via Tab or clicked in the picker
 */
export function registerRemoteEmoteRef(emote) {
  if (!emote?.name || !emote?.url) return
  const key = emote.name.toLowerCase()
  if (!remoteCompleted.has(key) && remoteCompleted.size >= REMOTE_COMPLETED_MAX) {
    remoteCompleted.delete(remoteCompleted.keys().next().value)
  }
  remoteCompleted.set(key, {
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
  let ref = lookup(word) || lookup(word.toLowerCase())
  if (ref) return { name: word, ref }
  if (word.endsWith('0') && word.length > 1) {
    const clean = word.slice(0, -1)
    ref = lookup(clean) || lookup(clean.toLowerCase())
    if (ref) return { name: clean, ref }
  }
  return null
}

/**
 * @param {string} content - the raw outgoing message text
 * @param {Map<string, {hash?:string,url?:string,name?:string,provider?:string,zeroWidth?:boolean,width?:number,height?:number}>} emotesMap
 *        the sender's own emote map (keyed by exact name, lowercase fallback)
 * @returns {Object} emote_refs keyed by the emote's name (overlay suffix stripped)
 */
export function buildEmoteRefs(content, emotesMap) {
  const emote_refs = {}
  if (!content) return emote_refs
  // Split on whitespace (not \b\w+\b) so non-word emotes like ")))" or "<3" are
  // considered too.
  for (const word of String(content).split(/\s+/).filter(Boolean)) {
    // Full name FIRST, exact case then lowercase — emotesMap is keyed by the
    // emote's real name. Only strip a trailing 0 (the overlay convention) when
    // the full word is NOT itself a real emote, so an emote literally named
    // "lerolero0" keeps its own ref and the renderer resolves it identically.
    let clean = word
    let ed = emotesMap?.get(word) || emotesMap?.get(word.toLowerCase())
    if (!ed && word.endsWith('0') && word.length > 1) {
      clean = word.slice(0, -1)
      ed = emotesMap?.get(clean) || emotesMap?.get(clean.toLowerCase())
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
    if (ed?.hash) {
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
    let r = remoteCompleted.get(word.toLowerCase())
    let rClean = word
    if (!r && word.endsWith('0') && word.length > 1) {
      rClean = word.slice(0, -1)
      r = remoteCompleted.get(rClean.toLowerCase())
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
 * @returns {{name:string,url:string,provider?:string,zeroWidth?:boolean,width?:number,height?:number,id?:string,animated?:boolean}|undefined}
 */
export function lookupRemoteEmoteRef(word) {
  if (!word) return undefined
  let r = remoteCompleted.get(word.toLowerCase())
  if (!r && word.endsWith('0') && word.length > 1) {
    r = remoteCompleted.get(word.slice(0, -1).toLowerCase())
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
