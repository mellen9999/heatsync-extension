// AutoMod hold-queue — twitch AutoMod paused a viewer's message in a channel
// this user moderates. Server (EventSub + Helix) does the real work and pushes
// two message types over the existing authed heatsync.org websocket, relayed
// here by background.js as runtime messages:
//   automod_hold   { broadcasterId, broadcasterLogin, msgId, senderId,
//                     senderLogin, senderName, text, heldAt, reason
//                     ('automod'|'blocked_term'), category, level, terms }
//   automod_update { broadcasterId, broadcasterLogin, msgId, status
//                     ('approved'|'denied'|'expired'), modLogin }
//   automod_relink { }  — server needs a fresh twitch OAuth grant to keep
//                          watching; shown once as a toast (see notifs.js).
// The row renders inline in the matching channel's tab via a dedicated
// m.type === 'automod-hold' branch in main.js's buildMessageDiv (this module
// owns the escaping + status text so that branch stays a thin renderer).

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsAutomod = {}

// ── pure mappers (unit-tested; no chrome.*/DOM) ─────────────────────────────

const AUTOMOD_HOLD_DEDUPE_TTL_MS = 10 * 60 * 1000
// Twitch auto-denies a held message 60 minutes after it holds it, and that is
// the only clock that decides whether allow/deny still works. This was 6
// minutes, which greyed out rows twitch would still have accepted — the queue
// expired messages the mod could have released. The server's pending backfill
// uses the same 60, and a 404 from the action route ('gone') still overrides
// both the moment twitch says otherwise.
const AUTOMOD_EXPIRE_MS = 60 * 60 * 1000
const AUTOMOD_SWEEP_INTERVAL_MS = 25 * 60 * 1000

// Wire payload (automod_hold, already coerced once by background.js) → the
// row model buffered alongside normal chat messages. Never trust the wire
// twice: re-coerce every field here too so a compromised/old BG build can't
// hand this a non-string/object.
function automodHoldToRowModel(payload) {
  if (!payload || typeof payload !== 'object') return null
  const msgId = String(payload.msgId || '').trim()
  if (!msgId) return null
  const broadcasterLogin = String(payload.broadcasterLogin || '').toLowerCase()
  if (!broadcasterLogin) return null
  const terms = Array.isArray(payload.terms)
    ? payload.terms
        .map((t) => String(t))
        .filter(Boolean)
        .slice(0, 10)
    : null
  const senderLogin = String(payload.senderLogin || '').toLowerCase()
  const heldAt = Number(payload.heldAt) || Date.now()
  return {
    type: 'automod-hold',
    msgId,
    broadcasterId: String(payload.broadcasterId || ''),
    broadcasterLogin,
    senderId: String(payload.senderId || ''),
    senderLogin,
    senderName: String(payload.senderName || payload.senderLogin || 'unknown'),
    text: String(payload.text || ''),
    heldAt,
    reason: payload.reason === 'blocked_term' ? 'blocked_term' : 'automod',
    category: payload.category ? String(payload.category) : null,
    level: Number(payload.level) || 0,
    terms: terms?.length ? terms : null,
    status: 'pending',
    resolvedBy: null,
    errorText: null,
    // Generic buffer-compat fields — every renderer/sort/dedupe path in
    // main.js expects .id/.time/.user/.channel/.platform on buffered rows.
    id: `automod-${msgId}`,
    time: heldAt,
    user: String(payload.senderName || payload.senderLogin || 'unknown'),
    channel: broadcasterLogin,
    platform: 'twitch',
  }
}

// reason + category/level/terms → the small chip text next to the row.
// Plain text (untranslated) — mirrors irc.js's dynamic notice text
// (e.g. CLEARCHAT's "banned"/"timed out for Ns"), which is also not routed
// through t() since the content is inherently dynamic, not a fixed label.
function automodReasonChipText(row) {
  if (!row) return ''
  if (row.reason === 'blocked_term') {
    const term = row.terms?.[0]
    return term ? `blocked term: ${term}` : 'blocked term'
  }
  if (row.category) return row.level ? `${row.category} (level ${row.level})` : row.category
  return 'automod'
}

