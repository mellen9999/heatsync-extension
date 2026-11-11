// Sub flair + heat for TWITCH chat rows: what is known about each chatter, asked in batches through the
// background (a content-script fetch to heatsync.org trips the edge), kept briefly, bounded. The decisions
// (tiers, order, validation) are name-marks.js; this file only holds data and paints rows.
//
// flair: keyed by twitch id, ttl 600s, <=500 chatters, 50 per request. heat: keyed by login, ttl 120s,
// <=1000 logins, 25 per request, kept live by the server's heat push. never a request per row.

const _hsmSets = {
  flair: { map: new Map(), q: new Set(), size: HSM_FLAIR_BATCH, ttl: HSM_FLAIR_TTL, max: HSM_FLAIR_MAX, zero: null },
  heat: { map: new Map(), q: new Set(), size: HSM_HEAT_BATCH, ttl: HSM_HEAT_TTL, max: HSM_HEAT_MAX, zero: 0 },
}
const _HSM_ASK_AGAIN = 30000 // an ask that never answered may be repeated after this
const _HSM_QUEUE_MAX = 600
let _hsmTimer = null
let _hsmFails = 0
let _hsmWaitUntil = 0

/** the three switches, all on by default; false only when the viewer turned it off */
function hsMarksOn(key) {
  return getSetting(key) !== false
}

// what a value draws: the flair image, or the bar's glyph + ink. a change in it means a repaint
function _hsmSig(kind, v) {
  const b = kind === 'heat' ? hsMarksBar(v) : null
  return kind === 'heat' ? `${b?.glyph}${b?.ink}` : v?.url
}

/** the held value for key (flair: validated {url,title}|null; heat: score), asking when unknown/stale */
function _hsmGet(kind, key) {
  const s = _hsmSets[kind]
  let e = s.map.get(key)
  if (!e) {
    if (s.map.size >= s.max) s.map.delete(s.map.keys().next().value)
    e = { v: s.zero, at: 0, asked: 0 }
    s.map.set(key, e)
  }
  const now = Date.now()
  if (now - e.at > s.ttl && now - e.asked > _HSM_ASK_AGAIN && s.q.size < _HSM_QUEUE_MAX) {
    s.q.add(key)
    if (!_hsmTimer) _hsmTimer = cleanup.setPageTimeout(_hsmFlush, Math.max(500, _hsmWaitUntil - now))
  }
  return e.v
}

function _hsmFlush() {
  _hsmTimer = null
  const changed = new Set()
  const jobs = Object.entries(_hsmSets).map(async ([kind, s]) => {
    const ids = [...s.q].slice(0, s.size)
    for (const id of ids) {
      s.q.delete(id)
      const e = s.map.get(id)
      if (e) e.asked = Date.now()
    }
    if (!ids.length) return true
    let body = null
    try {
      const resp = await safeSendMessage({ type: 'fetch_name_marks', kind, ids })
      if (resp?.ok) body = resp.body
    } catch (_) {}
    const rows = (kind === 'flair' ? body?.flairs : body?.users) ?? null
    for (const id of ids) {
      const e = s.map.get(id)
      if (!e) continue
      e.asked = 0
      if (!rows || typeof rows !== 'object') continue
      const row = Object.hasOwn(rows, id) ? rows[id] : null
      const v = kind === 'flair' ? hsMarksFlair(row) : hsMarksScore(row?.heat)
      if (_hsmSig(kind, e.v) !== _hsmSig(kind, v)) changed.add(id)
      e.v = v
      e.at = Date.now()
    }
    return !!rows && typeof rows === 'object'
  })
  Promise.all(jobs).then((oks) => {
    // failures wait 5s doubling to 60s; a good answer resets it
    const failed = oks.includes(false)
    _hsmFails = failed ? _hsmFails + 1 : 0
    _hsmWaitUntil = failed ? Date.now() + Math.min(60000, 5000 * 2 ** (_hsmFails - 1)) : 0
    if (!_hsmTimer && (_hsmSets.flair.q.size || _hsmSets.heat.q.size)) {
      _hsmTimer = cleanup.setPageTimeout(_hsmFlush, Math.max(500, _hsmWaitUntil - Date.now()))
    }
    if (changed.size) hsMarksRepaint(changed)
  })
}

/** your account changed (flair set or cleared on any device): every held flair is asked again, and a row
 * whose answer changed (yours) repaints when it lands */
function hsMarksForgetSelf() {
  const s = _hsmSets.flair
  for (const [k, e] of s.map) {
    e.at = 0
    s.q.add(k)
  }
  _hsmFlush()
}

