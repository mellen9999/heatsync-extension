// @ts-check
/**
 * The emote provider order and the one pool ranker (rule 3). The service worker
 * (background.js) cannot import, so build.js concatenates this file into it ahead
 * of its parts (BG_LIB) and into every content bundle with utils.js: one definition,
 * three scopes. Keep it free of anything but these two names.
 */

/**
 * The ONE provider order for a bare word with no sender ref (rule 3), winner first:
 * a channel's set is ffz, 7tv, bttv; globals are 7tv, bttv, ffz, twitch. Platform
 * natives (twitch/kick) trail the third parties in a channel: they arrive as tokens
 * (rule 1), a bare word never lets one beat a 7tv/bttv/ffz copy. background.js
 * carries this very file (build.js BG_LIB), so there is no second array.
 * @type {{channel: readonly string[], global: readonly string[]}}
 */
export const EMOTE_TIER_ORDER = {
  channel: ['heatsync', 'ffz', '7tv', 'bttv', 'twitch', 'kick'],
  global: ['7tv', 'bttv', 'ffz', 'twitch', 'heatsync'],
}

/**
 * Stable re-rank of a pool array so index 0 is the winner for every name: in a channel,
 * entries with no `source` (the owner's heatsync set) stay in front, then providers by tier
 * order, unknown providers last. Returns a new array; the input is untouched.
 * @param {Array<{source?: string}>} list
 * @param {'channel'|'global'} tier
 */
export function rankEmotePool(list, tier) {
  const order = EMOTE_TIER_ORDER[tier] || EMOTE_TIER_ORDER.global
  const rank = (e) => {
    if (!e?.source) return tier === 'channel' ? -1 : order.length
    const i = order.indexOf(e.source)
    return i === -1 ? order.length : i
  }
  // Array.prototype.sort is stable: equal ranks keep their input order
  return [...(list || [])].sort((a, b) => rank(a) - rank(b))
}
