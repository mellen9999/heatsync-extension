/**
 * Emote search ranking — the one rule every surface (Tab cycle, picker,
 * colon dropdown, /api/emote-search) orders remote results by.
 *
 * Match quality and popularity are BLENDED, not stacked, then DIVERSIFIED:
 *
 *   base = log10(1 + pop) + BONUS[bucket] - lengthPenalty
 *
 * BONUS: prefix +0.30, boundary +0.20, substring -0.30. A match is a
 * BOUNDARY only where a reader would see a word start: the previous char is
 * not a letter (4_|relaxed), a real camel hump (vibe|Pls: uppercase after
 * lowercase), or the match runs to the end of the name (vibePls, OMEGALUL,
 * SadCat). `cat` inside SCATTER is a substring, not a boundary. Names much
 * longer than the query lose 0.02 per extra char past 6, capped at 0.6.
 *
 * Diversify: one popular family (KappaChungus, KappaChungusDeluxe, ...
 * Kappa_420) must not fill the whole list. Candidates are picked greedily by
 * `base - 0.6 * fam`, where fam counts the already-picked names sharing this
 * name's stem (the query plus 4 chars) or being a prefix-root of it (numeric/
 * underscore tails stripped, so AlienPls3 is AlienPls's family). The family
 * state is shared across `group`s, so a later group does not repeat what an
 * earlier one already showed.
 *
 * Order: exact name first (most popular copy), then by group, each group
 * diversified, then items with no `pop` (upstream-only; by bucket, then
 * incoming order — the catalog holds everything >= 3 channels carry, so an
 * unmeasured emote is by construction a rarer one), then tag-only hits whose
 * name does not contain the query at all (CatTime for `pls`).
 *
 * `pop` is the number of channels carrying the emote (server/services/
 * emote-catalog.ts) — one unit across 7tv/bttv/ffz.
 */

export const BUCKET_EXACT = 0
export const BUCKET_PREFIX = 1
export const BUCKET_BOUNDARY = 2
export const BUCKET_SUBSTRING = 3
export const BUCKET_NONE = 4

const BONUS = [0.3, 0.3, 0.2, -0.3, 0]
const FAMILY_WEIGHT = 0.6
const LEN_FREE = 6
const LEN_STEP = 0.02
const LEN_CAP = 0.6

const isUpper = (c: string | undefined) => !!c && c >= 'A' && c <= 'Z'
const isLower = (c: string | undefined) => !!c && c >= 'a' && c <= 'z'
const isAlpha = (c: string | undefined) => isUpper(c) || isLower(c)

/** q must already be lowercase. */
export function matchBucket(name: string, q: string): number {
  const n = name.toLowerCase()
  if (n === q) return BUCKET_EXACT
  if (n.startsWith(q)) return BUCKET_PREFIX
  let pos = n.indexOf(q)
  if (pos === -1) return BUCKET_NONE
  // Any occurrence counts, not just the first: `xplsPls` → hump.
  while (pos !== -1) {
    const prev = name[pos - 1]
    if (!isAlpha(prev) || (isUpper(name[pos]) && isLower(prev)) || pos + q.length === n.length) return BUCKET_BOUNDARY
    pos = n.indexOf(q, pos + 1)
  }
  return BUCKET_SUBSTRING
}

function baseScore(name: string, q: string, pop: number, bucket: number): number {
  const over = Math.max(0, name.length - q.length - LEN_FREE)
  return Math.log10(1 + Math.max(0, pop || 0)) + BONUS[bucket] - Math.min(LEN_CAP, LEN_STEP * over)
}

/** q must already be lowercase. */
export function scoreEmote(name: string, q: string, pop: number): number {
  return baseScore(name, q, pop, matchBucket(name, q))
}

export interface RankableEmote {
  name: string
  /** channels carrying it; absent = not in the catalog (upstream-only) */
  pop?: number
}

export interface RankOpts<T> {
  /** lower groups list first; family state is shared across groups. default 0 */
  group?: (e: T) => number
  /** override where the popularity comes from. default e.pop */
  popOf?: (e: T) => number | undefined
  /** the word as typed, case kept: among exact-name matches the one spelled exactly like it leads (rule 5) */
  typed?: string
}

interface Cand<T> {
  e: T
  i: number
  b: number
  base: number
  known: boolean
  g: number
  norm: string
  key: string
  len: number
  /** picked names in this candidate's family; kept current as picks land */
  fam: number
}

const cmpName = <T extends RankableEmote>(a: Cand<T>, b: Cand<T>) => a.len - b.len || a.e.name.localeCompare(b.e.name)

interface Family {
  keys: Map<string, number>
  roots: Set<string>
}