// automod_update.status + modLogin → the text that replaces the buttons.
// Same "dynamic content stays plain" reasoning as automodReasonChipText.
function automodStatusText(status, modLogin) {
  const mod = modLogin ? String(modLogin) : ''
  if (status === 'approved') return mod ? `allowed by ${mod}` : 'allowed'
  if (status === 'denied') return mod ? `denied by ${mod}` : 'denied'
  if (status === 'expired') return 'expired'
  return ''
}

// Row model → pre-escaped HTML fragments for the DOM branch in main.js.
// Escaping lives HERE (not scattered across main.js) so the untrusted fields
// (sender name, message text, automod terms) only ever get escaped once, in
// one tested place. Depends on the repo's shared escapeHtml (utils.js) —
// same global-scope trick every sibling multichat module uses.
function buildAutomodHoldContentHtml(row) {
  if (!row) return { senderHtml: '', textHtml: '', reasonHtml: '' }
  return {
    senderHtml: escapeHtml(row.senderName || row.senderLogin || 'unknown'),
    textHtml: escapeHtml(row.text || ''),
    reasonHtml: escapeHtml(automodReasonChipText(row)),
  }
}

// Dedupe a hold by msgId with a rolling TTL — the same hold can arrive twice
// (WS reconnect replay, multiple mod tabs). Mutates `seen` in place (pure with
// respect to everything else: caller supplies the clock so this is testable
// without Date.now()). Returns true the first time a msgId is seen.
function shouldProcessAutomodHold(seen, msgId, now) {
  if (!seen || !msgId) return false
  for (const [id, ts] of seen) {
    if (now - ts > AUTOMOD_HOLD_DEDUPE_TTL_MS) seen.delete(id)
  }
  if (seen.has(msgId)) return false
  seen.set(msgId, now)
  return true
}

// ── impure wiring (chrome.*/DOM) ────────────────────────────────────────────

const _automodSeenHolds = new Map() // msgId -> firstSeenAt
const _automodExpireTimers = new Map() // msgId -> timeout id
const _automodBroadcasterIdCache = new Map() // twitch login -> numeric id
// Channels this page has already asked to backfill. The first sweep after a
// load is the one that needs it — later sweeps have the live socket, and
// asking again would only spend a request to be told nothing is new.
const _automodBackfilled = new Set()
// One relink toast per page session — BG's own dedupe (_automodRelinkNotified)
// is per-SW-lifetime, and MV3 kills/respawns the service worker independently
// of any open tab, so BG can legitimately re-broadcast automod_relink more
// than once across a single page's life (watch-sweep 401 at boot, a later
// action-401 after a SW respawn resets BG's flag, etc). HsNotifs' dedupeKey
// only collapses duplicates while an earlier toast with that key is still
// on screen — a broadcast that arrives after the first toast was dismissed
// is a fresh, non-duplicate emit as far as HsNotifs is concerned, so a
// content-side "already shown" flag is the only place this can actually be
// capped to one, regardless of how many times BG fires it.
let _automodRelinkShown = false

function findAutomodChannel(broadcasterLogin) {
  const lc = (broadcasterLogin || '').toLowerCase()
  if (!lc) return null
  return (config?.channels || []).find((c) => (c?.twitch || '').toLowerCase() === lc) || null
}

function findAutomodRow(broadcasterLogin, msgId) {
  const ch = findAutomodChannel(broadcasterLogin)
  if (!ch?.twitch) return null
  const buf = irc?.channels?.get(ch.twitch.toLowerCase())
  const all = buf?.getAll ? buf.getAll() : []
  return all.find((m) => m.type === 'automod-hold' && m.msgId === msgId) || null
}

