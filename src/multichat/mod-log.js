// Mod-action log — pure helpers for the streamer/mod popout view (drag to a
// stream monitor / capture in OBS). Self-contained: no DOM or bundle-closure
// deps, so it's unit-testable outside the bundle. Mirrors filter-rules.js — the
// source `export`s for tests; the build strips exports to bundle-globals that
// main.js calls directly.
//
// THE LOG SURVIVES A RELOAD. It lives in chrome.storage.local (this device
// only — never synced, never in a settings export) under MOD_LOG_KEY, newest
// MOD_LOG_PER_CHANNEL entries per channel, oldest dropped first. A burst in one
// channel can never push another channel's history out. createModLogStore is
// the storage half; main-state.js wires it to the page's real storage and
// timers, and the tests wire it to fakes.
//
// Every string the log SAYS comes from the catalog (modLogLine / formatDuration
// take the translator). Nothing in here is english.

const MOD_LOG_KEY = 'hs_modlog_v1'
const MOD_LOG_PER_CHANNEL = 500

// Notice types that represent a mod action worth logging.
const MOD_NOTICE_TYPES = new Set([
  'ban_success',
  'timeout_success',
  'unban_success',
  'untimeout_success',
  'delete_message_success',
])

const MOD_ACTION_MAP = {
  ban_success: 'ban',
  timeout_success: 'timeout',
  unban_success: 'unban',
  untimeout_success: 'untimeout',
  delete_message_success: 'delete',
}

const MOD_ACTION_NAMES = new Set(Object.values(MOD_ACTION_MAP))

// Is this message a mod-action notice we log?
function isModNotice(msg) {
  return !!msg && msg.type === 'notice' && MOD_NOTICE_TYPES.has(msg.noticeType)
}

// Build a structured, render-ready log entry from a mod-action notice. Returns
// null for non-mod messages. Pure: no Date.now() fallback (stays deterministic
// for tests) — callers pass notices that already carry msg.time.
function modLogEntryFromNotice(msg) {
  if (!isModNotice(msg)) return null
  const target = (msg.targetUser || '').toLowerCase()
  const channel = (msg.channel || '').toLowerCase()
  const id = msg.id || `${msg.noticeType}:${channel}:${target}:${msg.time || 0}`
  return {
    id,
    action: MOD_ACTION_MAP[msg.noticeType] || msg.noticeType,
    target,
    // WHO did it, when the page knows. Twitch's CLEARCHAT/CLEARMSG and Kick's
    // moderation events never say, so only an action taken through heatsync (the
    // synthetic notice mod-toolbar.js injects) carries a name. '' = not known.
    actor: String(msg.actor || '')
      .trim()
      .toLowerCase(),
    durationSec: msg.banDuration || 0,
    channel,
    platform: msg.platform || 'twitch',
    text: msg.systemMsg || msg.text || '',
    time: msg.time || 0,
  }
}

// What a channel is, for the cap: the same login on twitch and kick is two channels.
function modLogChannelKey(entry) {
  return `${entry.platform || 'twitch'}:${entry.channel || ''}`
}

// Keep at most `max` entries per channel, oldest first out. Mutates the log.
function capModLogPerChannel(log, max) {
  const counts = new Map()
  for (const e of log) {
    const k = modLogChannelKey(e)
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  for (let i = 0; i < log.length; ) {
    const k = modLogChannelKey(log[i])
    if (counts.get(k) > max) {
      counts.set(k, counts.get(k) - 1)
      log.splice(i, 1)
    } else i++
  }
  return log
}

// Append an entry to a log, deduped by id (cheap last-id short-circuit, then a
// reverse scan for the recent-dup common case). Mutates + returns the log.
// `max` caps retained entries PER CHANNEL (oldest trimmed first).
function pushModLogEntry(log, entry, max = MOD_LOG_PER_CHANNEL) {
  if (!entry) return log
  const n = log.length
  if (n && log[n - 1].id === entry.id) return log
  for (let i = n - 1; i >= 0; i--) if (log[i].id === entry.id) return log
  log.push(entry)
  return capModLogPerChannel(log, max)
}

// Two logs into one: union by id, oldest first, per-channel cap. Pure — the
// stored copy and the in-memory one are merged this way both ways, so neither
// a reload nor a second tab can lose entries.
function mergeModLogs(a, b, max = MOD_LOG_PER_CHANNEL) {
  const seen = new Set()
  const all = []
  for (const e of [...a, ...b]) {
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    all.push(e)
  }
  all.sort((x, y) => (x.time || 0) - (y.time || 0))
  return capModLogPerChannel(all, max)
}

const _str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

// Whatever storage hands back, as clean entries: anything that is not an entry
// (corrupt value, an older shape, hand-edited junk) is dropped, never thrown on.
function sanitizeStoredModLog(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : []
  const out = []
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || !MOD_ACTION_NAMES.has(e.action)) continue
    const time = Number(e.time)
    const dur = Number(e.durationSec)
    out.push({
      id: e.id.slice(0, 200),
      action: e.action,
      target: _str(e.target, 64),
      actor: _str(e.actor, 64),
      durationSec: Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 0,
      channel: _str(e.channel, 64),
      platform: _str(e.platform, 16) || 'twitch',
      text: _str(e.text, 300),
      time: Number.isFinite(time) && time > 0 ? time : 0,
    })
  }
  return out
}

