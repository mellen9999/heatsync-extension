// pin bar — the channel's pinned message, one row above the chat pane, shown to
// every heatsync viewer of the room (twitch has no pin api, so the pin lives on
// heatsync.org and mirrors the site's bar).
//
//   pinSync(tabId)          the tab on screen changed: fetch its rooms' pins
//   pinToggleRow(row)       pin the row's message, or unpin when it already is
//   initPinBar()            live pin_set / pin_clear from the background socket + the p key
//
// Everything goes through the background worker (content scripts must not fetch
// heatsync.org themselves). The server resolves the pinned line from its own
// archive, so the client only names the message id. ONE node, reused; it sits
// beside #hs-mc-messages, never inside the scroller, so bottom-follow is untouched.
//
// × is two things on purpose: a viewer hides this pin id for themselves
// (sessionStorage — a NEW pin shows again); someone who can pin is asked first
// (y / enter yes, esc backs out) and unpins for everyone.

const PIN_RELINK_URL = 'https://heatsync.org/api/auth/login?scopes=mod&return_to=%2Fhome%2Fhot'
const PIN_REFRESH_MS = 30000

const pinState = { pins: new Map(), rooms: [], cur: null, sig: '', at: 0, gen: 0, node: null }

const pinDismissKey = (id) => `hs_pin_x:${id}`
function pinIsDismissed(id) {
  try {
    return sessionStorage.getItem(pinDismissKey(id)) === '1'
  } catch (_) {
    return false
  }
}
function pinMarkDismissed(id) {
  try {
    sessionStorage.setItem(pinDismissKey(id), '1')
  } catch (_) {
    /* private mode: hides until the next render only */
  }
}

