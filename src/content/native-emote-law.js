// The native page's end of the emote law (the site's docs/emote-law.md, docs/emote-law-map.md R17):
// twitch's and kick's own chat with the overlay off. content.js owns the rows and their markup;
// this owns two answers, as plain lookups over the maps content.js already holds:
//
//   read   which emote a word is on a native row
//   send   which words of a line typed into the site's own box the room has to be told about
//
// It is the law's order, not a second rule: tests/native-emote-law.test.ts asks the law itself
// (shared/emote-law.ts) the same questions over hundreds of generated rooms and fails on any word
// the two answer differently.
// Self-contained: build.js embeds it into content.js, tests import it.

/** First tier that holds the name wins; an absent tier is skipped. The order IS the precedence. */
export function hsTieredEmotes(tiers) {
  const live = tiers.filter(Boolean)
  return {
    get(name) {
      for (const m of live) {
        const e = m.get(name)
        if (e) return e
      }
      return undefined
    },
    has(name) {
      return live.some((m) => !!m.get(name))
    },
    get size() {
      return live.reduce((n, m) => n + m.size, 0)
    },
  }
}

/**
 * A sender's set as the law's two tiers. The background hands over one merged map: what 7tv or
 * bttv call their personal set carries `personal`, everything else is their heatsync emotes.
 * @param {Map<string, object>|null|undefined} set
 */
function hsSenderTier(set, personal) {
  if (!set || set.size === 0) return null
  return {
    size: set.size,
    get(name) {
      const e = set.get(name)
      return e && (e.personal === true) === personal ? e : undefined
    },
  }
}

/** The personal half of a sender's merged set (null when there is none to read). */
export const hsPersonalOf = (set) => hsSenderTier(set, true)

/**
 * What a native row reads against, in the law's read order: the line's pick (what the sender's
 * app told the room), the sender's personal set, the room, the sender's own emotes, the globals.
 * A platform's own emote is an <img> the site drew: it is never a word here.
 * On the viewer's own row `own` is their inventory as this page holds it (fresher than the copy
 * the server hands out): the same order, so your row is what everyone sees.
 * @param {object} p
 * @param {Map|null} p.picks    name -> the emote this sender's app announced
 * @param {Map|null} p.sender   the sender's merged set
 * @param {Map|null} p.room     the page's channel: the streamer's own emotes, ffz, 7tv, bttv, the platform's
 * @param {Map|null} [p.own]    the viewer's inventory, on the viewer's own row
 * @param {Map|null} p.globals
 */
export function hsNativeReadTiers({ picks, sender, room, own, globals }) {
  return hsTieredEmotes([picks, hsSenderTier(sender, true), room, own || hsSenderTier(sender, false), globals])
}

/**
 * The words of a native send the room must be told about (`emote:used`), as [{ name, emote }].
 * The law's send order decides what each word is: twitch's own emote you can use (twitch marks
 * it whatever we say), a pick made in this draft, your personal set's, the room's, yours, a
 * global. Only two of those are news to a reader: a pick, and your own emote where neither your
 * personal set nor the room has that name. A word the room answers is the room's for everyone
 * and is announced by nobody, so your saved copy of a name never rides a hand-typed word again.
 * An overlay (`name0` with no emote of that literal name anywhere) goes out under the name
 * without the 0; twitch marks only the exact word, so `Kappa0` is never twitch's.
 * @param {string} text
 * @param {object} p
 * @param {{has(name:string):boolean}|null} p.native  twitch emotes you can post there; null off twitch
 * @param {Map|null} p.picks      name -> your emote picked for this draft
 * @param {{get(name:string):object|undefined}|null} [p.personal]  your 7tv / bttv personal set
 * @param {Map|null} p.room
 * @param {Map|null} p.inventory  your heatsync emotes
 * @param {Map|null} p.globals
 */
