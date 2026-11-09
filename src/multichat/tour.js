// first-run tour — one small card above the chat pane, shown once per device.
//
// The overlay replaces the site's own chat, so a new viewer could not see what it
// does: the row menu, the commands, the search box, the tabs, where settings are,
// and four useful switches that ship OFF (timestamps, the hover reply button, vi
// keys, the mod hover buttons). The card walks through them one card at a time,
// one idea each, one or two short lines; the last card holds the switches.
//
//   initTour()          read the seen flag + saved step, listen for changes (once)
//   tourSync(tabId)     the tab on screen changed / the pane repainted: draw or
//                       hide the card, and re-ask whether the mod row applies
//   tourReopen()        settings › ? › "show the tour again" (back to the first card)
//
// Progress: the step is kept in storage so a reload (or the next page) resumes where
// the viewer stopped. "skip" and "got it" are the same thing, seen for good — Esc too.
//
// Each switch writes the REAL registry key through setSetting — the exact call the
// settings panel makes — so the two can never disagree, in either direction. The
// card repaints from getSetting, and from the storage change when settings (or
// another tab) flips one. The mod row exists only where the hover buttons would
// actually appear: the toolbar's own gate (twitch mod / kick mod of a room on the
// tab on screen), so a switch is never shown that would do nothing.
//
// The card sits beside #hs-mc-messages, never inside the scroller (bottom-follow
// is untouched), and never takes focus on its own: it appears, it waits. Only an
// explicit "show the tour again" moves focus to it. ← → (when focus is in the card)
// go back / next; no bare printable key is used, the composer owns those.
// The flag is per device (chrome.storage.local), not a synced setting.
//
// Each card but the last also points a big yellow arrow (▲▼◀▶, a body-level fixed node, never in
// the scroller) at the thing it talks about. tourArrow() is the pure placement; the rest keeps it
// on the target through step / tab / resize / scroll and drops it with the card.

const TOUR_SEEN_KEY = 'hs_tour_seen'
const TOUR_STEP_KEY = 'hs_tour_step'
// The cards, in order. A card's words are mc_tour_<id>_t (title) and mc_tour_<id>_d (one or
// two short lines). The last one has no line of its own: it is the switches below.
const TOUR_STEPS = ['menu', 'cmd', 'find', 'tabs', 'settings', 'switches']
const TOUR_LAST = TOUR_STEPS.length - 1
const TOUR_MOD_KEY = 'hs_mod_toolbar_buttons'
// What the mod switch turns on. The full list stays off by default on purpose
// (clutter); this is the smallest set a mod reaches for first, and the rest is
// one tap away in settings › mod. Off clears the list, as unticking every chip does.
const TOUR_MOD_STARTER = ['delete_message', 'timeout_10m', 'ban']
const TOUR_MOD_RETRY_MS = 15000
// key = the registry key, label = the SAME label settings shows for it
const TOUR_ROWS = [
  { key: 'timestamps', labelKey: 'mc_settings_timestamps', tipKey: 'mc_tour_timestamps_tip' },
  { key: 'hoverReply', labelKey: 'mc_settings_hover_reply', tipKey: 'mc_tour_hover_reply_tip' },
  { key: 'viMode', labelKey: 'mc_settings_vi_mode', tipKey: 'mc_tour_vi_tip' },
  { key: TOUR_MOD_KEY, labelKey: 'mc_settings_mod_toolbar_buttons', tipKey: 'mc_tour_mod_tip', mod: true },
]

let tourSeen = null // null = flag not read yet, false = show the card, true = done for good
let tourStep = 0 // index into TOUR_STEPS: the card on screen
let tourWired = false
let tourNode = null
let tourModOk = false
let tourModSig = ''
let tourModAt = 0
let tourArrowNode = null
let tourObs = null
const TOUR_ARROW = 32
const TOUR_ARROW_GAP = 2
// the side of the target the arrow sits on -> the glyph that points back at the target
const TOUR_GLYPH = { top: '\u25bc', bottom: '\u25b2', left: '\u25b6', right: '\u25c0' }
const TOUR_OPP = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