function pinEl(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// 'twitch/name' rooms of the tab on screen: a channel tab's own twitch + kick
// rooms, the live tab's picked channel (and the tab it is paired with). Kick
// slugs keep their dashes; only twitch/kick have pins.
function pinRoomsFor(tabId) {
  const out = []
  const add = (platform, channel) => {
    const c = String(channel || '').toLowerCase()
    if (c && /^[a-z0-9_-]+$/.test(c) && !out.includes(`${platform}/${c}`)) out.push(`${platform}/${c}`)
  }
  const addEntry = (ch) => {
    if (!ch) return
    add('twitch', ch.twitch)
    add('kick', ch.kick)
  }
  if (tabId === 'live') {
    const live = String(getLiveChannel() || '').toLowerCase()
    if (!live) return out
    let paired = false
    for (const ch of config.channels || []) {
      if (String(ch.twitch || '').toLowerCase() === live || String(ch.kick || '').toLowerCase() === live) {
        addEntry(ch)
        paired = true
      }
    }
    if (!paired) add('twitch', live)
    return out
  }
  addEntry(getChannelById(tabId))
  return out
}

// the same gate the other mod entries use (twitch: helix-confirmed mod, kick:
// kick_mod_status) plus the channel's own broadcaster; the server re-checks it
function pinCanAct(platform, channel) {
  const c = String(channel || '').toLowerCase()
  if (!c) return false
  const me = typeof currentUsername === 'string' ? currentUsername.toLowerCase() : ''
  const slug = (n) => (platform === 'kick' ? n.replace(/_/g, '-') : n)
  if (me && slug(me) === slug(c)) return true
  if (platform === 'kick') return typeof isKickModForSync === 'function' && isKickModForSync(c)
  if (platform === 'twitch') return typeof isModForSync === 'function' && isModForSync(c)
  return false
}

// the room a chat row's pin lives on, or null (youtube / no channel / not on this tab)
function pinRoomOfRow(row) {
  const platform = row?.dataset?.msgPlatform || ''
  const channel = String(row?.dataset?.msgChannel || '').toLowerCase()
  if ((platform !== 'twitch' && platform !== 'kick') || !channel) return null
  const room = `${platform}/${channel}`
  return pinState.rooms.includes(room) ? { platform, channel, room } : null
}

function pinFail(res) {
  const e = res?.error
  if (e === 'relink_required') {
    showToast(t('mc_cm_link'), 'error')
    try {
      window.open(PIN_RELINK_URL, '_blank', 'noopener')
    } catch (_) {}
  } else if (e === 'auth_required') showToast(t('mc_automod_signin'), 'error')
  else if (e === 'not_moderator') showToast(t('mc_pin_denied'), 'error')
  else if (e === 'not_archived') showToast(t('mc_pin_retry'), 'error')
  else showToast(t('mc_pin_failed'), 'error')
}

function pinCall(op, room, messageId) {
  const [platform, channel] = room.split('/')
  return safeSendMessage({ type: 'pin', op, platform, channel, messageId })
}

// ── the bar ────────────────────────────────────────────────────────────────

function pinNodeEnsure() {
  let n = pinState.node
  if (n?.isConnected) return n
  n = document.getElementById('hs-mc-pinbar')
  if (!n) return null
  n.textContent = ''
  const label = pinEl('span', 'hs-mc-pin-label', t('mc_pin_label'))
  const body = pinEl('div', 'hs-mc-pin-body')
  const ask = pinEl('span', 'hs-mc-pin-ask', t('mc_pin_confirm'))
  const x = hsXButton('hs-x-inline hs-mc-pin-x', t('mc_pin_dismiss'))
  n.append(label, body, ask, x)
  n.tabIndex = -1
  body.addEventListener('click', () => n.classList.toggle('open'))
  x.addEventListener('click', pinOnX)
  n.addEventListener('keydown', pinOnKey)
  n._body = body
  n._x = x
  pinState.node = n
  return n
}

// the pin line through the live row renderer: paints, badges, emotes like any row
function pinRowFor(pin, room) {
  const [platform, channel] = room.split('/')
  const badges = Array.isArray(pin.badges)
    ? pin.badges
        .filter((b) => b?.name)
        .map((b) => `${b.name}/${b.version ?? '1'}`)
        .join(',')
    : ''
  const m = {
    id: `pin-${pin.id}`,
    user: pin.display_name || pin.username,
    login: String(pin.username || '').toLowerCase(),
    text: String(pin.content || ''),
    color: pin.color ? sanitizeColor(pin.color) : '#fff',
    badges,
    channel,
    platform,
    time: pin.ts,
  }
  let row = null
  try {
    row = buildMessageDiv(m, currentTab)
  } catch (_) {
    row = null
  }
  if (!row) row = pinEl('div', 'hs-mc-msg', `${m.user}: ${m.text}`)
  // not a row of the pane: nothing for the mod toolbar, reply or the p key to find
  row.removeAttribute('data-msg-id')
  row.removeAttribute('data-msg-key')
  row.removeAttribute('tabindex')
  row.querySelector('.hs-mc-reply-btn')?.remove()
  return row
}

function pinRender() {
  const n = pinNodeEnsure()
  if (!n) return
  pinConfirm(false)
  let best = null
  for (const [room, pin] of pinState.pins) {
    if (pin && !pinIsDismissed(pin.id) && (!best || pin.pinned_at > best.pin.pinned_at)) best = { room, pin }
  }
  const was = n.hidden
  pinState.cur = best
  n.classList.remove('open')
  if (!best) {
    n.hidden = true
    n._body.textContent = ''
  } else {
    n._body.replaceChildren(pinRowFor(best.pin, best.room))
    const [platform, channel] = best.room.split('/')
    const tip = t(pinCanAct(platform, channel) ? 'mc_pin_unpin_all' : 'mc_pin_dismiss')
    n._x.title = tip
    n._x.setAttribute('aria-label', tip)
    n.hidden = false
  }
  // the pane just got shorter or taller: keep the tail in view if it was
  if (was !== n.hidden && !isScrolledUp) {
    const msgsEl = document.getElementById('hs-mc-messages')
    if (msgsEl && typeof scheduleScrollPin === 'function') scheduleScrollPin(msgsEl)
  }
}

function pinApply(room, pin) {
  if (!pinState.pins.has(room)) return
  pinState.pins.set(room, pin || null)
  pinRender()
}

function pinConfirm(on) {
  const n = pinState.node
  if (!n) return
  if (on) {
    n.dataset.confirm = '1'
    n._x.focus()
  } else delete n.dataset.confirm
}

function pinOnX() {
  const cur = pinState.cur
  if (!cur) return
  const [platform, channel] = cur.room.split('/')
  if (!pinCanAct(platform, channel)) {
    pinMarkDismissed(cur.pin.id)
    pinRender()
    return
  }
  if (pinState.node.dataset.confirm) pinUnpin(cur.room)
  else pinConfirm(true)
}

function pinOnKey(e) {
  const n = pinState.node
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (n.dataset.confirm) pinConfirm(false)
    else if (pinState.cur) {
      pinMarkDismissed(pinState.cur.pin.id)
      pinRender()
    }
  } else if (n.dataset.confirm && (e.key === 'y' || e.key === 'Enter')) {
    e.preventDefault()
    e.stopPropagation()
    if (pinState.cur) pinUnpin(pinState.cur.room)
  }
}