export function hsNativeAnnounce(text, { native, picks, personal, room, inventory, globals }) {
  const out = []
  const seen = new Set()
  // an emote to tell the room; 'theirs' = an emote every reader works out alone; 'marked' = the
  // platform's own; null = not an emote
  const answer = (name, stripped) => {
    if (!stripped && native?.has(name)) return 'marked'
    const pick = picks?.get(name)
    if (pick) return pick
    if (personal?.get(name) || room?.get(name)) return 'theirs'
    return inventory?.get(name) || (globals?.get(name) ? 'theirs' : null)
  }
  for (const word of String(text || '').split(/\s+/)) {
    if (!word) continue
    let name = word
    let hit = answer(name, false)
    if (!hit && word.length > 1 && word.endsWith('0')) {
      name = word.slice(0, -1)
      hit = answer(name, true)
    }
    // the platform's own emote is a picture in the line, not a word: it takes no name
    if (!hit || hit === 'marked') continue
    // one draft, one meaning per name: the first answer stands
    if (seen.has(name)) continue
    seen.add(name)
    if (hit === 'theirs') continue
    // a pick of the very picture the room already draws for the name says nothing new
    const rooms = room?.get(name)
    if (!(rooms?.hash && rooms.hash === hit.hash)) out.push({ name, emote: hit })
  }
  return out
}

/** Is `name` a word of the box (as typed, or as its overlay `name0`)? */
const hsWordIn = (words, name) => words.has(name) || words.has(`${name}0`)

/**
 * A draft's picks are `name -> { hash, seen }`, noted when our picker pastes a word into the
 * site's box. A pick ends when its word leaves the box: called on every edit, this marks a pick
 * `seen` once its word is there and drops a seen pick whose word is gone. (The paste lands a
 * beat after the note, so a pick not seen yet is left alone.)
 */
export function hsTrackPicks(picks, text) {
  if (!picks || picks.size === 0) return
  const words = new Set(String(text || '').split(/\s+/))
  for (const [name, pick] of [...picks]) {
    if (hsWordIn(words, name)) pick.seen = true
    else if (pick.seen) picks.delete(name)
  }
}

/**
 * The picks a line leaves with, as `name -> emote`: a pick whose word is in the line and whose
 * picture is one of your own emotes right now. Anything else picked (the room's emote, a global)
 * is what the bare word already means, so it is no pick.
 * @param {Map<string, {hash: string}>|null} picks
 * @param {string} text
 * @param {Map|null} inventory
 */
export function hsPicksOf(picks, text, inventory) {
  if (!picks || picks.size === 0) return null
  const words = new Set(String(text || '').split(/\s+/))
  const out = new Map()
  for (const [name, pick] of picks) {
    const mine = inventory?.get(name)
    if (mine && pick.hash && mine.hash === pick.hash && hsWordIn(words, name)) out.set(name, mine)
  }
  return out.size ? out : null
}

// Modifiers (`w! Kappa`, `Kappa ffzX`) on a native row: for each modifier word, the index of the
// word it changes. The rule is lib/modifiers.js hsModSide, the one the overlay's rows are drawn by
// (shared/emote-mods.vectors.json is it as data; tests/native-modifier-binding.test.js runs it here).
// `words` is the line split on whitespace (gaps may stay in the list);
// `isEmote(i, ahead)` says whether word i is drawn as an emote, and is asked with
// ahead=true when a word reaches forward (an emoji takes a word typed after it
// but is never reached for). A word with no emote on either side is not in the
// answer: it is drawn as typed, as the emote of its name when there is one.
export function hsModBind(words, isEmote) {
  const out = new Map()
  // every modifier word starts with one of its tokens: `x!` or `ffz…`
  const isMod = (w) => (w.charCodeAt(1) === 33 || w.startsWith('ffz')) && hsModClassify(w).kind === 'modifier'
  const blank = (w) => !w || !w.trim()
  let last = -1
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (blank(w)) continue
    if (!isMod(w.trim())) {
      last = isEmote(i, false) ? i : -1
      continue
    }
    let next = -1
    const ahead = () => {
      for (let j = i + 1; j < words.length; j++) {
        if (blank(words[j]) || isMod(words[j].trim())) continue
        next = isEmote(j, true) ? j : -1
        break
      }
      return next >= 0
    }
    const side = hsModSide(w.trim(), last >= 0, ahead)
    if (side) out.set(i, side === 'last' ? last : next)
    else last = isEmote(i, false) ? i : -1
  }
  return out
}

/**
 * The law's offer (multichat-core's lawNativeMatches) as the plain rows the native boxes draw and
 * the twitch hook reads across worlds: { name, url, hash, source, tier } for an emote (tier 0 the
 * room's, 1 yours, 2 a global), { name: ':cat:', emoji } for an emoji.
 */
export function hsNativeRows(matches) {
  return matches.map((m) =>
    m.type === 'emoji'
      ? { name: m.name, emoji: m.emoji }
      : { name: m.name, url: m.url, hash: m.hash, source: m.source, tier: m.tier, sub: !!m.sub },
  )
}