/**
 * The persistence half. `log` is the live in-memory array (modActionLog); it is
 * only ever changed in place, because the tab renders straight from it.
 *
 *   record(msg)  log a mod notice (no-op for anything else) and schedule a write
 *   load()       merge what storage holds into the log — once, at boot
 *   absorb(raw)  merge a stored value another tab just wrote
 *   flush()      write now (pagehide)
 *
 * A write is read-merge-write, never a blind overwrite: two tabs of the same
 * browser each keep their own log, and each one's write must carry the other's
 * entries along. Writes are queued one at a time so two flushes can't interleave
 * their read and their write.
 *
 * @param {{ log: object[], storage: () => ({get: Function, set: Function}|null),
 *           setTimer: (fn: Function, ms: number) => *, clearTimer: (t: *) => void,
 *           debounceMs?: number, max?: number }} deps
 */
function createModLogStore({ log, storage, setTimer, clearTimer, debounceMs = 1500, max = MOD_LOG_PER_CHANNEL }) {
  let timer = null
  let queue = Promise.resolve()

  const swapIn = (merged) => log.splice(0, log.length, ...merged)

  const write = async () => {
    const area = storage()
    if (!area) return
    const stored = sanitizeStoredModLog((await area.get(MOD_LOG_KEY))?.[MOD_LOG_KEY])
    const merged = mergeModLogs(stored, log, max)
    swapIn(merged)
    await area.set({ [MOD_LOG_KEY]: { entries: merged, ts: Date.now() } })
  }

  const flush = () => {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    queue = queue.then(write).catch(() => {})
    return queue
  }

  return {
    record(msg) {
      const entry = modLogEntryFromNotice(msg)
      if (!entry) return null
      if (log.some((e) => e.id === entry.id)) return null // a duplicate: nothing new to keep
      pushModLogEntry(log, entry, max)
      if (!timer) {
        timer = setTimer(() => {
          timer = null
          flush()
        }, debounceMs)
      }
      return entry
    },
    async load() {
      const area = storage()
      if (!area) return
      try {
        const stored = sanitizeStoredModLog((await area.get(MOD_LOG_KEY))?.[MOD_LOG_KEY])
        swapIn(mergeModLogs(stored, log, max))
      } catch (_) {}
    },
    absorb(raw) {
      const stored = sanitizeStoredModLog(raw)
      if (stored.length) swapIn(mergeModLogs(stored, log, max))
    },
    flush,
  }
}

// Compact human duration for a timeout (e.g. 600 → "10m"). '' for 0/none.
// `tr` is the translator: the unit letters are the viewer's language's.
function formatDuration(sec, tr = t) {
  const s = Math.max(0, Math.floor(sec || 0))
  if (s === 0) return ''
  if (s < 60) return tr('mc_modlog_dur_s', [String(s)])
  if (s < 3600) return tr('mc_modlog_dur_m', [String(Math.floor(s / 60))])
  if (s < 86400) return tr('mc_modlog_dur_h', [String(Math.floor(s / 3600))])
  return tr('mc_modlog_dur_d', [String(Math.floor(s / 86400))])
}

// One-line human summary of a log entry, for the popout row — in the viewer's
// language. WHO did it is not in the sentence (word order differs too much to
// splice a name into): the row shows it beside the line, see modLogBy.
function modLogLine(entry, tr = t) {
  if (!entry) return ''
  const who = entry.target || tr('mc_modlog_someone')
  if (entry.action === 'ban') return tr('mc_modlog_ban', [who])
  if (entry.action === 'timeout') {
    const d = formatDuration(entry.durationSec, tr)
    return d ? tr('mc_modlog_timeout_for', [who, d]) : tr('mc_modlog_timeout', [who])
  }
  if (entry.action === 'unban') return tr('mc_modlog_unban', [who])
  if (entry.action === 'untimeout') return tr('mc_modlog_untimeout', [who])
  if (entry.action === 'delete') return entry.target ? tr('mc_modlog_delete', [who]) : tr('mc_modlog_delete_any')
  return entry.text || entry.action || ''
}

// "by alice" — the acting mod, '' when it isn't known.
function modLogBy(entry, tr = t) {
  return entry?.actor ? tr('mc_modlog_by', [entry.actor]) : ''
}

// Filter a log by action type and/or a free-text query (matches target/channel).
// Pure — drives the popout's filter controls.
function filterModLog(log, opts = {}) {
  const action = opts.action || ''
  const q = (opts.query || '').trim().toLowerCase()
  return log.filter((e) => {
    if (action && e.action !== action) return false
    if (q && !((e.target || '').includes(q) || (e.channel || '').includes(q))) return false
    return true
  })
}

export {
  capModLogPerChannel,
  createModLogStore,
  filterModLog,
  formatDuration,
  isModNotice,
  MOD_LOG_KEY,
  MOD_LOG_PER_CHANNEL,
  MOD_NOTICE_TYPES,
  mergeModLogs,
  modLogBy,
  modLogChannelKey,
  modLogEntryFromNotice,
  modLogLine,
  pushModLogEntry,
  sanitizeStoredModLog,
}
