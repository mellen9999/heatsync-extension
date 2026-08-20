// Background script - Fetch emote inventory and manage WebSocket

// Chrome compatibility - Firefox uses 'browser', Chrome uses 'chrome'
const browser = globalThis.browser || chrome
// --- error reporter (service worker) ---
// Inlined here because lib/ is bundled into content scripts only. Same shape
// as src/lib/error-reporter.js: ring-buffer 50 in chrome.storage.local key
// 'hs_errors', popup reads + clears.
;(() => {
  if (globalThis.__hsErrorReporterSw) return
  const MAX = 50,
    KEY = 'hs_errors',
    MSG_CAP = 500,
    STACK_CAP = 2000
  let ver = 'unknown'
  try {
    ver = browser.runtime.getManifest().version || ver
  } catch (_) {}
  const pending = []
  let timer = null
  let reentry = false
  function trunc(s, n) {
    if (typeof s !== 'string') {
      try {
        s = String(s)
      } catch {
        return ''
      }
    }
    return s.length > n ? s.slice(0, n) : s
  }
  const SENSITIVE_PARAMS =
    /^(access_token|refresh_token|id_token|token|auth|authorization|key|apikey|api_key|password|passwd|secret|code|state|session|sig|signature)$/i
  function scrubUrl(url) {
    if (typeof url !== 'string') return url
    try {
      const qIdx = url.indexOf('?')
      const hIdx = url.indexOf('#')
      if (qIdx === -1 && hIdx === -1) return url
      const base = qIdx !== -1 ? url.slice(0, qIdx) : hIdx !== -1 ? url.slice(0, hIdx) : url
      const qPart = qIdx !== -1 ? url.slice(qIdx + 1, hIdx !== -1 ? hIdx : undefined) : ''
      const hPart = hIdx !== -1 ? url.slice(hIdx + 1) : ''
      function scrubPairs(str) {
        if (!str) return str
        return str.replace(/([^&=]+)=([^&]*)/g, (_, k, v) => {
          return SENSITIVE_PARAMS.test(decodeURIComponent(k).trim()) ? `${k}=REDACTED` : `${k}=${v}`
        })
      }
      let result = base
      if (qPart) result += `?${scrubPairs(qPart)}`
      if (hPart) result += `#${scrubPairs(hPart)}`
      return result
    } catch (_) {
      return url
    }
  }
  const TEXT_SCRUB = [
    /Bearer\s+[\w.-]+/gi,
    /oauth:[\w.-]+/gi,
    /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
    /(?<=[=\s"':])[A-Za-z0-9_\-+/=]{24,}/g,
  ]
  function scrubText(s) {
    if (typeof s !== 'string') return s
    for (const re of TEXT_SCRUB) {
      s = s.replace(re, '[REDACTED]')
    }
    return s
  }
  function fmt(e) {
    if (e == null) return { msg: '' }
    if (e instanceof Error || (typeof e === 'object' && e && 'stack' in e)) {
      let msg = ''
      let stack = ''
      try {
        msg = String(e.message || '')
      } catch (_) {}
      try {
        stack = String(e.stack || '')
      } catch (_) {}
      if (!msg) {
        try {
          msg = String(e)
        } catch (_) {
          msg = '[unreadable]'
        }
      }
      if (msg === '[object Object]') msg = ''
      return { msg: trunc(scrubText(msg), MSG_CAP), stack: trunc(scrubText(stack), STACK_CAP) }
    }
    if (typeof e === 'object') {
      try {
        const s = JSON.stringify(e)
        if (s && s !== '{}' && s !== '[]') return { msg: trunc(scrubText(s), MSG_CAP) }
      } catch (_) {}
      try {
        return { msg: trunc(scrubText(String(e)), MSG_CAP) }
      } catch {
        return { msg: '[unserializable]' }
      }
    }
    return { msg: trunc(scrubText(String(e)), MSG_CAP) }
  }
  function synthStack(skip) {
    try {
      const s = String(new Error().stack || '')
      return s
        .split('\n')
        .slice((skip || 0) + 1)
        .join('\n')
    } catch (_) {
      return ''
    }
  }
  function capture(rec) {
    if (reentry) return
    if (!rec.msg && !rec.stack) return
    if (rec.msg === 'Script error.' && !rec.stack) return
    if (rec.url && rec.url !== 'background') rec = { ...rec, url: scrubUrl(rec.url) }
    if (rec.msg) rec = { ...rec, msg: scrubText(rec.msg) }
    if (rec.stack) rec = { ...rec, stack: scrubText(rec.stack) }
    reentry = true
    try {
      pending.push(rec)
      if (pending.length > MAX) pending.splice(0, pending.length - MAX)
      if (!timer) timer = setTimeout(flush, 500)
    } finally {
      reentry = false
    }
  }
  // Serialize get→concat→set flushes — overlapping flushes would read the
  // same base array and the later set() would drop the earlier batch.
  let flushChain = Promise.resolve()
  function flush() {
    timer = null
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    flushChain = flushChain
      .then(
        () =>
          new Promise((resolve) => {
            try {
              browser.storage.local.get(KEY, (cur) => {
                try {
                  if (browser.runtime.lastError) return resolve()
                  const existing = Array.isArray(cur?.[KEY]) ? cur[KEY] : []
                  const next = existing.concat(batch).slice(-MAX)
                  browser.storage.local.set({ [KEY]: next }, () => {
                    void browser.runtime.lastError
                    resolve()
                  })
                } catch (_) {
                  resolve()
                }
              })
            } catch (_) {
              resolve()
            }
          }),
      )
      .catch(() => {})
  }
  try {
    self.addEventListener('error', (e) => {
      const f = fmt(e.error != null ? e.error : e.message)
      capture({
        ts: Date.now(),
        type: 'error',
        plat: 'sw',
        ver,
        url: 'background',
        msg: f.msg,
        stack: f.stack,
        file: trunc(e.filename || '', 200),
        line: e.lineno || 0,
      })
    })
  } catch (_) {}
  try {
    self.addEventListener('unhandledrejection', (e) => {
      const f = fmt(e.reason)
      const stack = f.stack || synthStack(2)
      capture({
        ts: Date.now(),
        type: 'rejection',
        plat: 'sw',
        ver,
        url: 'background',
        msg: f.msg || '(promise rejection with no reason)',
        stack,
      })
    })
  } catch (_) {}
  try {
    const origErr = console.error
    if (origErr && !origErr.__hsWrapped) {
      const wrapped = function (...args) {
        try {
          let derivedStack = ''
          const parts = args.map((a) => {
            if (a instanceof Error || (typeof a === 'object' && a && 'stack' in a)) {
              if (!derivedStack && a.stack) {
                try {
                  derivedStack = String(a.stack)
                } catch (_) {}
              }
              try {
                return String(a.message || a)
              } catch (_) {
                return '[unreadable]'
              }
            }
            if (typeof a === 'string') return a
            try {
              const s = JSON.stringify(a)
              return s && s !== '{}' ? s : String(a)
            } catch {
              return String(a)
            }
          })
          const msg = parts.filter((p) => p && p !== '[object Object]').join(' ')
          // Drop transient MV3-lifecycle spam — the SW gets torn down mid-fetch
          // (fetchFollowedUsers/fetchEmoteInventory "Failed to fetch" / "signal is
          // aborted") and ext reloads ("context invalidated"). Not actionable, and
          // it was filling the report buffer. Still prints to devtools.
          if (/signal is aborted|Failed to fetch|context invalidated/i.test(msg)) return origErr.apply(this, args)
          if (!derivedStack) derivedStack = synthStack(2)
          capture({
            ts: Date.now(),
            type: 'console',
            plat: 'sw',
            ver,
            url: 'background',
            msg: trunc(scrubText(msg), MSG_CAP),
            stack: trunc(scrubText(derivedStack), STACK_CAP),
          })
        } catch (_) {}
        return origErr.apply(this, args)
      }
      wrapped.__hsWrapped = true
      console.error = wrapped
    }
  } catch (_) {}
  globalThis.__hsErrorReporterSw = { capture, flush, ver }
})()

// --- user-key.js (service worker) ---
// Inlined here because lib/ is bundled into content scripts only.
// Canonical source: src/lib/user-key.js — keep in sync if either changes.
function canonPlatform(platform) {
  return platform === 'yt' ? 'youtube' : platform
}
function userKey(username, platform) {
  const u = String(username == null ? '' : username)
    .toLowerCase()
    .replace(/^@/, '')
  if (!u) return ''
  const p = canonPlatform(platform)
  return p ? `${p}:${u}` : u
}
function userSetMatches(set, username, platform, aliasKeys) {
  if (!set || set.size === 0) return false
  const u = String(username == null ? '' : username)
    .toLowerCase()
    .replace(/^@/, '')
  if (!u) return false
  if (set.has(u)) return true
  if (set.has(userKey(u, platform))) return true
  // Legacy short-form keys: entries stored as `yt:<name>` before platform
  // canonicalization must keep matching youtube rows.
  if (canonPlatform(platform) === 'youtube' && set.has(`yt:${u}`)) return true
  if (aliasKeys) {
    for (const k of aliasKeys) {
      if (k && set.has(k)) return true
    }
  }
  return false
}

// Storage hygiene — sanitize ui_settings before merging into chrome.storage
// .sync. Strips numeric-string keys (corruption marker), prototype-pollution
// keys, blocklist keys (platformFilters / keywordHighlights / chatFilterRules
// belong in local), oversized strings (>4 KB) and oversized values (JSON
// >6 KB). Mirrors the canonical implementation in src/lib/utils.js —
// duplicated here because the service worker is not bundled with the lib
// (parity enforced at build time by build.js's checkUiSyncBlocklistParity).
const UI_SYNC_BLOCKLIST = new Set(['platformFilters', 'keywordHighlights', 'chatFilterRules'])
// Subset of UI_SYNC_BLOCKLIST that never leaves the device at all — see
// src/lib/utils.js for the full rationale. keywordHighlights/chatFilterRules
// are real prefs and DO ride the server ui-state channel (size-capped);
// platformFilters is per-device tab-layout state and never does.
const DEVICE_LOCAL_KEYS = new Set(['platformFilters'])
// registry key → chrome.storage.local key name — must match src/lib/utils.js
// OVERFLOW_MIRROR_KEYS exactly (parity-checked at build time).
const OVERFLOW_MIRROR_KEYS = {
  platformFilters: 'platform_filters',
  keywordHighlights: 'keyword_highlights',
  chatFilterRules: 'chat_filter_rules',
}
// Per-key cap for blocklist keys riding the server channel — must match
// src/lib/utils.js LARGE_KEY_SYNC_MAX.
const LARGE_KEY_SYNC_MAX = 32768
function estimateSettingSize(value) {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return Infinity
  }
}
function sanitizeUiSettings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out = {}
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue
    if (/^\d+$/.test(key)) continue
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (key.length === 0 || key.length > 64) continue
    if (UI_SYNC_BLOCKLIST.has(key)) continue
    const v = obj[key]
    const t = typeof v
    if (t === 'function' || t === 'symbol') continue
    if (t === 'string' && v.length > 4096) continue
    if (t === 'object' && v !== null) {
      try {
        if (JSON.stringify(v).length > 6144) continue
      } catch {
        continue
      }
    }
    out[key] = v
  }
  return out
}

// Splits a server-fanned ui-state blob (full state or partial patch) into:
//   sync     → sanitizeUiSettings-cleaned keys destined for chrome.storage
//              .sync.ui_settings (existing RMW path, unchanged)
//   overflow → blocklist keys that are real cross-device prefs (not
//              DEVICE_LOCAL_KEYS) and fit under LARGE_KEY_SYNC_MAX, keyed by
//              their chrome.storage.local mirror name — NEVER written to
//              chrome.storage.sync. Oversized or device-local entries are
//              silently dropped (server should already enforce the cap; this
//              is defense in depth against a stale/misbehaving server build).
function splitIncomingUiState(obj) {
  const sync = {}
  const overflow = {}
  if (obj && typeof obj === 'object') {
    for (const key in obj) {
      if (!Object.hasOwn(obj, key)) continue
      if (DEVICE_LOCAL_KEYS.has(key)) continue
      if (UI_SYNC_BLOCKLIST.has(key)) {
        const mirrorKey = OVERFLOW_MIRROR_KEYS[key]
        // string-only: both large keys are serialized strings on the wire
        // (server enforces the same) — never let a server-fanned object/array
        // shape into storage.local, where the sync bucket's sanitizer can't
        // see it. size cap is defense in depth against a stale server build.
        if (mirrorKey && typeof obj[key] === 'string' && estimateSettingSize(obj[key]) <= LARGE_KEY_SYNC_MAX)
          overflow[mirrorKey] = obj[key]
        continue
      }
      sync[key] = obj[key]
    }
  }
  return { sync: sanitizeUiSettings(sync), overflow }
}

// Serialized read-modify-write for ui_settings in sync storage.
// Three message handlers (ui-state:sync/update, settings:patch, settings:delete)
// can race on concurrent WS events. Chain all writes through this so each sees
// the previous write's result before merging.
// Resolves to {ok} — never rejects, so a failed write can't poison the chain
// for every write queued behind it. Callers that surface failures (the
// ui_settings_rmw message handler → content-script quota toast) read .ok.
let _uiSettingsRmwChain = Promise.resolve({ ok: true })
function uiSettingsRmw(mergeFn) {
  _uiSettingsRmwChain = _uiSettingsRmwChain
    .then(async () => {
      const s = await browser.storage.sync.get(['ui_settings'])
      const merged = mergeFn(s.ui_settings || {})
      try {
        await browser.storage.sync.set({ ui_settings: merged })
      } catch (_e) {
        // retry once — sync.set write-op throttling is transient; quota
        // overflows will still fail and must be surfaced, never swallowed
        await new Promise((r) => setTimeout(r, 1000))
        await browser.storage.sync.set({ ui_settings: merged })
      }
      return { ok: true }
    })
    .catch((e) => {
      console.warn('[heatsync] ui_settings sync write failed:', e?.message || e)
      return { ok: false, error: e?.message || String(e) }
    })
  return _uiSettingsRmwChain
}

// Debug logging - set to false for production
const DEBUG = false
const log = DEBUG ? console.log.bind(console, '[heatsync]') : () => {}

log('🔥 BACKGROUND SCRIPT LOADING...')

// Keepalive alarm — prevent Chrome from killing the service worker.
// Chrome minimum alarm period is 0.5 minutes (30s), which resets the inactivity timer.
// IMPORTANT: alarms.create() resets the period each call, so calling it on every SW
// wake makes long-period alarms (refresh-global-emotes 1440min) effectively never fire.
// Only create if not already registered.
async function ensureAlarm(name, opts) {
  try {
    const existing = await browser.alarms?.get?.(name)
    if (!existing) browser.alarms?.create?.(name, opts)
  } catch {
    browser.alarms?.create?.(name, opts)
  }
}
// 'keepalive' + 'hs-ws-watchdog' (both 0.5min — each fire resets the SW idle
// timer, so together they pin the SW alive FOREVER) are platform-tab-gated in
// scheduleWsIdleCheck: cleared when no chat tabs exist so the SW can actually
// idle-die and release its whole heap, re-created when a tab appears.
// Random delayInMinutes is set once per client when the alarm is created and
// persists for the alarm's lifetime — this offsets the *phase* of every
// subsequent fire, so 30k clients don't all hit /api/* at the minute boundary.
//
// TAB_GATED_ALARMS: alarms that only serve open platform tabs. Each period is
// individually long enough for the SW to die between fires, but STAGGERED
// together they wake it faster than the 30s idle timeout — measured in real
// Chrome: with zero tabs the SW never died across 4min of sampling until
// these were cleared. Gated with the lifelines in scheduleWsIdleCheck.
// live-poll / refresh-followed-users / hs-health-poll / hs-kick-follow-sync
// stay unconditional: they power tab-less features (went-live notifications,
// kill-switch recovery, follow mirror).
const TAB_GATED_ALARMS = {
  'refresh-emote-inventory': () => ({ delayInMinutes: 1 + Math.random(), periodInMinutes: 1 }),
  'prune-expired-mutes': () => ({ periodInMinutes: 1 }),
  'hs-7tv-watchdog': () => ({ periodInMinutes: 2 }),
  'hs-yt-bridge-sweep': () => ({ periodInMinutes: 5 }),
}
ensureAlarm('refresh-global-emotes', { delayInMinutes: 1440 + Math.random() * 60, periodInMinutes: 1440 })
ensureAlarm('refresh-emote-inventory', TAB_GATED_ALARMS['refresh-emote-inventory']())
ensureAlarm('prune-expired-mutes', TAB_GATED_ALARMS['prune-expired-mutes']())
// Twitch rides the WS follow:stream:* push (near-instant) + the
// follow:live:snapshot on connect, so the poll is a pure reconcile belt there.
// But Kick/YouTube have NO push path — the poll is still their ONLY live
// detection, so it can't go as slow as a pure-backstop would allow. 2min is
// the compromise: ~halves the old 60s load while keeping Kick/YouTube
// "went live" latency acceptable (5min was too slow for a live product).
ensureAlarm('live-poll', { delayInMinutes: 2 + Math.random(), periodInMinutes: 2 })
// Followed-users refresh — the feed filter's followedUsers cache otherwise only
// updates on login/SW boot, so follows made on heatsync.org (or another device)
// stay invisible until SW eviction. 5 min matches the server's 300s cache TTL.
ensureAlarm('refresh-followed-users', { delayInMinutes: 5 + Math.random(), periodInMinutes: 5 })
// WS watchdog — survives SW eviction. setInterval timers inside onopen die
// when the SW is terminated; this alarm wakes the SW and either reconnects,
// kills a zombie, or sends a heartbeat. Each fire is 30s (chrome.alarms min).
// Created/cleared by scheduleWsIdleCheck (platform-tab-gated, see above).
// 7TV reconnect watchdog — the in-flight setTimeout backoff dies if the SW
// is evicted mid-disconnect. This alarm wakes the SW every 2 min to resurrect
// the 7TV WS if there are emote sets that should be subscribed.
ensureAlarm('hs-7tv-watchdog', TAB_GATED_ALARMS['hs-7tv-watchdog']())
// Server kill-switch poll — recovers from a broken release without forcing a
// CWS update push. delayInMinutes jitter spreads 30k clients' first hit.
ensureAlarm('hs-health-poll', { delayInMinutes: 0.25 + Math.random() * 0.5, periodInMinutes: 5 })
// Reap idle yt send-bridge tabs (see sweepYtBridgeTabs).
ensureAlarm('hs-yt-bridge-sweep', TAB_GATED_ALARMS['hs-yt-bridge-sweep']())
// Kick follow mirror — hourly, matching the server's twitch resync latch. See
// syncKickFollows(): Kick is the one platform the SERVER can never sync, so the
// mirror has to run here. Jittered so 30k clients don't sync on the same tick.
ensureAlarm('hs-kick-follow-sync', { delayInMinutes: 2 + Math.random() * 3, periodInMinutes: 60 })
// ============================================================
// KICK FOLLOW MIRROR
// ============================================================
// heatsync's follow graph mirrors your platform follows, but Kick can ONLY be
// read from a browser: the official api.kick.com has NO followed-channels
// endpoint (no scope for one either), and kick.com/api/v2 403s from any server
// — cloudflare fingerprints non-browser clients, verified from prod itself. The
// session_token that unlocks it lives in the user's cookie jar and is not an
// OAuth token our server could ever hold. So unlike twitch (server-side sync),
// the Kick half of the mirror has to run here in the service worker.
//
// Additive only: we never auto-UNfollow on heatsync when someone unfollows on
// Kick. The twitch importer can safely diff because it owns every
// source='twitch_import' row; here we'd risk deleting follows the user made by
// hand, so a removal needs its own explicit design.
const KICK_FOLLOW_SYNCED_KEY = 'hs_kick_followed_synced'
const KICK_FOLLOW_MAX_PAGES = 40
const KICK_FOLLOW_MAX_NEW_PER_RUN = 50

// GET /api/v2/channels/followed — paginated {nextCursor, channels[]}. Needs
// `Authorization: Bearer <session_token>`; cookies alone return 401 (which is
// why this endpoint reads as nonexistent unless you send the bearer).
async function kickFollowedSlugs(token) {
  const slugs = []
  let cursor = 0
  for (let page = 0; page < KICK_FOLLOW_MAX_PAGES; page++) {
    let data = null
    try {
      const res = await fetchWithTimeout(
        `https://kick.com/api/v2/channels/followed?cursor=${encodeURIComponent(cursor)}`,
        { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, credentials: 'include' },
      )
      if (!res.ok) break
      data = await res.json()
    } catch {
      break
    }
    const chans = Array.isArray(data?.channels) ? data.channels : []
    if (!chans.length) break
    for (const c of chans) if (c?.channel_slug) slugs.push(String(c.channel_slug))
    if (data.nextCursor == null) break
    cursor = data.nextCursor
  }
  return slugs
}

// The followed payload carries only channel_slug/user_username — no numeric id —
// but heatsync's kick shadow ids are kick_<kick USER id> (same shape the
// profile-card synth path builds). The channel record is the only source.
async function kickUserIdForSlug(slug) {
  try {
    const res = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const d = await res.json()
    const id = d?.user_id ?? d?.user?.id
    return id != null && /^\d+$/.test(String(id)) ? String(id) : null
  } catch {
    return null
  }
}

async function syncKickFollows() {
  try {
    const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
    const token = session?.value ? decodeURIComponent(session.value) : null
    if (!token) return // not logged into kick — nothing to mirror
    const hsToken = authToken || (await getAuthCookie())
    if (!hsToken) return // not logged into heatsync — nowhere to mirror to

    const slugs = await kickFollowedSlugs(token)
    if (!slugs.length) return

    const store = await browser.storage.local.get(KICK_FOLLOW_SYNCED_KEY)
    const already = new Set(Array.isArray(store?.[KICK_FOLLOW_SYNCED_KEY]) ? store[KICK_FOLLOW_SYNCED_KEY] : [])
    const fresh = slugs.filter((s) => !already.has(s)).slice(0, KICK_FOLLOW_MAX_NEW_PER_RUN)
    if (!fresh.length) return

    let pushed = 0
    for (const slug of fresh) {
      const kickId = await kickUserIdForSlug(slug)
      if (!kickId) continue
      try {
        // ?kickUsername= is the hint ensureKickShadowUser needs to materialize a
        // shadow account (it verifies the pair server-side before grafting).
        const res = await fetchWithTimeout(
          `${API_URL}/api/follow/kick_${kickId}?kickUsername=${encodeURIComponent(slug)}`,
          { method: 'POST', headers: { Authorization: `Bearer ${hsToken}` } },
        )
        // Already-following comes back as a conflict — still "synced", so mark it
        // and stop retrying it every hour.
        if (res.ok || res.status === 409) {
          already.add(slug)
          pushed++
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250)) // gentle on both APIs
    }
    if (pushed) {
      await browser.storage.local.set({ [KICK_FOLLOW_SYNCED_KEY]: [...already].slice(-2000) })
      log(` [kick-follow-mirror] mirrored ${pushed} kick follow(s) into heatsync`)
      // Same refresh the 'refresh-followed-users' alarm runs, so the new follows
      // show up in the feed filter / live notifications without waiting 5min.
      fetchFollowedUsers().catch(() => {})
    }
  } catch (e) {
    log(' [kick-follow-mirror] failed:', e?.message)
  }
}

// async is safe here: unlike onMessage, alarms ignore the return value
browser.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name === 'hs-kick-follow-sync') {
    await syncKickFollows()
    return
  }
  if (alarm.name === 'hs-emote-refetch') {
    // One-shot retry after a failed channel-emote fetch. Without this, a
    // transient network flake during join left the channel with no 7TV set
    // mapping — no EventAPI subscription AND invisible to the fallback poll
    // (it iterates seventvEmoteSetIds) — a permanent live-emote blackout
    // until the tab rejoined. Re-run the fetch for every active tab channel;
    // fetchChannelOwnerEmotes is TTL-gated so fresh channels are a no-op.
    try {
      if (typeof fetchChannelOwnerEmotes !== 'function' || typeof tabChannels === 'undefined') return
      const seen = new Set()
      for (const entry of tabChannels.values()) {
        const key = entry.channel
        if (!key || seen.has(key)) continue
        seen.add(key)
        const { platform, channel } = splitChKey(key)
        if (!channel) continue
        fetchChannelOwnerEmotes(channel, null, platform).catch(() => {})
      }
    } catch (e) {
      log('hs-emote-refetch error:', e?.message)
    }
    return
  }
  if (alarm.name === 'keepalive') {
    // Just existing is enough to keep the worker alive. Also rides this 30s
    // tick for the yt innertube fallback tap's check — it has no timer of its
    // own (a bare setInterval would die with the service worker; this alarm
    // survives eviction and wakes it).
    try {
      ytTapCheck()
    } catch (e) {
      log(' ytTapCheck failed:', e?.message)
    }
  } else if (alarm.name === 'refresh-global-emotes') {
    fetchGlobalEmotes().catch((err) => console.warn('[heatsync-ext] fetchGlobalEmotes fetch failed:', err?.message))
  } else if (alarm.name === 'refresh-emote-inventory') {
    if (typeof fetchEmoteInventory === 'function') {
      try {
        const p = fetchEmoteInventory()
        if (p?.catch) p.catch((err) => console.warn('[heatsync-ext] fetchEmoteInventory fetch failed:', err?.message))
      } catch (_e) {}
    }
  } else if (alarm.name === 'prune-expired-mutes') {
    if (typeof pruneExpiredMutes === 'function') {
      try {
        pruneExpiredMutes()
      } catch (_e) {}
    }
  } else if (alarm.name === 'live-poll') {
    if (typeof pollFollowedLive === 'function') {
      try {
        pollFollowedLive().catch(() => {})
      } catch {}
    }
  } else if (alarm.name === 'refresh-followed-users') {
    fetchFollowedUsers().catch((err) => console.warn('[heatsync-ext] fetchFollowedUsers refresh failed:', err?.message))
  } else if (alarm.name === 'hs-ws-watchdog') {
    // Kick Pusher tap liveness rides the same alarm (see _kpWatchdogCheck).
    try {
      if (typeof _kpWatchdogCheck === 'function') _kpWatchdogCheck()
    } catch {}
    // Three states to handle:
    //   1) WS not open: kick a fresh connect (no-op if already connecting)
    //   2) WS open + zombie (no data received for 45s): close → reconnect
    //   3) WS open + healthy: send heartbeat to defeat the server's 2min
    //      idle timeout
    try {
      if (typeof isSocketOpen !== 'function') return
      if (!isSocketOpen()) {
        // Idle-closed on purpose — don't resurrect a socket nobody needs
        if (typeof hsWsIdleClosed !== 'undefined' && hsWsIdleClosed) return
        // Auth failed — reconnecting just replays the dead cookie and loops
        // authenticate → authentication_failed every 30s. Only a fresh login
        // (cookies.onChanged 'set' / set_auth_token) clears the block.
        if (typeof authFailedBlock !== 'undefined' && authFailedBlock) return
        if (typeof connectWebSocket === 'function') connectWebSocket().catch(() => {})
        return
      }
      if (typeof lastWsDataReceived !== 'undefined' && lastWsDataReceived && Date.now() - lastWsDataReceived > 45000) {
        log('WS zombie detected (alarm path), reconnecting')
        try {
          socket.close()
        } catch {}
        return
      }
      try {
        socket.send(JSON.stringify({ type: 'presence:heartbeat' }))
      } catch {}
    } catch (e) {
      log('hs-ws-watchdog error:', e?.message)
    }
  } else if (alarm.name === 'hs-yt-bridge-sweep') {
    sweepYtBridgeTabs().catch(() => {})
  } else if (alarm.name === 'hs-health-poll') {
    fetchHealth().catch(() => {})
  } else if (alarm.name === 'hs-7tv-watchdog') {
    // Resurrect the 7TV WS if it died and the in-flight setTimeout backoff
    // was lost to SW eviction. No-op if the WS is already healthy.
    try {
      if (typeof ensure7TVConnection !== 'function') return
      if (typeof seventvEmoteSetIds === 'undefined' || !seventvEmoteSetIds || seventvEmoteSetIds.size === 0) return
      const ws = typeof seventvWebSocket !== 'undefined' ? seventvWebSocket : null
      const dead = !ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)
      if (dead) {
        // Idle-closed on purpose, or no platform tab to serve (covers SW
        // restarts that reset the idle flag) — don't resurrect a socket
        // nobody is listening for. A returning tab reconnects via subscribe.
        if (typeof seventvIdleClosed !== 'undefined' && seventvIdleClosed) return
        try {
          const platformTabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
          if (platformTabs.length === 0) return
        } catch {}
        log('7TV reconnect alarm: WS dead, reviving')
        // Reset backoff cap so we keep trying after an SW restart.
        try {
          seventvReconnectAttempts = 0
        } catch {}
        ensure7TVConnection()
      }
    } catch (e) {
      log('hs-7tv-watchdog error:', e?.message)
    }
  }
})

// ── Edge-block circuit breaker (heatsync.org only) ──────────────────────────
// When Cloudflare rate-limits an IP (429 / error 1015), every heatsync API
// call from this extension is doomed for the ban window — but the retries
// still COUNT toward the rate rule, so a hot-retrying client re-trips it
// forever and the ban self-sustains (observed live 2026-07-20: sender-emote
// batch + auth checks kept a household banned through three back-to-back
// windows). There is no single fetch funnel in this file — dozens of raw
// fetch sites — so the breaker wraps the service worker's global fetch for
// heatsync.org hosts ONLY. While open, calls fail fast with a synthetic 429
// (no network, nothing fed to the edge counter): every caller already
// handles !res.ok, and the edge would have returned 429 anyway, so callers
// can't tell the difference — except the ban actually gets to expire.
// Window doubles on consecutive blocks (20s → 5min cap) and any successful
// heatsync response resets the streak. State is SW-lifetime only: a SW
// restart forgetting the cooldown just means one real request re-probes.
const _hsEdge = { blockedUntil: 0, streak: 0 }
const HS_EDGE_BASE_COOLDOWN_MS = 20_000
const HS_EDGE_MAX_COOLDOWN_MS = 300_000
function _hsEdgeHost(input) {
  try {
    const u = typeof input === 'string' ? input : input?.url
    if (!u) return null
    return new URL(u).hostname
  } catch (_) {
    return null
  }
}
function _hsIsHeatsyncHost(h) {
  return h === 'heatsync.org' || h === 'www.heatsync.org'
}
;(() => {
  const realFetch = self.fetch.bind(self)
  self.fetch = async (input, init) => {
    const host = _hsEdgeHost(input)
    if (!_hsIsHeatsyncHost(host)) return realFetch(input, init)
    if (Date.now() < _hsEdge.blockedUntil) {
      return new Response(null, { status: 429, statusText: 'hs-edge-cooldown' })
    }
    const res = await realFetch(input, init)
    if (res.status === 429) {
      _hsEdge.streak = Math.min(_hsEdge.streak + 1, 5)
      const wait = Math.min(HS_EDGE_BASE_COOLDOWN_MS * 2 ** (_hsEdge.streak - 1), HS_EDGE_MAX_COOLDOWN_MS)
      _hsEdge.blockedUntil = Date.now() + wait
      log(`edge 429 — cooling heatsync API calls for ${Math.round(wait / 1000)}s (streak ${_hsEdge.streak})`)
    } else if (res.status < 500) {
      // Any non-blocked answer proves the edge is serving us again.
      _hsEdge.streak = 0
      _hsEdge.blockedUntil = 0
    }
    return res
  }
})()

// Link preview via heatsync.org server proxy (avoids CORS)
const LINK_PREVIEW_API = 'https://heatsync.org/api/link-preview'

// ── Server kill-switch / version-floor ──────────────────────────────────────
// One endpoint to recover from a broken release without forcing a CWS update
// push. Response shape is frozen at v=1; older clients ignore unknown keys,
// newer servers must keep returning the v1 shape. Fails OPEN — any error
// or schema mismatch leaves the extension fully active. Last-known state is
// cached in storage so SW restart inherits it.
//
//   { v:1, ext_min, ext_hard_min, kill, disabled[], msg }
//
//   kill         — true → every content surface bails on init
//   ext_min      — current_version < this → soft "update available" notif
//   ext_hard_min — current_version < this → hard bail (emergency only)
//   disabled[]   — feature names: 'multichat' | 'mutations' | 'cosmetics' | 'feed' | 'whispers'
//   msg          — optional banner text shown next to update prompt
const HEALTH_URL = 'https://heatsync.org/api/extension/health'
const HEALTH_DEFAULT = Object.freeze({
  v: 1,
  ext_min: '0.0.0',
  ext_hard_min: null,
  kill: false,
  disabled: [],
  msg: null,
})
// A DAILY-ROTATING id, sent with the health poll so the server can count how
// many installs are actually out there and how fast a release rolls out. Before
// this the answer was genuinely unknown — the endpoint was stateless and no
// other surface identified a client.
//
// Rotating is the whole point. The server drops the value into a HyperLogLog and
// stores nothing, and because the id changes at every UTC midnight it cannot be
// joined across days to follow anyone. It is not sent anywhere else, and the
// server tolerates its absence, so an older install just goes uncounted.
async function getInstallId() {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const { hs_install_id, hs_install_id_day } = await browser.storage.local.get(['hs_install_id', 'hs_install_id_day'])
    if (hs_install_id && hs_install_id_day === today) return hs_install_id
    const fresh = crypto.randomUUID()
    await browser.storage.local.set({ hs_install_id: fresh, hs_install_id_day: today })
    return fresh
  } catch {
    return null
  }
}

async function fetchHealth() {
  try {
    // Identity is best-effort: a storage failure must never cost us the
    // kill-switch, so the poll goes out plain rather than not at all.
    let url = HEALTH_URL
    try {
      const id = await getInstallId()
      const version = browser.runtime.getManifest()?.version
      if (id) {
        const q = new URLSearchParams({ id })
        if (version) q.set('v', version)
        url = `${HEALTH_URL}?${q}`
      }
    } catch {}
    const resp = await fetchWithTimeout(url, { cache: 'no-store' }, 8000)
    if (!resp?.ok) return
    const j = await resp.json().catch(() => null)
    if (!j || typeof j !== 'object' || j.v !== 1) return
    const sane = {
      v: 1,
      ext_min: typeof j.ext_min === 'string' ? j.ext_min : HEALTH_DEFAULT.ext_min,
      ext_hard_min: typeof j.ext_hard_min === 'string' ? j.ext_hard_min : null,
      kill: j.kill === true,
      disabled: Array.isArray(j.disabled) ? j.disabled.filter((x) => typeof x === 'string').slice(0, 32) : [],
      msg: typeof j.msg === 'string' ? j.msg.slice(0, 200) : null,
    }
    await browser.storage.local.set({ hs_health: sane, hs_health_at: Date.now() })
  } catch {}
}
// A cached kill/disabled/ext_hard_min flag is meant to survive a SW restart,
// not outlive the server that set it. If heatsync.org has been unreachable
// (or fetchHealth just never won a race) for a full day, a bad or
// deploy-time-cached value would otherwise brick every install to zero UI
// forever, even after the server recovered — the kill-switch never re-fetches
// once it thinks it's dead. Age it out and fail open; ext_min/msg (soft,
// non-destructive) ride along untouched.
const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000
async function getCachedHealth() {
  try {
    const { hs_health, hs_health_at } = await browser.storage.local.get(['hs_health', 'hs_health_at'])
    if (!hs_health) return HEALTH_DEFAULT
    const stale = typeof hs_health_at !== 'number' || Date.now() - hs_health_at > HEALTH_MAX_AGE_MS
    if (stale && (hs_health.kill || hs_health.disabled?.length || hs_health.ext_hard_min)) {
      return { ...hs_health, kill: false, disabled: [], ext_hard_min: null }
    }
    return hs_health
  } catch {
    return HEALTH_DEFAULT
  }
}
// First fetch is non-blocking — SW init must not stall on a slow heatsync.org.
fetchHealth().catch(() => {})

// Show welcome page on first install, clear stale intervals on update
browser.runtime.onInstalled.addListener((details) => {
  log(' 📦 onInstalled - extension installed/updated', details.reason)
  // Spread the herd: when 30k Chrome clients auto-update around the same
  // hour, every SW will wake and try to connect /ws at once. Delay each
  // client's first connect by a random 0–60s. Skip on fresh install — that's
  // one human waiting on a blank panel, not a thundering herd.
  pendingStartupJitterMs = details.reason === 'install' ? 0 : Math.random() * 60000
  browser.storage.session?.set({ startup_jitter_at: Date.now() + pendingStartupJitterMs }).catch(() => {})
  // Clear any stale intervals from previous version
  activeIntervals.forEach((id) => clearInterval(id))
  activeIntervals.clear()
  // Only nuke channel emotes on first install — on 'update' or 'chrome_update'
  // wiping the cache means every tracked multichat channel renders raw text
  // until the user clicks each tab (channel emotes are "half the emote pool").
  // CHANNEL_EMOTES_TTL + per-fetch failure backdating already cover staleness.
  if (details.reason === 'install') {
    channelEmotesMap = {}
    channelEmotesFetchedAt = {}
    browser.storage.local.remove('channel_emotes_map').catch(() => {})
    browser.storage.local.remove('channel_emotes_fetched_at').catch(() => {})
    // Tells multichat's first init to hide feed/whispers/mentions/modlog —
    // empty/login-walled for a signed-out first-run user — until first login.
    // Only stamped here (reason:'install'), never on update, so existing
    // users who never touched the Tabs setting are never affected.
    browser.storage.local.set({ hs_fresh_install_hidden_tabs: true }).catch(() => {})
  }
  // Don't re-inject content scripts on update. Soft-reinjection of 1.5MB of
  // bundled JS on top of a live React-mounted Twitch DOM was blanking the
  // renderer (and worse — crashing Chrome when fanned out to N tabs). Content
  // scripts detect ctx-death and defer location.reload() to visibilitychange:
  // active tab reloads in 1–5s, background tabs reload only when focused.
  // Trade-off: lose scroll position vs. reliable recovery. Scroll loses.
  if (details.reason === 'install') {
    browser.tabs.create({
      url: browser.runtime.getURL('welcome.html'),
    })
  }
})

// Browser cold-start herd: people open Chrome around the same time of day.
// Only set jitter if not already set by onInstalled in this session.
browser.runtime.onStartup?.addListener(() => {
  if (pendingStartupJitterMs > 0) return
  pendingStartupJitterMs = Math.random() * 30000
  browser.storage.session?.set({ startup_jitter_at: Date.now() + pendingStartupJitterMs }).catch(() => {})
})

// One-time migration: ensure clean state
browser.storage.local
  .get('migrated_to_prod_v2')
  .then(async (data) => {
    if (!data.migrated_to_prod_v2) {
      await browser.storage.local.set({ migrated_to_prod_v2: true })
      log(' Migration v2 complete')
    }
  })
  .catch((err) => log(' Migration check failed:', err?.message))

// v1.5.4 one-time wipe of channel_emotes_map cache. v1.5.3 stopped wiping
// the cache on every ext reload (good for warm state across upgrades) but
// left long-corrupt entries from prior versions intact (a Chatterino badge
// row leaked into channelEmotesMap[xqc] over a year ago; never got pruned
// because no clean re-fetch ever ran). Run once on v1.5.4 boot: clear,
// then let fetchChannelOwnerEmotes repopulate per channel as visited.
browser.storage.local
  .get('migrated_emote_cache_v154')
  .then(async (data) => {
    if (!data.migrated_emote_cache_v154) {
      channelEmotesMap = {}
      channelEmotesFetchedAt = {}
      await browser.storage.local.remove(['channel_emotes_map', 'channel_emotes_fetched_at'])
      await browser.storage.local.set({ migrated_emote_cache_v154: true })
      log(' v1.5.4 channel_emotes_map migration: cleared stale cache')
    }
  })
  .catch((err) => log(' v1.5.4 migration check failed:', err?.message))

// Migrate old single channel_emotes to per-channel map
browser.storage.local
  .get(['channel_emotes', 'channel_emotes_owner'])
  .then(async (data) => {
    if (data.channel_emotes && data.channel_emotes_owner) {
      const map = { [data.channel_emotes_owner]: data.channel_emotes }
      await browser.storage.local.set({ channel_emotes_map: map })
      await browser.storage.local.remove(['channel_emotes', 'channel_emotes_owner'])
      log(' Migrated channel_emotes to per-channel map')
    }
  })
  .catch((err) => log(' Channel emotes migration failed:', err?.message))

let emoteInventory = []
let globalEmotes = [] // BTTV, FFZ, 7TV global emotes

// Hydrate content-filter flags from storage on SW wake-up so emote fetches
// that fire before fetchViewerSettings() resolves still use the right flags.
// onChanged listener below keeps in-memory state in sync when the settings
// UI or other tabs flip a toggle.
browser.storage.local
  .get(['viewer_show_sexual', 'viewer_show_gore', 'viewer_show_weapon', 'viewer_show_drug', 'viewer_show_hate'])
  .then((d) => {
    if (typeof d?.viewer_show_sexual === 'boolean') viewerShowSexual = d.viewer_show_sexual
    if (typeof d?.viewer_show_gore === 'boolean') viewerShowGore = d.viewer_show_gore
    if (typeof d?.viewer_show_weapon === 'boolean') viewerShowWeapon = d.viewer_show_weapon
    if (typeof d?.viewer_show_drug === 'boolean') viewerShowDrug = d.viewer_show_drug
    if (typeof d?.viewer_show_hate === 'boolean') viewerShowHate = d.viewer_show_hate
  })
  .catch(() => {})
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  const cs = changes.viewer_show_sexual
  if (cs && typeof cs.newValue === 'boolean' && cs.newValue !== viewerShowSexual) {
    viewerShowSexual = cs.newValue
    log(' viewer_show_sexual changed →', viewerShowSexual)
  }
  const cg = changes.viewer_show_gore
  if (cg && typeof cg.newValue === 'boolean' && cg.newValue !== viewerShowGore) {
    viewerShowGore = cg.newValue
    log(' viewer_show_gore changed →', viewerShowGore)
  }
  const cw = changes.viewer_show_weapon
  if (cw && typeof cw.newValue === 'boolean' && cw.newValue !== viewerShowWeapon) {
    viewerShowWeapon = cw.newValue
    log(' viewer_show_weapon changed →', viewerShowWeapon)
  }
  const cd = changes.viewer_show_drug
  if (cd && typeof cd.newValue === 'boolean' && cd.newValue !== viewerShowDrug) {
    viewerShowDrug = cd.newValue
    log(' viewer_show_drug changed →', viewerShowDrug)
  }
  const ch = changes.viewer_show_hate
  if (ch && typeof ch.newValue === 'boolean' && ch.newValue !== viewerShowHate) {
    viewerShowHate = ch.newValue
    log(' viewer_show_hate changed →', viewerShowHate)
  }
})

let channelEmotesMap = {} // Per-channel emotes: { "platform/channel": emotes[] }
let channelEmotesFetchedAt = {} // "platform/channel" → timestamp of last successful fetch

// Composite key helpers — keep all channelEmotesMap access platform-scoped
function chKey(platform, ch) {
  return `${platform || 'twitch'}/${String(ch || '').toLowerCase()}`
}
function splitChKey(key) {
  const i = String(key).indexOf('/')
  return i < 0 ? { platform: 'twitch', channel: String(key) } : { platform: key.slice(0, i), channel: key.slice(i + 1) }
}

function getStorableChannelEmotes() {
  const map = {}
  for (const [ch, data] of Object.entries(channelEmotesMap)) {
    if (data !== 'loading') map[ch] = data
  }
  return map
}
const CHANNEL_EMOTES_TTL = 30 * 60 * 1000 // 30 minutes
const CHANNEL_EMOTES_EMPTY_TTL = 5 * 60 * 1000 // 5 minutes for zero-result channels
const tabChannels = new Map() // tabId → { channel, channelOwner }
// Channels joined via ws_send from content scripts (e.g. multichat extras).
// tabChannels only tracks the primary tab channel — multichat adds many more.
// On WS reconnect (incl. server restart) these must be re-joined or messages drop silently.
const joinedExtraChannels = new Set() // "platform/channel" keys

// Reserved site paths that must never become channels — the third copy of the
// overlay blocklist (main.js NON_CHANNEL_PATHS, content.js TWITCH_EXCLUDED_PATHS).
// BG needs its own because ghost keys persisted in joined_extra_channels replay
// straight into WS joins + the kick Pusher tap on every SW boot, bypassing the
// overlay-side purges ('login' is a REAL kick channel — the tap happily
// subscribed chatroom 31705 to it). Keep the three lists in sync.
const BG_NON_CHANNEL_PATHS = new Set([
  'directory',
  'settings',
  'login',
  'logout',
  'signup',
  'oauth',
  'oauth2',
  'activate',
  'checkout',
  'videos',
  'moderator',
  'subscriptions',
  'search',
  'help',
  'about',
  'jobs',
  'contact',
  'wallet',
  'inventory',
  'friends',
  'admin',
  'broadcast',
  'drops',
  'store',
  'popout',
  'embed',
  'partners',
  'turbo',
  'prime',
  'p',
  'subs',
  'turbo-faq',
  'bits',
  'browse',
  'category',
  'categories',
  'community',
  'clips',
  'leaderboards',
  'dashboard',
  'vods',
  'u',
  'auth',
  'authorize',
])
function isGhostChannelKey(key) {
  const ch = String(key || '')
    .split('/')
    .pop()
  return !ch || BG_NON_CHANNEL_PATHS.has(ch)
}

// Get the most recently set channel owner from any tab
function _getActiveChannelOwner() {
  let latest = null
  for (const entry of tabChannels.values()) {
    if (entry.channelOwner) latest = entry.channelOwner
  }
  return latest
}

// Get the channel string for a specific tab
function getTabChannel(tabId) {
  return tabChannels.get(tabId)?.channel || null
}

// Persist tabChannels to session storage (survives worker restarts, not browser restarts)
function saveTabChannels() {
  const data = Object.fromEntries(tabChannels)
  browser.storage.session?.set({ tab_channels: data }).catch(() => {})
}

function saveJoinedExtraChannels() {
  // Local (not session) — extension reload clears session storage, which
  // would orphan kick channel subscriptions on every "reload extension"
  // click and never resubscribe until the user manually edits a channel.
  // Local survives reloads, only cleared by explicit unjoin or storage wipe.
  browser.storage.local.set({ joined_extra_channels: [...joinedExtraChannels] }).catch(() => {})
}

// Clean up tab tracking on close
browser.tabs.onRemoved.addListener((tabId) => {
  tabChannels.delete(tabId)
  saveTabChannels()
  _cachedTabs = null // Invalidate tab cache
})

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  _cachedTabs = null // Invalidate tab cache on navigation/load
  if (tabChannels.has(tabId) && changeInfo.url && !/twitch\.tv|kick\.com|youtube\.com/.test(changeInfo.url)) {
    tabChannels.delete(tabId)
    saveTabChannels()
  }
  // URL change = real navigation (not SPA). Clear drain dedup so the next
  // status:complete on this tabId can fire a fresh drain.
  if (changeInfo.url) _drainAttempted.delete(tabId)
  // Cross-follow queue drain trigger. When a twitch.tv / kick.com tab
  // finishes loading, ask its content script to drain any pending follows
  // that were queued while the user was elsewhere (or while the platform
  // session was logged out). Deduped per (tabId × platform) in
  // _maybeTriggerCrossFollowDrain so a SPA URL change doesn't repeat-drain.
  if (changeInfo.status === 'complete') {
    _maybeTriggerCrossFollowDrain(tabId).catch(() => {})
  }
})

// One-shot per-tab drain — sends the cross_follow_drain message to whichever
// platform matches the tab's URL. Idempotent: if the queue is empty, the
// content script noops. We also dedupe by tabId+platform so a SPA reload
// doesn't repeat-drain.
const _drainAttempted = new Map() // tabId → Set<platform>
async function _maybeTriggerCrossFollowDrain(tabId) {
  let tab
  try {
    tab = await browser.tabs.get(tabId)
  } catch {
    return
  }
  if (!tab?.url) return
  let platform = null
  if (/twitch\.tv/.test(tab.url)) platform = 'twitch'
  else if (/kick\.com/.test(tab.url)) platform = 'kick'
  if (!platform) return
  if (!_drainAttempted.has(tabId)) _drainAttempted.set(tabId, new Set())
  const set = _drainAttempted.get(tabId)
  if (set.has(platform)) return
  set.add(platform)
  // Small delay so the content script has time to register its onMessage
  // listener after page load completes.
  setTimeout(() => {
    browser.tabs.sendMessage(tabId, { type: 'cross_follow_drain', platform }).catch(() => {})
  }, 2500)
}
browser.tabs.onRemoved.addListener((tabId) => {
  _drainAttempted.delete(tabId)
})
const seventvEmoteSetIds = new Map() // channelName → 7TV emote set ID
let blockedEmotes = new Set()
let localBlockedEmotes = new Set() // Local blocks for anonymous users
let mutedUsers = new Map() // username -> expiresAt (null = permanent)
let blockedUsers = new Set()

// Third-party cosmetics (BTTV/FFZ badges, 7TV paints+badges)
let bttvBadgeMap = new Map() // twitchUserId → { description, url }
let ffzBadgeMap = new Map() // twitchUserId → [{ title, color, url }]
let chatterinoBadgeMap = new Map() // twitchUserId → { tooltip, url }
const userCosmeticsCache = new Map() // twitchUserId → { paint, badge, fetchedAt }
let badgesFetchedAt = 0 // persisted to storage in fetchBulkBadges, restored in initialize()
const BADGES_TTL = 24 * 60 * 60 * 1000
const USER_COSMETICS_TTL = 30 * 60 * 1000
// Shorter TTL for negative results (no paint+badge) so newly-added cosmetics
// pick up within 5 min instead of being masked for 30.
const COSMETICS_NEGATIVE_TTL = 5 * 60 * 1000
const USER_COSMETICS_MAX = 500
// SW-side LRU for /api/embed/resolve responses. Re-rendered feed posts (tab
// switch, scrollback) reuse cached embed metadata instead of re-fetching
// the heatsync server every time.
const _embedResolveCache = new Map()
const EMBED_RESOLVE_TTL = 60 * 60 * 1000 // 1 hour
// HeatSync name paints (GET /api/paints?ids=..., public, ≤50/batch) — short
// in-memory cache. 60s matches the server's own redis TTL (server/routes/paint.ts);
// no point holding it any longer client-side since the server refreshes at the
// same cadence. In-memory only (unlike userCosmeticsCache) — paints are cheap,
// low-stakes to refetch, and don't need to survive an SW restart.
const _paintsCache = new Map() // twitchUserId → { spec: object|null, color: string|null, plus: string|null, fetchedAt }
const PAINTS_TTL = 60 * 1000
const PAINTS_CACHE_MAX = 500
// Channel banner / accent across platforms — Twitch GQL (public client id),
// Kick public API, YouTube HTML scrape via ytInitialData. All sources return
// the same shape: { bannerUrl, offlineUrl, accent, profileUrl }. Cache keyed
// by `${platform}:${lowercased-login}` so cross-platform same-name users don't
// collide. 12h TTL — banners rarely change and a stale URL still resolves.
const _channelBannerCache = new Map()
const CHANNEL_BANNER_TTL = 12 * 60 * 60 * 1000
const CHANNEL_BANNER_MAX = 800
// pronoundb.org self-declared pronouns — public GET, Twitch-only (their v2
// API has no Kick/YouTube platform as of 2026-07). Keyed by twitch numeric
// user id. 24h TTL — pronouns almost never change, so a stale value for a
// day is harmless (unlike a stale banner/avatar).
const _pronounCache = new Map()
const PRONOUN_TTL = 24 * 60 * 60 * 1000
const PRONOUN_CACHE_MAX = 500
let followedUsers = [] // Users the current user follows
let currentUsername = null // Logged-in user's username
// v1.6 content filters. sexual + gore default OFF (hidden); weapons/drugs/hate
// default ON. Flipped via the multichat panel ⚙ → Content toggles, which
// PATCH /api/user/settings and write to storage. Every emote-fetch BG call
// appends include_sexual/gore/weapons/drugs/hate params via withNsfwParam().
let viewerShowSexual = false
let viewerShowGore = false
// Per-category content filters. Default ON (show); server hides only when =false.
let viewerShowWeapon = true
let viewerShowDrug = true
let viewerShowHate = true
let socket = null
let lastBroadcastWasEmpty = false // Track to prevent spamming 0-emote broadcasts
// Tracks the last user-initiated block/unblock per hash so late-arriving WS
// echoes can't reverse a recent toggle. Server broadcasts our own actions back
// to us; if HTTP completes faster than the WS echo, the WS handler sees stale
// state and "re-blocks" what we just unblocked (or vice versa). 5s window is
// enough for any realistic broadcast delay.
const recentBlockToggle = new Map() // hash -> { state: 'blocked'|'unblocked', at: ms }
const BLOCK_TOGGLE_GRACE_MS = 5000
function markBlockToggle(hash, state) {
  if (!hash) return
  recentBlockToggle.set(hash, { state, at: Date.now() })
  if (recentBlockToggle.size > 200) {
    const cutoff = Date.now() - BLOCK_TOGGLE_GRACE_MS
    for (const [h, e] of recentBlockToggle) if (e.at < cutoff) recentBlockToggle.delete(h)
  }
}
function recentBlockToggleState(hash) {
  const e = recentBlockToggle.get(hash)
  if (!e) return null
  if (Date.now() - e.at > BLOCK_TOGGLE_GRACE_MS) {
    recentBlockToggle.delete(hash)
    return null
  }
  return e.state
}
let lastInventoryFetch = 0 // Timestamp of last successful inventory fetch
let inventoryRefreshTimer = null // Debounce WS-triggered inventory refreshes
let inventoryFetchPromise = null // In-flight guard for fetchEmoteInventory
let inventoryFetchOK = false // Last fetch succeeded — gate persist writes so transient failures don't store []
// Consecutive auth failures (null cookie / 401 / 403) on inventory fetch.
// The session JWT routinely crosses expiry between site visits; the site
// rolls the cookie on the next request and cookies.onChanged refetches. A
// single stale-token fetch in that gap must NOT strip every rendered emote
// on every open tab — only wipe after 2 consecutive auth failures. (This
// fix shipped 2026-06-04 and was silently dropped in a later rewrite.)
let authConsecutiveFails = 0
let globalEmotesFetchPromise = null // In-flight guard for fetchGlobalEmotes

function scheduleInventoryRefresh() {
  if (inventoryRefreshTimer) clearTimeout(inventoryRefreshTimer)
  inventoryRefreshTimer = setTimeout(() => {
    inventoryRefreshTimer = null
    fetchEmoteInventory()
  }, 2000)
}
let unreadNotifCount = 0 // Unread notification count for extension badge
// Survive SW eviction: the counter only lived in memory, so any eviction
// zeroed the badge silently. session scope (not local) — the server is the
// source of truth across browser restarts via hydrateUnreadNotifCount.
browser.storage.session
  ?.get('unread_notif_count')
  .then((r) => {
    const n = r?.unread_notif_count
    if (typeof n === 'number' && n > unreadNotifCount) {
      unreadNotifCount = n
      updateExtensionBadge()
    }
  })
  .catch(() => {})
let cachedFollowHistory = null // Cache follow:history for late-loading content scripts
const wsStreamEventDedup = new Map() // Dedup stream events across stream:* and follow:stream:*
let cachedFollowColors = null // Cache follow:colors for late-loading content scripts
let activeYoutubeVideoId = null // Currently subscribed YouTube videoId (for WS reconnect)
// videoId → Set<channelId> (per-channel YouTube routing). Multi-valued: the
// same stream can be bound to the live tab (__live_yt_auto__/global) AND a
// config channel at once — chat must fan out to every binding, or the losing
// tab goes silent and its watchdog force-reconnects the shared WS.
const ytVideoToChannel = new Map()
const youtubeChannelUrls = {} // channelId → url (in-memory source of truth, persisted to storage)
// Pending subscriptions whose URL doesn't carry a videoId (e.g. https://youtube.com/@user/live).
// We can't pre-populate ytVideoToChannel for these, so we track them here. When the WS server
// echoes back a youtube:status connected event without a channelId field, we attribute the
// videoId to the most-recent pending entry — without this fallback the status broadcasts as
// channelId='global' and every chat message that follows gets dropped by the receiving tab.
const pendingYtSubscribes = [] // [{ channelId, url, ts }] LIFO, capped, ts for staleness
const ytChannelHandleCache = new Map() // videoId → channel handle (oEmbed lookup, session-scoped)
function cacheYtHandle(videoId, handle) {
  ytChannelHandleCache.set(videoId, handle)
  // LRU cap — long sessions watching many YT channels would otherwise grow unbounded.
  if (ytChannelHandleCache.size > 100) {
    ytChannelHandleCache.delete(ytChannelHandleCache.keys().next().value)
  }
}
async function getYtChannelHandle(videoId) {
  if (!videoId) return null
  if (ytChannelHandleCache.has(videoId)) return ytChannelHandleCache.get(videoId)
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
    const r = await fetch(oembedUrl, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) {
      // Cache a definitive miss for private/deleted/blocked videos (won't resolve
      // this session) so repeat callers stop re-hitting oEmbed. Leave transient
      // statuses (429 rate-limit, 5xx) uncached so they can recover on retry.
      if (r.status === 404 || r.status === 401 || r.status === 403) cacheYtHandle(videoId, null)
      return null
    }
    const data = await r.json()
    let handle = null
    if (data.author_url) {
      const m = data.author_url.match(/\/@([^/?]+)/)
      if (m) handle = m[1]
    }
    if (!handle && data.author_name) handle = data.author_name.replace(/\s+/g, '')
    // Cache either outcome: a successful oEmbed that simply carries no author is
    // a stable null, so caching it spares the repeat fetch too.
    cacheYtHandle(videoId, handle)
    return handle
  } catch (_e) {
    return null
  }
}
const MAX_YT_VIDEO_ENTRIES = 100 // LRU cap — evict oldest when full
let _ytVideoMapPersistTimer = null
function persistYtVideoMap() {
  // Debounce burst writes (re-subscribe loops fire many sets in <50ms)
  if (_ytVideoMapPersistTimer) return
  _ytVideoMapPersistTimer = setTimeout(() => {
    _ytVideoMapPersistTimer = null
    browser.storage.local
      .set({ yt_video_to_channel: Object.fromEntries([...ytVideoToChannel].map(([v, s]) => [v, [...s]])) })
      .catch(() => {})
  }, 500)
}
// Broadcast target used when a videoId has no channel binding yet. It is NOT a
// channel — it must never sit in the Set alongside a real binding, or every
// message for that video fans out once per entry (duplicate chat).
const YT_FALLBACK_CHANNEL = 'global'
function ytChannelsFor(videoId) {
  const s = ytVideoToChannel.get(videoId)
  return s ? [...s] : []
}
// Fallback/real bindings are mutually exclusive: a real channelId evicts the
// fallback, and the fallback is never added once a real binding exists.
function setYtVideoChannel(videoId, channelId) {
  const set = ytVideoToChannel.get(videoId) || new Set()
  if (channelId === YT_FALLBACK_CHANNEL) {
    for (const c of set) if (c !== YT_FALLBACK_CHANNEL) return
  } else {
    set.delete(YT_FALLBACK_CHANNEL)
  }
  ytVideoToChannel.delete(videoId) // Re-insert for LRU ordering
  set.add(channelId)
  ytVideoToChannel.set(videoId, set)
  if (ytVideoToChannel.size > MAX_YT_VIDEO_ENTRIES) {
    const oldest = ytVideoToChannel.keys().next().value
    ytVideoToChannel.delete(oldest)
  }
  persistYtVideoMap()
}
// channelId given → unbind just that channel; omitted → drop every binding
function deleteYtVideoChannel(videoId, channelId) {
  const set = ytVideoToChannel.get(videoId)
  if (!set) return
  if (channelId !== undefined) {
    if (!set.delete(channelId)) return
    if (set.size === 0) ytVideoToChannel.delete(videoId)
  } else {
    ytVideoToChannel.delete(videoId)
  }
  persistYtVideoMap()
}

let authToken = null // Will be set by content script or loaded from storage
let initPromise = null // Track init completion for message handlers
let authFailedBlock = false // Prevent reconnect loop after authentication_failed

// Auto-detect login/logout via httpOnly cookie changes
browser.cookies.onChanged.addListener((changeInfo) => {
  try {
    const c = changeInfo.cookie
    if (c.name !== 'auth' || !c.domain.includes('heatsync.org')) return

    // changeInfo.removed fires both for actual deletion AND for overwrite
    // (when the server sets a new auth cookie that replaces the old one).
    // Only treat as logout for true deletion — overwrite is followed by a
    // 'set' event that re-establishes auth.
    if (changeInfo.removed && changeInfo.cause !== 'overwrite') {
      log(' Auth cookie removed — logging out')
      unsubscribeFromPush(authToken).catch((err) => log(' unsubscribeFromPush failed:', err?.message))
      authToken = null
      emoteInventory = []
      blockedEmotes = new Set()
      followedUsers = []
      viewerShowSexual = false
      viewerShowGore = false
      viewerShowWeapon = true
      viewerShowDrug = true
      viewerShowHate = true
      browser.storage.local
        .remove([
          'emote_inventory',
          'blocked_emotes',
          'auth_token_encrypted',
          'auth_token',
          'user_info',
          'viewer_show_sexual',
          'viewer_show_gore',
          'viewer_show_weapon',
          'viewer_show_drug',
          'viewer_show_hate',
        ])
        .catch((err) => log(' storage remove failed:', err?.message))
      broadcastToTabs({ type: 'auth_changed', loggedIn: false })
    } else {
      log(' Auth cookie set — logging in')
      authToken = c.value
      authFailedBlock = false
      storeToken(c.value).catch((err) => log(' storeToken failed:', err?.message))
      fetchEmoteInventory().catch((err) => log(' fetchEmoteInventory failed:', err?.message))
      fetchBlockedEmotes().catch((err) => log(' fetchBlockedEmotes failed:', err?.message))
      fetchFollowedUsers().catch((err) => log(' fetchFollowedUsers failed:', err?.message))
      fetchUserInfo().catch((err) => log(' fetchUserInfo failed:', err?.message))
      fetchViewerSettings().catch((err) => log(' fetchViewerSettings failed:', err?.message))
      connectWebSocket().catch((err) => log(' connectWebSocket failed:', err?.message))
      subscribeToPush(c.value).catch((err) => log(' subscribeToPush failed:', err?.message))
      broadcastToTabs({ type: 'auth_changed', loggedIn: true })
    }
  } catch (err) {
    log(' cookies.onChanged error:', err?.message)
  }
})
const API_URL = 'https://heatsync.org' // Production
const WS_URL = 'wss://heatsync.org' // Production WebSocket

// Network online/offline — react instantly to transitions instead of waiting
// for backoff timers. Service workers have `self` (global), and these events
// fire while the SW is alive. If the SW is asleep when the network changes,
// it'll re-evaluate on next wake anyway.
try {
  self.addEventListener('online', () => {
    log(' 🌐 Network online — kicking fresh WS connect')
    reconnectAttempts = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (!hsWsIdleClosed && !isSocketOpen())
      connectWebSocket().catch((err) => log(' onlineConnect failed:', err?.message))
  })
  self.addEventListener('offline', () => {
    log(' 🚫 Network offline — pausing reconnect attempts')
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  })
} catch {}

// Normalize relative emote URLs to absolute (API returns /uploads/... paths)
// Hosts whose images we link to and never copy — emote CDNs serving creator
// artwork we have no licence to host. Keep in sync with the direct-render list
// in src/multichat/feed-embed.js (HS_IMG_DIRECT_HOSTS), which is why a bare link
// to one of these still renders.
const HOTLINK_ONLY_HOSTS = new Set([
  'cdn.7tv.app',
  'cdn.betterttv.net',
  'cdn.frankerfacez.com',
  'static-cdn.jtvnw.net',
  'files.kick.com',
])

function absUrl(url) {
  if (!url) return url
  return url.startsWith('/') ? API_URL + url : url
}

// senderKeys off a WS emote push — server-originated but bound anyway: plain
// platform:id strings, capped, or null when absent/invalid (null = legacy path).
function sanitizeSenderKeys(v) {
  if (!Array.isArray(v) || !v.length) return null
  const out = v.filter((k) => typeof k === 'string' && k.length > 0 && k.length < 200 && k.includes(':')).slice(0, 30)
  return out.length ? out : null
}

// emote-ver cache-bust token: short opaque string, never interpolated as code.
function sanitizeVer(v) {
  return v == null
    ? undefined
    : String(v)
        .replace(/[^0-9a-zA-Z_-]/g, '')
        .slice(0, 32) || undefined
}

// Track intervals for cleanup (memory leak prevention)
const activeIntervals = new Set()
function trackInterval(id) {
  activeIntervals.add(id)
  return id
}
function untrackInterval(id) {
  clearInterval(id)
  activeIntervals.delete(id)
}

// Fetch with 10s timeout to prevent hung requests
// Global heatsync.org backoff state — when the server sends 429 with Retry-After,
// every subsequent heatsync fetch short-circuits until the window passes. Keeps
// 10k extensions from hammering a stressed server one endpoint at a time.
let heatsyncBackoffUntil = 0
// In-flight heatsync AbortControllers — on the FIRST 429 we cancel every other
// pending heatsync fetch so a single rate-limit hit doesn't cascade into N-1
// redundant 429s (concurrent channel-emote / cosmetics bursts were spamming
// hundreds of "backing off" warns; the server already told us to slow down).
const heatsyncInflightAborts = new Set()
let _heatsyncBackoffWarnAt = 0
// (Removed: heatsync concurrency cap. The 4-slot semaphore could starve
// critical calls behind queued retries during sustained backoff windows.
// Cascade-abort + warn dedupe below are enough; if bursts return, revisit.)
function fakeBackoffResponse() {
  // Match the Response interface enough that callers checking .status / .ok / .json() / .body work.
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests (client-side backoff)',
    headers: new Headers(),
    body: null,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }
}
// 7TV's Cloudflare 403s (or, behind a misrouted VPN/tunnel, times out) requests
// from datacenter/VPN exit IPs, so 7tv.io is unreachable for some users. When a
// direct GET to 7tv.io fails, retry through heatsync's server (clean IP) which
// returns 7TV's native JSON unchanged. Once a failure is seen, skip the doomed
// direct hit entirely so channel-emote loads never hang behind it.
let sevenTVApiBlocked = false
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const is7tvGet =
    typeof url === 'string' && url.startsWith('https://7tv.io/') && (opts.method || 'GET').toUpperCase() === 'GET'
  if (is7tvGet && !opts.__no7tvFallback) {
    const proxyUrl = url.replace('https://7tv.io/', 'https://heatsync.org/api/7tv/')
    // noBackoff: the proxy is heatsync.org, so without this the shared heatsync
    // backoff (tripped by an unrelated 429 from colors/inventory/cosmetics) would
    // fake-429 these 7TV proxy calls and silently kill channel emotes for ~60s —
    // fatal for IP-blocked users, whose ONLY 7TV path is the proxy. It's a cached,
    // read-only GET, so exempting it from the write-protection backoff is safe.
    const proxyOpts = { ...opts, noBackoff: true }
    if (sevenTVApiBlocked) return fetchWithTimeout(proxyUrl, proxyOpts, ms)
    try {
      const r = await fetchWithTimeout(url, { ...opts, __no7tvFallback: true }, ms)
      // 403 = this IP is blocked by 7TV's WAF; it's instant + permanent for the
      // session, so flip to the proxy for every subsequent 7TV call.
      if (r.status === 403) {
        sevenTVApiBlocked = true
        return fetchWithTimeout(proxyUrl, proxyOpts, ms)
      }
      // 5xx/429 = 7TV outage or rate-limit (not an IP block) — the proxy may
      // hold a cached set, so render keeps working through 7TV downtime.
      if (r.status >= 500 || r.status === 429) return fetchWithTimeout(proxyUrl, proxyOpts, ms)
      return r
    } catch (_) {
      // Timeout/network error — could be a slow large channel, not a block.
      // Try the proxy for THIS call only; don't permanently flip.
      return fetchWithTimeout(proxyUrl, proxyOpts, ms)
    }
  }
  const isHeatsync = typeof url === 'string' && /^https?:\/\/(www\.)?heatsync\.org/.test(url)
  // noBackoff: opt a non-critical, high-volume call (sender-emote batch) OUT of the
  // shared heatsync backoff. Otherwise a 429 from ANY heatsync call (colors, inventory,
  // cosmetics — common in busy channels) fake-429s it for up to 60s and it never loads;
  // and a batch 429 shouldn't in turn block those critical calls.
  const backoffManaged = isHeatsync && !opts.noBackoff
  if (backoffManaged && Date.now() < heatsyncBackoffUntil) {
    return fakeBackoffResponse()
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ctrl.abort())
  }
  if (backoffManaged) heatsyncInflightAborts.add(ctrl)
  // Default credentials: 'omit' for third-party APIs (no cookie leakage to 7TV/FFZ/BTTV/etc).
  // heatsync.org calls override with credentials: 'include' explicitly.
  const credentials = opts.credentials ?? (isHeatsync ? 'include' : 'omit')
  let resp
  try {
    resp = await fetch(url, { ...opts, credentials, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
    if (backoffManaged) heatsyncInflightAborts.delete(ctrl)
  }
  if (backoffManaged && resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after')
    let waitMs = 5000
    if (retryAfter) {
      const n = parseInt(retryAfter, 10)
      if (!Number.isNaN(n) && n > 0) waitMs = Math.min(60000, n * 1000)
    }
    const firstHit = Date.now() >= heatsyncBackoffUntil
    heatsyncBackoffUntil = Date.now() + waitMs
    if (firstHit) {
      // Cancel every other in-flight heatsync request — they were issued before
      // we knew about the rate-limit and would each get 429'd individually.
      for (const a of heatsyncInflightAborts) {
        if (a !== ctrl) {
          try {
            a.abort()
          } catch {}
        }
      }
    }
    // Dedupe the warn — one per backoff window. Include URL so future storms
    // can be traced back to the noisy endpoint.
    if (Date.now() - _heatsyncBackoffWarnAt > 1000) {
      _heatsyncBackoffWarnAt = Date.now()
      console.warn('[heatsync] 429 — backing off all heatsync fetches for', waitMs, 'ms (first url:', url, ')')
    }
  }
  return resp
}

// Per-URL ETag cache for politeness toward third-party CDN APIs (7TV/BTTV/FFZ).
// We store last seen ETag in chrome.storage.local under hs_etag:{url}; on the
// next fetch we send If-None-Match. A 304 response body is empty so the caller
// must short-circuit on { notModified: true } and reuse its parsed payload.
const ETAG_KEY_PREFIX = 'hs_etag:'
async function fetchWithEtag(url, opts = {}, ms = 10000) {
  let storedEtag = null
  try {
    const k = ETAG_KEY_PREFIX + url
    const got = await browser.storage.local.get(k)
    storedEtag = got[k] || null
  } catch {}
  const headers = { ...(opts.headers || {}) }
  if (storedEtag) headers['If-None-Match'] = storedEtag
  const resp = await fetchWithTimeout(url, { ...opts, headers }, ms)
  if (resp.status === 304) {
    // body is already empty on 304 — nothing to cancel
    return { ok: true, status: 304, notModified: true, json: () => null }
  }
  if (resp.ok) {
    const newEtag = resp.headers.get('etag')
    if (newEtag && newEtag !== storedEtag) {
      try {
        await browser.storage.local.set({ [ETAG_KEY_PREFIX + url]: newEtag })
      } catch {}
    }
  }
  return resp
}

// ============================================
// TOKEN ENCRYPTION (SubtleCrypto)
// ============================================
// Encrypts auth tokens at rest using a random per-user salt
// Salt is generated on first use and persisted in local storage

async function getOrCreateEncryptionSalt() {
  const stored = await browser.storage.local.get('encryption_salt')
  if (stored.encryption_salt) {
    // hex → Uint8Array
    const hex = stored.encryption_salt
    const arr = new Uint8Array(hex.length / 2)
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return arr
  }
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const hex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  await browser.storage.local.set({ encryption_salt: hex })
  return salt
}

async function getEncryptionKey(salt) {
  const extensionId = browser.runtime.id || 'heatsync-default'
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${extensionId}-heatsync-token-key`),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptToken(token) {
  if (!token) return null
  try {
    const salt = await getOrCreateEncryptionSalt()
    const key = await getEncryptionKey(salt)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encoder = new TextEncoder()
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token))
    // Store as base64: iv + encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)
    return btoa(String.fromCharCode(...combined))
  } catch (err) {
    log(' Encryption failed:', err.message)
    return null
  }
}

async function decryptToken(encryptedBase64) {
  if (!encryptedBase64) return null
  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const encrypted = combined.slice(12)

  // Try with random per-user salt first
  try {
    const salt = await getOrCreateEncryptionSalt()
    const key = await getEncryptionKey(salt)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)
    return new TextDecoder().decode(decrypted)
  } catch {
    // Migration: token may have been encrypted with old hardcoded salt — try it
    try {
      const encoder = new TextEncoder()
      const oldKey = await getEncryptionKey(encoder.encode('heatsync-salt'))
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, oldKey, encrypted)
      const token = new TextDecoder().decode(decrypted)
      log(' Migrating token from static salt to random salt')
      // Re-encrypt with new random salt (getOrCreateEncryptionSalt already wrote it above)
      const newEncrypted = await encryptToken(token)
      if (newEncrypted) await browser.storage.local.set({ auth_token_encrypted: newEncrypted })
      return token
    } catch (err) {
      log(' Decryption failed:', err.message)
      return null
    }
  }
}

// Secure token storage helpers
async function storeToken(token) {
  const encrypted = await encryptToken(token)
  if (encrypted) {
    await browser.storage.local.set({ auth_token_encrypted: encrypted })
    // Remove old unencrypted token if exists
    await browser.storage.local.remove('auth_token')
  }
}

async function retrieveToken() {
  const data = await browser.storage.local.get(['auth_token_encrypted', 'auth_token'])
  // Try encrypted first
  if (data.auth_token_encrypted) {
    const token = await decryptToken(data.auth_token_encrypted)
    if (token) return token
  }
  // Fallback to unencrypted (migration) and re-encrypt
  if (data.auth_token) {
    log(' Migrating unencrypted token to encrypted storage')
    await storeToken(data.auth_token)
    return data.auth_token
  }
  return null
}

// HeatSync emotes are smuggled into native chat as fake FFZ-style CDN URLs
// (__FFZ__999999::HASH__FFZ__) and rewritten to real URLs client-side by the
// autocomplete-hook MutationObserver on both Chrome and Firefox. No background
// hash→URL map or webRequest interception needed — the DOM-rewrite path is the
// single cross-browser mechanism.

// Get auth token (read from memory, storage, or httpOnly cookie via cookies API)
async function getAuthCookie() {
  if (authToken) {
    log(' Using auth token from memory')
    return authToken
  }

  // Read fresh cookie FIRST. Encrypted storage was preferred before, but a
  // stale stored token (from a logout/re-login on heatsync.org while the SW
  // was suspended) would silently reauth with the dead value, the server
  // would reply authentication_failed, and authFailedBlock would pin us in
  // a no-reconnect state. The browser's cookie store is the source of truth.
  try {
    const cookie = await browser.cookies.get({ url: 'https://heatsync.org', name: 'auth' })
    if (cookie?.value) {
      log(' ✓ Read auth cookie via cookies API')
      authToken = cookie.value
      await storeToken(cookie.value)
      return cookie.value
    }
  } catch (err) {
    log(' cookies.get failed:', err.message)
  }

  // Fallback: encrypted storage (cookie may be unavailable — third-party
  // contexts, restricted profiles).
  try {
    const stored = await retrieveToken()
    if (stored) {
      log(' Read auth token from encrypted storage')
      authToken = stored
      return stored
    }
  } catch (err) {
    console.error('[HS] retrieveToken error:', err)
  }

  log(' No auth token available')
  return null
}

// Fetch user's emote inventory via HTTP
// Normalize a server added_at (ISO string / epoch ms) to epoch ms, 0 = unknown.
// Unknown fails OPEN at render (the emote draws ungated), so a bad parse can
// never blank emotes — it only loses the inventory-time freeze for that entry.
// Values without a timezone are treated as UTC (server clock); values in the
// future beyond 10min are clock-skew garbage → unknown.
function emoteAddedAtMs(v) {
  if (!v) return 0
  let t
  if (typeof v === 'number') t = v
  else {
    const s = String(v).trim().replace(' ', 'T')
    t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)
  }
  if (!Number.isFinite(t) || t <= 0 || t > Date.now() + 600000) return 0
  return t
}

function fetchEmoteInventory() {
  // Skip if fetched within 10s (WS events already deliver fresh data)
  if (Date.now() - lastInventoryFetch < 10000) {
    log(' Inventory fetch skipped — last fetch was', `${Math.round((Date.now() - lastInventoryFetch) / 1000)}s ago`)
    return Promise.resolve()
  }
  if (inventoryFetchPromise) return inventoryFetchPromise
  inventoryFetchPromise = (async () => {
    try {
      const authToken = await getAuthCookie()
      if (!authToken) {
        authConsecutiveFails++
        inventoryFetchOK = false
        if (authConsecutiveFails < 2) {
          log(' No auth token for inventory fetch — keeping warm cache (fail 1/2)')
          return
        }
        log(' No auth token for inventory fetch (consecutive) — clearing')
        emoteInventory = []
        // Only broadcast empty once to prevent spam (every 60s poll was flooding console)
        if (!lastBroadcastWasEmpty) {
          broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory })
          lastBroadcastWasEmpty = true
        }
        return
      }

      log(' Fetching user inventory from API')
      const response = await fetchWithTimeout(withNsfwParam(`${API_URL}/api/user/emotes`), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })

      if (!response.ok) {
        response.body?.cancel()
        // Only clobber on auth failure (token revoked/expired). Transient errors
        // (5xx, 429 backoff, server warm-up) must preserve the warm cache —
        // otherwise a single cold-start hiccup broadcasts an empty inventory and
        // strips every rendered emote on every open Twitch/Kick tab.
        if (response.status === 401 || response.status === 403) {
          authConsecutiveFails++
          inventoryFetchOK = false
          if (authConsecutiveFails < 2) {
            log(` Inventory fetch ${response.status} — keeping warm cache (auth fail 1/2)`)
            return
          }
          emoteInventory = []
          if (!lastBroadcastWasEmpty) {
            broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory })
            lastBroadcastWasEmpty = true
          }
        } else {
          log(` Inventory fetch ${response.status} — keeping warm cache`)
          inventoryFetchOK = false
        }
        return
      }

      const data = await response.json()
      log(' API response:', data)
      log(' 🔍 API emotes array length:', data.emotes ? data.emotes.length : 'undefined')
      log(' 🔍 First emote from API:', data.emotes ? data.emotes[0] : 'none')

      // Transform the API response to match extension format
      // Backend returns 'custom_name', extension expects 'name'
      const inventoryEmotes = (data.emotes || []).map((emote) => ({
        name: emote.custom_name, // Map custom_name to name
        url: absUrl(emote.url),
        hash: emote.hash,
        width: emote.width,
        height: emote.height,
        slot: emote.slot_number,
        usage_count: emote.usage_count,
        zero_width: !!emote.zero_width, // 7TV overlay flag — drives stacking in chat
        nsfw: !!emote.nsfw, // v1.6 — cyan-dashed border + tooltip suffix
        // Inventory-time stamp (epoch ms) — own messages older than this stay
        // text at render (a collect never retro-imagifies your own history)
        addedAt: emoteAddedAtMs(emote.added_at),
        // Server CW annotation (own inventory is never filtered) — chat hides
        // own flagged emotes at render when the owner's toggles say so.
        cw_cats: Array.isArray(emote.cw_cats) && emote.cw_cats.length ? emote.cw_cats : undefined,
      }))
      log(' 🔍 Transformed inventory length:', inventoryEmotes.length)
      log(' 🔍 First transformed emote:', inventoryEmotes[0])

      // Transform subscription emotes
      const subEmotes = (data.subscriptionEmotes || []).map((emote) => ({
        name: emote.custom_name,
        url: absUrl(emote.url),
        hash: emote.hash,
        width: emote.width || 28,
        height: emote.height || 28,
        tier: emote.tier,
        broadcaster: emote.broadcaster_name,
        subscription: true,
      }))

      // Combine inventory + subscription emotes
      emoteInventory = sanitizeEmoteList([...inventoryEmotes, ...subEmotes])

      log(' Loaded', inventoryEmotes.length, 'inventory emotes')
      log(' Loaded', subEmotes.length, 'subscription emotes')
      if (emoteInventory.length > 0) {
        log(
          ' Sample emotes:',
          emoteInventory.slice(0, 3).map((e) => e.name),
        )
      }
      lastBroadcastWasEmpty = false // Reset - we have real emotes now
      authConsecutiveFails = 0
      lastInventoryFetch = Date.now()
      inventoryFetchOK = true
      broadcastToTabs({ type: 'inventory_update', emotes: emoteInventory })
    } catch (error) {
      // AbortError = SW reinit / ext-reload cancelled an in-flight fetch.
      // Expected, not a real failure — keep the noise out of the error log.
      const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '')
      if (!isAbort) console.error('[heatsync] fetchEmoteInventory failed:', error.message || error)
      // Network/timeout — preserve warm cache. Broadcasting [] here was the
      // source of the cold-start "no emotes" symptom: a single transient
      // failure nuked the in-memory inventory AND every tab's rendered emotes.
      inventoryFetchOK = false
    } finally {
      inventoryFetchPromise = null
    }
  })()
  return inventoryFetchPromise
}

// Fetch blocked emotes
async function fetchBlockedEmotes() {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      // Not logged in - load local blocks only
      await loadLocalBlockedEmotes()
      return
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/blocked`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })

    if (!response.ok) {
      response.body?.cancel()
      return
    }

    const data = await response.json()
    // Server returns blocked_emotes array with hash property
    blockedEmotes = new Set((data.blocked_emotes || []).map((b) => b.hash))

    // Also load local blocks and merge them
    await loadLocalBlockedEmotes()
    const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])

    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
  } catch (error) {
    console.error('[heatsync] fetchBlockedEmotes failed:', error.message || error)
  }
}

// Load local blocked emotes from storage (for anonymous users)
async function loadLocalBlockedEmotes() {
  try {
    const stored = await browser.storage.local.get('local_blocked_emotes')
    if (stored.local_blocked_emotes && Array.isArray(stored.local_blocked_emotes)) {
      localBlockedEmotes = new Set(stored.local_blocked_emotes)
      log(' Loaded', localBlockedEmotes.size, 'local blocked emotes')
    }
  } catch (error) {
    log(' Failed to load local blocked emotes:', error.message)
  }
}

// Save local blocked emotes to storage
async function saveLocalBlockedEmotes() {
  try {
    await browser.storage.local.set({
      local_blocked_emotes: Array.from(localBlockedEmotes),
    })
    log(' Saved', localBlockedEmotes.size, 'local blocked emotes')
  } catch (error) {
    log(' Failed to save local blocked emotes:', error.message)
  }
}

// Fetch followed users
async function fetchFollowedUsers() {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      followedUsers = []
      return
    }

    const response = await fetchWithTimeout(`${API_URL}/api/user/following`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })

    if (!response.ok) {
      response.body?.cancel()
      // 401 means the session is gone — clear. Anything else is transient
      // (5xx, ratelimit): keep the previous list, stale beats empty.
      if (response.status === 401) followedUsers = []
      return
    }

    const data = await response.json()
    followedUsers = (data.following || []).map((f) => f.username)
    log(' Followed users loaded:', followedUsers.length)
    broadcastToTabs({ type: 'followed_users_updated', users: followedUsers })
    // Refresh live status immediately so the badge populates without waiting
    // for the next 1-min alarm tick.
    if (typeof pollFollowedLive === 'function') pollFollowedLive().catch(() => {})
  } catch (error) {
    // Transient failure (network, timeout): keep the previous list.
    console.error('[heatsync] fetchFollowedUsers failed:', error.message || error)
  }
}

// =============================================================================
// LIVE-FOLLOWED CREATOR TRACKING — cross-platform live status awareness.
// Polls every minute, fires desktop notifications on off→on transitions, drives
// the extension badge count. Works for Twitch + Kick simultaneously (and YouTube
// once profiles track yt_is_live). No competitor offers cross-platform live
// notifications — Twitch app is Twitch only, Kick app is Kick only.
// =============================================================================
const LIVE_STATE_KEY = 'hs_live_status_state'
const LIVE_NOTIFY_THROTTLE_MS = 30 * 60 * 1000 // 30 min between notifications for same creator
const LIVE_FETCH_TIMEOUT_MS = 8000
let _liveFollowedCount = 0
let _liveStatusInitialized = false
let _liveStatusState = { lastSeenLive: {}, lastNotifiedAt: {} }
const _liveNotificationUrls = new Map() // notification id → url for click handler
let _livePollInflight = false

async function loadLiveStatusState() {
  try {
    const data = await browser.storage.local.get(LIVE_STATE_KEY)
    if (data?.[LIVE_STATE_KEY]) {
      _liveStatusState = {
        lastSeenLive: data[LIVE_STATE_KEY].lastSeenLive || {},
        lastNotifiedAt: data[LIVE_STATE_KEY].lastNotifiedAt || {},
      }
      _liveStatusInitialized = !!data[LIVE_STATE_KEY].initialized
    }
  } catch {}
}
// Eagerly hydrate at SW boot so handleFollowStreamEvent can gate on lastSeenLive
// before the first pollFollowedLive tick. Without this the WS reconnect burst
// races the poll alarm and slips through.
loadLiveStatusState().catch(() => {})

async function saveLiveStatusState() {
  _liveStatusInitialized = true
  try {
    await browser.storage.local.set({
      [LIVE_STATE_KEY]: { ..._liveStatusState, initialized: true },
    })
  } catch {}
}

// Cached snapshot of currently-live followed streams (for badge tooltip + popup
// + future "next channel" suggestion). Refreshed on every poll cycle.
let _liveFollowedSnapshot = [] // [{username, platform, viewers, displayName, profileImageUrl, key, profile}]

async function pollFollowedLive() {
  if (_livePollInflight) return
  _livePollInflight = true
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      _liveFollowedCount = 0
      _liveFollowedSnapshot = []
      recomputeBadge()
      updateLiveBadgeTooltip()
      return
    }

    if (!_liveStatusInitialized) await loadLiveStatusState()
    const wasFirstPoll = !_liveStatusInitialized

    // ONE call to /api/live/following replaces the per-user /api/profile loop.
    // Server returns one row per (user, platform) live combination so a creator
    // streaming on twitch+kick simultaneously appears twice — that's correct,
    // we want both rows for accurate platform-aware notifications.
    let streams = []
    try {
      const resp = await fetchWithTimeout(
        `${API_URL}/api/live/following`,
        { headers: { Authorization: `Bearer ${authToken}` } },
        LIVE_FETCH_TIMEOUT_MS,
      )
      if (resp.ok) {
        const body = await resp.json()
        streams = body?.streams || body?.data?.streams || []
      } else {
        resp.body?.cancel()
      }
    } catch (e) {
      console.warn('[heatsync] /api/live/following failed:', e?.message)
      return
    }

    const transitions = [] // { username, platform, stream }
    const seen = new Set()
    const snapshot = []

    for (const s of streams) {
      const username = String(s?.username || '').toLowerCase()
      const platform = String(s?.platform || '').toLowerCase()
      if (!username || !platform) continue
      const key = `${platform}:${username}`
      seen.add(key)
      const wasLive = !!_liveStatusState.lastSeenLive?.[key]
      _liveStatusState.lastSeenLive[key] = true

      const viewers = Number(s.viewerCount || s.viewer_count || 0) || 0
      snapshot.push({
        username,
        platform,
        viewers,
        displayName: s.heatsyncDisplayName || s.displayName || s.display_name || username,
        profileImageUrl: s.profileImageUrl || s.profile_image_url || '',
        key,
        stream: s,
      })

      // Off→on transition: fire notification (skipping cold-start)
      if (!wasFirstPoll && !wasLive) {
        const lastNotif = _liveStatusState.lastNotifiedAt?.[key] || 0
        if (Date.now() - lastNotif > LIVE_NOTIFY_THROTTLE_MS) {
          transitions.push({ username, platform, stream: s })
          _liveStatusState.lastNotifiedAt[key] = Date.now()
        }
      }
    }

    // Anything in lastSeenLive but not in current snapshot: stream ended or
    // the user was unfollowed. Delete the entry so the map stays bounded by
    // currently-live followed users instead of growing across all ever-followed
    // accounts. Off-transition is implicit (no longer in lastSeenLive == not live).
    for (const k of Object.keys(_liveStatusState.lastSeenLive)) {
      if (!seen.has(k)) delete _liveStatusState.lastSeenLive[k]
    }
    // Prune lastNotifiedAt entries older than throttle window so memory doesn't grow
    const cutoff = Date.now() - LIVE_NOTIFY_THROTTLE_MS
    for (const k of Object.keys(_liveStatusState.lastNotifiedAt)) {
      if ((_liveStatusState.lastNotifiedAt[k] || 0) < cutoff) {
        delete _liveStatusState.lastNotifiedAt[k]
      }
    }

    await saveLiveStatusState()

    // Dedupe live count by username (a creator on twitch+kick = 1 person live)
    const uniqueLiveUsers = new Set(snapshot.map((s) => s.username))
    _liveFollowedCount = uniqueLiveUsers.size
    _liveFollowedSnapshot = snapshot.sort((a, b) => b.viewers - a.viewers)

    recomputeBadge()
    updateLiveBadgeTooltip()
    broadcastToTabs({ type: 'live_followed_updated', snapshot: _liveFollowedSnapshot })

    if (transitions.length >= 3) fireLiveCoalescedNotification(transitions)
    else for (const t of transitions) fireLiveNotificationFromStream(t.stream, t.username, t.platform)
  } catch (e) {
    console.warn('[heatsync] pollFollowedLive failed:', e?.message || e)
  } finally {
    _livePollInflight = false
  }
}

// Add or update one entry in the live-followed snapshot (badge count + popup
// list). Keyed by platform:username so a creator on twitch+kick keeps two
// rows, matching pollFollowedLive's semantics.
function upsertLiveSnapshotEntry(entry) {
  const key = `${entry.platform}:${entry.username}`
  const full = { ...entry, key }
  const idx = _liveFollowedSnapshot.findIndex((s) => s.key === key)
  if (idx >= 0) _liveFollowedSnapshot[idx] = { ..._liveFollowedSnapshot[idx], ...full }
  else _liveFollowedSnapshot.push(full)
  _liveFollowedSnapshot.sort((a, b) => b.viewers - a.viewers)
  _liveFollowedCount = new Set(_liveFollowedSnapshot.map((s) => s.username)).size
}

function removeLiveSnapshotEntry(platform, username) {
  const key = `${platform}:${username}`
  const before = _liveFollowedSnapshot.length
  _liveFollowedSnapshot = _liveFollowedSnapshot.filter((s) => s.key !== key)
  if (_liveFollowedSnapshot.length !== before) {
    _liveFollowedCount = new Set(_liveFollowedSnapshot.map((s) => s.username)).size
  }
}

// Handle a WS follow:stream:* event: 60s in-mem dedup + persistent lastSeenLive
// gate, then cache + broadcast. This is the FAST PATH for Twitch (the only
// platform the server currently pushes stream events for) — it drives the
// same badge/snapshot/notification pipeline pollFollowedLive does, so the
// 2-min poll alarm only needs to be a reconcile backstop. The in-mem dedup
// is cleared on SW eviction, so we additionally suppress online events for
// channels we already knew were live (persisted via lastSeenLive). Genuine
// off→on transitions still pass (lastSeenLive cleared on offline / poll absence).
function handleFollowStreamEvent(msg) {
  const now = Date.now()
  const dedupKey = `${msg.channel}:${msg.type.replace('follow:', '')}:${msg.game || ''}`
  if (wsStreamEventDedup.has(dedupKey) && now - wsStreamEventDedup.get(dedupKey) < 60000) return
  wsStreamEventDedup.set(dedupKey, now)
  if (wsStreamEventDedup.size > 100) {
    for (const [k, t] of wsStreamEventDedup) {
      if (now - t > 60000) wsStreamEventDedup.delete(k)
    }
  }

  const platform = String(msg.platform || '').toLowerCase()
  const channel = String(msg.channel || '').toLowerCase()
  const liveKey = `${platform}:${channel}`
  if (msg.type === 'follow:stream:online') {
    if (_liveStatusState.lastSeenLive?.[liveKey]) return
    if (!_liveStatusState.lastSeenLive) _liveStatusState.lastSeenLive = {}
    _liveStatusState.lastSeenLive[liveKey] = true
    saveLiveStatusState().catch(() => {})

    upsertLiveSnapshotEntry({
      username: channel,
      platform,
      viewers: 0,
      displayName: channel,
      profileImageUrl: '',
    })
    recomputeBadge()
    updateLiveBadgeTooltip()
    broadcastToTabs({ type: 'live_followed_updated', snapshot: _liveFollowedSnapshot })

    // Same 30-min re-notify throttle pollFollowedLive uses. Skip entirely
    // before persisted state has loaded (cold SW boot) — otherwise a burst
    // of "already live" pushes on first connect would fire a notification
    // storm for everything, same guard as pollFollowedLive's wasFirstPoll.
    if (_liveStatusInitialized) {
      const lastNotif = _liveStatusState.lastNotifiedAt?.[liveKey] || 0
      if (now - lastNotif > LIVE_NOTIFY_THROTTLE_MS) {
        if (!_liveStatusState.lastNotifiedAt) _liveStatusState.lastNotifiedAt = {}
        _liveStatusState.lastNotifiedAt[liveKey] = now
        fireLiveNotificationFromStream({ title: msg.title || '', game: msg.game || '' }, channel, platform).catch(
          () => {},
        )
      }
    }
  } else if (msg.type === 'follow:stream:offline') {
    if (_liveStatusState.lastSeenLive?.[liveKey]) {
      delete _liveStatusState.lastSeenLive[liveKey]
      saveLiveStatusState().catch(() => {})
    }
    removeLiveSnapshotEntry(platform, channel)
    recomputeBadge()
    updateLiveBadgeTooltip()
    broadcastToTabs({ type: 'live_followed_updated', snapshot: _liveFollowedSnapshot })
  }

  if (!cachedFollowHistory) cachedFollowHistory = []
  cachedFollowHistory.push({
    type: msg.type,
    platform: msg.platform,
    channel: msg.channel,
    game: msg.game || '',
    title: msg.title || '',
    prevGame: msg.prevGame || '',
    prevTitle: msg.prevTitle || '',
    color: msg.color || '',
    time: now,
  })
  if (cachedFollowHistory.length > 200) cachedFollowHistory.splice(0, cachedFollowHistory.length - 200)
  broadcastToTabs({
    type: 'follow_stream_event',
    eventType: msg.type.replace('follow:', ''),
    platform: msg.platform,
    channel: msg.channel,
    game: msg.game || '',
    title: msg.title || '',
    prevGame: msg.prevGame || '',
    prevTitle: msg.prevTitle || '',
    color: msg.color || '',
  })
}

// One-shot catch-up sent by the server right after WS authenticate: the
// cross-platform live-following state (Twitch + Kick + YouTube) that existed
// before this connection, read from the same 30s Redis cache /api/live/following
// uses. Union-merge ONLY — never removes/marks-offline anything, so a cold
// cache (server sends nothing) or a partial cache can't wrongly wipe out state
// we already knew from a previous session. Removals still flow through explicit
// follow:stream:offline pushes (Twitch) and the 2-min poll backstop (all
// platforms). Never fires notifications — this is catch-up, not a transition.
function handleFollowLiveSnapshot(msg) {
  const streams = Array.isArray(msg.streams) ? msg.streams : []
  if (streams.length === 0) return
  if (!_liveStatusState.lastSeenLive) _liveStatusState.lastSeenLive = {}
  let changed = false
  for (const s of streams) {
    const username = String(s?.username || '').toLowerCase()
    const platform = String(s?.platform || '').toLowerCase()
    if (!username || !platform) continue
    const key = `${platform}:${username}`
    if (!_liveStatusState.lastSeenLive[key]) {
      _liveStatusState.lastSeenLive[key] = true
      changed = true
    }
    upsertLiveSnapshotEntry({
      username,
      platform,
      viewers: Number(s.viewerCount || s.viewer_count || 0) || 0,
      displayName: s.heatsyncDisplayName || s.displayName || s.display_name || username,
      profileImageUrl: s.profileImageUrl || s.profile_image_url || '',
      stream: s,
    })
  }
  if (changed) saveLiveStatusState().catch(() => {})
  recomputeBadge()
  updateLiveBadgeTooltip()
  broadcastToTabs({ type: 'live_followed_updated', snapshot: _liveFollowedSnapshot })
}

// Set browser action title (icon hover tooltip) — top live followed names.
function updateLiveBadgeTooltip() {
  if (!badgeApi) return
  const live = _liveFollowedSnapshot || []
  if (live.length === 0) {
    badgeApi.setTitle?.({ title: 'heatsync' })?.catch?.(() => {})
    return
  }
  const top = live
    .slice(0, 5)
    .map((s) => s.displayName || s.username)
    .join(', ')
  const more = live.length > 5 ? ` +${live.length - 5} more` : ''
  const title = `heatsync · ${live.length} live: ${top}${more}`
  try {
    badgeApi.setTitle({ title })
  } catch {}
}

async function fireLiveNotificationFromStream(stream, username, platform) {
  if (!browser.notifications?.create) return
  const display = stream.heatsyncDisplayName || stream.displayName || stream.display_name || username
  const viewers = Number(stream.viewerCount || stream.viewer_count || 0) || 0
  const platName =
    platform === 'twitch' ? 'Twitch' : platform === 'kick' ? 'Kick' : platform === 'youtube' ? 'YouTube' : platform
  const slug =
    platform === 'twitch'
      ? stream.twitch_username || username
      : platform === 'kick'
        ? stream.kick_username || username
        : stream.youtube_username || stream.youtube_channel_id || username
  const url =
    platform === 'twitch'
      ? `https://www.twitch.tv/${slug}`
      : platform === 'kick'
        ? `https://kick.com/${slug}`
        : platform === 'youtube'
          ? `https://www.youtube.com/${slug?.startsWith('UC') ? `channel/${slug}` : `@${slug}`}`
          : null
  if (!url) return

  const viewerStr = viewers > 0 ? ` · ${viewers.toLocaleString()} viewers` : ''
  const id = `hs-live-${platform}-${username}-${Date.now()}`
  _liveNotificationUrls.set(id, url)
  if (_liveNotificationUrls.size > 50) {
    const oldest = _liveNotificationUrls.keys().next().value
    _liveNotificationUrls.delete(oldest)
  }
  // Streamer pfp > heatsync logo: the notification is about a specific person,
  // showing their face/avatar is the recognizable signal ("oh, shroud is up").
  // Falls back to the extension icon if no pfp resolved (rare — resolveIdentity
  // usually fills this in; coldest cold-starts may lack it).
  let pfp =
    stream.profileImageUrl ||
    stream.profile_image_url ||
    stream.heatsyncAvatar ||
    stream.avatar_url ||
    stream.avatar ||
    ''
  // /api/live/following may not carry a pfp — resolve it directly so the toast
  // still shows a face instead of the logo.
  if (!pfp) pfp = await resolveAvatarUrl(username, platform)
  const iconUrl = (await toNotifIconDataUrl(pfp)) || browser.runtime.getURL('icon-128.png')
  try {
    browser.notifications.create(id, {
      type: 'basic',
      iconUrl,
      title: `${display} is live`,
      message: `${platName}${viewerStr}`,
      contextMessage: 'heatsync',
      priority: 1,
    })
  } catch (e) {
    console.warn('[heatsync] fireLiveNotification failed:', e?.message)
  }
}

async function fireLiveCoalescedNotification(transitions) {
  if (!browser.notifications?.create) return
  const names = transitions.map((t) => {
    const s = t.stream
    return s.heatsyncDisplayName || s.displayName || s.display_name || t.username
  })
  const uniqNames = [...new Set(names)]
  const head = uniqNames.slice(0, 3).join(', ')
  const more = uniqNames.length > 3 ? ` +${uniqNames.length - 3} more` : ''
  const id = `hs-live-batch-${Date.now()}`
  _liveNotificationUrls.set(id, `${API_URL}/?tab=following`)
  if (_liveNotificationUrls.size > 50) {
    const oldest = _liveNotificationUrls.keys().next().value
    _liveNotificationUrls.delete(oldest)
  }
  // Lead with the top streamer's pfp (matches the first name in the list) —
  // a face reads faster than the logo. Falls back to the icon if unresolved.
  const lead = transitions[0]?.stream || {}
  let pfp =
    lead.profileImageUrl || lead.profile_image_url || lead.heatsyncAvatar || lead.avatar_url || lead.avatar || ''
  if (!pfp) pfp = await resolveAvatarUrl(transitions[0]?.username, transitions[0]?.platform)
  const iconUrl = (await toNotifIconDataUrl(pfp)) || browser.runtime.getURL('icon-128.png')
  try {
    browser.notifications.create(id, {
      type: 'basic',
      iconUrl,
      title: `${uniqNames.length} following are live`,
      message: `${head}${more}`,
      contextMessage: 'heatsync',
      priority: 1,
    })
  } catch (e) {
    console.warn('[heatsync] fireLiveCoalescedNotification failed:', e?.message)
  }
}

// OS notifications outlive the SW — a click can wake a fresh SW whose
// _liveNotificationUrls map is empty. The id encodes the target
// (hs-live-${platform}-${username}-${ts}), so rebuild the URL from it.
function _liveNotificationUrlFromId(id) {
  if (id.startsWith('hs-live-batch-')) return `${API_URL}/?tab=following`
  const m = /^hs-live-(twitch|kick|youtube)-(.+)-\d+$/.exec(id)
  if (!m) return null
  const [, platform, username] = m
  if (platform === 'twitch') return `https://www.twitch.tv/${username}`
  if (platform === 'kick') return `https://kick.com/${username}`
  return `https://www.youtube.com/${username.startsWith('UC') ? `channel/${username}` : `@${username}`}`
}

if (browser.notifications?.onClicked) {
  browser.notifications.onClicked.addListener((id) => {
    const url = _liveNotificationUrls.get(id) || _liveNotificationUrlFromId(id)
    if (url) {
      browser.tabs.create({ url }).catch(() => {})
      _liveNotificationUrls.delete(id)
      try {
        browser.notifications.clear(id)
      } catch {}
    }
  })
}

// Fetch user profile info for popup display
async function fetchUserInfo() {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      browser.storage.local.remove('user_info')
      return
    }

    const response = await fetchWithTimeout(`${API_URL}/api/auth/me`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${authToken}` },
    })

    if (!response.ok) {
      response.body?.cancel()
      // Only an explicit auth rejection means "logged out" — wipe. A 5xx/429/
      // gateway blip is transient: keep stale user_info so mention aliases +
      // display identity survive instead of silently dying until next refetch.
      // Drop the TOKEN too, not just the identity. Clearing user_info alone
      // left the worst possible state: token present so every signed-out
      // affordance stays hidden (they all test the token), identity absent so
      // nothing matches you — signed out in fact, signed in on screen, silent
      // either way. Removing both makes the existing logged-out UI correct
      // again and lets the next cookie read re-authenticate cleanly.
      if (response.status === 401 || response.status === 403) {
        await browser.storage.local.remove(['user_info', 'auth_token_encrypted', 'auth_token'])
        try {
          broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'session_expired' })
        } catch (_) {}
      }
      return
    }

    const bodyText = await response.text()
    if (!bodyText) return // empty 200 = server anomaly — keep stale identity
    let user
    try {
      user = JSON.parse(bodyText)
    } catch {
      return // unparseable = transient — keep stale identity
    }
    if (!user) {
      browser.storage.local.remove('user_info')
      return
    }

    const userInfo = {
      // Identity ids — the paint/colour/tenure lookups are keyed by them
      // (primeSelfHsCosmetics).
      id: user.id != null ? String(user.id) : '',
      twitch_id: user.twitch_id != null ? String(user.twitch_id) : '',
      kick_id: user.kick_id != null ? String(user.kick_id) : '',
      display_name: user.display_name || user.twitch_username || user.kick_username || '',
      username: user.username || user.twitch_username || '',
      twitch_username: user.twitch_username || '',
      kick_username: user.kick_username || '',
      youtube_username: user.youtube_username || '',
      youtube_channel_id: user.youtube_channel_id || '',
      avatar_url: user.twitch_profile_pic || user.kick_profile_pic || user.profile_image_url || '',
      heat: user.heat || 0,
      color: user.color || '',
      // Every batch key this HS account resolves as (server-computed). The
      // panel compares the identity it's chatting under against this list —
      // a miss means "your emotes can't render for anyone else here".
      sender_keys: Array.isArray(user.sender_keys)
        ? user.sender_keys.filter((k) => typeof k === 'string').slice(0, 10)
        : null,
      youtube_verified: !!user.youtube_verified,
    }
    currentUsername = userInfo.username
    // Persist HERE, not via a global the init batch happens to flush later.
    // This used to only set `pendingUserInfoToPersist`, which reached disk in
    // exactly one place: initialize()'s Promise.all tail. So logging in stored
    // your TOKEN but never your IDENTITY — the cookie-change login path and the
    // popup's refresh both fetched it and dropped it when the service worker
    // died. Overlay symptoms: no red mentions, no "replied to you", no mention
    // pings — while every signed-out affordance stayed hidden because those all
    // key off the token, which WAS present. Nothing on screen said anything.
    await browser.storage.local.set({ user_info: userInfo })
    log(' User info loaded:', userInfo.display_name)
  } catch (error) {
    console.error('[heatsync] fetchUserInfo failed:', error.message || error)
  }
}

// v1.6 — load the viewer's content filter settings. Falls back to stored
// value if the network call fails, then to defaults. Flags flow into every
// emote-fetch via withNsfwParam() below.
async function fetchViewerSettings() {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      viewerShowSexual = false
      viewerShowGore = false
      browser.storage.local.set({ viewer_show_sexual: false, viewer_show_gore: false })
      return
    }
    const resp = await fetchWithTimeout(`${API_URL}/api/user/settings`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (!resp.ok) {
      resp.body?.cancel()
      return
    }
    const data = await resp.json().catch(() => null)
    if (data && typeof data.show_sexual_emotes === 'boolean') {
      viewerShowSexual = data.show_sexual_emotes
      browser.storage.local.set({ viewer_show_sexual: viewerShowSexual })
    }
    if (data && typeof data.show_gore_emotes === 'boolean') {
      viewerShowGore = data.show_gore_emotes
      browser.storage.local.set({ viewer_show_gore: viewerShowGore })
    }
    if (data && typeof data.show_weapon_emotes === 'boolean') {
      viewerShowWeapon = data.show_weapon_emotes
      browser.storage.local.set({ viewer_show_weapon: viewerShowWeapon })
    }
    if (data && typeof data.show_drug_emotes === 'boolean') {
      viewerShowDrug = data.show_drug_emotes
      browser.storage.local.set({ viewer_show_drug: viewerShowDrug })
    }
    if (data && typeof data.show_hate_emotes === 'boolean') {
      viewerShowHate = data.show_hate_emotes
      browser.storage.local.set({ viewer_show_hate: viewerShowHate })
    }
  } catch (error) {
    log(' fetchViewerSettings failed:', error?.message)
  }
}

// Append content-filter params to an emote-fetch URL. URL may already have a query.
// Covers include_sexual + include_gore (default hide) + include_weapons/drugs/hate (default show).
function withNsfwParam(url) {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}include_sexual=${viewerShowSexual ? 'true' : 'false'}&include_gore=${viewerShowGore ? 'true' : 'false'}&include_weapons=${viewerShowWeapon ? 'true' : 'false'}&include_drugs=${viewerShowDrug ? 'true' : 'false'}&include_hate=${viewerShowHate ? 'true' : 'false'}`
}

// Validate emote objects from third-party APIs to bound string sizes and URL patterns
// Allowlist of CDN hosts emote URLs can come from. cdn.heatsync.org is
// added explicitly — server-side toAbsoluteEmoteUrl rewrites /uploads/*
// to cdn.heatsync.org (CDN-cached subdomain), so leaving it off the
// allowlist silently dropped every self-hosted emote (including v1.6
// flagged emotes the user uploaded) from the ext inventory.
const EMOTE_CDN_PATTERN =
  /^https:\/\/(cdn\.(betterttv\.net|7tv\.app|frankerfacez\.com|heatsync\.org)|static-cdn\.jtvnw\.net|heatsync\.org|files\.kick\.com)\//
const MAX_EMOTE_NAME_LEN = 100
const MAX_EMOTES_PER_SOURCE = 5000
// BTTV declares per-emote 1x width/height; most are 28px tall but some globals
// (NaM = 38×40) are intentionally oversized and native BTTV renders them at
// that height. Carry the height→baseline ratio so render can raise its clamp.
// Clamped to 2× as a sanity bound against rogue API values.
function bttvOversize(e) {
  const h = Number(e?.height)
  return h > 28 ? Math.min(2, +(h / 28).toFixed(3)) : undefined
}
function sanitizeEmote(e) {
  if (!e || typeof e.name !== 'string' || typeof e.url !== 'string') return null
  if (e.name.length > MAX_EMOTE_NAME_LEN || e.name.length === 0) return null
  if (!EMOTE_CDN_PATTERN.test(e.url)) return null
  return e
}
function sanitizeEmoteList(emotes) {
  return emotes.slice(0, MAX_EMOTES_PER_SOURCE).map(sanitizeEmote).filter(Boolean)
}

// Fetch BTTV channel emotes
async function fetchBTTVChannelEmotes(channelName, channelId = null, platform = 'twitch') {
  try {
    if (platform === 'youtube') {
      // BTTV's YouTube endpoint (unlike 7TV's) is keyed under "youtube" and
      // needs the real UC... channel id — no handle lookup here either.
      if (!/^UC[\w-]{20,}$/i.test(String(channelId || ''))) {
        log(' BTTV: No resolvable YouTube channel ID for', channelName, '- skipping')
        return []
      }
      const ytResponse = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/youtube/${channelId}`)
      if (ytResponse.status === 404) {
        ytResponse.body?.cancel()
        return [] // genuine: user has no BTTV
      }
      if (!ytResponse.ok) {
        ytResponse.body?.cancel()
        return null // transient: 5xx etc.
      }
      const ytData = await ytResponse.json()
      const ytEmotes = [...(ytData.channelEmotes || []), ...(ytData.sharedEmotes || [])]
      return sanitizeEmoteList(
        ytEmotes.map((e) => ({
          name: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
          source: 'bttv',
          os: bttvOversize(e),
          hash: e.id,
        })),
      )
    }
    // BTTV API requires numeric Twitch user ID, not username
    let twitchId = channelId
    if (!twitchId) {
      twitchId = await lookupTwitchUserId(channelName)
      if (!twitchId) {
        log(' BTTV: Could not resolve Twitch ID for', channelName)
        return null // transient: ID lookup failed, retry next time
      }
    }
    const userResponse = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`)
    if (userResponse.status === 404) {
      userResponse.body?.cancel()
      return []
    } // genuine: user has no BTTV
    if (!userResponse.ok) {
      userResponse.body?.cancel()
      return null
    } // transient: 5xx etc.

    const userData = await userResponse.json()
    const emotes = [...(userData.channelEmotes || []), ...(userData.sharedEmotes || [])]

    return sanitizeEmoteList(
      emotes.map((e) => ({
        name: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
        source: 'bttv',
        hash: e.id,
        os: bttvOversize(e),
      })),
    )
  } catch (error) {
    log(' BTTV channel emotes error for:', channelName, error?.message)
    return null // transient: network/timeout
  }
}

// Negative cache for FFZ room 404s — a channel with no FFZ room 404s on
// EVERY visit, and the orchestrator's failure backdating (any sibling
// provider failing shortens the retry window to ~60s) was re-fetching the
// same dead room several times a minute. Session-scoped Map like
// ytChannelIdCache — cheap to rebuild after a SW restart.
const ffzRoom404At = new Map() // room key (lowercase) → ms timestamp of the 404
const FFZ_ROOM_404_TTL = 30 * 60 * 1000 // matches CHANNEL_EMOTES_TTL — new FFZ rooms are rare
const FFZ_ROOM_404_MAX = 500

// Fetch FFZ channel emotes
async function fetchFFZChannelEmotes(channelName) {
  const roomKey = String(channelName || '').toLowerCase()
  // FFZ rooms are TWITCH rooms only. YouTube identities — UC… channel ids,
  // @handles, hyphenated 11-char videoIds — contain chars a Twitch login
  // ([a-z0-9_], ≤25) never can. Do NOT also gate on ytChannelIdCache: linked
  // twitch channels resolve their yt id under the SAME bare-login key, so
  // that check silently killed FFZ for every twitch channel with a linked
  // youtube. A rare login-shaped videoId just 404s into ffzRoom404At.
  if (!/^[a-z0-9_]{1,25}$/.test(roomKey)) return []
  const negAt = ffzRoom404At.get(roomKey)
  if (negAt && Date.now() - negAt < FFZ_ROOM_404_TTL) return []
  try {
    const response = await fetchWithTimeout(`https://api.frankerfacez.com/v1/room/${roomKey}`)
    if (response.status === 404) {
      response.body?.cancel()
      if (ffzRoom404At.size >= FFZ_ROOM_404_MAX) ffzRoom404At.delete(ffzRoom404At.keys().next().value)
      ffzRoom404At.set(roomKey, Date.now())
      return []
    } // genuine: channel has no FFZ
    if (!response.ok) {
      response.body?.cancel()
      return null
    } // transient: 5xx etc.
    ffzRoom404At.delete(roomKey) // room exists (again) — drop any expired negative entry

    const data = await response.json()
    const emotes = []

    for (const setId in data.sets) {
      const set = data.sets[setId]
      for (const emote of set.emoticons || []) {
        // FFZ modifier emotes (ffzW/ffzX/ffzY/ffzCursed/ffzHyper…) aren't real
        // images — they transform the preceding emote. Handled as typed tokens
        // via src/lib/modifiers.js, so keep them out of the pool: otherwise they
        // resolve as base emotes (the FFZ arrow placeholder), pollute the picker,
        // and break overlay stacks (e.g. "LICK ffzW ALERT0").
        if (emote.modifier) continue
        // FFZ exposes animated emotes under emote.animated (animated webp);
        // emote.urls is the static PNG first-frame. Prefer animated when present.
        const srcs = emote.animated || emote.urls
        const rawUrl = srcs['1'] || srcs['2'] || srcs['4']
        emotes.push({
          name: emote.name,
          url: rawUrl.startsWith('https:') ? rawUrl : `https:${rawUrl}`,
          source: 'ffz',
          hash: `ffz-${emote.id}`,
        })
      }
    }
    return sanitizeEmoteList(emotes)
  } catch (error) {
    log(' FFZ channel emotes error for:', channelName, error?.message)
    return null // transient
  }
}

// Cache Twitch user IDs to avoid repeated lookups (especially for polling).
// Persisted to chrome.storage.local — IDs never change, so cross-SW survival
// eliminates the resolve/GQL cascade on every SW wake (critical at 30k users).
const twitchIdCache = new Map()
const TWITCH_ID_CACHE_MAX = 1000
const kickChannelIdCache = new Map()

// Kick channel slug → numeric channelId, LRU-cached (cap 100). Shared by the
// kick_resolve_channel runtime-message handler, the kick_send_message flow,
// and the kick:relay_send ws path (server-relayed sends from heatsync.org).
async function resolveKickChannelIdBg(slug) {
  if (!slug) return { error: 'no slug' }
  const cached = kickChannelIdCache.get(slug)
  if (cached) return { channelId: cached }
  try {
    const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
    if (!resp.ok) return { error: `kick api ${resp.status}` }
    const data = await resp.json()
    // messages/send/{id} takes the CHATROOM id, not the channel id. Kick's
    // backend stopped translating channel ids (2026-07): a channel-id send
    // returns 200 but broadcasts to no one — the message lands in the void
    // (proven live: send to channels.id silent, send to chatroom.id echoes
    // on chatrooms.<id>.v2). Fall back to data.id only if chatroom is absent.
    const channelId = data?.chatroom?.id || data?.id
    if (!channelId) return { error: 'no channel id' }
    if (kickChannelIdCache.size >= 100) {
      const oldest = kickChannelIdCache.keys().next().value
      kickChannelIdCache.delete(oldest)
    }
    kickChannelIdCache.set(slug, channelId)
    return { channelId }
  } catch (e) {
    return { error: e.message }
  }
}

// Send a Kick chat message via a kick.com tab's session cookies. Any kick.com
// tab works as the messaging origin — the send is parameterized by channelId
// + XSRF token, not by which channel the tab happens to be viewing. Shared by
// the kick_send_message runtime-message handler and the kick:relay_send ws
// path.
// Rank kick.com tabs by relay viability: a discarded tab has NO content
// scripts (memory-saver unloads them) and a pre-reload tab holds an
// invalidated context — both throw "Receiving end does not exist" on
// tabs.sendMessage. Loaded+active tabs first; dead ones fail fast, so
// walking the whole list costs ~ms per corpse.
function rankKickRelayTabs(tabs) {
  return [...tabs].sort(
    (a, b) =>
      (a.discarded === true) - (b.discarded === true) ||
      (b.status === 'complete') - (a.status === 'complete') ||
      (b.active === true) - (a.active === true),
  )
}

async function sendKickMessageViaTab(channelId, content, reply = null) {
  if (!channelId || !content) return { ok: false, error: 'missing params' }
  const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
  if (!cookie?.value) return { ok: false, error: 'kick_not_logged_in' }
  // Kick's send API now demands Authorization: Bearer <session_token> — the
  // laravel session cookie + XSRF alone 403s "User is not authenticated"
  // (changed 2026-07). Cookie is non-httpOnly; absent = logged out.
  const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
  const tabs = await browser.tabs.query({ url: '*://*.kick.com/*' })
  if (!tabs || tabs.length === 0) return { ok: false, error: 'no_kick_tab' }
  let lastError = 'no response from tab'
  for (const tab of rankKickRelayTabs(tabs)) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, {
        type: 'kick_send_relay',
        channelId,
        content,
        reply: reply || null,
        xsrfToken: cookie.value,
        sessionToken: session?.value || '',
      })
      if (result) return result
    } catch (e) {
      lastError = e?.message || 'tab relay failed'
    }
  }
  return { ok: false, error: lastError }
}

// Kick chat modes — PUT /api/v1/chatrooms/<chatroomId>. Route discovered
// read-only: a GET on it answers 405 "Supported methods: PUT". Same auth shape
// as sendKickMessageViaTab (XSRF cookie + Bearer session_token), same reason it
// must run inside a kick.com tab.
async function setKickChatModeViaTab(chatroomId, body) {
  if (!chatroomId || !body) return { ok: false, error: 'missing params' }
  const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
  if (!cookie?.value) return { ok: false, error: 'kick_not_logged_in' }
  const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
  const tabs = await browser.tabs.query({ url: '*://*.kick.com/*' })
  if (!tabs || tabs.length === 0) return { ok: false, error: 'no_kick_tab' }
  let lastError = 'no response from tab'
  for (const tab of rankKickRelayTabs(tabs)) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, {
        type: 'kick_chatmode_relay',
        chatroomId,
        body,
        xsrfToken: cookie.value,
        sessionToken: session?.value || '',
      })
      if (result) return result
    } catch (e) {
      lastError = e?.message || 'tab relay failed'
    }
  }
  return { ok: false, error: lastError }
}

const kickChatroomIdCache = new Map()
const kickUsernameToIdCache = new Map()

// AutoMod hold-queue — per-broadcaster watch-registration throttle. Ext
// surfaces re-send automod_watch every ~25min as a keepalive; this caps the
// actual heatsync.org call to once per window (the server's own last_active_at
// bump is the real keepalive signal, not the HTTP call cadence).
const AUTOMOD_WATCH_THROTTLE_MS = 30 * 60 * 1000
const _automodWatchThrottle = new Map() // broadcasterId -> last-sent ts
// One shape for a held message, whichever door it came through: the live
// websocket push, or the pending backfill the watch call hands back. Two
// copies of this coercion would drift the way every duplicated message
// pipeline in this codebase has (see tests/handler-parity.test.js), and the
// backfill would be the copy nobody notices is wrong.
function normalizeAutomodHold(msg) {
  // heldAt arrives as an ISO 8601 string from the server (Helix timestamp
  // shape) — Number() on that NaNs, which silently always fell back to
  // Date.now(). Date.parse handles the string case; Number still covers a
  // server that ever sends an epoch ms number. It matters more for a backfill
  // than for a live push: a hold from 40 minutes ago must not read as now.
  const heldAtRaw = typeof msg.heldAt === 'string' ? Date.parse(msg.heldAt) : Number(msg.heldAt)
  const heldAt = Number.isFinite(heldAtRaw) && heldAtRaw > 0 ? heldAtRaw : Date.now()
  return {
    type: 'automod_hold',
    broadcasterId: String(msg.broadcasterId || ''),
    broadcasterLogin: String(msg.broadcasterLogin || '').toLowerCase(),
    msgId: String(msg.msgId || ''),
    senderId: String(msg.senderId || ''),
    senderLogin: String(msg.senderLogin || '').toLowerCase(),
    senderName: String(msg.senderName || msg.senderLogin || '').slice(0, 100),
    text: String(msg.text || '').slice(0, 2000),
    heldAt,
    reason: msg.reason === 'blocked_term' ? 'blocked_term' : 'automod',
    category: msg.category ? String(msg.category).slice(0, 100) : null,
    level: Number(msg.level) || 0,
    terms: Array.isArray(msg.terms)
      ? msg.terms
          .map((t) => String(t).slice(0, 100))
          .filter(Boolean)
          .slice(0, 10)
      : null,
  }
}
let _automodRelinkNotified = false // one 'automod_relink' broadcast per SW lifetime
function notifyAutomodRelinkOnce() {
  if (_automodRelinkNotified) return
  _automodRelinkNotified = true
  broadcastToTabs({ type: 'automod_relink' })
}
// Kick chatter profile_pic (username → url), captured from the SAME v1/users
// fetch that resolves the kick user_id — so real avatars cost zero extra
// requests. Populated in lockstep with kickUsernameToIdCache (both set only when
// v1/users runs), so an id-cache hit always implies a pfp-cache hit.
const kickUsernameToPfpCache = new Map()
// kick channel slug (lowercased) → numeric kick user id. 7TV's /v3/users/kick/{id}
// needs the numeric id; the initial fetch resolves it via GQL, the poll reuses it.
const channelOwnerKickId = new Map()

// channel-cache-key (lowercased, whatever "channel" string join_channel used —
// a handle, a videoId, or a config tab id) → resolved YouTube UC... channel id.
// Neither 7TV nor BTTV can look up YouTube channels by handle/videoId, only by
// the real UC id, and YouTube's own oEmbed only ever hands back a handle — so
// this is resolved once (scrape the channel page's canonical id) and cached.
// Not persisted (mirrors kickChannelIdCache — session-scoped is fine, cheap to
// re-resolve after a SW restart).
const ytChannelIdCache = new Map()
const YT_CHANNEL_ID_CACHE_MAX = 300

// Resolve the real YouTube channel id (UC...) for a channel-emote fetch.
// `channelName` is the cache key (handle/videoId/tab-id — whatever join_channel
// was called with); `hint` is anything more specific the caller already has
// (e.g. a stored `.../channel/UC.../` or `/@handle` URL). Never falls back to
// guessing a Twitch/Kick identity — an unresolved id means "skip, no emotes."
async function resolveYtChannelId(channelName, hint = null) {
  const key = String(channelName || '').toLowerCase()
  if (!key) return null
  const cached = ytChannelIdCache.get(key)
  if (cached) return cached

  // Already have a UC id sitting in the hint or the channel name itself.
  const direct = (String(hint || '').match(/UC[\w-]{20,}/) || String(channelName || '').match(/UC[\w-]{20,}/))?.[0]
  if (direct) {
    ytChannelIdCache.set(key, direct)
    return direct
  }

  // Pull an @handle out of the hint/channelName; bare alnum strings (e.g. a
  // manually-typed handle with no @) count too. A raw 11-char videoId won't
  // match either pattern — resolve its handle via the existing oEmbed lookup
  // first (getYtChannelHandle is already used for the WS-subscribe path).
  const handleMatch = String(hint || channelName || '').match(/@([\w.-]+)/)
  let handle = handleMatch ? handleMatch[1] : /^[\w.-]{3,30}$/.test(key) ? key : null
  if (!handle && /^[\w-]{11}$/.test(key)) {
    handle = await getYtChannelHandle(key)
  }
  if (!handle) return null // nothing to resolve from — skip quietly, no cross-platform guessing

  try {
    const resp = await fetchWithTimeout(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {}, 6000)
    if (!resp.ok) {
      resp.body?.cancel()
      return null
    }
    const html = await resp.text()
    const m = html.match(/"externalId":"(UC[\w-]{20,})"/)
    const id = m?.[1] || null
    if (id) {
      if (ytChannelIdCache.size >= YT_CHANNEL_ID_CACHE_MAX)
        ytChannelIdCache.delete(ytChannelIdCache.keys().next().value)
      ytChannelIdCache.set(key, id)
    }
    return id
  } catch (e) {
    log(' YouTube channel ID resolve failed for', handle, ':', e?.message)
    return null
  }
}
let twitchIdPersistTimer = null
function persistTwitchIdCache() {
  if (twitchIdPersistTimer) return
  twitchIdPersistTimer = setTimeout(() => {
    twitchIdPersistTimer = null
    browser.storage.local.set({ twitch_id_cache: Object.fromEntries(twitchIdCache) }).catch(() => {})
  }, 5000)
}

// Lookup Twitch user ID from username — try Twitch GQL first (fast, no rate limit), first-party resolve fallback
async function lookupTwitchUserId(username) {
  const cached = twitchIdCache.get(username)
  if (cached) {
    twitchIdCache.delete(username)
    twitchIdCache.set(username, cached)
    return cached
  }
  try {
    // Twitch GQL — same client ID used by the website, no auth needed
    const gqlResp = await fetchWithTimeout('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ user(login: "${username.replace(/[^a-z0-9_]/gi, '')}") { id } }` }),
    })
    if (gqlResp.ok) {
      const gqlData = await gqlResp.json()
      const id = gqlData?.data?.user?.id
      if (id) {
        if (twitchIdCache.size >= TWITCH_ID_CACHE_MAX) {
          twitchIdCache.delete(twitchIdCache.keys().next().value)
        }
        twitchIdCache.set(username, id)
        persistTwitchIdCache()
        log('[hs-bg] GQL lookup', username, '→', id)
        return id
      }
    }
  } catch (e) {
    log(' GQL user lookup failed, trying first-party resolve:', e.message)
  }
  // Fallback to first-party resolver
  try {
    const response = await fetchWithTimeout(
      `https://heatsync.org/api/resolve/twitch/${encodeURIComponent(username)}`,
      {},
      2000,
    )
    if (!response.ok) {
      response.body?.cancel()
      return null
    }
    const data = await response.json()
    const id = data?.id
    if (id && /^\d+$/.test(String(id))) {
      if (twitchIdCache.size >= TWITCH_ID_CACHE_MAX) {
        twitchIdCache.delete(twitchIdCache.keys().next().value)
      }
      twitchIdCache.set(username, String(id))
      persistTwitchIdCache()
      return String(id)
    }
    return null
  } catch (e) {
    log(' Failed to lookup Twitch user ID:', e)
    return null
  }
}

// Resolve a user's avatar (pfp) for notification toasts. A toast is about a
// specific person — their face is the recognizable signal, not the heatsync
// logo. Cached LRU (success only — never poison the cache on a transient
// failure, so a later mention can retry). Returns '' when unresolved; callers
// fall back to the extension icon.
const avatarCache = new Map()
const AVATAR_CACHE_MAX = 500
async function resolveAvatarUrl(username, platform) {
  if (!username) return ''
  const name = String(username).trim()
  if (!name) return ''
  const key = `${platform || 'twitch'}|${name.toLowerCase()}`
  const hit = avatarCache.get(key)
  if (hit !== undefined) {
    avatarCache.delete(key)
    avatarCache.set(key, hit)
    return hit
  }
  let url = ''
  try {
    if (platform === 'kick') {
      // Kick public v2 — channel slug (= username) → user.profile_pic.
      const r = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(name)}`, {}, 3000)
      if (r.ok) {
        const j = await r.json()
        url = j?.user?.profile_pic || ''
      } else r.body?.cancel?.()
    } else if (platform === 'youtube' || platform === 'yt') {
      // No twitch GQL for a youtube identity — a yt handle that happens to
      // match an unrelated twitch login would return THAT user's avatar as the
      // toast icon. No cheap unauthenticated yt avatar endpoint, so leave blank
      // (toast falls back to the platform mark).
      url = ''
    } else {
      // Twitch GQL — same client-id as the website, unauthenticated, no rate limit.
      const r = await fetchWithTimeout(
        'https://gql.twitch.tv/gql',
        {
          method: 'POST',
          headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{ user(login: "${name.replace(/[^a-z0-9_]/gi, '')}") { profileImageURL(width: 70) } }`,
          }),
        },
        3000,
      )
      if (r.ok) {
        const j = await r.json()
        url = j?.data?.user?.profileImageURL || ''
      } else r.body?.cancel?.()
    }
  } catch {}
  if (url) {
    if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value)
    avatarCache.set(key, url)
  }
  return url
}

// chrome.notifications renders data: URLs reliably; remote https icons are
// flaky when Chrome hands the toast to a native daemon (mako on wlroots). Fetch
// the pfp in the SW and inline it as base64 so the face always shows. No
// FileReader in MV3 service workers — use arrayBuffer + btoa. Returns '' on any
// failure so the caller falls back to the extension icon.
async function toNotifIconDataUrl(url) {
  if (!url) return ''
  if (url.startsWith('data:')) return url
  try {
    const r = await fetchWithTimeout(url, {}, 4000)
    if (!r.ok) {
      r.body?.cancel?.()
      return ''
    }
    const blob = await r.blob()
    if (blob.size > 512 * 1024) return '' // sanity cap — pfps are tiny
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`
  } catch {
    return ''
  }
}

// Fetch 7TV channel emotes
// Supports Twitch (user ID or username) and Kick (username) lookups
async function fetch7TVChannelEmotes(channelName, channelId = null, platform = 'twitch') {
  try {
    let response, data, identifier

    if (platform === 'kick') {
      // Kick: 7TV requires numeric user ID, not slug — resolve via GQL search
      log(' 7TV: Fetching Kick channel emotes for:', channelName)
      // Accept channelId only when it looks like a numeric Kick user id — a slug
      // passed here would be cached and then cause 404s on every poll cycle.
      let kickId = channelId && /^\d+$/.test(String(channelId)) ? channelId : null
      if (!kickId) {
        try {
          const gqlResp = await fetchWithTimeout('https://7tv.io/v3/gql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `query { users(query: "${channelName.replace(/[^a-z0-9_-]/gi, '')}") { connections { platform id username } } }`,
            }),
          })
          if (gqlResp.ok) {
            const gqlData = await gqlResp.json()
            const users = gqlData?.data?.users || []
            for (const u of users) {
              const conn = u.connections?.find(
                (c) => c.platform === 'KICK' && c.username?.toLowerCase() === channelName.toLowerCase(),
              )
              // Validate that id is numeric — 7TV GQL id field is a string but must be
              // the Kick numeric user id; a slug here would cause 404s on every poll.
              if (conn && /^\d+$/.test(String(conn.id || ''))) {
                kickId = conn.id
                break
              }
            }
          }
        } catch (e) {
          log(' 7TV: GQL Kick lookup failed:', e.message)
        }
      }
      if (!kickId) {
        log(' 7TV: Could not resolve Kick user ID for', channelName)
        return null // transient: ID lookup failed
      }
      identifier = kickId
      // Cache the resolved numeric id so the 7TV poll can reuse it (the poll
      // only has the channel slug, and the kick endpoint rejects slugs).
      channelOwnerKickId.set(channelName.toLowerCase(), kickId)
      if (channelOwnerKickId.size > 500) channelOwnerKickId.delete(channelOwnerKickId.keys().next().value)
      response = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kickId}`)
      if (response.status === 404) {
        response.body?.cancel()
        return []
      } // genuine: user has no 7TV
      if (!response.ok) {
        response.body?.cancel()
        log(` 7TV: Kick lookup failed (${response.status})`)
        return null // transient: 5xx etc.
      }
      data = await response.json()
      log(' ✅ 7TV: Kick lookup succeeded (id:', `${kickId})`)
    } else if (platform === 'youtube') {
      // 7TV files YouTube accounts under the "google" platform slug (YouTube
      // sign-in is Google OAuth), keyed by the real UC... channel id — there is
      // no handle/username lookup on this endpoint. channelId must already be
      // a resolved UC id by the time we get here (fetchChannelOwnerEmotes
      // resolves it up front); if it isn't, we cannot safely identify the
      // channel, so return no emotes rather than guess or fall through to a
      // Twitch/username endpoint (that would be a cross-platform identity bleed).
      if (!/^UC[\w-]{20,}$/i.test(String(channelId || ''))) {
        log(' 7TV: No resolvable YouTube channel ID for', channelName, '- skipping (no cross-platform fallback)')
        return []
      }
      identifier = channelId
      log(' 7TV: Fetching YouTube channel emotes for:', channelName, '(id:', `${identifier})`)
      response = await fetchWithTimeout(`https://7tv.io/v3/users/google/${identifier}`, {}, 15000)
      if (response.status === 404) {
        response.body?.cancel()
        return [] // genuine: user has no 7TV
      }
      if (!response.ok) {
        response.body?.cancel()
        log(` 7TV: YouTube lookup failed (${response.status})`)
        return null // transient: 5xx etc.
      }
      data = await response.json()
      log(' ✅ 7TV: YouTube lookup succeeded (id:', `${identifier})`)
    } else {
      // Twitch: use channelId if available, otherwise lookup via GQL/first-party resolve
      identifier = channelId
      if (!identifier) {
        log(' 7TV: No channelId provided, looking up via lookupTwitchUserId...')
        identifier = await lookupTwitchUserId(channelName)
        if (identifier) {
          log(' 7TV: Got user ID:', identifier)
        }
      }

      // Final fallback to username (rarely works but try anyway)
      if (!identifier) {
        identifier = channelName
      }

      log(' 7TV: Fetching with identifier:', identifier, '(channelId:', channelId, ')')

      // Try Twitch ID lookup first — large channels (kripp, xqc) can be slow,
      // give 7TV 15s before timing out.
      const sevenTvUrl = `https://7tv.io/v3/users/twitch/${identifier}`
      response = await fetchWithTimeout(sevenTvUrl, {}, 15000)
      if (DEBUG)
        broadcastToTabs({ type: 'debug_log', msg: `7TV fetch ${channelName}: ${sevenTvUrl} → ${response.status}` })

      if (!response.ok) {
        const firstStatus = response.status
        response.body?.cancel()
        log(` 7TV: Twitch ID lookup failed (${firstStatus}), trying username fallback...`)

        // Fallback to username-based lookup
        response = await fetchWithTimeout(`https://7tv.io/v3/users/${channelName}`, {}, 15000)
        if (response.status === 404) {
          response.body?.cancel()
          // Both Twitch ID and username 404 = user genuinely has no 7TV account
          if (firstStatus === 404) return []
          return null // mixed: first was 5xx, second was 404 — treat as transient
        }
        if (!response.ok) {
          response.body?.cancel()
          log(` 7TV: Username lookup also failed (${response.status})`)
          return null // transient: 5xx etc.
        }

        data = await response.json()
        log(' ✅ 7TV: Username fallback succeeded!')
      } else {
        data = await response.json()
        log(' ✅ 7TV: Twitch ID lookup succeeded')
      }
    }

    const emoteSet = data.emote_set
    if (!emoteSet) {
      log(' 7TV: No emote set found for', identifier)
      return [] // genuine: user has no emote set
    }

    const emoteList = emoteSet.emotes || []
    log(' 7TV: Found', emoteList.length, 'emotes for', identifier, '(set ID:', `${emoteSet.id})`)

    const emotes = sanitizeEmoteList(
      emoteList.map((e) => ({
        name: e.name,
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        hash: e.id,
        flags: e.flags || e.data?.flags || 0,
        zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
        animated: !!e.data?.animated,
      })),
    )
    const cosmeticIds = extract7TVCosmeticIds(data)
    // Resolve cosmetics async — dont block emote return
    if (cosmeticIds && channelId) {
      resolve7TVCosmeticIds(cosmeticIds)
        .then((cosmetic) => {
          if (cosmetic) setUserCosmetic(String(channelId), cosmetic)
        })
        .catch(() => {})
    }
    return { emotes, setId: emoteSet.id }
  } catch (error) {
    // Aborts (timeouts) are expected for slow channels; demote to log so the
    // console isn't spammed with red errors during normal operation.
    const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '')
    if (isAbort) {
      log(' 7TV: timeout for', channelName, '(will retry on next fetch)')
    } else {
      console.error('[hs-bg] 7TV FETCH ERROR for', channelName, ':', error?.message || error)
    }
    if (DEBUG) broadcastToTabs({ type: 'debug_log', msg: `7TV ERROR ${channelName}: ${error?.message || error}` })
    return null // transient: network/timeout
  }
}

// Cache of resolved 7TV cosmetic objects by ID (paint_id/badge_id → full object)
const cosmeticObjectCache = new Map()

function extract7TVCosmeticIds(data) {
  const style = data?.user?.style || data?.style
  if (!style) return null
  // Old API returned full objects; new API returns IDs only
  if (style.paint || style.badge) return { paint: style.paint || null, badge: style.badge || null }
  const paintId = style.paint_id || null
  const badgeId = style.badge_id || null
  if (!paintId && !badgeId) return null
  return { paintId, badgeId }
}

async function resolve7TVCosmeticIds(ids) {
  if (!ids) return null
  // Already resolved (old API format)
  if (ids.paint !== undefined && ids.badge !== undefined && !ids.paintId) return ids

  const toFetch = []
  const result = { paint: null, badge: null }

  // Check cache first
  if (ids.paintId) {
    const cached = cosmeticObjectCache.get(ids.paintId)
    if (cached) {
      // Move to end for LRU ordering
      cosmeticObjectCache.delete(ids.paintId)
      cosmeticObjectCache.set(ids.paintId, cached)
      result.paint = cached
    } else {
      toFetch.push(ids.paintId)
    }
  }
  if (ids.badgeId) {
    const cached = cosmeticObjectCache.get(ids.badgeId)
    if (cached) {
      // Move to end for LRU ordering
      cosmeticObjectCache.delete(ids.badgeId)
      cosmeticObjectCache.set(ids.badgeId, cached)
      result.badge = cached
    } else {
      toFetch.push(ids.badgeId)
    }
  }
  if (toFetch.length === 0) return result

  try {
    const query = `query($list:[ObjectID!]){cosmetics(list:$list){paints{id name function color stops{at color}angle shape image_url repeat shadows{x_offset y_offset radius color}}badges{id name tooltip tag host{url files{name format width height}}}}}`
    const resp = await fetchWithTimeout('https://7tv.io/v3/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { list: toFetch } }),
    })
    if (!resp.ok) return result
    const data = await resp.json()
    const paints = data?.data?.cosmetics?.paints || []
    const badges = data?.data?.cosmetics?.badges || []
    for (const p of paints) {
      cosmeticObjectCache.set(p.id, p)
      if (p.id === ids.paintId) result.paint = p
    }
    for (const b of badges) {
      cosmeticObjectCache.set(b.id, b)
      if (b.id === ids.badgeId) result.badge = b
    }
    // Cap cache
    if (cosmeticObjectCache.size > 200) {
      let count = 0
      for (const key of cosmeticObjectCache.keys()) {
        if (count++ >= 50) break
        cosmeticObjectCache.delete(key)
      }
    }
  } catch (e) {
    log(' resolve7TVCosmeticIds failed:', e?.message)
  }
  return result
}

let cosmeticsSaveTimer = null
let cosmeticsLastFlushAt = 0
const COSMETICS_STORAGE_MAX = USER_COSMETICS_MAX // match in-memory cap so eviction doesn't lose data
const COSMETICS_FORCE_FLUSH_INTERVAL = 30000 // when at-cap, flush at most every 30s

function flushCosmeticsToStorage() {
  cosmeticsLastFlushAt = Date.now()
  const entries = [...userCosmeticsCache.entries()]
    // Persist only positive results — never negatives. A blank entry that
    // survives a restart re-serves "no cosmetics" for users who actually have
    // them; they're cheap to recheck, so let restart re-resolve them fresh.
    .filter(([, v]) => (v.paint || v.badge) && Date.now() - v.fetchedAt < USER_COSMETICS_TTL)
    .slice(-COSMETICS_STORAGE_MAX)
  browser.storage.local
    .set({
      // Persist twitchId so Kick→Twitch ID linkage survives SW restart;
      // otherwise BTTV/FFZ badge lookup falls back to no-op until the 30min
      // TTL forces a refetch from 7TV.
      user_cosmetics_cache: entries.map(([k, v]) => [
        k,
        { paint: v.paint, badge: v.badge, twitchId: v.twitchId, fetchedAt: v.fetchedAt },
      ]),
    })
    .catch(() => {})
}

function debounceSaveCosmetics() {
  if (cosmeticsSaveTimer) clearTimeout(cosmeticsSaveTimer)
  cosmeticsSaveTimer = setTimeout(() => {
    cosmeticsSaveTimer = null
    flushCosmeticsToStorage()
  }, 5000)
}

function setUserCosmetic(twitchId, cosmetic) {
  if (userCosmeticsCache.size >= USER_COSMETICS_MAX) {
    userCosmeticsCache.delete(userCosmeticsCache.keys().next().value)
    // At-cap path: flush immediately (rate-limited) so eviction can't lose data
    // before the 5s debounce fires.
    if (Date.now() - cosmeticsLastFlushAt > COSMETICS_FORCE_FLUSH_INTERVAL) {
      if (cosmeticsSaveTimer) {
        clearTimeout(cosmeticsSaveTimer)
        cosmeticsSaveTimer = null
      }
      userCosmeticsCache.set(twitchId, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: Date.now() })
      flushCosmeticsToStorage()
      return
    }
  }
  userCosmeticsCache.set(twitchId, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: Date.now() })
  debounceSaveCosmetics()
}

function setPaintCache(twitchId, spec, color = null, plus = null) {
  if (_paintsCache.size >= PAINTS_CACHE_MAX) {
    _paintsCache.delete(_paintsCache.keys().next().value)
  }
  // color = the user's picked name colour (users.color); plus = their ISO
  // plus_since (active HeatSync Plus tenure) — both ride the same
  // /api/paints response, cached alongside the spec so the fetch_paints reply
  // can return parallel colors/plus maps without a second request/inflight chain.
  _paintsCache.set(twitchId, { spec: spec ?? null, color: color ?? null, plus: plus ?? null, fetchedAt: Date.now() })
}

async function fetchBulkBadges() {
  const mapsPopulated = ffzBadgeMap.size > 0 || bttvBadgeMap.size > 0 || chatterinoBadgeMap.size > 0
  if (mapsPopulated && Date.now() - badgesFetchedAt < BADGES_TTL) return
  badgesFetchedAt = Date.now()
  try {
    const [bttvResp, ffzResp, chatterinoResp] = await Promise.allSettled([
      fetchWithTimeout('https://api.betterttv.net/3/cached/badges'),
      fetchWithTimeout('https://api.frankerfacez.com/v1/badges/ids'),
      fetchWithTimeout('https://heatsync.org/api/chatterino-badges'),
    ])
    if (bttvResp.status === 'fulfilled' && bttvResp.value.ok) {
      const data = await bttvResp.value.json()
      bttvBadgeMap.clear()
      for (const entry of data) {
        let url = entry.badge?.svg || entry.badge?.png
        if (url && !url.startsWith('https://')) url = url.startsWith('//') ? `https:${url}` : null
        if (entry.providerId && url) {
          bttvBadgeMap.set(entry.providerId, { description: entry.badge.description || 'BTTV', url })
        }
      }
      log(' BTTV badges loaded:', bttvBadgeMap.size)
    }
    if (ffzResp.status === 'fulfilled' && ffzResp.value.ok) {
      const data = await ffzResp.value.json()
      ffzBadgeMap.clear()
      const badgeById = {}
      for (const b of data.badges || []) badgeById[b.id] = b
      const users = data.users || {}
      for (const [badgeId, userIds] of Object.entries(users)) {
        const badge = badgeById[badgeId]
        if (!badge) continue
        const url = badge.urls?.['2'] || badge.urls?.['1'] || badge.urls?.['4']
        if (!url) continue
        const normalizedUrl = url.startsWith('//') ? `https:${url}` : url
        if (!/^https:\/\//.test(normalizedUrl)) continue
        const normalized = { title: badge.title || 'FFZ', color: badge.color || null, url: normalizedUrl }
        for (const uid of userIds) {
          const uidStr = String(uid)
          if (!ffzBadgeMap.has(uidStr)) ffzBadgeMap.set(uidStr, [])
          ffzBadgeMap.get(uidStr).push(normalized)
        }
      }
      log(' FFZ badges loaded:', ffzBadgeMap.size, 'users')
    }
    if (chatterinoResp.status === 'fulfilled' && chatterinoResp.value.ok) {
      const data = await chatterinoResp.value.json()
      chatterinoBadgeMap.clear()
      for (const badge of data.badges || []) {
        const url = badge.image2 || badge.image1
        if (!url || !badge.users || !/^https:\/\//.test(url)) continue
        for (const uid of badge.users) {
          chatterinoBadgeMap.set(String(uid), { tooltip: badge.tooltip || 'Chatterino', url })
        }
      }
      log(' Chatterino badges loaded:', chatterinoBadgeMap.size, 'users')
    }
    broadcastBadgeMaps()
    // Persist badge maps + timestamp so they survive MV3 service worker restarts
    const bttvObj = {}
    for (const [k, v] of bttvBadgeMap) bttvObj[k] = v
    const ffzObj = {}
    for (const [k, v] of ffzBadgeMap) ffzObj[k] = v
    const chatterinoObj = {}
    for (const [k, v] of chatterinoBadgeMap) chatterinoObj[k] = v
    browser.storage.local
      .set({
        badges_fetched_at: badgesFetchedAt,
        bttv_badge_map: bttvObj,
        ffz_badge_map: ffzObj,
        chatterino_badge_map: chatterinoObj,
      })
      .catch(() => {})
  } catch (e) {
    log(' fetchBulkBadges failed:', e.message)
    badgesFetchedAt = 0
  }
}

function broadcastBadgeMaps() {
  const bttvObj = {}
  for (const [k, v] of bttvBadgeMap) bttvObj[k] = v
  const ffzObj = {}
  for (const [k, v] of ffzBadgeMap) ffzObj[k] = v
  const chatterinoObj = {}
  for (const [k, v] of chatterinoBadgeMap) chatterinoObj[k] = v
  broadcastToTabs({ type: 'cosmetics_update', bttvBadges: bttvObj, ffzBadges: ffzObj, chatterinoBadges: chatterinoObj })
}

// Fetch channel owner's emotes (public API) + third-party channel emotes
async function fetchChannelOwnerEmotes(channelName, channelId = null, platform = 'twitch') {
  const key = chKey(platform, channelName)
  // Skip if already fetched, or currently loading (sentinel prevents race)
  const cached = channelEmotesMap[key]
  // Kept for the failure path: a failed refetch falls back to this instead of
  // erasing the channel's emotes (stale beats missing).
  const prevCached = Array.isArray(cached) ? cached : null
  if (cached === 'loading') {
    log(' Channel emotes currently loading for', channelName, '- skipping')
    return
  }
  if (Array.isArray(cached)) {
    const age = Date.now() - (channelEmotesFetchedAt[key] || 0)
    const ttl = cached.length > 0 ? CHANNEL_EMOTES_TTL : CHANNEL_EMOTES_EMPTY_TTL
    // Always broadcast cached data immediately — content script needs emotes NOW
    broadcastToTabs({ type: 'channel_emotes_update', emotes: cached, channelOwner: channelName, platform })
    if (age < ttl) {
      log(
        ' Channel emotes already fetched for',
        channelName,
        '- skipping (',
        cached.length,
        'emotes,',
        `${Math.round(age / 1000)}s old)`,
      )
      return
    }
    log(' Channel emotes stale for', channelName, '(', `${Math.round(age / 1000)}s) - refetching in background`)
  }
  channelEmotesMap[key] = 'loading'

  try {
    log(' 📺 Fetching channel emotes for:', channelName, 'id:', channelId, 'platform:', platform)

    // Show loading indicator
    broadcastToTabs({ type: 'loading_status', text: 'loading channel emotes...' })

    // Fetch heatsync emotes + resolve the platform channel ID in PARALLEL (both
    // needed before third-party fetch). IMPORTANT: each platform resolves its
    // OWN identity system here — a Twitch username must never be looked up via
    // lookupTwitchUserId for a Kick/YouTube channelName, that's a cross-platform
    // identity bleed (wrong user's emotes/cosmetics attached to this channel).
    const [heatsyncResult, resolvedChannelId] = await Promise.all([
      fetchWithTimeout(withNsfwParam(`${API_URL}/api/emotes/user/${encodeURIComponent(channelName)}`)).catch(
        () => null,
      ),
      platform === 'twitch' && !channelId
        ? lookupTwitchUserId(channelName)
        : platform === 'youtube' && !/^UC[\w-]{20,}$/i.test(String(channelId || ''))
          ? resolveYtChannelId(channelName, channelId)
          : Promise.resolve(channelId),
    ])
    let heatsyncEmotes = []
    if (heatsyncResult?.status === 429) {
      // Heatsync API rate-limited — skip the heatsync emote slot but DO NOT
      // bail the whole fetch. BTTV/FFZ/7TV/Twitch are independent providers;
      // a heatsync 429 should never starve the channel of its third-party
      // emote set. (Pre-fix this returned, leaving the cache empty until next
      // manual join — channels would silently lose all 7TV emotes.)
      console.warn(
        '[heatsync] fetchChannelOwnerEmotes: heatsync 429 for',
        channelName,
        '— continuing third-party fetch',
      )
      heatsyncResult.body?.cancel()
      // heatsyncEmotes stays [] (default); flow continues to third-party tasks
    } else if (heatsyncResult?.ok) {
      const data = await heatsyncResult.json()
      heatsyncEmotes = (data.emotes || []).map((e) => ({
        name: e.name,
        url: absUrl(e.url),
        hash: e.hash || e.name,
        provider: e.provider || 'upload',
      }))
    }
    channelId = resolvedChannelId

    // Fetch third-party emotes in PARALLEL — broadcast progressively as each provider
    // returns so the user sees BTTV/FFZ instantly while 7TV resolves (avoids "no emotes
    // until everything's done"). Keep slots fixed so priority order is stable.
    broadcastToTabs({ type: 'loading_status', text: 'fetching third-party emotes...' })
    const slots = { bttv: [], ffz: [], sevenTV: [], twitch: [], kick: [] }
    const failed = { bttv: false, ffz: false, sevenTV: false, twitch: false, kick: false }
    let sevenTVResult = null
    let coalesceTimer = null
    // Refresh-class fetch (an existing non-empty set is being revalidated —
    // the 30min TTL or a post-SW-restart pass): suppress the per-provider
    // partial broadcasts and ship ONLY the final consolidated set. The
    // tab-side cache rebuilds from each payload as if it were complete, so a
    // BTTV-only partial wiped the other providers' entries and made them look
    // brand-new on the next partial — false hadAdds → full-row reprocess →
    // the "random ~30min full-panel flash". Cold joins keep the progressive
    // paints: nothing is rendered yet, so there is nothing to flash.
    const isRefresh = Array.isArray(prevCached) && prevCached.length > 0
    const broadcastCurrent = () => {
      if (isRefresh) return
      clearTimeout(coalesceTimer)
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        const partial = [
          ...heatsyncEmotes,
          ...slots.bttv,
          ...slots.ffz,
          ...slots.sevenTV,
          ...slots.twitch,
          ...slots.kick,
        ]
        broadcastToTabs({ type: 'channel_emotes_update', emotes: partial, channelOwner: channelName, platform })
      }, 40)
    }

    const tasks = []
    if (platform === 'twitch') {
      tasks.push(
        fetchBTTVChannelEmotes(channelName, channelId, platform)
          .then((e) => {
            if (e === null) failed.bttv = true
            slots.bttv = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.bttv = true
          }),
      )
      tasks.push(
        fetchFFZChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.ffz = true
            slots.ffz = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.ffz = true
          }),
      )
      tasks.push(
        fetchTwitchChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.twitch = true
            slots.twitch = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.twitch = true
          }),
      )
    } else if (platform === 'kick') {
      // No BTTV/FFZ for Kick (neither provider supports it). Kick-native
      // channel + Global emotes join the same pool Twitch-native does.
      tasks.push(
        fetchKickChannelEmotes(channelName)
          .then((e) => {
            if (e === null) failed.kick = true
            slots.kick = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.kick = true
          }),
      )
    } else if (platform === 'youtube') {
      // No FFZ (no YouTube support) and no Twitch-native calls — those would
      // treat a YouTube handle/id as a Twitch identity.
      tasks.push(
        fetchBTTVChannelEmotes(channelName, channelId, platform)
          .then((e) => {
            if (e === null) failed.bttv = true
            slots.bttv = e || []
            broadcastCurrent()
          })
          .catch(() => {
            failed.bttv = true
          }),
      )
    }
    tasks.push(
      fetch7TVChannelEmotes(channelName, channelId, platform)
        .then((r) => {
          if (r === null) {
            failed.sevenTV = true
            slots.sevenTV = []
            broadcastCurrent()
            return
          }
          sevenTVResult = r
          slots.sevenTV = r?.emotes || (Array.isArray(r) ? r : []) || []
          broadcastCurrent()
        })
        .catch(() => {
          failed.sevenTV = true
        }),
    )

    await Promise.all(tasks)
    // Final consolidated broadcast (force-flush any pending coalesce)
    if (coalesceTimer) {
      clearTimeout(coalesceTimer)
      coalesceTimer = null
    }
    // Per-provider stale salvage — a transient provider failure during a
    // REFRESH must not strip that provider's emotes from the consolidated
    // set: an idle tab never re-joins, so the ~60s backdated retry only
    // fires on the next manual join and the loss sticks — the recurring
    // "emotes turned to text mid-session" report (7tv.io latency spikes past
    // the fetch timeout are the usual trigger). Stale beats missing, per
    // provider — same philosophy as the whole-fetch fallback in the catch
    // below. Third-party entries carry `source`; heatsync entries don't.
    if (isRefresh) {
      const SALVAGE = { bttv: 'bttv', ffz: 'ffz', sevenTV: '7tv', twitch: 'twitch', kick: 'kick' }
      for (const [slot, src] of Object.entries(SALVAGE)) {
        if (failed[slot] && slots[slot].length === 0) {
          slots[slot] = prevCached.filter((e) => e && e.source === src)
          if (slots[slot].length) log(` ♻️ ${src} refetch failed — keeping ${slots[slot].length} stale entries`)
        }
      }
      if (!heatsyncResult?.ok && heatsyncEmotes.length === 0) {
        heatsyncEmotes = prevCached.filter((e) => e && !e.source)
        if (heatsyncEmotes.length) log(` ♻️ heatsync refetch failed — keeping ${heatsyncEmotes.length} stale entries`)
      }
    }
    const sevenTVEmotes = slots.sevenTV
    const sevenTVSetId = sevenTVResult?.setId || null
    const bttvEmotes = slots.bttv
    const ffzEmotes = slots.ffz
    const twitchChannelEmotes = slots.twitch
    const kickChannelEmotes = slots.kick
    if (DEBUG)
      broadcastToTabs({
        type: 'debug_log',
        msg: `${channelName} BTTV:${bttvEmotes.length} FFZ:${ffzEmotes.length} 7TV:${sevenTVEmotes.length} Twitch:${twitchChannelEmotes.length} Kick:${kickChannelEmotes.length} HS:${heatsyncEmotes.length}`,
      })

    // Store emotes for this specific channel (prune old entries to bound memory)
    const emotes = [
      ...heatsyncEmotes,
      ...bttvEmotes,
      ...ffzEmotes,
      ...sevenTVEmotes,
      ...twitchChannelEmotes,
      ...kickChannelEmotes,
    ]
    const anyFailed = failed.bttv || failed.ffz || failed.sevenTV || failed.twitch || failed.kick
    channelEmotesMap[key] = emotes
    // If any provider had a transient failure, backdate fetchedAt so the next
    // channel join refetches within ~60s (regardless of empty/non-empty TTL).
    channelEmotesFetchedAt[key] = anyFailed ? Date.now() - CHANNEL_EMOTES_TTL + 60000 : Date.now()
    if (anyFailed) {
      log(' ⚠️ Channel emotes fetched with failures', failed, '— will retry in ~90s')
      scheduleEmoteRefetch()
    }
    const channelKeys = Object.keys(channelEmotesMap).filter((k) => channelEmotesMap[k] !== 'loading')
    if (channelKeys.length > 20) {
      for (const old of channelKeys.slice(0, channelKeys.length - 20)) {
        if (old !== key) {
          delete channelEmotesMap[old]
          delete channelEmotesFetchedAt[old]
          const evictedSetId = seventvEmoteSetIds.get(old)
          seventvEmoteSetIds.delete(old)
          release7TVEmoteSet(evictedSetId)
          seventvPolledChannels.delete(old)
        }
      }
    }

    // Update channelOwner in all tab entries that match this channel
    let ownerUpdated = false
    for (const [_tabId, entry] of tabChannels) {
      if (entry.channel?.endsWith(`/${channelName}`)) {
        entry.channelOwner = channelName
        ownerUpdated = true
      }
    }
    if (ownerUpdated) saveTabChannels()
    log(
      ' ✅ Channel emotes loaded for',
      `${channelName}:`,
      emotes.length,
      `(heatsync: ${heatsyncEmotes.length}, bttv: ${bttvEmotes.length}, ffz: ${ffzEmotes.length}, 7tv: ${sevenTVEmotes.length}, twitch: ${twitchChannelEmotes.length}, kick: ${kickChannelEmotes.length})`,
    )

    // Hide loading indicator
    broadcastToTabs({ type: 'loading_status', done: true })

    // Broadcast to content scripts (include channel owner name for filtering)
    broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: channelName, platform })

    // Save per-channel map to storage for persistence (filter out 'loading' sentinels)
    await browser.storage.local.set({
      channel_emotes_map: getStorableChannelEmotes(),
      channel_emotes_fetched_at: channelEmotesFetchedAt,
    })

    // Store 7TV set ID per channel and subscribe on shared EventAPI connection
    if (sevenTVSetId) {
      seventvEmoteSetIds.set(key, sevenTVSetId)
      subscribe7TVEmoteSet(sevenTVSetId)
      start7TVPolling()
      // Persist so all channels survive service worker restart
      browser.storage.local.set({ seventv_emote_set_ids: Object.fromEntries(seventvEmoteSetIds) }).catch(() => {})
    }
  } catch (error) {
    log(' ❌ Channel emotes fetch failed:', error.message || error)
    broadcastToTabs({ type: 'loading_status', done: true })
    // A failed REFETCH must fall back to the stale copy, not erase it — the
    // old `delete` here threw away a restored cache on one transient 7TV/BTTV
    // flake during the post-reload herd, leaving the channel emote-less for
    // the whole session (and the deletion persisted on the next storage
    // write). Stale emotes render; missing emotes don't. fetchedAt stays old,
    // so the next join retries the refresh.
    if (Array.isArray(prevCached)) {
      channelEmotesMap[key] = prevCached
      broadcastToTabs({ type: 'channel_emotes_update', emotes: prevCached, channelOwner: channelName, platform })
    } else {
      // Nothing to fall back to — clear the sentinel so the next join retries.
      delete channelEmotesMap[key]
    }
    // Keep any existing 7TV set mapping + subscription: the set still exists
    // server-side, so live pushes keep flowing against the stale list, and the
    // retry alarm reconciles the set id on the next successful fetch. Deleting
    // it here orphaned the channel from BOTH the EventAPI and the fallback
    // poll (which iterates seventvEmoteSetIds) — a silent permanent blackout.
    scheduleEmoteRefetch()
  }
}

// One-shot retry alarm for failed channel-emote fetches. chrome.alarms
// survives SW eviction (a bare setTimeout dies with the worker). Re-arming on
// every failure just pushes the retry out — fine, it stays one-shot.
function scheduleEmoteRefetch() {
  browser.alarms?.create?.('hs-emote-refetch', { delayInMinutes: 1.5 })
}

// Fetch BTTV global emotes
async function fetchBTTVEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.betterttv.net/3/cached/emotes/global')
    if (!response.ok) {
      response.body?.cancel()
      return []
    }

    const emotes = await response.json()
    return sanitizeEmoteList(
      emotes.map((e) => ({
        name: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
        source: 'bttv',
        hash: e.id,
        os: bttvOversize(e),
      })),
    )
  } catch (_error) {
    return []
  }
}

// Fetch FFZ global emotes
async function fetchFFZEmotes() {
  try {
    const response = await fetchWithTimeout('https://api.frankerfacez.com/v1/set/global')
    if (!response.ok) {
      response.body?.cancel()
      return []
    }

    const data = await response.json()
    const emotes = []

    const defaultSets = data?.default_sets || []
    for (const set of Object.values(data?.sets || {})) {
      if (defaultSets.includes(set.id)) {
        for (const emote of set.emoticons || []) {
          // Skip FFZ modifier emotes — see fetchFFZChannelEmotes. They're typed
          // tokens (modifiers.js), not pool images.
          if (emote.modifier) continue
          // FFZ exposes animated emotes under emote.animated (animated webp);
          // emote.urls is the static PNG first-frame. Prefer animated when present.
          const srcs = emote.animated || emote.urls
          if (!srcs) continue
          const rawUrl = srcs['1'] || srcs['2'] || srcs['4']
          if (!rawUrl) continue
          emotes.push({
            name: emote.name,
            url: rawUrl.startsWith('https:') ? rawUrl : `https:${rawUrl}`,
            source: 'ffz',
            hash: `ffz-${emote.id}`,
          })
        }
      }
    }

    return sanitizeEmoteList(emotes)
  } catch (_error) {
    return []
  }
}

// Fetch 7TV global emotes — uses ETag conditional GET so 7TV can answer 304
// when their global set hasn't changed (saves them ~30KB payload per check).
// On 304 we reuse the previously parsed list from chrome.storage.local.
const GLOBAL_7TV_CACHE_KEY = 'hs_7tv_global_cache'
async function fetch7TVEmotes() {
  try {
    const response = await fetchWithEtag('https://7tv.io/v3/emote-sets/global')
    if (response.notModified) {
      const got = await browser.storage.local.get(GLOBAL_7TV_CACHE_KEY)
      return Array.isArray(got[GLOBAL_7TV_CACHE_KEY]) ? got[GLOBAL_7TV_CACHE_KEY] : []
    }
    if (!response.ok) {
      response.body?.cancel?.()
      return []
    }

    const data = await response.json()
    const emotes = sanitizeEmoteList(
      (data?.emotes || []).map((e) => ({
        name: e.name,
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        hash: e.id,
        animated: !!e.data?.animated,
        flags: e.flags || e.data?.flags || 0,
        zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
      })),
    )
    try {
      await browser.storage.local.set({ [GLOBAL_7TV_CACHE_KEY]: emotes })
    } catch {}
    return emotes
  } catch (_error) {
    return []
  }
}

// Fetch Twitch native global emotes (Kappa, PogChamp, etc.)
async function fetchTwitchGlobalEmotes() {
  try {
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/twitch/global`)
    if (!response.ok) {
      response.body?.cancel()
      log('⚠️ Twitch global emotes failed:', response.status)
      return []
    }

    const data = await response.json()
    const emotes = (data?.emotes || []).map((e) => ({
      name: e.name,
      url: e.url,
      url_2x: e.url_2x,
      url_4x: e.url_4x,
      source: 'twitch',
      hash: e.id,
    }))

    const validated = sanitizeEmoteList(emotes)
    log('✅ Loaded', validated.length, 'Twitch global emotes from server')
    return validated
  } catch (error) {
    log('❌ Twitch global emotes error:', error)
    return []
  }
}

// Fetch Twitch channel emotes (subscriber, follower, bits tier)
async function fetchTwitchChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`${API_URL}/api/emotes/twitch/channel/${channelName}`)
    if (response.status === 404) {
      response.body?.cancel()
      return []
    } // genuine: channel has no twitch emotes
    if (!response.ok) {
      response.body?.cancel()
      log(' Twitch channel emotes failed for', channelName, ':', response.status)
      return null // transient: 5xx etc.
    }

    const data = await response.json()
    log(' Loaded', data.count, 'Twitch channel emotes for', channelName)

    return sanitizeEmoteList(
      (data?.emotes || []).map((e) => ({
        name: e.name,
        url: e.url,
        source: 'twitch',
        hash: e.id,
        url_2x: e.url_2x,
        url_4x: e.url_4x,
        tier: e.tier,
        emote_type: e.emote_type,
      })),
    )
  } catch (error) {
    log(' Twitch channel emotes error for', channelName, ':', error?.message)
    return null // transient
  }
}

// Fetch Kick channel-native emotes: the channel's own set + Kick's Global
// set (Kick has no separate global-emote fetch cycle anywhere in this
// codebase, so folding Global in here is the only way viewers ever see it —
// same call already merges BTTV's channelEmotes+sharedEmotes above). The
// "Emojis" set is Kick's built-in unicode-emoji reskin, not a real emote
// provider — skipped like every other provider skips emoji.
// Direct BG fetch, no tab relay: this is a public GET, same as
// resolveKickChannelIdBg/kick_channel_badges above — Cloudflare only gates
// credentialed kick.com mutations (those go through a kick.com tab for
// session cookies), not public reads from the service worker.
async function fetchKickChannelEmotes(channelName) {
  try {
    const response = await fetchWithTimeout(`https://kick.com/emotes/${encodeURIComponent(channelName)}`)
    if (response.status === 404) {
      response.body?.cancel()
      return [] // genuine: channel has no Kick emote sets
    }
    if (!response.ok) {
      response.body?.cancel()
      log(' Kick channel emotes failed for', channelName, ':', response.status)
      return null // transient: 5xx etc.
    }

    const data = await response.json()
    if (!Array.isArray(data)) return []

    const out = []
    for (const set of data) {
      if (set?.name === 'Emojis') continue
      for (const e of set?.emotes || []) {
        if (!e?.id || !e?.name) continue
        out.push({
          name: e.name,
          url: `https://files.kick.com/emotes/${e.id}/fullsize`,
          source: 'kick',
          hash: String(e.id),
          // Carried through so the client-side pool build can exclude these
          // the same way it excludes tier-gated Twitch emotes — mirrors
          // fetchTwitchChannelEmotes's tier/emote_type fields above.
          subscribersOnly: !!e.subscribers_only,
        })
      }
    }
    log(' Loaded', out.length, 'Kick channel emotes for', channelName)
    return sanitizeEmoteList(out)
  } catch (error) {
    log(' Kick channel emotes error for', channelName, ':', error?.message)
    return null // transient
  }
}

function fetchGlobalEmotes() {
  if (globalEmotesFetchPromise) return globalEmotesFetchPromise
  globalEmotesFetchPromise = (async () => {
    try {
      log(' Fetching global emotes from', `${API_URL}/api/emotes`)
      // Try server API first (has all providers cached)
      const response = await fetchWithTimeout(withNsfwParam(`${API_URL}/api/emotes`))
      log(' Global emotes response:', response.status, response.ok)
      if (response.ok) {
        const data = await response.json()
        globalEmotes = sanitizeEmoteList(
          (data?.emotes || []).map((e) => ({
            name: e.name,
            url: e.url,
            source: e.provider,
            hash: e.hash,
            zeroWidth: !!e.zeroWidth,
            os: e.os > 1 ? Math.min(2, +e.os) : undefined,
          })),
        )
        log(' Loaded', globalEmotes.length, 'global emotes from server')
        log(
          ' Sample global emotes:',
          globalEmotes.slice(0, 5).map((e) => e.name),
        )

        // ALWAYS fetch Twitch + 7TV global emotes separately (server cache may be stale)
        log('📥 Fetching Twitch + 7TV globals separately...')
        const [twitchGlobals, seventvGlobals] = await Promise.all([fetchTwitchGlobalEmotes(), fetch7TVEmotes()])

        // Rebuild merged array (prevents duplicate accumulation on reconnects)
        // 7TV globals override server emotes (server cache lacks zeroWidth flags)
        const seen = new Set()
        const merged = []
        // 7TV first (has authoritative zeroWidth flags), then Twitch, then server emotes
        for (const e of seventvGlobals) {
          if (!seen.has(e.name)) {
            seen.add(e.name)
            merged.push(e)
          }
        }
        for (const e of twitchGlobals) {
          if (!seen.has(e.name)) {
            seen.add(e.name)
            merged.push(e)
          }
        }
        for (const e of globalEmotes) {
          if (!seen.has(e.name)) {
            seen.add(e.name)
            merged.push(e)
          }
        }
        globalEmotes = merged
        log(
          '✅ Merged globals:',
          globalEmotes.length,
          '(twitch:',
          twitchGlobals.length,
          '7tv:',
          seventvGlobals.length,
          ')',
        )

        log('📊 Total global emotes:', globalEmotes.length)

        broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes })
        return
      }
      log(' Server API failed, trying fallback')

      // Fallback: fetch directly from APIs
      const [bttv, ffz, sevenTV, twitchGlobal] = await Promise.all([
        fetchBTTVEmotes(),
        fetchFFZEmotes(),
        fetch7TVEmotes(),
        fetchTwitchGlobalEmotes(),
      ])

      globalEmotes = [...bttv, ...ffz, ...sevenTV, ...twitchGlobal]
      log(' Loaded', globalEmotes.length, 'global emotes (fallback)')
      broadcastToTabs({ type: 'global_emotes_update', emotes: globalEmotes })
    } catch (error) {
      console.error('[heatsync] fetchGlobalEmotes failed:', error.message || error)
    } finally {
      globalEmotesFetchPromise = null
    }
  })()
  return globalEmotesFetchPromise
}

// ========== 7TV EventAPI WebSocket for Real-Time Emote Updates ==========
// Single shared connection, multiple subscriptions (one per channel's emote set).
// 7TV allows up to 500 subs per connection.
let seventvWebSocket = null
let seventvReconnectAttempts = 0
let seventvReconnectTimer = null
let seventvLastData = 0
let seventvZombieTimer = null
const seventvSubscribedSets = new Set() // Track which set IDs we've subscribed to
const seventvPendingSubs = new Set() // Queued while connection is opening
const SEVENTV_MAX_RECONNECT_ATTEMPTS = 5
// The Hello payload states how many subscriptions this connection may hold.
// Unknown until it lands, then honored for both set and user subscriptions.
let seventvSubLimit = Infinity
// Idle disconnect: the socket only carries emote/cosmetic deltas for open
// platform tabs — at zero tabs every event is discarded work, so we close
// after a short grace and reconnect when a tab returns (subs replay on open).
let seventvIdleClosed = false
let seventvIdleTimer = null
const SEVENTV_IDLE_GRACE_MS = 5000
const SEVENTV_PLATFORM_URLS = ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*', '*://*.heatsync.org/*']

function ensure7TVConnection() {
  if (seventvWebSocket && seventvWebSocket.readyState !== WebSocket.CLOSED) {
    return // Already connected, connecting, or closing
  }
  // Any explicit connect intent (subscribe from a live tab, watchdog revive)
  // ends the idle state — only the automatic paths honor it.
  seventvIdleClosed = false

  clearTimeout(seventvReconnectTimer)
  seventvReconnectTimer = null
  seventvSubscribedSets.clear()
  // Drop any stale handler refs from a prior socket before creating a new one
  if (seventvWebSocket) {
    try {
      seventvWebSocket.onopen = null
      seventvWebSocket.onmessage = null
      seventvWebSocket.onerror = null
      seventvWebSocket.onclose = null
    } catch {}
    seventvWebSocket = null
  }
  if (seventvZombieTimer) {
    untrackInterval(seventvZombieTimer)
    seventvZombieTimer = null
  }

  log(' 7TV EventAPI: Connecting...')

  try {
    seventvWebSocket = new WebSocket('wss://events.7tv.io/v3')

    seventvWebSocket.onopen = () => {
      log(' 7TV EventAPI: Connected')
      seventvReconnectAttempts = 0
      seventvLastData = Date.now()
      // Zombie detection: force close if no data for 3 minutes
      if (seventvZombieTimer) {
        untrackInterval(seventvZombieTimer)
        seventvZombieTimer = null
      }
      seventvZombieTimer = trackInterval(
        setInterval(() => {
          if (seventvLastData && Date.now() - seventvLastData > 180000) {
            log(' 7TV EventAPI: Zombie detected, forcing reconnect')
            if (seventvWebSocket) {
              try {
                seventvWebSocket.close()
              } catch {}
            }
            if (seventvZombieTimer) {
              untrackInterval(seventvZombieTimer)
              seventvZombieTimer = null
            }
          }
        }, 60000),
      )

      // Subscribe all pending emote sets
      for (const setId of seventvPendingSubs) {
        send7TVSubscribe(setId)
      }
      seventvPendingSubs.clear()
      // Re-subscribe all known user cosmetic subs on (re)connect
      seventvUserSubs.clear()
      for (const userId of pendingUserSubs) {
        send7TVUserSubscribe(userId)
      }
      pendingUserSubs.clear()
      for (const userId of seventvToTwitchId.keys()) {
        send7TVUserSubscribe(userId)
      }
    }

    seventvWebSocket.onmessage = (event) => {
      seventvLastData = Date.now()
      try {
        const message = JSON.parse(event.data)

        if (message.op === 0) {
          // Dispatch event
          const eventData = message.d
          if (!eventData) return
          log(' 7TV EventAPI: Received event:', eventData.type)
          if (eventData.type === 'emote_set.update') {
            handle7TVEmoteSetUpdate(eventData.body)
          } else if (
            eventData.type === 'user.update' ||
            eventData.type === 'user.create' ||
            eventData.type === 'cosmetic.create' ||
            eventData.type === 'entitlement.create' ||
            eventData.type === 'entitlement.delete'
          ) {
            // User's cosmetics changed (badge/paint granted/revoked).
            // Bust the cache for that user so next lookup refetches fresh.
            handle7TVUserUpdate(eventData.body)
            // EMOTE_SET entitlements carry the chatter's PERSONAL set
            if (eventData.type === 'entitlement.create') capture7TVPersonalEntitlement(eventData.body)
          }
        } else if (message.op === 1) {
          if (message.d?.subscription_limit > 0) seventvSubLimit = message.d.subscription_limit
          log(' 7TV EventAPI: Hello received, session:', message.d.session_id)
        } else if (message.op === 2) {
          // Server heartbeat — no response needed
        } else if (message.op === 5) {
          const subType = message.d?.data?.type
          const subId = message.d?.data?.condition?.object_id
          log(' 7TV EventAPI: Subscription acknowledged:', subType, 'for', subId?.slice(0, 12))
        }
      } catch (err) {
        console.error('[heatsync] 7TV EventAPI: Parse error:', err)
      }
    }

    seventvWebSocket.onerror = () => {
      log(' 7TV EventAPI: WebSocket error (will reconnect)')
    }

    seventvWebSocket.onclose = (closeEvent) => {
      log(' 7TV EventAPI: Connection closed')
      const closing = closeEvent?.target
      if (closing) {
        try {
          closing.onopen = null
          closing.onmessage = null
          closing.onerror = null
          closing.onclose = null
        } catch {}
      }
      seventvWebSocket = null
      seventvSubscribedSets.clear()
      seventvUserSubs.clear()
      if (seventvZombieTimer) {
        untrackInterval(seventvZombieTimer)
        seventvZombieTimer = null
      }

      // Deliberate idle close — stay down until a platform tab returns
      // (schedule7TVIdleCheck / the next subscribe call reconnects).
      if (seventvIdleClosed) {
        log(' 7TV EventAPI: idle close (no platform tabs) — not reconnecting')
        return
      }

      if (seventvReconnectAttempts < SEVENTV_MAX_RECONNECT_ATTEMPTS && seventvEmoteSetIds.size > 0) {
        // Jitter scales with the base delay (capped at 30s). At 100k clients
        // a shared 7TV outage hits a wide spread, not a 1s synchronization
        // window — prevents thundering-herd reconnects against 7TV.
        const baseDelay = Math.min(1000 * 2 ** seventvReconnectAttempts, 30000)
        const jitter7tv = Math.random() * baseDelay
        const delay = baseDelay + jitter7tv
        seventvReconnectAttempts++
        log(
          ` 7TV EventAPI: Reconnecting in ${Math.round(delay)}ms (attempt ${seventvReconnectAttempts}/${SEVENTV_MAX_RECONNECT_ATTEMPTS})`,
        )
        clearTimeout(seventvReconnectTimer)
        seventvReconnectTimer = setTimeout(() => {
          seventvReconnectTimer = null
          // Re-subscribe all known sets on reconnect
          for (const setId of seventvEmoteSetIds.values()) {
            subscribe7TVEmoteSet(setId)
          }
        }, delay)
      } else if (seventvReconnectAttempts >= SEVENTV_MAX_RECONNECT_ATTEMPTS) {
        log(' 7TV EventAPI: Max reconnect attempts reached, giving up. Will retry in 10 minutes.')
        clearTimeout(seventvReconnectTimer)
        seventvReconnectAttempts = 0
        seventvWebSocket = null
        seventvReconnectTimer = setTimeout(() => {
          seventvReconnectTimer = null
          ensure7TVConnection()
        }, 600000)
      }
    }
  } catch (err) {
    console.error('[heatsync] 7TV EventAPI: Connection failed:', err)
  }
}

function send7TVSubscribe(setId) {
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) return
  if (seventvSubscribedSets.has(setId)) return
  if (seventvSubscribedSets.size + seventvUserSubs.size >= seventvSubLimit) {
    log(' 7TV EventAPI: subscription_limit reached, skipping set', setId.slice(0, 12))
    return
  }

  seventvWebSocket.send(
    JSON.stringify({
      op: 35,
      d: { type: 'emote_set.*', condition: { object_id: setId } },
    }),
  )
  seventvSubscribedSets.add(setId)
  log(' 7TV EventAPI: Subscribed to', setId.slice(0, 12))
}

/**
 * Drop a set subscription once no channel maps to it. Without the explicit
 * op 36 the subscription lingers on 7TV's side for the life of the socket —
 * a long session that hops channels would keep paying for dead sets and
 * eventually push against subscription_limit.
 */
function release7TVEmoteSet(setId) {
  if (!setId) return
  for (const id of seventvEmoteSetIds.values()) if (id === setId) return // still in use
  seventvPendingSubs.delete(setId)
  if (!seventvSubscribedSets.delete(setId)) return
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) return
  seventvWebSocket.send(
    JSON.stringify({
      op: 36,
      d: { type: 'emote_set.*', condition: { object_id: setId } },
    }),
  )
  log(' 7TV EventAPI: Unsubscribed from', setId.slice(0, 12))
}

// Track per-user 7TV subscriptions so we get real-time badge/paint changes
// for users we care about (logged-in user, currently-watched broadcaster, etc).
const seventvUserSubs = new Set() // 7TV user IDs subscribed for cosmetics
const pendingUserSubs = new Set() // queued while WS is opening

function send7TVUserSubscribe(seventvUserId) {
  if (!seventvWebSocket || seventvWebSocket.readyState !== WebSocket.OPEN) {
    pendingUserSubs.add(seventvUserId)
    return
  }
  if (seventvUserSubs.has(seventvUserId)) return
  if (seventvSubscribedSets.size + seventvUserSubs.size >= seventvSubLimit) {
    log(' 7TV EventAPI: subscription_limit reached, skipping user', seventvUserId.slice(0, 12))
    return
  }
  seventvWebSocket.send(
    JSON.stringify({
      op: 35,
      d: { type: 'user.*', condition: { object_id: seventvUserId } },
    }),
  )
  seventvUserSubs.add(seventvUserId)
  log(' 7TV EventAPI: Subscribed to user', seventvUserId.slice(0, 12))
}

// Map: twitchId → 7tvUserId. Populated when a content script registers a twitch ID
// and we resolve it via the 7TV API. Used to bust cache on user.update events.
const twitchToSeventvId = new Map()
const seventvToTwitchId = new Map()

async function ensureSelfCosmeticSub(twitchId) {
  if (!twitchId) return
  // First time we see this twitch ID this session — force a fresh cosmetic
  // fetch (busts any stale negative cache from before they got their badge).
  if (!twitchToSeventvId.has(twitchId)) {
    userCosmeticsCache.delete(String(twitchId))
    broadcastToTabs({ type: 'cosmetics_invalidated', twitchId: String(twitchId) })
  } else {
    return // already subscribed
  }
  try {
    const resp = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${twitchId}`)
    if (!resp.ok) {
      resp.body?.cancel?.()
      return
    }
    const data = await resp.json()
    const seventvId = data?.user?.id
    if (!seventvId) return
    twitchToSeventvId.set(String(twitchId), seventvId)
    seventvToTwitchId.set(seventvId, String(twitchId))
    // LRU cap — these grew unbounded (one entry per distinct 7TV chatter) over
    // an 8h session. Evict the oldest pair together so the two stay in sync;
    // the next message from an evicted user just re-fetches their 7TV id.
    if (twitchToSeventvId.size > 2000) {
      const oldT = twitchToSeventvId.keys().next().value
      const oldS = twitchToSeventvId.get(oldT)
      twitchToSeventvId.delete(oldT)
      if (oldS) seventvToTwitchId.delete(oldS)
    }
    ensure7TVConnection()
    send7TVUserSubscribe(seventvId)
  } catch {}
}

// 7TV PERSONAL emote sets — paid-sub emotes usable in any chat. They are
// NOT in /v3/users/<platform>/<id> (that's the channel set); the EventAPI
// pushes an EMOTE_SET entitlement per active chatter. Capture → fetch the
// set once → merge into get_sender_emotes results so DonkMonk-class emotes
// render for other people's messages.
const seventvPersonalSets = new Map() // twitch uid -> { name: emoteData }
const _stvSetFetchAt = new Map() // set id -> ts (6h TTL)
async function capture7TVPersonalEntitlement(body) {
  try {
    const obj = body?.object || body
    const kind = obj?.kind || body?.kind
    if (String(kind).toUpperCase() !== 'EMOTE_SET') return
    const setId = obj?.ref_id || obj?.refId || obj?.id
    const conns = obj?.user?.connections || body?.user?.connections || []
    const twitchId = conns.find?.((c) => String(c?.platform).toUpperCase() === 'TWITCH')?.id
    if (!setId || !twitchId) return
    const last = _stvSetFetchAt.get(setId) || 0
    const cached = seventvPersonalSets.get(String(twitchId))
    if (cached && Date.now() - last < 6 * 3600_000) return
    _stvSetFetchAt.set(setId, Date.now())
    if (_stvSetFetchAt.size > 2000) _stvSetFetchAt.delete(_stvSetFetchAt.keys().next().value)
    const res = await fetchWithTimeout(`https://7tv.io/v3/emote-sets/${setId}`)
    if (!res.ok) return
    const data = await res.json()
    const out = {}
    for (const e of data?.emotes || []) {
      if (!e?.name || !e?.id) continue
      const flags = (e.flags || 0) | (e.data?.flags || 0)
      out[e.name] = {
        url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
        source: '7tv',
        state: 'global',
        zeroWidth: !!(flags & 257),
        hash: e.id,
        animated: !!e.data?.animated,
      }
    }
    if (Object.keys(out).length) {
      seventvPersonalSets.set(String(twitchId), out)
      if (seventvPersonalSets.size > 2000) {
        const k0 = seventvPersonalSets.keys().next().value
        seventvPersonalSets.delete(k0)
      }
      log(' 7TV: personal set captured for', twitchId, '—', Object.keys(out).length, 'emotes')
    }
  } catch (e) {
    log('7TV personal-set capture err:', e?.message)
  }
}

function handle7TVUserUpdate(body) {
  const seventvId = body?.id || body?.object?.id || body?.user?.id || body?.user_id
  if (!seventvId) return
  const twitchId = seventvToTwitchId.get(seventvId)
  if (!twitchId) return
  // Bust cosmetics cache so next get_user_cosmetics refetches fresh data
  userCosmeticsCache.delete(twitchId)
  log(' 7TV: User cosmetic update for twitchId', twitchId, '— cache busted')
  // Tell tabs to drop their local cosmetic cache for this user and reapply
  broadcastToTabs({ type: 'cosmetics_invalidated', twitchId })
}

function subscribe7TVEmoteSet(setId) {
  if (!setId) return

  ensure7TVConnection()

  if (seventvWebSocket && seventvWebSocket.readyState === WebSocket.OPEN) {
    send7TVSubscribe(setId)
  } else {
    // Queue for when connection opens
    seventvPendingSubs.add(setId)
  }
}

// Debounced zero-tab check for BOTH long-lived sockets (7TV EventAPI +
// heatsync WS): close when the last platform tab goes away, reconnect when
// one returns. The grace window rides out reloads and channel switches.
// 7TV: emote-set subs park in seventvPendingSubs (replayed in onopen), user
// cosmetic subs re-derive from seventvToTwitchId. Heatsync: channel joins
// replay from tabChannels/joinedExtraChannels in the connect burst, and the
// toolbar badge resyncs via hydrateUnreadNotifCount on the next auth.
// Closing the heatsync WS also releases the SW keepalive (its 20s heartbeat
// pinned the worker in RAM forever) — the whole SW heap gets reclaimed.
function scheduleWsIdleCheck() {
  clearTimeout(seventvIdleTimer)
  seventvIdleTimer = setTimeout(async () => {
    seventvIdleTimer = null
    let tabs
    try {
      tabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
    } catch {
      return // can't tell — leave the sockets alone (fail open)
    }
    if (tabs.length === 0) {
      const ws = seventvWebSocket
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        log(' 7TV EventAPI: no platform tabs — closing idle socket')
        seventvIdleClosed = true
        for (const setId of seventvSubscribedSets) seventvPendingSubs.add(setId)
        clearTimeout(seventvReconnectTimer)
        seventvReconnectTimer = null
        try {
          ws.close()
        } catch {}
      }
      if (typeof socket !== 'undefined' && socket && socket.readyState !== WebSocket.CLOSED && !hsWsIdleClosed) {
        log(' HS WS: no platform tabs — closing idle socket')
        hsWsIdleClosed = true // gates onclose→scheduleReconnect + watchdog + online
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        try {
          socket.close() // onclose still runs: clears heartbeat, sets state
        } catch {}
      }
      // BG IRC reader rides its own 20s heartbeat — same SW-pinning rule as
      // the sockets above, so it idle-closes with them. Buffers are already
      // debounce-persisted to storage.local; reopen restores them.
      if (BG_IRC.ws && !BG_IRC.idleClosed) {
        log('BG IRC: no platform tabs — closing idle reader')
        bgIrcIdleClose()
      }
      // With every socket down, the 30s lifelines pin the SW alive on their
      // own, and the staggered tab-serving alarms (TAB_GATED_ALARMS) fire
      // <30s apart COMBINED — either set alone keeps the heap resident
      // forever. Clear both; alarms persist outside the SW, so the
      // else-branch below re-creates them when a platform tab returns.
      browser.alarms?.clear?.('keepalive')?.catch?.(() => {})
      browser.alarms?.clear?.('hs-ws-watchdog')?.catch?.(() => {})
      for (const name of Object.keys(TAB_GATED_ALARMS)) {
        browser.alarms?.clear?.(name)?.catch?.(() => {})
      }
    } else {
      ensureAlarm('keepalive', { periodInMinutes: 0.5 })
      ensureAlarm('hs-ws-watchdog', { periodInMinutes: 0.5 })
      for (const [name, opts] of Object.entries(TAB_GATED_ALARMS)) {
        ensureAlarm(name, opts())
      }
      if (seventvIdleClosed) ensure7TVConnection() // pending subs replay on open
      if (hsWsIdleClosed) {
        hsWsIdleClosed = false
        connectWebSocket().catch(() => {})
      }
      if (BG_IRC.idleClosed) {
        bgIrcRestoreFromStorage()
          .catch(() => {})
          .then(() => bgIrcConnect())
      }
    }
  }, SEVENTV_IDLE_GRACE_MS)
}
browser.tabs.onRemoved.addListener(scheduleWsIdleCheck)
browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) scheduleWsIdleCheck()
})
// Boot: reconcile alarm + reader state against actual tab presence. Without
// this, a SW woken by a non-tab event (alarm, notification click) after the
// browser restarted with zero platform tabs would keep stale lifeline alarms.
scheduleWsIdleCheck()

function handle7TVEmoteSetUpdate(updateData) {
  // updateData.id is the emote set ID — look up which channel it belongs to
  const setId = updateData.id
  let key = null
  for (const [k, id] of seventvEmoteSetIds) {
    if (id === setId) {
      key = k
      break
    }
  }
  if (!key) {
    log(' 7TV: Received update for unknown set:', setId)
    return
  }

  const { platform, channel: channelName } = splitChKey(key)
  log(' 7TV: Emote set update for', channelName, '(', platform, ')')

  let updated = false
  const actor = updateData.actor?.display_name || updateData.actor?.username || ''

  // Handle added emotes
  if (updateData.pushed && updateData.pushed.length > 0) {
    // Large batch = likely initial sync on subscription, not real additions — suppress per-emote spam
    const isBulkSync = updateData.pushed.length > 3
    for (const item of updateData.pushed) {
      const emote = item.value
      if (!emote || typeof emote.id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(emote.id)) continue
      const newEmote = {
        name: String(emote.name || '').slice(0, 100),
        url: `https://cdn.7tv.app/emote/${emote.id}/1x.avif`,
        source: '7tv',
        hash: emote.id,
        animated: !!emote.data?.animated,
      }

      const chEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : []
      if (!chEmotes.some((e) => e.hash === emote.id)) {
        chEmotes.push(newEmote)
        channelEmotesMap[key] = chEmotes
        updated = true

        if (!isBulkSync) {
          log(' 7TV: Added emote:', emote.name, 'to', channelName)
          const msg = actor ? `${actor} added 7TV emote ${emote.name}` : `${emote.name} added to channel`
          broadcastToTabs({
            type: 'channel_emote_added',
            emote: newEmote,
            channel: channelName,
            platform,
            actor: actor || null,
            message: msg,
          })
        }
      }
    }
    if (isBulkSync) {
      log(' 7TV: Bulk sync — added', updateData.pushed.length, 'emotes to', channelName, '(notifications suppressed)')
    }
  }

  // Handle removed emotes
  if (updateData.pulled && updateData.pulled.length > 0) {
    const isBulkRemoval = updateData.pulled.length > 3
    let removedCount = 0
    for (const item of updateData.pulled) {
      const emote = item.old_value
      if (!emote || typeof emote.id !== 'string') continue
      const chEmotes = channelEmotesMap[key] || []
      const index = chEmotes.findIndex((e) => e.hash === emote.id)

      if (index !== -1) {
        chEmotes.splice(index, 1)
        channelEmotesMap[key] = chEmotes
        updated = true
        removedCount++

        if (!isBulkRemoval) {
          log(' 7TV: Removed emote:', emote.name, 'from', channelName)
          const msg = actor ? `${actor} removed 7TV emote ${emote.name}` : `${emote.name} removed from channel`
          broadcastToTabs({
            type: 'channel_emote_removed',
            emoteName: emote.name,
            emoteHash: emote.id,
            channel: channelName,
            platform,
            actor: actor || null,
            message: msg,
          })
        }
      }
    }
    if (isBulkRemoval && removedCount > 0) {
      log(' 7TV: Bulk removal —', removedCount, 'emotes removed from', channelName, '(notifications suppressed)')
      broadcastToTabs({
        type: 'channel_emote_removed',
        emoteName: null,
        emoteHash: null,
        channel: channelName,
        platform,
        actor: actor || null,
        message: `${removedCount} 7TV emotes removed from channel (set changed)`,
      })
    }
  }

  if (updated) {
    const updatedEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : []
    broadcastToTabs({
      type: 'channel_emotes_update',
      emotes: updatedEmotes,
      channelOwner: channelName,
      platform,
    })

    browser.storage.local
      .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
      .catch(() => {})
    log(' 7TV: Channel emotes updated for', channelName, '(now', updatedEmotes.length, 'total)')
  }
}

// ========== 7TV Polling Fallback ==========
// EventAPI works but can be unreliable. Poll as backup — both paths diff against
// channelEmotesMap so they naturally deduplicate (no double-fire).
let seventvPollTimer = null
const SEVENTV_POLL_INTERVAL = 30000
// Track channels that have completed their first poll in this session
// Prevents spammy "removed" notifications when diffing stale cache on startup
const seventvPolledChannels = new Set()

function start7TVPolling() {
  stop7TVPolling()
  if (seventvEmoteSetIds.size === 0) return
  log(' 7TV Poll: Starting for', seventvEmoteSetIds.size, 'channel(s)')
  // Jitter the interval per-client to spread 30k clients across the window
  // instead of synchronizing on whatever instant start7TVPolling fires.
  const jittered = SEVENTV_POLL_INTERVAL + Math.random() * SEVENTV_POLL_INTERVAL
  seventvPollTimer = trackInterval(setInterval(poll7TVEmoteSet, jittered))
}

// EventAPI is healthy when the WS is OPEN and we received data in the last 3min.
// When healthy + the channel's set is subscribed, the poll is redundant.
function isSeventvEventApiHealthy() {
  return (
    seventvWebSocket &&
    seventvWebSocket.readyState === WebSocket.OPEN &&
    seventvLastData &&
    Date.now() - seventvLastData < 180000
  )
}

function stop7TVPolling() {
  if (seventvPollTimer) {
    untrackInterval(seventvPollTimer)
    seventvPollTimer = null
  }
}

// Tracks when EventAPI first became unhealthy. Gates polling so brief
// WS hiccups don't trigger a 100k-client REST burst against 7TV.
let seventvUnhealthySince = 0
const SEVENTV_UNHEALTHY_GRACE_MS = 60000

async function poll7TVEmoteSet() {
  // Poll ALL channels that have an active 7TV emote set ID
  const channels = Array.from(seventvEmoteSetIds.keys())
  if (channels.length === 0) return
  const eventApiHealthy = isSeventvEventApiHealthy()
  if (eventApiHealthy) {
    seventvUnhealthySince = 0
  } else {
    if (!seventvUnhealthySince) seventvUnhealthySince = Date.now()
    // Within the grace window, skip the entire poll — reconnect is in progress.
    if (Date.now() - seventvUnhealthySince < SEVENTV_UNHEALTHY_GRACE_MS) return
  }

  for (const key of channels) {
    // Skip channels whose emote set is actively subscribed via EventAPI —
    // pushes from the WS supersede polling. Falls back to poll only when
    // EventAPI is degraded or this set isn't subscribed yet.
    const setId = seventvEmoteSetIds.get(key)
    if (eventApiHealthy && setId && seventvSubscribedSets.has(setId)) continue

    const { platform, channel: channelName } = splitChKey(key)

    try {
      let response
      if (platform === 'kick') {
        // 7TV's kick endpoint needs the numeric id, not the slug. Reuse the id
        // the initial fetch resolved; skip this cycle if it's not cached yet.
        const kid = channelOwnerKickId.get(channelName)
        if (!kid) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kid}`)
      } else if (platform === 'youtube') {
        // Only poll if we already resolved a real UC id for this exact key —
        // never resolve fresh here (this is a fallback poll path; resolving on
        // every cycle would hammer youtube.com). No id cached = skip, no bleed.
        const ucid = ytChannelIdCache.get(channelName)
        if (!ucid) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/google/${ucid}`)
      } else {
        const channelId = await lookupTwitchUserId(channelName)
        if (!channelId) continue
        response = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${channelId}`)
      }
      if (!response.ok) continue
      const data = await response.json()

      const emoteSet = data.emote_set
      if (!emoteSet?.emotes) continue

      // Check if emote set ID changed (user recreated their set)
      const knownSetId = seventvEmoteSetIds.get(key)
      if (emoteSet.id !== knownSetId) {
        log(' 7TV Poll: Emote set ID changed for', channelName, ':', knownSetId, '→', emoteSet.id)
        seventvEmoteSetIds.set(key, emoteSet.id)
        subscribe7TVEmoteSet(emoteSet.id)
      }

      // Build current 7TV emote map from fetched data
      const fetchedEmotes = new Map()
      for (const e of emoteSet.emotes) {
        fetchedEmotes.set(e.id, {
          name: e.name,
          url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
          source: '7tv',
          hash: e.id,
          flags: e.flags || e.data?.flags || 0,
          zeroWidth: !!(e.flags & 257 || e.data?.flags & 257),
          animated: !!e.data?.animated,
        })
      }

      // Get existing 7TV emotes for this channel
      const chEmotes = Array.isArray(channelEmotesMap[key]) ? channelEmotesMap[key] : []
      const existing7TV = new Map()
      for (const e of chEmotes) {
        if (e.source === '7tv') existing7TV.set(e.hash, e)
      }

      // Diff: find added and removed
      const added = []
      const removed = []
      for (const [id, emote] of fetchedEmotes) {
        if (!existing7TV.has(id)) added.push(emote)
      }
      for (const [id, emote] of existing7TV) {
        if (!fetchedEmotes.has(id)) removed.push(emote)
      }

      if (added.length === 0 && removed.length === 0) continue

      log(' 7TV Poll: Detected changes for', channelName, '— added:', added.length, 'removed:', removed.length)

      // Apply changes to channelEmotesMap
      const updatedEmotes = chEmotes.filter((e) => e.source !== '7tv' || fetchedEmotes.has(e.hash))
      updatedEmotes.push(...added)
      channelEmotesMap[key] = updatedEmotes

      // Only broadcast individual notifications after first successful poll this session
      // Prevents spammy "removed" notifications when diffing stale cache on startup
      if (seventvPolledChannels.has(key)) {
        const isBulk = added.length > 3 || removed.length > 3
        if (isBulk) {
          log(
            ' 7TV Poll: Bulk set change for',
            channelName,
            '—',
            added.length,
            'added,',
            removed.length,
            'removed (notifications suppressed)',
          )
          if (added.length > 0) {
            broadcastToTabs({
              type: 'channel_emote_added',
              emote: null,
              channel: channelName,
              platform,
              message: `${added.length} 7TV emotes added to channel (set changed)`,
            })
          }
          if (removed.length > 0) {
            broadcastToTabs({
              type: 'channel_emote_removed',
              emoteName: null,
              emoteHash: null,
              channel: channelName,
              platform,
              message: `${removed.length} 7TV emotes removed from channel (set changed)`,
            })
          }
        } else {
          for (const emote of added) {
            log(' 7TV Poll: Added emote:', emote.name, 'to', channelName)
            broadcastToTabs({
              type: 'channel_emote_added',
              emote,
              channel: channelName,
              platform,
              message: `${emote.name} added to channel (7TV)`,
            })
          }
          for (const emote of removed) {
            log(' 7TV Poll: Removed emote:', emote.name, 'from', channelName)
            broadcastToTabs({
              type: 'channel_emote_removed',
              emoteName: emote.name,
              emoteHash: emote.hash,
              channel: channelName,
              platform,
              message: `${emote.name} removed from channel (7TV)`,
            })
          }
        }
      } else {
        log(
          ' 7TV Poll: Skipping notifications for initial load of',
          channelName,
          `(${added.length} added,`,
          removed.length,
          'removed)',
        )
        seventvPolledChannels.add(key)
      }

      // Broadcast full update
      broadcastToTabs({
        type: 'channel_emotes_update',
        emotes: updatedEmotes,
        channelOwner: channelName,
        platform,
      })

      browser.storage.local
        .set({ channel_emotes_map: getStorableChannelEmotes(), channel_emotes_fetched_at: channelEmotesFetchedAt })
        .catch(() => {})
      log(' 7TV Poll: Channel emotes updated for', channelName, '(now', updatedEmotes.length, 'total)')
    } catch (_err) {
      // Silent fail — poll will retry next interval
    }
  }
}

// Block emote via HTTP - returns success/failure
async function blockEmote(hash) {
  // Server stores blocks by hash only — silently 404s for empty/null hashes.
  // Reject early to prevent corrupting blockedEmotes Set with undefined entries.
  if (!hash || typeof hash !== 'string') return { success: false, error: 'no hash' }
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      // Not logged in - use local storage
      localBlockedEmotes.add(hash)
      markBlockToggle(hash, 'blocked')
      await saveLocalBlockedEmotes()

      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_blocked', hash })
      return { success: true, local: true }
    }

    // Optimistically add to blockedEmotes BEFORE HTTP request
    // Prevents race where WS emote:blocked arrives before HTTP response
    // and triggers inventory_update → emoteGeneration++ → stack rebuild
    blockedEmotes.add(hash)
    markBlockToggle(hash, 'blocked')

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/block`, {
      method: 'POST',
      credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ emote_hash: hash }),
    })

    if (!response.ok) {
      // Rollback optimistic add
      blockedEmotes.delete(hash)
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      return { success: false, error: error.error || `HTTP ${response.status}` }
    }

    // 2-state model: block is a render-preference, not an inventory mutation.
    // Server preserves the user_emotes row now; local emoteInventory stays in
    // lockstep so an immediate unblock restores the slot membership without a
    // round-trip refetch.

    // Persist server-only set under `blocked_emotes`. Local blocks live in
    // `local_blocked_emotes`. Mixing them under the same key poisons the
    // warm-boot rehydrate (line ~5211) — local-era hashes leak into the
    // server-truth Set and get re-broadcast as fake server blocks.
    persistServerBlockedEmotes()
    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])) })
    broadcastToTabs({ type: 'emote_blocked', hash })
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message || 'Network error' }
  }
}

// Unblock emote via HTTP - returns success/failure
async function unblockEmote(hash) {
  // Same hash-validity guard as blockEmote — silent 404 corrupts state otherwise.
  if (!hash || typeof hash !== 'string') return { success: false, error: 'no hash' }
  try {
    // Always strip local block too — covers the anon→login transition where a
    // hash sits in localBlockedEmotes and the user expects "unblock" to clear
    // both layers. Without this, the picker (which reads merged via blocked_update)
    // shows the emote as blocked forever even after the server-side unblock.
    const hadLocal = localBlockedEmotes.delete(hash)
    if (hadLocal) await saveLocalBlockedEmotes()

    const authToken = await getAuthCookie()
    if (!authToken) {
      markBlockToggle(hash, 'unblocked')

      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_unblocked', hash })

      log(' 🔓 Unblocked emote locally (not logged in):', hash)
      return { success: true, local: true }
    }

    // If the hash was only ever a local block (anon-era), there's nothing to
    // delete on the server. Skip the HTTP call so a 404 doesn't surface as a
    // false failure to the picker.
    const hadServer = blockedEmotes.has(hash)
    if (!hadServer && hadLocal) {
      markBlockToggle(hash, 'unblocked')
      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_unblocked', hash })
      return { success: true, local: true }
    }

    // Optimistically remove from blockedEmotes BEFORE HTTP request
    // Prevents race where WS emote:unblocked arrives before HTTP response
    blockedEmotes.delete(hash)
    markBlockToggle(hash, 'unblocked')

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/blocked/${hash}`, {
      method: 'DELETE',
      credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })

    // Treat 404 as success — the hash isn't on the server, so "unblock" is a no-op.
    // Without this, hash-formula mismatches between block/unblock surfaces (24-slice
    // vs 32-slice vs server-supplied) make every cross-surface unblock look like
    // a network failure and the UI rolls back the optimistic local clear.
    if (!response.ok && response.status !== 404) {
      // Rollback optimistic delete
      blockedEmotes.add(hash)
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      return { success: false, error: error.error || `HTTP ${response.status}` }
    }

    persistServerBlockedEmotes()
    // Picker subscribes to `blocked_update` (merged set) only — without this
    // broadcast the open picker keeps showing the just-unblocked emote as
    // blocked until its next `get_inventory` round-trip.
    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])) })
    broadcastToTabs({ type: 'emote_unblocked', hash })
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message || 'Network error' }
  }
}

// Single owner of the `blocked_emotes` storage key — only server-blocked hashes.
// Drops any queued merged-set write from broadcastToTabs so the next debounce
// flush can't clobber this with stale anon-era hashes.
function persistServerBlockedEmotes() {
  const blockedArr = Array.from(blockedEmotes)
  _broadcastStorageQueue.delete('blocked_emotes')
  browser.storage.local.set({ blocked_emotes: blockedArr }).catch(() => {})
}

// Extension badge — combined source: live followed creators (red, priority) +
// unread heatsync notifications (orange, fallback). Whichever is non-zero wins,
// live wins when both. One number on the icon, colour disambiguates the source.
// Firefox MV2 uses browserAction, Chrome MV3 uses action.
const badgeApi = browser.action || browser.browserAction
function recomputeBadge() {
  if (!badgeApi) return
  const live = _liveFollowedCount || 0
  const notifs = unreadNotifCount || 0
  if (live > 0) {
    badgeApi.setBadgeText({ text: String(live) }).catch(() => {})
    badgeApi.setBadgeBackgroundColor({ color: '#ff0000' }).catch(() => {}) // doctrine: --hs-danger
  } else if (notifs > 0) {
    badgeApi.setBadgeText({ text: String(notifs) }).catch(() => {})
    badgeApi.setBadgeBackgroundColor({ color: '#555' }).catch(() => {})
  } else {
    badgeApi.setBadgeText({ text: '' }).catch(() => {})
  }
}
function updateExtensionBadge() {
  recomputeBadge()
}

// Resync the toolbar badge's notification count from the server. Runs on
// every WS auth — the in-memory counter misses notification:new events that
// arrive while the socket is idle-closed or the SW is evicted, so reconnect
// always adopts server truth instead of trusting stale local state.
async function hydrateUnreadNotifCount() {
  try {
    const res = await fetch('https://heatsync.org/api/notifications', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return // 401 = not logged in, skip silently
    const data = await res.json()
    if (typeof data?.count !== 'number') return
    if (data.count === unreadNotifCount) return
    unreadNotifCount = data.count
    browser.storage.session?.set({ unread_notif_count: unreadNotifCount }).catch(() => {})
    updateExtensionBadge()
  } catch {}
}

// Persist muted users to storage as { username, expiresAt } objects
function persistMutedUsers() {
  const arr = Array.from(mutedUsers.entries()).map(([username, expiresAt]) => ({ username, expiresAt }))
  browser.storage.local.set({ muted_users: arr }).catch(() => {})
}

// Persist blocked users (mirrors persistMutedUsers). The previous bare set had
// no .catch, so a rejected write in the MV3 service worker (quota, SW teardown)
// was an unhandled rejection AND the block was silently lost — the user
// reappeared after the next SW restart even though the UI showed { ok: true }.
function persistBlockedUsers() {
  browser.storage.local.set({ blocked_users: Array.from(blockedUsers) }).catch(() => {})
}

// Fetch server-side mute list on first auth — merges with any locally-stored
// mutes so cross-device mutes (set on heatsync.org) take effect immediately.
// Gracefully no-ops if not logged in, server is unreachable, or returns 401.
let _serverMutesFetched = false
async function fetchServerMutes() {
  if (_serverMutesFetched) return
  _serverMutesFetched = true
  try {
    const res = await fetch('https://heatsync.org/api/mutes', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      // fetch does NOT throw on an HTTP error, so the catch below never sees a
      // 5xx — and this runs off the WS 'authenticated' event, so we ARE logged
      // in and a 401 here is a token blip, not "logged out". Leaving the latch
      // set meant server mutes silently never synced again for the whole
      // session (not even on reconnect). Clear it so the next auth retries.
      _serverMutesFetched = false
      return
    }
    const data = await res.json()
    const list = Array.isArray(data) ? data : Array.isArray(data?.mutes) ? data.mutes : null
    if (!list) return
    const now = Date.now()
    let changed = false
    for (const entry of list) {
      const u = (entry.username || entry.user || '').toLowerCase()
      if (!u) continue
      const rawExp = entry.expires_at || entry.expiresAt || null
      const expiresAt = rawExp ? new Date(rawExp).getTime() : null
      if (expiresAt !== null && expiresAt <= now) continue // already expired
      if (!mutedUsers.has(u)) {
        mutedUsers.set(u, expiresAt)
        broadcastToTabs({ type: 'user_muted', username: u, expiresAt })
        changed = true
        log(' server mute synced:', u)
      }
    }
    if (changed) persistMutedUsers()
  } catch (e) {
    log(' fetchServerMutes failed:', e?.message)
    _serverMutesFetched = false // allow retry on next auth
  }
}

// Fetch server-side block list on first auth — merges with any locally-stored
// blocks so cross-device blocks (set on heatsync.org) take effect immediately.
// Gracefully no-ops if not logged in, server is unreachable, or returns 401.
let _serverBlocksFetched = false
async function fetchServerBlocks() {
  if (_serverBlocksFetched) return
  _serverBlocksFetched = true
  try {
    const res = await fetch('https://heatsync.org/api/user/blocks', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      // Same as fetchServerMutes: an HTTP error doesn't throw, so the catch
      // can't reset this. Blocks are safety-relevant — a silently un-synced
      // block list means a blocked user's messages reappear in chat with no
      // signal at all. Always allow the next auth to retry.
      _serverBlocksFetched = false
      return
    }
    const data = await res.json()
    const list = Array.isArray(data?.blocked_users) ? data.blocked_users : null
    if (!list) return
    let changed = false
    for (const entry of list) {
      const u = (entry.username || '').toLowerCase()
      if (!u) continue
      const platform = entry.platform || null
      const key = userKey(u, platform)
      if (!key) continue
      if (!blockedUsers.has(key)) {
        blockedUsers.add(key)
        broadcastToTabs({ type: 'user_blocked', username: key })
        changed = true
        log(' server block synced:', key)
      }
    }
    if (changed) persistBlockedUsers()
  } catch (e) {
    log(' fetchServerBlocks failed:', e?.message)
    _serverBlocksFetched = false // allow retry on next auth
  }
}

// Write a mute to the server's REST /api/mutes endpoint. Server broadcasts
// mute:added WS event so heatsync.org MuteManager + other ext instances pick
// up. Bearer auth → CSRF-exempt.
async function syncMuteToServer(username, expiresAtMs) {
  const token = await getAuthCookie()
  if (!token) return // not logged in
  const body = {
    username: username.toLowerCase(),
    platform: null,
    expires_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    reason: null,
  }
  const res = await fetch('https://heatsync.org/api/mutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) log(' /api/mutes POST', res.status)
}

async function syncUnmuteToServer(username) {
  const token = await getAuthCookie()
  if (!token) return
  const res = await fetch(`https://heatsync.org/api/mutes/${encodeURIComponent(username.toLowerCase())}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) log(' /api/mutes DELETE', res.status)
}

// Remove expired mutes and broadcast unmutes
function pruneExpiredMutes() {
  const now = Date.now()
  const expired = []
  for (const [username, expiresAt] of mutedUsers) {
    if (expiresAt !== null && expiresAt <= now) {
      expired.push(username)
    }
  }
  if (expired.length > 0) {
    expired.forEach((u) => {
      mutedUsers.delete(u)
      broadcastToTabs({ type: 'user_unmuted', username: u })
    })
    persistMutedUsers()
    log(' Pruned', expired.length, 'expired mutes')
  }
}

// Prune expired mutes — driven by chrome.alarms 'prune-expired-mutes' (MV3 SW survives across wakeups)

// Cached tab list to avoid repeated browser.tabs.query IPC on burst broadcasts
let _cachedTabs = null
let _cachedTabsAt = 0
const TAB_CACHE_TTL = 2000 // 2 seconds

async function getMatchingTabs() {
  const now = Date.now()
  if (_cachedTabs && now - _cachedTabsAt < TAB_CACHE_TTL) return _cachedTabs
  _cachedTabs = await browser.tabs.query({
    url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*', '*://*.heatsync.org/*', '*://heatsync.org/*'],
  })
  _cachedTabsAt = now
  return _cachedTabs
}

// Coalesce per-key persistence so high-frequency broadcasts don't write storage 1-2x/sec.
// Latest payload wins; flush after a short idle window.
const _broadcastStorageQueue = new Map() // key -> latest value
let _broadcastStorageTimer = null
const BROADCAST_STORAGE_DEBOUNCE = 5000
function _scheduleBroadcastStorageFlush() {
  if (_broadcastStorageTimer) return
  _broadcastStorageTimer = setTimeout(() => {
    _broadcastStorageTimer = null
    if (!_broadcastStorageQueue.size) return
    const payload = {}
    for (const [k, v] of _broadcastStorageQueue) payload[k] = v
    _broadcastStorageQueue.clear()
    browser.storage.local.set(payload).catch(() => {})
  }, BROADCAST_STORAGE_DEBOUNCE)
}

// Broadcast updates to all content scripts AND update storage
async function broadcastToTabs(message) {
  // Coalesce storage writes — burst broadcasts collapse to one set() per 5s window
  if (message.type === 'inventory_update') {
    _broadcastStorageQueue.set('emote_inventory', message.emotes)
    _scheduleBroadcastStorageFlush()
  } else if (message.type === 'global_emotes_update') {
    _broadcastStorageQueue.set('global_emotes', message.emotes)
    _scheduleBroadcastStorageFlush()
  } else if (message.type === 'blocked_update') {
    // `message.blocked` is merged (server + local) — used by content scripts to
    // render combined block state. Do NOT persist it under `blocked_emotes`:
    // that storage key is owned by persistServerBlockedEmotes() and holds the
    // server-only set. Mixing leaks anon-era local blocks into the server set
    // on warm boot. Local set is persisted separately via saveLocalBlockedEmotes.
  }

  // Broadcast to streaming tabs only (filtered query instead of all-tabs scan)
  try {
    const tabs = await getMatchingTabs()
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, message).catch(() => {})
    }
  } catch (e) {
    console.error('[HS] broadcastToTabs error:', e)
  }
}

// =============================================================================
// BULLETPROOF WEBSOCKET CONNECTION
// =============================================================================
// Features:
// - Message queue for when socket isn't ready
// - Connection state machine
// - Automatic retry with exponential backoff
// - Flush queued messages on connect

const WS_STATE = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
  AUTHENTICATED: 3,
}

let wsState = WS_STATE.DISCONNECTED
let isAuthenticated = false
let socketAuthToken = null
let reconnectAttempts = 0
let heartbeatInterval = null // Keep connection alive
let reconnectTimer = null
let pendingReconnectSpreadMs = 0 // Set by server:shutdown — consumed once on next scheduleReconnect to spread the herd
// Set on extension install/update or browser startup. Consumed once by the
// first connectWebSocket() to delay 0–60s, so 30k clients auto-updating in
// the same window don't slam /ws simultaneously.
let pendingStartupJitterMs = 0
const messageQueue = [] // Queue messages when socket not ready
let connectionPromise = null // Track ongoing connection attempt
let lastWsDataReceived = 0 // Timestamp of last received WS message (zombie detection)
// Idle disconnect (mirrors seventvIdleClosed): every WS consumer is
// tab-directed except the toolbar notification badge, which resyncs via
// hydrateUnreadNotifCount on reconnect — so at zero platform tabs the socket
// is pure idle cost (and its 20s heartbeat pins the SW in RAM forever).
// Gates the automatic revival paths only; any explicit connect intent
// (wsSend queue, tab join, auth change) clears it in connectWebSocket.
let hsWsIdleClosed = false

function isSocketOpen() {
  return socket && socket.readyState === WebSocket.OPEN
}

const MESSAGE_QUEUE_TTL = 60000 // 60 seconds — matches max reconnect backoff + jitter

// Flush queued messages when socket becomes ready
function flushMessageQueue() {
  if (!isSocketOpen()) return

  const now = Date.now()
  // Drop messages older than TTL before counting
  while (messageQueue.length > 0 && now - messageQueue[0]._queuedAt > MESSAGE_QUEUE_TTL) {
    log(` 🗑 Dropping stale queued message: ${messageQueue[0].type}`)
    messageQueue.shift()
  }

  const queued = messageQueue.length
  if (queued > 0) {
    log(` 📤 Flushing ${queued} queued messages`)
  }

  while (messageQueue.length > 0 && isSocketOpen()) {
    const msg = messageQueue.shift()
    if (now - msg._queuedAt > MESSAGE_QUEUE_TTL) {
      log(` 🗑 Dropping stale queued message: ${msg.type}`)
      continue
    }
    try {
      socket.send(JSON.stringify(msg))
      log(` 📤 Sent queued: ${msg.type}`)
    } catch (_err) {
      messageQueue.unshift(msg) // Put it back
      break
    }
  }
}

// WS lifecycle breadcrumb — last 30 events persisted to storage.local so a
// dead/misauthed socket is DIAGNOSABLE after the fact (the SW console is
// unreachable in the field; storage is readable from any surface). Sub-100B
// events, debounced writes — silent-failure playbook, not scaffolding.
const _wsDebug = []
let _wsDebugTimer = null
function wsDebugNote(evt, extra) {
  _wsDebug.push(`${new Date().toISOString().slice(11, 19)} ${evt}${extra ? ` ${extra}` : ''}`)
  while (_wsDebug.length > 30) _wsDebug.shift()
  if (_wsDebugTimer) return
  _wsDebugTimer = setTimeout(() => {
    _wsDebugTimer = null
    browser.storage.local.set({ hs_ws_debug: _wsDebug.slice() }).catch(() => {})
  }, 2000)
}

async function connectWebSocket() {
  // Explicit connect intent ends the idle state — only the automatic
  // revival paths (watchdog alarm, scheduleReconnect, online) honor it.
  hsWsIdleClosed = false
  wsDebugNote('connect', `auth:${!!authToken}`)
  // If already connecting, wait for that attempt
  if (wsState === WS_STATE.CONNECTING && connectionPromise) {
    log(' Connection in progress, waiting...')
    return connectionPromise
  }

  // Consume startup jitter once. SW evictions during the wait are fine —
  // storage.session preserves the deadline so the next wake honors what's left.
  if (pendingStartupJitterMs > 0) {
    const ms = pendingStartupJitterMs
    pendingStartupJitterMs = 0
    browser.storage.session?.remove('startup_jitter_at').catch(() => {})
    log(` ⏱ Startup jitter: delaying first connect by ${Math.round(ms)}ms`)
    await new Promise((r) => setTimeout(r, ms))
  }

  // If already connected with SAME token, skip
  if (isSocketOpen() && socketAuthToken === authToken && wsState >= WS_STATE.CONNECTED) {
    log(' Already connected with same token')
    return Promise.resolve()
  }

  // If connected with DIFFERENT token, disconnect first
  if (isSocketOpen() && socketAuthToken !== authToken) {
    log(' 🔄 Token changed, reconnecting...')
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    socket.onclose = null // prevent scheduleReconnect on intentional close
    socket.onmessage = null
    socket.onopen = null
    socket.onerror = null
    socket.close()
    wsState = WS_STATE.DISCONNECTED
    isAuthenticated = false
  }

  // Claim CONNECTING state BEFORE any await to block concurrent callers
  wsState = WS_STATE.CONNECTING
  connectionPromise = new Promise((resolve, reject) => {
    // Run async work inside the promise executor so the lock is held before any yield
    ;(async () => {
      // Load auth token if needed (async — but lock is already held above)
      if (!authToken) {
        log(' Loading auth token before connecting...')
        await getAuthCookie()
      }

      socketAuthToken = authToken

      const wsEndpoint = `${WS_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`
      log(' 🔌 Connecting to WebSocket:', wsEndpoint, 'with auth:', !!authToken)

      // Defensive: detach handlers from any prior closed/closing socket before reassigning
      if (socket) {
        try {
          socket.onopen = null
          socket.onmessage = null
          socket.onerror = null
          socket.onclose = null
          if (socket.readyState !== WebSocket.CLOSED) socket.close()
        } catch {}
        socket = null
      }

      try {
        socket = new WebSocket(wsEndpoint)
      } catch (err) {
        wsState = WS_STATE.DISCONNECTED
        connectionPromise = null
        scheduleReconnect()
        reject(err)
        return
      }

      // Connection timeout (10 seconds)
      const connectTimeout = setTimeout(() => {
        if (wsState === WS_STATE.CONNECTING) {
          socket.close()
          wsState = WS_STATE.DISCONNECTED
          connectionPromise = null
          scheduleReconnect()
          reject(new Error('Connection timeout'))
        }
      }, 10000)

      socket.onopen = () => {
        clearTimeout(connectTimeout)
        log(' ✅ WebSocket connected')
        // Clear "down" banner once we reconnect
        if (reconnectAttempts >= 3) {
          broadcastToTabs({ type: 'api_status', source: 'heatsync', state: 'up' })
        }
        reconnectAttempts = 0
        wsState = WS_STATE.CONNECTED
        // Missed-push convergence: emote pushes that fired while this socket
        // was down (>60s gap) are gone — nuke the sender cache and tell panels
        // to invalidate, so viewers converge at reconnect instead of at TTL.
        if (lastWsDataReceived && Date.now() - lastWsDataReceived > 60000) {
          if (globalThis.__senderEmoteCache) globalThis.__senderEmoteCache.clear()
          broadcastToTabs({ type: 'emote_added_broadcast', username: '' })
          // Same convergence for paints: any cosmetic:changed push that fired
          // while this socket was down is gone for good. Drop our own cache and
          // tell the panes theirs is suspect — nothing is refetched until a
          // name renders again, so this costs nothing on a quiet tab.
          _paintsCache.clear()
          broadcastToTabs({ type: 'cosmetics_stale_all' })
        }
        // Reset zombie-detection timestamp; otherwise a stale lastWsDataReceived
        // from before the disconnect makes the first heartbeat (90s later) trip
        // the 2min idle threshold and immediately kill the fresh socket.
        lastWsDataReceived = Date.now()

        // Two-layer heartbeat:
        //   1) chrome.alarms 'hs-ws-watchdog' (30s) survives SW eviction — wakes
        //      SW from idle to verify socket health + send heartbeat. Recovery.
        //   2) setInterval below (20s) KEEPS SW ALIVE via Chrome 116+'s
        //      WS-activity rule (any frame in/out within 30s window extends SW
        //      lifetime indefinitely). With this, SW never idle-dies while WS
        //      is connected. Server tolerates duplicate heartbeats.
        // Immediate heartbeat so server sees us right after auth.
        try {
          socket.send(JSON.stringify({ type: 'presence:heartbeat' }))
        } catch {}
        if (heartbeatInterval) {
          untrackInterval(heartbeatInterval)
          heartbeatInterval = null
        }
        heartbeatInterval = trackInterval(
          setInterval(() => {
            if (!isSocketOpen()) return
            try {
              socket.send(JSON.stringify({ type: 'presence:heartbeat' }))
            } catch {}
          }, 20000),
        )

        // Build the connect-time burst as a single queue, then drain it with
        // 80ms spacing. Server enforces a 60-token global WS rate limit per
        // socket (refill 1/sec); a user with 10+ channels was burning the
        // entire budget in <100ms, tripping the 5-violations-close threshold
        // and triggering IP-level fetch backoffs. 80ms cadence (≈12 msg/s) is
        // well under refill rate, full drain still completes in ~2s.
        const burst = []
        if (authToken) burst.push({ type: 'authenticate', token: authToken })
        const rejoinedChannels = new Set()
        for (const entry of tabChannels.values()) {
          if (entry.channel && !rejoinedChannels.has(entry.channel)) {
            const [platform, channel] = entry.channel.split('/')
            burst.push({ type: 'channel:join', platform, channel })
            rejoinedChannels.add(entry.channel)
            // Rejoin the Pusher tap too — tap-only kick channels have NO
            // server relay, so the server join alone leaves them silent.
            // Idempotent (_kpChannels.has guard).
            if (platform === 'kick') kickPusherJoin(channel)
          }
        }
        for (const key of joinedExtraChannels) {
          if (rejoinedChannels.has(key)) continue
          const [platform, channel] = key.split('/')
          if (!platform || !channel) continue
          burst.push({ type: 'channel:join', platform, channel })
          rejoinedChannels.add(key)
          if (platform === 'kick') kickPusherJoin(channel)
        }
        try {
          for (const ch of BG_IRC.channels.keys()) {
            const buf = BG_IRC.channels.get(ch)
            const all = buf?.getAll() || []
            const lastTs = all.length > 0 ? all[all.length - 1].time || 0 : 0
            burst.push({ type: 'irc:join', channel: ch })
            burst.push({ type: 'irc:resume', channel: ch, since: lastTs })
          }
        } catch (e) {
          log('irc:resume replay err:', e?.message)
        }
        burst.push({ type: 'feed:join', feed: 'new' })

        log(` 🌊 Connect burst queued: ${burst.length} msgs over ~${burst.length * 80}ms`)
        burst.forEach((msg, i) => {
          setTimeout(() => {
            if (!isSocketOpen()) return
            wsSendDirect(msg)
          }, i * 80)
        })

        if (!authToken) {
          log(' ℹ️ No auth token - viewer mode')
          flushMessageQueue()
        }

        // Re-subscribe to YouTube channels (global + per-channel)
        log('[hs-bg] WS connected, re-subscribing YouTube channels...')
        browser.storage.local
          .get(['youtube_url'])
          .then((data) => {
            log('[hs-bg] stored youtube data:', JSON.stringify(data))
            // Global YouTube (live tab)
            if (data.youtube_url) {
              const vidMatch =
                data.youtube_url.match(/[?&]v=([^&]+)/) ||
                data.youtube_url.match(/\/live\/([^?&/]+)/) ||
                data.youtube_url.match(/youtu\.be\/([^?&]+)/)
              if (vidMatch) setYtVideoChannel(vidMatch[1], 'global')
              wsSend({ type: 'youtube:subscribe', url: data.youtube_url })
            }
            // Per-channel YouTube URLs from in-memory map
            for (const [channelId, url] of Object.entries(youtubeChannelUrls)) {
              const vidMatch =
                url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
              if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
              wsSend({ type: 'youtube:subscribe', url, channelId })
            }
          })
          .catch(() => {})

        connectionPromise = null
        resolve()
      }

      socket.onmessage = (event) => {
        lastWsDataReceived = Date.now()
        try {
          const msg = JSON.parse(event.data)
          handleWSMessage(msg)
        } catch (err) {
          log(' WS message parse error:', err?.message)
        }
      }

      socket.onclose = (event) => {
        clearTimeout(connectTimeout)
        if (heartbeatInterval) {
          untrackInterval(heartbeatInterval)
          heartbeatInterval = null
        }
        log(' ⚠️ WebSocket disconnected:', event.code, event.reason)
        wsDebugNote('close', String(event.code))
        // Detach handlers from the closing socket so its closure releases
        const closing = event?.target
        if (closing) {
          try {
            closing.onopen = null
            closing.onmessage = null
            closing.onerror = null
            closing.onclose = null
          } catch {}
        }
        wsState = WS_STATE.DISCONNECTED
        isAuthenticated = false
        connectionPromise = null
        scheduleReconnect()
      }

      socket.onerror = (err) => {
        log(' WebSocket error:', err?.message || 'unknown')
      }
    })().catch((err) => {
      wsState = WS_STATE.DISCONNECTED
      connectionPromise = null
      scheduleReconnect()
      reject(err)
    })
  })

  return connectionPromise
}

// Direct send (bypasses queue) - used internally
function wsSendDirect(msg) {
  if (!isSocketOpen()) {
    log(' Cannot send direct - socket not open')
    return false
  }
  try {
    socket.send(JSON.stringify(msg))
    return true
  } catch (_err) {
    return false
  }
}

// Send JSON message over WebSocket (queues if not ready)
function wsSend(msg) {
  // If socket is open and ready, send immediately
  if (isSocketOpen()) {
    try {
      socket.send(JSON.stringify(msg))
      return true
    } catch (_err) {
      return false
    }
  }

  // Queue the message and ensure we're connecting
  log(` 📥 Queueing message: ${msg.type}`)
  msg._queuedAt = Date.now()
  messageQueue.push(msg)

  // Limit queue size to prevent memory issues
  if (messageQueue.length > 50) {
    messageQueue.shift() // Remove oldest
  }

  // Trigger connection if not already connecting. Auth failed — reconnecting
  // just replays the dead cookie and loops authenticate → authentication_failed.
  // Only a fresh login (cookies.onChanged 'set' / set_auth_token) clears the
  // block. Same guard the ws watchdog uses.
  if (wsState === WS_STATE.DISCONNECTED && !authFailedBlock) {
    connectWebSocket().catch((err) => log(' WS connect failed:', err?.message))
  }

  return false
}

// Handle incoming WebSocket messages
function handleWSMessage(msg) {
  try {
    log(' 📨 WS message received:', msg.type, msg)

    switch (msg.type) {
      case 'authenticated':
        log(' ✅ Authenticated, userId:', msg.userId)
        wsDebugNote('authed', msg.userId ? 'user' : 'anon')
        isAuthenticated = true
        wsState = WS_STATE.AUTHENTICATED
        // Flush any queued messages now that we're authenticated
        flushMessageQueue()
        // Pull server mute + block lists once per session so heatsync.org
        // actions are reflected immediately (WS events only arrive for changes
        // while connected)
        fetchServerMutes().catch(() => {})
        fetchServerBlocks().catch(() => {})
        // Every auth (not once-per-session): resync the badge counter the
        // idle-closed socket / evicted SW couldn't keep current.
        hydrateUnreadNotifCount().catch(() => {})
        break

      case 'server:shutdown':
        // Server is restarting and asking clients to spread reconnects across a
        // window so 10k+ extensions don't dogpile the freshly-restarted box.
        // Honors `reconnectSpreadMs` from the server's payload.
        if (typeof msg.reconnectSpreadMs === 'number' && msg.reconnectSpreadMs > 0) {
          pendingReconnectSpreadMs = Math.min(60000, msg.reconnectSpreadMs)
          log(` 🌊 Server shutdown — will spread reconnect over ${pendingReconnectSpreadMs}ms`)
        }
        break

      case 'authentication_failed':
        isAuthenticated = false
        authToken = null
        authFailedBlock = true
        _serverMutesFetched = false // reset so re-login triggers a fresh sync
        // Drop the stored token so the next reconnect (after a fresh login)
        // doesn't keep replaying the dead one and looping us back to here.
        browser.storage.local.remove(['auth_token_encrypted', 'auth_token']).catch(() => {})
        if (socket) {
          socket.close()
        }
        // Tell content scripts so the multichat panel can prompt the user to
        // log in — without this signal YT chat (which depends on the server
        // scraping for us) silently produces zero messages.
        broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'authentication_failed' })
        break

      case 'emote:broadcast':
        if (msg.emoteData?.url) {
          msg.emoteData.url = absUrl(msg.emoteData.url)
          if (!/^https:\/\//.test(msg.emoteData.url)) break
        }
        if (msg.emoteName) msg.emoteName = String(msg.emoteName).slice(0, 100)
        log(' 📢 EMOTE BROADCAST RECEIVED:', {
          username: msg.username,
          emoteName: msg.emoteName,
          emoteUrl: msg.emoteData?.url,
        })
        broadcastToTabs({
          type: 'emote_broadcast',
          username: msg.username,
          emoteName: msg.emoteName,
          emoteData: msg.emoteData,
        })
        break

      case 'emote:removed':
        // Could be broadcast (other users) OR personal inventory removal
        if (msg.slot !== undefined) {
          // Personal inventory removal (has slot number)
          log(' 🗑️ EMOTE REMOVED FROM YOUR INVENTORY:', msg.name, 'slot:', msg.slot)
          scheduleInventoryRefresh()
        } else if (msg.username) {
          // Broadcast from other user. New servers send senderKeys (the exact
          // batch keys this sender resolves as) + ver (emote-ver cache-bust) —
          // invalidate precisely. Legacy shape (no senderKeys): scrub by name
          // across every cached set.
          log(' 🗑️ EMOTE REMOVED BROADCAST:', msg)
          const rmKeys = sanitizeSenderKeys(msg.senderKeys)
          if (globalThis.__senderEmoteCache) {
            if (rmKeys) {
              for (const k of rmKeys) globalThis.__senderEmoteCache.delete(k)
            } else if (msg.emoteName) {
              for (const [_k, hit] of globalThis.__senderEmoteCache) {
                if (hit?.emotes && msg.emoteName in hit.emotes) {
                  delete hit.emotes[msg.emoteName]
                }
              }
            }
          }
          broadcastToTabs({
            type: 'emote_removed_broadcast',
            username: msg.username,
            emoteName: msg.emoteName,
            ...(rmKeys ? { senderKeys: rmKeys, ver: sanitizeVer(msg.ver) } : {}),
          })
        }
        break

      case 'emote:added':
        // Two shapes:
        //  - Personal add (msg.slot present): server saved YOUR own add, refresh
        //    inventory. (User-side broadcast on own add via website upload.)
        //  - Broadcast (msg.username present): a DIFFERENT user's set changed
        //    (single add carries emoteName/emoteData; bulk set change carries
        //    neither). New servers send senderKeys + ver for precise
        //    invalidation; legacy shape nukes the whole cache.
        if (msg.slot !== undefined) {
          log(' ✅ EMOTE ADDED TO INVENTORY:', msg.name, 'slot:', msg.slot)
          scheduleInventoryRefresh()
        } else if (msg.username) {
          log(' ➕ EMOTE ADDED BROADCAST:', msg)
          const addKeys = sanitizeSenderKeys(msg.senderKeys)
          if (globalThis.__senderEmoteCache) {
            if (addKeys) for (const k of addKeys) globalThis.__senderEmoteCache.delete(k)
            else globalThis.__senderEmoteCache.clear()
          }
          broadcastToTabs({
            type: 'emote_added_broadcast',
            username: msg.username,
            emoteName: msg.emoteName,
            ...(addKeys ? { senderKeys: addKeys, ver: sanitizeVer(msg.ver) } : {}),
          })
        }
        break

      case 'emotes:refresh':
        // Bulk inventory change from the site (apply saved set, channel-import,
        // shared-set import, undo/redo). Without this case the event fell through
        // and the inventory stayed stale until the 60s poll — the applied/imported
        // emotes silently didn't render.
        log(' 🔄 EMOTES REFRESH (bulk inventory change)')
        scheduleInventoryRefresh()
        break

      case 'cosmetic:changed': {
        // A user changed (or cleared) a HeatSync paint. The server sends only
        // the affected paint-space ids — never the spec, since GET /api/paints
        // withholds specs from unentitled users and re-fetching keeps that gate
        // intact. Drop our cached copies so the next lookup is authoritative,
        // then let content scripts repaint the rows already on screen.
        const changedIds = Array.isArray(msg.ids) ? msg.ids.filter((i) => typeof i === 'string') : []
        if (!changedIds.length) break
        for (const id of changedIds) _paintsCache.delete(id)
        broadcastToTabs({ type: 'cosmetic_changed', ids: changedIds })
        break
      }

      case 'profile:color':
        // A user changed their heatsync name color — forward to content
        // scripts so the overlay recolors that user's visible rows live.
        broadcastToTabs({ type: 'profile_color', userId: msg.userId, usernames: msg.usernames, color: msg.color })
        break

      case 'emote:blocked':
        // Skip if user just unblocked locally — late WS echo would otherwise re-add.
        if (recentBlockToggleState(msg.hash) === 'unblocked') break
        if (msg.hash && !blockedEmotes.has(msg.hash)) {
          blockedEmotes.add(msg.hash)
          browser.storage.local.set({ blocked_emotes: Array.from(blockedEmotes) }).catch(() => {})
          // 2-state model: block preserves inventory. No emoteInventory filter,
          // no inventory_update broadcast — only the blocked_update + emote_blocked
          // events that tell tabs to start painting the dashed-rect overlay.
          broadcastToTabs({ type: 'blocked_update', blocked: [...blockedEmotes, ...localBlockedEmotes] })
          broadcastToTabs({ type: 'emote_blocked', hash: msg.hash })
        }
        break

      case 'emote:unblocked':
        // Skip if user just blocked locally — late WS echo would otherwise re-remove.
        if (recentBlockToggleState(msg.hash) === 'blocked') break
        if (msg.hash && blockedEmotes.has(msg.hash)) {
          blockedEmotes.delete(msg.hash)
          browser.storage.local.set({ blocked_emotes: Array.from(blockedEmotes) }).catch(() => {})
          // Refresh inventory in case the unblocked emote should be restored
          scheduleInventoryRefresh()
          broadcastToTabs({ type: 'blocked_update', blocked: [...blockedEmotes, ...localBlockedEmotes] })
          broadcastToTabs({ type: 'emote_unblocked', hash: msg.hash })
        }
        break

      case 'ui-state:update': {
        // Cross-surface UI prefs sync — server merged a patch from another
        // client and is fanning out the full state. Mirror into chrome.storage
        // .sync.ui_settings so the existing storage.onChanged listener applies
        // every key live (zebra/timestamps/avatars/active tab/etc). Large
        // blocklist prefs (keywordHighlights/chatFilterRules) split off into
        // their chrome.storage.local overflow keys instead — the SAME onChanged
        // listener already reacts to those (keyword_highlights/chat_filter_rules)
        // for the local-mirror write path, so no new plumbing is needed.
        // Sanitize the patch first — never trust server-fanned-out state. A
        // single malformed payload here will otherwise corrupt every client of
        // this user permanently (sync replicates everywhere; once bad data is
        // in, every tab and the heatsync.org chat-tile inherit it).
        if (msg.state && typeof msg.state === 'object') {
          const { sync: cleanState, overflow } = splitIncomingUiState(msg.state)
          const cleanKeys = Object.keys(cleanState)
          const overflowKeys = Object.keys(overflow)
          if (cleanKeys.length === 0 && overflowKeys.length === 0) break
          if (cleanKeys.length) {
            log(' 🎛️  ui-state sync received:', cleanKeys.length, 'keys')
            uiSettingsRmw((ui) => sanitizeUiSettings({ ...ui, ...cleanState }))
          }
          if (overflowKeys.length) {
            log(' 🎛️  ui-state sync received (overflow):', overflowKeys.length, 'keys')
            browser.storage.local.set(overflow).catch(() => {})
          }
          broadcastToTabs({ type: 'ui_state_update', state: cleanState })
        }
        break
      }

      case 'multichat:config':
        // Cross-device sync: server sent updated multichat config
        if (Array.isArray(msg.channels)) {
          // Validate channel objects — reject malformed data to prevent CRLF injection in IRC.
          // twitch is sent to IRC so it must be username-shaped. kick allows hyphens.
          // youtube is a full https URL we resolve later; reject anything else.
          const validChannels = msg.channels.filter((ch) => {
            if (!ch || typeof ch !== 'object') return false
            if (ch.twitch && (typeof ch.twitch !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(ch.twitch))) return false
            if (ch.kick && (typeof ch.kick !== 'string' || !/^[a-zA-Z0-9_-]{1,25}$/.test(ch.kick))) return false
            if (
              ch.youtube &&
              (typeof ch.youtube !== 'string' ||
                !/^https:\/\/(www\.)?youtube\.com\//i.test(ch.youtube) ||
                /[\r\n]/.test(ch.youtube))
            )
              return false
            return true
          })
          log(' 📋 Multichat config sync received:', validChannels.length, 'channels')
          browser.storage.local
            .get(['heatsync_multichat'])
            .then((data) => {
              const current = data.heatsync_multichat || { channels: [], enabled: true }
              const currentJson = JSON.stringify(current.channels)
              const newJson = JSON.stringify(validChannels)
              if (currentJson !== newJson) {
                browser.storage.local.set({ heatsync_multichat: { ...current, channels: validChannels } })
              }
            })
            .catch(() => {})
        }
        break

      case 'new-message': {
        log(' New message received:', msg)
        // Only show posts from followed users, exclude anonymous
        const msgUser = (msg.username || '').toLowerCase()
        if (msg.username === 'Anonymous') {
          log(' Skipping feed post — anonymous')
          break
        }
        if (currentUsername && msgUser === currentUsername.toLowerCase()) {
          // Always show own posts
        } else if (!followedUsers.some((u) => u.toLowerCase() === msgUser)) {
          log(' Skipping feed post — not followed')
          break
        }
        broadcastToTabs({
          type: 'new-message',
          data: msg,
        })
        break
      }

      case 'message-updated':
        broadcastToTabs({ type: 'message-updated', data: msg })
        break

      case 'message-edited':
        broadcastToTabs({ type: 'message-edited', data: msg })
        break

      case 'message-deleted':
        broadcastToTabs({ type: 'message-deleted', data: msg })
        break

      case 'notification:new':
        log(' Notification received:', msg)
        unreadNotifCount++
        browser.storage.session?.set({ unread_notif_count: unreadNotifCount }).catch(() => {})
        updateExtensionBadge()
        broadcastToTabs({
          type: 'notification:new',
          data: msg.data,
        })
        break

      case 'youtube:chat':
        handleYoutubeChatBatch(msg)
        break

      case 'youtube:status': {
        // Resolve channelId BEFORE potentially deleting the videoId mapping —
        // otherwise an `ended` event broadcasts with channelId='global' and the
        // multichat panel can't update the right channel tab.
        // Fallback: server may not echo channelId for @user/live subscribes,
        // so attribute via pending-subscribe LIFO when status carries a fresh
        // videoId we haven't seen yet.
        const bound = new Set(ytChannelsFor(msg.videoId))
        if (msg.channelId) bound.add(msg.channelId)
        // Same ambiguity as youtube:chat — only fall back when exactly one pending.
        if (!bound.size && msg.status === 'connected' && msg.videoId && pendingYtSubscribes.length === 1) {
          const pend = pendingYtSubscribes.shift()
          bound.add(pend.channelId)
        }
        // A stale fallback binding (persisted by an older build) alongside a
        // real one would fan every broadcast out twice.
        if (bound.size > 1) bound.delete(YT_FALLBACK_CHANNEL)
        const channelIds = bound.size ? [...bound] : [YT_FALLBACK_CHANNEL]
        if (msg.status === 'connected') {
          activeYoutubeVideoId = msg.videoId
          if (msg.videoId) for (const cid of channelIds) setYtVideoChannel(msg.videoId, cid)
          if (msg.videoId) ytTapMarkWanted(msg.videoId)
        } else if (msg.status === 'ended') {
          if (activeYoutubeVideoId === msg.videoId) activeYoutubeVideoId = null
          deleteYtVideoChannel(msg.videoId)
          if (msg.videoId) ytTapUnmarkWanted(msg.videoId)
        } else if (msg.status === 'error') {
          // Transient errors (rate limit, single failed fetch) shouldn't kill routing —
          // the poller usually recovers and resumes broadcasting. Keeping the mapping
          // means resumed chat lands on the right tab instead of falling to 'global'.
          if (activeYoutubeVideoId === msg.videoId) activeYoutubeVideoId = null
        }
        for (const channelId of channelIds) {
          broadcastToTabs({
            type: 'youtube_status',
            videoId: msg.videoId,
            channelId,
            status: msg.status,
            channelName: msg.channelName || '',
            title: msg.title || '',
            error: msg.error || '',
          })
        }
        break
      }

      case 'dm:new':
        broadcastToTabs({
          type: 'dm_new',
          data: msg,
        })
        break

      case 'seen:update':
        // Cross-surface unread sync: another client (web, other ext) bumped a
        // tab's seen-at. Forward to all multichat tabs so they clear the dot.
        broadcastToTabs({
          type: 'seen_update',
          surface: msg.surface,
          at: msg.at,
        })
        break

      case 'kick-chat-message':
        // Tee into BG buffer first so reload-history is instant
        try {
          bgKickIngest(msg.data)
        } catch {}
        _kickSrcBump(_kickSrcStats.relay, (msg.data?.channel || '').toLowerCase(), msg.data?.id)
        // Relay Kick chat messages (via server webhook) to content scripts
        broadcastToTabs({
          type: 'kick_chat_message',
          data: msg.data,
        })
        break

      case 'moment:spike':
        // server-side heat spike — forward to tabs for the moments band + 🔥 notif.
        // Carry id (dedup key for live-insert) + title/game (card context); dropping
        // them silently broke dedup-by-id and the card title.
        broadcastToTabs({
          type: 'hs_moment',
          data: {
            id: msg.id,
            platform: msg.platform,
            channel: msg.channel,
            rate: msg.rate,
            baseline: msg.baseline,
            title: msg.title,
            game: msg.game,
          },
        })
        break

      case 'irc:message': {
        // Live twitch from the heatsync server (EventSub-fed consumer fanout).
        // Heals channels whose direct IRC delivery twitch is starving —
        // including background channels no native tap can cover.
        try {
          const ch = (msg.channel || '').toLowerCase()
          const ext = msg.message ? bgIrcRecordToExt(msg.message, ch) : null
          if (ch && ext && !bgIrcDupModNotice(BG_IRC.channels.get(ch), ext)) {
            if (!(ext.id && bgIrcSeenLiveId(`${ch}:${ext.id}`))) {
              const buf = BG_IRC.channels.get(ch)
              if (buf) {
                buf.push(ext)
                bgIrcPersistChannel(ch)
              }
              bgIrcBroadcast({ type: 'bg_irc_msg', msg: ext })
            } else if (ext.hsEmotes && ext.id) {
              // Deduped: the native IRC tap already delivered this id (won the
              // race), but this server copy carries server-enriched emote refs
              // the native copy lacked. Patch the buffered row (history) and tell
              // the panel to merge them + re-render just that row. Additive and
              // safe — no-ops entirely on channels the server never fans out.
              try {
                const buf = BG_IRC.channels.get(ch)
                if (buf?.getAll) {
                  for (const m of buf.getAll()) {
                    if (m && m.id === ext.id) {
                      if (!m.hsEmotes) m.hsEmotes = ext.hsEmotes
                      break
                    }
                  }
                }
              } catch {}
              bgIrcBroadcast({ type: 'bg_irc_enrich', channel: ch, id: ext.id, hsEmotes: ext.hsEmotes })
            }
          }
        } catch (e) {
          log('irc:message err:', e?.message)
        }
        break
      }

      case 'irc:backlog':
        // Heatsync server-side Twitch IRC ring buffer (500 msgs / 24h Redis).
        // Way deeper than robotty's instant fetch; merge it in.
        try {
          bgIrcMergeServerBacklog(msg.channel, msg.messages)
        } catch (e) {
          log('irc:backlog merge err:', e?.message)
        }
        break

      case 'kick-chat-backfill':
        // Server-side Kick ring buffer (200 msgs) replayed on channel:join.
        // Ingest into BG buffer for instant history on future tab joins, then
        // broadcast a merge notice so already-open tabs refresh.
        try {
          const ch = (msg.channel || '').toLowerCase()
          const list = Array.isArray(msg.messages) ? msg.messages : []
          if (ch && list.length > 0) {
            if (!BG_KICK.channels.has(ch)) {
              BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
              if (BG_KICK.channels.size > MAX_BG_KICK_CHANNELS) {
                const oldest = BG_KICK.channels.keys().next().value
                BG_KICK.channels.delete(oldest)
                chrome.storage.local.remove(`hs_kick_${oldest}`).catch(() => {})
              }
              bgKickFetchArchive(ch).catch(() => {})
            }
            const buf = BG_KICK.channels.get(ch)
            const existing = buf.getAll()
            // Build Sets once for O(1) per-message dedup — avoids O(n²) scan.
            const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
            const fpOf = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
            const existingFp = new Set(existing.filter((m) => !m.id).map(fpOf))
            const toAdd = []
            for (const data of list) {
              try {
                const badgeStr = Array.isArray(data.badges)
                  ? data.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
                  : ''
                const m = {
                  user: data.username || data.displayName || data.user || 'unknown',
                  text: data.content || data.message || data.text || '',
                  color: data.color || '#53fc18',
                  userId: data.senderId != null ? String(data.senderId) : '',
                  badges: badgeStr,
                  channel: ch,
                  time: data.timestamp || data.time || Date.now(),
                  platform: 'kick',
                  id: data.id || '',
                  isHistory: true,
                  replyTo: data.replyTo
                    ? {
                        user: data.replyTo.username || 'unknown',
                        text: data.replyTo.content || '',
                        id: data.replyTo.id || data.replyTo.message_id || '',
                        threadId: data.replyTo.thread_id || data.replyTo.id || data.replyTo.message_id || '',
                      }
                    : null,
                }
                if (m.id) {
                  if (existingIds.has(m.id)) continue
                  existingIds.add(m.id)
                } else {
                  const fp = fpOf(m)
                  if (existingFp.has(fp)) continue
                  existingFp.add(fp)
                }
                toAdd.push(m)
              } catch {}
            }
            if (toAdd.length > 0) {
              const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
              buf.clear()
              for (const m of all) buf.push(m)
              bgKickPersistChannel(ch)
              broadcastToTabs({ type: 'bg_kick_history_merged', channel: ch, count: toAdd.length })
              log('BG KICK backfill merged', toAdd.length, 'msgs for', ch)
            }
          }
        } catch {}
        break

      case 'chat:origin_broadcast':
        // User sent a chat message from the heatsync.org chat-tile on a
        // different device — fan out to all tabs so multichat can tag the
        // upcoming platform-relay echo with [H] instead of [T]/[K].
        wsDebugNote('origin_bcast', (msg.text || '').slice(0, 24))
        broadcastToTabs({
          type: 'chat_origin_broadcast',
          text: msg.text,
          channel: msg.channel,
          origin: msg.origin || 'heatsync',
          // sendId: server stamps it since 25646584 (site-side fold); carried
          // through so the multichat fold can key on it instead of bare text.
          sendId: msg.sendId || '',
          ts: msg.ts || Date.now(),
        })
        break

      case 'yt:relay_send':
        // Server is asking us to DOM-inject text into youtube.com's live chat.
        // Find a tab on this videoId, hand off to youtube-content's existing
        // youtube_send_relay path, ack back over the WS so the originating
        // website socket knows whether it landed.
        ;(async () => {
          const reqId = msg.reqId
          const videoId = msg.videoId
          const text = msg.text
          let ok = false
          let error
          let ytUsername
          try {
            if (!videoId || typeof videoId !== 'string') {
              error = 'invalid_video_id'
            } else if (!text || typeof text !== 'string' || text.length === 0 || text.length > 200) {
              error = 'invalid_text'
            } else {
              // MUST match this exact videoId — youtube send is DOM-injected
              // into the targeted tab, so the wrong tab would post into a
              // DIFFERENT stream's chat. No fallback to tabs[0] (unlike kick,
              // whose send is channel-parameterized by session, tab-agnostic).
              const tabs = await browser.tabs.query({ url: '*://*.youtube.com/*' }).catch(() => [])
              const matching = tabs.find((t) => (t.url || '').includes(`v=${videoId}`))
              if (!matching) {
                error = 'no_youtube_tab'
              } else {
                const result = await browser.tabs
                  .sendMessage(matching.id, {
                    type: 'youtube_send_relay',
                    text,
                    awaitConfirm: true,
                  })
                  .catch((e) => ({ ok: false, error: e?.message || 'tab_send_failed' }))
                ok = !!result?.ok
                error = result?.error
                ytUsername = result?.ytUsername
              }
            }
          } catch (e) {
            error = e?.message || 'unknown'
          } finally {
            wsSendDirect({ type: 'yt:relay_ack', reqId, ok, ytUsername, error })
          }
        })()
        break

      case 'kick:relay_send':
        // Server is asking us to send a chat message through a kick.com tab.
        // Unlike the YouTube relay above, Kick send is channel-parameterized
        // (channelId + session XSRF cookie) — the tab does NOT need to be on
        // that channel's page, so ANY kick.com tab works as the messaging
        // origin. Reuses the same resolve/send helpers as the local
        // kick_resolve_channel / kick_send_message runtime-message flow.
        ;(async () => {
          const reqId = msg.reqId
          const channel = msg.channel
          const text = msg.text
          let ok = false
          let error
          try {
            if (!channel || typeof channel !== 'string') {
              error = 'invalid_channel'
            } else if (!text || typeof text !== 'string' || text.length === 0 || text.length > 500) {
              error = 'invalid_text'
            } else {
              const resolved = await resolveKickChannelIdBg(channel.toLowerCase())
              if (!resolved.channelId) {
                error = 'no_channel'
              } else {
                const result = await sendKickMessageViaTab(resolved.channelId, text)
                ok = !!result?.ok
                error = result?.error
              }
            }
          } catch (e) {
            error = e?.message || 'unknown'
          } finally {
            wsSendDirect({ type: 'kick:relay_ack', reqId, ok, error })
          }
        })()
        break

      case 'kick-sub-event':
        // Relay Kick subscription events to content scripts
        broadcastToTabs({
          type: 'kick_sub_event',
          channel: msg.channel,
          eventType: msg.eventType,
          username: msg.username,
          months: msg.months,
          gifter: msg.gifter,
          giftees: msg.giftees,
          message: msg.message,
        })
        break

      case 'kick-kicks-event':
        // Relay KICKs gifted events to content scripts
        broadcastToTabs({
          type: 'kick_kicks_event',
          channel: msg.channel,
          username: msg.username,
          amount: msg.amount,
          giftName: msg.giftName,
          message: msg.message,
        })
        break

      case 'stream:update':
      case 'stream:online':
      case 'stream:offline': {
        // Dedup: same channel+event within 60s (prevents dupes from stream:* and follow:stream:*)
        const streamKey = `${msg.channel}:${msg.type}:${msg.game || ''}`
        const streamNow = Date.now()
        if (wsStreamEventDedup.has(streamKey) && streamNow - wsStreamEventDedup.get(streamKey) < 60000) break
        wsStreamEventDedup.set(streamKey, streamNow)
        if (wsStreamEventDedup.size > 100) {
          for (const [k, t] of wsStreamEventDedup) {
            if (streamNow - t > 60000) wsStreamEventDedup.delete(k)
          }
        }
        broadcastToTabs({
          type: 'stream_event',
          eventType: msg.type,
          platform: msg.platform,
          channel: msg.channel,
          game: msg.game || '',
          title: msg.title || '',
          prevGame: msg.prevGame || '',
          prevTitle: msg.prevTitle || '',
          isLive: msg.isLive,
        })
        break
      }

      case 'stream:redeem':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:redeem',
          platform: msg.platform,
          channel: msg.channel,
          user: msg.user || '',
          title: msg.title || '',
          cost: msg.cost || 0,
        })
        break

      case 'stream:raid':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:raid',
          platform: msg.platform,
          channel: msg.channel,
          target: msg.target || '',
          viewers: msg.viewers || 0,
        })
        break

      case 'stream:hype-start':
      case 'stream:hype-end':
        broadcastToTabs({
          type: 'stream_event',
          eventType: msg.type,
          platform: msg.platform,
          channel: msg.channel,
          level: msg.level || 0,
        })
        break

      case 'stream:sub-gift':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:sub-gift',
          platform: msg.platform,
          channel: msg.channel,
          user: msg.user || '',
          count: msg.count || 0,
        })
        break

      case 'follow:stream:update':
      case 'follow:stream:online':
      case 'follow:stream:offline':
        handleFollowStreamEvent(msg)
        break

      case 'follow:colors':
        cachedFollowColors = msg.colors || {}
        broadcastToTabs({
          type: 'follow_colors',
          colors: cachedFollowColors,
        })
        break

      case 'follow:history':
        cachedFollowHistory = msg.events || []
        broadcastToTabs({
          type: 'follow_history',
          events: cachedFollowHistory,
        })
        break

      case 'follow:live:snapshot':
        handleFollowLiveSnapshot(msg)
        break

      case 'user:heat_batch_update': {
        // Server pushes heat updates every 60s for users whose heat changed.
        // Forward to tabs so content.js can update its username-keyed heat cache
        // without polling /api/users/heat. Drops the polled endpoint volume to
        // near-zero in steady state.
        const updates = Array.isArray(msg.updates) ? msg.updates : []
        if (updates.length > 0) {
          broadcastToTabs({ type: 'heat_batch_update', updates })
        }
        break
      }

      // Server-synced mute list — fired when the user mutes/unmutes on heatsync.org
      // (REST /api/mutes) which broadcasts these WS events to all of the user's sockets.
      case 'mute:added': {
        const u = msg.username?.toLowerCase()
        if (u) {
          const rawExp = msg.expires_at
          const expiresAt = rawExp ? new Date(rawExp).getTime() : null
          if (!mutedUsers.has(u)) {
            mutedUsers.set(u, expiresAt)
            persistMutedUsers()
            broadcastToTabs({ type: 'user_muted', username: u, expiresAt })
            log(' mute:added from server:', u)
          }
        }
        break
      }

      case 'mute:removed':
      case 'mute:expired': {
        const u = msg.username?.toLowerCase()
        if (u && mutedUsers.has(u)) {
          mutedUsers.delete(u)
          persistMutedUsers()
          broadcastToTabs({ type: 'user_unmuted', username: u })
          log(' mute:removed/expired from server:', u)
        }
        break
      }

      case 'mute:cleared': {
        if (mutedUsers.size > 0) {
          mutedUsers.clear()
          persistMutedUsers()
          broadcastToTabs({ type: 'mutes_cleared' })
          log(' mute:cleared from server')
        }
        break
      }

      // Cross-device settings sync (partial patch variant).
      // ui-state:update covers the full-state fanout; settings:patch/delete
      // cover incremental edits from /api/settings on heatsync.org.
      case 'settings:patch': {
        if (msg.patches && typeof msg.patches === 'object') {
          const { sync: cleanPatch, overflow } = splitIncomingUiState(msg.patches)
          const patchKeys = Object.keys(cleanPatch)
          const overflowKeys = Object.keys(overflow)
          if (patchKeys.length > 0) {
            log(' settings:patch received:', patchKeys)
            uiSettingsRmw((ui) => sanitizeUiSettings({ ...ui, ...cleanPatch }))
          }
          if (overflowKeys.length > 0) {
            log(' settings:patch received (overflow):', overflowKeys)
            browser.storage.local.set(overflow).catch(() => {})
          }
          if (patchKeys.length > 0 || overflowKeys.length > 0) {
            broadcastToTabs({ type: 'ui_state_update', state: cleanPatch })
          }
        }
        break
      }

      // v1.6 cross-device sync for column-stored prefs (PATCH /api/user/settings).
      // Server broadcasts this to every WS-connected device for the user, so a
      // toggle flipped in tab A mirrors instantly in tab B / desktop 2 / phone,
      // without polling. The chrome.storage.local write triggers the existing
      // onChanged listener which updates BG globals + every content-script tab's
      // local mirrors. The gate (!== current) makes this a no-op for the
      // originating tab (click handler already updated before WS round-trip).
      case 'user_settings:update': {
        let settingsChanged = false
        if (typeof msg.show_sexual_emotes === 'boolean' && msg.show_sexual_emotes !== viewerShowSexual) {
          log(' user_settings:update received: show_sexual_emotes →', msg.show_sexual_emotes)
          viewerShowSexual = msg.show_sexual_emotes
          browser.storage.local.set({ viewer_show_sexual: viewerShowSexual }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_gore_emotes === 'boolean' && msg.show_gore_emotes !== viewerShowGore) {
          log(' user_settings:update received: show_gore_emotes →', msg.show_gore_emotes)
          viewerShowGore = msg.show_gore_emotes
          browser.storage.local.set({ viewer_show_gore: viewerShowGore }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_weapon_emotes === 'boolean' && msg.show_weapon_emotes !== viewerShowWeapon) {
          log(' user_settings:update received: show_weapon_emotes →', msg.show_weapon_emotes)
          viewerShowWeapon = msg.show_weapon_emotes
          browser.storage.local.set({ viewer_show_weapon: viewerShowWeapon }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_drug_emotes === 'boolean' && msg.show_drug_emotes !== viewerShowDrug) {
          log(' user_settings:update received: show_drug_emotes →', msg.show_drug_emotes)
          viewerShowDrug = msg.show_drug_emotes
          browser.storage.local.set({ viewer_show_drug: viewerShowDrug }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_hate_emotes === 'boolean' && msg.show_hate_emotes !== viewerShowHate) {
          log(' user_settings:update received: show_hate_emotes →', msg.show_hate_emotes)
          viewerShowHate = msg.show_hate_emotes
          browser.storage.local.set({ viewer_show_hate: viewerShowHate }).catch(() => {})
          settingsChanged = true
        }
        if (settingsChanged) {
          // Invalidate cross-user batch caches + refetch own inventory so the
          // chat repaints with the new filter immediately, not at the next
          // channel switch. Mirrors what the originating tab's click handler
          // does after PATCH success.
          Promise.all([fetchEmoteInventory(), fetchBlockedEmotes()]).catch(() => {})
          // Drop sender-emote LRU so next message render re-fetches with the
          // new filter params. Same cache the inventory-block path uses
          // (globalThis.__senderEmoteCache), guarded for lazy init order.
          try {
            if (globalThis.__senderEmoteCache?.clear) globalThis.__senderEmoteCache.clear()
          } catch {}
        }
        break
      }

      // Server-evaluated mention rule match — show inline notif in multichat overlay.
      case 'mention:rule-match': {
        const d = msg.data
        if (d && typeof d === 'object') {
          broadcastToTabs({
            type: 'mention_rule_match',
            ruleId: d.ruleId,
            pattern: String(d.pattern || '').slice(0, 200),
            channel: String(d.channel || '').slice(0, 50),
            platform: String(d.platform || '').slice(0, 20),
            username: String(d.username || '').slice(0, 50),
            snippet: String(d.snippet || '').slice(0, 200),
          })
          log(' mention:rule-match:', d.pattern, 'in', d.channel)
        }
        break
      }

      // EventSub fan-out — server pushes channel events subscribed via eventsub:subscribe.
      // Translate into the same stream_event shape the existing renderers expect.

      // AutoMod hold-queue — server pushes a held message for a channel this
      // user moderates (EventSub AutoMod + Helix, server-side). Trim/coerce
      // every field — never trust the wire — same discipline as eventsub:event.
      case 'automod:hold': {
        broadcastToTabs(normalizeAutomodHold(msg))
        break
      }

      // Resolution update for a held message — approved/denied/expired, by
      // this mod or any other. Ext matches it to a rendered row by msgId.
      case 'automod:update': {
        broadcastToTabs({
          type: 'automod_update',
          broadcasterId: String(msg.broadcasterId || ''),
          broadcasterLogin: String(msg.broadcasterLogin || '').toLowerCase(),
          msgId: String(msg.msgId || ''),
          status: msg.status === 'approved' || msg.status === 'denied' ? msg.status : 'expired',
          modLogin: String(msg.modLogin || ''),
        })
        break
      }

      case 'error':
        break

      default:
        log(' Unknown message type:', msg.type)
    }
  } catch (err) {
    console.error('[HS] handleWSMessage error:', err.message, 'type:', msg?.type)
  }
}

// Relay a batch of YouTube chat messages to every Twitch/Kick/YT tab.
// Extracted out of handleWSMessage's 'youtube:chat' case so the yt innertube
// fallback tap (see ~12060) can feed it too — fromTap:true batches use the
// EXACT same routing/dedup/broadcast path a server-relay batch would.
// !fromTap && msg.videoId stamps _ytTapLastDelivery: a real primary just
// delivered, so the tap's silence clock resets. Tap-fed batches must NOT
// stamp — that would be the tap feeding its own "primary is healthy" signal
// and it would never stand down.
function handleYoutubeChatBatch(msg, { fromTap = false } = {}) {
  if (!fromTap && msg.videoId) _ytTapLastDelivery.set(msg.videoId, Date.now())
  // Relay YouTube chat messages to all Twitch/Kick tabs
  if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
    // Union of server-echoed channelId and every local binding — the
    // server's per-socket map is single-valued, so its echo alone would
    // miss a second binding to the same stream.
    const bound = new Set(ytChannelsFor(msg.videoId))
    if (msg.channelId) {
      bound.add(msg.channelId)
      if (msg.videoId) setYtVideoChannel(msg.videoId, msg.channelId)
    }
    // Pending-subscribe attribution is ambiguous when multiple subscribes are
    // in flight (server may resolve them in any order). Only attribute when
    // exactly one is pending — otherwise fall through to 'global' and let
    // the eventual youtube:status event correct the mapping. This trades a
    // brief routing miss for the much worse cross-channel chat leak that
    // happens when LIFO pop guesses wrong.
    if (!bound.size && msg.videoId && pendingYtSubscribes.length === 1) {
      const pend = pendingYtSubscribes.shift()
      bound.add(pend.channelId)
      setYtVideoChannel(msg.videoId, pend.channelId)
    }
    // A stale fallback binding (persisted by an older build) alongside a
    // real one would fan every message out twice.
    if (bound.size > 1) bound.delete(YT_FALLBACK_CHANNEL)
    const channelIds = bound.size ? [...bound] : [YT_FALLBACK_CHANNEL]

    // Use real ytMsg.timestamp for both replay and live. Mellen's
    // ordering rule: every msg lands at its true chronological position
    // via fairMerge's full sort. live YT msgs may appear slightly above
    // the most-recent twitch msg if YT's timestamp is older — that's
    // chronologically correct, not a bug. Backfill ensures hard-refresh
    // accuracy: msgs from 30 min ago slot into the chat at 30 min ago.
    const sorted = msg.messages.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    const isReplay = !!msg.replay
    const buildPayload = (ytMsg, channelId) => ({
      type: 'youtube_chat_message',
      videoId: msg.videoId,
      channelId,
      id: ytMsg.id || undefined, // innertube id — end-to-end yt dedup key
      user: ytMsg.user,
      text: ytMsg.text,
      color: ytMsg.color || '#ff0000',
      time: ytMsg.timestamp || Date.now(),
      platform: 'youtube',
      emotes: ytMsg.emotes || [],
      msgType: ytMsg.type,
      amount: ytMsg.amount || '',
      scColor: ytMsg.scColor || '',
      sticker: ytMsg.sticker || null,
      avatar: ytMsg.avatar || undefined,
      badges: ytMsg.badges || undefined,
      systemMsg: ytMsg.systemMsg || undefined,
      // author's UC… channel id — yt_<id> paint/identity lookups. NEVER
      // put this in userId (twitch-space only, see paints.js ID-SPACE
      // SAFETY) — it rides its own field.
      authorChannelId: ytMsg.authorChannelId || undefined,
      // Server-enriched third-party emote refs (name→{url,provider,zeroWidth}) —
      // sender inventory resolved server-side; renders without a per-sender
      // fetch. Server-fed only (absent on the innertube fallback tap).
      hsEmotes: ytMsg.hsEmotes || undefined,
      source: 'server',
      replay: isReplay,
    })
    // Bulk dispatch. content-script's social.js routes:
    //   replay → ingestReplayYtMsg (bulk-buffer + 1 microtask render)
    //   live   → enqueueYtForPacing (per-channel 60-400ms cadence)
    for (const ytMsg of sorted) {
      for (const channelId of channelIds) {
        const payload = buildPayload(ytMsg, channelId)
        try {
          bgYtIngest(payload)
        } catch {}
        broadcastToTabs(payload)
      }
    }
  }
}

// Reconnect with exponential backoff
function scheduleReconnect() {
  if (hsWsIdleClosed) return // Deliberate idle close — a returning tab reconnects
  if (authFailedBlock) return // Auth failed — don't loop
  if (reconnectTimer) return // Already scheduled
  // Don't burn retries against a known-dead network — the online listener
  // will fire a fresh connect when connectivity comes back.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    log(' Skipping reconnect — navigator.onLine is false')
    return
  }

  // If the server signalled a planned shutdown, spread reconnects across the
  // window it asked for. Consumed once — subsequent transient drops get the
  // normal exponential backoff.
  let shutdownSpread = 0
  if (pendingReconnectSpreadMs > 0) {
    shutdownSpread = Math.random() * pendingReconnectSpreadMs
    pendingReconnectSpreadMs = 0
  }

  const jitter = Math.random() * 1000
  // Capped at 15s (was 30s) — long-running stream sessions can't tolerate
  // half-minute gaps when recovering from a transient network blip.
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000) + jitter + shutdownSpread
  reconnectAttempts++
  log(` Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`)

  // After 3 consecutive failures, surface a "down" banner to UIs.
  // Cleared in socket.onopen when we reconnect.
  if (reconnectAttempts === 3) {
    broadcastToTabs({ type: 'api_status', source: 'heatsync', state: 'down' })
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWebSocket()
  }, delay)
}

// Join channel room for emote broadcasting
async function joinChannel(platform, channelName, channelId = null, senderTabId = null) {
  const channelKey = `${platform}/${channelName}`
  if (senderTabId) {
    tabChannels.set(senderTabId, { channel: channelKey, channelOwner: null })
    saveTabChannels()
  }
  log(' 🚪 Setting channel:', channelKey, 'id:', channelId, 'tab:', senderTabId)

  // Fetch channel owner's emotes (7TV EventAPI subscription happens inside)
  fetchChannelOwnerEmotes(channelName, channelId, platform).catch((err) =>
    console.warn('[heatsync-ext] fetchChannelOwnerEmotes fetch failed:', err?.message),
  )

  // Ensure we're connected first
  if (!isSocketOpen()) {
    await connectWebSocket()
  }

  // Always send channel:join (wsSend queues if not ready)
  wsSend({ type: 'channel:join', platform, channel: channelName })
  log(' 🚪 Joined channel:', channelKey)
}

// Broadcast emote usage - returns success status
function broadcastEmoteUsage(emoteName, emoteHash, senderTabId = null) {
  const senderChannel = senderTabId ? getTabChannel(senderTabId) : null
  const channelStr = senderChannel || null
  if (!channelStr) return { success: false, reason: 'no_channel' }
  if (!isSocketOpen() || !isAuthenticated) {
    log(
      ' ⚠️ Cannot broadcast emote - socket open:',
      isSocketOpen(),
      'authenticated:',
      isAuthenticated,
      'channel:',
      channelStr,
    )
    return {
      success: false,
      reason: 'not_ready',
      socketOpen: isSocketOpen(),
      authenticated: isAuthenticated,
      channel: channelStr,
    }
  }

  // Parse platform and channel from combined format
  const [platform, channel] = channelStr.split('/')

  log(' 📤 BROADCASTING EMOTE USAGE:', {
    emoteName,
    platform,
    channel,
  })

  wsSend({
    type: 'emote:used',
    platform,
    channel,
    emoteName,
    emoteData: emoteHash ? { hash: emoteHash } : undefined,
  })

  return { success: true }
}

// Add emote to your set (for global emotes clicked in chat) - returns success/failure
async function addToInventory(emoteName, emoteHash, emoteUrl, zeroWidth = false) {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      broadcastToTabs({
        type: 'emote_add_failed',
        emoteName,
        error: 'Not logged in - visit heatsync.org to log in',
        // Distinct flag so the panel shows a one-click login nudge instead of a
        // transient error toast — the #1 reason emotes "don't work" for people.
        notLoggedIn: true,
      })
      return { success: false, error: 'Not logged in' }
    }

    log(' Adding to your set via API:', emoteName)

    // Call server API to add emote
    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes`, {
      method: 'POST',
      // Bearer-only (omit cookie): sending the cookie makes the server enforce
      // CSRF on this mutation, which the extension can't satisfy → 403/hang. The
      // Bearer token alone is CSRF-exempt (matches the working syncMuteToServer).
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        emoteUrl,
        emoteName,
        customName: emoteName,
        source: 'extension',
        sourceId: emoteHash,
        zeroWidth: !!zeroWidth,
      }),
    })

    const data = await response.json().catch(() => ({ error: `HTTP ${response.status} (non-JSON body)` }))

    if (!response.ok) {
      broadcastToTabs({
        type: 'emote_add_failed',
        emoteName,
        error: data.error || `Server error (${response.status})`,
      })
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }

    log(' ✅ Added to server inventory:', data)

    // Update local inventory immediately
    const newEmote = {
      name: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot,
      addedAt: Date.now(),
    }

    // Check if already in your set (by hash) to avoid duplicates
    // Use snapshot to prevent race with concurrent filter/reassign
    const currentInventory = [...emoteInventory]
    if (!currentInventory.some((e) => e.hash === newEmote.hash)) {
      currentInventory.push(newEmote)
      emoteInventory = currentInventory
    }

    // Broadcast success to tabs. senderKeys (from the server response) lets
    // the panel check the identity it's chatting under against the account
    // that actually received the emote — a miss means nobody else can render
    // it and the panel warns instead of lying with a local-only image.
    broadcastToTabs({
      type: 'emote_added',
      emoteName: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot,
      alreadyExists: data.alreadyExists,
      ...(Array.isArray(data.senderKeys) ? { senderKeys: data.senderKeys.slice(0, 10) } : {}),
    })

    // Also update storage for persistence
    await browser.storage.local.set({ emote_inventory: emoteInventory })

    return { success: true, slot: data.slot, hash: data.hash || emoteHash, alreadyExists: data.alreadyExists }
  } catch (error) {
    broadcastToTabs({
      type: 'emote_add_failed',
      emoteName,
      error: error.message || 'Network error',
    })
    return { success: false, error: error.message || 'Network error' }
  }
}

// Coalesce concurrent removes for the same emote — without this, two tabs
// firing the same delete pick different slots from a mid-mutation inventory
// snapshot and the wrong emote gets deleted server-side.
const _removeInFlight = new Map() // hash → Promise

// Remove emote from your set - returns success/failure
async function removeFromInventory(emoteHash, emoteName) {
  const flightKey = emoteHash || emoteName
  if (flightKey && _removeInFlight.has(flightKey)) {
    return _removeInFlight.get(flightKey)
  }
  const p = _removeFromInventoryImpl(emoteHash, emoteName)
  if (flightKey) {
    _removeInFlight.set(flightKey, p)
    p.finally(() => _removeInFlight.delete(flightKey))
  }
  return p
}

async function _removeFromInventoryImpl(emoteHash, emoteName) {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      broadcastToTabs({
        type: 'emote_remove_failed',
        emoteName,
        error: 'Not logged in',
      })
      return { success: false, error: 'Not logged in' }
    }

    log(' Removing from your set via API:', emoteName, 'hash:', emoteHash?.substring(0, 8))

    // Tell content scripts early so they suppress this emote in new messages immediately
    // This must happen BEFORE any fetchEmoteInventory() which would broadcast inventory_update.
    // Hash is forwarded so content can optimistically tier-drop existing rendered wrappers
    // before the server roundtrip completes.
    broadcastToTabs({ type: 'emote_removing', emoteName, hash: emoteHash })

    // Find slot number by hash or name
    let emote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
    if (!emote) {
      // Refetch in case local state is stale. fetchEmoteInventory has a 10s
      // throttle — bypass it here so we don't return a spurious "not in set"
      // error during the throttle window.
      log(' Emote not in local inventory, refetching...', emoteName, emoteHash?.substring(0, 8))
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      emote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (!emote) {
        broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
        broadcastToTabs({
          type: 'emote_remove_failed',
          emoteName,
          error: 'Emote not found in your set',
        })
        return { success: false, error: 'Emote not found in your set' }
      }
    }

    if (emote.slot == null) {
      // Bypass throttle here too — same reason.
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      const refreshedEmote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (refreshedEmote?.slot == null) {
        broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
        broadcastToTabs({
          type: 'emote_remove_failed',
          emoteName,
          error: 'Could not determine emote slot',
        })
        return { success: false, error: 'Could not determine emote slot' }
      }
      emote.slot = refreshedEmote.slot
    }

    const doDelete = async (slot) => {
      const resp = await fetchWithTimeout(`${API_URL}/api/user/emotes/${slot}`, {
        method: 'DELETE',
        credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
        headers: { Authorization: `Bearer ${authToken}` },
      })
      // `.catch()` covers a thrown SyntaxError, but JSON.parse('null') resolves
      // to literal null — coerce so `data.error` access can't throw a TypeError
      // and bubble up as the user-facing message.
      const d = (await resp.json().catch(() => null)) || {}
      return { resp, d }
    }

    let { resp: response, d: data } = await doDelete(emote.slot)

    // 404 here is ambiguous. The slot we read from local `emoteInventory` is
    // throttled (10s) and another tab / the move endpoint may have shifted
    // slots since — so the slot we just hit might be empty while the emote
    // is alive and well at a different slot. Without this retry path:
    //   - silent-reconcile-and-broadcast assumes "goal state already true"
    //     and drops the local row. The next 1-min inventory poll pulls the
    //     live row back from the server, the picker re-renders green, the
    //     user right-clicks again, gets 404, repeats. Whack-a-mole.
    //   - failing loud surfaces a confusing "not in set" error on an emote
    //     that visibly IS in the set.
    // So: on 404, force-bypass the inventory throttle and refetch. If the
    // emote moved, retry DELETE with the new slot (the actual destructive
    // operation the user asked for). Only treat as already-gone if the
    // fresh server view confirms the emote is genuinely absent.
    if (response.status === 404) {
      log(' DELETE 404 at slot', emote.slot, '— forcing inventory refetch to verify')
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      const fresh = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (fresh && fresh.slot != null && fresh.slot !== emote.slot) {
        log(' Slot moved:', emote.slot, '→', fresh.slot, '— retrying DELETE')
        emote = fresh
        ;({ resp: response, d: data } = await doDelete(emote.slot))
      } else if (!fresh) {
        // Server's current view: emote isn't in user's set. Local was stale
        // (optimistic add that never reconciled, missed emote_removed event,
        // another tab beat us to it). Drop the local row + broadcast so all
        // tabs flip to unadded; same end state as a successful DELETE.
        log(' Server confirms emote not in set — reconciling local state')
        emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
        await browser.storage.local.set({ emote_inventory: emoteInventory })
        broadcastToTabs({ type: 'emote_removed', emoteName, hash: emoteHash, slot: emote.slot })
        return { success: true, slot: emote.slot, reconciled: true }
      }
      // else: fresh view still maps it to the same slot the server just 404'd
      // on. That's a server-side inconsistency we can't fix from here; fall
      // through to the loud-error branch below.
    }

    if (!response.ok) {
      // Server-reported "not found in your set" after fresh refetch above
      // means truly already-gone; treat as reconcile.
      if (data.error && /not found in your set/i.test(data.error)) {
        emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
        await browser.storage.local.set({ emote_inventory: emoteInventory })
        broadcastToTabs({ type: 'emote_removed', emoteName, hash: emoteHash, slot: emote.slot })
        return { success: true, slot: emote.slot, reconciled: true }
      }
      broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
      broadcastToTabs({
        type: 'emote_remove_failed',
        emoteName,
        error: data.error || `Server error (${response.status})`,
      })
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }

    log(' ✅ Removed from server inventory:', data)

    // Update local inventory
    emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
    await browser.storage.local.set({ emote_inventory: emoteInventory })

    // Broadcast success to tabs
    broadcastToTabs({
      type: 'emote_removed',
      emoteName,
      hash: emoteHash,
      slot: emote.slot,
    })

    // Broadcast removal to other clients so they clear pending broadcasts
    // Send to all active channels
    const sentChannels = new Set()
    for (const entry of tabChannels.values()) {
      if (entry.channel && isSocketOpen() && !sentChannels.has(entry.channel)) {
        const [platform, channel] = entry.channel.split('/')
        wsSend({
          type: 'emote:removed',
          platform,
          channel,
          emoteName: emoteName,
        })
        sentChannels.add(entry.channel)
      }
    }
    if (sentChannels.size > 0) {
      log(' 📤 Broadcasted emote removal:', emoteName)
    }

    return { success: true, slot: emote.slot }
  } catch (error) {
    broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
    broadcastToTabs({
      type: 'emote_remove_failed',
      emoteName,
      error: error.message || 'Network error',
    })
    return { success: false, error: error.message || 'Network error' }
  }
}

// ========== YOUTUBE SEND BRIDGE ==========
//
// YouTube has no send API usable at scale (Data API ≈ 50 msgs/day per project),
// so a send drives a real, logged-in youtube.com tab. When the user has none
// open, we silently open a hidden, pinned live_chat tab for the EXACT stream —
// it inherits their YouTube login cookies, so send "just works" whenever they're
// signed into YouTube in Chrome. We only ever open a tab for a concrete videoId
// (never a guess) so we can never send to the wrong stream. Tabs are cached per
// videoId and reused; cleaned up when closed.
const ytBridgeTabs = new Map() // videoId → tabId
// Bridge tabs used to live forever (one pinned tab per videoId ever sent to,
// surviving stream end). Stamp use on ensure + relay; the sweep alarm removes
// idle ones. Map loss on SW restart is fine — the sweep then closes on sight.
const ytBridgeLastUsed = new Map() // videoId → ms timestamp
const YT_BRIDGE_IDLE_MS = 20 * 60 * 1000
async function sweepYtBridgeTabs() {
  const now = Date.now()
  for (const [vid, tid] of [...ytBridgeTabs]) {
    const last = ytBridgeLastUsed.get(vid) || 0
    if (now - last < YT_BRIDGE_IDLE_MS) continue
    ytBridgeTabs.delete(vid)
    ytBridgeLastUsed.delete(vid)
    await browser.tabs.remove(tid).catch(() => {})
  }
  // Orphans: #hs-bridge-marked tabs the map doesn't know (SW restarted since
  // creation). An actively-used one gets re-adopted into the map by the send
  // path's URL match before the next sweep; anything still untracked is dead.
  const tracked = new Set(ytBridgeTabs.values())
  const marked = await browser.tabs.query({ url: '*://www.youtube.com/live_chat*' }).catch(() => [])
  for (const t of marked) {
    if ((t.url || '').includes('#hs-bridge') && !tracked.has(t.id)) await browser.tabs.remove(t.id).catch(() => {})
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [vid, tid] of ytBridgeTabs) {
    if (tid === tabId) {
      ytBridgeTabs.delete(vid)
      ytBridgeLastUsed.delete(vid)
    }
  }
})

function pingYtBridge(tabId) {
  return browser.tabs.sendMessage(tabId, { type: 'youtube_bridge_ping' }).catch(() => null)
}

// Ensure a sendable live_chat tab exists for videoId; resolve when its chat
// input is present AND enabled. Returns { tabId } on ready, { tabId, error } when
// present-but-not-sendable (e.g. logged-out → 'chat_disabled'), or { error }.
// Inflight-deduped: concurrent sends for one videoId must share one creation —
// racing tabs.create calls each opened a pinned tab and orphaned the loser.
const _ytBridgeInflight = new Map() // videoId → Promise
function ensureYoutubeBridgeTab(videoId) {
  const inflight = _ytBridgeInflight.get(videoId)
  if (inflight) return inflight
  const p = _ensureYoutubeBridgeTab(videoId).finally(() => _ytBridgeInflight.delete(videoId))
  _ytBridgeInflight.set(videoId, p)
  return p
}
async function _ensureYoutubeBridgeTab(videoId) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) return { error: 'no_video' }
  let tabId = ytBridgeTabs.get(videoId)
  if (tabId != null) {
    const t = await browser.tabs.get(tabId).catch(() => null)
    if (!t) {
      ytBridgeTabs.delete(videoId)
      tabId = null
    }
  }
  if (tabId == null) {
    // #hs-bridge marks this tab as OURS: the multichat bundle sees the hash
    // and skips its entire boot. Without the marker the bridge booted a full
    // hidden popout overlay — it rebound the single __live_yt_auto__ slot to
    // the bridge's videoId (killing the watch tab's feed on WS reconnect) and
    // its overlay hid the native chat, so the "sign in here" tab we surface
    // on chat_disabled had no visible login UI.
    const created = await browser.tabs
      .create({ url: `https://www.youtube.com/live_chat?v=${videoId}#hs-bridge`, active: false, pinned: true })
      .catch(() => null)
    if (!created?.id) return { error: 'no_youtube_tab' }
    tabId = created.id
    ytBridgeTabs.set(videoId, tabId)
  }
  ytBridgeLastUsed.set(videoId, Date.now())
  // Poll for readiness — the YT SPA + auth-cookie load takes a couple seconds.
  const deadline = Date.now() + 12000
  let sawInput = false
  while (Date.now() < deadline) {
    const ping = await pingYtBridge(tabId)
    if (ping?.ok && ping.hasInput) {
      sawInput = true
      if (!ping.disabled) return { tabId }
      return { tabId, error: 'chat_disabled' } // present but logged-out / restricted
    }
    // No input + a restricted-participation banner = a terminal state
    // (subscribers-only / members-only), not "still loading" — fail fast with
    // the human reason instead of burning the full 12s into bridge_timeout.
    if (ping?.ok && !ping.hasInput && ping.restrictedMsg) {
      return { tabId, error: 'chat_restricted', reason: ping.restrictedMsg }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { tabId, error: sawInput ? 'chat_disabled' : 'bridge_timeout' }
}

// ========== COSMETICS ==========

// Handle messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender?.tab?.url || sender?.url || ''
  const isFromPopup = !sender?.tab // popup/options pages have no tab
  // Reject messages from other extensions — must originate from this extension's
  // content scripts (sender.id matches) or our own popup/options (no tab).
  const isOwnExtension = sender?.id === browser.runtime.id
  const isValidOrigin =
    isFromPopup || /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(senderUrl)
  const isValidSender = isOwnExtension && isValidOrigin

  if (!isValidSender) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }

  // Health check ping from content scripts
  if (message.type === 'extension_reload') {
    // Dev hook so an automation/page can reload the extension without manual
    // chrome://extensions clicking. Fired by content.js on receipt of
    // window.postMessage({type:'heatsync-reload-extension'}).
    log(' 🔁 extension_reload requested via page message')
    try {
      sendResponse({ ok: true })
    } catch {}
    setTimeout(() => {
      try {
        chrome.runtime.reload()
      } catch (e) {
        console.error('[heatsync] reload failed:', e)
      }
    }, 50)
    return true
  }
  if (message.type === 'resolve_twitch_id') {
    // login → numeric twitch id for content scripts. They must not fetch
    // heatsync.org themselves — CF edge bot-checks 503 cross-origin
    // content-script requests (the origin never sees them); SW fetches pass.
    ;(async () => {
      const login = String(message.login || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
      try {
        sendResponse({ id: login ? await lookupTwitchUserId(login) : null })
      } catch {
        sendResponse({ id: null })
      }
    })()
    return true
  }
  if (message.type === 'automod_watch') {
    // Register/keepalive the server-side AutoMod-hold watch for a channel this
    // user moderates (automod-queue.js sweeps its joined+modded channels on an
    // interval and calls this per channel). Throttled — see AUTOMOD_WATCH_THROTTLE_MS.
    ;(async () => {
      try {
        const broadcasterId = String(message.broadcasterId || '').replace(/[^0-9]/g, '')
        if (!broadcasterId) {
          sendResponse({ ok: false, error: 'missing broadcasterId' })
          return
        }
        const now = Date.now()
        const last = _automodWatchThrottle.get(broadcasterId) || 0
        // wantPending = a page that has just opened its queue and has nothing
        // in it. The throttle is there to keep the keepalive cheap, and it
        // does its job for the sweep — but a reload inside the window would
        // otherwise be handed no backfill at all, which is the exact case the
        // backfill exists for. One extra call per channel per page load.
        if (!message.wantPending && now - last < AUTOMOD_WATCH_THROTTLE_MS) {
          sendResponse({ ok: true, throttled: true })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          sendResponse({ ok: false, error: 'not logged in' })
          return
        }
        _automodWatchThrottle.set(broadcasterId, now)
        if (_automodWatchThrottle.size > 500) _automodWatchThrottle.delete(_automodWatchThrottle.keys().next().value)
        const res = await fetchWithTimeout(`${API_URL}/api/mod/automod-watch`, {
          method: 'POST',
          credentials: 'omit', // Bearer-only → CSRF-exempt (matches every other heatsync.org mutation)
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ broadcaster_id: broadcasterId }),
        })
        if (res.ok) {
          // The watch response carries whatever is STILL held on this channel.
          // Before this, a hold existed only in the websocket frame that
          // announced it: reload the page and the queue was empty while twitch
          // was still holding the messages. Normalized through the same
          // function as the live push so the two can't drift.
          const data = await res.json().catch(() => null)
          const pending = Array.isArray(data?.pending)
            ? data.pending
                .slice(0, 100)
                .map(normalizeAutomodHold)
                .filter((h) => h.msgId && h.broadcasterLogin)
            : []
          sendResponse({ ok: true, pending })
          return
        }
        if (res.status === 401) {
          // Two very different 401s arrive here and only one is about twitch.
          // `relink_required` means the twitch grant is missing the automod
          // scope. A BARE 401 is authRequired rejecting OUR bearer token — an
          // expired heatsync session. Reporting both as 'relink_required' sent
          // people to relink twitch over and over for a problem relinking
          // twitch cannot fix; the toast was already gated correctly, this
          // response was not.
          const data = await res.json().catch(() => null)
          if (data?.error === 'relink_required') {
            notifyAutomodRelinkOnce()
            sendResponse({ ok: false, error: 'relink_required' })
          } else {
            sendResponse({ ok: false, error: 'auth_required' })
          }
          return
        }
        log(' automod_watch failed:', res.status)
        sendResponse({ ok: false, error: 'subscribe_failed' })
      } catch (e) {
        log(' automod_watch error:', e?.message)
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'automod_action') {
    // Resolve a held message — allow/deny. automod-queue.js shows the
    // optimistic 'resolving…' state; the confirming automod:update broadcast
    // (any mod, any tab) is what actually flips the row to allowed/denied.
    ;(async () => {
      try {
        const msgId = String(message.msgId || '')
        const action = message.action === 'deny' ? 'deny' : message.action === 'allow' ? 'allow' : ''
        if (!msgId || !action) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const authToken = await getAuthCookie()
        if (!authToken) {
          // No heatsync session — OUR cookie, not the twitch grant. Answering
          // 'relink_required' here put "automod queue needs a twitch relink"
          // in front of someone whose twitch link was perfectly fine, and no
          // amount of relinking could clear it. Same split the 401 branches
          // below already make.
          sendResponse({ ok: false, error: 'auth_required' })
          return
        }
        const res = await fetchWithTimeout(`${API_URL}/api/mod/automod-action`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ msg_id: msgId, action }),
        })
        if (res.ok) {
          sendResponse({ ok: true })
          return
        }
        if (res.status === 404) {
          sendResponse({ ok: false, error: 'gone' })
        } else if (res.status === 401) {
          // Same split as automod_watch: only a server-declared
          // `relink_required` is about the twitch grant. A bare 401 is our own
          // expired session.
          const data = await res.json().catch(() => null)
          if (data?.error === 'relink_required') {
            notifyAutomodRelinkOnce()
            sendResponse({ ok: false, error: 'relink_required' })
          } else {
            sendResponse({ ok: false, error: 'auth_required' })
          }
        } else if (res.status === 403) {
          sendResponse({ ok: false, error: 'not_moderator' })
        } else {
          const data = await res.json().catch(() => null)
          sendResponse({ ok: false, error: data?.error || `http ${res.status}` })
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'network error' })
      }
    })()
    return true
  }
  if (message.type === 'ping') {
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'dbg_kick_tap') {
    // Read-only tap/relay state snapshot — reachable only from our own content
    // scripts (sender gate above); nothing secret, just routing liveness.
    try {
      sendResponse({
        enabled: KICK_PUSHER_TAP,
        wsState: _kpWs ? _kpWs.readyState : null,
        connected: _kpConnected,
        lastDataAgeMs: _kpLastData ? Date.now() - _kpLastData : null,
        channels: [..._kpChannels.entries()],
        chatroomCache: [..._kpChatroomCache.entries()],
        tap: [..._kickSrcStats.tap.entries()],
        relay: [..._kickSrcStats.relay.entries()],
        tapUnmatched: _kickSrcStats.tapUnmatched,
        // Mode-banner chain liveness — a swallowed ChatroomUpdatedEvent is
        // otherwise invisible (the exact silent failure that cost this session
        // a debug loop). events/broadcasts counters + last error surface it.
        modes: {
          slugs: [..._kpModes.keys()],
          events: _kpModeStats.events,
          broadcasts: _kpModeStats.broadcasts,
          baselines: _kpModeStats.baselines,
          lastError: _kpModeStats.lastError,
        },
        // Celebration events off the tap. `dropped` non-zero means kick is
        // shipping a payload shape we don't parse — the one failure mode that
        // would otherwise look identical to "nobody subscribed".
        events: { ..._kpEventStats },
      })
    } catch (e) {
      sendResponse({ error: e?.message || 'unknown' })
    }
    return true
  }

  // videoId → @handle, for naming a tab that was added by pasting a watch URL.
  // Thin wrapper over the same cached oEmbed lookup the subscribe path uses.
  if (message.type === 'yt_channel_handle') {
    const vid = String(message.videoId || '')
    if (!/^[\w-]{11}$/.test(vid)) {
      sendResponse({ handle: null })
      return true
    }
    getYtChannelHandle(vid)
      .then((handle) => sendResponse({ handle: handle || null }))
      .catch(() => sendResponse({ handle: null }))
    return true
  }

  // Chatroom id for a kick slug — used by the page-side fallback pusher
  // connection (kick-native-tap.js) so it can subscribe chatrooms.<id>.v2
  // without its own kick API round-trip when BG already knows the answer.
  if (message.type === 'kick_chatroom_id') {
    const slug = (message.slug || '').toLowerCase()
    sendResponse({ id: _kpChannels.get(slug) ?? _kpChatroomCache.get(slug) ?? null })
    return true
  }

  // Serialized ui_settings patch. Content scripts must NOT get→merge→set the
  // key themselves — they race this SW's uiSettingsRmw chain (and each other),
  // and the loser's write is silently overwritten. Keys are governed by the
  // settings registry via sanitizeUiSettings, so only the shape is checked here.
  if (message.type === 'ui_settings_rmw') {
    const patch = message.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      sendResponse({ ok: false, error: 'patch must be a plain object' })
      return true
    }
    uiSettingsRmw((ui) => sanitizeUiSettings({ ...ui, ...patch }))
      .then((r) => sendResponse(r?.ok ? { ok: true } : { ok: false, error: r?.error || 'write failed' }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    return true
  }

  // Content-script error appends. Same rationale as ui_settings_rmw: the SW
  // owns the serialized hs_errors get→concat→set chain, so unserialized
  // content-script writes would drop whole batches.
  if (message.type === 'report_error') {
    try {
      const rep = globalThis.__hsErrorReporterSw
      const errs = Array.isArray(message.errors) ? message.errors.slice(0, 50) : []
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
      for (const r of errs) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue
        rep?.capture({
          ts: typeof r.ts === 'number' ? r.ts : Date.now(),
          type: str(r.type, 20) || 'error',
          plat: str(r.plat, 20) || 'other',
          ver: str(r.ver, 20) || 'unknown',
          url: str(r.url, 200),
          msg: str(r.msg, 500),
          stack: str(r.stack, 2000),
          file: str(r.file, 200),
          line: typeof r.line === 'number' ? r.line : 0,
        })
      }
    } catch (_) {}
    sendResponse({ ok: true })
    return true
  }

  // Cached server health (kill-switch + version-floor). Fail-open default if
  // we've never successfully fetched. Synchronous content-script callers use
  // this to early-bail before painting any UI.
  if (message.type === 'get_health') {
    getCachedHealth()
      .then((h) => sendResponse({ ok: true, health: h }))
      .catch(() => sendResponse({ ok: true, health: HEALTH_DEFAULT }))
    return true
  }

  // Diag snapshot for bug reports — bundled with errors on copy.
  if (message.type === 'get_diag') {
    buildDiagSnapshot()
      .then((d) => sendResponse({ ok: true, diag: d }))
      .catch(() => sendResponse({ ok: false, diag: null }))
    return true
  }
  // Ensure in-memory state is populated before any handler reads it (MV3 SW restart race)
  ;(async () => {
    if (initPromise) await initPromise
    handleMessage(message, sender, sendResponse)
  })().catch((err) => {
    console.error('[heatsync-ext] onMessage dispatch error:', err)
    try {
      sendResponse({ ok: false, error: String(err?.message || err) })
    } catch {}
  })
  return true
})

async function handleMessage(message, sender, sendResponse) {
  // YouTube chat relay — forward native-tap copies to every multichat host.
  // youtube-content.js scrapes the YT live_chat iframe and sends `channelId: videoId`.
  // Remap to the real extension channelId so the receiving tab can route — otherwise
  // messages bucket under a videoId key that no tab is listening on.
  // youtube.com tabs are included (minus the SENDER tab, whose overlay already
  // gets the same-tab copies directly) so a yt surface watching stream A still
  // sees stream B's chat when the server relay goes quiet — the DOM tap is the
  // yt resilience line, and innertube-id dedup drops the copies while the
  // relay is healthy.
  if (message.type === 'youtube_chat_message' && !message.source) {
    const vId = message.videoId
    // DOM tap is the second primary — its deliveries count the same as the
    // server relay for the innertube fallback tap's silence clock.
    if (vId) _ytTapLastDelivery.set(vId, Date.now())
    const senderTabId = sender?.tab?.id
    let mapped = ytChannelsFor(vId)
    if (!mapped.length && vId && vId === activeYoutubeVideoId) mapped = ['__live_yt_auto__']
    const relays = mapped.length
      ? mapped.map((cid) => (cid !== message.channelId ? { ...message, channelId: cid } : message))
      : [message]
    browser.tabs
      .query({ url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://www.youtube.com/*'] })
      .then((tabs) => {
        for (const tab of tabs) {
          if (tab.id === senderTabId) continue
          for (const relay of relays) browser.tabs.sendMessage(tab.id, relay).catch(() => {})
        }
      })
      .catch(() => {})
    sendResponse({ ok: true })
    return true
  }

  // YouTube moderator deletion — relay to all extension tabs so they can dim
  if (message.type === 'youtube_msg_deleted') {
    const bound = ytChannelsFor(message.videoId)
    for (const channelId of bound.length ? bound : ['global']) {
      broadcastToTabs({
        type: 'youtube_msg_deleted',
        videoId: message.videoId,
        channelId,
        user: message.user,
        reason: message.reason || '',
      })
    }
    sendResponse({ ok: true })
    return true
  }

  // Link preview — proxy through heatsync.org server (avoids CORS)
  if (message.type === 'fetch_link_preview') {
    const url = message.url
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse(null)
      return true
    }
    // Block internal/private URLs from being proxied through the server
    try {
      const parsed = new URL(url)
      // hostname keeps IPv6 brackets ([::1]) — strip so the v6 checks match
      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      if (
        /^(localhost|127\.|0\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) ||
        /^(::1$|::ffff:|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(host) ||
        /^(\d+|0x[0-9a-f]+)$/.test(host)
      ) {
        sendResponse(null)
        return true
      }
    } catch {
      sendResponse(null)
      return true
    }
    fetch(`${LINK_PREVIEW_API}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000),
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true
  }

  // Proxy recent-messages backfill through SW — cross-origin content-script
  // fetches trip Cloudflare bot heuristics (edge 503 before the origin ever
  // sees them); SW requests pass clean.
  if (message.type === 'fetch_recent_messages') {
    const ch = String(message.channel || '').toLowerCase()
    if (!/^[a-z0-9_]{1,25}$/.test(ch)) {
      sendResponse(null)
      return true
    }
    fetch(`https://heatsync.org/api/recent-messages/${ch}?limit=500`, {
      signal: AbortSignal.timeout(15000),
      credentials: 'omit',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true
  }

  // Proxy /api/embed/resolve through SW — content-script fetches in MV3 still
  // get blocked by CORS even with host_permissions; SW bypasses it.
  // 1hr in-memory cache keyed by URL so re-renders (tab switch, scrollback)
  // don't re-hit the heatsync server. Cache cleared on SW restart, which is
  // fine — this is a UX cache, not correctness.
  if (message.type === 'fetch_embed_resolve') {
    const url = message.url
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse(null)
      return true
    }
    const cached = _embedResolveCache.get(url)
    if (cached && Date.now() - cached.ts < EMBED_RESOLVE_TTL) {
      sendResponse(cached.data)
      return true
    }
    fetch(`https://heatsync.org/api/embed/resolve?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000),
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          _embedResolveCache.set(url, { data, ts: Date.now() })
          // LRU trim — Map iteration order is insertion order
          if (_embedResolveCache.size > 500) {
            const first = _embedResolveCache.keys().next().value
            _embedResolveCache.delete(first)
          }
        }
        sendResponse(data)
      })
      .catch(() => sendResponse(null))
    return true
  }

  // Channel banner — multi-platform (twitch/kick/youtube). All routes return
  // { bannerUrl, offlineUrl, accent, profileUrl } and respect a shared 12h LRU
  // keyed by `${platform}:${login}`. Banners rarely change so a stale URL is
  // tolerable; cache also survives SW wake (in-memory only by design — this is
  // pure UX-warming, not correctness state).
  if (message.type === 'fetch_channel_banner') {
    const platform = String(message.platform || '').toLowerCase()
    let username = String(message.username || '').toLowerCase()
    if (!platform || !username) {
      sendResponse(null)
      return true
    }
    // Sanitization differs per platform — Twitch is the strictest (a–z, 0–9,
    // underscore); Kick allows hyphens; YouTube handles and channel IDs allow
    // a-z, 0-9, dot, dash, underscore. Be conservative but permissive enough
    // to handle real names without false-negatives.
    if (platform === 'twitch') username = username.replace(/[^a-z0-9_]/g, '')
    else if (platform === 'kick') username = username.replace(/[^a-z0-9_-]/g, '')
    else if (platform === 'youtube') username = username.replace(/[^a-z0-9._-]/g, '')
    else {
      sendResponse(null)
      return true
    }
    if (!username) {
      sendResponse(null)
      return true
    }
    const cacheKey = `${platform}:${username}`
    const cached = _channelBannerCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CHANNEL_BANNER_TTL) {
      sendResponse(cached.data)
      return true
    }
    const handle = (data) => {
      _channelBannerCache.set(cacheKey, { data, ts: Date.now() })
      if (_channelBannerCache.size > CHANNEL_BANNER_MAX) {
        _channelBannerCache.delete(_channelBannerCache.keys().next().value)
      }
      sendResponse(data)
    }
    // A network blip / timeout / 5xx / 429 is NOT proof the channel has no
    // banner. Caching null here would blank the banner for 12h (CHANNEL_BANNER_TTL)
    // with no retry — same negative-cache-poisoning the cosmetics + sender-emote
    // fetches below explicitly guard against. Respond null (no banner this time)
    // but leave the cache empty so the next hover retries.
    const handleTransient = () => sendResponse(null)
    if (platform === 'twitch') {
      // Public GQL — kimne client id is the same one twitch.tv uses, no token
      // required for read-only profile fields.
      fetchWithTimeout(
        'https://gql.twitch.tv/gql',
        {
          method: 'POST',
          headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{ user(login: "${username}") { bannerImageURL offlineImageURL primaryColorHex profileImageURL(width: 600) } }`,
          }),
        },
        5000,
      )
        .then(async (r) => {
          if (!r.ok) {
            // 404 = definitively no such channel (safe to cache the negative);
            // 5xx / 429 / anything else = transient, must not poison the cache.
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const json = await r.json()
          const u = json?.data?.user
          if (!u) {
            handle(null)
            return
          }
          handle({
            bannerUrl: u.bannerImageURL || null,
            offlineUrl: u.offlineImageURL || null,
            accent: u.primaryColorHex ? `#${u.primaryColorHex.replace(/^#/, '')}` : null,
            profileUrl: u.profileImageURL || null,
            sourcePlatform: 'twitch',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    if (platform === 'kick') {
      // Kick public v2 — channel slug → banner_image.url and user.profile_pic.
      // Kick provides no accent so we default to the platform brand green.
      fetchWithTimeout(
        `https://kick.com/api/v2/channels/${encodeURIComponent(username)}`,
        {
          headers: { Accept: 'application/json' },
        },
        5000,
      )
        .then(async (r) => {
          if (!r.ok) {
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const j = await r.json()
          if (!j) {
            handle(null)
            return
          }
          const banner = j.banner_image?.url || j.banner_image?.responsive?.split(' ')[0] || null
          const offline = j.offline_banner_image?.src || j.offline_banner_image?.url || null
          handle({
            bannerUrl: banner,
            offlineUrl: offline,
            accent: '#53fc18',
            profileUrl: j.user?.profile_pic || null,
            sourcePlatform: 'kick',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    if (platform === 'youtube') {
      // YouTube has no documented public banner API without OAuth/key, so we
      // fetch the channel page HTML and pull bannerExternalUrl out of the
      // embedded ytInitialData JSON. Works for both @handles and UC* channel
      // IDs because youtube.com routes both to the same page shape.
      const path = /^uc[a-z0-9_-]{20,}$/i.test(username) ? `/channel/${username}` : `/@${username}`
      fetchWithTimeout(
        `https://www.youtube.com${path}`,
        {
          headers: { Accept: 'text/html', 'Accept-Language': 'en' },
        },
        8000,
      )
        .then(async (r) => {
          if (!r.ok) {
            if (r.status === 404) handle(null)
            else handleTransient()
            return
          }
          const html = await r.text()
          if (!html) {
            handle(null)
            return
          }
          let banner = null
          // First match wins — bannerExternalUrl is the desktop hero banner;
          // banner.thumbnails[] (last entry = highest res) is the mobile path.
          const m1 = html.match(/"bannerExternalUrl":"([^"]+)"/)
          if (m1) banner = m1[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
          if (!banner) {
            const all = [...html.matchAll(/"banner":\s*\{\s*"thumbnails":\s*\[([^\]]+)\]/g)]
            for (const m of all) {
              const last = [...m[1].matchAll(/"url":"([^"]+)"/g)].pop()
              if (last) {
                banner = last[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
                break
              }
            }
          }
          let avatar = null
          const av = html.match(/"avatar":\s*\{\s*"thumbnails":\s*\[\s*\{\s*"url":"([^"]+)"/)
          if (av) avatar = av[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/')
          if (!avatar) {
            const og = html.match(/<meta property="og:image" content="([^"]+)"/)
            if (og) avatar = og[1]
          }
          handle({
            bannerUrl: banner,
            offlineUrl: null,
            accent: '#ff0000', // doctrine: --hs-plat-youtube
            profileUrl: avatar,
            sourcePlatform: 'youtube',
          })
        })
        .catch(() => handleTransient())
      return true
    }
    sendResponse(null)
    return true
  }

  // PronounDB lookup — self-declared pronouns for a Twitch numeric user id.
  // Content scripts can't hit pronoundb.org directly (CSP connect-src is
  // extension-declared, and cross-origin fetch from a page-world content
  // script is blocked regardless) — this is the only fetch path. Response:
  // { pronouns: string[] } | null. 24h LRU cache above absorbs repeat hovers.
  if (message.type === 'fetch_pronouns') {
    const platform = String(message.platform || '').toLowerCase()
    const userId = String(message.userId || '').replace(/[^0-9]/g, '')
    // pronoundb v2 supports discord/github/minecraft/twitch/twitter — no
    // kick or youtube, so anything else is a guaranteed miss. Bail before
    // spending a network round-trip.
    if (platform !== 'twitch' || !userId) {
      sendResponse(null)
      return true
    }
    const cacheKey = `${platform}:${userId}`
    const cached = _pronounCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < PRONOUN_TTL) {
      sendResponse(cached.data)
      return true
    }
    fetchWithTimeout(
      `https://pronoundb.org/api/v2/lookup?platform=${platform}&ids=${encodeURIComponent(userId)}`,
      { headers: { Accept: 'application/json' } },
      5000,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const words = json?.[userId]?.sets?.en
        const data = Array.isArray(words) && words.length ? { pronouns: words.slice(0, 3) } : null
        _pronounCache.set(cacheKey, { data, ts: Date.now() })
        if (_pronounCache.size > PRONOUN_CACHE_MAX) _pronounCache.delete(_pronounCache.keys().next().value)
        sendResponse(data)
      })
      .catch(() => sendResponse(null))
    return true
  }

  // Query all open Twitch/Kick tabs to find channels the user is watching
  if (message.type === 'get_watching_channels') {
    const skip = new Set([
      'directory',
      'settings',
      'videos',
      'moderator',
      'subscriptions',
      'downloads',
      'search',
      'categories',
      'following',
    ])
    browser.tabs
      .query({ url: ['*://*.twitch.tv/*', '*://kick.com/*', '*://*.kick.com/*', '*://*.youtube.com/*'] })
      .then(async (tabs) => {
        const channels = []
        const seen = new Set()
        const ytPending = [] // {idx, videoId} — needs oEmbed lookup to resolve handle
        for (const tab of tabs) {
          try {
            const url = new URL(tab.url)
            let match
            if (url.hostname.includes('twitch.tv')) {
              match = url.pathname.match(/^\/(?:popout\/)?([a-zA-Z0-9_]+)/)
            } else if (url.hostname.includes('kick.com')) {
              match = url.pathname.match(/^\/(popout|embed)\/([a-zA-Z0-9_-]+)/)
              if (match)
                match = [null, match[2]] // normalize to [_, channel]
              else match = url.pathname.match(/^\/([a-zA-Z0-9_-]+)/)
            } else if (url.hostname.includes('youtube.com')) {
              // Only count tabs on a live stream URL — handle, /live/<id>, or /watch?v=<id>.
              const v = url.searchParams.get('v')
              const liveHandleMatch = url.pathname.match(/^\/@([^/]+)\/live/)
              const liveIdMatch = url.pathname.match(/^\/live\/([^/?]+)/)
              if (liveHandleMatch) {
                const handle = liveHandleMatch[1]
                const key = `yt:${handle.toLowerCase()}`
                if (!seen.has(key)) {
                  seen.add(key)
                  channels.push({
                    name: handle,
                    platform: 'youtube',
                    youtubeUrl: `https://www.youtube.com/@${handle}/live`,
                  })
                }
              } else if (liveIdMatch || (v && url.pathname === '/watch')) {
                const videoId = liveIdMatch ? liveIdMatch[1] : v
                const ytUrl = liveIdMatch
                  ? `https://www.youtube.com/live/${videoId}`
                  : `https://www.youtube.com/watch?v=${videoId}`
                const idx = channels.length
                // Placeholder — name will be resolved to channel handle via oEmbed below.
                channels.push({ name: videoId, platform: 'youtube', youtubeUrl: ytUrl, _videoId: videoId })
                ytPending.push({ idx, videoId })
              }
              continue
            }
            if (match?.[1]) {
              const ch = match[1].toLowerCase()
              if (!skip.has(ch) && ch !== 'popout' && ch !== 'embed' && !seen.has(ch)) {
                seen.add(ch)
                channels.push({ name: ch, platform: url.hostname.includes('kick') ? 'kick' : 'twitch' })
              }
            }
          } catch (_e) {}
        }

        // Resolve YT handles via oEmbed — public, no auth, CORS-friendly.
        if (ytPending.length) {
          await Promise.all(
            ytPending.map(async (p) => {
              const handle = await getYtChannelHandle(p.videoId)
              if (!handle) return
              const key = `yt:${handle.toLowerCase()}`
              if (seen.has(key)) {
                channels[p.idx] = null // duplicate — prefer the existing entry
              } else {
                seen.add(key)
                channels[p.idx].name = handle
                delete channels[p.idx]._videoId
              }
            }),
          )
          for (let i = channels.length - 1; i >= 0; i--) {
            if (channels[i] === null) channels.splice(i, 1)
          }
        }

        sendResponse({ channels })
      })
      .catch(() => sendResponse({ channels: [] }))
    return true
  }

  // Proxy fetch for live status (avoids CORS in content script)
  if (message.type === 'fetch_live_status') {
    const channels = message.channels || []
    const kickChannels = message.kickChannels || []
    if (!channels.length && !kickChannels.length) {
      sendResponse(null)
      return true
    }
    const params = []
    if (channels.length) params.push(`channels=${encodeURIComponent(channels.join(','))}`)
    if (kickChannels.length) params.push(`kick_channels=${encodeURIComponent(kickChannels.join(','))}`)
    fetch(`https://heatsync.org/api/platform/live-status?${params.join('&')}`, { signal: AbortSignal.timeout(6000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null))
    return true // async sendResponse
  }

  // Auth state probe — multichat content script asks for current state on init
  // so it can show the login banner immediately on a tab opened after the
  // auth_changed broadcast already fired.
  if (message.type === 'get_auth_state') {
    // Lazy-fetch the auth cookie if memory cache is empty.
    // cookies.onChanged only fires on cookie mutations — if the user logged in
    // before the extension started watching, the listener never ran and
    // chrome.storage.local stays empty until any feature calls getAuthCookie().
    // Multichat content scripts ask for auth state at startup; honor that by
    // proactively reading the cookie here and storing the token.
    if (!authToken && !authFailedBlock) {
      getAuthCookie()
        .then((t) => {
          sendResponse({ loggedIn: !!t && !authFailedBlock })
        })
        .catch(() => sendResponse({ loggedIn: false }))
      return true
    }
    sendResponse({ loggedIn: !!authToken && !authFailedBlock })
    return true
  }

  // YouTube subscribe via WS server — from multichat content script
  if (message.type === 'youtube_ws_subscribe') {
    const url = message.url
    const channelId = message.channelId || 'global'
    log('[hs-bg] youtube_ws_subscribe received:', { url, channelId, socketOpen: isSocketOpen() })
    if (url && /^https:\/\/(www\.)?youtube\.com\//i.test(url)) {
      // Extract videoId from URL for routing (always, even if socket is down)
      const vidMatch = url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) {
        setYtVideoChannel(vidMatch[1], channelId)
        ytTapMarkWanted(vidMatch[1])
      } else {
        // No videoId in URL — server resolves it. Track for status-fallback attribution.
        pendingYtSubscribes.push({ channelId, url, ts: Date.now() })
        if (pendingYtSubscribes.length > 20) pendingYtSubscribes.shift()
      }
      // wsSend handles both immediate send and queue-on-reconnect; previous
      // gating let subscribes silently drop when the socket was closing.
      log('[hs-bg] youtube:subscribe (open?', isSocketOpen(), '):', { url, channelId })
      wsSend({ type: 'youtube:subscribe', url, channelId })
      // Always persist for reconnect (even if socket is currently down)
      if (channelId === 'global') {
        browser.storage.local.set({ youtube_url: url })
      } else {
        youtubeChannelUrls[channelId] = url
        const ytUrlKeys = Object.keys(youtubeChannelUrls)
        if (ytUrlKeys.length > 50) {
          delete youtubeChannelUrls[ytUrlKeys[0]]
        }
        // __live_yt_auto__ is an EPHEMERAL binding to whatever stream is open
        // right now. Persisting it resurrects a stale stream's YT chat on the
        // next SW wake — e.g. an @<name>/live guess for a focused tab bleeds
        // into an unrelated channel forever. Keep it in memory for mid-session
        // reconnects, but never write it to storage; the content script re-binds
        // it per page from the current channel's explicit YT link.
        const { __live_yt_auto__: _omitAuto, ...persistUrls } = youtubeChannelUrls
        browser.storage.local.set({ youtube_channel_urls: persistUrls })
      }
      log(' YouTube subscribe:', url, 'channel:', channelId, isSocketOpen() ? '' : '(queued for reconnect)')
      // Fire-and-forget real-history backfill — _ytRecentFetched gates this to
      // once per channelId per SW lifetime (this handler re-fires on every
      // reconnect/reload, unlike kick's join-gated _kpChannels check). After
      // the fetch settles (or the one-shot no-ops), replay the buffer to the
      // SUBSCRIBING tab so surfaces that boot after the one-shot still get
      // history without a hard refresh.
      const ytSubTabId = sender?.tab?.id
      bgYtFetchRecentArchive(channelId, url)
        .catch(() => {})
        .then(() => bgYtReplayToTab(ytSubTabId, channelId))
        .catch(() => {})
    }
    sendResponse({ ok: true })
    return
  }

  // YouTube unsubscribe
  if (message.type === 'youtube_ws_unsubscribe') {
    const channelId = message.channelId || 'global'
    // Try videoId from message first, then extract from stored URL
    let videoId = message.videoId
    if (!videoId && message.url) {
      const vidMatch =
        message.url.match(/[?&]v=([^&]+)/) ||
        message.url.match(/\/live\/([^?&/]+)/) ||
        message.url.match(/youtu\.be\/([^?&]+)/)
      if (vidMatch) videoId = vidMatch[1]
    }
    if (videoId) {
      deleteYtVideoChannel(videoId, channelId)
      // Only tear down the server poller (and the tap's wantedness) when no
      // other channel is still bound to this video — the same stream can
      // back multiple bindings.
      if (!ytVideoToChannel.has(videoId)) {
        ytTapUnmarkWanted(videoId)
        if (isSocketOpen()) wsSend({ type: 'youtube:unsubscribe', videoId })
      }
      if (activeYoutubeVideoId === videoId) activeYoutubeVideoId = null
    }
    // Clean up storage
    if (channelId === 'global') {
      browser.storage.local.remove(['youtube_url'])
    } else {
      delete youtubeChannelUrls[channelId]
      browser.storage.local.set({ youtube_channel_urls: { ...youtubeChannelUrls } })
      // Channel removed from config — drop its persisted history buffer too,
      // else hs_yt_<channelId> storage entries accumulate forever across every
      // channel the user has ever added and removed (BG_YT only caps total
      // channel COUNT, it never ages one out on removal).
      BG_YT.channels.delete(channelId)
      chrome.storage.local.remove(`hs_yt_${channelId}`).catch(() => {})
    }
    log(' YouTube unsubscribe:', videoId || '(no videoId)', 'channel:', channelId)
    sendResponse({ ok: true })
    return
  }

  // Content-script escalation: a per-channel watchdog has decided the BG WS
  // is in zombie state. Close the socket and let scheduleReconnect fire a
  // fresh connection, which replays joins from joinedExtraChannels.
  if (message.type === 'ws_force_reconnect') {
    log(' 🚨 ws_force_reconnect requested:', message.source, message.channel || '')
    if (socket) {
      try {
        socket.onclose = null
        socket.close()
      } catch {}
    }
    wsState = WS_STATE.DISCONNECTED
    isAuthenticated = false
    reconnectAttempts = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (heartbeatInterval) {
      untrackInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    connectWebSocket().catch((err) => log(' force-reconnect failed:', err?.message))
    sendResponse({ ok: true })
    return
  }

  // Forward WS message from content scripts (used by multichat kick channels)
  if (message.type === 'ws_send') {
    const allowedWsTypes = [
      'channel:join',
      'channel:leave',
      'emote:used',
      'youtube:subscribe',
      'youtube:unsubscribe',
      'multichat:sync',
      'ui-state:sync',
      'twitch:chat:relay',
    ]
    if (message.data && allowedWsTypes.includes(message.data.type)) {
      // Track multichat-added channel joins so we can replay on WS reconnect
      // (server restarts, network blips, SW resume — any of these orphan the join).
      if (message.data.type === 'channel:join' && message.data.platform && message.data.channel) {
        const key = `${message.data.platform}/${message.data.channel.toLowerCase()}`
        if (isGhostChannelKey(key)) {
          sendResponse?.({ ok: false, error: 'reserved path' })
          return true
        }
        if (!joinedExtraChannels.has(key)) {
          joinedExtraChannels.add(key)
          saveJoinedExtraChannels()
        }
        // Multichat extra channels get their emote sets HERE — this join is the
        // only signal BG ever receives for them (content-side join_channel only
        // fires for the page channel; the SW-boot refetch loop only covers
        // channels known at boot). TTL-gating inside fetchChannelOwnerEmotes
        // makes repeat joins cheap, and it re-broadcasts the cache immediately.
        try {
          fetchChannelOwnerEmotes(message.data.channel.toLowerCase(), null, message.data.platform.toLowerCase()).catch(
            () => {},
          )
        } catch {}
        // Kick: pull deep archive from postgres alongside the server's 200-msg
        // ring backfill. Internal cooldown prevents duplicate fetches on
        // rapid switches.
        if (message.data.platform.toLowerCase() === 'kick') {
          try {
            bgKickFetchArchive(message.data.channel.toLowerCase()).catch(() => {})
          } catch {}
          try {
            kickPusherJoin(message.data.channel.toLowerCase())
          } catch {}
        }
      } else if (message.data.type === 'channel:leave' && message.data.platform && message.data.channel) {
        const key = `${message.data.platform}/${message.data.channel.toLowerCase()}`
        if (joinedExtraChannels.delete(key)) saveJoinedExtraChannels()
        if (message.data.platform.toLowerCase() === 'kick') {
          const kch = message.data.channel.toLowerCase()
          try {
            kickPusherLeave(kch)
          } catch {}
          // Channel removed from config — drop its persisted history buffer too,
          // else hs_kick_<ch> storage entries accumulate forever across every
          // channel the user has ever added and removed (BG_KICK only caps total
          // channel COUNT, it never ages one out on removal).
          BG_KICK.channels.delete(kch)
          chrome.storage.local.remove(`hs_kick_${kch}`).catch(() => {})
        }
      }
      wsSend(message.data)
    }
    sendResponse({ ok: true })
    return
  }

  if (message.type === 'set_auth_token') {
    // Async: verify state nonce + confirm token via /api/auth/me before touching caches
    ;(async () => {
      try {
        // State nonce check (defense against identity fixation)
        const stored = await browser.storage.local.get('hs_login_state')
        const storedState = stored?.hs_login_state
        if (storedState) {
          // One-time: always consume regardless of match
          await browser.storage.local.remove('hs_login_state')
          // A pending login (storedState present) means THIS extension opened
          // the flow with ext_state=nonce (see heatsync-button.js), and the
          // backend echoes it back — so a legit callback ALWAYS carries a
          // matching state. Require it: reject a MISSING or mismatched state.
          // Closes the window where an attacker's crafted heatsync.org/?auth_token=
          // link (no / forged ext_state) lands while a login is pending.
          // (A token arriving with NO pending login is still accepted after the
          // /api/auth/me check below; fully closing that needs every login entry
          // point to seed a nonce — tracked separately.)
          if (message.state !== storedState) {
            log(' ⚠ set_auth_token rejected — missing or mismatched state nonce')
            sendResponse({ ok: false, error: 'state mismatch' })
            return
          }
        }
        // Verify token against /api/auth/me before wiping any caches
        const verifyResp = await fetchWithTimeout(`${API_URL}/api/auth/me`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${message.token}` },
        })
        if (!verifyResp.ok) {
          verifyResp.body?.cancel()
          log(' ⚠ set_auth_token rejected — /api/auth/me returned', verifyResp.status)
          sendResponse({ ok: false, error: 'token verification failed' })
          return
        }
        let meUser
        try {
          meUser = JSON.parse(await verifyResp.text())
        } catch {
          meUser = null
        }
        if (!meUser) {
          log(' ⚠ set_auth_token rejected — invalid /api/auth/me response')
          sendResponse({ ok: false, error: 'invalid auth response' })
          return
        }
        const newUsername = (meUser.username || meUser.twitch_username || '').toLowerCase()
        // Notify on identity switch so user is aware
        if (currentUsername && newUsername && newUsername !== currentUsername.toLowerCase()) {
          log(` set_auth_token: account switch ${currentUsername} → ${newUsername}`)
          try {
            chrome.notifications.create(`hs-account-switch-${Date.now()}`, {
              type: 'basic',
              iconUrl: 'icon-48.png',
              title: 'heatsync — account switch',
              message: `switching from ${currentUsername} to ${newUsername}`,
            })
          } catch {}
        }
        // Token verified — adopt it and refresh caches
        authToken = message.token
        authFailedBlock = false
        log(' Received and verified auth token from content script')
        emoteInventory = []
        blockedEmotes = new Set()
        followedUsers = []
        browser.storage.local.remove(['emote_inventory', 'blocked_emotes'])
        storeToken(message.token).catch((err) => log('storeToken failed:', err?.message))
        fetchEmoteInventory().catch(() => {})
        fetchBlockedEmotes().catch(() => {})
        fetchFollowedUsers().catch(() => {})
        log(' 🔄 Reconnecting WebSocket with new auth token...')
        connectWebSocket().catch(() => {})
        sendResponse({ ok: true })
      } catch (err) {
        log(' set_auth_token error:', err?.message || err)
        sendResponse({ ok: false, error: err?.message || 'unknown error' })
      }
    })()
    return true // async sendResponse
  } else if (message.type === 'block_emote') {
    // Async - send response when done
    blockEmote(message.hash).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'unblock_emote') {
    // Async - send response when done
    unblockEmote(message.hash).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'add_to_inventory') {
    // Async - send response when done
    addToInventory(message.emoteName, message.emoteHash, message.emoteUrl, message.zeroWidth).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'remove_from_inventory') {
    // Async - send response when done
    removeFromInventory(message.emoteHash, message.emoteName).then((result) => {
      sendResponse(result)
    })
    return true // Keep channel open for async response
  } else if (message.type === 'mute_user') {
    const expiresAt = message.expiresAt || null
    mutedUsers.set(message.username, expiresAt)
    persistMutedUsers()
    broadcastToTabs({ type: 'user_muted', username: message.username, expiresAt })
    // Sync to server via REST /api/mutes — writes to user_mutes table and
    // broadcasts mute:added WS event so heatsync.org tabs + other ext sockets
    // pick up the mute instantly. Replaces the old `user:mute` WS path which
    // wrote to user_blocks (different table, never read by chat-mute UI).
    syncMuteToServer(message.username, expiresAt).catch((err) => log(' syncMuteToServer failed:', err?.message))
    log(' Muted user:', message.username, expiresAt ? `(expires ${new Date(expiresAt).toISOString()})` : '(permanent)')
    sendResponse({ ok: true })
  } else if (message.type === 'unmute_user') {
    mutedUsers.delete(message.username)
    persistMutedUsers()
    broadcastToTabs({ type: 'user_unmuted', username: message.username })
    // Sync to server via REST DELETE /api/mutes/:username — broadcasts
    // mute:removed WS event for cross-device + cross-surface unmute.
    syncUnmuteToServer(message.username).catch((err) => log(' syncUnmuteToServer failed:', err?.message))
    log(' Unmuted user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'block_user') {
    blockedUsers.add(message.username)
    persistBlockedUsers()
    broadcastToTabs({ type: 'user_blocked', username: message.username })
    log(' Blocked user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'unblock_user') {
    blockedUsers.delete(message.username)
    persistBlockedUsers()
    broadcastToTabs({ type: 'user_unblocked', username: message.username })
    log(' Unblocked user:', message.username)
    sendResponse({ ok: true })
  } else if (message.type === 'get_blocked_users') {
    sendResponse({ users: Array.from(blockedUsers) })
  } else if (message.type === 'get_twitch_auth_token') {
    // Cross-domain Twitch cookie access (for sending from Kick/YouTube pages)
    Promise.all([
      browser.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }),
      browser.cookies.get({ url: 'https://www.twitch.tv', name: 'name' }),
    ])
      .then(([tokenCookie, nameCookie]) => {
        sendResponse({
          token: tokenCookie?.value || null,
          username: nameCookie?.value
            ? decodeURIComponent(nameCookie.value).toLowerCase()
            : userInfo?.twitch_username || null,
        })
      })
      .catch(() => sendResponse({ token: null, username: null }))
    return true
  } else if (message.type === 'get_inventory') {
    // Async - wait for init to complete first
    ;(async () => {
      if (initPromise) {
        await initPromise
      }
      log(
        ' Background: get_inventory request - responding with',
        emoteInventory.length,
        'personal,',
        globalEmotes.length,
        'global',
      )
      // Merged set — picker needs to surface BOTH server and local blocks so
      // anon-era hashes (now lingering in localBlockedEmotes after login) can
      // still be unblocked from the UI. unblockEmote handles either layer.
      sendResponse({
        emotes: emoteInventory,
        globalEmotes: globalEmotes,
        blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])),
      })
    })()
    return true // Keep channel open for async response
  } else if (message.type === 'get_followed_users') {
    sendResponse({
      users: followedUsers,
    })
    return true
  } else if (message.type === 'get_live_followed') {
    // Cached snapshot from background poll — popup/content can read instantly
    sendResponse({
      snapshot: _liveFollowedSnapshot,
      count: _liveFollowedCount,
    })
    return true
  } else if (message.type === 'refresh_followed_users') {
    // Triggered after a follow/unfollow action elsewhere — re-fetches the
    // canonical list from server and re-runs live poll so badge/notifications
    // reflect the change immediately.
    fetchFollowedUsers().catch(() => {})
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'join_channel') {
    // Content script detected channel change — wait for init so cached channel emotes are available
    // Defence in depth: validate platform + channel before forwarding to WS server
    const VALID_PLATFORMS = new Set(['twitch', 'kick', 'youtube'])
    const safePlatform = VALID_PLATFORMS.has(message.platform) ? message.platform : null
    // YouTube handles can contain periods (e.g. "@mr.beast") — allow them so the
    // sanitized key still matches what the content script reads back via
    // getCurrentChannel() (which doesn't strip periods). Twitch/Kick names never
    // contain periods, so this is a no-op for those platforms.
    const safeChannel = String(message.channel || '')
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 50)
    if (!safePlatform || !safeChannel) {
      sendResponse({ received: false, error: 'invalid platform/channel' })
      return true
    }
    log(' 📺 Content script requesting channel join:', safePlatform, '/', safeChannel, 'id:', message.channelId)
    ;(async () => {
      // sendResponse must run on every path: if initPromise rejects (WS
      // constructor throw, 10s connect timeout, offline) the rejection used
      // to escape this IIFE and the message port just hung, leaving the
      // caller's callback waiting forever. joinChannel is intentionally not
      // awaited, but it IS async — catch it too so a failed join doesn't
      // surface as an unhandled rejection.
      try {
        if (initPromise) await initPromise
      } catch (e) {
        log(' 📺 join_channel: init failed, joining anyway:', e?.message || e)
      }
      try {
        const p = joinChannel(safePlatform, safeChannel, message.channelId, sender.tab?.id)
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch (_) {}
      sendResponse({ received: true })
    })()
    return true // Keep channel open for async response
  } else if (message.type === 'yt_ensure_channel_emotes') {
    // Native yt live_chat surface (youtube-content.js). join_channel only
    // fires for channels added to the multichat overlay, so a viewer just
    // watching youtube.com never loaded the streamer's 7TV/BTTV set. Resolve
    // videoId → UC id and fetch; the channel_emotes_update broadcast feeds
    // the iframe's listener. Deliberately NOT joinChannel(): no tabChannels
    // write (would clobber the overlay's primary-channel tracking for the
    // tab) and no WS room join.
    // Channel key: the iframe's ?v= when present (popout chat), else derive
    // from the sender tab's URL — embedded watch-page chat iframes only carry
    // ?continuation=, so the top frame's watch?v=/@handle is the identity.
    // sender.tab.url is browser-provided (not page-controlled).
    const ytVid = String(message.videoId || '')
    const ytTabUrl = String(sender?.tab?.url || '')
    const ytChanKey = /^[\w-]{11}$/.test(ytVid)
      ? ytVid
      : (ytTabUrl.match(/[?&]v=([\w-]{11})/)?.[1] ??
        (ytTabUrl.match(/youtube\.com\/@([\w.-]{3,30})/)
          ? `@${ytTabUrl.match(/youtube\.com\/@([\w.-]{3,30})/)[1]}`
          : null))
    if (ytChanKey) {
      ;(async () => {
        if (initPromise) await initPromise
        fetchChannelOwnerEmotes(ytChanKey, null, 'youtube').catch(() => {})
      })()
      sendResponse({ received: true })
    } else {
      sendResponse({ received: false, error: 'no channel identity' })
    }
    return true
  } else if (message.type === 'update_channel_id') {
    // Content script late-discovered the Twitch channel ID via early-inject MAIN-world.
    // Cache it so subsequent fetches skip the GQL roundtrip; if current fetch is in flight
    // without an ID, it stays in flight (we don't abort) but emote map will refresh on next nav.
    if (message.channel && message.channelId) {
      const ch = message.channel.toLowerCase()
      twitchIdCache.set(ch, String(message.channelId))
      log(' 📺 Late channel ID cached:', ch, '→', message.channelId)
    }
    sendResponse({ ok: true })
    return true
  } else if (message.type === 'emote_sent') {
    // Content script detected user sent emote
    log(' 💬 Content script detected emote sent:', message.emoteName)
    const result = broadcastEmoteUsage(message.emoteName, message.emoteHash, sender.tab?.id)
    log(' 📤 Broadcast result:', result)
    sendResponse(result || { success: false, reason: 'unknown' })
    return true // Keep channel open for response
  } else if (message.type === 'get_channel_emotes') {
    // Multichat/content requesting channel emotes (may have missed the broadcast).
    // Await init like get_picker_emotes/get_inventory beside it — a cold SW
    // must finish restoring channel_emotes_map before we count/broadcast, else
    // we return count:0 and the client's retry just spins. Async → return true.
    ;(async () => {
      if (initPromise) await initPromise
      // Self-heal: any joined channel with no cache entry (evicted, wiped by a
      // past failed refetch, never fetched) gets a fetch kicked off NOW — the
      // result arrives via the progressive channel_emotes_update broadcasts.
      // Without this, a missing channel stayed missing for the whole session:
      // this handler only ever REPORTED the cache, and nothing else re-fetched.
      try {
        const wanted = new Set(joinedExtraChannels)
        for (const t of tabChannels.values()) {
          // tabChannels .channel is already a "platform/name" key (joinChannel)
          if (t?.channel?.includes('/')) wanted.add(t.channel.toLowerCase())
        }
        for (const k of wanted) {
          const state = channelEmotesMap[k]
          if (!Array.isArray(state) && state !== 'loading') {
            const { platform, channel } = splitChKey(k)
            if (channel) fetchChannelOwnerEmotes(channel, null, platform).catch(() => {})
          }
        }
      } catch {}
      const totalEmotes = Object.values(channelEmotesMap).reduce((sum, e) => sum + (Array.isArray(e) ? e.length : 0), 0)
      if (totalEmotes > 0) {
        browser.storage.local.set({
          channel_emotes_map: getStorableChannelEmotes(),
          channel_emotes_fetched_at: channelEmotesFetchedAt,
        })
        for (const [k, emotes] of Object.entries(channelEmotesMap)) {
          if (Array.isArray(emotes)) {
            const { platform, channel } = splitChKey(k)
            broadcastToTabs({ type: 'channel_emotes_update', emotes, channelOwner: channel, platform })
          }
        }
      }
      sendResponse({ count: totalEmotes })
    })()
    return true
  } else if (message.type === 'get_picker_emotes') {
    // Return immediately with whatever's cached. If channel emotes aren't
    // ready, trigger the fetch but DON'T poll-wait — fetchChannelOwnerEmotes
    // broadcasts channel_emotes_update progressively as each provider
    // (BTTV/FFZ/7TV/Twitch) lands, and the picker listens for that broadcast.
    // The old 8s poll-wait gated the entire panel render on the slowest
    // third-party API.
    ;(async () => {
      if (initPromise) await initPromise
      const channel = message.channel?.toLowerCase()
      const pickerPlatform = message.platform || (sender?.url?.includes('kick.com') ? 'kick' : 'twitch')
      const chState = channel ? channelEmotesMap[chKey(pickerPlatform, channel)] : null
      const chEmotes = Array.isArray(chState) ? chState : null
      if (channel && !chEmotes && chState !== 'loading') {
        // Fire-and-forget: result will arrive via channel_emotes_update broadcast
        fetchChannelOwnerEmotes(channel, null, pickerPlatform)
      }
      // channelLoading lets the picker keep showing "loading…" instead of
      // "no emotes" while the third-party fetch is still in flight.
      const channelLoading = !!channel && !chEmotes
      sendResponse({
        channelEmotes: chEmotes || [],
        channelLoading,
        globalEmotes: globalEmotes,
        inventoryEmotes: emoteInventory,
        blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])),
      })
    })()
    return true
  } else if (message.type === 'refresh_all') {
    // Refresh all emotes — called from popup AND from the NSFW toggle
    // click path (chat needs to repaint with the new filter without
    // waiting for the 5min sender-emote LRU TTL). Clear sender cache
    // here so cross-user emote sets re-fetch fresh on next message.
    try {
      if (globalThis.__senderEmoteCache?.clear) globalThis.__senderEmoteCache.clear()
    } catch {}
    ;(async () => {
      await Promise.all([
        fetchGlobalEmotes(),
        fetchEmoteInventory(),
        fetchBlockedEmotes(),
        fetchUserInfo(),
        fetchViewerSettings(),
      ])
      sendResponse({ success: true })
    })()
    return true
  } else if (message.type === 'notifs_viewed') {
    unreadNotifCount = 0
    browser.storage.session?.set({ unread_notif_count: 0 }).catch(() => {})
    updateExtensionBadge()
  } else if (message.type === 'get_follow_history') {
    // Content scripts request cached follow history (handles race condition on load)
    sendResponse({
      history: cachedFollowHistory,
      colors: cachedFollowColors,
    })
    return true // Required for Firefox — sendResponse ignored without this
  } else if (message.type === 'get_roomstate') {
    // Return cached IRC ROOMSTATE for a channel (modes from the JOIN tag set).
    // Available as soon as the SW's IRC connection has joined the channel —
    // works from any host (Twitch/Kick/YT) because IRC is shared.
    const ch = (message.channel || '').toString().toLowerCase()
    if (!ch) {
      sendResponse({ ok: false, error: 'no channel' })
      return true
    }
    const state = BG_IRC?.roomstates?.get(ch) || null
    sendResponse({ ok: true, state })
    return true
  } else if (message.type === 'twitch_gql_authed') {
    // Cross-platform Twitch GQL: queries authenticated with the twitch.tv
    // auth-token cookie, so content scripts on Kick/YouTube can read mod
    // state and other authed data without a Twitch tab being open.
    // Mutations that need Client-Integrity should go through twitch_relay
    // instead (relays through a live Twitch tab).
    ;(async () => {
      try {
        const cookie = await browser.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }).catch(() => null)
        const hdrs = {
          'Content-Type': 'application/json',
          'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        }
        if (cookie?.value) hdrs.Authorization = `OAuth ${cookie.value}`
        const body = message.variables
          ? { query: message.query, variables: message.variables }
          : { query: message.query }
        const resp = await fetchWithTimeout(
          'https://gql.twitch.tv/gql',
          {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify(body),
          },
          8000,
        )
        if (!resp.ok) {
          sendResponse({ ok: false, error: `GQL ${resp.status}` })
          return
        }
        const data = await resp.json()
        sendResponse({ ok: true, data })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'twitch_relay') {
    // Relay a Twitch API call through an open twitch.tv tab. Used for
    // mutations (ban/timeout/delete/follow) that require a Client-Integrity
    // token which can only be minted from a Twitch page context.
    ;(async () => {
      try {
        const tabs = await browser.tabs.query({ url: '*://*.twitch.tv/*' })
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: 'no_twitch_tab' })
          return
        }
        // Try every Twitch tab — after an extension reload, content scripts
        // in existing tabs become orphans (no listener for new message types)
        // until the page is refreshed.
        const candidates = [...tabs.filter((t) => t.active), ...tabs.filter((t) => !t.active)]
        let lastErr = null
        for (const tab of candidates) {
          try {
            const result = await browser.tabs.sendMessage(tab.id, {
              type: 'twitch_relay_exec',
              op: message.op,
              args: message.args || {},
            })
            if (result) {
              sendResponse(result)
              return
            }
          } catch (e) {
            lastErr = e?.message || ''
            if (/Could not establish connection|Receiving end does not exist/i.test(lastErr)) continue
            sendResponse({ ok: false, error: lastErr })
            return
          }
        }
        sendResponse({ ok: false, error: 'stale_twitch_tab' })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_channel_badges') {
    // Fetch kick.com/api/v2/channels/{slug}.subscriber_badges → [{months, src}].
    // Run from BG so kick.com fetch isn't gated by the panel's cross-origin
    // CORS rules (panel may be on twitch.tv/youtube.com viewing a linked Kick
    // channel). Cached per-slug for the SW lifetime via reuse of the
    // kickChannelIdCache pattern.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!slug) {
          sendResponse({ ok: false, error: 'missing slug' })
          return
        }
        const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
        if (!resp.ok) {
          resp.body?.cancel?.()
          sendResponse({ ok: false, error: `kick api ${resp.status}` })
          return
        }
        const data = await resp.json().catch(() => null)
        const sub = Array.isArray(data?.subscriber_badges) ? data.subscriber_badges : []
        const badges = []
        for (const b of sub) {
          const months = parseInt(b?.months, 10)
          const src = b?.badge_image?.src
          if (Number.isFinite(months) && typeof src === 'string' && /^https?:\/\//i.test(src)) {
            badges.push({ months, src })
          }
        }
        sendResponse({ ok: true, badges })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'fetch_failed' })
      }
    })()
    return true
  } else if (message.type === 'kick_resolve_channel') {
    // Resolve Kick channel slug → numeric channelId
    ;(async () => {
      const slug = message.slug?.toLowerCase()
      sendResponse(await resolveKickChannelIdBg(slug))
    })()
    return true
  } else if (message.type === 'kick_send_message') {
    // Route Kick chat send through a kick.com tab (same-origin cookies)
    ;(async () => {
      try {
        sendResponse(await sendKickMessageViaTab(message.channelId, message.content, message.reply))
      } catch (e) {
        log('kick_send_message error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_set_chat_mode') {
    ;(async () => {
      try {
        sendResponse(await setKickChatModeViaTab(message.chatroomId, message.body))
      } catch (e) {
        log('kick_set_chat_mode error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_follow') {
    // Kick has no public follow API. We POST/DELETE /api/v2/channels/{slug}/follow
    // with the user's own session cookies + XSRF token. SW direct fetch with
    // credentials:include works because manifest grants kick.com/* host access.
    // No tab-relay required (unlike kick_send_message which needs a kick.com
    // tab as the messaging origin); SW is fine here because Kick's follow
    // endpoint doesn't enforce a same-origin Referer check.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        const follow = !!message.follow
        if (!slug) {
          sendResponse({ ok: false, error: 'missing slug' })
          return
        }
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: false, error: 'kick_not_logged_in' })
          return
        }
        // Bearer required since kick's 2026-07 auth change (see sendKickMessageViaTab)
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/follow`
        const followHeaders = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-XSRF-TOKEN': decodeURIComponent(cookie.value),
        }
        if (session?.value) followHeaders.Authorization = `Bearer ${decodeURIComponent(session.value)}`
        const resp = await fetchWithTimeout(url, {
          method: follow ? 'POST' : 'DELETE',
          credentials: 'include',
          headers: followHeaders,
        })
        // Kick returns 200/204 on success; treat "already following" / "not following"
        // signals as idempotent success. Other 4xx/5xx surface as errors.
        if (resp.ok || resp.status === 204) {
          sendResponse({ ok: true })
          return
        }
        // 422 with "already" in body → idempotent
        let bodyText = ''
        try {
          bodyText = await resp.text()
        } catch {}
        if (/already|not.*follow/i.test(bodyText)) {
          sendResponse({ ok: true, idempotent: true })
          return
        }
        sendResponse({ ok: false, error: `kick ${resp.status}`, body: bodyText.slice(0, 200) })
      } catch (e) {
        log('kick_follow error:', e?.message)
        sendResponse({ ok: false, error: e?.message || 'fetch failed' })
      }
    })()
    return true
  } else if (message.type === 'kick_mod_action') {
    // Kick moderation — ban / timeout / unban / delete-message.
    // Routed through a kick.com tab so same-origin XSRF + session cookies apply.
    // Shape: { action: 'ban'|'timeout'|'unban'|'delete', slug, username?, durationMin?, reason?, messageId? }
    ;(async () => {
      try {
        const action = String(message.action || '')
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!action || !slug) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: false, error: 'kick_not_logged_in' })
          return
        }
        // Bearer required since kick's 2026-07 auth change (see sendKickMessageViaTab)
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const tabs = await browser.tabs.query({ url: '*://*.kick.com/*' })
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: 'no_kick_tab' })
          return
        }
        // For delete we need the chatroomId — resolve once per slug, cached.
        let chatroomId = null
        if (action === 'delete') {
          chatroomId = kickChatroomIdCache.get(slug)
          if (!chatroomId) {
            const resp = await fetchWithTimeout(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              chatroomId = data?.chatroom?.id || null
              if (chatroomId) {
                if (kickChatroomIdCache.size >= 100) {
                  kickChatroomIdCache.delete(kickChatroomIdCache.keys().next().value)
                }
                kickChatroomIdCache.set(slug, chatroomId)
              }
            }
            if (!chatroomId) {
              sendResponse({ ok: false, error: 'no_chatroom' })
              return
            }
          }
        }
        // Prefer a tab actually on the target channel (most likely live + the
        // relevant session) over an arbitrary kick.com tab. The API call is
        // slug-parameterized and cookie-authed so any logged-in kick tab CAN
        // execute it, but a frozen/unrelated tab is a worse bet. Then walk the
        // health-ranked rest — a discarded/stale tab throws "Receiving end does
        // not exist" instantly, so retrying siblings costs nothing (same trap
        // as sendKickMessageViaTab).
        const ranked = rankKickRelayTabs(tabs)
        const onSlug = ranked.find((t) => (t.url || '').toLowerCase().includes(`/${slug}`))
        const candidates = onSlug ? [onSlug, ...ranked.filter((t) => t !== onSlug)] : ranked
        let result = null
        for (const relayTab of candidates) {
          // Deadline: a hung renderer would otherwise leave tabs.sendMessage
          // pending forever, hanging the mod command with no feedback. Fail loud.
          result = await Promise.race([
            browser.tabs
              .sendMessage(relayTab.id, {
                type: 'kick_mod_relay',
                action,
                slug,
                chatroomId,
                username: message.username || '',
                durationMin: message.durationMin || 0,
                reason: message.reason || '',
                messageId: message.messageId || '',
                xsrfToken: cookie.value,
                sessionToken: session?.value || '',
                // .catch keeps a late rejection (tab port closes after the timeout
                // already won the race) from becoming an unhandled promise rejection.
              })
              .catch((e) => ({ ok: false, error: e?.message || 'kick relay failed' })),
            new Promise((res) =>
              setTimeout(() => res({ ok: false, error: 'kick tab unresponsive — reload kick.com' }), 12000),
            ),
          ])
          // ok:true or a real API response (e.g. kick 403) ends the walk — only
          // relay-transport failures justify trying another tab.
          if (result?.ok || (result && !/Receiving end|kick relay failed|unresponsive/.test(result.error || ''))) break
        }
        sendResponse(result || { ok: false, error: 'no response from tab' })
      } catch (e) {
        log('kick_mod_action error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'kick_mod_status') {
    // Is the authed Kick viewer a mod/broadcaster on this channel? Gates the
    // kick mod UI the way isModFor (twitch GQL) gates the twitch one. A plain
    // credentialed GET on kick.com (no XSRF/relay needed — same as kick_follow
    // and _kpResolveChatroomId) returns the viewer's role on the channel object.
    // Fails closed (isMod:false) on any error so the UI just doesn't surface.
    ;(async () => {
      try {
        const slug = String(message.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 64)
        if (!slug) {
          sendResponse({ ok: true, isMod: false })
          return
        }
        const cookie = await browser.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' })
        if (!cookie?.value) {
          sendResponse({ ok: true, isMod: false })
          return
        } // not logged in
        // Bearer so the response carries the VIEWER's chatroom_user role —
        // without it kick treats the request as anon (2026-07 auth change)
        // and mod status permanently fails closed.
        const session = await browser.cookies.get({ url: 'https://kick.com', name: 'session_token' })
        const statusHeaders = { Accept: 'application/json' }
        if (session?.value) statusHeaders.Authorization = `Bearer ${decodeURIComponent(session.value)}`
        const resp = await fetchWithTimeout(
          `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
          { credentials: 'include', headers: statusHeaders },
          5000,
        )
        if (!resp.ok) {
          sendResponse({ ok: false, isMod: false, error: `kick api ${resp.status}` })
          return
        }
        const data = await resp.json().catch(() => null)
        // ONLY trust the viewer-specific `chatroom_user` object (the authed
        // viewer's relationship to this chatroom). Do NOT probe data.user /
        // data.role / data.chatroom.* — those are the BROADCASTER's / channel's
        // fields (data.user is the channel owner, role always 'broadcaster'), so
        // trusting them would mark every viewer a mod. Field path is community-
        // documented but unconfirmed live; under-showing (no UI) is the safe
        // failure, never showing ban buttons to a non-mod.
        const cu = data?.chatroom_user || null
        const role = String(cu?.role || cu?.user_role || '').toLowerCase()
        const isMod =
          role === 'moderator' ||
          role === 'broadcaster' ||
          role === 'mod' ||
          cu?.is_moderator === true ||
          cu?.is_broadcaster === true
        // log() is a no-op unless DEBUG — flip DEBUG to confirm the field path live
        // (logs the raw viewer object whether mod or not).
        try {
          log('kick_mod_status', slug, `isMod=${isMod}`, JSON.stringify(cu))
        } catch (_) {}
        sendResponse({ ok: true, isMod })
      } catch (e) {
        sendResponse({ ok: false, isMod: false, error: e?.message || 'fetch failed' })
      }
    })()
    return true
  } else if (message.type === 'youtube_mod_action') {
    // Forward a mod action to the YouTube tab's live_chat content script, which
    // drives YT's own moderation flow. FORT KNOX tab resolution, same as the
    // send path: with a videoId only ever touch THAT stream's tabs (bridge →
    // matching open tab → auto-opened bridge); without one, only the sender's
    // own tab. Never a guessed active/any tab — a ban/delete must never land on
    // the wrong stream's chat.
    ;(async () => {
      try {
        const { action, msgId, target, videoId } = message
        if (!action || !msgId) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        const vidOk = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)
        let targetTabId = null
        if (vidOk) {
          const bridged = ytBridgeTabs.get(videoId)
          if (bridged != null && (await browser.tabs.get(bridged).catch(() => null))) {
            targetTabId = bridged
            ytBridgeLastUsed.set(videoId, Date.now())
          }
          if (!targetTabId) {
            const ytTabs = await browser.tabs.query({ url: '*://www.youtube.com/*' }).catch(() => [])
            const match = ytTabs.find((t) => (t.url || '').includes(videoId))
            if (match) targetTabId = match.id
          }
          if (!targetTabId) {
            const bridge = await ensureYoutubeBridgeTab(videoId)
            if (bridge.tabId && !bridge.error) {
              targetTabId = bridge.tabId
            } else {
              sendResponse({ ok: false, error: bridge.error || 'no_youtube_tab' })
              return
            }
          }
        } else {
          const senderTabId = sender?.tab?.id
          if (senderTabId) {
            const t = await browser.tabs.get(senderTabId).catch(() => null)
            if (t && /youtube\.com/.test(t.url || '')) targetTabId = senderTabId
          }
          if (!targetTabId) {
            sendResponse({ ok: false, error: 'no_youtube_tab' })
            return
          }
        }
        const relayMsg = { type: 'youtube_mod_relay', action, msgId, target }
        let result = null
        try {
          result = await browser.tabs.sendMessage(targetTabId, relayMsg)
        } catch (relayErr) {
          // Watch tab with collapsed native chat has NO live_chat frame — no
          // receiver. With a videoId, fall back to a bridge tab (its chat
          // frame carries recent history, so message-scoped actions usually
          // still resolve).
          const canBridge = vidOk && targetTabId !== ytBridgeTabs.get(videoId)
          if (!canBridge) throw relayErr
          const bridge = await ensureYoutubeBridgeTab(videoId)
          if (!bridge.tabId || bridge.error) {
            sendResponse({ ok: false, error: bridge.error || relayErr.message })
            return
          }
          result = await browser.tabs.sendMessage(bridge.tabId, relayMsg)
        }
        sendResponse(result || { ok: false, error: 'no response from tab' })
      } catch (e) {
        log('youtube_mod_action error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'youtube_send_message') {
    ;(async () => {
      try {
        const { text, videoId } = message
        if (!text) {
          sendResponse({ ok: false, error: 'missing params' })
          return
        }
        let targetTabId = null

        if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          // Path A — exact stream known. Only ever drive a tab on THIS videoId
          // (a cached bridge tab → a matching open tab → an auto-opened bridge
          // tab). Never falls back to an unrelated tab, so a send can't land in
          // the wrong stream's chat.
          const bridged = ytBridgeTabs.get(videoId)
          if (bridged != null && (await browser.tabs.get(bridged).catch(() => null))) {
            targetTabId = bridged
            ytBridgeLastUsed.set(videoId, Date.now())
          }
          if (!targetTabId) {
            const ytTabs = await browser.tabs.query({ url: '*://www.youtube.com/*' }).catch(() => [])
            const match = ytTabs.find((t) => (t.url || '').includes(videoId))
            if (match) {
              targetTabId = match.id
              // Re-adopt a bridge tab the map forgot (SW restart) — without
              // this the orphan sweep would close it mid-use.
              if ((match.url || '').includes('#hs-bridge')) {
                ytBridgeTabs.set(videoId, match.id)
                ytBridgeLastUsed.set(videoId, Date.now())
              }
            }
          }
          if (!targetTabId) {
            const bridge = await ensureYoutubeBridgeTab(videoId)
            if (bridge.tabId && !bridge.error) {
              targetTabId = bridge.tabId
            } else {
              // Provisioned but not sendable (usually logged-out) — surface the
              // tab so the user can sign in, and report why.
              if (bridge.tabId && bridge.error === 'chat_disabled') {
                await browser.tabs.update(bridge.tabId, { active: true }).catch(() => {})
              }
              sendResponse({ ok: false, error: bridge.error || 'no_youtube_tab', reason: bridge.reason })
              return
            }
          }
        } else {
          // Path B — no concrete videoId. FORT KNOX: only ever drive the
          // SENDER'S OWN YouTube tab (the page the user is actually typing on).
          // The old active-tab / any-tab fallbacks routed a send into whatever
          // YouTube tab happened to be open — so a message leaked into an
          // unrelated stream's chat (e.g. a popped-out live_chat for a channel
          // you're not even in). Never guess a tab; fail loud instead.
          const senderTabId = sender?.tab?.id
          if (senderTabId) {
            const t = await browser.tabs.get(senderTabId).catch(() => null)
            if (t && /youtube\.com/.test(t.url || '')) targetTabId = senderTabId
          }
          if (!targetTabId) {
            sendResponse({ ok: false, error: 'no_youtube_tab' })
            return
          }
        }

        const relayPayload = {
          type: 'youtube_send_relay',
          text,
          // awaitConfirm makes the relay run the 2.5s observer race in
          // youtube-content.js (1024+) so we know whether YT actually
          // accepted the send (rate-limit / slow-mode / disabled button
          // would otherwise return ok:true after the click animation).
          awaitConfirm: true,
        }
        let result = null
        try {
          result = await browser.tabs.sendMessage(targetTabId, relayPayload)
        } catch (relayErr) {
          // A URL-matched watch tab can have NO live_chat frame — the overlay
          // collapses native chat, which unloads the iframe youtube-content.js
          // lives in, so there is no receiver. With a concrete videoId, fall
          // back to a bridge tab instead of failing the send.
          //
          // But ONLY when the first attempt provably never reached a content
          // script ("receiving end does not exist"). A "message port closed"
          // means the frame received the relay and died mid-send — the click
          // (and the post) may already have happened, so re-driving a bridge tab
          // through the same inject-and-click would double-post. Report that
          // ambiguous case as a failure rather than silently sending twice.
          const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(relayErr.message || '')
          const canBridge =
            noReceiver && videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) && targetTabId !== ytBridgeTabs.get(videoId)
          if (!canBridge) throw relayErr
          const bridge = await ensureYoutubeBridgeTab(videoId)
          if (!bridge.tabId || bridge.error) {
            sendResponse({ ok: false, error: bridge.error || relayErr.message, reason: bridge.reason })
            return
          }
          result = await browser.tabs.sendMessage(bridge.tabId, relayPayload)
        }
        sendResponse(result || { ok: false, error: 'no response from tab' })
      } catch (e) {
        log('youtube_send_message error:', e.message)
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  } else if (message.type === 'api_fetch') {
    // Generic API proxy — content scripts route through here to bypass CORS
    // Strict path validation: catch literal `..` AND URL-encoded variants
    // (%2e%2e, %2E, etc) by decoding before the check
    let _decodedPath
    try {
      _decodedPath = decodeURIComponent(message.path || '')
    } catch {
      _decodedPath = ''
    }
    if (!message.path?.startsWith('/api/') || /\.\./.test(_decodedPath)) {
      sendResponse({ ok: false, error: 'invalid path' })
      return true
    }
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    const reqMethod = String(message.method || 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(reqMethod)) {
      sendResponse({ ok: false, error: 'invalid method' })
      return true
    }
    ;(async () => {
      const doFetch = async (token) => {
        const opts = { method: reqMethod, headers: {} }
        if (message.auth && token) opts.headers.Authorization = `Bearer ${token}`
        if (message.body) {
          opts.headers['Content-Type'] = 'application/json'
          opts.body = JSON.stringify(message.body)
        }
        const resp = await fetchWithTimeout(`${API_URL}${message.path}`, opts)
        const data = await resp.json().catch(() => null)
        return { resp, data }
      }
      try {
        const token = message.auth ? authToken || (await getAuthCookie()) : null
        let { resp, data } = await doFetch(token)
        // Self-heal: on 401 with auth, the in-memory/encrypted token may be
        // stale (e.g. JWT issued before user linked Twitch). Re-read directly
        // from the heatsync auth cookie (which the website refreshes on every
        // login), refresh storage, and retry once.
        if (message.auth && resp.status === 401) {
          try {
            const cookie = await browser.cookies.get({ url: 'https://heatsync.org', name: 'auth' })
            if (cookie?.value && cookie.value !== token) {
              log(' [api_fetch] 401 — refreshing token from cookie and retrying')
              authToken = cookie.value
              await storeToken(cookie.value)
              ;({ resp, data } = await doFetch(cookie.value))
            }
          } catch (err) {
            log(' [api_fetch] cookie refresh failed:', err?.message)
          }
        }
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status, error: data?.error || `${resp.status}`, code: data?.code })
          return
        }
        sendResponse(data?.ok !== undefined ? data : { ok: true, data })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'api_upload') {
    // Multipart sibling of api_fetch. Same reason for existing: a content
    // script cannot reach heatsync.org directly — the host page's CORS applies
    // and twitch/kick/youtube are not allowed origins. api_fetch can't serve
    // this one because it is JSON-only, so the file arrives here as a data URL
    // and is rebuilt into a real multipart body on this side.
    ;(async () => {
      try {
        const dataUrl = String(message.dataUrl || '')
        const comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith('data:') || comma < 0) {
          sendResponse({ ok: false, error: 'bad file data' })
          return
        }
        // Trust the declared mime only as far as its shape — the server
        // re-derives the real type from the bytes, but there is no reason to
        // relay something that isn't claiming to be media in the first place.
        const mime = String(message.mime || '').toLowerCase()
        if (!/^(image|video)\/[a-z0-9.+-]+$/.test(mime)) {
          sendResponse({ ok: false, error: 'only images/videos allowed' })
          return
        }
        const bin = atob(dataUrl.slice(comma + 1))
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const form = new FormData()
        form.append('file', new Blob([bytes], { type: mime }), String(message.name || 'paste'))

        const doUpload = async (token) => {
          const opts = { method: 'POST', body: form, headers: {} }
          // No Content-Type header — fetch sets it WITH the multipart boundary,
          // and overriding it here makes the body unparseable server-side.
          if (token) opts.headers.Authorization = `Bearer ${token}`
          const resp = await fetchWithTimeout(`${API_URL}/api/upload`, opts, 120000)
          const data = await resp.json().catch(() => null)
          return { resp, data }
        }
        const token = authToken || (await getAuthCookie())
        let { resp, data } = await doUpload(token)
        // Same stale-token self-heal as api_fetch — a JWT issued before the
        // user linked an account 401s until it's re-read from the cookie.
        if (resp.status === 401) {
          try {
            const cookie = await browser.cookies.get({ url: 'https://heatsync.org', name: 'auth' })
            if (cookie?.value && cookie.value !== token) {
              authToken = cookie.value
              await storeToken(cookie.value)
              ;({ resp, data } = await doUpload(cookie.value))
            }
          } catch (err) {
            log(' [api_upload] cookie refresh failed:', err?.message)
          }
        }
        if (!resp.ok || !data?.url) {
          sendResponse({
            ok: false,
            status: resp.status,
            error: data?.error || (resp.status === 401 ? 'log in to upload' : `http ${resp.status}`),
          })
          return
        }
        // Absolutize before it leaves the relay. The server answers with an
        // origin-relative '/uploads/<file>', and the only consumer drops that
        // string straight into the chat composer — where a leading '/' makes
        // Twitch read the whole message as a slash command and answer
        // "Unrecognized command: /uploads/...". The message never reaches chat.
        // The render chokepoint already absolutizes for feed/thread, but a chat
        // send has no chokepoint: the raw text is the wire payload.
        sendResponse({ ok: true, url: absUrl(data.url) })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'api_store_remote') {
    // Store a remote image by URL and answer with OUR copy of it.
    //
    // Why this exists: Chromium's "copy image" rasterizes an animated gif to a
    // single frame before the bytes ever reach the clipboard, so the paste
    // handler uploads a still and the gif arrives dead. The same copy also
    // offers a text/html flavor holding the original <img src> — that url still
    // points at the real animated file, and fetching it server-side is the only
    // way back to the frames.
    //
    // /api/img is that fetch, already built and already hardened: SSRF-pinned
    // per redirect hop, byte-capped, moderated, and stored through the same
    // handleUpload pipeline as a direct upload — then it answers 302 to
    // /uploads/<hash>.webp with animation intact. So this is a URL resolve, not
    // a second upload path, and it needs no permission the ext doesn't have.
    ;(async () => {
      try {
        const src = String(message.url || '')
        let parsed
        try {
          parsed = new URL(src)
        } catch {
          sendResponse({ ok: false, error: 'bad url' })
          return
        }
        // /api/img is https-only and refuses its own origin. Answer both here
        // rather than spending a round trip to be told.
        if (parsed.protocol !== 'https:') {
          sendResponse({ ok: false, error: 'https only' })
          return
        }
        if (parsed.hostname === 'heatsync.org' || parsed.hostname.endsWith('.heatsync.org')) {
          sendResponse({ ok: true, url: src })
          return
        }
        // Emote CDNs are hotlinked, never mirrored. Storing a copy would put
        // someone else's emote artwork in our bucket, and the standing posture
        // is that the risk on unlicensed creator art stays with the host that
        // chose to serve it. These hosts also render directly (they're in
        // HS_IMG_DIRECT_HOSTS), so the link works untouched — and it's already
        // animated, which was the entire point of resolving a source url.
        if (HOTLINK_ONLY_HOSTS.has(parsed.hostname)) {
          sendResponse({ ok: true, url: src })
          return
        }
        // noBackoff: a cached, read-only GET. Under the shared heatsync backoff
        // an unrelated 429 somewhere else would fake-429 this one, and the only
        // symptom would be gifs quietly going still for the next minute.
        // 30s: a cold url is a real fetch + moderation pass on our side.
        const res = await fetchWithTimeout(
          `${API_URL}/api/img?url=${encodeURIComponent(src)}`,
          { noBackoff: true },
          30000,
        )
        // The stored path is the redirect TARGET, not the body — and the body is
        // the full image, up to 10MB. Take the identity and drop the bytes.
        const finalUrl = res.url || ''
        try {
          await res.body?.cancel()
        } catch {}
        const stored = finalUrl.match(/\/uploads\/[\w.-]+$/)
        if (!res.ok || !stored) {
          sendResponse({ ok: false, error: `http ${res.status}` })
          return
        }
        sendResponse({ ok: true, url: absUrl(stored[0]) })
      } catch (err) {
        sendResponse({ ok: false, error: err.message })
      }
    })()
    return true
  } else if (message.type === 'register_self_twitch_id') {
    // Content script discovered the user's own twitch ID. Subscribe to 7TV
    // EventAPI so badge/paint changes push in real-time (no polling needed).
    if (message.twitchId && /^\d+$/.test(String(message.twitchId))) {
      ensureSelfCosmeticSub(String(message.twitchId))
    }
    sendResponse({ ok: true })
    return false
  } else if (message.type === 'get_user_cosmetics') {
    const ids = (message.twitchIds || []).slice(0, 25)
    ;(async () => {
      const result = {}
      const toFetch = []
      // Per-id inflight dedup — concurrent get_user_cosmetics calls (multi-tab
      // or rapid chat) used to fan out as N separate /api/cosmetics/batch POSTs
      // even when IDs overlapped, each one a fresh 429 candidate. Share promises.
      if (!globalThis.__cosmeticsInflight) globalThis.__cosmeticsInflight = new Map()
      const inflightMap = globalThis.__cosmeticsInflight
      const pendingInflight = []
      for (const id of ids) {
        const cached = userCosmeticsCache.get(id)
        const isNegative = cached && !cached.paint && !cached.badge
        const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
        if (cached && Date.now() - cached.fetchedAt < ttl) {
          result[id] = { paint: cached.paint, badge: cached.badge }
        } else if (inflightMap.has(id)) {
          pendingInflight.push(id)
        } else {
          toFetch.push(id)
        }
      }

      if (toFetch.length > 0) {
        // Try heatsync proxy first — single request, server-side cache, no 7TV
        // IP exposure. Retry once: switching to a busy/frozen channel rebuilds
        // its whole buffer and floods this with ~60 batches at once; a single
        // 6s timeout under that burst failed whole batches, fell to the direct
        // 7TV path, and CACHED the empty result as "no cosmetics" — which stuck
        // users who actually have a paint until the negative TTL expired.
        // Wrapped in one shared per-id promise so concurrent overlapping batch
        // calls don't each re-fire the same id.
        const batchPromise = (async () => {
          let proxied = null
          for (let attempt = 0; attempt < 2 && !proxied; attempt++) {
            try {
              const resp = await fetchWithTimeout(
                `${API_URL}/api/cosmetics/batch`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ twitchIds: toFetch }),
                },
                10000,
              )
              if (resp.ok) {
                const data = await resp.json()
                if (data?.cosmetics) proxied = data.cosmetics
              } else {
                resp.body?.cancel?.()
              }
            } catch (_e) {
              /* retry, then fall through */
            }
          }
          if (proxied) {
            const out = {}
            for (const id of toFetch) {
              const c = proxied[id] ?? null
              setUserCosmetic(id, c)
              out[id] = c
            }
            return out
          }
          // Proxy unreachable — fall back to direct 7TV. CRITICAL: only cache a
          // negative on a definitive 404 (no 7TV account). A 503/timeout/network
          // error must NOT be cached, or one transient blip blanks a user's
          // cosmetics for the whole negative-TTL window; leave it unset to retry.
          const out = {}
          await Promise.all(
            toFetch.map(async (id) => {
              try {
                const resp = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${id}`)
                if (resp.status === 404) {
                  resp.body?.cancel?.()
                  setUserCosmetic(id, null)
                  out[id] = null
                  return
                }
                if (!resp.ok) {
                  resp.body?.cancel?.()
                  out[id] = null
                  return
                }
                const data = await resp.json()
                const ids7tv = extract7TVCosmeticIds(data)
                const cosmetic = await resolve7TVCosmeticIds(ids7tv)
                setUserCosmetic(id, cosmetic)
                out[id] = cosmetic
              } catch (_e) {
                out[id] = null
              }
            }),
          )
          return out
        })()
        // Register each id as inflight before awaiting — overlapping concurrent
        // callers see the same promise and skip refiring.
        for (const id of toFetch) {
          const idP = batchPromise.then((m) => m[id] || null)
          inflightMap.set(id, idP)
          idP.finally(() => {
            if (inflightMap.get(id) === idP) inflightMap.delete(id)
          })
        }
        const batchResult = await batchPromise
        for (const id of toFetch) result[id] = batchResult[id] || null
      }

      // Collect from any other in-flight requests (started by sibling calls)
      if (pendingInflight.length > 0) {
        await Promise.all(
          pendingInflight.map(async (id) => {
            const p = inflightMap.get(id)
            if (p) result[id] = (await p) || null
          }),
        )
      }

      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'get_kick_user_cosmetics') {
    // 7TV's /v3/users/kick/{id} expects the numeric Kick user_id, not the
    // username — username lookups return 404 user_not_found. Resolve via
    // kick.com/api/v1/users/{username} first (returns {id, username, ...}),
    // cache that id forever (LRU), then hit 7TV with the id to pull cosmetics
    // and the linked Twitch connection.
    const usernames = (message.kickUsernames || []).slice(0, 10)
    ;(async () => {
      const result = {}
      await Promise.all(
        usernames.map(async (username) => {
          const cacheKey = `kick:${username}`
          const cached = userCosmeticsCache.get(cacheKey)
          const isNegative = cached && !cached.paint && !cached.badge
          const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
          if (cached && Date.now() - cached.fetchedAt < ttl) {
            // kickId is absent on cache entries written before this field
            // existed — omit it rather than force a re-fetch (graceful).
            result[username] = {
              paint: cached.paint,
              badge: cached.badge,
              twitchId: cached.twitchId || null,
              ...(cached.kickId ? { kickId: cached.kickId } : {}),
              avatar: kickUsernameToPfpCache.get(username) || null,
            }
            return
          }
          try {
            // Step 1 — username → kick user_id (cached separately)
            let kickUserId = kickUsernameToIdCache.get(username)
            if (!kickUserId) {
              const userResp = await fetchWithTimeout(`https://kick.com/api/v1/users/${encodeURIComponent(username)}`)
              if (!userResp.ok) {
                userResp.body?.cancel?.()
                // Only a 404 is proof the user has no cosmetics — cache that.
                // A 429/5xx is transient; caching it blanks real paints/badges
                // for COSMETICS_NEGATIVE_TTL. Matches get_user_cosmetics / yt /
                // fetch_paints, which all skip the cache on non-404 failures.
                if (userResp.status === 404) setUserCosmetic(cacheKey, null)
                result[username] = null
                return
              }
              const userData = await userResp.json().catch(() => null)
              kickUserId = userData?.id || null
              if (!kickUserId) {
                setUserCosmetic(cacheKey, null)
                result[username] = null
                return
              }
              if (kickUsernameToIdCache.size >= 1000) {
                kickUsernameToIdCache.delete(kickUsernameToIdCache.keys().next().value)
              }
              kickUsernameToIdCache.set(username, kickUserId)
              // Capture the real avatar from the same response (free — no extra
              // fetch). Kept parallel to the id cache so it's available even when
              // a later request skips v1/users on an id-cache hit. NOTE: v1/users
              // spells it `profilepic` (no underscore) — v2/channels uses
              // `profile_pic`; accept both to be safe.
              const _pfp = userData?.profilepic || userData?.profile_pic
              if (_pfp) {
                if (kickUsernameToPfpCache.size >= 1000) {
                  kickUsernameToPfpCache.delete(kickUsernameToPfpCache.keys().next().value)
                }
                kickUsernameToPfpCache.set(username, _pfp)
              }
            }
            // Step 2 — kick user_id → 7TV cosmetics + twitch connection.
            // Most kick chatters have no 7TV account (404) — the resolved
            // kickId + avatar must still flow back so kick-origin heatsync
            // paints and real avatars render without a 7TV account.
            const resp = await fetchWithTimeout(`https://7tv.io/v3/users/kick/${kickUserId}`)
            if (!resp.ok) {
              resp.body?.cancel?.()
              const bare = { paint: null, badge: null, twitchId: null, twitchUsername: null, kickId: kickUserId }
              if (resp.status === 404) setUserCosmetic(cacheKey, bare) // genuine: no 7TV account
              result[username] = { ...bare, avatar: kickUsernameToPfpCache.get(username) || null }
              return
            }
            const data = await resp.json()
            const ids7tv = extract7TVCosmeticIds(data)
            const cosmetic = await resolve7TVCosmeticIds(ids7tv)
            const twitchConn = data?.user?.connections?.find((c) => c.platform === 'TWITCH')
            const twitchId = twitchConn?.id || null
            const twitchUsername = twitchConn?.username || null
            // kickUserId is the raw numeric kick id — safe to hand back here
            // (this response only ever feeds cosmetics.js's kickId field,
            // never a paint lookup directly; see queuePaintLookup's ID-SPACE
            // SAFETY note in src/multichat/paints.js for the namespacing rule
            // callers must apply before using it for a paint lookup).
            const full = cosmetic
              ? { ...cosmetic, twitchId, twitchUsername, kickId: kickUserId }
              : { paint: null, badge: null, twitchId, twitchUsername, kickId: kickUserId }
            setUserCosmetic(cacheKey, full)
            result[username] = { ...full, avatar: kickUsernameToPfpCache.get(username) || null }
          } catch (_e) {
            result[username] = null // transient: network/timeout — don't cache
          }
        }),
      )
      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'get_youtube_user_cosmetics') {
    // Per-chatter 7TV cosmetics for YouTube-only accounts (no linked Twitch).
    // 7TV files YouTube under the "google" platform slug keyed by the real UC
    // channel id (see fetch7TVChannelEmotes's youtube branch for the id-format
    // rationale). Mirrors get_kick_user_cosmetics: direct-to-7TV from the BG SW
    // (no server proxy exists for non-twitch platforms — cosmetics.ts only
    // validates numeric twitch ids), same cache/TTL posture, own key prefix so
    // it can never collide with a twitch_id or a kick_id.
    const channelIds = Array.from(
      new Set((message.channelIds || []).filter((id) => /^UC[\w-]{20,}$/i.test(String(id || '')))),
    ).slice(0, 25)
    ;(async () => {
      const result = {}
      await Promise.all(
        channelIds.map(async (ucid) => {
          const cacheKey = `yt:${ucid}`
          const cached = userCosmeticsCache.get(cacheKey)
          const isNegative = cached && !cached.paint && !cached.badge
          const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
          if (cached && Date.now() - cached.fetchedAt < ttl) {
            result[ucid] = { paint: cached.paint, badge: cached.badge }
            return
          }
          try {
            const resp = await fetchWithTimeout(`https://7tv.io/v3/users/google/${ucid}`)
            if (resp.status === 404) {
              resp.body?.cancel?.()
              setUserCosmetic(cacheKey, null) // genuine: no 7TV account
              result[ucid] = null
              return
            }
            if (!resp.ok) {
              resp.body?.cancel?.()
              result[ucid] = null // transient: don't cache 5xx
              return
            }
            const data = await resp.json()
            const ids7tv = extract7TVCosmeticIds(data)
            const cosmetic = await resolve7TVCosmeticIds(ids7tv)
            setUserCosmetic(cacheKey, cosmetic)
            result[ucid] = cosmetic
          } catch (_e) {
            result[ucid] = null // transient: network/timeout — don't cache
          }
        }),
      )
      sendResponse({ cosmetics: result })
    })()
    return true
  } else if (message.type === 'fetch_paints') {
    // Relay for GET /api/paints?ids=... (public, ≤50/batch) — CRITICAL: this
    // must stay a BG fetch, never a content-script one. Cross-origin
    // content-script fetches to heatsync.org trip Cloudflare's bot heuristics
    // (edge 503 before the origin ever sees them; see fetch_recent_messages
    // above for the same reasoning). Mirrors get_user_cosmetics's shape:
    // per-id TTL cache + in-flight promise sharing so concurrent overlapping
    // batches (multi-tab, rapid chat) don't each re-fire the same ids.
    const ids = Array.from(
      // Allow '-': yt paint uids are `yt_<UCid>` and UC channel ids are
      // base64url, so a hyphen is common (kson = yt_UC9ruVYPv7yJmV0Rh0NKA-Lw).
      // The old no-hyphen guard silently dropped ~half of yt paint lookups.
      // Matches the server /api/paints ID_RE (paint.ts). twitch/kick/heatsync
      // ids are unaffected (no hyphens).
      new Set((message.userIds || []).filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id))),
    ).slice(0, 50)
    ;(async () => {
      if (!ids.length) {
        sendResponse({ paints: {}, colors: {}, plus: {} })
        return
      }
      const result = {}
      const toFetch = []
      if (!globalThis.__paintsInflight) globalThis.__paintsInflight = new Map()
      const inflightMap = globalThis.__paintsInflight
      const pendingInflight = []
      for (const id of ids) {
        const cached = _paintsCache.get(id)
        if (cached && Date.now() - cached.fetchedAt < PAINTS_TTL) {
          result[id] = cached.spec
        } else if (inflightMap.has(id)) {
          pendingInflight.push(id)
        } else {
          toFetch.push(id)
        }
      }

      if (toFetch.length > 0) {
        const batchPromise = (async () => {
          // CRITICAL: only ever set `out[id]` (and cache it) on a CONFIRMED
          // answer from a successful, parseable response — including a
          // confirmed negative (id genuinely absent from `paints`, meaning
          // the user has no paint set). On any failure (non-OK, timeout,
          // unparseable body) leave the id OUT of `out` entirely so the
          // per-id key is absent from the response; the content script
          // (paints.js) treats an absent key as "retry later" and never
          // caches it — a transient BG hiccup must never get mistaken for
          // (and mask) a real paint, mirroring the same rule already applied
          // to 7TV cosmetics negative-caching above.
          const out = {}
          try {
            const resp = await fetchWithTimeout(
              `${API_URL}/api/paints?ids=${toFetch.map(encodeURIComponent).join(',')}`,
              {},
              10000,
            )
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              if (data?.paints && typeof data.paints === 'object') {
                const dataColors = data.colors && typeof data.colors === 'object' ? data.colors : {}
                const dataPlus = data.plus && typeof data.plus === 'object' ? data.plus : {}
                for (const id of toFetch) {
                  const spec = data.paints[id] ?? null
                  setPaintCache(id, spec, dataColors[id] ?? null, dataPlus[id] ?? null)
                  out[id] = spec
                }
              }
              // else: unparseable/malformed body — leave `out` empty, retry next flush.
            } else {
              resp.body?.cancel?.()
            }
          } catch (_e) {
            /* network error/timeout — leave `out` empty, retry next flush */
          }
          return out
        })()
        // `undefined` (not `null`) is the "unresolved, retry later" sentinel
        // threaded through the inflight-sharing chain — `null` is reserved
        // for a CONFIRMED negative and must never be conflated with it.
        for (const id of toFetch) {
          const idP = batchPromise.then((m) => (id in m ? m[id] : undefined))
          inflightMap.set(id, idP)
          idP.finally(() => {
            if (inflightMap.get(id) === idP) inflightMap.delete(id)
          })
        }
        const batchResult = await batchPromise
        for (const id of toFetch) {
          if (id in batchResult) result[id] = batchResult[id]
        }
      }

      if (pendingInflight.length > 0) {
        await Promise.all(
          pendingInflight.map(async (id) => {
            const p = inflightMap.get(id)
            if (!p) return
            const v = await p
            if (v !== undefined) result[id] = v
          }),
        )
      }

      // `result` only has keys for CONFIRMED ids (positive spec, or a
      // confirmed negative) — an id with no answer yet is simply absent, and
      // paints.js (content script) treats an absent key as "retry next flush".
      // Picked name colours + plus tenure ride along: read them from the
      // cache for every resolved id (inflight-shared ids were cached by
      // their owning batch before their promise resolved, so both are
      // present by now).
      const colors = {}
      const plus = {}
      for (const id of Object.keys(result)) {
        const cached = _paintsCache.get(id)
        if (cached?.color) colors[id] = cached.color
        if (cached?.plus) plus[id] = cached.plus
      }
      sendResponse({ paints: result, colors, plus })
    })()
    return true
  } else if (message.type === 'get_sender_emotes') {
    // Per-sender 7TV + BTTV personal-set fetch. Used by content script to lazy-resolve
    // each unseen sender's emotes once and cache write-once-per-(sender, name) forever.
    // Input:  senderKeys: ["twitch:12345", "kick:somebody", "yt:abcd", ...]
    // Output: { emotes: { "twitch:12345": { "67": {url, source, zeroWidth, hash}, ... }, ... } }
    // Empty inner object = sender has no personal set (caller still caches the miss to avoid refetch).
    const senderKeys = (message.senderKeys || []).slice(0, 30)
    ;(async () => {
      const result = {}
      // Keys whose providers errored this round — clients must NOT replace
      // their cached set with this partial/empty result (raw-text regression)
      const erroredKeys = []
      // Cache hits inside this background instance (cross-tab dedupe). 6h TTL.
      // Per-name perma is enforced on the content side via mergeSenderEmotes.
      if (!globalThis.__senderEmoteCache) globalThis.__senderEmoteCache = new Map()
      const cache = globalThis.__senderEmoteCache
      const SENDER_EMOTE_CACHE_TTL = 120000 // 2min — matches the panel's re-fetch TTL so the fallback path is a consistent 2min end-to-end (the live emote:added broadcast busts this cache immediately, making this the miss/reconnect fallback, not the primary path)
      // Misses expire much sooner: an empty cached set is the exact window
      // where a sender's brand-new emote renders as plain text for this
      // viewer if the live emote:broadcast was missed. 90s bounds it.
      const SENDER_EMOTE_NEGATIVE_TTL = 90000
      const cacheFresh = (h) => {
        if (!h) return false
        const ttl = h.emotes && Object.keys(h.emotes).length > 0 ? SENDER_EMOTE_CACHE_TTL : SENDER_EMOTE_NEGATIVE_TTL
        return Date.now() - h.ts < ttl
      }
      // Batch-fetch heatsync sets for all numeric ids that aren't cache-fresh, in ONE
      // request. Per-id /api/users/:id calls fired ~15-parallel per flush tripped
      // Cloudflare's 429; one batched call keeps it well under. credentials:'omit' so
      // the *-CORS response isn't rejected (credentialed + ACAO:* is invalid).
      const _missKeys = [
        ...new Set(
          senderKeys
            .filter((k) => !cacheFresh(cache.get(k)))
            .filter((k) => {
              const c = k.indexOf(':')
              return c >= 0 && k.slice(c + 1).length > 0
            }),
        ),
      ]
      // Sentinel so an errored fetch (null from .catch) is distinguishable from
      // an authoritative empty ({} / 404). Poisoning the cache with an empty
      // set on a transient failure made a sender's emotes render as raw text
      // (even the 90s negative TTL is a lie for a network blip) after recovery.
      const SENDER_FETCH_ERR = (globalThis.__senderFetchErr ??= Symbol('sender-fetch-err'))
      let hsBatch = {}
      let _hsBatchErrored = false
      if (_missKeys.length) {
        // Send platform-prefixed keys (e.g. twitch:12345, kick:username) so the server
        // can resolve all platforms. Response is keyed by the same prefixed strings.
        // v (from a live push's emote-ver) busts the CF edge: TTL refetches keep
        // the shared cacheable URL, push refetches hit a URL the edge never saw.
        const bust = sanitizeVer(message.v)
        const hb = await fetchWithTimeout(
          withNsfwParam(
            `${API_URL}/api/users/emotes/batch?ids=${_missKeys.map(encodeURIComponent).join(',')}${bust ? `&v=${bust}` : ''}`,
          ),
          { credentials: 'omit', noBackoff: true },
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => SENDER_FETCH_ERR)
        // Distinguish a transient failure (network/timeout → don't poison the
        // cache with an empty set) from a legit empty response.
        hsBatch = hb === SENDER_FETCH_ERR ? {} : hb?.sets || {}
        if (hb === SENDER_FETCH_ERR) _hsBatchErrored = true
      }
      await Promise.all(
        senderKeys.map(async (key) => {
          const hit = cache.get(key)
          if (cacheFresh(hit)) {
            result[key] = hit.emotes
            return
          }
          const colon = key.indexOf(':')
          if (colon < 0) {
            result[key] = {}
            return
          }
          const platform = key.slice(0, colon)
          const id = key.slice(colon + 1)
          if (!id) {
            result[key] = {}
            return
          }
          const collected = {}
          // 7TV — twitch by id; kick by NUMERIC kick user_id (NOT the username:
          // /users/kick/{username} 404s user_not_found). content.js queues
          // kick:<username>, so resolve username→id via kick.com/api/v1/users
          // (cached, same resolver get_kick_user_cosmetics uses) before the
          // fetch; no id → skip the 7TV leg (hs personal set still resolves).
          let sevenTvPath
          if (platform === 'kick') {
            let kid = kickUsernameToIdCache.get(id)
            if (kid === undefined) {
              try {
                const ur = await fetchWithTimeout(`https://kick.com/api/v1/users/${encodeURIComponent(id)}`)
                if (ur.ok) {
                  const uj = await ur.json()
                  kid = uj?.id != null ? String(uj.id) : null
                } else {
                  ur.body?.cancel?.()
                  kid = null
                }
              } catch {
                kid = null
              }
              if (kid) {
                if (kickUsernameToIdCache.size >= 1000)
                  kickUsernameToIdCache.delete(kickUsernameToIdCache.keys().next().value)
                kickUsernameToIdCache.set(id, kid)
              }
            }
            sevenTvPath = kid ? `kick/${encodeURIComponent(kid)}` : null
          } else {
            sevenTvPath = `twitch/${encodeURIComponent(id)}`
          }
          const isNumericId = /^\d+$/.test(id)
          // Per-id inflight dedup for 7TV/BTTV — chat rebuild can flush 30 keys in
          // <1s; without this each one fires its own pair. Shared promise per
          // (provider, path) collapses duplicate concurrent fetches into one. The
          // 5min cache below handles the longer-window case.
          const stv7tvInflight = (globalThis.__stv7tvInflight ??= new Map())
          const bttvInflight = (globalThis.__bttvInflight ??= new Map())
          let stvP = null
          if (sevenTvPath) {
            stvP = stv7tvInflight.get(sevenTvPath)
            if (!stvP) {
              stvP = fetchWithTimeout(`https://7tv.io/v3/users/${sevenTvPath}`)
                // 404 = user genuinely has no 7TV set (cache the empty); a 5xx /
                // 429 must NOT read as empty — that caches the sender's real
                // emotes away as raw text for the negative TTL. Flag it errored.
                .then((r) => (r.ok ? r.json() : r.status === 404 ? null : SENDER_FETCH_ERR))
                .catch(() => SENDER_FETCH_ERR)
              stv7tvInflight.set(sevenTvPath, stvP)
              stvP.finally(() => stv7tvInflight.delete(sevenTvPath))
            }
          }
          // BTTV — only twitch-id endpoint. Skip for kick/yt.
          let bttvP
          if (platform === 'twitch' && isNumericId) {
            bttvP = bttvInflight.get(id)
            if (!bttvP) {
              bttvP = fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${id}`)
                // 404 = no BTTV user (empty); 5xx/429 = transient, flag errored
                // so it isn't cached as "no emotes". See the 7TV leg above.
                .then((r) => (r.ok ? r.json() : r.status === 404 ? null : SENDER_FETCH_ERR))
                .catch(() => SENDER_FETCH_ERR)
              bttvInflight.set(id, bttvP)
              bttvP.finally(() => bttvInflight.delete(id))
            }
          } else {
            bttvP = Promise.resolve(null)
          }
          // HeatSync personal set — the sender's added/custom emotes (public endpoint,
          // users.id == platform id). This is the ONLY source for an emote a user
          // added to heatsync that isn't in their 7TV/BTTV provider set (e.g. a 7TV
          // catalog emote added via the picker, or a self-hosted upload). Without it,
          // those emotes render only for the sender themselves and as raw text for
          // everyone else. Numeric ids only (twitch/kick; yt once twitch-resolved).
          // credentials:'omit' is REQUIRED: this public endpoint sends
          // Access-Control-Allow-Origin:* (for cross-origin extension reads), and a
          // CREDENTIALED request (the heatsync.org default in fetchWithTimeout) makes
          // the browser reject `*`+credentials — Firefox then drops the response and
          // the sender's heatsync emotes never load. No cookie is needed here anyway.
          // HeatSync set comes from the single batched fetch above (hsBatch), keyed by
          // platform-prefixed key (e.g. twitch:12345, kick:username).
          const hs = { emotes: hsBatch[key] || [] }
          const [stvRaw, bttvRaw] = await Promise.all([stvP, bttvP])
          const stvErrored = stvRaw === SENDER_FETCH_ERR
          const bttvErrored = bttvRaw === SENDER_FETCH_ERR
          const stv = stvErrored ? null : stvRaw
          const bttv = bttvErrored ? null : bttvRaw
          // 7TV active channel set (a useful proxy; TRUE personal sets merge below)
          const stvEmotes = stv?.emote_set?.emotes || []
          for (const e of stvEmotes) {
            if (!e?.name || !e?.id) continue
            const flags = (e.flags || 0) | (e.data?.flags || 0)
            collected[e.name] = {
              url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
              source: '7tv',
              state: 'global',
              zeroWidth: !!(flags & 257),
              hash: e.id,
              animated: !!e.data?.animated,
            }
          }
          // 7TV TRUE personal set — captured live from EventAPI entitlements
          const uid = key.startsWith('twitch:') ? key.slice(7) : null
          const personal = uid ? seventvPersonalSets.get(uid) : null
          if (personal) Object.assign(collected, personal)
          // BTTV personal — channelEmotes + sharedEmotes
          if (bttv) {
            const all = [...(bttv.channelEmotes || []), ...(bttv.sharedEmotes || [])]
            for (const e of all) {
              if (!e?.code || !e?.id) continue
              if (collected[e.code]) continue // 7TV wins on collision
              collected[e.code] = {
                url: `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
                source: 'bttv',
                state: 'global',
                zeroWidth: false,
                hash: e.id,
                os: bttvOversize(e),
              }
            }
          }
          // HeatSync personal set — overrides provider entries because it's the
          // sender's curated set (and what they actually post via heatsync). URLs
          // are already absolute (server normalizes /uploads/ → CDN). zero_width
          // arrives from the emotes table (added 2026-05-23, migration 164) so
          // cross-user overlay stacks ("wavE wavE wavE") render correctly. If the
          // server flag is missing (old payload / unmigrated row) we fall back to
          // any zeroWidth already collected via the 7TV personal-set loop above —
          // never blindly overwriting an overlay flag with false.
          const hsEmotes = hs?.emotes || []
          for (const e of hsEmotes) {
            const name = e?.custom_name || e?.name
            if (!name) continue
            // cw stub — the viewer's content filter hid this emote server-side
            // (no url, just the category). Carry it through so chat paints the
            // dashed cyan "hidden by filter" placeholder instead of raw text.
            // Overrides any same-name 7TV/BTTV entry, matching the normal
            // heatsync-set-wins precedence below.
            if (!e?.url && typeof e?.cw === 'string' && e.cw) {
              collected[name] = { url: '', source: 'heatsync', state: 'cw', cw: e.cw, zeroWidth: false, hash: '' }
              continue
            }
            if (!e?.url) continue
            const u = e.url
            // Server stores source:'extension' for ext-added emotes — meaningless to
            // the UI. Derive the real provider from the CDN url for an accurate label.
            const src = /cdn\.7tv\.app/.test(u)
              ? '7tv'
              : /cdn\.betterttv\.net/.test(u)
                ? 'bttv'
                : /cdn\.frankerfacez\.com/.test(u)
                  ? 'ffz'
                  : e.source && e.source !== 'extension'
                    ? e.source
                    : 'heatsync'
            const prevZW = collected[name]?.zeroWidth
            collected[name] = {
              url: u,
              source: src,
              // Inventory-time stamp (epoch ms) — processEmotes gates rendering
              // to messages sent after the sender actually owned the emote, so
              // a fresh collect never retro-imagifies their older messages.
              // heatsync entries only; 7TV/BTTV sets have no ownership time.
              addedAt: emoteAddedAtMs(e.added_at),
              // 2-state model: every pasteable shared emote is just 'global'.
              // processEmotes still upgrades to 'owned' if the viewer has the
              // name in their inventory; otherwise it renders identically to
              // any other global (white hover, click pastes, auto-add at send).
              state: 'global',
              zeroWidth: !!(e.zero_width ?? e.zeroWidth ?? prevZW),
              hash: e.hash || '',
              nsfw: !!e.nsfw, // v1.6 — cyan dashed border in chat + picker
            }
          }
          // Only cache when the result is trustworthy: a transient fetch error
          // must NOT be cached — even the 90s negative TTL wrongly blanks this
          // sender after the network recovers. A partial result (one provider
          // errored, another delivered) is also not cached — next flush retries
          // the failed leg. Error-free results (empty or not) cache normally;
          // cacheFresh picks the 5min/90s TTL by emptiness.
          const anyErrored = stvErrored || bttvErrored || _hsBatchErrored
          if (!anyErrored) {
            cache.set(key, { emotes: collected, ts: Date.now() })
            // LRU evict: keep most-recent 500. Each entry holds a sender's full
            // 7TV+BTTV personal set (potentially 100+ emote objects) — 5000 was
            // overkill for any realistic chatroom and bloated the SW heap.
            if (cache.size > 500) cache.delete(cache.keys().next().value)
          } else {
            erroredKeys.push(key)
          }
          result[key] = collected
        }),
      )
      sendResponse({ emotes: result, errored: erroredKeys })
    })()
    return true
  } else if (message.type === 'get_bulk_badges') {
    // Synchronous response — must call sendResponse before this handler yields,
    // or the message channel closes and the caller's promise hangs forever.
    // The cold-start "maps not loaded yet" race is handled on the client side:
    // the multichat retry-loader re-requests until non-empty, and initialize()
    // broadcasts a cosmetics_update once the storage restore lands.
    const bttvObj = {}
    for (const [k, v] of bttvBadgeMap) bttvObj[k] = v
    const ffzObj = {}
    for (const [k, v] of ffzBadgeMap) ffzObj[k] = v
    const chatterinoObj = {}
    for (const [k, v] of chatterinoBadgeMap) chatterinoObj[k] = v
    sendResponse({ bttvBadges: bttvObj, ffzBadges: ffzObj, chatterinoBadges: chatterinoObj })
    return
  } else if (message.type === 'mention_detected') {
    // Defense-in-depth: blocked users never trigger a mention notification,
    // regardless of which content-script path detected the @mention.
    // userSetMatches checks legacy bare keys first so pre-namespace entries still match.
    if (message.username && userSetMatches(blockedUsers, message.username, message.platform || null, [])) {
      sendResponse({ ok: true })
      return
    }
    // Fire a browser notification if the user has hs_notifications enabled.
    // Show the mention author's pfp (their face), falling back to the logo.
    browser.storage.local
      .get('hs_notifications')
      .then(async (data) => {
        if (!data.hs_notifications) return
        if (!browser.notifications) return
        const pfp = await resolveAvatarUrl(message.username, message.platform)
        const iconUrl = (await toNotifIconDataUrl(pfp)) || browser.runtime.getURL('icon-128.png')
        const notifId = `hs-mention-${Date.now()}`
        browser.notifications
          .create(notifId, {
            type: 'basic',
            iconUrl,
            title: message.username || 'mention',
            message: message.text || '',
          })
          .catch(() => {})
      })
      .catch(() => {})
    sendResponse({ ok: true })
    return
  } else if (message.type === 'resolve_avatar') {
    // Avatar lookup for the multichat panel's own Web Notification toasts.
    // Returns a data URL (resolve → inline) so panel toasts render reliably too.
    ;(async () => {
      try {
        const raw = await resolveAvatarUrl(message.username, message.platform)
        sendResponse({ url: (await toNotifIconDataUrl(raw)) || '' })
      } catch {
        sendResponse({ url: '' })
      }
    })()
    return true // async response
  } else if (message.type === 'resolve_avatar_url') {
    // Raw avatar URL (NOT a data URL) for in-chat avatar rendering — the browser
    // caches the image normally, so per-row avatars stay light on RAM. First-party
    // resolution (Twitch GQL / Kick v2).
    ;(async () => {
      try {
        sendResponse({ url: (await resolveAvatarUrl(message.username, message.platform)) || '' })
      } catch {
        sendResponse({ url: '' })
      }
    })()
    return true // async response
  }
}

// Initialize on startup
async function initialize() {
  log(' 🚀 Starting background script...')

  // Restore startup jitter deadline if SW was evicted mid-wait.
  try {
    const j = await (browser.storage.session?.get('startup_jitter_at') ?? Promise.resolve(null))
    const remaining = (j?.startup_jitter_at || 0) - Date.now()
    if (remaining > 0) pendingStartupJitterMs = remaining
    else if (j?.startup_jitter_at) browser.storage.session?.remove('startup_jitter_at').catch(() => {})
  } catch {}

  // Run auth load + storage batch reads + session restore in PARALLEL — all independent.
  // Saves ~60-90ms of serial waits vs. awaiting them sequentially.
  const tokenP = getAuthCookie().catch((err) => {
    log(' Could not load auth token:', err.message)
    return null
  })
  const storedP = browser.storage.local
    .get([
      'user_info',
      'channel_emotes_fetched_at',
      'channel_emotes_map',
      'seventv_emote_set_ids',
      'muted_users',
      'blocked_users',
      'global_emotes',
      'emote_inventory',
      'blocked_emotes',
      'local_blocked_emotes',
      'youtube_channel_urls',
      'yt_video_to_channel',
      'joined_extra_channels',
      'heatsync_multichat',
      'badges_fetched_at',
      'bttv_badge_map',
      'ffz_badge_map',
      'chatterino_badge_map',
      'user_cosmetics_cache',
      'twitch_id_cache',
    ])
    .catch((err) => {
      log(' Storage restore failed:', err.message)
      return {}
    })
  const sessionP = (
    browser.storage.session?.get(['tab_channels', 'joined_extra_channels']) ?? Promise.resolve(null)
  ).catch((e) => {
    console.warn('session storage restore failed:', e)
    return null
  })

  // Kick off WebSocket connect AS SOON AS auth resolves — don't wait for storage to finish.
  // If no auth token, surface that to content scripts so the multichat panel can prompt
  // the user. cookies.onChanged will broadcast loggedIn:true once they sign in.
  tokenP
    .then((t) => {
      if (!t) broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'no_token' })
      return connectWebSocket()
    })
    .catch(() => {})

  // Batch-load all cached state from storage in ONE read
  try {
    const stored = await storedP

    if (stored.user_info?.username) {
      currentUsername = stored.user_info.username
      log(' ✓ Restored username:', currentUsername)
    }
    if (stored.channel_emotes_fetched_at && typeof stored.channel_emotes_fetched_at === 'object') {
      channelEmotesFetchedAt = stored.channel_emotes_fetched_at
      log(' ✓ Restored channelEmotesFetchedAt for', Object.keys(channelEmotesFetchedAt).length, 'channels')
    }
    if (stored.channel_emotes_map && typeof stored.channel_emotes_map === 'object') {
      Object.assign(channelEmotesMap, stored.channel_emotes_map)
      log(' ✓ Restored channelEmotesMap for', Object.keys(stored.channel_emotes_map).length, 'channels')
    }
    if (stored.seventv_emote_set_ids && typeof stored.seventv_emote_set_ids === 'object') {
      for (const [ch, id] of Object.entries(stored.seventv_emote_set_ids)) {
        seventvEmoteSetIds.set(ch, id)
      }
      if (seventvEmoteSetIds.size > 0) {
        log(' ✓ Restored seventvEmoteSetIds for', seventvEmoteSetIds.size, 'channels')
        start7TVPolling()
        for (const setId of seventvEmoteSetIds.values()) subscribe7TVEmoteSet(setId)
      }
    }
    if (stored.muted_users && Array.isArray(stored.muted_users)) {
      mutedUsers = new Map()
      for (const entry of stored.muted_users) {
        if (typeof entry === 'string') mutedUsers.set(entry, null)
        else if (entry?.username) mutedUsers.set(entry.username, entry.expiresAt || null)
      }
      if (stored.muted_users.length > 0 && typeof stored.muted_users[0] === 'string') persistMutedUsers()
      pruneExpiredMutes()
      log(' ✓ Loaded', mutedUsers.size, 'muted users')
    }
    if (stored.blocked_users && Array.isArray(stored.blocked_users)) {
      blockedUsers = new Set(stored.blocked_users)
      log(' ✓ Loaded', blockedUsers.size, 'blocked users')
    }
    if (stored.twitch_id_cache && typeof stored.twitch_id_cache === 'object') {
      for (const [name, id] of Object.entries(stored.twitch_id_cache)) {
        if (typeof id === 'string' && /^\d+$/.test(id)) twitchIdCache.set(name, id)
      }
      log(' ✓ Restored twitchIdCache for', twitchIdCache.size, 'usernames')
    }
    // Warm emote arrays from storage cache (instant availability while API fetches run)
    if (Array.isArray(stored.global_emotes)) {
      globalEmotes = stored.global_emotes
      log(' ✓ Warm cache:', globalEmotes.length, 'global emotes from storage')
    }
    if (Array.isArray(stored.emote_inventory)) {
      emoteInventory = stored.emote_inventory
      log(' ✓ Warm cache:', emoteInventory.length, 'inventory emotes from storage')
    }
    if (Array.isArray(stored.blocked_emotes)) {
      blockedEmotes = new Set(stored.blocked_emotes)
      log(' ✓ Warm cache:', blockedEmotes.size, 'blocked emotes from storage')
    }
    if (stored.local_blocked_emotes && Array.isArray(stored.local_blocked_emotes)) {
      localBlockedEmotes = new Set(stored.local_blocked_emotes)
      log(' ✓ Warm cache:', localBlockedEmotes.size, 'local blocked emotes from storage')
    }
    if (stored.youtube_channel_urls && typeof stored.youtube_channel_urls === 'object') {
      // Purge any persisted __live_yt_auto__ — it's an ephemeral per-page binding
      // and must be re-bound from the current channel's explicit YT link, never
      // resurrected from storage. Older builds wrote a guessed @<name>/live here,
      // which is why a stranger's YT chat kept reappearing across reloads.
      if (stored.youtube_channel_urls.__live_yt_auto__) {
        delete stored.youtube_channel_urls.__live_yt_auto__
        browser.storage.local.set({ youtube_channel_urls: { ...stored.youtube_channel_urls } })
      }
      Object.assign(youtubeChannelUrls, stored.youtube_channel_urls)
      delete youtubeChannelUrls.__live_yt_auto__
      log(' ✓ Restored youtubeChannelUrls for', Object.keys(youtubeChannelUrls).length, 'channels')
      // Race fix: connectWebSocket() was kicked off at the top of init() and
      // may have already opened, iterating an empty youtubeChannelUrls in its
      // onopen handler — losing every YT subscription on SW wake. Replay them
      // explicitly now (mirrors the joined_extra_channels pattern below).
      // wsSend queues if not yet open, sends if open.
      for (const [channelId, url] of Object.entries(youtubeChannelUrls)) {
        const vidMatch =
          url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
        if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
        wsSend({ type: 'youtube:subscribe', url, channelId })
      }
      // Also replay the global YT subscription if one was set
      browser.storage.local
        .get(['youtube_url'])
        .then((d) => {
          if (d.youtube_url) {
            const vidMatch =
              d.youtube_url.match(/[?&]v=([^&]+)/) ||
              d.youtube_url.match(/\/live\/([^?&/]+)/) ||
              d.youtube_url.match(/youtu\.be\/([^?&]+)/)
            if (vidMatch) setYtVideoChannel(vidMatch[1], 'global')
            wsSend({ type: 'youtube:subscribe', url: d.youtube_url })
          }
        })
        .catch(() => {})
    }
    if (stored.yt_video_to_channel && typeof stored.yt_video_to_channel === 'object') {
      // Restore videoId→channelId routing so chat msgs from existing pollers
      // (server already broadcasting) land on the right tab even when the
      // server doesn't re-echo youtube:status connected on SW wake.
      // Skip __live_yt_auto__ targets — that binding is no longer restored, so
      // routing a video to it would orphan (or resurrect) a stale stream's chat.
      let _ytMapPoisoned = false
      for (const [vid, cids] of Object.entries(stored.yt_video_to_channel)) {
        // Accept both shapes: current array-of-channelIds and the legacy
        // single-string value written before the map went multi-valued.
        for (const cid of Array.isArray(cids) ? cids : [cids]) {
          if (cid === '__live_yt_auto__') {
            _ytMapPoisoned = true
            continue
          }
          const set = ytVideoToChannel.get(vid) || new Set()
          set.add(cid)
          ytVideoToChannel.set(vid, set)
        }
      }
      if (_ytMapPoisoned) persistYtVideoMap()
      log(' ✓ Restored ytVideoToChannel for', ytVideoToChannel.size, 'videos')
    }
    if (Array.isArray(stored.joined_extra_channels)) {
      // Restore Kick channel joins so the WS-connect handler replays them.
      // Survives extension reload (session storage didn't), so re-subscribes
      // fire automatically without waiting for a content-script re-init.
      let _ghostsDropped = false
      for (const key of stored.joined_extra_channels) {
        if (isGhostChannelKey(key)) {
          _ghostsDropped = true // persisted from the pre-blocklist era — purge
          continue
        }
        joinedExtraChannels.add(key)
      }
      if (_ghostsDropped) saveJoinedExtraChannels()
      log(' ✓ Restored', joinedExtraChannels.size, 'extra channel joins from local storage')
      // Replay joins on the WS now — connectWebSocket() was kicked off at the
      // start of init, so by the time storage restore finishes, the WS connect
      // handler may have ALREADY iterated an empty joinedExtraChannels Set.
      // wsSend queues if socket isn't open yet, sends immediately if it is —
      // either way, server gets the rejoin without waiting for content-script
      // multichat re-init.
      for (const key of joinedExtraChannels) {
        const [platform, channel] = key.split('/')
        if (platform && channel) {
          wsSend({ type: 'channel:join', platform, channel })
          // _kpChannels is a non-persisted Map — after SW eviction the Pusher
          // tap has forgotten every channel, and tap-only kick channels have
          // no other live source. Idempotent.
          if (platform === 'kick') kickPusherJoin(channel)
        }
      }
      // Also refetch channel owner emotes for every restored channel — the
      // WS rejoin above only subscribes to live broadcasts, it doesn't
      // refresh per-channel BTTV+FFZ+7TV sets. Without this, every multichat
      // tab except the active one renders raw text until the user clicks
      // each tab (content-side join_channel only fires for the page channel).
      // Internal cache-and-TTL gating in fetchChannelOwnerEmotes makes
      // duplicate calls cheap.
      for (const key of joinedExtraChannels) {
        const [platform, channel] = key.split('/')
        if (!platform || !channel) continue
        // Stagger by 50ms each to avoid 5-10 simultaneous third-party fetches.
        const delay = [...joinedExtraChannels].indexOf(key) * 50
        setTimeout(() => fetchChannelOwnerEmotes(channel, null, platform).catch(() => {}), delay)
      }
    }
    // Also seed joinedExtraChannels from the user's multichat config — covers
    // the very first launch after install (or storage wipe) before any content
    // script has fired kickChat.join. Without this, kick subs only start
    // working AFTER the user opens a streaming tab, not at SW boot.
    if (stored.heatsync_multichat?.channels) {
      const cfg = stored.heatsync_multichat.channels
      for (const ch of cfg) {
        if (typeof ch === 'string') continue
        if (ch.kick && typeof ch.kick === 'string') {
          const key = `kick/${ch.kick.toLowerCase()}`
          if (!joinedExtraChannels.has(key)) {
            joinedExtraChannels.add(key)
            wsSend({ type: 'channel:join', platform: 'kick', channel: ch.kick.toLowerCase() })
          }
          kickPusherJoin(ch.kick.toLowerCase())
        }
      }
      saveJoinedExtraChannels()
    }
    if (stored.badges_fetched_at && typeof stored.badges_fetched_at === 'number') {
      badgesFetchedAt = stored.badges_fetched_at
      log(' ✓ Restored badgesFetchedAt:', new Date(badgesFetchedAt).toISOString())
    }
    if (stored.user_cosmetics_cache && Array.isArray(stored.user_cosmetics_cache)) {
      const now = Date.now()
      let restored = 0
      for (const [key, val] of stored.user_cosmetics_cache) {
        if (!val?.fetchedAt) continue
        // Negative entries (no paint AND no badge) get the shorter TTL on
        // restore too — otherwise a stale null badge cache would suppress a
        // newly-granted 7TV badge for up to 30 min after extension reload.
        const isNegative = !val.paint && !val.badge
        const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
        if (now - val.fetchedAt < ttl) {
          userCosmeticsCache.set(key, val)
          restored++
        }
      }
      if (restored > 0) log(' ✓ Warm cache:', restored, 'user cosmetics from storage')
    }
    // Warm-cache 3rd-party badge maps so badges render immediately on cold start
    if (stored.bttv_badge_map && typeof stored.bttv_badge_map === 'object') {
      bttvBadgeMap = new Map(Object.entries(stored.bttv_badge_map))
      log(' ✓ Warm cache:', bttvBadgeMap.size, 'BTTV badge entries from storage')
    }
    if (stored.ffz_badge_map && typeof stored.ffz_badge_map === 'object') {
      ffzBadgeMap = new Map(Object.entries(stored.ffz_badge_map))
      log(' ✓ Warm cache:', ffzBadgeMap.size, 'FFZ badge entries from storage')
    }
    if (stored.chatterino_badge_map && typeof stored.chatterino_badge_map === 'object') {
      chatterinoBadgeMap = new Map(Object.entries(stored.chatterino_badge_map))
      log(' ✓ Warm cache:', chatterinoBadgeMap.size, 'Chatterino badge entries from storage')
    }
    // Push restored maps to tabs that loaded before this cold-wake restore landed.
    // Content scripts request get_bulk_badges during their own init; one of them
    // can arrive before the async restore completes and the multichat overlay,
    // which inits early, may receive an empty response with no later recovery
    // (cosmetics_update only re-broadcasts on a fresh fetch). A warm-cache push
    // here gives every already-listening surface the maps regardless of timing.
    if (ffzBadgeMap.size || bttvBadgeMap.size || chatterinoBadgeMap.size) {
      broadcastBadgeMaps()
    }
  } catch (err) {
    log(' Storage restore failed:', err.message)
  }

  // Restore tabChannels from session storage (survives worker restarts) — already in flight from initialize()
  try {
    const session = await sessionP
    if (session?.tab_channels) {
      // Validate restored tab IDs still exist
      const allTabs = await browser.tabs.query({
        url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*'],
      })
      const validIds = new Set(allTabs.map((t) => t.id))
      for (const [tabId, entry] of Object.entries(session.tab_channels)) {
        const id = Number(tabId)
        if (validIds.has(id)) tabChannels.set(id, entry)
      }
      log(' ✓ Restored', tabChannels.size, 'tab channels from session storage')
      // Replay joins on the WS now — same race as joinedExtraChannels above:
      // connectWebSocket() was kicked off at the start of init, so the connect
      // burst may have ALREADY iterated an empty tabChannels Map. wsSend
      // queues if the socket isn't open yet; server tolerates duplicate joins.
      const replayedTabJoins = new Set()
      for (const entry of tabChannels.values()) {
        if (!entry.channel || replayedTabJoins.has(entry.channel)) continue
        replayedTabJoins.add(entry.channel)
        const [platform, channel] = entry.channel.split('/')
        if (!platform || !channel) continue
        wsSend({ type: 'channel:join', platform, channel })
        if (platform === 'kick') kickPusherJoin(channel)
      }
    }
    if (Array.isArray(session?.joined_extra_channels)) {
      // Migration path — old code persisted to session. Pull anything still
      // there and bake it into the local-storage-backed Set on next save.
      for (const key of session.joined_extra_channels) {
        if (!isGhostChannelKey(key)) joinedExtraChannels.add(key)
      }
    }
  } catch (e) {
    console.warn('session storage restore failed:', e)
  }

  // Broadcast warm-cached badges immediately (before fresh fetch)
  if (bttvBadgeMap.size > 0 || ffzBadgeMap.size > 0 || chatterinoBadgeMap.size > 0) {
    broadcastBadgeMaps()
  }

  // Start WebSocket immediately (don't wait for API fetches)
  connectWebSocket().catch(() => {})

  broadcastToTabs({ type: 'loading_status', text: 'loading emotes...' })

  // Fetch fresh data in parallel (updates warm cache)
  Promise.all([
    fetchGlobalEmotes(),
    fetchBulkBadges(),
    fetchEmoteInventory(),
    fetchBlockedEmotes(),
    fetchFollowedUsers(),
    fetchUserInfo(),
    fetchViewerSettings(),
  ])
    .then(() => {
      log(' ✓ All fetches complete - global:', globalEmotes.length, 'personal:', emoteInventory.length)
      broadcastToTabs({ type: 'loading_status', done: true })
      // Persist fresh data — single batched write (fire-and-forget, don't await).
      // emote_inventory is gated on inventoryFetchOK: if the API call failed
      // transiently, the in-memory array is the warm cache from storage and
      // writing it back is a no-op; if the API call clobbered it to [] on a
      // 401 the logout path already cleaned storage. Either way, never let a
      // post-init persist overwrite a healthy warm cache with [].
      const persist = {
        blocked_emotes: Array.from(blockedEmotes),
      }
      // Only persist a non-empty global set. globalEmotes is [] when every provider
      // (BTTV/FFZ/7TV/twitch) failed this fetch (network/VPN blip) — like the
      // emote_inventory gate below, never overwrite a healthy warm cache with [].
      // Global sets are platform-wide and never legitimately empty, so [] == failure.
      if (globalEmotes.length > 0) {
        persist.global_emotes = globalEmotes
      }
      if (inventoryFetchOK) {
        persist.emote_inventory = emoteInventory
      }
      // user_info is no longer batched here — fetchUserInfo() persists it the
      // moment it has it, so it can't be lost when this batch never runs.
      browser.storage.local.set(persist).catch(() => {})
    })
    .catch((err) => log(' Fetch error:', err.message))

  // Re-register push subscription after MV3 service worker restart.
  // The cookie-onChanged path only fires on login/logout; on cold SW wake
  // with an existing valid token, push must be re-confirmed against the server
  // so the endpoint stays active.
  if (authToken) {
    subscribeToPush(authToken).catch((err) => log(' subscribeToPush retry failed:', err?.message))
  }

  // Inventory refresh driven by chrome.alarms 'refresh-emote-inventory' (MV3 setInterval dies with SW)

  // Global emotes refresh handled by chrome.alarms (MV3 setInterval unreliable for long durations)
}

log(' 🚀 Calling initialize()...')
initPromise = initialize().catch((err) => {
  console.error('[heatsync] Initialize failed:', err)
})

// Diag snapshot for bug reports — gathered on demand, never stored.
// Combines SW-side runtime state with the most recently active tab's page-side
// state (hs_diag_page key, written by content.js). No PII; counts and states only.
function _wsLabel(ws) {
  if (!ws) return 'null'
  const s = ws.readyState
  return s === 0 ? 'connecting' : s === 1 ? 'open' : s === 2 ? 'closing' : 'closed'
}
async function buildDiagSnapshot() {
  const now = Date.now()
  const out = { ts: now, ver: 'unknown', sw: {}, page: null }
  try {
    out.ver = browser.runtime.getManifest().version
  } catch {}
  try {
    out.sw.irc = {
      state: _wsLabel(BG_IRC?.ws),
      lastDataAgeMs: BG_IRC?.lastData ? now - BG_IRC.lastData : null,
      channels: BG_IRC?.channels?.size || 0,
      liveTabs: BG_IRC?.liveTabs?.size || 0,
      reconnectAttempts: BG_IRC?.reconnectAttempts || 0,
    }
  } catch {}
  try {
    out.sw.ws7tv = _wsLabel(seventvWebSocket)
  } catch {}
  try {
    out.sw.wsHs = _wsLabel(socket)
  } catch {}
  try {
    out.sw.inventory = Array.isArray(emoteInventory) ? emoteInventory.length : 0
  } catch {}
  try {
    out.sw.blocked = blockedEmotes?.size || 0
  } catch {}
  try {
    out.sw.channelEmotes = Object.keys(channelEmotesMap || {}).length
  } catch {}
  try {
    const h = await getCachedHealth()
    const { hs_health_at } = await browser.storage.local.get('hs_health_at')
    out.sw.health = {
      kill: !!h.kill,
      ext_min: h.ext_min || '',
      disabledN: (h.disabled || []).length,
      msgPresent: !!h.msg,
      ageMs: hs_health_at ? now - hs_health_at : null,
    }
  } catch {}
  try {
    const { hs_diag_page } = await browser.storage.local.get('hs_diag_page')
    if (hs_diag_page && typeof hs_diag_page === 'object') {
      out.page = { ...hs_diag_page, ageMs: hs_diag_page.ts ? now - hs_diag_page.ts : null }
    }
  } catch {}
  return out
}

// ============================================
// WEB PUSH SUBSCRIPTION
// ============================================
// MV3: service workers support PushManager via self.registration.pushManager.
// Firefox has NO push here: MV2 background pages run in a Window (no
// self.registration), and FF doesn't support the Push API in extension
// contexts at all — subscribeToPush no-ops there by design. FF's persistent
// background page keeps the WS alive, which covers live notifications.
// Notification.permission check is skipped — extensions have implicit grant
// via the 'notifications' manifest permission.

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const out = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i)
  return out
}

async function subscribeToPush(token) {
  try {
    if (!self.registration?.pushManager) {
      log(' PushManager not available — skipping push subscription')
      return
    }
    // Fast-path: storage marker means we already confirmed a subscription this
    // browser session — skip the getSubscription() call entirely. Cleared on
    // logout / unsubscribe paths. Cuts SW-wake noise across 100k clients.
    try {
      const m = await chrome.storage.session?.get?.('hs_push_ok')
      if (m?.hs_push_ok) return
    } catch {}
    const existing = await self.registration.pushManager.getSubscription()
    if (existing) {
      log(' Push already subscribed:', `${existing.endpoint.slice(0, 40)}...`)
      try {
        chrome.storage.session?.set?.({ hs_push_ok: 1 })
      } catch {}
      return
    }
    const keyRes = await fetchWithTimeout(`${API_URL}/api/push/vapid-key`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!keyRes.ok) {
      log(' VAPID key fetch failed:', keyRes.status)
      return
    }
    const keyData = await keyRes.json()
    const vapidKey = keyData.key
    if (!vapidKey) {
      log(' VAPID key missing in response')
      return
    }
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapidKey),
    })
    const subJson = sub.toJSON()
    const subRes = await fetchWithTimeout(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
      }),
    })
    if (!subRes.ok) {
      log(' Push subscribe POST failed:', subRes.status)
      return
    }
    log(' Push subscription registered')
    try {
      chrome.storage.session?.set?.({ hs_push_ok: 1 })
    } catch {}
  } catch (err) {
    log(' subscribeToPush error:', err?.message)
  }
}

async function unsubscribeFromPush(token) {
  try {
    if (!self.registration?.pushManager) return
    try {
      chrome.storage.session?.remove?.('hs_push_ok')
    } catch {}
    const sub = await self.registration.pushManager.getSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    if (token) {
      // DELETE, not POST — the server only ever registered DELETE, so this
      // 404'd every time and the swallowed error hid it. The push_subscriptions
      // row then survived until a later send hit the dead endpoint and
      // self-pruned it, costing one guaranteed failed push per stale row.
      await fetchWithTimeout(`${API_URL}/api/push/unsubscribe`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint }),
      }).catch((err) => log(' push unsubscribe failed:', err?.message))
    }
    log(' Push subscription removed')
  } catch (err) {
    log(' unsubscribeFromPush error:', err?.message)
  }
}

// Receive a push message and show a notification
self.addEventListener('push', (ev) => {
  let title = 'HeatSync'
  let body = ''
  // Use runtime.getURL so the icon resolves inside the extension package
  const icon = browser.runtime.getURL('icon-48.png')
  let data = {}
  try {
    if (ev.data) {
      const payload = ev.data.json()
      title = payload.title || title
      body = payload.body || body
      // Don't accept payload.icon — would let server set arbitrary URLs
      data = payload.data || {}
    }
  } catch (_e) {
    body = ev.data?.text() || ''
  }
  ev.waitUntil(self.registration.showNotification(title, { body, icon, data }))
})

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close()
  const url = ev.notification.data?.url
  // Only open URLs on our own origin — server payloads are untrusted
  if (typeof url === 'string' && url.startsWith('https://heatsync.org/')) {
    ev.waitUntil(clients.openWindow(url))
  }
})

// ============================================================================
// BG TWITCH IRC READER — reload-safe connection
// ============================================================================
// Owns the read-only Twitch IRC connection. Survives content tab reloads —
// the WebSocket lives in the SW, persists across page navigations, and
// serves history instantly. Per-tab auth-irc.js still handles SENDING.
//
// Message flow:
//   tab → 'bg_irc_join' / 'bg_irc_part'      (channel subscription)
//   tab → 'bg_irc_history' (req)             (instant buffer hand-off)
//   bg  → 'bg_irc_msg' (broadcast)           (live + history backfill events)
//   bg  → 'bg_irc_history_merged' (broadcast) (robotty filled in late msgs)

const BG_IRC_PERSIST_MAX = 3000
const BG_IRC_PERSIST_DEBOUNCE_MS = 1500
const BG_IRC_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/
// Bump whenever IRC parser semantics change. bgIrcRestoreFromStorage wipes
// hs_irc_* cached buffers + lastRobottyAt so robotty refetches everything
// through the new parser. v3: BG USERNOTICE parser now extracts tags.emotes,
// promotes viewermilestone+watch-streak → 'watchstreak' msgId, and carries
// streakCount — mirrors the content-script parser.
const BG_IRC_PARSER_VERSION = 3

function bgIrcSanitizeColor(c) {
  if (!c) return '#fff'
  return BG_IRC_COLOR_RE.test(c) ? c : '#fff'
}

function bgIrcParseEmotesTag(emotesTag, text) {
  if (!emotesTag) return null
  // Twitch positions count code points; slice counts UTF-16 units. Parity
  // copy of src/multichat/irc.js parseTwitchEmotesTag — keep in sync.
  const cps = /[\uD800-\uDFFF]/.test(text) ? Array.from(text) : null
  const out = {}
  for (const part of emotesTag.split('/')) {
    const [emoteId, posStr] = part.split(':')
    if (!emoteId || !posStr) continue
    const firstPos = posStr.split(',')[0]
    const [start, end] = firstPos.split('-').map(Number)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    const name = cps ? cps.slice(start, end + 1).join('') : text.slice(start, end + 1)
    if (name && !out[name]) {
      out[name] = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function bgIrcParseTags(tagStr) {
  const tags = {}
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      tags[part] = ''
      continue
    }
    tags[part.slice(0, eq)] = part.slice(eq + 1) || ''
  }
  return tags
}

// IRCv3 tag-value unescape: \s→space, \:→";", \\→"\", \r→CR, \n→LF.
// Tag values are backslash-escaped, NOT percent-encoded — decodeURIComponent
// throws URIError on any bare '%' (e.g. "im 100% sure") and silently corrupts
// valid-looking sequences like '%20'.
function bgIrcTagUnescape(v) {
  if (!v || v.indexOf('\\') === -1) return v
  let out = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = v[++i]
    if (n === 's') out += ' '
    else if (n === ':') out += ';'
    else if (n === '\\') out += '\\'
    else if (n === 'r') out += '\r'
    else if (n === 'n') out += '\n'
    else if (n !== undefined) out += n
  }
  return out
}

function bgIrcParseLine(raw, channelHint) {
  try {
    const tagsMatch = raw.match(/^@([^ ]+)/)
    if (!tagsMatch) return null
    const tags = bgIrcParseTags(tagsMatch[1])

    const privmsg = raw.match(/PRIVMSG #([^ ]+) :(.+)$/)
    if (privmsg) {
      const displayName = tags['display-name'] || 'anonymous'
      // Extract IRC source login (correct for unicode display names where
      // display.toLowerCase() ≠ login). Format: :user!user@user.tmi.twitch.tv
      const loginMatch = raw.match(/^@[^ ]+ :([^!]+)!/)
      const login = loginMatch ? loginMatch[1] : ''
      let text = privmsg[2]
      let isAction = false
      if (text.charCodeAt(0) === 1 && text.startsWith('\x01ACTION ')) {
        text = text.slice(8, text.endsWith('\x01') ? -1 : undefined)
        isAction = true
      }
      const msg = {
        user: displayName,
        login,
        userId: tags['user-id'] || '',
        text,
        color: bgIrcSanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channelHint || privmsg[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: tags.id || '',
        replyTo: tags['reply-parent-display-name']
          ? {
              user: bgIrcTagUnescape(tags['reply-parent-display-name']),
              text: tags['reply-parent-msg-body'] ? bgIrcTagUnescape(tags['reply-parent-msg-body']) : '',
              id: tags['reply-parent-msg-id'] || '',
              // Twitch-resolved id — lets the multichat renderer paint the reply
              // target with their own cosmetic synchronously, without waiting on
              // the async name→uid resolve (see src/multichat/irc.js's parseIrcLine,
              // which already carries this; this copy had drifted from it).
              userId: tags['reply-parent-user-id'] || '',
              threadId: tags['reply-thread-parent-msg-id'] || tags['reply-parent-msg-id'] || '',
            }
          : null,
      }
      const twitchEmotes = bgIrcParseEmotesTag(tags.emotes, text)
      if (twitchEmotes) msg.twitchEmotes = twitchEmotes
      if (isAction) msg.isAction = true
      const bits = parseInt(tags.bits, 10) || 0
      if (bits > 0) msg.bits = bits
      if (tags['custom-reward-id']) {
        msg.redeemed = true
        msg.rewardId = tags['custom-reward-id']
      }
      if (tags['msg-id'] === 'highlighted-message') msg.isHighlighted = true
      if (tags['first-msg'] === '1') msg.isFirstMsg = true
      const badgeInfo = tags['badge-info']
      if (badgeInfo) {
        const subMatch = badgeInfo.match(/subscriber\/(\d+)/)
        if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
      }
      return msg
    }

    const usernotice = raw.match(/USERNOTICE #([^ ]+)(?: :(.+))?$/)
    if (usernotice) {
      const displayName = tags['display-name'] || 'system'
      const subPlan = tags['msg-param-sub-plan'] || ''
      const tier =
        subPlan === '2000' ? '2' : subPlan === '3000' ? '3' : subPlan === 'Prime' ? 'prime' : subPlan ? '1' : ''
      const months = parseInt(tags['msg-param-cumulative-months'], 10) || parseInt(tags['msg-param-months'], 10) || 0
      const giftCount = parseInt(tags['msg-param-mass-gift-count'], 10) || 0
      const recipient = tags['msg-param-recipient-display-name']
        ? bgIrcTagUnescape(tags['msg-param-recipient-display-name'])
        : ''
      const raidViewers = parseInt(tags['msg-param-viewerCount'], 10) || 0
      const raidFrom = tags['msg-param-displayName'] ? bgIrcTagUnescape(tags['msg-param-displayName']) : ''
      const announceColor = tags['msg-param-color'] || ''
      const bitsTier = parseInt(tags['msg-param-threshold'], 10) || 0
      const category = tags['msg-param-category'] || ''
      const rawMsgId = tags['msg-id'] || ''
      const msgId = rawMsgId === 'viewermilestone' && category === 'watch-streak' ? 'watchstreak' : rawMsgId
      const streakCount = msgId === 'watchstreak' ? parseInt(tags['msg-param-value'], 10) || 0 : 0
      const userText = usernotice[2] || ''
      const twitchEmotes = bgIrcParseEmotesTag(tags.emotes, userText)
      return {
        user: displayName,
        text: userText,
        systemMsg: bgIrcTagUnescape(tags['system-msg'] || ''),
        color: bgIrcSanitizeColor(tags.color || '#fff'),
        badges: tags.badges || '',
        channel: channelHint || usernotice[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        type: 'usernotice',
        msgId,
        subTier: tier,
        subMonths: months,
        giftCount,
        recipient,
        raidViewers,
        raidFrom,
        announceColor,
        bitsTier,
        streakCount,
        twitchEmotes: twitchEmotes || undefined,
        id: tags.id || '',
      }
    }

    const notice = raw.match(/NOTICE #([^ ]+) :(.+)$/)
    if (notice) {
      const ch = channelHint || notice[1].toLowerCase()
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      const noticeType = tags['msg-id'] || ''
      const detId = `notice-${ch}-${time}-${notice[2].slice(0, 64)}`
      return {
        type: 'notice',
        noticeType,
        user: 'system',
        text: notice[2],
        color: '#808080',
        badges: '',
        channel: ch,
        time,
        id: tags.id || detId,
        systemMsg: notice[2],
      }
    }

    const roomstate = raw.match(/ROOMSTATE #([^ ]+)/)
    if (roomstate) {
      const ch = channelHint || roomstate[1].toLowerCase()
      return {
        type: 'roomstate',
        channel: ch,
        time: Date.now(),
        slow: tags.slow != null ? parseInt(tags.slow, 10) : null,
        subsOnly: tags['subs-only'] != null ? tags['subs-only'] === '1' : null,
        emoteOnly: tags['emote-only'] != null ? tags['emote-only'] === '1' : null,
        followersOnly: tags['followers-only'] != null ? parseInt(tags['followers-only'], 10) : null,
        r9k: tags.r9k != null ? tags.r9k === '1' : null,
      }
    }

    const userstate = raw.match(/USERSTATE #([^ ]+)/)
    if (userstate) {
      const ch = channelHint || userstate[1].toLowerCase()
      const badgeNames = []
      for (const part of (tags.badges || '').split(',')) {
        const name = part.split('/')[0]
        if (name) badgeNames.push(name)
      }
      // rawBadges keeps tier suffixes (`subscriber/40`) for our synthetic
      // celebrations to stamp the right sub badge before the user has sent
      // a message on this channel. badges Set drops tiers, used elsewhere
      // for membership gating.
      return { type: 'userstate', channel: ch, badges: badgeNames, rawBadges: tags.badges || '', time: Date.now() }
    }

    const clearchat = raw.match(/CLEARCHAT #([^ ]+)(?: :(.+))?$/)
    if (clearchat) {
      const target = clearchat[2] || ''
      const duration = tags['ban-duration']
      const text = target
        ? duration
          ? `${target} timed out for ${duration}s`
          : `${target} was permanently banned`
        : 'chat cleared'
      const ch = channelHint || clearchat[1].toLowerCase()
      const time = parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now()
      const detId = `clearchat-${ch}-${target}-${duration || 'perma'}-${time}`
      return {
        type: 'notice',
        noticeType: duration ? 'timeout_success' : 'ban_success',
        user: 'system',
        text,
        color: '#808080',
        badges: '',
        channel: ch,
        time,
        id: tags.id || detId,
        systemMsg: text,
        targetUser: target,
        targetUserId: tags['target-user-id'] || '',
        banDuration: duration ? parseInt(duration, 10) : 0,
      }
    }

    const clearmsg = raw.match(/CLEARMSG #([^ ]+) :(.+)$/)
    if (clearmsg) {
      const targetMsgId = tags['target-msg-id']
      const text = `${tags.login || 'unknown'}'s message was deleted`
      return {
        type: 'notice',
        noticeType: 'delete_message_success',
        user: 'system',
        text,
        color: '#808080',
        badges: '',
        channel: channelHint || clearmsg[1].toLowerCase(),
        time: parseInt(tags['tmi-sent-ts'], 10) || parseInt(tags['rm-received-ts'], 10) || Date.now(),
        id: targetMsgId || `clearmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        systemMsg: text,
        targetUser: tags.login || '',
        targetMsgId: targetMsgId || '',
      }
    }

    return null
  } catch (_e) {
    return null
  }
}

class BGCircularBuffer {
  constructor(cap = BG_IRC_PERSIST_MAX) {
    this.buf = new Array(cap)
    this.cap = cap
    this.head = 0
    this.size = 0
  }
  push(item) {
    this.buf[this.head] = item
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
  }
  getAll() {
    if (this.size === 0) return []
    if (this.size < this.cap) return this.buf.slice(0, this.size)
    return this.buf.slice(this.head).concat(this.buf.slice(0, this.head))
  }
  clear() {
    this.buf = new Array(this.cap)
    this.head = 0
    this.size = 0
  }
}

const BG_IRC = {
  ws: null,
  partial: '',
  nick: `justinfan${Math.floor(Math.random() * 99999)}`,
  // Authed-reader upgrade: twitch periodically starves anonymous (justinfan)
  // IRC connections (ecosystem-wide anti-scrape throttling — history loads
  // via robotty but live delivery trickles). When a twitch tab hands us the
  // user's chat token we reconnect the reader authenticated; auth failure
  // falls straight back to anonymous, never worse than today.
  authToken: null,
  authNick: null,
  authFailed: false,
  authFailedAt: 0,
  channels: new Map(), // ch -> BGCircularBuffer
  tabInterest: new Map(), // tabId -> Set<channel>
  channelTabs: new Map(), // channel -> Set<tabId>
  lastData: 0,
  destroyed: false,
  idleClosed: false, // reader parked by scheduleWsIdleCheck (no platform tabs)
  reconnectTimer: null,
  reconnectAttempts: 0,
  heartbeatTimer: null,
  connectTimeout: null,
  chanLastSeen: new Map(),
  chanRejoinAttempts: new Map(),
  roomstates: new Map(),
  historyInFlight: new Map(), // ch -> Promise<void> (awaitable in-flight robotty fetch)
  lastRobottyAt: new Map(), // ch -> ts (last successful/attempted robotty fetch)
  persistTimers: new Map(),
  storageRestored: false,
  // Tabs that have requested live broadcasts. Empty initially — we don't
  // broadcast until at least one tab has joined a channel, so a freshly
  // installed extension with no chat tabs open isn't running for nothing.
  liveTabs: new Set(),
}

async function bgIrcRestoreFromStorage() {
  if (BG_IRC.storageRestored) return
  BG_IRC.storageRestored = true
  // authed-reader creds survive SW restarts (session storage; cleared when
  // the browser closes — the next twitch tab re-supplies them)
  try {
    const sess = await chrome.storage.session?.get?.('hs_irc_auth')
    const a = sess?.hs_irc_auth
    if (a?.token && a?.nick && !BG_IRC.authToken) {
      BG_IRC.authToken = a.token
      BG_IRC.authNick = a.nick
    }
  } catch {}
  try {
    const all = await chrome.storage.local.get(null)
    const storedVer = all.hs_irc_parser_version | 0
    if (storedVer !== BG_IRC_PARSER_VERSION) {
      const stale = Object.keys(all).filter(
        (k) => k.startsWith('hs_irc_') && !k.startsWith('hs_irc_sync_') && k !== 'hs_irc_parser_version',
      )
      if (stale.length) await chrome.storage.local.remove(stale).catch(() => {})
      await chrome.storage.local.set({ hs_irc_parser_version: BG_IRC_PARSER_VERSION }).catch(() => {})
      await chrome.storage.session?.remove?.('hs_irc_last_robotty').catch?.(() => {})
      log(
        'BG IRC parser version bump',
        storedVer,
        '→',
        BG_IRC_PARSER_VERSION,
        '— wiped',
        stale.length,
        'cached channel buffers',
      )
      return
    }
    let n = 0
    const expired = []
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_irc_') || k.startsWith('hs_irc_sync_') || k === 'hs_irc_parser_version') continue
      const ch = k.slice('hs_irc_'.length)
      // A key written before channel sanitization existed could carry protocol
      // characters straight back into the JOIN loop on restore — drop any key
      // whose channel isn't already in canonical form instead of trusting it.
      if (ch !== bgIrcSafeChannel(ch)) {
        expired.push(k)
        continue
      }
      // Missing/invalid ts counts as stale — unknown-age data fails safe.
      if (!ch || !v?.msgs?.length || !(Date.now() - (v.ts || 0) < 86400000)) {
        // Skipped buffers were previously left in storage forever — every
        // channel ever watched kept its full ring in storage.local unbounded.
        expired.push(k)
        continue
      }
      const buf = new BGCircularBuffer(BG_IRC_PERSIST_MAX)
      // Purge non-renderable types from legacy persisted buffers. Earlier
      // backfill paths pushed ROOMSTATE/USERSTATE/WHISPER into the ring;
      // they fill 500-msg toRender slots with null divs → chat appears empty.
      for (const m of v.msgs) {
        if (m?.type === 'roomstate' || m?.type === 'userstate' || m?.type === 'whisper') continue
        buf.push(m)
      }
      BG_IRC.channels.set(ch, buf)
      n++
    }
    if (expired.length) await chrome.storage.local.remove(expired).catch(() => {})
    log('BG IRC restored', n, 'channels from storage', expired.length ? `(purged ${expired.length} stale)` : '')
  } catch (e) {
    log('BG IRC restore failed:', e.message)
  }
  // Restore lastRobottyAt from session storage — survives SW eviction within
  // the same browser session. Without this, every SW wake refetched robotty
  // for every joined channel, hammering a community-run free service.
  try {
    const sess = await chrome.storage.session?.get?.('hs_irc_last_robotty')
    const obj = sess?.hs_irc_last_robotty
    if (obj && typeof obj === 'object') {
      for (const [ch, ts] of Object.entries(obj)) {
        if (typeof ts === 'number') BG_IRC.lastRobottyAt.set(ch, ts)
      }
    }
  } catch {}
}

const ROBOTTY_PERSIST_DEBOUNCE_MS = 2000
const ROBOTTY_TS_MAX_CHANNELS = 200
const COOLDOWN_TS_MAX_CHANNELS = 200
const MAX_BG_IRC_CHANNELS = 100
const MAX_BG_KICK_CHANNELS = 50
const MAX_BG_YT_CHANNELS = 30

function pruneMap(map, max) {
  if (map.size <= max) return
  const excess = map.size - max
  const it = map.keys()
  for (let i = 0; i < excess; i++) map.delete(it.next().value)
}
let _robottyPersistTimer = null
function bgIrcPersistRobottyTs() {
  if (_robottyPersistTimer) return
  _robottyPersistTimer = setTimeout(() => {
    _robottyPersistTimer = null
    try {
      // Cap entries — long-running SW with channel churn shouldn't grow forever.
      if (BG_IRC.lastRobottyAt.size > ROBOTTY_TS_MAX_CHANNELS) {
        const excess = BG_IRC.lastRobottyAt.size - ROBOTTY_TS_MAX_CHANNELS
        const it = BG_IRC.lastRobottyAt.keys()
        for (let i = 0; i < excess; i++) BG_IRC.lastRobottyAt.delete(it.next().value)
      }
      const obj = Object.fromEntries(BG_IRC.lastRobottyAt)
      chrome.storage.session?.set?.({ hs_irc_last_robotty: obj })?.catch?.(() => {})
    } catch {}
  }, ROBOTTY_PERSIST_DEBOUNCE_MS)
}

function bgIrcPersistChannel(ch) {
  if (BG_IRC.persistTimers.has(ch)) return
  BG_IRC.persistTimers.set(
    ch,
    setTimeout(() => {
      BG_IRC.persistTimers.delete(ch)
      try {
        const buf = BG_IRC.channels.get(ch)
        if (!buf) return
        const msgs = buf.getAll()
        chrome.storage.local.set({ [`hs_irc_${ch}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, BG_IRC_PERSIST_DEBOUNCE_MS),
  )
}

function bgIrcConnect() {
  if (BG_IRC.destroyed) return
  BG_IRC.idleClosed = false // any explicit connect un-parks the reader
  if (BG_IRC.ws && BG_IRC.ws.readyState === WebSocket.CONNECTING) return
  bgIrcStopHeartbeat()
  if (BG_IRC.reconnectTimer) {
    clearTimeout(BG_IRC.reconnectTimer)
    BG_IRC.reconnectTimer = null
  }
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onopen = null
      BG_IRC.ws.onmessage = null
      BG_IRC.ws.onerror = null
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
  BG_IRC.partial = ''
  if (BG_IRC.connectTimeout) clearTimeout(BG_IRC.connectTimeout)
  BG_IRC.connectTimeout = setTimeout(() => {
    if (BG_IRC.ws?.readyState !== WebSocket.OPEN) {
      log('BG IRC: connect timeout')
      try {
        BG_IRC.ws?.close()
      } catch {}
    }
  }, 10000)

  BG_IRC.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  BG_IRC.ws.onopen = () => {
    clearTimeout(BG_IRC.connectTimeout)
    log('BG IRC: connected')
    BG_IRC.reconnectAttempts = 0
    BG_IRC.lastData = Date.now()
    const now = Date.now()
    for (const ch of BG_IRC.channels.keys()) BG_IRC.chanLastSeen.set(ch, now)
    BG_IRC.chanRejoinAttempts.clear()
    // transient login failures un-stick after 30min (token may have healed)
    if (BG_IRC.authFailed && Date.now() - (BG_IRC.authFailedAt || 0) > 30 * 60_000) BG_IRC.authFailed = false
    if (BG_IRC.authToken && BG_IRC.authNick && !BG_IRC.authFailed) {
      BG_IRC.ws.send(`PASS oauth:${BG_IRC.authToken}\r\n`)
      BG_IRC.ws.send(`NICK ${BG_IRC.authNick}\r\n`)
      log('BG IRC: authed as', BG_IRC.authNick)
    } else {
      BG_IRC.ws.send(`NICK ${BG_IRC.nick}\r\n`)
    }
    BG_IRC.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n')
    for (const ch of BG_IRC.channels.keys()) {
      if (BG_IRC.ws.readyState !== WebSocket.OPEN) return
      BG_IRC.ws.send(`JOIN #${ch}\r\n`)
    }
    bgIrcStartHeartbeat()
    // Gap-fill: SW eviction + WS dropout can lose minutes of chat. On every
    // (re)connect, refetch robotty for each channel to backfill the gap.
    // 60s per-channel cooldown keeps us polite during flappy reconnects;
    // historyInFlight prevents concurrent fetches when ensureChannel races.
    const reconnectGapMs = 60_000
    const now2 = Date.now()
    for (const ch of BG_IRC.channels.keys()) {
      const last = BG_IRC.lastRobottyAt.get(ch) || 0
      if (now2 - last < reconnectGapMs) continue
      bgIrcFetchRobotty(ch)
    }
  }
  BG_IRC.ws.onmessage = (e) => bgIrcOnData(e.data)
  BG_IRC.ws.onerror = () => {
    clearTimeout(BG_IRC.connectTimeout)
  }
  BG_IRC.ws.onclose = () => {
    clearTimeout(BG_IRC.connectTimeout)
    bgIrcStopHeartbeat()
    if (BG_IRC.destroyed) return
    bgIrcScheduleReconnect()
  }
}

function bgIrcScheduleReconnect() {
  if (BG_IRC.destroyed) return
  if (BG_IRC.reconnectTimer) clearTimeout(BG_IRC.reconnectTimer)
  const base = Math.min(2000 * 2 ** BG_IRC.reconnectAttempts, 15000)
  const delay = base + Math.random() * 2000
  BG_IRC.reconnectAttempts++
  log('BG IRC: reconnect in', Math.round(delay), 'ms (attempt', BG_IRC.reconnectAttempts, ')')
  BG_IRC.reconnectTimer = setTimeout(() => {
    if (!BG_IRC.destroyed) bgIrcConnect()
  }, delay)
}

function bgIrcForceReconnect() {
  bgIrcStopHeartbeat()
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
  if (!BG_IRC.destroyed) bgIrcConnect()
}

// Park the reader when the last platform tab closes (scheduleWsIdleCheck).
// Its 20s heartbeat otherwise extends the SW lifetime forever (Chrome 116+
// WS-activity rule), pinning every BG buffer in RAM for a user who isn't on
// any chat site. Buffers are already debounce-persisted per message, so the
// reopen path (idle-check else-branch / bg_irc_join) loses nothing.
function bgIrcIdleClose() {
  BG_IRC.idleClosed = true
  bgIrcStopHeartbeat()
  if (BG_IRC.reconnectTimer) {
    clearTimeout(BG_IRC.reconnectTimer)
    BG_IRC.reconnectTimer = null
  }
  if (BG_IRC.connectTimeout) clearTimeout(BG_IRC.connectTimeout)
  if (BG_IRC.ws) {
    try {
      BG_IRC.ws.onopen = null
      BG_IRC.ws.onmessage = null
      BG_IRC.ws.onerror = null
      BG_IRC.ws.onclose = null
      BG_IRC.ws.close()
    } catch {}
    BG_IRC.ws = null
  }
}

function bgIrcStartHeartbeat() {
  bgIrcStopHeartbeat()
  BG_IRC.heartbeatTimer = trackInterval(
    setInterval(() => {
      if (!BG_IRC.ws || BG_IRC.ws.readyState !== WebSocket.OPEN) {
        bgIrcStopHeartbeat()
        if (!BG_IRC.destroyed) bgIrcScheduleReconnect()
        return
      }
      const now = Date.now()
      const silence = now - BG_IRC.lastData
      if (silence > 90000) {
        log('BG IRC: zombie detected —', Math.round(silence / 1000), 's silence')
        bgIrcForceReconnect()
        return
      }
      try {
        BG_IRC.ws.send('PING :heatsync\r\n')
      } catch {
        bgIrcForceReconnect()
        return
      }
      // Per-channel watchdog
      for (const ch of BG_IRC.channels.keys()) {
        const last = BG_IRC.chanLastSeen.get(ch) || 0
        if (!last) continue
        const chSilence = now - last
        if (chSilence < 120000) continue
        const attempts = BG_IRC.chanRejoinAttempts.get(ch) || 0
        if (attempts >= 2) {
          log('BG IRC: channel', ch, 'unresponsive — full reconnect')
          BG_IRC.chanRejoinAttempts.clear()
          bgIrcForceReconnect()
          return
        }
        log('BG IRC: channel', ch, 'silent — PART+JOIN')
        try {
          BG_IRC.ws.send(`PART #${ch}\r\n`)
          BG_IRC.ws.send(`JOIN #${ch}\r\n`)
          BG_IRC.chanLastSeen.set(ch, now)
          BG_IRC.chanRejoinAttempts.set(ch, attempts + 1)
        } catch {
          bgIrcForceReconnect()
          return
        }
      }
      // 20s interval (was 30s) — Chrome 116+ extends SW lifetime as long as any
      // WS frame in/out happens within a 30s window. 20s gives 10s safety margin.
    }, 20000),
  )
}

function bgIrcStopHeartbeat() {
  if (BG_IRC.heartbeatTimer) {
    untrackInterval(BG_IRC.heartbeatTimer)
    BG_IRC.heartbeatTimer = null
  }
}

function bgIrcOnData(data) {
  BG_IRC.lastData = Date.now()
  BG_IRC.partial += data
  if (BG_IRC.partial.length > 65536) BG_IRC.partial = ''
  const lines = BG_IRC.partial.split('\r\n')
  BG_IRC.partial = lines.pop()
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('PING')) {
      try {
        BG_IRC.ws.send('PONG :tmi.twitch.tv\r\n')
      } catch {}
      continue
    }
    // Authed-reader login rejected (expired/revoked token) — flag and fall
    // back to anonymous so the reader is never worse than the old default.
    if (line.includes('Login authentication failed') || line.includes('Improperly formatted auth')) {
      log('BG IRC: auth login failed — falling back to anonymous reader')
      BG_IRC.authFailed = true
      BG_IRC.authFailedAt = Date.now()
      bgIrcConnect()
      continue
    }
    if (line.startsWith(':tmi.twitch.tv PONG') || line.startsWith('PONG')) continue
    if (line.includes('RECONNECT')) {
      log('BG IRC: server requested RECONNECT')
      bgIrcForceReconnect()
      return
    }
    bgIrcHandleLine(line)
  }
}

// Collapse duplicate moderation notices (timeout/ban) for the same target that
// arrive across transports. A single `!vanish`/timeout reaches us from BOTH the
// direct IRC CLEARCHAT and the server EventSub fanout; the EventSub channel.ban
// path can also drop the timeout duration, surfacing a bogus "permanently
// banned" line next to the real "timed out for Ns". Each transport mints a
// different id, so id-dedupe misses these — match on (target, type, window)
// instead. First notice for a target wins within the window.
function bgIrcDupModNotice(buf, msg) {
  if (!buf || !msg || msg.type !== 'notice') return false
  if (msg.noticeType !== 'timeout_success' && msg.noticeType !== 'ban_success') return false
  const targetLc = (msg.targetUser || '').toLowerCase()
  if (!targetLc) return false
  const t = msg.time || 0
  for (const m of buf.getAll()) {
    if (m.type !== 'notice') continue
    if (m.noticeType !== 'timeout_success' && m.noticeType !== 'ban_success') continue
    if ((m.targetUser || '').toLowerCase() !== targetLc) continue
    if (Math.abs((m.time || 0) - t) > 10000) continue
    return true
  }
  return false
}

function bgIrcHandleLine(line) {
  const msg = bgIrcParseLine(line)
  if (!msg) return
  if (msg.channel) {
    BG_IRC.chanLastSeen.set(msg.channel, Date.now())
    // Healthy traffic clears the rejoin strike count — without this, two
    // historical lulls escalate the next quiet spell straight to a full
    // reconnect of every joined channel.
    BG_IRC.chanRejoinAttempts.delete(msg.channel)
  }

  if (msg.type === 'roomstate') {
    const prev = BG_IRC.roomstates.get(msg.channel) || {}
    const changes = []
    if (msg.slow != null && msg.slow !== prev.slow)
      changes.push(msg.slow > 0 ? `slow mode on (${msg.slow}s)` : 'slow mode off')
    if (msg.subsOnly != null && msg.subsOnly !== prev.subsOnly)
      changes.push(msg.subsOnly ? 'sub-only mode on' : 'sub-only mode off')
    if (msg.emoteOnly != null && msg.emoteOnly !== prev.emoteOnly)
      changes.push(msg.emoteOnly ? 'emote-only mode on' : 'emote-only mode off')
    if (msg.followersOnly != null && msg.followersOnly !== prev.followersOnly) {
      if (msg.followersOnly === -1) changes.push('follower-only mode off')
      else if (msg.followersOnly === 0) changes.push('follower-only mode on')
      else changes.push(`follower-only mode on (${msg.followersOnly}m)`)
    }
    if (msg.r9k != null && msg.r9k !== prev.r9k) changes.push(msg.r9k ? 'unique-chat mode on' : 'unique-chat mode off')
    const newState = { ...prev }
    for (const k of ['slow', 'subsOnly', 'emoteOnly', 'followersOnly', 'r9k']) {
      if (msg[k] != null) newState[k] = msg[k]
    }
    BG_IRC.roomstates.set(msg.channel, newState)
    if (changes.length && Object.keys(prev).length) {
      const buf = BG_IRC.channels.get(msg.channel)
      for (const text of changes) {
        const evt = {
          type: 'notice',
          noticeType: 'mode_change',
          user: 'system',
          text,
          color: '#808080',
          badges: '',
          channel: msg.channel,
          time: Date.now(),
          id: `mode-${msg.channel}-${Date.now()}-${text.slice(0, 16)}`,
          systemMsg: text,
        }
        if (buf) buf.push(evt)
        bgIrcPersistChannel(msg.channel)
        bgIrcBroadcast({ type: 'bg_irc_msg', msg: evt })
      }
    }
    bgIrcBroadcast({ type: 'bg_irc_msg', msg })
    return
  }

  if (msg.type === 'userstate' || msg.type === 'whisper') {
    bgIrcBroadcast({ type: 'bg_irc_msg', msg })
    return
  }

  // Apply CLEARCHAT/CLEARMSG annotations to existing buffer entries
  const buf = msg.channel ? BG_IRC.channels.get(msg.channel) : null
  // Drop a mod notice already delivered by another transport (the first wins +
  // ran the annotation/persist/broadcast below).
  if (bgIrcDupModNotice(buf, msg)) return
  if (buf && msg.type === 'notice' && (msg.noticeType === 'ban_success' || msg.noticeType === 'timeout_success')) {
    const targetLc = (msg.targetUser || '').toLowerCase()
    if (targetLc) {
      for (const m of buf.getAll()) {
        if (m.user && m.user.toLowerCase() === targetLc && !m.cleared) {
          m.cleared = true
          m.clearedReason = msg.banDuration ? `timed out (${msg.banDuration}s)` : 'banned'
        }
      }
    }
  }
  if (buf && msg.type === 'notice' && msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
    const id = msg.targetMsgId
    for (const m of buf.getAll()) {
      if (m.id === id) {
        m.cleared = true
        m.clearedReason = 'deleted'
        break
      }
    }
  }

  // PRIVMSG, USERNOTICE, NOTICE → store + broadcast.
  // Plain chat with an id marks the cross-source dedupe set (server
  // irc:message fanout may deliver the same message).
  if ((!msg.type || msg.type === 'usernotice') && msg.id && bgIrcSeenLiveId(`${msg.channel}:${msg.id}`)) return
  if (buf && (!msg.type || msg.type === 'usernotice' || msg.type === 'notice')) {
    buf.push(msg)
    bgIrcPersistChannel(msg.channel)
  }
  bgIrcBroadcast({ type: 'bg_irc_msg', msg })
}

// Cross-reference CLEARCHAT/CLEARMSG notices in a buffer against PRIVMSGs
// from the same window, so banned/deleted historical messages render cleared
// instead of as normal text. Live IRC handles this on the fly in
// bgIrcHandleLine, but the robotty backfill merges everything in one shot —
// without this pass, a user's pre-ban history shows up un-struck.
function bgIrcReconcileCleared(buf) {
  if (!buf) return
  const all = buf.getAll()
  if (!all.length) return
  const byId = new Map()
  for (const m of all) {
    if (!m.id) continue
    if (m.type === 'notice' || m.type === 'usernotice') continue
    byId.set(m.id, m)
  }
  // First pass: handle delete_message_success (O(1) per via byId) and build a
  // banMap of userLc -> {reason, eventTime} for ban/timeout notices (O(n)).
  const banMap = new Map()
  for (const m of all) {
    if (m.type !== 'notice') continue
    if (m.noticeType === 'delete_message_success' && m.targetMsgId) {
      const target = byId.get(m.targetMsgId)
      if (target && !target.cleared) {
        target.cleared = true
        target.clearedReason = 'deleted'
      }
      continue
    }
    if (m.noticeType !== 'timeout_success' && m.noticeType !== 'ban_success') continue
    const targetLc = (m.targetUser || '').toLowerCase()
    if (!targetLc) continue
    const eventTime = m.time || 0
    const reason = m.banDuration ? `timed out (${m.banDuration}s)` : 'banned'
    // Keep latest eventTime — last ban/timeout wins, clearing all prior msgs
    const existing = banMap.get(targetLc)
    if (!existing || eventTime > existing.eventTime) {
      banMap.set(targetLc, { reason, eventTime })
    }
  }
  // Second pass: single linear scan to apply ban/timeout clearings (O(n)).
  if (banMap.size > 0) {
    for (const v of all) {
      if (v.cleared || v.type === 'notice' || v.type === 'usernotice' || !v.user) continue
      const entry = banMap.get(v.user.toLowerCase())
      if (entry && (v.time || 0) <= entry.eventTime) {
        v.cleared = true
        v.clearedReason = entry.reason
      }
    }
  }
}

function bgIrcFetchRobotty(ch) {
  if (BG_IRC.historyInFlight.has(ch)) return BG_IRC.historyInFlight.get(ch)
  // 30s per-channel cooldown — protects robotty + our SW from thrash on
  // rapid page reloads / channel switches. Survives SW eviction via
  // chrome.storage.session (bgIrcPersistRobottyTs). At 100k users, SW-eviction
  // waves used to refetch robotty for every joined channel — this kills that.
  const lastAt = BG_IRC.lastRobottyAt.get(ch) || 0
  if (Date.now() - lastAt < 30_000) return Promise.resolve()
  BG_IRC.lastRobottyAt.set(ch, Date.now())
  bgIrcPersistRobottyTs()
  const p = (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      const resp = await fetch(
        `https://heatsync.org/api/recent-messages/${ch}?limit=1000&hide_moderation_messages=false&hide_moderated_messages=false&clearchatToNotice=true`,
        { signal: ctrl.signal, credentials: 'omit' },
      )
      clearTimeout(timer)
      if (!resp.ok) return
      const data = await resp.json()
      if (!data.messages?.length) return
      const buf = BG_IRC.channels.get(ch)
      if (!buf) return
      const existing = buf.getAll()
      const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
      const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
      const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
      const toAdd = []
      for (const line of data.messages) {
        const msg = bgIrcParseLine(line, ch)
        if (!msg) continue
        // Non-renderable types (roomstate/userstate/whisper) belong in their
        // dedicated maps, not the chat buffer. Live path filters them; without
        // this skip the backfill paths flooded the ring with mode-toggle dupes.
        if (msg.type === 'roomstate' || msg.type === 'userstate' || msg.type === 'whisper') continue
        msg.isHistory = true
        if (msg.id && existingIds.has(msg.id)) continue
        if (!msg.id && existingFp.has(fpKey(msg))) continue
        toAdd.push(msg)
      }
      if (toAdd.length === 0) {
        // Even on a no-op merge, reconcile — a live CLEARCHAT may have landed
        // for a user whose backfilled msgs predate it; this paints them cleared.
        bgIrcReconcileCleared(buf)
        return
      }
      const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
      buf.clear()
      for (const m of all) buf.push(m)
      bgIrcReconcileCleared(buf)
      bgIrcPersistChannel(ch)
      bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
      log('BG IRC robotty merged', toAdd.length, 'msgs for', ch)
    } catch (e) {
      log('BG IRC robotty fetch failed for', ch, ':', e.message)
    } finally {
      BG_IRC.historyInFlight.delete(ch)
    }
  })()
  BG_IRC.historyInFlight.set(ch, p)
  return p
}

// justlog — public Twitch chat archive going back years for any opted-in channel
// (~50k popular channels). Pulls the most recent msgs in raw IRC format (parseable
// by our existing parser). Fetched through heatsync.org/api/justlog/:ch — a
// first-party proxy that walks the justlog forks server-side, so a chatter's IP
// never touches a third party. Channels not in any archive return {messages:[]}.
const BG_IRC_JUSTLOG_COOLDOWN_MS = 5 * 60 * 1000
function bgIrcFetchJustlog(ch) {
  ch = (ch || '').toLowerCase()
  if (!ch) return Promise.resolve()
  const last = BG_IRC.lastJustlogAt?.get?.(ch) || 0
  if (Date.now() - last < BG_IRC_JUSTLOG_COOLDOWN_MS) return Promise.resolve()
  if (!BG_IRC.lastJustlogAt) BG_IRC.lastJustlogAt = new Map()
  BG_IRC.lastJustlogAt.set(ch, Date.now())
  pruneMap(BG_IRC.lastJustlogAt, COOLDOWN_TS_MAX_CHANNELS)
  return (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      const resp = await fetch(`https://heatsync.org/api/justlog/${encodeURIComponent(ch)}`, {
        signal: ctrl.signal,
        credentials: 'omit',
      })
      clearTimeout(timer)
      if (!resp.ok) return
      const data = await resp.json()
      const list = Array.isArray(data?.messages) ? data.messages : []
      if (list.length === 0) return
      const buf = BG_IRC.channels.get(ch)
      if (!buf) return
      const existing = buf.getAll()
      const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
      const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
      const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
      const toAdd = []
      for (const item of list) {
        const raw = typeof item === 'string' ? item : item?.raw || ''
        if (!raw) continue
        const msg = bgIrcParseLine(raw, ch)
        if (!msg) continue
        if (msg.type === 'roomstate' || msg.type === 'userstate' || msg.type === 'whisper') continue
        msg.isHistory = true
        if (msg.id && existingIds.has(msg.id)) continue
        if (!msg.id && existingFp.has(fpKey(msg))) continue
        existingIds.add(msg.id)
        if (!msg.id) existingFp.add(fpKey(msg))
        toAdd.push(msg)
      }
      if (toAdd.length === 0) return
      const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
      buf.clear()
      for (const m of all) buf.push(m)
      bgIrcReconcileCleared(buf)
      bgIrcPersistChannel(ch)
      bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
      log('BG IRC justlog merged', toAdd.length, 'msgs for', ch)
    } catch (e) {
      log('BG IRC justlog fetch failed for', ch, ':', e?.message)
    }
  })()
}

// Convert one heatsync server-side IrcRecord (structured shape) into the ext's
// own msg shape used by BG_IRC buffers + tab renderer. Heatsync persists a
// 500-msg Redis ring per channel for 24h — way more reach than robotty's
// instant-API endpoint. Records cover privmsg / usernotice / clearchat /
// clearmsg / notice; ext only renders the first three meaningfully.
function bgIrcRecordToExt(rec, channelHint) {
  if (!rec || typeof rec !== 'object') return null
  const ch = channelHint || (typeof rec.channel === 'string' ? rec.channel.toLowerCase() : '')
  if (!ch) return null
  const t = rec.type
  if (t === 'privmsg') {
    // /me actions: the IRC transport persists the raw \x01ACTION…\x01 wrapper
    // (EventSub strips it). Mirror bgIrcParseLine — strip for display, flag
    // isAction, and slice the STRIPPED text for emote names so positions align
    // exactly as on the live IRC path. A record that arrives already-stripped
    // just no-ops the guard.
    let content = rec.content || ''
    let isAction = false
    if (content.charCodeAt(0) === 1 && content.startsWith('\x01ACTION ')) {
      content = content.slice(8, content.endsWith('\x01') ? -1 : undefined)
      isAction = true
    }
    const msg = {
      user: rec.displayName || rec.username || 'anonymous',
      userId: rec.userId || '',
      text: content,
      color: bgIrcSanitizeColor(rec.color || '#fff'),
      badges: rec.badges || '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      id: rec.id || '',
      isHistory: true,
      replyTo: rec.replyTo
        ? {
            user: rec.replyTo.username || '',
            text: rec.replyTo.content || '',
            id: rec.replyTo.messageId || '',
            // Twitch-resolved id, mirroring rec.userId's convention above — the
            // server relays reply-parent-user-id under this same camelCase field.
            // Lets the renderer paint the reply target synchronously instead of
            // falling back to an async name→uid lookup.
            userId: rec.replyTo.userId || '',
            threadId: rec.replyTo.threadId || rec.replyTo.messageId || '',
          }
        : null,
    }
    if (rec.emotes) {
      const twitchEmotes = {}
      for (const part of String(rec.emotes).split('/')) {
        const [emoteId, posStr] = part.split(':')
        if (!emoteId || !posStr) continue
        const firstPos = posStr.split(',')[0]
        const [start, end] = firstPos.split('-').map(Number)
        if (Number.isNaN(start) || Number.isNaN(end)) continue
        const name = content.slice(start, end + 1)
        if (name && !twitchEmotes[name]) {
          twitchEmotes[name] = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`
        }
      }
      if (Object.keys(twitchEmotes).length > 0) msg.twitchEmotes = twitchEmotes
    }
    // Server-enriched third-party emote refs (name→{url,provider,zeroWidth}) —
    // authoritative per-message set the sender actually used, so the panel
    // renders them without fetching the sender's set. See emote-enrich.ts.
    if (rec.hsEmotes && typeof rec.hsEmotes === 'object') msg.hsEmotes = rec.hsEmotes
    if (rec.bits && rec.bits > 0) msg.bits = rec.bits
    if (rec.isHighlighted) msg.isHighlighted = true
    if (rec.isFirstMsg) msg.isFirstMsg = true
    if (rec.isRedemption) msg.redeemed = true
    const subMatch = (rec.badgeInfo || '').match?.(/subscriber\/(\d+)/)
    if (subMatch) msg.subMonths = parseInt(subMatch[1], 10)
    if (isAction) msg.isAction = true
    return msg
  }
  if (t === 'usernotice') {
    return {
      user: rec.displayName || rec.username || 'system',
      text: rec.content || '',
      systemMsg: rec.systemMessage || '',
      color: bgIrcSanitizeColor(rec.color || '#fff'),
      badges: rec.badges || '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      type: 'usernotice',
      msgId: rec.subType || '',
      subTier: '',
      subMonths: 0,
      giftCount: 0,
      recipient: '',
      raidViewers: 0,
      raidFrom: '',
      announceColor: '',
      bitsTier: 0,
      id: rec.id || '',
      isHistory: true,
    }
  }
  if (t === 'clearchat') {
    const target = rec.targetUsername || ''
    const duration = rec.banDuration
    // A LIVE CLEARCHAT line with no ban-duration tag means permanent, per
    // twitch's protocol. A REPLAYED record with no duration FIELD means we
    // never stored one — those are not the same thing, and this shared
    // string-builder used to treat them identically, manufacturing
    // "permanently banned" for a 1s timeout. Explicit 0 = recorded permanent
    // ban; null/undefined = unknown, so say something true instead.
    const durationKnown = duration != null
    const text = target
      ? duration
        ? `${target} timed out for ${duration}s`
        : durationKnown
          ? `${target} was permanently banned`
          : `${target} was removed from chat`
      : 'Chat was cleared'
    return {
      type: 'notice',
      noticeType: duration ? 'timeout_success' : 'ban_success',
      user: 'system',
      text,
      color: '#808080',
      badges: '',
      channel: ch,
      time: rec.timestamp || Date.now(),
      id: rec.id || `clearchat-${ch}-${target}-${duration || 'perma'}-${rec.timestamp || 0}`,
      systemMsg: text,
      targetUser: target,
      targetUserId: rec.targetUserId || '',
      banDuration: duration || 0,
      isHistory: true,
    }
  }
  return null
}

// Merge a heatsync `irc:backlog` payload into BG_IRC. Dedupes by id (PRIVMSG
// ids overlap with Twitch tag.id, so this catches what robotty also saw).
function bgIrcMergeServerBacklog(ch, records) {
  ch = (ch || '').toLowerCase()
  if (!ch || !Array.isArray(records) || records.length === 0) return
  if (!BG_IRC.channels.has(ch)) BG_IRC.channels.set(ch, new BGCircularBuffer(BG_IRC_PERSIST_MAX))
  const buf = BG_IRC.channels.get(ch)
  const existing = buf.getAll()
  const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
  const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
  const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
  const toAdd = []
  for (const rec of records) {
    const msg = bgIrcRecordToExt(rec, ch)
    if (!msg) continue
    if (msg.id && existingIds.has(msg.id)) continue
    if (!msg.id && existingFp.has(fpKey(msg))) continue
    // Mod notices need the (target, type, window) check too, not just id +
    // fingerprint: two history sources describe ONE timeout with different
    // wording and different ids, so both slipped through and the same action
    // rendered twice. bgIrcDupModNotice is the same collapse the live path uses.
    if (bgIrcDupModNotice(buf, msg)) continue
    toAdd.push(msg)
  }
  if (toAdd.length === 0) return
  const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
  buf.clear()
  for (const m of all) buf.push(m)
  bgIrcReconcileCleared(buf)
  bgIrcPersistChannel(ch)
  bgIrcBroadcast({ type: 'bg_irc_history_merged', channel: ch, count: toAdd.length })
  log('BG IRC heatsync backlog merged', toAdd.length, 'msgs for', ch)
}

// Cross-source live dedupe — the same PRIVMSG can arrive from our own IRC
// socket AND the heatsync server's EventSub-fed fanout (irc:message). FIFO.
const _bgLiveIds = new Set()
const _bgLiveIdOrder = []
function bgIrcSeenLiveId(id) {
  if (!id) return false
  if (_bgLiveIds.has(id)) return true
  _bgLiveIds.add(id)
  _bgLiveIdOrder.push(id)
  if (_bgLiveIdOrder.length > 6000) {
    for (let i = 0; i < 1000; i++) _bgLiveIds.delete(_bgLiveIdOrder[i])
    _bgLiveIdOrder.splice(0, 1000)
  }
  return false
}

async function bgIrcBroadcast(payload) {
  try {
    const tabs = await getMatchingTabs()
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, payload).catch(() => {})
    }
  } catch {}
}

// Every multichat instance learns which channels are open across the whole
// browser — feeds the ephemeral auto-tabs (5 streams open = 5 tabs, no
// manual adds). Debounced: interest churns in bursts during navigation.
let _openChBroadcastTimer = null
function bgBroadcastOpenChannels() {
  if (_openChBroadcastTimer) return
  _openChBroadcastTimer = setTimeout(() => {
    _openChBroadcastTimer = null
    try {
      bgIrcBroadcast({ type: 'open_channels', channels: [...BG_IRC.channelTabs.keys()] })
    } catch {}
  }, 500)
}

function bgIrcRegisterTabInterest(tabId, ch) {
  if (!BG_IRC.tabInterest.has(tabId)) BG_IRC.tabInterest.set(tabId, new Set())
  BG_IRC.tabInterest.get(tabId).add(ch)
  if (!BG_IRC.channelTabs.has(ch)) BG_IRC.channelTabs.set(ch, new Set())
  BG_IRC.channelTabs.get(ch).add(tabId)
  bgBroadcastOpenChannels()
}

function bgIrcUnregisterTabInterest(tabId, ch) {
  const tabSet = BG_IRC.channelTabs.get(ch)
  if (tabSet) {
    tabSet.delete(tabId)
    if (tabSet.size === 0) BG_IRC.channelTabs.delete(ch)
  }
  const interest = BG_IRC.tabInterest.get(tabId)
  if (interest) interest.delete(ch)
  bgBroadcastOpenChannels()
}

// Twitch logins are [a-z0-9_]{1,25}. Every JOIN/PART below interpolates the
// channel into a raw IRC protocol line, so a name carrying \r\n would inject
// a second command onto the user's own authenticated connection. Anything
// non-conforming is stripped to empty and the join is dropped — the manual
// add-channel form and the join_channel handler already enforce this shape;
// the profile-card "add as channel" path (server-supplied twitch_username)
// did not, which is what this closes.
function bgIrcSafeChannel(ch) {
  // Non-strings are rejected outright rather than stringified — String({})
  // would otherwise yield a bogus but "valid-looking" channel that passes the
  // caller's truthiness guard and joins a channel nobody asked for.
  if (typeof ch !== 'string') return ''
  return ch
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 25)
}

function bgIrcEnsureChannel(ch) {
  ch = bgIrcSafeChannel(ch)
  if (!ch) return
  const isNew = !BG_IRC.channels.has(ch)
  if (isNew) {
    BG_IRC.channels.set(ch, new BGCircularBuffer(BG_IRC_PERSIST_MAX))
    BG_IRC.chanLastSeen.set(ch, Date.now())
    if (BG_IRC.channels.size > MAX_BG_IRC_CHANNELS) {
      const oldest = BG_IRC.channels.keys().next().value
      BG_IRC.channels.delete(oldest)
      BG_IRC.chanLastSeen.delete(oldest)
      BG_IRC.lastJustlogAt?.delete?.(oldest)
      BG_IRC.chanRejoinAttempts.delete(oldest)
      chrome.storage.local.remove(`hs_irc_${oldest}`).catch(() => {})
    }
    if (BG_IRC.ws?.readyState === WebSocket.OPEN) {
      try {
        BG_IRC.ws.send(`JOIN #${ch}\r\n`)
      } catch {}
    }
  }
  // External history sources fire regardless of whether the channel already
  // exists in our in-memory map. A channel restored from chrome.storage on
  // SW boot has the buffer but never had this SW's external fetches run —
  // without firing them on every join, restored channels permanently miss
  // the deeper sources (justlog / heatsync irc:resume / fresh robotty).
  // All three have internal cooldowns to prevent hammering.
  try {
    wsSend({ type: 'irc:join', channel: ch })
  } catch {}
  try {
    const buf = BG_IRC.channels.get(ch)
    const all = buf?.getAll() || []
    const lastTs = all.length > 0 ? all[all.length - 1].time || 0 : 0
    wsSend({ type: 'irc:resume', channel: ch, since: lastTs })
  } catch {}
  try {
    bgIrcFetchJustlog(ch)
  } catch {}
  bgIrcFetchRobotty(ch)
}

// Tab cleanup — drop interest when a tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  BG_IRC.liveTabs.delete(tabId)
  const interest = BG_IRC.tabInterest.get(tabId)
  if (!interest) return
  for (const ch of interest) {
    const tabSet = BG_IRC.channelTabs.get(ch)
    if (tabSet) {
      tabSet.delete(tabId)
      if (tabSet.size === 0) BG_IRC.channelTabs.delete(ch)
    }
  }
  BG_IRC.tabInterest.delete(tabId)
  bgBroadcastOpenChannels()
})

// Ctx-death detector port (companion to content.js + multichat bootstrap).
// Each content script opens this port at startup; BG just accepts and holds
// it. When the ext is invalidated, the content side gets a SYNCHRONOUS
// onDisconnect — fires before chrome.runtime becomes undefined or Chrome
// suspends the orphaned script's setInterval, giving a reliable recovery
// signal that the 2s interval detector misses. No messaging on this port.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'heatsync-ctx-death') return
  // SW idle-suspension disconnects the port; content side re-opens (which
  // also wakes the SW). No-op handler on our end.
})

// Listener — handles bg_irc_join / bg_irc_part / bg_irc_history
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  // Reject messages from other extensions — must be this extension's own scripts.
  const _senderUrl = sender?.tab?.url || sender?.url || ''
  const _isFromPopup = !sender?.tab
  const _isOwnExt = sender?.id === chrome.runtime.id
  const _isValidOrigin =
    _isFromPopup || /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(_senderUrl)
  if (!(_isOwnExt && _isValidOrigin)) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }
  const tabId = sender?.tab?.id
  if (message.type === 'bg_irc_auth') {
    // Twitch chat token from a twitch tab (same internal channel the GQL
    // relay uses). Reconnect the reader authed when creds arrive/change.
    const token = typeof message.token === 'string' ? message.token : ''
    const nick = (message.nick || '').toLowerCase()
    if (token && nick && /^[a-z0-9_]{1,30}$/.test(nick)) {
      const changed = token !== BG_IRC.authToken || nick !== BG_IRC.authNick
      BG_IRC.authToken = token
      BG_IRC.authNick = nick
      // survive SW restarts within the browser session — otherwise the
      // reader silently reverts to starved-anonymous until a twitch tab
      // happens to re-init
      try {
        chrome.storage.session?.set?.({ hs_irc_auth: { token, nick } })
      } catch {}
      if (changed) BG_IRC.authFailed = false
      const anonOrStale = changed || !BG_IRC.ws || BG_IRC.ws.readyState !== WebSocket.OPEN
      if (anonOrStale && !BG_IRC.authFailed) {
        log('BG IRC: upgrading reader to authed connection')
        bgIrcConnect()
      }
    }
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'bg_get_open_channels') {
    sendResponse({ channels: [...BG_IRC.channelTabs.keys()] })
    return true
  }
  if (message.type === 'bg_submit_feedback') {
    // Popup feedback form. Server re-validates everything; the slices here
    // just keep an oversized payload from 422ing on schema caps.
    const kind = message.kind === 'bug' ? 'bug' : 'feedback'
    const body = typeof message.body === 'string' ? message.body.trim().slice(0, 4000) : ''
    if (body.length < 3) {
      sendResponse({ ok: false, error: 'too short' })
      return true
    }
    const rawCtx = message.context && typeof message.context === 'object' ? message.context : {}
    const context = {}
    for (const [key, max] of [
      ['url', 2000],
      ['ua', 500],
      ['version', 50],
      ['platform', 50],
      ['viewport', 50],
    ]) {
      if (typeof rawCtx[key] === 'string' && rawCtx[key]) context[key] = rawCtx[key].slice(0, max)
    }
    ;(async () => {
      try {
        const token = await retrieveToken()
        const headers = { 'Content-Type': 'application/json' }
        if (token) headers.Authorization = `Bearer ${token}`
        const r = await fetchWithTimeout(
          `${API_URL}/api/feedback`,
          { method: 'POST', headers, body: JSON.stringify({ kind, body, source: 'ext', context }) },
          10000,
        )
        sendResponse({ ok: r.ok })
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) })
      }
    })()
    return true
  }
  if (message.type === 'bg_irc_join') {
    const ch = bgIrcSafeChannel(message.channel)
    if (!ch) {
      sendResponse({ ok: false, error: 'no channel' })
      return true
    }
    ;(async () => {
      try {
        if (!BG_IRC.storageRestored) await bgIrcRestoreFromStorage()
        bgIrcEnsureChannel(ch)
        // Reader may be parked (SW booted with no platform tabs) — a join is
        // live interest, connect now; onopen re-JOINs every known channel.
        if (!BG_IRC.ws && !BG_IRC.reconnectTimer) bgIrcConnect()
        if (tabId) bgIrcRegisterTabInterest(tabId, ch)
        BG_IRC.liveTabs.add(tabId)
        sendResponse({ ok: true })
      } catch (e) {
        // Always respond — a thrown restore/join would otherwise leave the
        // content script's await hanging (no port reply) and the join silently dead.
        sendResponse({ ok: false, error: e?.message || String(e) })
      }
    })()
    return true
  }
  if (message.type === 'bg_irc_part') {
    const ch = (message.channel || '').toLowerCase()
    if (ch && tabId) bgIrcUnregisterTabInterest(tabId, ch)
    sendResponse({ ok: true })
    return true
  }
  if (message.type === 'bg_irc_history') {
    const ch = (message.channel || '').toLowerCase()
    ;(async () => {
      try {
        if (!BG_IRC.storageRestored) await bgIrcRestoreFromStorage()
        // If a robotty backfill is in flight (cold SW / fresh channel), wait
        // for it so the tab's first paint already has full history instead of
        // depending on the later bg_irc_history_merged broadcast. Cap the wait
        // so a slow robotty doesn't block the page indefinitely.
        const pending = BG_IRC.historyInFlight.get(ch)
        if (pending) {
          try {
            await Promise.race([pending, new Promise((r) => setTimeout(r, 4000))])
          } catch {}
        }
        const buf = BG_IRC.channels.get(ch)
        sendResponse({ ok: true, msgs: buf ? buf.getAll() : [], hasBg: true })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e), msgs: [], hasBg: true })
      }
    })()
    return true
  }
  return false
})

// Boot — restore + connect on SW startup, but ONLY when a platform tab
// exists. This IIFE runs on EVERY SW wake (any alarm, any event); connecting
// unconditionally gave the SW a permanent WS heartbeat → the whole heap
// stayed pinned forever even for a user on zero chat sites. With no tabs the
// reader stays parked; bg_irc_join / scheduleWsIdleCheck un-park it.
;(async () => {
  let tabs = null
  try {
    tabs = await browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })
  } catch {} // query failed → fail open, connect as before
  if (tabs && tabs.length === 0) {
    BG_IRC.idleClosed = true
    return
  }
  await bgIrcRestoreFromStorage()
  bgIrcConnect()
})()

// ============================================================================
// BG KICK + YT BUFFER MIRROR — same reload-safe guarantee
// ============================================================================
// Kick + YouTube messages already flow through this SW (heatsync server WS).
// We tee them into per-channel buffers so content tabs hydrate instantly on
// reload — same architecture as the Twitch IRC reader above.

// The archive route serves up to 800 rows (server recent-archive.ts MAX_LIMIT)
// and clamps anything larger. Callers ask for min(that, their own buffer cap):
// requesting more than the circular buffer keeps just pays for rows it drops on
// arrival, and the old flat 200 left the other 600 the archive would gladly
// have handed over unseen, with no "load more" anywhere to reach them.
const BG_ARCHIVE_FETCH_MAX = 800
const BG_KICK_PERSIST_MAX = 3000
const BG_YT_PERSIST_MAX = 500
const BG_KICK = {
  channels: new Map(), // username -> BGCircularBuffer
  persistTimers: new Map(),
  storageRestored: false,
}
const BG_YT = {
  channels: new Map(), // channelId -> BGCircularBuffer
  persistTimers: new Map(),
  storageRestored: false,
}

async function bgKickRestoreFromStorage() {
  if (BG_KICK.storageRestored) return
  BG_KICK.storageRestored = true
  try {
    const all = await chrome.storage.local.get(null)
    // Channels no longer in the user's config never hit the live channel:leave
    // cleanup (removed via another device, or before that handler existed) —
    // sweep them here so hs_kick_* doesn't grow forever.
    const kickKeep = new Set(
      (all.heatsync_multichat?.channels || [])
        .filter((c) => c && typeof c === 'object' && typeof c.kick === 'string' && c.kick)
        .map((c) => c.kick.toLowerCase()),
    )
    const toPurge = []
    let n = 0
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_kick_') || k.startsWith('hs_kick_sync_')) continue
      const ch = k.slice('hs_kick_'.length)
      if (ch && !kickKeep.has(ch)) {
        toPurge.push(k)
        continue
      }
      if (!ch || !v?.msgs?.length || Date.now() - v.ts >= 86400000) continue
      const buf = new BGCircularBuffer(BG_KICK_PERSIST_MAX)
      // Live ingest may have created this buffer while get(null) was pending
      // (boot doesn't await this restore) — merge stored history BEFORE the
      // live messages instead of clobbering them.
      const live = BG_KICK.channels.get(ch)?.getAll() || []
      const liveIds = new Set(live.filter((m) => m.id).map((m) => m.id))
      for (const m of v.msgs) {
        if (m.id && liveIds.has(m.id)) continue
        buf.push(m)
      }
      for (const m of live) buf.push(m)
      BG_KICK.channels.set(ch, buf)
      n++
    }
    if (toPurge.length) chrome.storage.local.remove(toPurge).catch(() => {})
    log('BG KICK restored', n, `channels${toPurge.length ? `, purged ${toPurge.length} orphaned` : ''}`)
  } catch (e) {
    log('BG KICK restore failed:', e.message)
  }
}

async function bgYtRestoreFromStorage() {
  if (BG_YT.storageRestored) return
  BG_YT.storageRestored = true
  try {
    const all = await chrome.storage.local.get(null)
    // Same sweep as the Kick twin above — channels removed from config while
    // this SW wasn't running never hit the live youtube_ws_unsubscribe cleanup.
    const ytKeep = new Set(
      (all.heatsync_multichat?.channels || [])
        .filter((c) => c && typeof c === 'object' && c.youtube && typeof c.id === 'string')
        .map((c) => c.id),
    )
    const toPurge = []
    let n = 0
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('hs_yt_') || k.startsWith('hs_yt_sync_')) continue
      const channelId = k.slice('hs_yt_'.length)
      if (channelId && !ytKeep.has(channelId)) {
        toPurge.push(k)
        continue
      }
      if (!channelId || !v?.msgs?.length || Date.now() - v.ts >= 86400000) continue
      const buf = new BGCircularBuffer(BG_YT_PERSIST_MAX)
      // Same merge-not-clobber as the kick twin — boot doesn't await this.
      const live = BG_YT.channels.get(channelId)?.getAll() || []
      const liveIds = new Set(live.filter((m) => m.id).map((m) => m.id))
      for (const m of v.msgs) {
        if (m.id && liveIds.has(m.id)) continue
        buf.push(m)
      }
      for (const m of live) buf.push(m)
      BG_YT.channels.set(channelId, buf)
      n++
    }
    if (toPurge.length) chrome.storage.local.remove(toPurge).catch(() => {})
    log('BG YT restored', n, `channels${toPurge.length ? `, purged ${toPurge.length} orphaned` : ''}`)
  } catch (e) {
    log('BG YT restore failed:', e.message)
  }
}

function bgKickPersistChannel(ch) {
  if (BG_KICK.persistTimers.has(ch)) return
  BG_KICK.persistTimers.set(
    ch,
    setTimeout(() => {
      BG_KICK.persistTimers.delete(ch)
      try {
        const buf = BG_KICK.channels.get(ch)
        if (!buf) return
        const msgs = buf.getAll()
        chrome.storage.local.set({ [`hs_kick_${ch}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, 1500),
  )
}

function bgYtPersistChannel(channelId) {
  if (BG_YT.persistTimers.has(channelId)) return
  BG_YT.persistTimers.set(
    channelId,
    setTimeout(() => {
      BG_YT.persistTimers.delete(channelId)
      try {
        const buf = BG_YT.channels.get(channelId)
        if (!buf) return
        const msgs = buf.getAll()
        chrome.storage.local.set({ [`hs_yt_${channelId}`]: { msgs, ts: Date.now() } }).catch(() => {})
      } catch {}
    }, 1500),
  )
}

// Cross-source live dedupe — the same Kick msg can arrive from the server
// relay AND the Pusher tap (both call bgKickIngest). FIFO, mirrors _bgLiveIds.
const _bgKickLiveIds = new Set()
const _bgKickLiveIdOrder = []
function bgKickSeenLiveId(id) {
  if (!id) return false
  if (_bgKickLiveIds.has(id)) return true
  _bgKickLiveIds.add(id)
  _bgKickLiveIdOrder.push(id)
  if (_bgKickLiveIdOrder.length > 6000) {
    for (let i = 0; i < 1000; i++) _bgKickLiveIds.delete(_bgKickLiveIdOrder[i])
    _bgKickLiveIdOrder.splice(0, 1000)
  }
  return false
}

function bgKickIngest(data) {
  // data shape from heatsync server kick-chat-message webhook → broadcast;
  // called from the relay case AND the Pusher tap's _kpHandleChatEvent
  if (!data?.channel) return
  const ch = data.channel.toLowerCase()
  if (data.id && bgKickSeenLiveId(`${ch}:${data.id}`)) return
  const isFirstSightOfChannel = !BG_KICK.channels.has(ch)
  if (isFirstSightOfChannel) {
    BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
    if (BG_KICK.channels.size > MAX_BG_KICK_CHANNELS) {
      const oldest = BG_KICK.channels.keys().next().value
      BG_KICK.channels.delete(oldest)
      chrome.storage.local.remove(`hs_kick_${oldest}`).catch(() => {})
    }
    // First time we see this Kick channel — pull deep history from postgres
    // archive in addition to the 200-msg server ring (which came via
    // kick-chat-backfill on the WS).
    bgKickFetchArchive(ch).catch(() => {})
  }
  // Build a serializable msg matching what content's KickChat constructs
  const msg = {
    user: data.username || data.user || 'unknown',
    text: data.content || data.message || data.text || '',
    color: data.color || '#53fc18',
    // kick numeric USER id → userId so hydrated history rows thread replies
    // and resolve kick_<id> identity like live rows do (irc.js maps
    // d.senderId → msg.userId on the live path)
    userId: data.senderId != null ? String(data.senderId) : '',
    // Extract Kick badges from the live payload (mirrors kick-chat-backfill).
    // Was hardcoded '' — so BG-buffer history replay (_refreshFromBg) dropped
    // the sub/mod badges that were present when the message arrived live.
    badges: Array.isArray(data.badges)
      ? data.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
      : '',
    channel: ch,
    time: data.timestamp || data.time || Date.now(),
    platform: 'kick',
    id: data.id || '',
    replyTo: data.replyTo
      ? {
          user: data.replyTo.username || 'unknown',
          text: data.replyTo.content || '',
          id: data.replyTo.id || data.replyTo.message_id || '',
          threadId: data.replyTo.thread_id || data.replyTo.id || data.replyTo.message_id || '',
        }
      : null,
  }
  BG_KICK.channels.get(ch).push(msg)
  bgKickPersistChannel(ch)
}

// chat_archive postgres pull for Kick — heatsync persists every Kick msg
// permanently. /api/archive/search returns up to 100 newest msgs DESC, with
// cursor for older pages. Used to seed the BG buffer beyond the 200-msg ring.
// Rate-limited server-side at 30/min/IP; one call per channel-join is fine.
const BG_KICK_ARCHIVE_COOLDOWN_MS = 5 * 60 * 1000
const BG_KICK_lastArchiveAt = new Map()
async function bgKickFetchArchive(ch, beforeIso) {
  ch = (ch || '').toLowerCase()
  if (!ch) return
  if (!beforeIso) {
    const last = BG_KICK_lastArchiveAt.get(ch) || 0
    if (Date.now() - last < BG_KICK_ARCHIVE_COOLDOWN_MS) return
    BG_KICK_lastArchiveAt.set(ch, Date.now())
    pruneMap(BG_KICK_lastArchiveAt, COOLDOWN_TS_MAX_CHANNELS)
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12000)
    const params = new URLSearchParams({
      channel: ch,
      platform: 'kick',
      limit: '100',
    })
    if (beforeIso) params.set('cursor', beforeIso)
    const resp = await fetch(`${API_URL}/api/archive/search?${params}`, {
      signal: ctrl.signal,
      credentials: 'omit',
    })
    clearTimeout(timer)
    if (!resp.ok) return
    const data = await resp.json()
    const rows = Array.isArray(data?.results) ? data.results : []
    if (rows.length === 0) return
    if (!BG_KICK.channels.has(ch)) BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
    const buf = BG_KICK.channels.get(ch)
    const existing = buf.getAll()
    const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
    const fpKey = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
    const existingFp = new Set(existing.filter((m) => !m.id).map(fpKey))
    const toAdd = []
    for (const r of rows) {
      const id = r.message_id || r.id || ''
      const text = r.message || r.content || ''
      const user = r.display_name || r.username || 'unknown'
      const ts = r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      const badgeStr = Array.isArray(r.badges)
        ? r.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
        : typeof r.badges === 'string'
          ? r.badges
          : ''
      const msg = {
        user,
        text,
        color: '#53fc18',
        badges: badgeStr,
        channel: ch,
        time: ts,
        platform: 'kick',
        id,
        isHistory: true,
        replyTo: r.reply_to_id ? { user: '', text: '', id: r.reply_to_id, threadId: r.reply_to_id } : null,
      }
      if (msg.id && existingIds.has(msg.id)) continue
      if (!msg.id && existingFp.has(fpKey(msg))) continue
      existingIds.add(msg.id)
      if (!msg.id) existingFp.add(fpKey(msg))
      toAdd.push(msg)
    }
    if (toAdd.length === 0) return
    const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
    buf.clear()
    for (const m of all) buf.push(m)
    bgKickPersistChannel(ch)
    broadcastToTabs({ type: 'bg_kick_history_merged', channel: ch, count: toAdd.length })
    log('BG KICK archive merged', toAdd.length, 'msgs for', ch)
  } catch (e) {
    log('BG KICK archive fetch failed for', ch, ':', e?.message)
  }
}

// ─── Real-history backfill from GET /api/recent/{platform}/{channel} ───────
// New first-party endpoint (NOT YET DEPLOYED everywhere) that serves up to
// 800 archived messages, newest-last, so a fresh kick/yt join backfills real
// history instead of just replaying whatever the local ring buffer happened
// to catch live. Every failure mode (404/5xx/timeout/malformed body) must
// fail soft and leave the existing local-buffer/relay backfill untouched —
// this is additive, never load-bearing.

// Map one row from the /api/recent response into our internal per-platform
// message shape. Pure — no fetch, no chrome.* — so it's directly unit
// testable. `row` fields per the API contract: { id, ts, channel, sender,
// display_name, text, badges?, emote_refs?, reply_to? } — every field is
// optional/untrusted (server not yet deployed), so every access is guarded
// and a malformed row degrades to plain text rather than throwing.
function mapRecentArchiveRow(platform, row) {
  if (!row || typeof row !== 'object') return null
  const id = row.id != null ? String(row.id) : ''
  const user = row.display_name || row.sender || 'unknown'
  let text = typeof row.text === 'string' ? row.text : ''
  const time = row.ts ? new Date(row.ts).getTime() || Date.now() : Date.now()
  if (!text) return null
  const base = { id, user, text, time, isHistory: true }
  if (platform === 'kick') {
    // Kick's native emotes render as literal [emote:ID:NAME] tokens inline in
    // text (see src/multichat/emotes.js) — the existing /api/archive/search
    // path already stores text with these tokens intact, so only reconstruct
    // from emote_refs when text doesn't already carry them AND the refs carry
    // explicit offsets. Refs without offsets can't be safely positioned —
    // skip reconstruction for those rather than guess (named skip).
    if (Array.isArray(row.emote_refs) && text.indexOf('[emote:') === -1) {
      const refs = row.emote_refs
        .filter(
          (r) =>
            r &&
            r.id != null &&
            r.name &&
            Number.isFinite(r.start) &&
            Number.isFinite(r.end) &&
            r.end >= r.start &&
            r.end <= text.length,
        )
        .sort((a, b) => b.start - a.start)
      for (const r of refs) {
        text = `${text.slice(0, r.start)}[emote:${r.id}:${r.name}]${text.slice(r.end)}`
      }
      base.text = text
    }
    base.color = '#53fc18'
    base.badges = Array.isArray(row.badges)
      ? row.badges.map((b) => `${b?.type || b?.name || 'badge'}/${b?.version || b?.count || '1'}`).join(',')
      : typeof row.badges === 'string'
        ? row.badges
        : ''
    base.platform = 'kick'
    base.replyTo =
      row.reply_to && typeof row.reply_to === 'object'
        ? {
            user: row.reply_to.user || row.reply_to.username || 'unknown',
            text: row.reply_to.text || row.reply_to.content || '',
            id: row.reply_to.id || '',
            threadId: row.reply_to.thread_id || row.reply_to.id || '',
          }
        : null
  } else if (platform === 'youtube') {
    // reply_to intentionally dropped — the YT message pipeline (social.js's
    // youtube_chat_message handler) has no reply-context field at all.
    base.color = '#ff0000'
    base.badges = Array.isArray(row.badges) ? row.badges : []
    base.platform = 'youtube'
    base.msgType = 'text'
  }
  return base
}

// Merge freshly-fetched archive rows into an existing message array. Pure —
// dedup by id first, then ALWAYS by a (user, ~time, text-prefix) content
// fingerprint against every existing row. The double net matters: the server
// serves the platform's own message id (kick uuid / yt id) since c81d5cd0,
// which matches live-caught rows — but legacy archive rows, stale server
// caches, and rows persisted from pre-c81d5cd0 fetches still carry DB row
// ids, so the same message can arrive under two id namespaces. Content fp
// bridges that. Time is bucketed to 10s with adjacent-bucket checks because
// an archive row's ts (server ingest) and a live row's time (client receive)
// differ by transport lag — never by more than a few seconds in practice.
// Cost: an archived repeat of the same user+text within ~20s is dropped from
// backfill — invisible next to rendering every overlap message twice.
// The local buffer always wins a conflict — it carries richer live fields
// (userId, live badges, etc.) than a re-derived archive row ever can — so
// `existing` seeds the dedup sets before any archive row is considered.
// Returns the rows actually appended (`toAdd`) and the time-sorted merge.
const ARCHIVE_FP_BUCKET_MS = 10000
function archiveFpAt(m, bucket) {
  return `${(m.user || '').toLowerCase()}|${bucket}|${(m.text || '').slice(0, 60)}`
}
function mergeRecentArchiveRows(existing, rows, platform) {
  const existingIds = new Set(existing.filter((m) => m.id).map((m) => String(m.id)))
  const existingFp = new Set()
  for (const m of existing) existingFp.add(archiveFpAt(m, Math.floor((m.time || 0) / ARCHIVE_FP_BUCKET_MS)))
  const toAdd = []
  for (const row of rows) {
    const m = mapRecentArchiveRow(platform, row)
    if (!m) continue
    if (m.id && existingIds.has(String(m.id))) continue
    const bucket = Math.floor((m.time || 0) / ARCHIVE_FP_BUCKET_MS)
    if (
      existingFp.has(archiveFpAt(m, bucket)) ||
      existingFp.has(archiveFpAt(m, bucket - 1)) ||
      existingFp.has(archiveFpAt(m, bucket + 1))
    )
      continue
    if (m.id) existingIds.add(String(m.id))
    existingFp.add(archiveFpAt(m, bucket))
    toAdd.push(m)
  }
  const merged = toAdd.length ? [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0)) : existing
  return { toAdd, merged }
}

// Fetch + parse the /api/recent/{platform}/{channel} response. Isolated from
// state mutation so fail-soft behavior (404/5xx/timeout/malformed JSON → empty
// rows, never throws) is directly testable via an injected fetch impl.
// Default and clamp stay literals: the unit harness compiles this function on
// its own via new Function, so a free variable here is a ReferenceError there.
async function fetchRecentArchiveRows(platform, channel, limit = 800) {
  try {
    const url = `${API_URL}/api/recent/${platform}/${encodeURIComponent(channel)}?limit=${Math.min(800, Math.max(1, limit))}`
    const resp = await fetchWithTimeout(url, { credentials: 'omit' }, 8000)
    if (!resp.ok) return []
    const data = await resp.json().catch(() => null)
    return Array.isArray(data?.messages) ? data.messages : []
  } catch {
    return [] // timeout/network/abort — fail soft, caller keeps current behavior
  }
}

// One-shot fire-and-forget kick join backfill. Gated by _kpChannels.has()
// being freshly-set (see kickPusherJoin) so this runs once per join, not on
// every reconnect within the SW's lifetime.
async function bgKickFetchRecentArchive(slug) {
  slug = (slug || '').toLowerCase()
  if (!slug) return
  const rows = await fetchRecentArchiveRows('kick', slug, Math.min(BG_ARCHIVE_FETCH_MAX, BG_KICK_PERSIST_MAX))
  if (!rows.length) return
  if (!BG_KICK.channels.has(slug)) BG_KICK.channels.set(slug, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
  const buf = BG_KICK.channels.get(slug)
  const { toAdd, merged } = mergeRecentArchiveRows(buf.getAll(), rows, 'kick')
  for (const m of toAdd) m.channel = slug
  if (!toAdd.length) return
  buf.clear()
  for (const m of merged) buf.push(m)
  bgKickPersistChannel(slug)
  broadcastToTabs({ type: 'bg_kick_history_merged', channel: slug, count: toAdd.length })
  log('BG KICK recent-archive merged', toAdd.length, 'msgs for', slug)
}

// One-shot fire-and-forget YT join backfill. `channelId` is the multichat
// tab's config id (e.g. "yt-1234567890"), NOT a UC id — resolveYtChannelId
// (already used for 7TV/BTTV channel-emote lookups) resolves the real UC...
// id from the join hint URL, since the archive is keyed by UC id, not our
// synthetic tab id. Gated by _ytRecentFetched so it runs once per channelId
// per SW lifetime — youtube_ws_subscribe re-fires on every reconnect/reload,
// unlike kick's join-gated _kpChannels check.
const _ytRecentFetched = new Set()
async function bgYtFetchRecentArchive(channelId, hintUrl) {
  if (!channelId || channelId === 'global' || channelId === '__live_yt_auto__') return
  if (_ytRecentFetched.has(channelId)) return
  _ytRecentFetched.add(channelId)
  if (_ytRecentFetched.size > 500) _ytRecentFetched.delete(_ytRecentFetched.values().next().value)
  const ucid = await resolveYtChannelId(channelId, hintUrl)
  if (!ucid) return
  const rows = await fetchRecentArchiveRows(
    'youtube',
    ucid.toLowerCase(),
    Math.min(BG_ARCHIVE_FETCH_MAX, BG_YT_PERSIST_MAX),
  )
  if (!rows.length) return
  if (!BG_YT.channels.has(channelId)) BG_YT.channels.set(channelId, new BGCircularBuffer(BG_YT_PERSIST_MAX))
  const buf = BG_YT.channels.get(channelId)
  const { toAdd, merged } = mergeRecentArchiveRows(buf.getAll(), rows, 'youtube')
  if (!toAdd.length) return
  buf.clear()
  for (const m of merged) buf.push(m)
  bgYtPersistChannel(channelId)
  // Feed straight into the same replay pipeline the live relay's own history
  // batches use (social.js's youtube_chat_message{replay:true} →
  // ingestReplayYtMsg), so rendering/paints/emotes/dedup all run through the
  // exact code the local buffer (channelYtMessages) already exercises. Rows
  // render PREPENDED into position by real timestamp — ingestReplayYtMsg
  // never reshuffles existing rows.
  for (const m of toAdd) broadcastToTabs(ytReplayMessageFor(channelId, m))
  log('BG YT recent-archive merged', toAdd.length, 'msgs for', channelId)
}

function ytReplayMessageFor(channelId, m) {
  return {
    type: 'youtube_chat_message',
    videoId: '',
    channelId,
    id: m.id || undefined,
    user: m.user,
    text: m.text,
    color: m.color,
    time: m.time,
    platform: 'youtube',
    emotes: [],
    msgType: m.msgType,
    amount: '',
    scColor: '',
    sticker: null,
    badges: m.badges,
    source: 'server',
    replay: true,
  }
}

// Replay the BG_YT buffer to ONE tab — the surface that just subscribed.
// The one-shot broadcast above only reaches surfaces alive at merge time;
// a multichat that boots (or a popout opened) AFTER it saw nothing until a
// hard refresh restored persisted storage. This closes that gap at the
// single chokepoint every subscribe path funnels through, targeted so a
// reconnecting surface never storms every other tab. ingestReplayYtMsg's
// dedup absorbs the overlap for surfaces that already hold these rows.
const YT_REPLAY_TO_TAB_MAX = 200
async function bgYtReplayToTab(tabId, channelId) {
  if (!tabId || !channelId || channelId === 'global') return
  try {
    if (!BG_YT.storageRestored) await bgYtRestoreFromStorage()
    const buf = BG_YT.channels.get(channelId)
    if (!buf) return
    const msgs = buf.getAll().slice(-YT_REPLAY_TO_TAB_MAX)
    for (const m of msgs) {
      browser.tabs.sendMessage(tabId, ytReplayMessageFor(channelId, m)).catch(() => {})
    }
  } catch {}
}

// ─── YouTube innertube fallback tap ──────────────────────────────────────────
// Last line of yt chat resilience. Two primaries already cover live chat: the
// heatsync server's innertube poller (relayed over WS as 'youtube:chat') and
// the DOM tap (youtube-content.js scraping the live_chat iframe, relayed as
// 'youtube_chat_message'). Both can go dark independently — a server poller
// crash, or simply no youtube.com tab open (multichat watching a channel from
// a twitch/kick tab only). main.js's per-channel watchdog already escalates
// re-subscribe → unsubscribe+resubscribe → BG WS reconnect at a 180s silence
// threshold (src/multichat/main.js ~13633); if NONE of that revives the
// channel within YT_TAP_SILENCE_MS, this tap opens its own on-demand
// innertube poller straight from the service worker — no page, no iframe,
// just a bootstrap fetch + POST poll loop porting
// heatsync/server/services/youtube-chat.ts. It stands down the instant a
// primary delivers again. One poller at a time (YT_TAP_MAX_POLLERS) — this is
// a last-resort backstop, not a third standing transport.
const YT_TAP_SILENCE_MS = 300000 // 5 min — after the 180s watchdog escalation exhausts itself
const YT_TAP_CHECK_MS = 30000 // rides the keepalive alarm (30s is chrome.alarms' minimum period)
const YT_TAP_POLL_MS = 6000
const YT_TAP_FETCH_TIMEOUT_MS = 10000
const YT_TAP_MAX_ERRORS = 5
const YT_TAP_COOLDOWN_MS = 300000
const YT_TAP_MAX_POLLERS = 1
const YT_TAP_WANTED_TTL_MS = 900000 // 15 min

// videoId → ms of last message delivered by a PRIMARY (server relay or DOM
// tap). Tap-fed batches (handleYoutubeChatBatch fromTap:true) never stamp
// this — self-feeding would make the tap look like a perpetually-healthy
// primary and it would never stand down.
const _ytTapLastDelivery = new Map()
// videoId → ms a tab last subscribed to it. TTL'd (see ytTapWantedExpired)
// rather than cleared strictly on unsubscribe, so a brief resubscribe gap
// (nav, reload) doesn't masquerade as a fresh video needing a fresh silence
// window. NEVER seeded from the persisted yt_video_to_channel storage restore
// (~9748) — that map survives across SW restarts for routing, but wantedness
// must reflect an ACTUAL subscribe this session (stale-restore trap: a video
// nobody re-subscribed to would otherwise look permanently "wanted").
const _ytTapWantedAt = new Map()
// videoId → { timer, continuation, apiKey, innertubeContext, seenIds, errorCount }
const _ytTapPollers = new Map()
// videoId → ms cooldown expires (post-close backoff before reopening)
const _ytTapCooldownUntil = new Map()

globalThis.__hsYtTapStats = {
  ticks: 0,
  gate: '',
  opens: 0,
  polls: 0,
  msgs: 0,
  replayMsgs: 0,
  errors: 0,
  lastStatus: 0,
  lastPollLatencyMs: 0,
  active: [],
  cooldowns: 0,
}

// yt-innertube-tap subsystem toggle, mirrored into memory from storage.sync
// ui_settings.subsystems — mirrors the read-boot + onChanged pattern
// content.js uses for its own subsystem gates (content.js ~11738) so the 30s
// check tick never blocks on an async storage read. Defaults ON (matches
// settings-schema.js's subsystems default map).
let _ytTapSubsystemOn = true
browser.storage.sync
  .get(['ui_settings'])
  .then((d) => {
    if (d?.ui_settings?.subsystems?.['yt-innertube-tap'] === false) _ytTapSubsystemOn = false
  })
  .catch(() => {})
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.ui_settings) return
  const subs = changes.ui_settings.newValue?.subsystems
  if (subs) _ytTapSubsystemOn = subs['yt-innertube-tap'] !== false
})

// ── wantedness ──────────────────────────────────────────────────────────────

function ytTapMarkWanted(videoId) {
  if (!videoId) return
  // Seed on FIRST sighting only — activation needs an OBSERVED silence, not
  // "no data since a boot we didn't watch".
  if (!_ytTapLastDelivery.has(videoId)) _ytTapLastDelivery.set(videoId, Date.now())
  _ytTapWantedAt.set(videoId, Date.now())
}

function ytTapUnmarkWanted(videoId) {
  if (!videoId) return
  _ytTapWantedAt.delete(videoId)
  _ytTapLastDelivery.delete(videoId)
  ytTapClose(videoId, 'unwanted')
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────

function ytTapShouldActivate(lastDeliveryMs, nowMs) {
  return !lastDeliveryMs || nowMs - lastDeliveryMs >= YT_TAP_SILENCE_MS
}

function ytTapWantedExpired(wantedAtMs, nowMs) {
  return !wantedAtMs || nowMs - wantedAtMs > YT_TAP_WANTED_TTL_MS
}

// Innertube ships two ytInitialData assignment forms across page variants.
function ytTapExtractInitialData(html) {
  const m = html.match(/window\["ytInitialData"\]\s*=\s*({.+?});/) || html.match(/var\s+ytInitialData\s*=\s*({.+?});/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

// Continuation token rides one of three shapes depending on chat state
// (invalidation = normal live tick, timed = slow-mode-style throttle,
// reload = the chat needs a hard resync). Port of youtube-chat.ts ~699-706.
function ytTapExtractContinuation(continuations) {
  if (!continuations?.length) return null
  return (
    continuations[0]?.invalidationContinuationData?.continuation ||
    continuations[0]?.timedContinuationData?.continuation ||
    continuations[0]?.reloadContinuationData?.continuation ||
    null
  )
}

// Mutates `seenIds` in place: adds a new id and returns true, or returns
// false for a dup. Caps growth by evicting the oldest 500 once past 2000 —
// Set iteration order is insertion order, so "oldest" is well-defined.
function ytTapSeenIdIsNew(seenIds, msgId) {
  if (!msgId) return true
  if (seenIds.has(msgId)) return false
  seenIds.add(msgId)
  if (seenIds.size > 2000) {
    const iter = seenIds.values()
    for (let i = 0; i < 500; i++) iter.next()
    const toKeep = new Set()
    for (const v of iter) toKeep.add(v)
    seenIds.clear()
    for (const v of toKeep) seenIds.add(v)
  }
  return true
}

function ytTapText(node) {
  if (!node) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('')
  return ''
}

function ytTapTimestamp(r) {
  return r?.timestampUsec ? Math.floor(Number.parseInt(r.timestampUsec, 10) / 1000) : Date.now()
}

// Flattens a run list into display text + an emotes array. Standard unicode
// emoji ride as their real char (emojiId short, no slash) so clients render
// them natively; yt-exclusive/member emoji are image-only (opaque UCxxx/yyy
// ids) and fall back to a :shortcut:-style alt the emotes array replaces
// with the image. Port of youtube-chat.ts parseRuns (~1002-1037).
function ytTapParseRuns(runs) {
  let text = ''
  const emotes = []
  if (!runs) return { text, emotes }
  for (const run of runs) {
    if (run.text) {
      text += run.text
      continue
    }
    if (!run.emoji) continue
    const url = run.emoji?.image?.thumbnails?.[0]?.url || ''
    const emojiId = run.emoji?.emojiId || ''
    const isUnicode = !!emojiId && emojiId.length <= 8 && !emojiId.includes('/')
    if (isUnicode) {
      text += emojiId
      continue
    }
    const rawAlt = run.emoji?.shortcuts?.[0] || run.emoji?.image?.accessibility?.accessibilityData?.label || ''
    const alt = rawAlt.replace(/<[^>]*>/g, '').trim() || '😀'
    if (url) {
      emotes.push({ type: 'emoji', url, alt })
      text += alt
    }
  }
  return { text, emotes }
}

function ytTapParseTextMessage(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  if (!text.trim()) return null
  return {
    type: 'text',
    user,
    text,
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapSuperChatColor(amount) {
  if (amount >= 100) return '#e62117'
  if (amount >= 50) return '#e91e63'
  if (amount >= 20) return '#ff6d00'
  if (amount >= 10) return '#ffd600'
  if (amount >= 5) return '#00c853'
  if (amount >= 2) return '#00bfa5'
  return '#1565c0'
}

function ytTapParseSuperChat(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  const amount = r.purchaseAmountText?.simpleText || ''
  const numMatch = amount.match(/([\d,.]+)/)
  const num = numMatch ? Number.parseFloat(numMatch[1].replace(',', '')) : 0
  return {
    type: 'superchat',
    user,
    text: text || '',
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    amount,
    color: ytTapSuperChatColor(num),
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseSuperSticker(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const amount = r.purchaseAmountText?.simpleText || ''
  const stickerUrl = r.sticker?.thumbnails?.[0]?.url || ''
  const stickerAlt = r.sticker?.accessibility?.accessibilityData?.label || 'sticker'
  const numMatch = amount.match(/([\d,.]+)/)
  const num = numMatch ? Number.parseFloat(numMatch[1].replace(',', '')) : 0
  return {
    type: 'supersticker',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    amount,
    color: ytTapSuperChatColor(num),
    authorChannelId: r.authorExternalChannelId || undefined,
    sticker: { url: stickerUrl, alt: stickerAlt },
  }
}

function ytTapParseMembership(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const milestone = ytTapText(r.headerPrimaryText)
  const systemMsg = milestone ? `${user}: ${milestone}` : `${user} became a member`
  const { text, emotes } = ytTapParseRuns(r.message?.runs)
  return {
    type: 'membership',
    user,
    text: text || '',
    emotes,
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseGiftPurchase(r, videoId) {
  const h = r.header?.liveChatSponsorshipsHeaderRenderer
  const user = h?.authorName?.simpleText || ''
  if (!user) return null
  const primary = ytTapText(h?.primaryText)
  const lead = primary ? primary.charAt(0).toLowerCase() + primary.slice(1) : 'gifted memberships'
  return {
    type: 'giftpurchase',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg: `${user} ${lead}`,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

function ytTapParseGiftRedemption(r, videoId) {
  const user = r.authorName?.simpleText || ''
  if (!user) return null
  const detail = ytTapText(r.message) || 'was gifted a membership'
  return {
    type: 'giftredemption',
    user,
    text: '',
    emotes: [],
    timestamp: ytTapTimestamp(r),
    videoId,
    systemMsg: `${user} ${detail}`,
    authorChannelId: r.authorExternalChannelId || undefined,
  }
}

// Port of youtube-chat.ts parseActions (~869-959) — 6 renderer types, id
// attached post-parse so every push shares one dedup-key code path. Mod
// deletions (markChatItemAsDeletedAction / removeChatItemAction and their
// by-author variants) are DELIBERATELY skipped: there is no ext ingest path
// for a tap-sourced deletion (youtube_msg_deleted is DOM-tap-only, keyed off
// a live DOM node this poller never touches) — accepted gap, not a bug.
function ytTapParseActions(actions, videoId, seenIds) {
  const messages = []
  for (const action of actions) {
    const item = action?.addChatItemAction?.item
    if (!item) continue
    const renderer =
      item.liveChatTextMessageRenderer ||
      item.liveChatPaidMessageRenderer ||
      item.liveChatPaidStickerRenderer ||
      item.liveChatMembershipItemRenderer ||
      item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer ||
      item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
    if (!renderer) continue
    const msgId = renderer.id || renderer.timestampUsec || ''
    if (seenIds && msgId && !ytTapSeenIdIsNew(seenIds, msgId)) continue
    const pushWithId = (msg) => {
      if (!msg) return
      if (msgId) msg.id = String(msgId)
      messages.push(msg)
    }
    if (item.liveChatTextMessageRenderer) pushWithId(ytTapParseTextMessage(item.liveChatTextMessageRenderer, videoId))
    if (item.liveChatPaidMessageRenderer) pushWithId(ytTapParseSuperChat(item.liveChatPaidMessageRenderer, videoId))
    if (item.liveChatPaidStickerRenderer) pushWithId(ytTapParseSuperSticker(item.liveChatPaidStickerRenderer, videoId))
    if (item.liveChatMembershipItemRenderer)
      pushWithId(ytTapParseMembership(item.liveChatMembershipItemRenderer, videoId))
    if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer)
      pushWithId(ytTapParseGiftPurchase(item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer, videoId))
    if (item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer)
      pushWithId(ytTapParseGiftRedemption(item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer, videoId))
  }
  return messages
}

// Public innertube web-client key baked into every youtube.com page — not a
// secret, just client identification. Fallback only: the live_chat page's
// own INNERTUBE_API_KEY (extracted below) is used whenever present.
const YT_TAP_FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const YT_TAP_DEFAULT_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } }

// Port of youtube-chat.ts fetchInitialChat (~673-741), trimmed to what the
// tap needs (no channel/title/owner extraction — the ext already knows the
// channel via ytChannelsFor; archiving is server-only).
function ytTapParseBootstrap(html, videoId) {
  const ytData = ytTapExtractInitialData(html)
  if (!ytData) return null
  const continuations =
    ytData?.continuationContents?.liveChatContinuation?.continuations ||
    ytData?.contents?.liveChatRenderer?.continuations
  const continuation = ytTapExtractContinuation(continuations)
  if (!continuation) return null
  const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)
  const apiKey = keyMatch?.[1] || YT_TAP_FALLBACK_API_KEY
  let innertubeContext = YT_TAP_DEFAULT_CONTEXT
  const ctxMatch = html.match(/"INNERTUBE_CONTEXT"\s*:\s*({.+?})\s*,\s*"/)
  if (ctxMatch) {
    try {
      innertubeContext = JSON.parse(ctxMatch[1])
    } catch {}
  }
  const actions =
    ytData?.continuationContents?.liveChatContinuation?.actions || ytData?.contents?.liveChatRenderer?.actions || []
  const messages = ytTapParseActions(actions, videoId)
  return { continuation, apiKey, innertubeContext, messages }
}

// ── poller lifecycle ────────────────────────────────────────────────────────

async function ytTapFetchText(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(YT_TAP_FETCH_TIMEOUT_MS) })
  if (!resp.ok) return null
  return resp.text()
}

function ytTapSchedulePoll(entry) {
  if (_ytTapPollers.get(entry.videoId) !== entry) return
  entry.timer = setTimeout(() => ytTapPoll(entry), YT_TAP_POLL_MS)
}

async function ytTapPoll(entry) {
  const stats = globalThis.__hsYtTapStats
  if (_ytTapPollers.get(entry.videoId) !== entry) return // closed while scheduled
  stats.polls++
  const pollStart = Date.now()
  const onErrorTick = () => {
    entry.errorCount++
    stats.errors++
    if (entry.errorCount > YT_TAP_MAX_ERRORS) {
      ytTapClose(entry.videoId, 'max-errors')
      _ytTapCooldownUntil.set(entry.videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    ytTapSchedulePoll(entry)
  }
  try {
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${entry.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: entry.innertubeContext, continuation: entry.continuation }),
      signal: AbortSignal.timeout(YT_TAP_FETCH_TIMEOUT_MS),
    })
    if (_ytTapPollers.get(entry.videoId) !== entry) return // closed mid-fetch
    stats.lastStatus = resp.status
    stats.lastPollLatencyMs = Date.now() - pollStart
    if (!resp.ok) {
      onErrorTick()
      return
    }
    const data = await resp.json().catch(() => null)
    if (_ytTapPollers.get(entry.videoId) !== entry) return
    entry.errorCount = 0
    const continuations = data?.continuationContents?.liveChatContinuation?.continuations
    if (!continuations?.length) {
      // Stream ended. Close + cooldown, but do NOT emit youtube:status
      // 'ended' — that signal belongs to the primaries (server relay /
      // watchdog); the tap only ever reacts to silence, never declares a
      // stream over.
      ytTapClose(entry.videoId, 'ended')
      _ytTapCooldownUntil.set(entry.videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    const newCont = ytTapExtractContinuation(continuations)
    if (newCont) entry.continuation = newCont // never persisted — memory-only
    const actions = data?.continuationContents?.liveChatContinuation?.actions || []
    const messages = ytTapParseActions(actions, entry.videoId, entry.seenIds)
    if (messages.length) {
      stats.msgs += messages.length
      handleYoutubeChatBatch(
        { type: 'youtube:chat', videoId: entry.videoId, messages, replay: false },
        { fromTap: true },
      )
    }
    ytTapSchedulePoll(entry)
  } catch (e) {
    if (_ytTapPollers.get(entry.videoId) !== entry) return
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      // Timeout — reschedule without counting as an error (transient).
      ytTapSchedulePoll(entry)
      return
    }
    onErrorTick()
  }
}

async function ytTapOpen(videoId) {
  if (_ytTapPollers.has(videoId) || _ytTapPollers.size >= YT_TAP_MAX_POLLERS) return
  const stats = globalThis.__hsYtTapStats
  const entry = {
    videoId,
    timer: null,
    continuation: null,
    apiKey: null,
    innertubeContext: null,
    seenIds: new Set(),
    errorCount: 0,
  }
  _ytTapPollers.set(videoId, entry) // reserve the slot before the async gap
  stats.opens++
  stats.active = [..._ytTapPollers.keys()]
  try {
    const html = await ytTapFetchText(`https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}`)
    if (_ytTapPollers.get(videoId) !== entry) return // closed mid-fetch (toggle-off, unwanted, etc.)
    const boot = html && ytTapParseBootstrap(html, videoId)
    if (!boot) {
      _ytTapPollers.delete(videoId)
      stats.active = [..._ytTapPollers.keys()]
      _ytTapCooldownUntil.set(videoId, Date.now() + YT_TAP_COOLDOWN_MS)
      stats.cooldowns++
      return
    }
    entry.continuation = boot.continuation
    entry.apiKey = boot.apiKey
    entry.innertubeContext = boot.innertubeContext
    if (boot.messages.length) {
      stats.replayMsgs += boot.messages.length
      // Gap-fill path: replay:true so the surface's replay pipeline (bulk
      // buffer + one render) takes these, not the live drip pacer — the
      // pacer rewrites arrival times, which would smear a burst of
      // already-real timestamps across several seconds for no reason.
      handleYoutubeChatBatch(
        { type: 'youtube:chat', videoId, messages: boot.messages, replay: true },
        { fromTap: true },
      )
    }
    ytTapSchedulePoll(entry)
  } catch {
    if (_ytTapPollers.get(videoId) === entry) {
      _ytTapPollers.delete(videoId)
      stats.active = [..._ytTapPollers.keys()]
    }
    _ytTapCooldownUntil.set(videoId, Date.now() + YT_TAP_COOLDOWN_MS)
    stats.cooldowns++
  }
}

function ytTapClose(videoId, reason) {
  const entry = _ytTapPollers.get(videoId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  _ytTapPollers.delete(videoId)
  const stats = globalThis.__hsYtTapStats
  stats.active = [..._ytTapPollers.keys()]
  stats.gate = `closed:${videoId}:${reason}`
}

// ── check tick (rides the 'keepalive' alarm, ~30s) ──────────────────────────

function ytTapCheck() {
  const stats = globalThis.__hsYtTapStats
  stats.ticks++
  if (!_ytTapSubsystemOn) {
    stats.gate = 'toggle-off'
    for (const vid of [..._ytTapPollers.keys()]) ytTapClose(vid, 'toggle-off')
    return
  }
  const now = Date.now()
  for (const [vid, at] of [..._ytTapWantedAt]) {
    if (ytTapWantedExpired(at, now)) {
      _ytTapWantedAt.delete(vid)
      _ytTapLastDelivery.delete(vid)
      ytTapClose(vid, 'wanted-expired')
    }
  }
  // Candidates: wanted AND still bound to a real channel (ytChannelsFor is
  // the same routing table youtube:chat itself resolves against).
  const candidates = [..._ytTapWantedAt.keys()].filter((vid) => ytChannelsFor(vid).length > 0)
  const candidateSet = new Set(candidates)
  for (const vid of [..._ytTapPollers.keys()]) {
    if (!candidateSet.has(vid)) {
      ytTapClose(vid, 'unbound')
      continue
    }
    if (!ytTapShouldActivate(_ytTapLastDelivery.get(vid), now)) ytTapClose(vid, 'primary-recovered')
  }
  if (_ytTapPollers.size >= YT_TAP_MAX_POLLERS) {
    stats.gate = `active:${[..._ytTapPollers.keys()].join(',')}`
    return
  }
  let best = null
  for (const vid of candidates) {
    if (_ytTapPollers.has(vid)) continue
    if ((_ytTapCooldownUntil.get(vid) || 0) > now) continue
    if (!ytTapShouldActivate(_ytTapLastDelivery.get(vid), now)) continue
    const wantedAt = _ytTapWantedAt.get(vid) || 0
    if (!best || wantedAt > best.wantedAt) best = { vid, wantedAt }
  }
  if (best) {
    stats.gate = `opening:${best.vid}`
    ytTapOpen(best.vid)
  } else {
    stats.gate = candidates.length ? 'primary-healthy' : 'no-candidates'
  }
}

// ─── Kick chat Pusher tap (client-side, anonymous) ──────────────────────────
// Reads Kick chat straight from Kick's own Pusher stream instead of waiting on
// the server webhook relay — lower latency, no per-app subscription cap, and it
// survives server hiccups. Each message carries the Kick message_id, so the
// overlay's KickChat id-dedup silently drops the duplicate from the (still
// running) server relay. If this tap can't connect/resolve a channel, that
// channel simply keeps flowing through the server relay — automatic fallback.
// Verified live 2026-06-02 (kick.com/westcol): tap fills + renders, dedup by
// Kick message id drops relay duplicates (KickChat._recentLiveIds). On = kick
// chat works on channels the server relay doesn't already track.
const KICK_PUSHER_TAP = true
const KICK_PUSHER_APP_KEY = '32cbd69e4b950bf97679' // rotates rarely — re-check the live Pusher URL if chat ever stops
let _kpWs = null
let _kpConnected = false
let _kpReconnectMs = 1000
let _kpReconnectTimer = null
let _kpLastData = 0
let _kpConnectingAt = 0
const _kpChannels = new Map() // slug -> chatroomId (currently subscribed)
const _kpChatroomCache = new Map() // slug -> chatroomId (resolved)
// slug -> kick CHANNEL id (a different number from the chatroom id). Kept
// separately because only some events ride the channel-scoped Pusher channel.
const _kpChannelIdCache = new Map()
const _kpSubbedChannelIds = new Map() // slug -> channelId (currently subscribed)
// Per-source delivery counters — the tap and the server relay fail silently
// (resolve miss, unmatched chatroom, dead socket); counters make "which source
// delivered the last message for this slug" answerable from a live probe.
const _kickSrcStats = { tap: new Map(), relay: new Map(), tapUnmatched: 0 } // slug -> {n, lastAt, lastId}
function _kickSrcBump(map, slug, id) {
  const e = map.get(slug) || { n: 0, lastAt: 0, lastId: '' }
  e.n++
  e.lastAt = Date.now()
  e.lastId = id || ''
  map.set(slug, e)
}

async function _kpResolveChatroomId(slug) {
  if (_kpChatroomCache.has(slug)) return _kpChatroomCache.get(slug)
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { credentials: 'include' })
    if (!r.ok) return null
    const j = await r.json()
    const id = j?.chatroom?.id
    // The CHANNEL id is a different number from the chatroom id, and the same
    // response carries both. KICKs ride `channel_<channelId>`, not the chatroom
    // channel — captured live 2026-07-21 — so grab it here rather than paying a
    // second round-trip later.
    if (j?.id != null) {
      if (_kpChannelIdCache.size >= 200) _kpChannelIdCache.delete(_kpChannelIdCache.keys().next().value)
      _kpChannelIdCache.set(slug, j.id)
    }
    if (id) {
      if (_kpChatroomCache.size >= 200) _kpChatroomCache.delete(_kpChatroomCache.keys().next().value)
      _kpChatroomCache.set(slug, id)
      return id
    }
  } catch {}
  return null
}

function _kpSubscribe(chatroomId) {
  if (_kpConnected && _kpWs) {
    try {
      _kpWs.send(
        JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }),
      )
    } catch {}
  }
}
// Second subscription per joined channel, for the events kick does NOT put on
// the chatroom channel — KICKs gifts land on `channel_<channelId>` (underscore;
// `channel.<id>` with a dot is a real but different channel carrying a
// duplicate of the sub event we already read). One extra frame on the socket we
// already hold, no extra connection.
function _kpSubscribeChannelScoped(channelId) {
  if (channelId == null || !_kpConnected || !_kpWs) return
  try {
    _kpWs.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel_${channelId}` } }))
  } catch {}
}
function _kpUnsubscribeChannelScoped(channelId) {
  if (channelId == null || !_kpConnected || !_kpWs) return
  try {
    _kpWs.send(JSON.stringify({ event: 'pusher:unsubscribe', data: { channel: `channel_${channelId}` } }))
  } catch {}
}
function _kpSlugForChannelId(channelId) {
  for (const [slug, id] of _kpSubbedChannelIds) if (String(id) === String(channelId)) return slug
  return null
}
function _kpUnsubscribe(chatroomId) {
  if (_kpConnected && _kpWs) {
    try {
      _kpWs.send(JSON.stringify({ event: 'pusher:unsubscribe', data: { channel: `chatrooms.${chatroomId}.v2` } }))
    } catch {}
  }
}
function _kpScheduleReconnect() {
  if (_kpReconnectTimer || !KICK_PUSHER_TAP || !_kpChannels.size) return
  _kpReconnectTimer = setTimeout(() => {
    _kpReconnectTimer = null
    _kpConnect()
  }, _kpReconnectMs)
  _kpReconnectMs = Math.min(_kpReconnectMs * 2, 30000)
}
function _kpConnect() {
  if (_kpWs || !KICK_PUSHER_TAP) return
  // Capture the socket locally — a stale socket's late close/error/message
  // events must never clobber a newer _kpWs (leave→join races spawn orphaned
  // duplicate-subscribed sockets otherwise).
  let ws
  try {
    ws = new WebSocket(
      `wss://ws-us2.pusher.com/app/${KICK_PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`,
    )
  } catch {
    _kpScheduleReconnect()
    return
  }
  _kpWs = ws
  _kpConnectingAt = Date.now()
  ws.onopen = () => {
    if (_kpWs !== ws) return
    _kpLastData = Date.now()
  }
  ws.onmessage = (e) => {
    if (_kpWs !== ws) return
    _kpLastData = Date.now()
    let d
    try {
      d = JSON.parse(e.data)
    } catch {
      return
    }
    if (d.event === 'pusher:connection_established') {
      _kpConnected = true
      // Reset backoff only on a fully-established session — resetting in
      // onopen lets connect-then-drop failures (rotated app key, quota)
      // retry at 1s forever.
      _kpReconnectMs = 1000
      for (const id of _kpChannels.values()) _kpSubscribe(id) // (re)assert all subs
      for (const id of _kpSubbedChannelIds.values()) _kpSubscribeChannelScoped(id)
    } else if (d.event === 'pusher:ping') {
      try {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
      } catch {}
    } else if (typeof d.event === 'string' && d.event.includes('ChatMessageEvent')) {
      _kpHandleChatEvent(d)
    } else if (typeof d.event === 'string' && d.event.includes('MessageDeletedEvent')) {
      _kpHandleModEvent(d, 'delete')
    } else if (typeof d.event === 'string' && d.event.includes('UserBannedEvent')) {
      _kpHandleModEvent(d, 'ban')
    } else if (typeof d.event === 'string' && d.event.includes('UserUnbannedEvent')) {
      _kpHandleModEvent(d, 'unban')
    } else if (d.event === 'KicksGifted') {
      _kpHandleKicksEvent(d)
    } else if (typeof d.event === 'string' && d.event.includes('PinnedMessageCreatedEvent')) {
      _kpHandlePinEvent(d, true)
    } else if (typeof d.event === 'string' && d.event.includes('PinnedMessageDeletedEvent')) {
      _kpHandlePinEvent(d, false)
    } else if (typeof d.event === 'string' && d.event.includes('GiftedSubscriptionsEvent')) {
      // Checked before SubscriptionEvent: kick's gift event name does not
      // contain "SubscriptionEvent", but ordering it first keeps the pair
      // obvious if kick ever renames one into a superstring of the other.
      _kpHandleGiftSubEvent(d)
    } else if (typeof d.event === 'string' && d.event.includes('SubscriptionEvent')) {
      _kpHandleSubEvent(d)
    } else if (typeof d.event === 'string' && d.event.includes('ChatroomUpdatedEvent')) {
      // Async (storage.session baseline load) — a rejection here is otherwise
      // an invisible unhandled promise in the SW; pin it for dbg_kick_tap.
      _kpHandleChatroomUpdated(d).catch((e) => {
        _kpModeStats.lastError = e?.message || 'unknown'
      })
    }
  }
  ws.onclose = () => {
    if (_kpWs !== ws) return
    _kpWs = null
    _kpConnected = false
    if (_kpChannels.size) _kpScheduleReconnect()
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {}
  }
}
// Zombie/half-open detection — Pusher's protocol-level WS pings are answered
// by the browser's network stack and never reach JS, so data silence is the
// only liveness signal we can observe. Fired from the hs-ws-watchdog alarm.
function _kpWatchdogCheck() {
  if (!KICK_PUSHER_TAP || !_kpChannels.size) return
  if (!_kpWs) {
    if (!_kpReconnectTimer) _kpConnect()
    return
  }
  if (_kpWs.readyState === WebSocket.CONNECTING) {
    if (Date.now() - _kpConnectingAt > 30000) {
      log('KP: connect stuck — closing')
      try {
        _kpWs.close()
      } catch {}
    }
    return
  }
  if (_kpWs.readyState === WebSocket.OPEN && _kpLastData && Date.now() - _kpLastData > 240000) {
    log('KP: zombie detected — reconnecting')
    try {
      _kpWs.close()
    } catch {}
  }
}
function _kpSlugForChatroom(chatroomId) {
  for (const [slug, id] of _kpChannels) if (id === chatroomId) return slug
  return null
}

// Kick chat-mode banners — Twitch parity (see bgIrcHandleLine's roomstate
// branch, ~line 10571). Kick's Pusher chatroom channel emits ChatroomUpdatedEvent
// whenever a mod changes slow/sub-only/emote-only/followers mode. Some
// deployments nest the payload under `chatroom` — handle both. Parsed
// defensively: any missing/malformed field is left unset (undefined) rather
// than coerced to a wrong default, so a partial payload only diffs the fields
// it actually carries.
function kpNormalizeChatroomModes(raw) {
  const src = raw && typeof raw.chatroom === 'object' && raw.chatroom ? raw.chatroom : raw
  if (!src || typeof src !== 'object') return {}
  const out = {}
  if (src.slow_mode && typeof src.slow_mode === 'object') {
    out.slow = src.slow_mode.enabled ? Math.max(0, Number(src.slow_mode.message_interval) || 0) : 0
  }
  if (src.subscribers_mode && typeof src.subscribers_mode === 'object') {
    out.subsOnly = !!src.subscribers_mode.enabled
  }
  if (src.emotes_mode && typeof src.emotes_mode === 'object') {
    out.emoteOnly = !!src.emotes_mode.enabled
  }
  if (src.followers_mode && typeof src.followers_mode === 'object') {
    // Kick's min_duration is minutes already (unlike Twitch's seconds-based
    // slow mode) — -1 mirrors Twitch's ROOMSTATE followers=-1 (off) encoding.
    out.followersOnly = src.followers_mode.enabled ? Math.max(0, Number(src.followers_mode.min_duration) || 0) : -1
  }
  // account_age / advanced_bot_protection have no Twitch ROOMSTATE equivalent
  // — intentionally not mapped (no banner surface for them yet).
  return out
}

// Diff two mode-state snapshots into Twitch-parity notice text lines. `prev`
// being {} means "first snapshot for this chatroom" (join replay) — callers
// must skip emitting in that case, same guard Twitch's ROOMSTATE handler uses
// (Object.keys(prev).length) to avoid a banner storm on join.
function kpModeChanges(prev, next) {
  const changes = []
  if (next.slow != null && next.slow !== prev.slow) {
    changes.push(next.slow > 0 ? `slow mode on (${next.slow}s)` : 'slow mode off')
  }
  if (next.subsOnly != null && next.subsOnly !== prev.subsOnly) {
    changes.push(next.subsOnly ? 'sub-only mode on' : 'sub-only mode off')
  }
  if (next.emoteOnly != null && next.emoteOnly !== prev.emoteOnly) {
    changes.push(next.emoteOnly ? 'emote-only mode on' : 'emote-only mode off')
  }
  if (next.followersOnly != null && next.followersOnly !== prev.followersOnly) {
    if (next.followersOnly === -1) changes.push('follower-only mode off')
    else if (next.followersOnly === 0) changes.push('follower-only mode on')
    else changes.push(`follower-only mode on (${next.followersOnly}m)`)
  }
  return changes
}

// slug -> last known {slow, subsOnly, emoteOnly, followersOnly}. Mirrored to
// storage.session: kick does NOT replay ChatroomUpdatedEvent on subscribe
// (live-probed 2026-07-17 — subscription_succeeded carries {}), so a baseline
// only ever forms from a real mode change. In-memory-only meant every MV3 SW
// respawn wiped it and silently swallowed the NEXT real change per channel.
// session scope (not local) still re-arms cleanly across browser restarts.
const _kpModes = new Map()
const _kpModeStats = { events: 0, broadcasts: 0, baselines: 0, lastError: null }
let _kpModesLoadPromise = null
function _kpModesEnsureLoaded() {
  // Memoized as a promise (not a bool): two events in one ws burst must BOTH
  // wait for the seed, or the second reads an empty map and re-baselines.
  _kpModesLoadPromise ??= (async () => {
    try {
      const stored = (await browser.storage.session?.get('kp_modes'))?.kp_modes
      if (stored && typeof stored === 'object') {
        // Seed only slugs a live event hasn't already written this SW lifetime.
        for (const [slug, modes] of Object.entries(stored)) {
          if (!_kpModes.has(slug) && modes && typeof modes === 'object') _kpModes.set(slug, modes)
        }
      }
    } catch {}
  })()
  return _kpModesLoadPromise
}
function _kpModesPersist() {
  try {
    browser.storage.session?.set({ kp_modes: Object.fromEntries(_kpModes) }).catch(() => {})
  } catch {}
}

async function _kpHandleChatroomUpdated(d) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) return
  _kpModeStats.events++
  await _kpModesEnsureLoaded()
  const next = kpNormalizeChatroomModes(ev)
  const prev = _kpModes.get(slug) || {}
  const hadPrev = Object.keys(prev).length > 0
  const merged = { ...prev, ...next }
  _kpModes.set(slug, merged)
  _kpModesPersist()
  if (!hadPrev) {
    _kpModeStats.baselines++
    return // first sighting this browser session — baseline, no banner
  }
  const changes = kpModeChanges(prev, next)
  if (!changes.length) return
  _kpModeStats.broadcasts += changes.length
  const buf = BG_KICK.channels.get(slug)
  for (const text of changes) {
    const evt = {
      type: 'notice',
      noticeType: 'mode_change',
      user: 'system',
      text,
      color: '#808080',
      badges: '',
      channel: slug,
      time: Date.now(),
      platform: 'kick',
      id: `kickmode-${slug}-${Date.now()}-${text.slice(0, 16)}`,
      systemMsg: text,
    }
    if (buf) buf.push(evt)
    bgKickPersistChannel(slug)
    broadcastToTabs({ type: 'kick_mode_change', channel: slug, msg: evt })
  }
}

function _kpHandleChatEvent(d) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) {
    _kickSrcStats.tapUnmatched++
    return
  }
  // Match the server webhook relay's data shape exactly (see kick-chat-webhooks
  // handleChatMessage) so the overlay renders identically + dedups by id.
  const payload = {
    platform: 'kick',
    channel: slug,
    username: ev.sender?.username || 'unknown',
    displayName: ev.sender?.username || 'Unknown',
    // kick numeric USER id — reply-threading + kick_<id> identity lookups
    senderId: ev.sender?.id ?? null,
    content: ev.content || '',
    color: ev.sender?.identity?.color || '#53fc18',
    badges: ev.sender?.identity?.badges || [],
    timestamp: ev.created_at ? Date.parse(ev.created_at) || Date.now() : Date.now(),
    id: ev.id || '',
    // Kick threads a reply via metadata.original_sender/original_message — the
    // server relay already forwards this; the Pusher tap used to drop it (every
    // tapped reply rendered flat). Match the relay's replyTo shape.
    replyTo: ev.metadata?.original_message
      ? {
          username: ev.metadata.original_sender?.username || 'unknown',
          content: ev.metadata.original_message.content || '',
          id: ev.metadata.original_message.id || '',
        }
      : null,
  }
  // Tee into the BG buffer — for tap-only channels this is the ONLY live
  // source, so without it bg_kick_history serves the SW-boot-age snapshot.
  // bgKickIngest dedups by id, so relay+tap doubles don't double-buffer.
  try {
    bgKickIngest(payload)
  } catch {}
  _kickSrcBump(_kickSrcStats.tap, slug, payload.id)
  broadcastToTabs({ type: 'kick_chat_message', data: payload })
}

// Kick broadcasts moderation on the same chatroom Pusher channel as chat. Mirror
// Twitch's CLEARCHAT/CLEARMSG so bans/timeouts/deletes by the streamer or ANY
// mod reflect in the ext (dim the offender's messages + a system line), not just
// self-actions. Emits a notice-shaped payload the overlay's platform-agnostic
// mod handler already understands (irc.js → irc.on('message')).
function _kpHandleModEvent(d, kind) {
  let ev
  try {
    ev = typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return
  }
  if (!ev) return
  const m = /chatrooms\.(\d+)\.v2/.exec(d.channel || '')
  const slug = m ? _kpSlugForChatroom(Number(m[1])) : null
  if (!slug) return
  if (kind === 'delete') {
    const targetMsgId = ev.message?.id || ev.id || ''
    if (!targetMsgId) return
    broadcastToTabs({ type: 'kick_moderation', action: 'delete', channel: slug, targetMsgId: String(targetMsgId) })
  } else if (kind === 'ban') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return
    // expires_at present ⇒ it was a TIMEOUT. Permanence is the ABSENCE of an
    // expiry, never "the expiry already passed" — the old `expMs > Date.now()`
    // reclassified every short timeout as a permanent ban, because a 1s timeout
    // has always elapsed by the time we process the event (and every replayed
    // one has elapsed by definition). That printed "was permanently banned"
    // about a person who was muted for one second.
    const expMs = ev.expires_at ? Date.parse(ev.expires_at) : 0
    const isTimeout = !!expMs
    // Remaining time can be <=0 for an already-elapsed timeout; report at least
    // 1s rather than a nonsense negative duration.
    const remainingSec = Math.max(1, Math.round((expMs - Date.now()) / 1000))
    broadcastToTabs({
      type: 'kick_moderation',
      action: isTimeout ? 'timeout' : 'ban',
      channel: slug,
      targetUser,
      targetUserId: ev.user?.id != null ? String(ev.user.id) : '',
      banDuration: isTimeout ? remainingSec : 0,
    })
  } else if (kind === 'unban') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return
    broadcastToTabs({ type: 'kick_moderation', action: 'unban', channel: slug, targetUser })
  }
}
// Kick's chatroom Pusher channel carries the celebration events too — subs and
// gift subs. The server webhook relay already renders both, but a webhook only
// fires for channels whose broadcaster authorised the heatsync kick app, which
// is a handful; the tap sees them for EVERY joined channel. Broadcast shapes
// match the relay's exactly (server kick-stream-webhooks handleSubscription*)
// so the overlay has one render path, and irc.js dedups source-blind when a
// channel happens to have both transports.
const _kpEventStats = { subs: 0, gifts: 0, pins: 0, kicks: 0, dropped: 0 }
function _kpEventParse(d) {
  try {
    return typeof d.data === 'string' ? JSON.parse(d.data) : d.data
  } catch {
    return null
  }
}
// Accepts the v1 chatroom channel as well as v2 — we only subscribe to v2
// today, but kick has moved events between the two before and a frame that
// arrives on v1 should resolve rather than land in the unmatched bucket.
function _kpEventSlug(d) {
  const m = /chatrooms\.(\d+)(?:\.v2)?$/.exec(d.channel || '')
  return m ? _kpSlugForChatroom(Number(m[1])) : null
}

function _kpHandleSubEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  const username = ev.username || ev.user?.username || ''
  if (!username) {
    _kpEventStats.dropped++
    return
  }
  const months = Math.max(1, Number(ev.months) || 1)
  const isResub = months > 1
  _kpEventStats.subs++
  broadcastToTabs({
    type: 'kick_sub_event',
    channel: slug,
    eventType: isResub ? 'renewal' : 'new',
    username,
    months,
    message: isResub ? `${username} resubscribed for ${months} months!` : `${username} subscribed!`,
  })
}

function _kpHandleGiftSubEvent(d) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  const gifter = ev.gifter_username || ev.gifter?.username || 'anonymous'
  const names = ev.gifted_usernames || ev.usernames || ev.giftees
  const giftees = Array.isArray(names)
    ? names.map((g) => (typeof g === 'string' ? g : g?.username)).filter(Boolean)
    : []
  // Count from the giftee list, never from a field we haven't seen — a gift
  // event we can't size is worth dropping (and counting) rather than
  // announcing "gifted 0 subs".
  const count = giftees.length
  if (!count) {
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.gifts++
  broadcastToTabs({
    type: 'kick_sub_event',
    channel: slug,
    eventType: 'gift',
    username: gifter,
    gifter,
    giftees,
    message: `${gifter} gifted ${count} sub${count !== 1 ? 's' : ''}!`,
  })
}

// Pinned messages — twitch's pubsub pin has rendered as a gold notice line
// since the event-coverage pass; kick broadcasts the same thing on the chatroom
// channel and it was going in the bin. Kick wraps native emotes as
// [emote:ID:name]; the systemMsg surface is plain text (emote parsing happens
// in the message-text pipeline), so the token collapses to the emote's name
// rather than shipping the raw literal into a notice line.
function _kpPinPlainText(s) {
  return String(s || '')
    .replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
    .slice(0, 200)
    .trim()
}
function _kpHandlePinEvent(d, pinned) {
  const ev = _kpEventParse(d)
  const slug = ev && _kpEventSlug(d)
  if (!slug) return
  if (!pinned) {
    _kpEventStats.pins++
    broadcastToTabs({ type: 'kick_pin_event', channel: slug, pinned: false })
    return
  }
  const text = _kpPinPlainText(ev.message?.content)
  if (!text) {
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.pins++
  broadcastToTabs({
    type: 'kick_pin_event',
    channel: slug,
    pinned: true,
    sender: ev.message?.sender?.username || '',
    text,
  })
}

// KICKs — kick's paid gift currency, their answer to bits. The overlay has
// rendered these since the server webhook relay shipped, but the webhook only
// fires for channels whose broadcaster authorised the heatsync kick app, and
// the event does not ride the chatroom channel at all, so the tap never saw
// one. Live payload (2026-07-21, channel_<id>):
//   { gift_transaction_id, message, sender:{username,...},
//     gift:{gift_id, name, amount, type, tier, ...}, created_at }
// Broadcast shape matches the relay's exactly (server kick-stream-webhooks
// handleKicksGifted); irc.js dedups source-blind when both transports deliver.
function _kpHandleKicksEvent(d) {
  const ev = _kpEventParse(d)
  if (!ev) return
  const m = /^channel_(\d+)$/.exec(d.channel || '')
  const slug = m ? _kpSlugForChannelId(m[1]) : null
  if (!slug) return
  const amount = Math.max(0, Number(ev.gift?.amount) || 0)
  if (!amount) {
    // A gift we can't price would render as "gifted 0 KICKs" — drop it and
    // count it instead, so a shape change shows up in dbg_kick_tap.
    _kpEventStats.dropped++
    return
  }
  _kpEventStats.kicks++
  broadcastToTabs({
    type: 'kick_kicks_event',
    channel: slug,
    username: ev.sender?.username || 'anonymous',
    amount,
    giftName: ev.gift?.name || '',
    message: typeof ev.message === 'string' ? ev.message : '',
  })
}

async function kickPusherJoin(slug) {
  if (!KICK_PUSHER_TAP) return
  slug = (slug || '').toLowerCase()
  if (!slug || _kpChannels.has(slug)) return
  // 'login' etc. are REAL kick channels — a ghost join here streams a
  // stranger's chat into the overlay. Last line of defense for callers that
  // bypass the joinedExtraChannels gate.
  if (BG_NON_CHANNEL_PATHS.has(slug)) return
  const chatroomId = await _kpResolveChatroomId(slug)
  if (!chatroomId) return // couldn't resolve -> leave this channel to the server relay
  _kpChannels.set(slug, chatroomId)
  _kpConnect()
  _kpSubscribe(chatroomId)
  // _kpResolveChatroomId stashed the channel id from the same response.
  const channelId = _kpChannelIdCache.get(slug)
  if (channelId != null) {
    _kpSubbedChannelIds.set(slug, channelId)
    _kpSubscribeChannelScoped(channelId)
  }
  // Fire-and-forget real-history backfill — the _kpChannels.has() guard above
  // means this line only runs on a genuinely fresh join, not every reconnect.
  bgKickFetchRecentArchive(slug).catch(() => {})
}
function kickPusherLeave(slug) {
  if (!KICK_PUSHER_TAP) return
  slug = (slug || '').toLowerCase()
  const chatroomId = _kpChannels.get(slug)
  if (chatroomId == null) return
  _kpUnsubscribe(chatroomId)
  _kpChannels.delete(slug)
  _kpModes.delete(slug)
  const leftChannelId = _kpSubbedChannelIds.get(slug)
  if (leftChannelId != null) {
    _kpUnsubscribeChannelScoped(leftChannelId)
    _kpSubbedChannelIds.delete(slug)
  }
  if (!_kpChannels.size) {
    // Kill any pending reconnect too — otherwise it opens a
    // zero-subscription socket after the last channel leaves.
    if (_kpReconnectTimer) {
      clearTimeout(_kpReconnectTimer)
      _kpReconnectTimer = null
    }
    if (_kpWs) {
      try {
        _kpWs.close()
      } catch {}
      _kpWs = null
      _kpConnected = false
    }
  }
}

function bgYtIngest(payload) {
  // payload is the youtube_chat_message we'd broadcast — store it under channelId
  if (!payload?.channelId || payload.channelId === 'global') return
  const channelId = payload.channelId
  if (!BG_YT.channels.has(channelId)) {
    BG_YT.channels.set(channelId, new BGCircularBuffer(BG_YT_PERSIST_MAX))
    if (BG_YT.channels.size > MAX_BG_YT_CHANNELS) {
      const oldest = BG_YT.channels.keys().next().value
      BG_YT.channels.delete(oldest)
      chrome.storage.local.remove(`hs_yt_${oldest}`).catch(() => {})
    }
  }
  // Strip transient flags before storing. `id` (innertube) is NOT transient —
  // it's the only cross-source-stable identity a yt message has. Without it a
  // replayed buffer row can't be id-deduped by the surface, and the content
  // fallback misses because the surface pacer rewrites live msg times.
  const msg = {
    id: payload.id || undefined,
    user: payload.user,
    text: payload.text,
    color: payload.color,
    time: payload.time,
    platform: 'youtube',
    emotes: payload.emotes,
    msgType: payload.msgType,
    amount: payload.amount,
    scColor: payload.scColor,
    sticker: payload.sticker,
    avatar: payload.avatar,
    badges: payload.badges,
    systemMsg: payload.systemMsg,
  }
  BG_YT.channels.get(channelId).push(msg)
  bgYtPersistChannel(channelId)
}

// History-pull endpoints
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  // Reject messages from other extensions — must be this extension's own scripts.
  const _senderUrl2 = sender?.tab?.url || sender?.url || ''
  const _isFromPopup2 = !sender?.tab
  const _isOwnExt2 = sender?.id === chrome.runtime.id
  const _isValidOrigin2 =
    _isFromPopup2 ||
    /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(_senderUrl2)
  if (!(_isOwnExt2 && _isValidOrigin2)) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }
  if (message.type === 'bg_kick_history') {
    const ch = (message.channel || '').toLowerCase()
    ;(async () => {
      try {
        if (!BG_KICK.storageRestored) await bgKickRestoreFromStorage()
        const buf = BG_KICK.channels.get(ch)
        sendResponse({ ok: true, msgs: buf ? buf.getAll() : [] })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e), msgs: [] })
      }
    })()
    return true
  }
  return false
})

// Boot restore
bgKickRestoreFromStorage()
bgYtRestoreFromStorage()
