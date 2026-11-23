/**
 * How much a person uses an emote name, and which pictures they sent last
 * (docs/emote-law.md: offer tier 2, browse). Pure: each client keeps the two
 * small records wherever it keeps things. They stay on the device: syncing them
 * would mean storing what someone types.
 */
export interface Use { n: number; t: number }
export type Uses = Record<string, Use>

export const USE_HALF_LIFE_MS = 7 * 24 * 3600e3
export const USE_CAP = 200
export const RECENT_CAP = 24

/** a count that halves each week since the last use: an old habit fades, one stray send never beats a real one */
export function useScore(u: Use | null | undefined, now: number): number {
  if (!u || typeof u.n !== 'number' || !(u.n > 0)) return 0
  const age = Math.max(0, now - (typeof u.t === 'number' ? u.t : 0))
  return u.n * 2 ** (-age / USE_HALF_LIFE_MS)
}

/**
 * One sent line: each distinct name counts once, on top of what is left of its
 * old count. Past the cap the least used go. Returns a new record; a name can be
 * anything (`__proto__` included), so it has no prototype to collide with.
 */
export function countUses(uses: Uses | null | undefined, names: Iterable<string>, now: number): Uses {
  const out: Uses = Object.create(null)
  if (uses && typeof uses === 'object' && !Array.isArray(uses)) {
    for (const k of Object.keys(uses)) if (useScore(uses[k], now) > 0) out[k] = uses[k]
  }
  for (const name of new Set(names)) {
    if (name) out[name] = { n: Math.round((useScore(out[name], now) + 1) * 1e4) / 1e4, t: now }
  }
  const keys = Object.keys(out)
  if (keys.length > USE_CAP) {
    keys.sort((a, b) => useScore(out[a], now) - useScore(out[b], now) || (a < b ? -1 : 1))
    for (const k of keys.slice(0, keys.length - USE_CAP)) delete out[k]
  }
  return out
}

/** the pictures a line just sent go to the front, each once, in the line's order */
export function pushRecents(list: readonly string[], keys: readonly string[]): string[] {
  return [...new Set([...keys, ...list])].slice(0, RECENT_CAP)
}
