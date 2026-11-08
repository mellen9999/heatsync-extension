/**
 * badge-catalogue.js — the heatsync badge catalogue and the pure rule that
 * decides who has which.
 *
 * Dependency-free on purpose: the server imports it (award + validation), the
 * site renders from it, and the extension takes it byte for byte
 * (scripts/sync-paint-compiler.sh, same mirror as plus-tenure.js). One list,
 * three readers, nothing to drift.
 *
 * Badges are COMPUTED, never hand-assigned: earnedBadgeIds() is a function of
 * facts the database already holds. A badge that cannot be derived from
 * existing data does not belong here. Adding one = a new entry below, its
 * words in every locale, and a version bump.
 *
 * The wire carries ONLY the id of the badge a user shows. Glyph, colour and the
 * words stay on the reader's side, so a catalogue change never has to be
 * pushed to anyone and a reader that does not know an id simply draws nothing.
 *
 * Words live in the locale files, keyed `badge_<id>_label` (what it is called)
 * and `badge_<id>_how` (how it is earned). The site prefixes them with `web_`.
 *
 * Colours are ANSI 0-7 only. Glyphs are plain text from the geometric-shapes
 * block the bitmap fonts draw.
 *
 * @module utils/badge-catalogue
 */

/** Bump when an entry is added or its rule changes. */
export const BADGE_CATALOGUE_VERSION = 2

/**
 * Accounts created before this instant are "early supporters". Taken from the
 * real signup curve (checked 2026-11-08): 98 accounts before 2026-05, 12 in
 * May, 933 in June, then the launch wave. Everything before July is the first
 * ~1,000 accounts, the people who were here before anyone had heard of it.
 * A named constant, not a column: moving it is a one-line, reviewable change.
 */
export const EARLY_SUPPORTER_CUTOFF = '2026-07-01T00:00:00.000Z'

/** The saved choice meaning "show nothing". */
export const BADGE_CHOICE_NONE = 'none'

/**
 * rank: which badge shows when the user has not picked one (higher wins).
 * months: plus tenure needed, for the plus_* family.
 */
export const BADGES = Object.freeze([
  { id: 'staff', glyph: '■', color: '#ffffff', rank: 100 },
  { id: 'plus_24m', glyph: '★', color: '#ff00ff', rank: 90, months: 24 },
  { id: 'plus_12m', glyph: '★', color: '#ffff00', rank: 80, months: 12 },
  { id: 'plus_6m', glyph: '◆', color: '#00ff00', rank: 70, months: 6 },
  { id: 'plus_3m', glyph: '◆', color: '#00ffff', rank: 60, months: 3 },
  { id: 'plus_1m', glyph: '◇', color: '#00ffff', rank: 50, months: 1 },
  { id: 'ember', glyph: '▲', color: '#ff0000', rank: 25 },
  { id: 'early_supporter', glyph: '●', color: '#8888ff', rank: 20 },
])

const BY_ID = new Map(BADGES.map((b) => [b.id, b]))

/** The catalogue entry for an id, or null for an id this reader does not know. */
export function badgeById(id) {
  return typeof id === 'string' ? (BY_ID.get(id) ?? null) : null
}

/**
 * Every badge a user has earned, best first (BADGES is already in rank order).
 *
 * Plus tenure counts only while Plus is active: tenure is public only while
 * entitled everywhere else (profile, the `plus` map in /api/paints), and a
 * badge must not advertise a membership that ended.
 *
 * @param {{
 *   createdAt?: Date|string|null,
 *   plusActive?: boolean,
 *   plusMonths?: number,
 *   hasEmber?: boolean,
 *   isStaff?: boolean,
 * }} facts
 * @returns {string[]} badge ids, highest rank first
 */
export function earnedBadgeIds(facts) {
  const f = facts || {}
  const earned = []
  for (const b of BADGES) {
    if (b.id === 'staff') {
      if (f.isStaff) earned.push(b.id)
    } else if (b.id === 'ember') {
      if (f.hasEmber) earned.push(b.id)
    } else if (b.id === 'early_supporter') {
      const t = f.createdAt instanceof Date ? f.createdAt.getTime() : Date.parse(f.createdAt ?? '')
      if (Number.isFinite(t) && t < Date.parse(EARLY_SUPPORTER_CUTOFF)) earned.push(b.id)
    } else if (b.months && f.plusActive && (Number(f.plusMonths) || 0) >= b.months) {
      earned.push(b.id)
    }
  }
  return earned
}

/**
 * The one badge a user shows: only what they picked, and only while they still
 * have it. Nothing is shown automatically — the 🔥 already says "heatsync user",
 * a picked badge takes its place, and two marks on one name is one too many.
 * null/undefined/'none' = nothing; a pick they no longer qualify for (Plus
 * lapsed) = nothing, never a badge they did not choose.
 *
 * @param {string[]} earned from earnedBadgeIds()
 * @param {string|null|undefined} choice
 * @returns {string|null}
 */
export function displayedBadgeId(earned, choice) {
  if (!choice || choice === BADGE_CHOICE_NONE || !Array.isArray(earned)) return null
  return earned.includes(choice) ? choice : null
}

/** Is `choice` something a user may save? (null or 'none' = nothing, else a known id.) */
export function isValidBadgeChoice(choice) {
  return choice === null || choice === BADGE_CHOICE_NONE || BY_ID.has(choice)
}