/** a cosmetic push named these ids (flair set or cleared): every flair held under one is asked again, and a
 * row whose answer changed repaints when it lands. ids this pane never held are ignored — a push reaches
 * every open chat, and it must not turn into a fetch per chat. */
function hsMarksRefreshIds(ids) {
  const s = _hsmSets.flair
  let n = 0
  for (const raw of Array.isArray(ids) ? ids.slice(0, 200) : []) {
    const id = String(raw)
    const e = s.map.get(id)
    if (!e) continue
    e.at = 0
    s.q.add(id)
    n++
  }
  if (n) _hsmFlush()
  return n
}

/** the server's heat push: new scores for logins we hold (a push never grows the cache) */
function hsMarksOnHeatPush(updates) {
  if (!Array.isArray(updates)) return
  const changed = new Set()
  for (const u of updates.slice(0, 500)) {
    const login = typeof u?.username === 'string' ? u.username.toLowerCase() : ''
    const e = _hsmSets.heat.map.get(login)
    if (!e) continue
    const next = hsMarksScore(u.userHeat)
    if (_hsmSig('heat', e.v) !== _hsmSig('heat', next)) changed.add(login)
    e.v = next
    e.at = Date.now()
  }
  if (changed.size) hsMarksRepaint(changed)
}

/** a sender emote set is "known" when it holds a live emote: we have seen heatsync content from them */
/** does this chatter show a heatsync badge this build can draw? (badges.js, lib/badge-catalogue.js) */
function hsMarksBadged(uid) {
  if (!uid || typeof getHsBadgeId !== 'function' || typeof badgeById !== 'function') return false
  return !!badgeById(getHsBadgeId(uid))
}

function hsMarksKnown(uid) {
  const set = uid && typeof getSenderEmotes === 'function' ? getSenderEmotes(`twitch:${uid}`) : null
  if (!set?.size) return false
  for (const e of set.values()) if (!e?.removedAt) return true
  return false
}

// name-marks.js is vendored byte for byte and prints these two titles in english; the host says them in the viewer's
// language. anchored on the class so no escaped user text can match
function hsMarksL10n(html) {
  return html
    .replace(
      'class="hs-mark-flame" title="heatsync user"',
      () => `class="hs-mark-flame" title="${_hsmEsc(t('mc_mark_user'))}"`,
    )
    .replace(
      /(class="hs-mark-heat hs-mark-heat-\w+") title="heat"/,
      (_, cls) => `${cls} title="${_hsmEsc(t('lib_opt_heat'))}"`,
    )
}

/** the marks span a twitch row carries before its name ('' when all three switches are off) */
function hsMarksRowHtml(m, uid) {
  const flairOn = hsMarksOn('subFlair')
  const flameOn = hsMarksOn('flame')
  const barsOn = hsMarksOn('heatBars')
  if (!flairOn && !flameOn && !barsOn) return ''
  const login = String(m?.user ?? '').toLowerCase()
  const flair = flairOn && /^\d{1,20}$/.test(uid) ? _hsmGet('flair', uid) : null
  const heat = (flameOn || barsOn) && hsMarksValidLogin(login) ? _hsmGet('heat', login) : 0
  // a picked heatsync badge takes the flame's place: one heatsync mark per name
  const wear = hsMarksWear(flameOn && !hsMarksBadged(uid), barsOn, flameOn && hsMarksKnown(uid), isSelf(m), heat)
  return `<span class="hs-mc-marks">${hsMarksL10n(hsMarksHtml(flair, wear))}</span>`
}

/** logins or ids whose marks changed: repaint the drawn rows in place (rows built later read the caches) */
function hsMarksRepaint(keys) {
  try {
    const msgs = document.getElementById('hs-mc-messages')
    if (!msgs) return
    let any = false
    for (const div of msgs.querySelectorAll('.hs-mc-msg[data-msg-key]')) {
      const m = div._hsMsg
      const slot = div.querySelector('.hs-mc-marks')
      if (!m || !slot || (m.platform && m.platform !== 'twitch')) continue
      const login = String(m.user ?? '').toLowerCase()
      if (!keys.has(login) && !keys.has(String(m.userId ?? ''))) continue
      const html = hsMarksRowHtml(m, String(m.userId ?? ''))
      const inner = html.slice('<span class="hs-mc-marks">'.length, -'</span>'.length)
      if (slot.innerHTML !== inner) {
        slot.innerHTML = inner
        any = true
      }
    }
    if (any) pinAfterInPlaceUpdate()
  } catch (_) {}
}

cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
  if (msg?.type === 'heat_batch_update') hsMarksOnHeatPush(msg.updates)
  else if (msg?.type === 'account_changed') hsMarksForgetSelf()
})
