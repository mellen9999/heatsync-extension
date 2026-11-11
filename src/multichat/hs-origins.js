// Which chat lines were sent THROUGH heatsync, by message id, for every viewer.
// The server records an origin row per (platform, message id) and tells the room
// (`chat:origin`) when a new one lands; the background relays it here and seeds a
// channel's last 24h. A line whose id is in the set wears [H]: born [H] when it
// renders after the origin is known, flipped in place when the origin arrives
// after the row is on screen ([T]/[K]/[Y] -> [H] is the only legal mark change).
// Keyed by id, NEVER by text: someone else's "gm" is not yours.

const HS_ORIGIN_CAP = 20000
const hsOriginIds = new Map() // `${platform}:${id}` -> sendId ('' when none)
const hsOriginSeeded = {} // platform -> Map(channel -> time it may be asked again; Infinity once seeded or in flight)

function hsOriginPlat(p) {
  const s = String(p || 'twitch').toLowerCase()
  return s === 'yt' ? 'youtube' : s
}

function hsOriginNote(platform, id, sendId) {
  if (!id) return
  const key = `${hsOriginPlat(platform)}:${id}`
  if (!hsOriginIds.has(key) && hsOriginIds.size >= HS_ORIGIN_CAP) hsOriginIds.delete(hsOriginIds.keys().next().value)
  hsOriginIds.set(key, sendId ? String(sendId) : '')
}

// Stamp a row: m.hsOrigin (+ m.hsSendId) when its id is a known heatsync send.
// Never un-stamps (M5). The first row of a channel also asks for that channel's
// seed. Returns true when the row is [H].
function hsOriginStamp(m) {
  if (!m || m.type || !m.id) return !!m?.hsOrigin
  const plat = hsOriginPlat(m.badgePlatform || m.platform)
  if (!m.hsOrigin) {
    const sid = hsOriginIds.get(`${plat}:${m.id}`)
    if (sid !== undefined) {
      m.hsOrigin = true
      if (sid) m.hsSendId = sid
    }
  }
  const ch = m.channel ? String(m.channel).toLowerCase().replace(/^@/, '') : ''
  if (ch) {
    const seen = hsOriginSeeded[plat] || (hsOriginSeeded[plat] = new Map())
    if (Date.now() >= (seen.get(ch) ?? 0)) {
      seen.set(ch, Number.POSITIVE_INFINITY)
      hsOriginSeed(plat, ch)
    }
  }
  return !!m.hsOrigin
}

// One GET at a time through the background's api proxy (~10 channels must not trip the
// per-IP limit). The server keeps the last 24h, so a tab opened later gets the same answer.
let hsOriginQueue = Promise.resolve()
function hsOriginSeed(platform, channel) {
  const path = `/api/chat/origins?platform=${platform}&channel=${encodeURIComponent(channel)}&limit=500`
  hsOriginQueue = hsOriginQueue
    .then(() => safeSendMessage({ type: 'api_fetch', path }))
    .then((res) => {
      const list = res?.data?.origins
      if (!Array.isArray(list)) {
        hsOriginSeeded[platform].set(channel, Date.now() + 60_000) // failed: one retry a minute, on a row
        return
      }
      for (const o of list) if (o?.origin === 'heatsync') hsOriginNote(platform, o.message_id, o.send_id)
      hsOriginRepaint()
    })
    .catch(() => hsOriginSeeded[platform].set(channel, Date.now() + 60_000))
}

// the one DOM patch for "this row is [H] now": the mark span's class, colour, text
function hsMarkBadgeHeatsync(pb) {
  const hm = platformMark('heatsync')
  pb.className = `hs-mc-platform-badge hs-mc-pb-${hm.cls}`
  pb.style.color = hm.color
  pb.textContent = hm.label
}

// flip every on-screen row whose id just became known
function hsOriginRepaint() {
  if (typeof document === 'undefined') return
  const rows = document.getElementById('hs-mc-messages')?.children
  if (!rows) return
  for (const div of rows) {
    const m = div._hsMsg
    if (!m || m.hsOrigin || !hsOriginStamp(m)) continue
    const pb = div.querySelector('.hs-mc-platform-badge')
    if (pb) hsMarkBadgeHeatsync(pb)
  }
}

// a live `chat:origin` (relayed by the background)
function hsOriginLive(msg) {
  hsOriginNote(msg.platform, msg.id, msg.sendId)
  hsOriginRepaint()
}

export { hsMarkBadgeHeatsync, hsOriginLive, hsOriginNote, hsOriginRepaint, hsOriginStamp }
