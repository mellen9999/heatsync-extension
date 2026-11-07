// Filled rows: which fill a notification row wears. The palette, labels and the
// rule-colour map are the site's shared/brand/tokens.json (mirrored as lib/brand-tokens.js);
// the CSS that paints them is styles/21-brand-rows.css, also a byte copy. This file only
// classifies THIS renderer's rows into the shared vocabulary:
//   hs-filled hs-fill-<olive|purple|navy|teal|red|rule> hs-row-label hs-name-cut
// Mirrors the site's client/chat/fill-family.js.

const EVENT_FILL = [
  [/event-(?:update|online|offline|hype|poll|pred|emote)\b/, 'olive'],
  [/event-raid\b/, 'purple'],
  [/event-(?:sub|yt-superchat|yt-supersticker|yt-membership|yt-milestone|yt-gift)\b/, 'navy'],
  [/event-redeem\b/, 'teal'],
]

/** the fill a stream-event row wears ('' = not a filled event) */
function eventFill(eventClass) {
  const c = eventClass || ''
  for (const [re, fill] of EVENT_FILL) if (re.test(c)) return fill
  return ''
}

const NAVY_NOTICES =
  /\bhs-mc-notice-(?:sub|gift|bits|milestone|watchstreak|charity|mod-anniversary)\b|\bhs-mc-kicks\b|\bhs-mc-superchat\b/

/** the fill a chat / system row wears ('' = a plain row) */
function rowFill(el) {
  const k = el.classList
  if (k.contains('hs-row-mention')) return 'red' // a mention / reply to you: the red fill, filled like the rest (no stripe)
  if (k.contains('hs-mc-rule-highlight')) return 'rule'
  if (k.contains('hs-mc-notice-raid') || k.contains('hs-mc-user-intro') || k.contains('hs-mc-first-msg'))
    return 'purple'
  if (
    k.contains('hs-mc-notice-announce') ||
    k.contains('hs-mc-redeemed') ||
    k.contains('hs-mc-highlighted') ||
    k.contains('hs-mc-animated')
  )
    return 'teal'
  if (k.contains('hs-mc-automod') || k.contains('hs-mc-notice-error')) return 'red'
  return NAVY_NOTICES.test(el.className) ? 'navy' : ''
}

/** a rule's highlight colour -> the token the row's fill reads (the zebra grey when it is not one of the eight) */
function ruleFillVar(color) {
  const name =
    RULE_FILL[
      String(color || '')
        .trim()
        .toLowerCase()
    ]
  return name && name !== 'zebra' ? `var(--brand-fill-${name})` : 'var(--brand-zebra)'
}