const tourBox = (x, y, s) => ({ left: x, top: y, right: x + s, bottom: y + s })
const tourHits = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

// Where the arrow goes: just outside the edge of `t` that faces the card `c`, centred on that edge,
// then the opposite edge, then the sides - the first that is on screen and off the card. Rects are
// {left, top, right, bottom, width, height}; b is the screen. null = no arrow (no target, zero
// size, or off screen).
function tourArrow(t, c, b, s = TOUR_ARROW) {
  if (!t || !b || !(t.width > 0 && t.height > 0)) return null
  if (t.right <= b.left || t.left >= b.right || t.bottom <= b.top || t.top >= b.bottom) return null
  const dx = c ? (c.left + c.right - t.left - t.right) / 2 : 0
  const dy = c ? (c.top + c.bottom - t.top - t.bottom) / 2 : 1
  const first = Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? 'bottom' : 'top') : dx >= 0 ? 'right' : 'left'
  const sides = [
    first,
    TOUR_OPP[first],
    ...['top', 'bottom', 'left', 'right'].filter((k) => k !== first && k !== TOUR_OPP[first]),
  ]
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)))
  let pick = null
  for (const side of sides) {
    const g = TOUR_ARROW_GAP
    const x = side === 'left' ? t.left - g - s : side === 'right' ? t.right + g : (t.left + t.right - s) / 2
    const y = side === 'top' ? t.top - g - s : side === 'bottom' ? t.bottom + g : (t.top + t.bottom - s) / 2
    const onAxis =
      side === 'left' || side === 'right' ? x >= b.left && x + s <= b.right : y >= b.top && y + s <= b.bottom
    const at = { glyph: TOUR_GLYPH[side], x: clamp(x, b.left, b.right - s), y: clamp(y, b.top, b.bottom - s) }
    if (!pick) pick = at
    if (onAxis && !(c && tourHits(tourBox(at.x, at.y, s), c))) return at
  }
  return pick
}

// the real thing a card is about; null when it is not on screen (hidden composer, no search bar on
// this tab, no rows yet), and the last card has none: it holds the switches itself
function tourTargetRect(id) {
  const q = (sel) => document.querySelector(sel)
  if (id === 'menu') {
    const m = q('#hs-mc-messages')
    if (!m) return null
    const mr = m.getBoundingClientRect()
    let r = m.lastElementChild
    for (let i = 0; r && i < 60; i++, r = r.previousElementSibling) {
      if (!r.classList.contains('hs-mc-msg')) continue
      const b = r.getBoundingClientRect()
      if (b.height > 0 && b.bottom > mr.top && b.top < mr.bottom) {
        const top = Math.max(b.top, mr.top)
        const bottom = Math.min(b.bottom, mr.bottom)
        return { left: b.left, right: b.right, top, bottom, width: b.width, height: bottom - top }
      }
    }
    return null
  }
  const sel = {
    cmd: '#hs-mc-input',
    find: '#hs-mc-search-bar',
    tabs: '.hs-mc-tabs-scroll .hs-mc-tab.active',
    settings: '#hs-mc-tabbar [data-tab="settings"]',
  }[id]
  const el = sel && (q(sel) ?? (id === 'tabs' ? q('.hs-mc-tabs-scroll') : null))
  return el?.getBoundingClientRect() ?? null
}

// draw, move or drop the arrow for the card on screen
function tourArrowPaint() {
  const n = tourNode
  const v = document.defaultView
  const rect = n && !n.hidden ? tourTargetRect(TOUR_STEPS[tourStep]) : null
  const a =
    rect && tourArrow(rect, n.getBoundingClientRect(), { left: 0, top: 0, right: v.innerWidth, bottom: v.innerHeight })
  if (!a) {
    tourArrowNode?.remove()
    tourArrowNode = null
    return
  }
  if (!tourArrowNode?.isConnected) {
    document.getElementById('hs-mc-tour-arrow')?.remove()
    const el = tourEl('div')
    el.id = 'hs-mc-tour-arrow'
    el.setAttribute('aria-hidden', 'true')
    document.body.append(el)
    tourArrowNode = el
  }
  if (tourArrowNode.textContent !== a.glyph) tourArrowNode.textContent = a.glyph
  tourArrowNode.style.left = `${Math.round(a.x)}px`
  tourArrowNode.style.top = `${Math.round(a.y)}px`
}

