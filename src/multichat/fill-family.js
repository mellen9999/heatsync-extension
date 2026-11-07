// Filled rows: the notification rows that wear a solid fill (the dim ANSI twin of the
// row's meaning colour — olive, purple, navy, teal; the CSS owns which class gets which).
// The ONE place that says which rows are filled: the stripe skips them, the name sits
// on a black cutout, and two touching filled rows are split by a gap.
// Mirrors the site's client/chat/fill-family.js.

/** Chat / system rows that are filled (stream-event rows are matched by FILLED_EVENT). */
const FILL_SELECTOR =
  '.hs-mc-notice-sub, .hs-mc-notice-gift, .hs-mc-notice-raid, .hs-mc-notice-bits, .hs-mc-notice-announce, ' +
  '.hs-mc-notice-milestone, .hs-mc-notice-watchstreak, .hs-mc-notice-charity, .hs-mc-notice-mod-anniversary, ' +
  '.hs-mc-kicks, .hs-mc-user-intro, .hs-mc-animated, .hs-mc-redeemed, .hs-mc-highlighted, .hs-mc-rule-highlight, ' +
  '.hs-mc-first-msg, .hs-mc-superchat'

/** The stream-event classes that are filled. */
const FILLED_EVENT =
  /event-(?:update|online|offline|hype|poll|pred|emote|raid|sub|redeem|yt-superchat|yt-supersticker|yt-membership|yt-milestone|yt-gift)\b/

// A rule highlight is the dim twin of the colour the rule chose. Exact ANSI hexes only;
// anything else falls back to the stripe grey.
const RULE_FILL = new Map([
  ['#ff0000', 'var(--hs-fill-maroon)'],
  ['#00ff00', 'var(--hs-fill-green)'],
  ['#ffff00', 'var(--hs-fill-olive)'],
  ['#8888ff', 'var(--hs-fill-navy)'],
  ['#ff00ff', 'var(--hs-fill-purple)'],
  ['#00ffff', 'var(--hs-fill-teal)'],
  ['#ffffff', 'var(--hs-zebra)'],
])

/**
 * The fill a rule's highlight colour becomes (a token reference).
 * @param {string} color a #rrggbb the rule chose
 * @returns {string}
 */
function ruleFillVar(color) {
  return RULE_FILL.get(String(color || '').trim().toLowerCase()) || 'var(--hs-zebra)'
}
