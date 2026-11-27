// A twitch VOD (/videos/<id>) has no live chat. Twitch draws its own replay chat there, synced to
// the playhead (seek, pause, any age), and keeps drawing it while its column is hidden. This tab
// mirrors those rows into the pane, so the replay reads like any other tab: heatsync emotes, name
// styling, paints. The `vod` tab exists only on that page; it is never saved, restored or synced.
//
// A row of the replay, as twitch draws it:
//   li > .vod-message > .vod-message__header (timestamp) + div > div > div >
//        [span > img.chat-badge] + a > span[data-a-target=chat-message-username]
//        + div.video-chat__message > span(":") + span(text fragments, emote imgs)
// Twitch gives no row ids. The newest row seen is the cursor: rows after it are new; when it is
// gone the list was replaced (a seek) and the tab is rebuilt from what twitch shows now.
//
// A replay row is not a live message: every row carries `replay: true`, the one flag the pane reads
// to leave its live-only habits off it (the first-message glow and the seen set, mention marks,
// highlight rules, the thread button, reply / mod / pin / post actions) and to show the video's own
// offset in the stamp slot. The tab is its own buffer: no live buffer, mentions list, counter,
// archive or relay ever sees a row, and the tab takes replay rows only (appendMessage).
// One observer queues one frame; the frame mirrors every row twitch drew since the last one.

const VOD_LIST = '.video-chat__message-list-wrapper'
const VOD_ROW = '.vod-message'
const VOD_TICK_MS = 500
const VOD_TICKS_MAX = 40 // 20s for twitch to draw the replay list
const VOD_API_AFTER = 6 // ticks with no channel link on the page before the site is asked
const VOD_QUIET_MS = 10000 // playing this long with no replay row: the vod has no replay chat
const VOD_APPEND_MAX = 30 // a frame's rows are appended up to this many; a burst is one render
const VOD_EMOTE_SRC = /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\//
const VOD_AT = /\d{1,3}(?::\d{1,2}){0,2}/ // the offset twitch prints in a row's header: h:mm:ss, m:ss or ss

// every row the pane holds for the tab (renderMessages reads it, like mentionsBuffer)
const vodBuffer = []
let _vod = null // { id, owner, prev, ticks, timer, obs, ready, last, seq, queued, quiet, quietTimer }
let _vodClickOff = null // the stamp's click listener: held only while a vod page is open