async function pinUnpin(room) {
  pinConfirm(false)
  const res = await pinCall('clear', room)
  if (!res?.ok) return pinFail(res)
  pinApply(room, null)
  showToast(t('mc_pin_gone'), 'success')
}

async function pinToggleRow(row) {
  const target = pinRoomOfRow(row)
  const id = row?.dataset?.msgId
  if (!target || !id || !pinCanAct(target.platform, target.channel)) return false
  if (pinState.pins.get(target.room)?.message_id === id) {
    await pinUnpin(target.room)
    return true
  }
  const res = await pinCall('set', target.room, id)
  if (!res?.ok) {
    pinFail(res)
    return true
  }
  pinApply(target.room, res.pin)
  showToast(t('mc_pin_done'), 'success')
  return true
}

// ── fetching ───────────────────────────────────────────────────────────────

// the tab on screen changed (or the pane repainted): same rooms inside the
// refresh window just repaint; new rooms are fetched once each
async function pinSync(tabId) {
  if (tabId !== currentTab) return
  const rooms = pinRoomsFor(tabId)
  const sig = rooms.join(',')
  for (const room of rooms) {
    const [platform, channel] = room.split('/')
    if (platform === 'kick') {
      if (typeof prefetchKickModFor === 'function') prefetchKickModFor(channel)
    } else if (typeof prefetchModFor === 'function') prefetchModFor(channel)
  }
  if (sig === pinState.sig && Date.now() - pinState.at < PIN_REFRESH_MS) return
  const same = sig === pinState.sig
  pinState.sig = sig
  pinState.at = Date.now()
  pinState.rooms = rooms
  const gen = ++pinState.gen
  if (!same) {
    pinState.pins = new Map(rooms.map((r) => [r, null]))
    pinRender()
  }
  if (!rooms.length) return
  const res = await Promise.all(rooms.map((r) => pinCall('get', r)))
  if (gen !== pinState.gen) return // another tab won the race
  pinState.pins = new Map(rooms.map((r, i) => [r, res[i]?.ok ? res[i].pin || null : pinState.pins.get(r) || null]))
  pinRender()
}

// ── wiring ─────────────────────────────────────────────────────────────────

function pinHoveredRow() {
  const a = document.activeElement?.closest?.('#hs-mc-messages .hs-mc-msg')
  if (a) return a
  const rows = document.querySelectorAll('#hs-mc-messages .hs-mc-msg:hover')
  return rows[rows.length - 1] || null
}

// `p` on the focused / hovered row pins or unpins it — never while typing, and
// only where this viewer may pin (the same gate as the menu entry)
function pinOnKeydown(e) {
  if (e.key !== 'p' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return
  const t0 = e.target
  if (t0 && (t0.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t0.tagName))) return
  const row = pinHoveredRow()
  const target = row && pinRoomOfRow(row)
  if (!target || !row.dataset.msgId || !pinCanAct(target.platform, target.channel)) return
  e.preventDefault()
  pinToggleRow(row)
}

function initPinBar() {
  cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
    if (!msg || (msg.type !== 'pin_set' && msg.type !== 'pin_clear')) return
    pinApply(`${msg.platform}/${String(msg.channel || '').toLowerCase()}`, msg.type === 'pin_set' ? msg.pin : null)
  })
  cleanup.addEventListener(document, 'keydown', pinOnKeydown)
  pinSync(currentTab)
}