// Patches ONLY the actions sub-element of an already-rendered row (mirrors
// _applyModNoticeDim's live-DOM-patch-without-rebuild approach). A future
// tab switch re-renders from the buffer, which already carries the mutated
// status, so this is a pure "don't make the user wait for a rebuild" nicety.
function patchAutomodRowDom(row) {
  if (!row) return
  try {
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    const safe = CSS.escape ? CSS.escape(row.msgId) : row.msgId.replace(/"/g, '\\"')
    const rowEl = msgsEl.querySelector(`.hs-mc-automod[data-msg-id="${safe}"]`)
    if (!rowEl) return
    const actionsEl = rowEl.querySelector('.hs-mc-automod-actions')
    if (actionsEl) actionsEl.innerHTML = renderAutomodHoldActionsHtml(row)
    const resolved = row.status === 'approved' || row.status === 'denied' || row.status === 'expired'
    rowEl.classList.toggle('hs-mc-automod-resolved', resolved)
  } catch (_) {}
}

// Buttons/status text for the actions slot — depends on t()/escapeHtml
// (impure, DOM-facing) so it lives next to patchAutomodRowDom rather than
// in the pure-mapper section above.
function renderAutomodHoldActionsHtml(row) {
  if (!row) return ''
  if (row.status === 'pending' || row.status === 'error') {
    const errHtml =
      row.status === 'error'
        ? `<span class="hs-mc-automod-status hs-mc-automod-err">${escapeHtml(row.errorText || t('mc_automod_error'))}</span> `
        : ''
    return (
      errHtml +
      `<button type="button" class="hs-mc-automod-btn hs-mc-automod-allow">${escapeHtml(t('mc_automod_allow'))}</button>` +
      `<button type="button" class="hs-mc-automod-btn hs-mc-automod-deny">${escapeHtml(t('mc_automod_deny'))}</button>`
    )
  }
  if (row.status === 'resolving') {
    return `<span class="hs-mc-automod-status">${escapeHtml(t('mc_automod_resolving'))}</span>`
  }
  return `<span class="hs-mc-automod-status">${escapeHtml(automodStatusText(row.status, row.resolvedBy))}</span>`
}

function clearAutomodExpiry(msgId) {
  const id = _automodExpireTimers.get(msgId)
  if (id != null) {
    cleanup.clearTimeout(id)
    _automodExpireTimers.delete(msgId)
  }
}

// Twitch expires an unresolved hold server-side; if the automod:update never
// arrives (dropped WS frame, server hiccup) this local fallback still moves
// the row out of "pending" instead of leaving stale allow/deny buttons on a
// message twitch already discarded.
function scheduleAutomodExpiry(row) {
  clearAutomodExpiry(row.msgId)
  // Measured from when TWITCH held the message, not from when this tab heard
  // about it. A backfilled hold arrives already part-aged; timing it from now
  // would leave a dead row looking actionable for another full hour.
  const age = Math.max(0, Date.now() - (Number(row.heldAt) || Date.now()))
  const id = cleanup.setTimeout(
    () => {
      _automodExpireTimers.delete(row.msgId)
      if (row.status !== 'pending' && row.status !== 'error' && row.status !== 'resolving') return
      row.status = 'expired'
      row.resolvedBy = null
      patchAutomodRowDom(row)
    },
    Math.max(0, AUTOMOD_EXPIRE_MS - age),
  )
  _automodExpireTimers.set(row.msgId, id)
}

function insertAutomodHoldRow(row) {
  const ch = findAutomodChannel(row.broadcasterLogin)
  if (!ch?.twitch) return // not a channel this ext has joined — drop
  const buf = irc?.channels?.get(ch.twitch.toLowerCase())
  if (!buf) return
  buf.push(row)
  if (currentTab === ch.id) {
    try {
      appendMessage(row, ch.id)
    } catch (_) {}
  }
  scheduleAutomodExpiry(row)
}

// Backfill: the holds twitch is still holding, handed back by the watch call.
// Same row model, same insert path, same expiry clock as a live push — the
// only difference is that these can be minutes old, so they are checked
// against the buffer rather than only against the seen-map. The map's TTL is
// shorter than a hold's life, so a hold that arrived live and was still on
// screen would otherwise come back a second time as a duplicate row.
function injectPendingAutomodHolds(pending) {
  if (!Array.isArray(pending) || !pending.length) return 0
  let added = 0
  for (const payload of pending) {
    const row = automodHoldToRowModel(payload)
    if (!row) continue
    if (findAutomodRow(row.broadcasterLogin, row.msgId)) continue // already on screen
    if (!shouldProcessAutomodHold(_automodSeenHolds, row.msgId, Date.now())) continue
    // Nothing to act on any more — don't resurrect it as a live row.
    if (Date.now() - row.heldAt >= AUTOMOD_EXPIRE_MS) continue
    insertAutomodHoldRow(row)
    added++
  }
  return added
}

function resolveAutomodRow(broadcasterLogin, msgId, status, modLogin) {
  const row = findAutomodRow(broadcasterLogin, msgId)
  if (!row) return // resolved a hold we never rendered (different mod tab, expired buffer) — ignore
  row.status = status === 'approved' || status === 'denied' ? status : 'expired'
  row.resolvedBy = modLogin ? String(modLogin) : null
  row.errorText = null
  clearAutomodExpiry(msgId)
  patchAutomodRowDom(row)
}

// ── delegated button clicks ─────────────────────────────────────────────────

function handleAutomodActionClick(rowEl, action) {
  // Audit-toggle rule: every toggle needs a reader on every action path, not
  // just the render/sweep/message-listener gates — a row rendered before a
  // mid-session disable would otherwise keep live, clickable allow/deny
  // buttons after the user turned the subsystem off.
  if (!isEnabled('automod-queue')) return
  const msgId = rowEl?.dataset.msgId
  // .toLowerCase() belt-and-braces: findAutomodChannel already lowercases
  // internally (row insertion also always writes the dataset lowercase), but
  // matching case explicitly at every lookup site is cheap and one less thing
  // to get wrong if either side ever changes.
  const broadcasterLogin = (rowEl?.dataset.msgChannel || '').toLowerCase()
  if (!msgId || !broadcasterLogin) return
  const row = findAutomodRow(broadcasterLogin, msgId)
  if (!row) return
  row.status = 'resolving'
  row.errorText = null
  patchAutomodRowDom(row)
  safeSendMessage({ type: 'automod_action', msgId, action })
    .then((res) => {
      if (res?.ok) {
        // The POST succeeding IS the confirmation — the action landed on
        // twitch. Resolve locally instead of waiting on the automod:update
        // broadcast: that WS frame has no backfill path (holds do, resolves
        // don't), so a SW restart or WS reconnect at the wrong moment left
        // rows stuck on "resolving…" forever. The broadcast still serves
        // other tabs/mods, and when it does arrive it re-patches this row
        // with the resolver's name.
        resolveAutomodRow(broadcasterLogin, msgId, action === 'allow' ? 'approved' : 'denied', null)
        return
      }
      if (res?.error === 'gone') {
        row.status = 'expired'
        row.resolvedBy = null
        clearAutomodExpiry(msgId)
        patchAutomodRowDom(row)
        return
      }
      row.status = 'error'
      // Three distinct failures, three distinct sentences. `relink_required`
      // is the twitch grant; `auth_required` is our own expired session, and
      // telling someone to relink twitch for that sends them round a loop
      // relinking can never close.
      row.errorText =
        res?.error === 'relink_required'
          ? t('mc_automod_relink_toast')
          : res?.error === 'auth_required'
            ? t('mc_automod_signin')
            : t('mc_automod_error')
      patchAutomodRowDom(row)
    })
    .catch(() => {
      row.status = 'error'
      row.errorText = t('mc_automod_error')
      patchAutomodRowDom(row)
    })
}

function installAutomodClickHandler() {
  if (_onceGuardsAutomod.automodBtnHandler) return
  _onceGuardsAutomod.automodBtnHandler = true
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('.hs-mc-automod-allow, .hs-mc-automod-deny')
      if (!btn) return
      const rowEl = btn.closest('.hs-mc-automod')
      if (!rowEl) return
      handleAutomodActionClick(rowEl, btn.classList.contains('hs-mc-automod-allow') ? 'allow' : 'deny')
    },
    { signal: mcSignal },
  )
}