/** "2:00:14", "5:07" or "45" → seconds; null for anything else */
function vodOffsetSecs(text) {
  const parts = String(text ?? '')
    .trim()
    .split(':')
  if (parts.length > 3 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}

/** a replay row's stamp: the video's own time, which seeks the video when clicked. '' without an offset
 *  (never a wall clock in its place) */
function vodStampHtml(m) {
  const at = String(m.replayAt || '')
  if (vodOffsetSecs(at) === null) return ''
  return `<span class="hs-mc-ts" role="button" data-hs-seek="${escapeHtml(at)}" title="${escapeHtml(t('mc_vod_seek'))}">${escapeHtml(at)}</span>`
}

// the stamp's click: the page's own video, to that second (a seek twitch then answers by replacing its list)
function vodStampClick(e) {
  const el = e.target?.closest?.('[data-hs-seek]')
  if (!el) return
  const secs = vodOffsetSecs(el.dataset.hsSeek)
  const video = document.querySelector('video')
  if (secs === null || !video) return
  e.preventDefault()
  video.currentTime = secs
}

// "rgb(r, g, b)" → "#rrggbb"; anything else passes through for sanitizeColor to judge
function vodColor(css) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(css || ''))
  if (!m) return String(css || '')
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`
}

// twitch's badge img → the "set/version" the pane renders badges from (the url carries only the
// badge's id): reverse of the url table twitch-api.js filled
let _vodBadgeIds = null
let _vodBadgeSize = -1
function vodBadgeKey(src) {
  const id = /\/badges\/v1\/([\w-]+)\//.exec(String(src || ''))?.[1]
  if (!id) return ''
  if (!_vodBadgeIds || _vodBadgeSize !== twitchBadgeUrls.size) {
    _vodBadgeIds = new Map()
    _vodBadgeSize = twitchBadgeUrls.size
    for (const [key, url] of twitchBadgeUrls) {
      const bid = /\/badges\/v1\/([\w-]+)\//.exec(String(url))?.[1]
      if (bid && !_vodBadgeIds.has(bid)) _vodBadgeIds.set(bid, key.slice(key.indexOf(':') + 1))
    }
  }
  return _vodBadgeIds.get(id) || ''
}

// the words of a message fragment tree: text as written, an emote img as its code (the pane draws
// its own), twitch's own emotes kept by name → url for the row's native-emote path
function vodText(node, emotes, top) {
  let out = ''
  let first = top
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      out += n.nodeValue
      continue
    }
    if (n.nodeType !== 1) continue
    if (first) {
      first = false
      if (n.textContent.trim() === ':') continue // the separator between name and message
    }
    if (n.getAttribute('role') === 'tooltip' || /tooltip/.test(String(n.className))) continue
    if (n.tagName === 'IMG') {
      const alt = n.getAttribute('alt') || ''
      const src = n.getAttribute('src') || ''
      out += alt
      if (alt && VOD_EMOTE_SRC.test(src) && !emotes[alt]) emotes[alt] = src
    } else out += vodText(n, emotes, false)
  }
  return out
}

/** One replay row → the message object every other tab holds. null for a row with no chatter
 *  (a notice twitch draws differently): it is skipped, never half-drawn. */
function vodRowToMsg(row, owner, id) {
  const nameEl = row.querySelector('[data-a-target="chat-message-username"]')
  const body = row.querySelector('.video-chat__message')
  if (!nameEl || !body) return null
  const user = nameEl.textContent.trim()
  const emotes = {}
  const text = vodText(body, emotes, true).trim()
  if (!user || !text) return null
  const href = nameEl.closest('a')?.getAttribute('href') || ''
  const login = (nameEl.getAttribute('data-a-user') || href.split('/').filter(Boolean).pop() || user).toLowerCase()
  const badges = [...row.querySelectorAll('img.chat-badge')]
    .map((img) => vodBadgeKey(img.getAttribute('src')))
    .filter(Boolean)
    .join(',')
  const css = nameEl.style?.color || (typeof getComputedStyle === 'function' ? getComputedStyle(nameEl).color : '')
  const at = VOD_AT.exec(row.querySelector('.vod-message__header')?.textContent || '')?.[0] || ''
  const msg = {
    user,
    login,
    userId: '',
    text,
    color: sanitizeColor(vodColor(css) || '#fff'),
    badges,
    channel: owner,
    time: Date.now(),
    id,
    replyTo: null,
    replay: true,
    replayAt: at,
  }
  if (Object.keys(emotes).length) msg.twitchEmotes = emotes
  return msg
}

function vodTabEl() {
  return tabBarElement?.querySelector('[data-tab="vod"]') || null
}

function vodGoTo(tab) {
  _autoSwitching = true // the page's doing, not the reader's pick: never saved
  try {
    switchTab(tab)
  } finally {
    _autoSwitching = false
  }
  updatePopoutBtnVisibility() // the strip's button follows the tab the page just put us on, whatever switchTab did
}

/** the owner's login from the page: the channel link beside the player */
function vodOwnerFromPage() {
  const a = document.querySelector('.channel-info-content a[href^="/"]')
  const href = a?.getAttribute('href') || ''
  return twitchPageKind(href, location.hostname) === 'channel' && !/^\/(?:popout|embed)\//.test(href)
    ? href.split('/').filter(Boolean)[0].toLowerCase()
    : ''
}

// no link on the page: the site's cached vod lookup (no auth, 1h) names the owner
function vodOwnerFromSite(v) {
  safeSendMessage({ type: 'api_fetch', path: `/api/twitch/vod/${v.id}` })
    .then((r) => {
      const login = String(r?.data?.channel_login || '').toLowerCase()
      if (_vod !== v || v.owner || !/^[a-z0-9_]{2,25}$/.test(login)) return
      v.owner = login
      vodTick()
    })
    .catch(() => {})
}

function vodNewRows(v) {
  const list = document.querySelector(VOD_LIST)
  const rows = list ? [...list.querySelectorAll(VOD_ROW)] : []
  const at = v.last ? rows.indexOf(v.last) : -1
  v.last = rows.length ? rows[rows.length - 1] : null
  return { rows, at }
}

// twitch's rows → messages. Only the newest the tab can hold are read (a burst past the cap is never
// walked), and a row with no chatter is skipped.
function vodMsgs(rows, v) {
  const out = []
  for (const row of rows.length > SCROLLBACK_MAX ? rows.slice(-SCROLLBACK_MAX) : rows) {
    const msg = vodRowToMsg(row, v.owner, `vod:${v.id}:${v.seq++}`)
    if (msg) out.push(msg)
  }
  return out
}

function vodTrim() {
  if (vodBuffer.length > SCROLLBACK_MAX) vodBuffer.splice(0, vodBuffer.length - SCROLLBACK_MAX)
}

// what a frame found, onto the screen: a few rows are appended like a live tab's, a burst is one render
// (a paused reader gets the pane's own pill, counted by the rows it holds back)
function vodDraw(fresh) {
  if (currentTab !== 'vod') return
  if (fresh.length <= VOD_APPEND_MAX) {
    for (let i = 0; i < fresh.length; i++) {
      if (appendMessage(fresh[i], 'vod')) continue
      renderMessages('vod', { added: fresh.length - i }) // paused or busy: the render holds the rest back
      return
    }
    return
  }
  renderMessages('vod', { added: fresh.length })
}

// the whole tab again (the first look, a seek, an emptied list): the reader lands at the bottom of the
// new moment, even from scrolled up. The pill is the pane's one way back to the tail: it renders.
function vodRedraw() {
  if (currentTab !== 'vod') return
  if (isScrolledUp) document.getElementById('hs-mc-new-msgs')?.click()
  else renderMessages('vod')
}

function vodScan() {
  const v = _vod
  if (!v?.ready) return
  const { rows, at } = vodNewRows(v)
  if (at >= 0) {
    // twitch drew more: only the rows after the one we held last
    const fresh = vodMsgs(rows.slice(at + 1), v)
    if (!fresh.length) return
    v.quiet = false
    for (const msg of fresh) vodBuffer.push(msg)
    vodTrim()
    vodDraw(fresh)
    return
  }
  // the first look, a seek, or twitch emptying the list: the tab is what twitch shows now
  if (!rows.length && !vodBuffer.length) return
  vodBuffer.length = 0
  for (const msg of vodMsgs(rows, v)) vodBuffer.push(msg)
  if (vodBuffer.length) v.quiet = false
  else if (!v.quietTimer) v.quietTimer = cleanup.setTimeout(vodQuiet, VOD_QUIET_MS) // a seek into silence
  _dropTabCache('vod')
  vodRedraw()
}

// the observer only asks: the rows of everything twitch drew since come in ONE frame
function vodQueue(v) {
  if (v.queued) return
  v.queued = true
  rafOrTimeout(() => {
    v.queued = false
    if (_vod === v) vodScan()
  })
}

// the tab's empty line while it waits: after VOD_QUIET_MS of the video playing with no row, it says so
function vodEmptyText() {
  return t(_vod?.quiet ? 'mc_vod_no_replay' : 'mc_no_messages')
}

function vodQuiet() {
  const v = _vod
  if (!v) return
  v.quietTimer = 0
  if (vodBuffer.length) return // the replay is talking
  const video = document.querySelector('video')
  if (video && !video.paused && !video.ended) {
    v.quiet = true
    if (currentTab === 'vod') renderMessages('vod')
  } else v.quietTimer = cleanup.setTimeout(vodQuiet, VOD_QUIET_MS) // not playing yet: nothing is owed
}

function vodBind(v, list) {
  // this room's emote sets and badges, before the first row is drawn (a late set repaints rows
  // anyway; badges would not)
  joinExtraChannel('twitch', v.owner, { scoped: true })
  v.joined = true
  const root = list.closest('.video-chat') || list.parentElement || list
  v.obs = new MutationObserver(() => vodQueue(v))
  v.obs.observe(root, { childList: true, subtree: true })
  cleanup.trackObserver(v.obs)
  Promise.allSettled([fetchGlobalBadges(), fetchChannelBadges(v.owner)]).then(() => {
    if (_vod !== v) return
    v.ready = true
    vodScan()
  })
}

// Twitch draws the owner link and the replay list after the route changes: ask a few times a
// second for the first seconds, then give up (the tab stays, empty, and says so).
function vodTick() {
  const v = _vod
  if (!v || v.obs) return
  v.timer = 0
  if (!v.owner) v.owner = vodOwnerFromPage()
  if (!v.owner && v.ticks === VOD_API_AFTER) vodOwnerFromSite(v)
  const list = document.querySelector(VOD_LIST)
  if (v.owner && list) return vodBind(v, list)
  if (++v.ticks <= VOD_TICKS_MAX) v.timer = cleanup.setTimeout(vodTick, VOD_TICK_MS)
}

function vodStopWatching(v) {
  if (v.timer) cleanup.clearTimeout(v.timer)
  if (v.quietTimer) cleanup.clearTimeout(v.quietTimer)
  if (v.obs) {
    v.obs.disconnect()
    cleanup.untrackObserver(v.obs)
  }
  // an extra we added: let it go, unless a saved tab or the page holds the same room
  if (v.joined && !config.channels.some((c) => c.twitch?.toLowerCase() === v.owner))
    leaveExtraChannel('twitch', v.owner, { scoped: true })
  vodBuffer.length = 0
  _dropTabCache('vod')
}

function vodNew(id, prev) {
  return {
    id,
    owner: '',
    prev,
    ticks: 0,
    timer: 0,
    obs: null,
    ready: false,
    last: null,
    seq: 0,
    queued: false,
    quiet: false,
    quietTimer: cleanup.setTimeout(vodQuiet, VOD_QUIET_MS),
  }
}

/** Match the pane to the page: on a vod page, the vod tab; anywhere else, none. Safe to call on
 *  every navigation and at boot. Twitch only; costs nothing off a VOD. */
function vodSync() {
  const id = hostPlatform === 'twitch' ? twitchVodId(location.pathname) : ''
  if (_vod && _vod.id === id) return
  const tabEl = vodTabEl()
  if (_vod && id) {
    // vod → vod: same tab, new replay
    const prev = _vod.prev
    vodStopWatching(_vod)
    _vod = vodNew(id, prev)
    if (currentTab === 'vod') renderMessages('vod')
    vodTick()
    return
  }
  if (_vod) {
    // left the vod: the tab goes, the reader lands where they were
    const { prev } = _vod
    vodStopWatching(_vod)
    _vod = null
    if (_vodClickOff) _vodClickOff()
    _vodClickOff = null
    if (tabEl) tabEl.style.display = 'none'
    if (currentTab === 'vod')
      vodGoTo(prev && prev !== 'vod' && (mcIsReservedTab(prev) || getChannelById(prev)) ? prev : liveTarget())
    return
  }
  if (!id) return
  _vod = vodNew(id, currentTab === 'vod' ? '' : currentTab)
  _vodClickOff = cleanup.addEventListener(document, 'click', vodStampClick, { capture: true })
  if (tabEl) tabEl.style.display = ''
  vodGoTo('vod')
  vodTick()
}

export { vodBuffer, vodEmptyText, vodOffsetSecs, vodRowToMsg, vodStampHtml, vodSync }
