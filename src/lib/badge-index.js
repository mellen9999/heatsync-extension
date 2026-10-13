// @ts-check
// Third-party badge maps (ffz ~83k users, chatterino ~9k) as a sorted id
// column + a badge column instead of a Map of per-user objects.
//
// The Map form cost ~8MB in every tab: extension messaging deep-copies, so
// each user arrived with its own { title, color, url } and its own copy of
// the url string — once per script holding it, in every open tab, and again
// in the SW. Here each badge exists once and a user costs 6 bytes (u32 id +
// u16 badge). Lookup is a binary search; get/has/size keep the Map surface
// the call sites already use, with get() always returning a list.
//
// Wire + storage shape (the SW builds it): [{ ...badge, ids: [twitchUserId] }]

export class BadgeIndex {
  /** @param {unknown} list */
  constructor(list) {
    /** @type {object[]} */
    this.badges = []
    /** @type {number[]} */
    const keys = []
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.ids)) continue
      if (this.badges.length >= 0xffff) break
      const { ids, ...badge } = entry
      const b = this.badges.push(badge) - 1
      for (const raw of ids) {
        const id = Number(raw)
        // twitch user ids are positive integers; the key packs id·2^16 + badge
        // (< 2^48, exact in a double) so one numeric sort orders both columns
        if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) keys.push(id * 0x10000 + b)
      }
    }
    const sorted = Float64Array.from(keys).sort()
    this.ids = new Uint32Array(sorted.length)
    this.badgeOf = new Uint16Array(sorted.length)
    let users = 0
    for (let i = 0; i < sorted.length; i++) {
      const id = Math.floor(sorted[i] / 0x10000)
      this.ids[i] = id
      this.badgeOf[i] = sorted[i] - id * 0x10000
      if (i === 0 || this.ids[i - 1] !== id) users++
    }
    this.size = users
  }

  /** first row for `id`, or -1 */
  _find(uid) {
    const id = Number(uid)
    if (!(id > 0)) return -1
    const ids = this.ids
    let lo = 0
    let hi = ids.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (ids[mid] < id) lo = mid + 1
      else hi = mid
    }
    return lo < ids.length && ids[lo] === id ? lo : -1
  }

  /** @param {string|number} uid */
  has(uid) {
    return this._find(uid) !== -1
  }

  /**
   * Every badge the user has, in the order the SW listed the badges.
   * @param {string|number} uid
   * @returns {any[]|undefined}
   */
  get(uid) {
    let i = this._find(uid)
    if (i === -1) return undefined
    const id = this.ids[i]
    const out = []
    for (; i < this.ids.length && this.ids[i] === id; i++) out.push(this.badges[this.badgeOf[i]])
    return out
  }
}
