// The overlay's end of the emote law (docs/emote-law-map.md, shared/emote-law.ts): which emote is
// this word on a chat row. processEmotes owns the markup, overlays and sizes; this owns only the
// answer, from the law, over the maps the overlay already holds.
//
// The law reads name -> emote maps. The overlay's maps are those (the channel's, the globals, a
// sender's set), so nothing is rebuilt per row: a view over a set only filters what a lookup may
// return (the inventory-time gate), the way the site's client/emotes/law.js sorts its maps once.

const LAW_NONE = new Map()

/** a sender's set as two law tiers: 7tv/bttv personal sets read above the room, everything else
 *  they hold (their heatsync emotes, natives) below it. `gate` is the time window they owned it. */
function lawSenderViews(set, named, gate) {
  const mine = (n, personal) => {
    const e = gate(set?.get(n))
    return e && (e.personal === true) === personal ? e : undefined
  }
  const size = (set?.size || 0) + (named?.size || 0)
  return {
    personal: { size, get: (n) => mine(n, true) },
    // a server name-match (hsEmotes) is the sender's emote, never a pick: it reads below the room
    inventory: { size, get: (n) => named?.get(n) ?? mine(n, false) },
  }
}

/**
 * Everything one row reads against.
 * @param {object} p
 * @param {Map|null} p.room        the row's channel emotes (name -> entry), null when none loaded
 * @param {string} [p.platform]    the row's platform
 * @param {Map} p.globals
 * @param {Map|null} p.tags        the platform's own emotes on this line, keyed by the ESCAPED word
 * @param {Map|null} p.refs        this line's refs, keyed by escaped word; `named` ones are server name-matches
 * @param {Map|null} p.sender      the sender's set (viewer's own on their own line)
 * @param {(e:object)=>object|null} p.gate  inventory-time gate for the sender's entries
 * @param {(s:string)=>string} p.unesc
 */
function lawReadCtx({ room, platform, globals, tags, refs, sender, gate, unesc }) {
  // what the sender's app shipped with the line: a plain object, so a word called __proto__ is a name
  const picks = Object.create(null)
  const named = new Map()
  for (const [k, v] of tags || LAW_NONE) picks[unesc(k)] = v
  for (const [k, v] of refs || LAW_NONE) {
    if (v.named) named.set(unesc(k), v)
    else picks[unesc(k)] = v
  }
  const s = lawSenderViews(sender, named, gate)
  return {
    room: room
      ? { platform: platform === 'yt' ? 'youtube' : platform || 'twitch', channel: '', loaded: true, names: room }
      : null,
    refs: picks,
    sender: { inventory: s.inventory, personal: s.personal, native: {} },
    globals,
    fold: false,
    tags,
  }
}

/**
 * What a word draws: { e, inv, overlay, stripped } or null. `word` is the escaped token. `inv` marks a hit that
 * draws BECAUSE of an inventory (the sender's, or a server name-match), the tooltip's attribution.
 */
function lawReadWord(word, ctx, unesc) {
  const raw = word.indexOf('&') === -1 ? word : unesc(word)
  const hit = hsEmoteLaw.readWord(raw, ctx)
  if (!hit?.emote) return null
  const e = hit.emote
  const fromTag = hit.from === 'pick' && ctx.tags?.get(word) === e
  // the law reads a literal name first and strips one trailing 0 only when there is none: the strip
  // shows as an overlay on an emote that is not zero-width by itself, or one whose literal is absent
  const stripped = hit.overlay && raw.length > 1 && raw.endsWith('0') && !lawHasLiteral(raw, ctx)
  return {
    e,
    inv: !fromTag && hit.from !== 'room' && hit.from !== 'global',
    overlay: hit.overlay,
    stripped,
    from: hit.from,
  }
}

function lawHasLiteral(raw, ctx) {
  return !!(
    ctx.refs[raw] ||
    ctx.sender.personal.get(raw) ||
    ctx.room?.names.get(raw) ||
    ctx.sender.inventory.get(raw) ||
    ctx.globals.get(raw)
  )
}
