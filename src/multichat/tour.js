// first-run tour — one small card above the chat pane, shown once per device.
//
// The overlay replaces the site's own chat, and four useful things ship OFF
// (timestamps, the hover reply button, vi keys, the mod hover buttons), so a new
// viewer had no way to learn they exist. The card names each one in a line and
// puts its switch right there.
//
//   initTour()          read the seen flag, listen for changes (once)
//   tourSync(tabId)     the tab on screen changed / the pane repainted: draw or
//                       hide the card, and re-ask whether the mod row applies
//   tourReopen()        settings › ? › "show the tour again"
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
// explicit "show the tour again" moves focus to it.
//
// "got it" and Esc are the same thing: seen for good. The flag is per device
// (chrome.storage.local), not a synced setting.

const TOUR_SEEN_KEY = 'hs_tour_seen'
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
let tourWired = false
let tourNode = null
let tourModOk = false
let tourModSig = ''
let tourModAt = 0

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
  n.append(tourEl('div', 'hs-mc-tour-head', t('mc_tour_title')))
  for (const r of TOUR_ROWS) {
    const b = tourEl('button', 'hs-mc-tour-row')
    b.type = 'button'
    b.setAttribute('role', 'switch')
    b.dataset.tourKey = r.key
    if (r.mod) {
      b.dataset.tourMod = '1'
      b.hidden = true
    }
    // the state word is for eyes; the switch role + aria-checked carry it for everything else
    const state = tourEl('span', 'hs-mc-tour-state')
    state.setAttribute('aria-hidden', 'true')
    b.append(state, tourEl('span', 'hs-mc-tour-name', t(r.labelKey)), tourEl('span', 'hs-mc-tour-tip', t(r.tipKey)))
    n.append(b)
  }
  const foot = tourEl('div', 'hs-mc-tour-foot')
  const more = tourEl('button', 'hs-mc-tour-more', t('mc_tour_more'))
  more.type = 'button'
  const done = tourEl('button', 'hs-mc-tour-done', t('mc_tour_done'))
  done.type = 'button'
  done.title = t('mc_tour_done_tip')
  foot.append(more, done)
  n.append(foot)
  n.addEventListener('click', tourOnClick)
  n.addEventListener('keydown', tourOnKey)
  n.addEventListener('keyup', tourOnKeyUp)
  msgsEl.before(n)
  tourNode = n
  return n
}

// state of every switch, from the settings themselves. Touches the DOM only where a value changed.
function tourPaint() {
  const n = tourNode
  if (!n || n.hidden) return
  const stateOf = (on) => t(on ? 'mc_cm_on' : 'mc_cm_off')
  for (const b of n.querySelectorAll('.hs-mc-tour-row')) {
    if (b.dataset.tourMod) b.hidden = !tourModOk
    const on = tourIsOn(b.dataset.tourKey)
    if (b.getAttribute('aria-checked') === String(on)) continue
    b.setAttribute('aria-checked', String(on))
    b.classList.toggle('on', on)
    b.firstChild.textContent = stateOf(on)
  }
}

function tourModIn(rooms) {
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
  tourAskMod(tabId)
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
  tourRepin()
}

function tourSaveFailed() {
  try {
    showToast(t('mc_main_settings_save_failed'), 'error')
  } catch (_) {}
}

// seen for good. Focus that was in the card goes back to the composer, not to nowhere.
function tourDone() {
  if (tourSeen === true) return
  tourSeen = true
  const hadFocus = !!tourNode?.contains(document.activeElement)
  tourHide()
  if (hadFocus) document.getElementById('hs-mc-input')?.focus()
  browser.storage.local.set({ [TOUR_SEEN_KEY]: true }).catch(tourSaveFailed)
}

function tourReopen() {
  tourSeen = false
  browser.storage.local.remove(TOUR_SEEN_KEY).catch(tourSaveFailed)
  tourSync(currentTab)
  tourNode?.querySelector('.hs-mc-tour-row:not([hidden])')?.focus()
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
  if (e.target.closest('.hs-mc-tour-more')) switchTab('settings')
}

// Esc closes. Space is handled here, not left to the button: the page treats a bare
// space over the panel as typing (type-to-focus) and would put it in the composer.
function tourOnKey(e) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    e.stopPropagation()
    tourDone()
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
    .get(TOUR_SEEN_KEY)
    .then((d) => {
      tourSeen = d?.[TOUR_SEEN_KEY] === true
      tourSync(currentTab)
    })
    .catch(() => {
      tourSeen = true // can't tell if it was seen: don't nag
    })
  cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
    if (area === 'local' && TOUR_SEEN_KEY in changes) {
      tourSeen = changes[TOUR_SEEN_KEY].newValue === true
      if (tourSeen) tourHide()
      else tourSync(currentTab)
    } else if (tourSeen === false && (changes.ui_settings || TOUR_MOD_KEY in changes)) {
      // after settings' own listener has updated its cache
      cleanup.setTimeout(tourPaint, 0)
    }
  })
}
