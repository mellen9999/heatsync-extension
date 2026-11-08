// background part 1 of 11 — prelude, error reporter, alarms, health, lifecycle, state and channels.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// Background script - Fetch emote inventory and manage WebSocket

// Chrome compatibility - Firefox uses 'browser', Chrome uses 'chrome'
const browser = globalThis.browser || chrome
// Service worker has no lib/browser-api.js; chrome.i18n works here directly.
// Substitutions must be strings (a non-string makes getMessage return '').
const bgT = (key, subs) => {
  try {
    return (
      browser.i18n?.getMessage(
        key,
        subs?.map((s) => String(s ?? '')),
      ) || key
    )
  } catch {
    return key
  }
}
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
// keys, blocklist keys (platformFilters / chatFilterRules
// belong in local), oversized strings (>4 KB) and oversized values (JSON
// >6 KB). Mirrors the canonical implementation in src/lib/utils.js —
// duplicated here because the service worker is not bundled with the lib
// (parity enforced at build time by build.js's checkUiSyncBlocklistParity).
const UI_SYNC_BLOCKLIST = new Set(['platformFilters', 'chatFilterRules'])
// Subset of UI_SYNC_BLOCKLIST that never leaves the device at all — see
// src/lib/utils.js for the full rationale. chatFilterRules is a real pref
// and DOES ride the server ui-state channel (size-capped);
// platformFilters is per-device tab-layout state and never does.
const DEVICE_LOCAL_KEYS = new Set(['platformFilters'])
// Retired by the 2026-11 settings pass — never adopted from the server; the
// stored blob drops them on the overlay's request. Must match src/lib/utils.js.
const RETIRED_UI_KEYS = new Set([
  'customPresets',
  'emoteWysiwyg',
  'emoteSpaceAfter',
  'rightClickBlockMode',
  'hideChatHeader',
  'compactChatInput',
  'highlightMentions',
  'showCosmetics',
  'lineHeight',
  'bttvBadges',
  'ffzBadges',
  'chatterinoBadges',
  'automodRegex',
  'automodAllCaps',
  'keywordHighlights',
  'debugLogging',
  'crashTelemetry',
  'emoteProviderPriority',
  'partialLinksEnabled',
  'channelVolumeTwitch',
  'channelVolumeKick',
  'channelVolumeYouTube',
  'crossFollowTwitchNotify',
  'ytFeedShelves',
  'nativeVisible',
])
// registry key → chrome.storage.local key name — must match src/lib/utils.js
// OVERFLOW_MIRROR_KEYS exactly (parity-checked at build time).
const OVERFLOW_MIRROR_KEYS = {
  platformFilters: 'platform_filters',
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
      if (DEVICE_LOCAL_KEYS.has(key) || RETIRED_UI_KEYS.has(key)) continue
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

// The per-site overlay switches (popup, the page's way back, the overlay's own
// hs-off). Returns the next ui_settings with one site flipped, or null for
// anything that is not one of these gates.
const SITE_OVERLAY_GATES = ['overlay-twitch', 'overlay-kick', 'overlay-youtube']
function siteOverlayMerge(ui, gate, on) {
  if (!SITE_OVERLAY_GATES.includes(gate)) return null
  return { ...ui, subsystems: { ...(ui?.subsystems || {}), [gate]: !!on } }
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
        // x-hs-follow-source self-declares this as an import, not a hand-made
        // follow, so the server can tag it separately (source='kick_import')
        // and it stays prunable later.
        const res = await fetchWithTimeout(
          `${API_URL}/api/follow/kick_${kickId}?kickUsername=${encodeURIComponent(slug)}`,
          { method: 'POST', headers: { Authorization: `Bearer ${hsToken}`, 'x-hs-follow-source': 'kick_import' } },
        )
        // Already-following comes back as a conflict — still "synced", so mark it
        // and stop retrying it every hour. Accept both 409 (current server)
        // and 400 (older server, pre-heatsync-322) since the extension and
        // server deploy independently and can be out of step either way.
        if (res.ok || res.status === 409 || res.status === 400) {
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

// Which surfaces this install opened since the last successful check-in.
//
// The install-id counter above answers "how many people run this"; it cannot
// answer "and do they ever open the social surface", and on 2026-08-25 that gap
// was the whole picture: ~5 installs alive every day, 0 requests to the feed
// endpoint, 0 posts. This rides the poll that already runs — no extra request,
// no timing, no ordering, no content. Just names from the closed list below,
// which the server checks again before any of them reaches a key.
//
// Stored rather than held in memory because an MV3 service worker is evicted
// freely, and losing these would undercount exactly the surface being measured.
const SURFACE_NAMES = new Set(['multichat', 'feed', 'dm', 'mentions'])
const SURFACE_KEY = 'hs_surfaces_pending'

async function noteSurfaceOpen(surface) {
  if (!SURFACE_NAMES.has(surface)) return
  try {
    const { [SURFACE_KEY]: pending } = await browser.storage.local.get([SURFACE_KEY])
    const set = new Set(Array.isArray(pending) ? pending : [])
    if (set.has(surface)) return
    set.add(surface)
    await browser.storage.local.set({ [SURFACE_KEY]: [...set] })
  } catch {}
}

async function takePendingSurfaces() {
  try {
    const { [SURFACE_KEY]: pending } = await browser.storage.local.get([SURFACE_KEY])
    const names = (Array.isArray(pending) ? pending : []).filter((s) => SURFACE_NAMES.has(s))
    return names.slice(0, SURFACE_NAMES.size)
  } catch {
    return []
  }
}

async function clearPendingSurfaces(sent) {
  try {
    const { [SURFACE_KEY]: pending } = await browser.storage.local.get([SURFACE_KEY])
    const rest = (Array.isArray(pending) ? pending : []).filter((s) => !sent.includes(s))
    if (rest.length) await browser.storage.local.set({ [SURFACE_KEY]: rest })
    else await browser.storage.local.remove(SURFACE_KEY)
  } catch {}
}

// Firefox lists this check-in under the optional technicalAndInteraction
// data category (src/manifests/firefox.json), so there it is the user's call:
// without the grant the poll still goes out — the kill-switch must never
// depend on it — but carries no id and no surfaces. Chromium has no such
// permission; its store disclosure covers the poll. A Firefox too old to know
// the key throws, and has no consent to honor either.
//
// An unpacked / temporary load is never a user: it is a dev build or a headless
// fresh-profile run, and each of those mints a new id. In sep 2026 they were 19
// of 21 "installs" on the days they ran, which read as 5x growth.
async function isDevInstall() {
  try {
    return (await browser.management?.getSelf?.())?.installType === 'development'
  } catch {
    return false
  }
}

async function mayCountInstall() {
  if (await isDevInstall()) return false
  if (typeof browser.runtime.getBrowserInfo !== 'function') return true
  try {
    return (await browser.permissions.contains({ data_collection: ['technicalAndInteraction'] })) === true
  } catch {
    return true
  }
}

// Coarse install age for the check-in: a range, never a date, so it cannot
// single anyone out. 'pre' = installed before the stamp existed. Read-only on
// purpose: the top-level fetchHealth() at SW start runs before onInstalled
// writes the stamp on a fresh install, so that first poll omits it and the
// next one (5 min on) sends d0 — no guessing, no race.
async function installAgeBucket() {
  try {
    const { hs_installed_day: day } = await browser.storage.local.get(['hs_installed_day'])
    if (day === 'pre') return 'pre'
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
    const days = Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(day)) / 86400000)
    if (Number.isNaN(days) || days < 0) return null
    return days === 0 ? 'd0' : days < 7 ? 'd1' : days < 30 ? 'd7' : 'd30'
  } catch {
    return null
  }
}

// Install stamps the day (date only); an update from a build without the stamp
// marks 'pre' once and never clobbers a real one.
async function stampInstallDay(reason) {
  try {
    if (reason === 'install') {
      await browser.storage.local.set({ hs_installed_day: new Date().toISOString().slice(0, 10) })
    } else if (reason === 'update') {
      const { hs_installed_day } = await browser.storage.local.get(['hs_installed_day'])
      if (hs_installed_day === undefined) await browser.storage.local.set({ hs_installed_day: 'pre' })
    }
  } catch {}
}

async function fetchHealth() {
  try {
    // Identity is best-effort: a storage failure must never cost us the
    // kill-switch, so the poll goes out plain rather than not at all.
    let url = HEALTH_URL
    let sent = []
    try {
      const id = (await mayCountInstall()) ? await getInstallId() : null
      const version = browser.runtime.getManifest()?.version
      if (id) {
        const q = new URLSearchParams({ id })
        if (version) q.set('v', version)
        // Only ever sent alongside an id — on its own it would be a report
        // about nobody, and the server drops it anyway.
        sent = await takePendingSurfaces()
        if (sent.length) q.set('s', sent.join(','))
        const age = await installAgeBucket()
        if (age) q.set('a', age)
        url = `${HEALTH_URL}?${q}`
      }
    } catch {}
    const resp = await fetchWithTimeout(url, { cache: 'no-store' }, 8000)
    if (!resp?.ok) return
    // Counted the moment the request reached the origin, whatever the body
    // turns out to be — so clear here, before the shape checks below can
    // return early and make us send the same names forever. Only the names
    // actually sent are removed: a surface opened while this request was in
    // flight is still pending, not silently dropped.
    if (sent.length) await clearPendingSurfaces(sent)
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
  stampInstallDay(details.reason)
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

/**
 * A channel entry from another device's multichat config. twitch is sent to IRC
 * so it must be username-shaped; kick allows hyphens. youtube is a bare handle
 * or UC id (what the website syncs: "lofigirl") or a full https URL (what a
 * pasted box stores) — both resolved later; anything else is rejected, and so
 * is any line break. The URL-only check used to drop every channel with a
 * youtube leg, so a stream opened on the website never reached the extension.
 */
function isValidSyncedChannel(ch) {
  if (!ch || typeof ch !== 'object') return false
  if (ch.twitch && (typeof ch.twitch !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(ch.twitch))) return false
  if (ch.kick && (typeof ch.kick !== 'string' || !/^[a-zA-Z0-9_-]{1,25}$/.test(ch.kick))) return false
  if (ch.youtube) {
    if (typeof ch.youtube !== 'string' || /[\r\n]/.test(ch.youtube)) return false
    const bare = /^@?[\w.-]{1,100}$/.test(ch.youtube)
    const url = /^https:\/\/(www\.)?youtube\.com\//i.test(ch.youtube)
    if (!bare && !url) return false
  }
  return true
}

/**
 * Every config read on the server races the write of a push, so a frame read
 * before a write can land after the echo of it and lay the old tab list back
 * (M9). The server stamps each frame with the row's multichat_rev; one older
 * than the newest already applied for the same account is stale. No stamp
 * (older server) always applies. Marks the rev seen when it isn't stale.
 */
const mcConfigRevSeen = { user: null, rev: -1 }
function isStaleConfigRev(seen, user, rev) {
  if (!Number.isFinite(rev)) return false
  if (seen.user !== user) {
    seen.user = user
    seen.rev = -1
  }
  if (rev < seen.rev) return true
  seen.rev = rev
  return false
}

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

// Feed thread rooms (feed:join `thread:<id>`) — one per tab, the thread that tab
// is showing. The server fans reaction/vote frames for it to this socket only
// while joined. The room is held while any tab shows it and re-joined on
// reconnect (the connect burst reads this map). Sent direct, never queued: a
// closed socket has nothing to leave, and the burst re-joins what is still open.
const feedThreadTabs = new Map() // tabId → 'thread:<id>'
// thread:<id> (a thread view) or ulog:<platform>:<login> (a person's logs view — their new archive lines)
const FEED_THREAD_ROOM_RE = /^(?:thread:[a-z0-9]{1,8}|ulog:(?:twitch|kick|youtube):[a-z0-9_]{1,40})$/
function feedThreadSet(tabId, room) {
  const before = new Set(feedThreadTabs.values())
  if (room) feedThreadTabs.set(tabId, room)
  else feedThreadTabs.delete(tabId)
  const after = new Set(feedThreadTabs.values())
  for (const r of before) if (!after.has(r)) wsSendDirect({ type: 'feed:leave', feed: r })
  for (const r of after) if (!before.has(r)) wsSendDirect({ type: 'feed:join', feed: r })
}

// Reserved site paths that must never become channels. BG needs its own
// literal copy — this is the MV3 service worker, a separate JS context from
// the content-script lib bundle, so it can't `import` src/lib/reserved-paths.js.
// Ghost keys persisted in joined_extra_channels replay straight into WS joins
// + the kick Pusher tap on every SW boot, bypassing the overlay-side purges
// ('login' is a REAL kick channel — the tap happily subscribed chatroom 31705
// to it). build.js's checkReservedPathsParity fails the build if this copy
// drifts from src/lib/reserved-paths.js.
const RESERVED_PATHS = new Set([
  'about',
  'accessibility',
  'activate',
  'admin',
  'agency',
  'agent',
  'api',
  'auth',
  'authorize',
  'bits',
  'blog',
  'broadcast',
  'browse',
  'bug',
  'careers',
  'categories',
  'category',
  'checkout',
  'clip',
  'clips',
  'collections',
  'community',
  'company',
  'contact',
  'dashboard',
  'directory',
  'dmca',
  'downloads',
  'drops',
  'embed',
  'feedback',
  'following',
  'friends',
  'games',
  'help',
  'inventory',
  'jobs',
  'kickbot',
  'leaderboards',
  'login',
  'logout',
  'messages',
  'moderation',
  'moderator',
  'notifications',
  'oauth',
  'oauth2',
  'p',
  'partner',
  'partners',
  'password',
  'popout',
  'press',
  'prime',
  'privacy',
  'products',
  'profile',
  'redeem',
  'referrals',
  'responsible-disclosure',
  'rules',
  'schedule',
  'search',
  'settings',
  'signup',
  'store',
  'subs',
  'subscriptions',
  'support',
  'team',
  'teams',
  'terms',
  'turbo',
  'turbo-faq',
  'u',
  'vault',
  'verify',
  'video',
  'videos',
  'vip',
  'vods',
  'wallet',
])
function isGhostChannelKey(key) {
  const ch = String(key || '')
    .split('/')
    .pop()
  return !ch || RESERVED_PATHS.has(ch)
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
  feedThreadSet(tabId, null)
  tabChannels.delete(tabId)
  saveTabChannels()
  _cachedTabs = null // Invalidate tab cache
})

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  _cachedTabs = null // Invalidate tab cache on navigation/load
  // A reload or hard navigation restarts the content script (its thread view is
  // gone), so the room it held would otherwise be joined forever.
  if (changeInfo.status === 'loading') feedThreadSet(tabId, null)
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
// Badge-centric, not per user: [{ title, color, url, ids: [twitchUserId] }].
// Tabs index it with src/lib/badge-index.js. A per-user Map cost ~8MB in the
// SW and again in every tab (messaging copies every user's badge object).
let ffzBadgeList = []
let chatterinoBadgeList = [] // [{ tooltip, url, ids }]
const userCosmeticsCache = new Map() // twitchUserId → { paint, badge, fetchedAt }
let badgesFetchedAt = 0 // persisted to storage in fetchBulkBadges, restored in initialize()
const BADGES_TTL = 24 * 60 * 60 * 1000
const USER_COSMETICS_TTL = 30 * 60 * 1000
// Shorter TTL for negative results (no paint+badge) so newly-added cosmetics
// pick up within 5 min instead of being masked for 30.
const COSMETICS_NEGATIVE_TTL = 5 * 60 * 1000
// A 429/5xx/network failure is NOT proof of "no cosmetics" — caching it at
// COSMETICS_NEGATIVE_TTL (or forever) would blank a real paint/badge for
// minutes. But caching nothing at all just re-fires the same doomed request
// on the next flush (800ms later), which is what turned a kick.com rate-limit
// into a storm. Short negative TTL: fails fast, retries soon, never poisons.
const KICK_TRANSIENT_NEGATIVE_TTL = 20 * 1000
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
const _paintsCache = new Map() // twitchUserId → { spec: object|null, color: string|null, plus: string|null, badge: string|null, fetchedAt }
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
// Self-declared pronouns (pronoundb data via heatsync's /api/pronouns, so
// chatter ids never reach a third party). Twitch-only — pronoundb has no
// Kick/YouTube platform. Keyed by twitch numeric user id. 24h TTL — pronouns
// almost never change, so a stale value for a day is harmless.
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
// Per-category content filters. Every category defaults hidden, same as the
// server and the site; shown only after the viewer turns it on.
let viewerShowWeapon = false
let viewerShowDrug = false
let viewerShowHate = false
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