// ── watch registration sweep ─────────────────────────────────────────────────

// Own-channel detection: GQL self.isModerator is FALSE for the broadcaster in
// their own channel (broadcaster ≠ moderator role), which silently skipped
// the user's own channel in the sweep — the one channel they always mod.
let _automodSelfLogin = null
async function automodSelfLogin() {
  if (_automodSelfLogin !== null) return _automodSelfLogin
  try {
    const data = await twitchGql('{ currentUser { login } }')
    _automodSelfLogin = (data?.data?.currentUser?.login || '').toLowerCase()
  } catch (_) {
    _automodSelfLogin = ''
  }
  return _automodSelfLogin
}

async function resolveAutomodBroadcasterId(login) {
  if (_automodBroadcasterIdCache.has(login)) return _automodBroadcasterIdCache.get(login)
  try {
    const res = await safeSendMessage({ type: 'resolve_twitch_id', login })
    const id = res?.id ? String(res.id) : null
    if (id) _automodBroadcasterIdCache.set(login, id)
    return id
  } catch (_) {
    return null
  }
}

// Single periodic sweep over joined twitch channels the user mods — registers
// (and, via background.js's own throttle, keeps alive) the server-side
// AutoMod-hold watch for each. isModFor is the same cached/deduped check the
// mod-toolbar hover uses, so repeated sweeps are cheap after the first pass.
async function automodSweep() {
  if (!isEnabled('automod-queue')) {
    _stampSweepTrace('subsystem-disabled')
    return
  }
  if (typeof config === 'undefined' || !Array.isArray(config?.channels)) {
    _stampSweepTrace('no-config')
    return
  }
  // Per-channel work is independent (own isModFor cache entry, own broadcaster
  // id, own watch call) — run the sweep concurrently instead of serially
  // awaiting each channel in turn.
  const trace = []
  await Promise.all(
    config.channels.map(async (ch) => {
      const login = (ch?.twitch || '').toLowerCase()
      if (!login) return
      try {
        const self = await automodSelfLogin()
        const modded = login === self || (typeof isModFor === 'function' && (await isModFor(login)))
        if (!modded) {
          trace.push(`${login}:not-mod(self=${self || '?'})`)
          return
        }
        const broadcasterId = await resolveAutomodBroadcasterId(login)
        if (!broadcasterId) {
          trace.push(`${login}:no-id`)
          return
        }
        // wantPending on the first pass only: BG throttles the watch call to
        // once per 30min per channel, and a page that reloads inside that
        // window would otherwise open an empty queue over messages twitch is
        // still holding — the exact case the backfill exists for.
        const wantPending = !_automodBackfilled.has(broadcasterId)
        const res = await safeSendMessage({ type: 'automod_watch', broadcasterId, wantPending })
        if (wantPending) _automodBackfilled.add(broadcasterId)
        const added = res?.ok ? injectPendingAutomodHolds(res.pending) : 0
        trace.push(`${login}:watched${added ? `+${added}pending` : ''}`)
      } catch (e) {
        trace.push(`${login}:err(${e?.message || 'unknown'})`)
      }
    }),
  )
  _stampSweepTrace(trace.join(' ') || 'no-channels')
}

