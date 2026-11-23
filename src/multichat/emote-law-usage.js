// What you use (docs/emote-law-map.md R16, shared/emote-usage.ts): how often you send a name, which
// is the law's "names you use" (Tab's second tier), and the pictures you sent last, which are the
// picker's recents. Both are written once, as a line leaves the composer: a pick never sent and a
// Tab step cycled past count nothing. They stay in this site's storage on this device.

// the record the page composers read too: { name: { n, t } }
const LAW_USES_KEY = 'hs-mc-emote-frecency'
// newest first: "name\npicture" (the picture as _acPicKey names it, whatever size or format it
// came in), or a bare name from a list kept before recents were pictures
const LAW_RECENT_KEY = 'hs-mc-recent-emotes'

function lawUsageRead(key) {
  try {
    return localStorage.getItem(key)
  } catch (_) {
    return null
  }
}

function lawUsesRecord(raw) {
  try {
    const r = JSON.parse(raw)
    if (r && typeof r === 'object' && !Array.isArray(r)) return r
  } catch (_) {}
  return {}
}

// Tab asks on every keystroke: the scores are built once per stored value
let _lawUses = { raw: null, map: null }

/** name -> how much you use it (> 0 = you have sent it), halving weekly */
function loadEmoteFrecency() {
  const raw = lawUsageRead(LAW_USES_KEY)
  if (_lawUses.map && _lawUses.raw === raw) return _lawUses.map
  const rec = lawUsesRecord(raw)
  const now = Date.now()
  const map = new Map()
  for (const name of Object.keys(rec)) {
    const s = hsEmoteLaw.useScore(rec[name], now)
    if (s > 0) map.set(name, s)
  }
  _lawUses = { raw, map }
  return map
}

/** the stored recents, newest first */
function loadRecentEmotes() {
  try {
    const r = JSON.parse(lawUsageRead(LAW_RECENT_KEY))
    return Array.isArray(r) ? r.filter((k) => typeof k === 'string' && k) : []
  } catch (_) {
    return []
  }
}

/** a line left the composer carrying these emotes: [{ name, url }] (lawShip's `used`) */
function lawNoteSent(used) {
  if (!used?.length) return
  try {
    const uses = hsEmoteLaw.countUses(
      lawUsesRecord(lawUsageRead(LAW_USES_KEY)),
      used.map((u) => u.name),
      Date.now(),
    )
    localStorage.setItem(LAW_USES_KEY, JSON.stringify(uses))
    const keys = used.map((u) => `${u.name}\n${_acPicKey(u.url)}`)
    localStorage.setItem(LAW_RECENT_KEY, JSON.stringify(hsEmoteLaw.pushRecents(loadRecentEmotes(), keys)))
  } catch (_) {}
}

/**
 * The recents as tiles: each is the very picture that was sent, looked up where the picker looks
 * (`maps`, in its order). One this tab cannot reach is absent, never swapped for another emote of
 * the name. A bare name (the old list) reads as the name's first emote here.
 * @param {Array<Map>} maps name -> entry
 * @returns {Array<[string, object]>}
 */
function lawRecentTiles(maps) {
  const out = []
  for (const k of loadRecentEmotes()) {
    const cut = k.indexOf('\n')
    const name = cut < 0 ? k : k.slice(0, cut)
    const pic = cut < 0 ? null : k.slice(cut + 1)
    for (const m of maps) {
      const e = m.get(name)
      if (e?.url && (pic === null || _acPicKey(e.url) === pic)) {
        out.push([name, e])
        break
      }
    }
  }
  return out
}