// keep it on the target as the pane, the window or the rows move; one set per card node
function tourArrowWire(n, msgsEl) {
  tourObs?.disconnect()
  tourObs = null
  if (typeof ResizeObserver === 'function') {
    tourObs = new ResizeObserver(tourArrowPaint)
    tourObs.observe(document.documentElement)
    tourObs.observe(n)
    tourObs.observe(msgsEl)
  }
  msgsEl.addEventListener('scroll', () => TOUR_STEPS[tourStep] === 'menu' && tourArrowPaint(), { passive: true })
}

function tourEl(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// a registry value read as a switch: bools as they are, the mod list is on when it has any button
function tourIsOn(key) {
  const v = getSetting(key)
  return Array.isArray(v) ? v.length > 0 : !!v
}

// the pane just got shorter or taller: keep the tail in view if it was
function tourRepin() {
  if (isScrolledUp) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (msgsEl && typeof scheduleScrollPin === 'function') scheduleScrollPin(msgsEl)
}

function tourNodeEnsure() {
  const live = tourNode
  if (live?.isConnected && live.dataset.hsCtx === MC_WIRE_CTX) return live
  // a card left by a previous injection: its handlers died with that context
  document.getElementById('hs-mc-tour')?.remove()
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl?.parentNode) return null
  const n = tourEl('div')
  n.id = 'hs-mc-tour'
  n.dataset.hsCtx = MC_WIRE_CTX
  n.hidden = true
  n.setAttribute('role', 'region')
  n.setAttribute('aria-label', t('mc_tour_aria'))
  const head = tourEl('div', 'hs-mc-tour-head')
  const line = tourEl('div', 'hs-mc-tour-d')
  // a card change is announced; the first draw is not (a live region only speaks changes)
  head.setAttribute('aria-live', 'polite')
  line.setAttribute('aria-live', 'polite')
  head.append(tourEl('span', 'hs-mc-tour-n'), tourEl('span', 'hs-mc-tour-t'))
  n.append(head, line)
  for (const r of TOUR_ROWS) {
    const b = tourEl('button', 'hs-mc-tour-row')
    b.type = 'button'
    b.setAttribute('role', 'switch')
    b.dataset.tourKey = r.key
    if (r.mod) b.dataset.tourMod = '1'
    b.hidden = true
    // the state word is for eyes; the switch role + aria-checked carry it for everything else
    const state = tourEl('span', 'hs-mc-tour-state')
    state.setAttribute('aria-hidden', 'true')
    b.append(state, tourEl('span', 'hs-mc-tour-name', t(r.labelKey)), tourEl('span', 'hs-mc-tour-tip', t(r.tipKey)))
    n.append(b)
  }
  const btn = (cls, text) => {
    const b = tourEl('button', cls, text)
    b.type = 'button'
    return b
  }
  const foot = tourEl('div', 'hs-mc-tour-foot')
  const nav = tourEl('div', 'hs-mc-tour-nav')
  nav.append(
    btn('hs-mc-tour-back', t('mc_tour_back')),
    btn('hs-mc-tour-next', t('mc_tour_next')),
    btn('hs-mc-tour-more', t('mc_tour_more')),
  )
  const done = btn('hs-mc-tour-done')
  done.title = t('mc_tour_done_tip')
  foot.append(nav, done)
  n.append(foot)
  n.addEventListener('click', tourOnClick)
  n.addEventListener('keydown', tourOnKey)
  n.addEventListener('keyup', tourOnKeyUp)
  msgsEl.before(n)
  tourNode = n
  tourArrowWire(n, msgsEl)
  return n
}