function diversify<T extends RankableEmote>(pool: Cand<T>[], q: string, st: Family): T[] {
  const out: T[] = []
  const minRoot = q.length + 3
  const rest = pool.slice().sort((a, b) => b.base - a.base || cmpName(a, b))
  for (const c of rest) {
    c.fam = st.keys.get(c.key) || 0
    for (let j = minRoot; j < c.norm.length; j++) if (st.roots.has(c.norm.slice(0, j))) c.fam++
  }
  while (rest.length) {
    let bi = 0, bestEff = -Infinity
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (c.base <= bestEff) break
      const eff = c.base - FAMILY_WEIGHT * c.fam
      if (eff > bestEff || (eff === bestEff && cmpName(c, rest[bi]) < 0)) { bestEff = eff; bi = i }
    }
    const [p] = rest.splice(bi, 1)
    out.push(p.e)
    const newRoot = p.norm.length >= minRoot && !st.roots.has(p.norm)
    st.keys.set(p.key, (st.keys.get(p.key) || 0) + 1)
    if (newRoot) st.roots.add(p.norm)
    for (const c of rest) {
      if (c.key === p.key) c.fam++
      if (newRoot && c.norm.length > p.norm.length && c.norm.startsWith(p.norm)) c.fam++
    }
  }
  return out
}

/**
 * Rank + dedupe by EXACT name (the most-used copy wins: 7TV alone has 25 emotes
 * named `pls`). Case is part of the name (rule 5: KEKW and kekw are two emotes), so
 * case twins are two candidates; only matching the typed prefix ignores case.
 * See the header for the order. q must be lowercase.
 */
export function rankEmotes<T extends RankableEmote>(list: T[], q: string, opts: RankOpts<T> = {}): T[] {
  const popOf = opts.popOf ?? ((e: T) => e.pop)
  const groupOf = opts.group
  const best = new Map<string, Cand<T>>()
  list.forEach((e, i) => {
    if (!e?.name) return
    const lower = e.name.toLowerCase()
    const pop = popOf(e)
    const known = typeof pop === 'number'
    const b = matchBucket(e.name, q)
    const base = known ? baseScore(e.name, q, pop as number, b) : -1
    const prev = best.get(e.name)
    if (prev && !(known && (!prev.known || base > prev.base))) return
    const norm = lower.replace(/[\d_]+$/, '') || lower
    const at = Math.max(0, lower.indexOf(q))
    best.set(e.name, { e, i, b, base, known, g: groupOf ? groupOf(e) : 0, norm, key: norm.slice(0, at + q.length + 4), len: e.name.length, fam: 0 })
  })
  const exact: Cand<T>[] = [], groups = new Map<number, Cand<T>[]>(), unknown: Cand<T>[] = [], tagOnly: Cand<T>[] = []
  for (const c of best.values()) {
    if (c.b === BUCKET_EXACT) exact.push(c)
    else if (c.b === BUCKET_NONE) tagOnly.push(c)
    else if (!c.known) unknown.push(c)
    else {
      const g = groups.get(c.g)
      if (g) g.push(c)
      else groups.set(c.g, [c])
    }
  }
  const byPop = (a: Cand<T>, b: Cand<T>) => b.base - a.base || cmpName(a, b)
  const byBucket = (a: Cand<T>, b: Cand<T>) => a.b - b.b || a.i - b.i
  const st: Family = { keys: new Map(), roots: new Set() }
  const typed = opts.typed
  const spelled = (c: Cand<T>) => (typed && c.e.name === typed ? 0 : 1)
  const out: T[] = exact.sort((a, b) => spelled(a) - spelled(b) || byPop(a, b)).map(c => c.e)
  for (const g of [...groups.keys()].sort((a, b) => a - b)) out.push(...diversify(groups.get(g) as Cand<T>[], q, st))
  out.push(...unknown.sort(byBucket).map(c => c.e), ...tagOnly.sort((a, b) => (a.known !== b.known ? (a.known ? -1 : 1) : a.known ? byPop(a, b) : a.i - b.i)).map(c => c.e))
  // rule 5: case twins keep their slots, but the one spelled the way the word was typed leads its twin
  if (typed) {
    const slots = new Map<string, number[]>()
    out.forEach((e, i) => { const key = e.name.toLowerCase(); const l = slots.get(key); if (l) l.push(i); else slots.set(key, [i]) })
    for (const idx of slots.values()) {
      if (idx.length < 2) continue
      const lead = idx.map(i => out[i]).sort((a, b) => Number(!a.name.startsWith(typed)) - Number(!b.name.startsWith(typed)))
      idx.forEach((i, n) => { out[i] = lead[n] })
    }
  }
  return out
}
