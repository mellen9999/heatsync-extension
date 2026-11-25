// While a room draws a provider's SAVED emotes (the background kept the last good set because a
// refetch failed), the status strip says so: "7tv is down — showing saved emotes". Fresh data
// clears it. The same line as the site's chat tile (web_chat_tile_emote_outage_*).

const emoteOutageByRoom = new Map() // "platform:owner" → ['7tv', 'bttv', 'ffz'] subset

const emoteOutageKey = (platform, owner) =>
  `${platform || 'twitch'}:${String(owner || '')
    .toLowerCase()
    .replace(/^@/, '')}`

/** the line for 1-3 providers ('' for none) */
function emoteOutageLine(providers) {
  const p = providers.slice(0, 3)
  return p.length ? t(`mc_emote_outage_${p.length}`, p) : ''
}

/** a channel_emotes_update says which providers its set is saved for; none = fresh */
function noteEmoteOutage(msg) {
  const key = emoteOutageKey(msg.platform, msg.channelOwner)
  const stale = Array.isArray(msg.stale) ? msg.stale : []
  if (stale.length) emoteOutageByRoom.set(key, stale)
  else emoteOutageByRoom.delete(key)
  renderEmoteOutage()
}

/** the open tab's rooms: every stale provider among them, once, in the site's order */
function openEmoteOutage() {
  if (!emoteOutageByRoom.size) return []
  const legs = typeof lawOpenLegs === 'function' ? lawOpenLegs() : {}
  const held = new Set()
  for (const [platform, owner] of Object.entries(legs)) {
    if (owner) for (const p of emoteOutageByRoom.get(emoteOutageKey(platform, owner)) || []) held.add(p)
  }
  return ['7tv', 'bttv', 'ffz'].filter((p) => held.has(p))
}

function renderEmoteOutage() {
  const bar = document.getElementById('hs-mc-statusbar')
  if (!bar) return
  const text = emoteOutageLine(openEmoteOutage())
  let el = document.getElementById('hs-mc-emote-outage')
  if (!text) {
    if (el) el.hidden = true
    return
  }
  if (!el) {
    el = document.createElement('div')
    el.id = 'hs-mc-emote-outage'
    el.setAttribute('role', 'status')
    bar.appendChild(el)
  }
  el.textContent = text
  el.hidden = false
}