// The card on screen, and the state of every switch (from the settings themselves). Touches the
// DOM only where something changed.
function tourPaint() {
  const n = tourNode
  if (!n || n.hidden) return
  const last = tourStep === TOUR_LAST
  if (n.dataset.tourShown !== String(tourStep)) {
    n.dataset.tourShown = String(tourStep)
    const id = TOUR_STEPS[tourStep]
    n.querySelector('.hs-mc-tour-n').textContent = `${tourStep + 1}/${TOUR_STEPS.length}`
    n.querySelector('.hs-mc-tour-t').textContent = t(`mc_tour_${id}_t`)
    const line = n.querySelector('.hs-mc-tour-d')
    line.hidden = last
    line.textContent = last ? '' : t(`mc_tour_${id}_d`)
    n.querySelector('.hs-mc-tour-back').hidden = tourStep === 0
    n.querySelector('.hs-mc-tour-next').hidden = last
    n.querySelector('.hs-mc-tour-more').hidden = !last
    n.querySelector('.hs-mc-tour-done').textContent = t(last ? 'mc_tour_done' : 'mc_tour_skip')
  }
  const stateOf = (on) => t(on ? 'mc_cm_on' : 'mc_cm_off')
  for (const b of n.querySelectorAll('.hs-mc-tour-row')) {
    b.hidden = !last || (!!b.dataset.tourMod && !tourModOk)
    const on = tourIsOn(b.dataset.tourKey)
    if (b.getAttribute('aria-checked') === String(on)) continue
    b.setAttribute('aria-checked', String(on))
    b.classList.toggle('on', on)
    b.firstChild.textContent = stateOf(on)
  }
  tourArrowPaint()
}

function tourModIn(rooms) {
  // youtube mod status is one flag for the viewer (no per-room cache), and a youtube-only mod has no pin rooms at all
  if (typeof isYtModForSync === 'function' && isYtModForSync()) return true
  return rooms.some((room) => {
    const [platform, channel] = room.split('/')
    return platform === 'kick' ? isKickModForSync(channel) : isModForSync(channel)
  })
}

// Is this viewer a mod of a room on the tab on screen? Answered from the caches
// the hover toolbar uses; a cold cache is asked once per tab, and a "no" is asked
// again every 15s while the card is up (twitch can answer "unknown" at boot).
function tourAskMod(tabId) {
  const rooms = typeof pinRoomsFor === 'function' ? pinRoomsFor(tabId) : []
  const sig = `${tabId}|${rooms.join(',')}`
  tourModOk = tourModIn(rooms)
  const now = Date.now()
  if (sig === tourModSig && (tourModOk || now - tourModAt < TOUR_MOD_RETRY_MS)) return
  tourModSig = sig
  tourModAt = now
  Promise.all(
    rooms.map((room) => {
      const [platform, channel] = room.split('/')
      return platform === 'kick' ? isKickModFor(channel) : isModFor(channel)
    }),
  )
    .then(() => {
      if (sig !== tourModSig || tourSeen !== false) return
      tourModOk = tourModIn(rooms)
      tourPaint()
    })
    .catch(() => {})
}

function tourSync(tabId) {
  if (tourSeen !== false) return
  const n = tourNodeEnsure()
  if (!n) return
  if (tourStep === TOUR_LAST) tourAskMod(tabId)
  if (n.hidden) {
    n.hidden = false
    tourRepin()
  }
  tourPaint()
}

function tourHide() {
  const n = tourNode
  if (!n || n.hidden) return
  n.hidden = true
  tourArrowPaint()
  tourRepin()
}

function tourSaveFailed() {
  try {
    showToast(t('mc_main_settings_save_failed'), 'error')
  } catch (_) {}
}

// a saved step is only trusted when it is a card that exists
function tourClampStep(v) {
  return Number.isInteger(v) && v >= 0 && v <= TOUR_LAST ? v : 0
}

// seen for good. Focus that was in the card goes back to the composer, not to nowhere.
function tourDone() {
  if (tourSeen === true) return
  tourSeen = true
  const hadFocus = !!tourNode?.contains(document.activeElement)
  tourHide()
  if (hadFocus) document.getElementById('hs-mc-input')?.focus()
  browser.storage.local.set({ [TOUR_SEEN_KEY]: true }).catch(tourSaveFailed)
  browser.storage.local.remove(TOUR_STEP_KEY).catch(() => {}) // the step is a nicety, never worth a toast
}