// Dev-build sweep breadcrumb — the per-channel catch in automodSweep swallows
// every failure silently, which cost a live-debug session (2026-07-18:
// own-channel watch never registered, zero signal anywhere). Every exit path
// stamps, so "attr absent" can only mean the sweep never ran at all. Read via
// document.documentElement.dataset.hsAutomodSweep.
function _stampSweepTrace(text) {
  if (typeof __HS_DEV_BUILD__ === 'undefined' || !__HS_DEV_BUILD__) return
  try {
    document.documentElement.dataset.hsAutomodSweep = `${new Date().toTimeString().slice(0, 8)} ${text}`
  } catch (_) {}
}

function initAutomodQueue() {
  cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'automod_hold') {
      if (!isEnabled('automod-queue')) return
      const row = automodHoldToRowModel(msg)
      if (!row) return
      if (!shouldProcessAutomodHold(_automodSeenHolds, row.msgId, Date.now())) return
      insertAutomodHoldRow(row)
      return
    }
    if (msg.type === 'automod_update') {
      if (!isEnabled('automod-queue')) return
      const broadcasterLogin = String(msg.broadcasterLogin || '').toLowerCase()
      const msgId = String(msg.msgId || '')
      if (!broadcasterLogin || !msgId) return
      resolveAutomodRow(broadcasterLogin, msgId, msg.status, msg.modLogin)
      return
    }
    if (msg.type === 'automod_relink') {
      if (!isEnabled('automod-queue')) return
      if (_automodRelinkShown) return
      _automodRelinkShown = true
      try {
        HsNotifs.emit('automod-relink', {})
      } catch (_) {}
    }
  })
  installAutomodClickHandler()
  // Give config/mod-state a moment to settle after boot rather than racing them.
  cleanup.setTimeout(() => automodSweep(), 3000)
  cleanup.setInterval(() => automodSweep(), AUTOMOD_SWEEP_INTERVAL_MS)
}
