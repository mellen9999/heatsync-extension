// send-status.js — the "sending" checklist in settings › ?: which sites this browser can send chat to.
//
// Sending to twitch, kick or youtube needs a login on THAT site (heatsync never holds it). Nothing told the
// viewer which of the three were done, so "i typed and kick never got it" had no visible cause. This reads
// what the extension already reads — no new permission, no network call:
//   twitch   the background's login check, a yes/no + name  (twitch_auth_status)
//   kick     the background's session check                 (kick_session_status)
//   youtube  the name chip in youtube's chat frame when a youtube tab is up, else the background's
//            check of youtube's login cookies                (yt_session_status)
// Each answers true (signed in) · false (not signed in) · null (could not tell). A probe that fails is a
// null, never a "not signed in": the row says so instead of sending the viewer off to log in twice.
//
//   sendStatusGroupHtml()    the group's markup, from the last answer (or "…" before there is one)
//   sendStatusFill(root)     probe, then repaint the group in root; wires the back-from-signing-in refresh once
//   sendStatusLogin(id)      open that site's sign-in page in a new tab

const SEND_SITES = [
  { id: 'twitch', login: 'https://www.twitch.tv/login' },
  { id: 'kick', login: 'https://kick.com/login' },
  {
    id: 'youtube',
    login: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
  },
]
const SEND_STATUS_TTL_MS = 3000
const SEND_STATUS_TIMEOUT_MS = 4000

let _sendStatus = { at: 0, byId: null, inflight: null }
let _sendStatusWired = false

// { twitch: { in, name }, kick: {…}, youtube: {…} } — never rejects
function sendStatusProbe() {
  const unknown = { in: null, name: '' }
  // a probe that hangs is a "could not tell", not a checklist stuck on "…" forever
  const guard = (fn) =>
    Promise.race([
      fn().catch(() => unknown),
      new Promise((res) => cleanup.setPageTimeout(() => res(unknown), SEND_STATUS_TIMEOUT_MS)),
    ])
  const bool = (r) => (typeof r?.loggedIn === 'boolean' ? r.loggedIn : null)
  return Promise.all([
    guard(async () => {
      const r = await safeSendMessage({ type: 'twitch_auth_status' })
      const signedIn = bool(r)
      const name = r?.username || (typeof currentUsername === 'string' ? currentUsername : '') || ''
      return { in: signedIn, name: signedIn ? name : '' }
    }),
    guard(async () => {
      const r = await safeSendMessage({ type: 'kick_session_status' })
      const signedIn = bool(r)
      return { in: signedIn, name: signedIn ? r.username || '' : '' }
    }),
    guard(async () => {
      const chip = typeof _selfYtChip === 'function' ? _selfYtChip() : ''
      if (chip) return { in: true, name: chip }
      return { in: bool(await safeSendMessage({ type: 'yt_session_status' })), name: '' }
    }),
  ]).then(([twitch, kick, youtube]) => ({ twitch, kick, youtube }))
}

function _sendStatusRow(site, s) {
  const state = s ? (s.in === true ? 'in' : s.in === false ? 'out' : 'unknown') : 'wait'
  const word = { in: t('mc_send_in'), out: t('mc_send_out'), unknown: t('mc_send_unknown'), wait: '…' }[state]
  const glyph = { in: '✓', out: '✗', unknown: '?', wait: '' }[state]
  const who = state === 'in' && s.name ? ` · ${escapeHtml(s.name)}` : ''
  // not signed in AND not-sure both get the way in: a viewer who cannot tell still wants to look
  const go =
    state === 'out' || state === 'unknown'
      ? `<button class="hs-mc-settings-btn hs-mc-send-go" data-action="send-login" data-plat="${escapeHtml(site.id)}">${escapeHtml(t('mc_sign_in'))}</button>`
      : ''
  return (
    `<div class="hs-mc-setting-row hs-mc-setting-row-split hs-mc-send-row" data-send-row="${escapeHtml(site.id)}">` +
    `<span class="hs-mc-setting-label">${escapeHtml(site.id)}</span>` +
    `<span class="hs-mc-send-state ${state}">${glyph ? `${glyph} ` : ''}${escapeHtml(word)}${who}</span>${go}` +
    '</div>'
  )
}

function sendStatusGroupHtml() {
  const by = _sendStatus.byId
  return (
    '<div class="hs-mc-send-group" data-send-status>' +
    `<div class="hs-mc-set-help-title">${escapeHtml(t('mc_send_title'))}</div>` +
    `<div class="hs-mc-send-hint">${escapeHtml(t('mc_send_hint'))}</div>` +
    SEND_SITES.map((site) => _sendStatusRow(site, by?.[site.id])).join('') +
    '</div>'
  )
}

// Repaint every checklist under root from `byId`. Only the rows change; the pane is never rebuilt.
function _sendStatusPaint(root, byId) {
  for (const group of root.querySelectorAll('[data-send-status]')) {
    for (const site of SEND_SITES) {
      const row = group.querySelector(`[data-send-row="${site.id}"]`)
      if (!row) continue
      const fresh = document.createElement('div')
      fresh.innerHTML = _sendStatusRow(site, byId[site.id])
      row.replaceWith(fresh.firstElementChild)
    }
  }
}

function sendStatusFill(root) {
  if (!root?.querySelector('[data-send-status]')) return
  if (!_sendStatusWired) {
    _sendStatusWired = true
    // back from signing in on another tab: look again, so the ✗ turns into a ✓ without a reload
    cleanup.addEventListener(window, 'focus', () => {
      const pane = document.getElementById('hs-mc-messages')
      if (pane) sendStatusFill(pane)
    })
  }
  const fresh = _sendStatus.byId && Date.now() - _sendStatus.at < SEND_STATUS_TTL_MS
  if (fresh || _sendStatus.inflight) return
  _sendStatus.inflight = sendStatusProbe().then((byId) => {
    _sendStatus = { at: Date.now(), byId, inflight: null }
    // the pane may have re-rendered (or closed) while the probe ran: paint whatever is there now
    const pane = document.getElementById('hs-mc-messages')
    if (pane) _sendStatusPaint(pane, byId)
  })
}

function sendStatusLogin(id) {
  const site = SEND_SITES.find((s) => s.id === id)
  if (!site) return
  try {
    window.open(site.login, '_blank', 'noopener')
  } catch (_) {}
  // the answer is stale the moment they go and sign in
  _sendStatus.at = 0
}