// Go to a card. Keeps the keyboard where it was: a button that just hid itself (back on the first
// card, next on the last) hands focus to the one that took its place.
function tourGo(step) {
  const next = tourClampStep(step)
  const n = tourNode
  if (!n || next === tourStep) return
  const had = n.contains(document.activeElement)
  tourStep = next
  if (tourStep === TOUR_LAST) tourAskMod(currentTab)
  tourPaint()
  tourRepin()
  const a = document.activeElement
  if (had && (!n.contains(a) || a.hidden)) {
    n.querySelector('.hs-mc-tour-next:not([hidden]), .hs-mc-tour-done')?.focus()
  }
  browser.storage.local.set({ [TOUR_STEP_KEY]: tourStep }).catch(() => {})
}

function tourReopen() {
  tourSeen = false
  tourStep = 0
  browser.storage.local.remove([TOUR_SEEN_KEY, TOUR_STEP_KEY]).catch(tourSaveFailed)
  tourSync(currentTab)
  tourNode?.querySelector('.hs-mc-tour-next')?.focus()
}

function tourToggle(key) {
  const on = tourIsOn(key)
  const next = key === TOUR_MOD_KEY ? (on ? [] : TOUR_MOD_STARTER.slice()) : !on
  if (!setSetting(key, next)) tourSaveFailed()
  tourPaint()
  // the settings panel may be open underneath: its switch must flip too
  if (currentTab === 'settings' && typeof renderSettingsTab === 'function') renderSettingsTab()
}

function tourOnClick(e) {
  const row = e.target.closest('.hs-mc-tour-row')
  if (row) return tourToggle(row.dataset.tourKey)
  if (e.target.closest('.hs-mc-tour-done')) return tourDone()
  if (e.target.closest('.hs-mc-tour-next')) return tourGo(tourStep + 1)
  if (e.target.closest('.hs-mc-tour-back')) return tourGo(tourStep - 1)
  if (e.target.closest('.hs-mc-tour-more')) switchTab('settings')
}

// Esc closes. ← → go back / next (mirrored in a right-to-left layout). Space is handled here, not
// left to the button: the page treats a bare space over the panel as typing (type-to-focus) and
// would put it in the composer.
function tourOnKey(e) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    e.stopPropagation()
    tourDone()
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) {
    e.preventDefault()
    e.stopPropagation()
    const rtl = !!tourNode?.closest('[dir="rtl"]')
    tourGo(tourStep + ((e.key === 'ArrowRight') !== rtl ? 1 : -1))
  } else if (e.key === ' ' && e.target.closest('button')) {
    e.preventDefault()
    if (!e.repeat) e.target.closest('button').click()
  }
}
function tourOnKeyUp(e) {
  if (e.key === ' ') e.preventDefault() // some browsers click on space-up; the keydown already did
}

function initTour() {
  if (tourWired) return
  tourWired = true
  browser.storage.local
    .get([TOUR_SEEN_KEY, TOUR_STEP_KEY])
    .then((d) => {
      tourSeen = d?.[TOUR_SEEN_KEY] === true
      tourStep = tourClampStep(d?.[TOUR_STEP_KEY])
      tourSync(currentTab)
    })
    .catch(() => {
      tourSeen = true // can't tell if it was seen: don't nag
    })
  cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
    if (area === 'local' && TOUR_SEEN_KEY in changes) {
      tourSeen = changes[TOUR_SEEN_KEY].newValue === true
      if (tourSeen) tourHide()
      else {
        tourStep = 0 // brought back from another tab or from settings: start over
        tourSync(currentTab)
      }
    } else if (tourSeen === false && (changes.ui_settings || TOUR_MOD_KEY in changes)) {
      // after settings' own listener has updated its cache
      cleanup.setTimeout(tourPaint, 0)
    }
  })
}
