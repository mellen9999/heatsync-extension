// background part 2 of 11 — http and auth, inventory, live status.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

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
      viewerShowWeapon = false
      viewerShowDrug = false
      viewerShowHate = false
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
// A third-party host that 429s gets left alone until its Retry-After passes:
// the per-chatter sender-emote lookups don't cache an errored reply (on
// purpose — a 429 is not "no emotes"), so without this every message from
// every unresolved chatter asked again — 1,600 BTTV 429s in 45s on three busy
// tabs. heatsync.org and kick.com keep their own backoffs.
const thirdPartyBackoffUntil = new Map() // host -> ts

// A response nobody reads holds its network pipe — a 2MB shared-memory buffer —
// until the SW happens to garbage-collect it, and a small SW heap almost never
// does. Error replies are the ones callers drop (`r.ok ? r.json() : null`), so
// they're read here while small, cancelled when not. Measured 2026-10-13: three
// busy twitch tabs pinned 900+ of these (1.8GB) in under a minute; 300MB after.
async function settleErrorBody(resp) {
  if (resp.ok || resp.status < 200) return resp
  let body = null
  if (Number(resp.headers.get('content-length')) > 65536) resp.body?.cancel().catch(() => {})
  else body = await resp.arrayBuffer().catch(() => null)
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
}

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
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {}
  const thirdParty = host && !isHeatsync && host !== 'kick.com'
  if (thirdParty && Date.now() < (thirdPartyBackoffUntil.get(host) || 0)) return fakeBackoffResponse()
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
    resp = await settleErrorBody(await fetch(url, { ...opts, credentials, signal: ctrl.signal }))
  } finally {
    clearTimeout(timer)
    if (backoffManaged) heatsyncInflightAborts.delete(ctrl)
  }
  if (thirdParty && resp.status === 429) {
    const n = parseInt(resp.headers.get('retry-after') || '', 10)
    thirdPartyBackoffUntil.set(host, Date.now() + (n > 0 ? Math.min(300, n) * 1000 : 30_000))
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

// ── kick.com token bucket + backoff ─────────────────────────────────────────
// get_kick_user_cosmetics + the sender-emote-batch resolver both hit
// kick.com/api/v1/users/<name> per-chatter with zero pacing — a busy channel's
// chatter churn fired up to 8 lookups every 800ms with no backoff, tripping
// kick.com's rate limit and then repeating the exact same burst on the next
// flush forever. A small token bucket paces steady-state volume; a 429's
// Retry-After (or a 5s default) pauses every kick.com call until it passes —
// same shape as the heatsync.org backoff above, scoped to this one host.
const KICK_COM_BUCKET_RATE = 3 // tokens refilled per second
const KICK_COM_BUCKET_CAPACITY = 5 // burst allowance
let _kickComTokens = KICK_COM_BUCKET_CAPACITY
let _kickComTokensAt = Date.now()
let kickComBackoffUntil = 0
let _kickComBackoffWarnAt = 0
function _kickComTakeToken() {
  const now = Date.now()
  const elapsed = (now - _kickComTokensAt) / 1000
  _kickComTokens = Math.min(KICK_COM_BUCKET_CAPACITY, _kickComTokens + elapsed * KICK_COM_BUCKET_RATE)
  _kickComTokensAt = now
  if (_kickComTokens >= 1) {
    _kickComTokens -= 1
    return true
  }
  return false
}
async function fetchKickCom(url, opts = {}, ms = 10000) {
  while (Date.now() < kickComBackoffUntil) {
    await new Promise((r) => setTimeout(r, Math.min(500, kickComBackoffUntil - Date.now())))
  }
  // Bounded poll for a bucket token rather than a real queue — nothing to
  // lose on an MV3 service-worker restart, and callers here are already
  // fire-and-await per-chatter lookups.
  while (!_kickComTakeToken()) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const resp = await fetchWithTimeout(url, opts, ms)
  if (resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after')
    let waitMs = 5000
    if (retryAfter) {
      const n = parseInt(retryAfter, 10)
      if (!Number.isNaN(n) && n > 0) waitMs = Math.min(60000, n * 1000)
    }
    kickComBackoffUntil = Math.max(kickComBackoffUntil, Date.now() + waitMs)
    if (Date.now() - _kickComBackoffWarnAt > 1000) {
      _kickComBackoffWarnAt = Date.now()
      console.warn('[heatsync] kick.com 429 — backing off', waitMs, 'ms')
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
// TOKEN AT REST (SubtleCrypto + IndexedDB)
// ============================================
// What this is, said plainly: the heatsync session token is kept in
// storage.local as AES-GCM ciphertext (`auth_token_encrypted`, "v2:" + base64
// of iv + ciphertext). The key is a random 256-bit CryptoKey generated once on
// this install with extractable=false and kept in IndexedDB as a structured
// clone. Nothing about it is derived from a public value, and nothing needed to
// rebuild it sits beside the data.
//
// What it buys: a copy of storage.local on its own (a diagnostics dump, a
// bug-report export, a backup of that one store) holds nothing usable, and no
// API will ever hand the key's bytes out.
//
// What it does not buy: any code running in this service worker can still call
// decrypt, and a copy of the whole profile folder carries the IndexedDB too.
// The browser's cookie jar stays the source of truth for the login
// (getAuthCookie reads it first); this blob is only the fallback for when the
// cookie cannot be read.
//
// The previous scheme (PBKDF2 over the public extension id, salt stored next to
// the ciphertext) was obfuscation, not encryption: anyone holding storage.local
// could rebuild the key. It is kept below as decryptLegacyToken, decrypt-only,
// so an upgrade moves the stored token onto the real key once and deletes the
// old salt. A token that will not decrypt either way is dropped and the user
// signs in again — never a crash, never a retry loop.

const TOKEN_BLOB_V2 = 'v2:'
const TOKEN_KEY_DB = 'hs-token-key'
const TOKEN_KEY_STORE = 'keys'
const TOKEN_KEY_ID = 'auth-token-aes-gcm'
// binds a ciphertext to its purpose: a blob made for something else never opens as the login
const TOKEN_AAD = new TextEncoder().encode('heatsync/auth-token/v2')

function openTokenKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TOKEN_KEY_DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(TOKEN_KEY_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('token key db open failed'))
    req.onblocked = () => reject(new Error('token key db open blocked'))
  })
}

async function loadOrCreateTokenKey() {
  const db = await openTokenKeyDb()
  try {
    const existing = await new Promise((resolve, reject) => {
      const get = db.transaction(TOKEN_KEY_STORE, 'readonly').objectStore(TOKEN_KEY_STORE).get(TOKEN_KEY_ID)
      get.onsuccess = () => resolve(get.result || null)
      get.onerror = () => reject(get.error || new Error('token key read failed'))
    })
    if (existing) return existing
    const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    // put-if-absent in ONE readwrite transaction: two callers that both found
    // nothing cannot each keep a different key (the loser adopts the winner's).
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_KEY_STORE, 'readwrite')
      const store = tx.objectStore(TOKEN_KEY_STORE)
      let winner = fresh
      const get = store.get(TOKEN_KEY_ID)
      get.onsuccess = () => {
        if (get.result) winner = get.result
        else store.put(fresh, TOKEN_KEY_ID)
      }
      tx.oncomplete = () => resolve(winner)
      tx.onerror = () => reject(tx.error || new Error('token key write failed'))
      tx.onabort = () => reject(tx.error || new Error('token key write aborted'))
    })
  } finally {
    try {
      db.close()
    } catch {}
  }
}

// one load per worker lifetime; a failure is not cached, the next call retries
let _tokenKeyP = null
function tokenKey() {
  if (!_tokenKeyP) {
    _tokenKeyP = loadOrCreateTokenKey().catch((err) => {
      _tokenKeyP = null
      throw err
    })
  }
  return _tokenKeyP
}

// Answers the stored form, or null when it could not be encrypted. Never
// writes the token in the clear.
async function encryptToken(token) {
  if (!token) return null
  try {
    const key = await tokenKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: TOKEN_AAD },
      key,
      new TextEncoder().encode(token),
    )
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)
    return TOKEN_BLOB_V2 + btoa(String.fromCharCode(...combined))
  } catch (err) {
    log(' Encryption failed:', err?.message)
    return null
  }
}

function unpackTokenBlob(b64) {
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return { iv: combined.slice(0, 12), data: combined.slice(12) }
}

// The v2 blob's token, or null when the ciphertext does not open under the key
// (corrupt, or a key that is gone). THROWS when the key itself could not be
// read (IndexedDB unavailable) — a failure that says nothing about the blob.
async function decryptTokenV2(blob) {
  const key = await tokenKey()
  try {
    const { iv, data } = unpackTokenBlob(blob.slice(TOKEN_BLOB_V2.length))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: TOKEN_AAD }, key, data)
    return new TextDecoder().decode(plain)
  } catch (err) {
    log(' Stored token does not open under the key:', err?.message)
    return null
  }
}

// DECRYPT-ONLY, kept for the one-time move off the old scheme. Its key was
// derived from the public extension id, so this is obfuscation being read, not
// a secret being opened. Reads the stored salt; never creates one.
async function legacyTokenKey(salt) {
  const extensionId = browser.runtime.id || 'heatsync-default'
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${extensionId}-heatsync-token-key`),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
}

async function decryptLegacyToken(blob) {
  let parts
  try {
    parts = unpackTokenBlob(blob)
  } catch {
    return null
  }
  const salts = []
  try {
    const hex = (await browser.storage.local.get('encryption_salt')).encryption_salt
    if (typeof hex === 'string' && hex.length > 0 && hex.length % 2 === 0) {
      const arr = new Uint8Array(hex.length / 2)
      for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      salts.push(arr)
    }
  } catch {}
  salts.push(new TextEncoder().encode('heatsync-salt')) // the first release's fixed salt
  for (const salt of salts) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: parts.iv },
        await legacyTokenKey(salt),
        parts.data,
      )
      return new TextDecoder().decode(plain)
    } catch {}
  }
  return null
}

// Answers the token or null. A pre-v2 blob is only READ here; retrieveToken
// moves it onto the real key.
async function decryptToken(blob) {
  if (!blob || typeof blob !== 'string') return null
  if (blob.startsWith(TOKEN_BLOB_V2)) return decryptTokenV2(blob)
  return decryptLegacyToken(blob)
}

// Secure token storage helpers
async function storeToken(token) {
  const encrypted = await encryptToken(token)
  if (!encrypted) return
  await browser.storage.local.set({ auth_token_encrypted: encrypted })
  // the clear-text token and the old scheme's salt have no business left
  await browser.storage.local.remove(['auth_token', 'encryption_salt'])
}

// The browser's cookie store is the truth about being logged in; the token
// this worker holds is a copy that goes stale. heatsync.org reissues the
// session cookie when an account is unlinked (and rolls it near expiry), and
// the old token is retired on the server the same moment. A request made with
// the copy then fails — and that failure used to read as "logged out": the
// socket pinned itself in authFailedBlock, the stored login was wiped, and
// every panel on every platform said "log in at heatsync.org first" for a
// browser that was logged in, until the next real login (gauntlet
// youtube+kick row, 2026-11-01). Re-read the cookie first. Answers the live
// cookie when it differs from the rejected token (memory + storage adopt it),
// null when the browser agrees the session is gone — only then is it a logout.
async function tokenAfterRejection(rejected) {
  try {
    const cookie = await browser.cookies.get({ url: 'https://heatsync.org', name: 'auth' })
    const live = cookie?.value || null
    if (!live || live === rejected) return null
    log(' rejected token was retired — the cookie moved on, adopting it')
    authToken = live
    await storeToken(live)
    return live
  } catch (err) {
    log(' cookie re-read after rejection failed:', err?.message)
    return null
  }
}

async function retrieveToken() {
  const data = await browser.storage.local.get(['auth_token_encrypted', 'auth_token', 'encryption_salt'])
  const blob = data.auth_token_encrypted
  if (typeof blob === 'string' && blob) {
    let token = null
    let keyReadable = true
    try {
      token = await decryptToken(blob)
    } catch (err) {
      // the key store itself failed (IndexedDB unavailable): that says nothing
      // about the blob, so it is left alone for the next try
      keyReadable = false
      log(' Token key unavailable:', err?.message)
    }
    if (token) {
      if (!blob.startsWith(TOKEN_BLOB_V2)) {
        log(' Moving the stored token onto the real key')
        await storeToken(token) // writes v2, deletes the old salt
      } else if (data.encryption_salt) {
        await browser.storage.local.remove('encryption_salt')
      }
      return token
    }
    if (keyReadable) {
      // opens under nothing we hold: gone for good. Dropped so the popup stops
      // claiming a login that no longer exists; the next sign-in writes a new one.
      log(' Stored token is unreadable — dropping it, sign-in will replace it')
      await browser.storage.local.remove(['auth_token_encrypted', 'encryption_salt'])
    }
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
async function getAuthCookie({ fresh = false } = {}) {
  if (authToken && !fresh) {
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
      // unchanged on a fresh re-read: nothing to re-encrypt
      if (cookie.value !== authToken) {
        authToken = cookie.value
        await storeToken(cookie.value)
      }
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

// ============================================
// TWITCH SESSION — the twitch.tv login cookie stays in this worker
// ============================================
// `auth-token` on twitch.tv is the user's twitch login. Content scripts used to
// ask for it by value (`get_twitch_auth_token`) for four different jobs, and
// three of them never needed the value:
//   - "is there a twitch login, and whose"  → twitch_auth_status (yes/no + name)
//   - helix lookups: own user id, the whisper subscription → twitch_helix; the
//     worker makes the call, the answer leaves, the token does not
//   - the authed chat socket on kick/youtube pages must send `PASS oauth:<token>`
//     from the page's own WebSocket → get_twitch_auth_token, still handed out
//     (that one job), but only to the overlay's top frame on a twitch / kick /
//     youtube tab. Never to heatsync.org, a subframe, the popup or another
//     extension. Moving that socket into this worker is the step that would
//     make the value stay here for good.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const TWITCH_SESSION_HOSTS = /^https:\/\/((?:[a-z0-9-]+\.)*twitch\.tv|(?:[a-z0-9-]+\.)*kick\.com|www\.youtube\.com)$/

// Who may use the twitch login at all: this extension's own content script, in
// the TOP frame of a tab that is on twitch / kick / youtube. The frame's own
// url and the tab's must be the same origin (a page cannot dress an iframe up as
// the tab). Anything else — heatsync.org, an iframe, no tab at all — is refused.
function twitchSessionSenderOk(sender) {
  try {
    if (!sender || sender.id !== browser.runtime.id) return false
    if (!sender.tab || sender.tab.id == null || sender.frameId !== 0) return false
    const frame = new URL(sender.url || '')
    if (frame.origin !== new URL(sender.tab.url || '').origin) return false
    return TWITCH_SESSION_HOSTS.test(frame.origin)
  } catch {
    return false
  }
}

// The twitch cookie, read fresh each time (it rotates; a copy held for hours
// goes stale). username falls back to the heatsync-linked twitch name: the
// stored identity, not a fetchUserInfo() local, which was once a ReferenceError
// here that read as "signed out".
async function readTwitchSession() {
  const [tokenCookie, nameCookie, stored] = await Promise.all([
    browser.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }),
    browser.cookies.get({ url: 'https://www.twitch.tv', name: 'name' }),
    browser.storage.local.get('user_info'),
  ])
  return {
    token: tokenCookie?.value || null,
    username: nameCookie?.value
      ? decodeURIComponent(nameCookie.value).toLowerCase()
      : stored?.user_info?.twitch_username || null,
  }
}

// The two helix calls the overlay needs, by name. Not a proxy: no other path, no
// caller-chosen url or body.
//   self_id            → { ok, id }
//   whisper_subscribe  → { ok, status }   args: { sessionId, userId }
async function twitchHelix(op, args = {}) {
  const { token } = await readTwitchSession()
  if (!token) return { ok: false, error: 'no_token' }
  const headers = { 'Client-Id': TWITCH_WEB_CLIENT_ID, Authorization: `Bearer ${token}` }
  if (op === 'self_id') {
    const resp = await fetchWithTimeout('https://api.twitch.tv/helix/users', { headers, credentials: 'omit' }, 8000)
    if (!resp.ok) return { ok: false, status: resp.status, error: `helix ${resp.status}` }
    const id = (await resp.json().catch(() => null))?.data?.[0]?.id
    return id ? { ok: true, id: String(id) } : { ok: false, error: 'no_id' }
  }
  if (op === 'whisper_subscribe') {
    const sessionId = String(args.sessionId ?? '')
    const userId = String(args.userId ?? '')
    if (!/^[\w-]{8,200}$/.test(sessionId) || !/^\d{1,20}$/.test(userId)) return { ok: false, error: 'bad_args' }
    const resp = await fetchWithTimeout(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          type: 'user.whisper.message',
          version: '1',
          condition: { user_id: userId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      },
      8000,
    )
    return { ok: resp.status === 202, status: resp.status }
  }
  return { ok: false, error: 'unknown_op' }
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

// Signed-out notice: a lapsed heatsync.org login hides the user's own emotes
// with no hint why. Pure gate: only someone who WAS signed in (a fresh install
// that never logged in stays quiet), and only once until the next sign-in.
function signedOutNoticeDue(hadPrior, alreadyShown) {
  return !!hadPrior && !alreadyShown
}
let _signedOutShown = false
let _signInNoted = false
async function noteSignedOut() {
  _signInNoted = false
  try {
    if (_signedOutShown) return
    const s = await browser.storage.session?.get('hs_signed_out_shown')
    if (s?.hs_signed_out_shown) {
      _signedOutShown = true
      return
    }
    const l = await browser.storage.local.get(['hs_was_signed_in', 'user_info'])
    const hadPrior = l.hs_was_signed_in || l.user_info || emoteInventory.length > 0
    if (!signedOutNoticeDue(hadPrior, false)) return
    // Mark shown only once a tab actually received it. No tab (or a content
    // script not up yet) = not shown; the next inventory poll retries.
    const tabs = await getMatchingTabs()
    const got = await Promise.all(
      tabs.map((tab) =>
        browser.tabs.sendMessage(tab.id, { type: 'signed_out_notice' }).then(
          () => true,
          () => false,
        ),
      ),
    )
    if (!got.some(Boolean)) return
    _signedOutShown = true
    browser.storage.session?.set({ hs_signed_out_shown: true }).catch(() => {})
  } catch (_) {}
}
// Token works again: remember we were signed in, re-arm the notice.
function noteSignedIn() {
  if (_signInNoted) return
  _signInNoted = true
  _signedOutShown = false
  browser.storage.local.set({ hs_was_signed_in: true }).catch(() => {})
  browser.storage.session?.remove('hs_signed_out_shown').catch(() => {})
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
        await noteSignedOut() // before the clear: a warm cache proves a prior sign-in
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
          await noteSignedOut()
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
        // own uploads' smaller copies the server lists (["1x","2x","3x","4x"]); absent = url only
        variants: Array.isArray(emote.variants) ? emote.variants : undefined,
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
      noteSignedIn()
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
// keyed per leg (`platform:name`); peers: leg -> its card's legs
let _liveStatusState = { lastSeenLive: {}, lastNotifiedAt: {}, peers: {} }
const _liveNotificationUrls = new Map() // notification id → url for click handler
let _livePollInflight = false

async function loadLiveStatusState() {
  try {
    const data = await browser.storage.local.get(LIVE_STATE_KEY)
    if (data?.[LIVE_STATE_KEY]) {
      _liveStatusState = {
        lastSeenLive: data[LIVE_STATE_KEY].lastSeenLive || {},
        lastNotifiedAt: data[LIVE_STATE_KEY].lastNotifiedAt || {},
        peers: data[LIVE_STATE_KEY].peers || {},
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

const LIVE_PLATFORMS = ['twitch', 'kick', 'youtube']

// A card's live legs as `platform:name`: primary first (its biggest leg, which
// changes hands), then platformUsernames and secondaryLegs. One card = one person.
function liveLegKeys(card) {
  const keys = []
  const add = (platform, name) => {
    const p = String(platform || '').toLowerCase()
    if (!LIVE_PLATFORMS.includes(p) || typeof name !== 'string' || !name || name.length > 100) return
    const k = `${p}:${name.toLowerCase()}`
    if (!keys.includes(k) && keys.length < 8) keys.push(k)
  }
  add(card?.platform, card?.username)
  const named = card?.platformUsernames
  if (named && typeof named === 'object') for (const p of LIVE_PLATFORMS) add(p, named[p])
  if (Array.isArray(card?.secondaryLegs)) for (const l of card.secondaryLegs.slice(0, 8)) add(l?.platform, l?.username)
  return keys
}

// Keys for the same person: the same name on every platform (the server merges
// those) plus the legs of its last-polled card (zackrawrr / asmongold).
function samePersonKeys(key, peers) {
  const name = key.slice(key.indexOf(':') + 1)
  const out = new Set([key])
  for (const p of LIVE_PLATFORMS) out.add(`${p}:${name}`)
  const legs = peers?.[key]
  if (Array.isArray(legs)) for (const k of legs) if (typeof k === 'string') out.add(k)
  return [...out]
}

// One poll's go-lives, per card: news only if none of its legs was live last
// poll or announced inside the throttle (a new leg or a primary flip is not).
function liveTransitions(cards, state, now, firstPoll) {
  const transitions = []
  const seen = new Set()
  const peers = {}
  for (const s of cards) {
    const username = String(s?.username || '').toLowerCase()
    const platform = String(s?.platform || '').toLowerCase()
    const legs = liveLegKeys(s)
    if (legs[0] !== `${platform}:${username}`) continue
    const wasLive = legs.some((k) => state.lastSeenLive[k])
    const person = [...new Set(legs.flatMap((k) => samePersonKeys(k, state.peers)))]
    const recent = person.some((k) => now - (state.lastNotifiedAt[k] || 0) <= LIVE_NOTIFY_THROTTLE_MS)
    for (const k of legs) {
      seen.add(k)
      state.lastSeenLive[k] = true
      peers[k] = legs
    }
    if (firstPoll || wasLive || recent) continue
    for (const k of person) state.lastNotifiedAt[k] = now
    transitions.push({ username, platform, stream: s })
  }
  state.peers = peers
  return { transitions, seen }
}

// A pushed go-live: is its person live elsewhere already, does it notify.
function pushedGoLive(liveKey, state, now) {
  const person = samePersonKeys(liveKey, state.peers)
  const peerLive = person.some((k) => k !== liveKey && state.lastSeenLive[k])
  const recent = person.some((k) => now - (state.lastNotifiedAt[k] || 0) <= LIVE_NOTIFY_THROTTLE_MS)
  return { person, peerLive, notify: !peerLive && !recent }
}

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

    if (!Array.isArray(streams)) streams = []
    const { transitions, seen } = liveTransitions(streams, _liveStatusState, Date.now(), wasFirstPoll)
    const snapshot = []

    for (const s of streams) {
      const username = String(s?.username || '').toLowerCase()
      const platform = String(s?.platform || '').toLowerCase()
      if (!username || !platform) continue
      const key = `${platform}:${username}`
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

    // The poll is the only way a Kick or YouTube go-live is ever seen (the
    // server pushes Twitch only), so it owes the same inline "went live" line
    // the Twitch push gives — not just a desktop toast.
    for (const t of transitions) announceWentLive(t.username, t.platform, t.stream)

    if (transitions.length >= 3) fireLiveCoalescedNotification(transitions)
    else for (const t of transitions) fireLiveNotificationFromStream(t.stream, t.username, t.platform)
  } catch (e) {
    console.warn('[heatsync] pollFollowedLive failed:', e?.message || e)
  } finally {
    _livePollInflight = false
  }
}

// A stream frame's streamer id and chat colour, bounded: the page validates the
// shape per platform (streamEventUserId), this only keeps a hostile frame from
// stashing a huge string in the cache that rides every broadcast.
function streamFrameWho(m) {
  const id = m?.userId
  const color = m?.color
  return {
    userId: (typeof id === 'string' || typeof id === 'number') && String(id).length <= 40 ? String(id) : '',
    color: typeof color === 'string' && color.length <= 32 ? color : '',
  }
}

// An inline chat line for a go-live the poll found, shaped like the Twitch
// push's follow_stream_event so the page handles both the same way. `fresh`:
// this is a vetted off->on transition (the cold-start and throttle gates ran).
function announceWentLive(username, platform, stream) {
  const who = streamFrameWho(stream)
  const game = String(stream?.game || stream?.gameName || stream?.game_name || stream?.category || '')
  const title = String(stream?.title || '')
  if (!cachedFollowHistory) cachedFollowHistory = []
  cachedFollowHistory.push({
    type: 'follow:stream:online',
    platform,
    channel: username,
    game,
    title,
    prevGame: '',
    prevTitle: '',
    color: who.color,
    userId: who.userId,
    time: Date.now(),
  })
  if (cachedFollowHistory.length > 200) cachedFollowHistory.splice(0, cachedFollowHistory.length - 200)
  broadcastToTabs({
    type: 'follow_stream_event',
    eventType: 'stream:online',
    platform,
    channel: username,
    game,
    title,
    prevGame: '',
    prevTitle: '',
    color: who.color,
    userId: who.userId,
    fresh: true,
  })
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
// gate, then cache + broadcast. This is the FAST PATH for Twitch and Kick (the
// platforms the server pushes stream events for) — it drives the
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

  const who = streamFrameWho(msg)
  const platform = String(msg.platform || '').toLowerCase()
  const channel = String(msg.channel || '').toLowerCase()
  const liveKey = `${platform}:${channel}`
  // a simulcast's second leg: no notification, fresh:false drops the page line
  let peerLive = false
  if (msg.type === 'follow:stream:online') {
    if (_liveStatusState.lastSeenLive?.[liveKey]) return
    if (!_liveStatusState.lastSeenLive) _liveStatusState.lastSeenLive = {}
    if (!_liveStatusState.lastNotifiedAt) _liveStatusState.lastNotifiedAt = {}
    const push = pushedGoLive(liveKey, _liveStatusState, now)
    peerLive = push.peerLive
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
    if (_liveStatusInitialized && push.notify) {
      for (const k of push.person) _liveStatusState.lastNotifiedAt[k] = now
      fireLiveNotificationFromStream({ title: msg.title || '', game: msg.game || '' }, channel, platform).catch(
        () => {},
      )
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
    color: who.color,
    userId: who.userId,
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
    color: who.color,
    userId: who.userId,
    // An online event only gets this far when lastSeenLive did not already
    // know the channel (the early return above): a real off->on transition.
    // The page cannot work that out itself — the snapshot broadcast just above
    // already put the channel in its live set.
    fresh: msg.type === 'follow:stream:online' && !peerLive,
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
    const legs = liveLegKeys(s)
    for (const key of legs) {
      if (!_liveStatusState.peers) _liveStatusState.peers = {}
      _liveStatusState.peers[key] = legs
      if (!_liveStatusState.lastSeenLive[key]) {
        _liveStatusState.lastSeenLive[key] = true
        changed = true
      }
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
  const more = live.length > 5 ? bgT('bg_more', [live.length - 5]) : ''
  const title = bgT('bg_badge_tip', [live.length, top + more])
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
  const url = channelPageUrl(platform, slug, true)
  if (!url) return

  const viewerStr = viewers > 0 ? bgT('bg_live_viewers', [viewers.toLocaleString()]) : ''
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
    stream.avatarUrl || // youtube rows of /api/live/following carry the channel avatar here
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
      title: bgT('bg_live_title', [display]),
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
  const more = uniqNames.length > 3 ? bgT('bg_more', [uniqNames.length - 3]) : ''
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
      title: bgT('bg_batch_title', [uniqNames.length]),
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
  return channelPageUrl(m[1], m[2], true)
}

// The streamer's own page — where their live + chat (and multichat) are.
// Slugs come off the wire, so anything that isn't a plain handle is refused.
// live=true (a went-live click) lands a youtube channel on its /live stream —
// the channel home would leave the viewer hunting for the stream.
function channelPageUrl(platform, slug, live = false) {
  const v = String(slug || '').trim()
  if (!/^[\w.-]{1,100}$/.test(v)) return null
  if (platform === 'twitch') return `https://www.twitch.tv/${v}`
  if (platform === 'kick') return `https://kick.com/${v}`
  if (platform === 'youtube')
    return `https://www.youtube.com/${v.startsWith('UC') ? `channel/${v}` : `@${v}`}${live ? '/live' : ''}`
  return null
}

// Which channel a page belongs to, so a second click finds the first tab.
// twitch popout/moderator/embed chat counts as that channel's chat.
function channelPageKey(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^(www|m)\./, '')
    if (host === 'heatsync.org') return `${host}${u.pathname}${u.search}`
    const seg = u.pathname.split('/').filter(Boolean)
    if (host === 'twitch.tv' && ['popout', 'moderator', 'embed'].includes(seg[0])) seg.shift()
    if (host === 'youtube.com' && seg[0] === 'channel') seg.shift()
    if (!seg[0] || !['twitch.tv', 'kick.com', 'youtube.com'].includes(host)) return null
    return `${host}/${seg[0].toLowerCase()}`
  } catch {
    return null
  }
}

// Focus a tab already on that channel (or heatsync page), else open one.
// host_permissions let tabs.query read these urls — no "tabs" permission.
async function focusOrOpenTab(url) {
  const key = channelPageKey(url)
  if (key) {
    try {
      const tabs = await browser.tabs.query({
        url: ['https://*.twitch.tv/*', 'https://kick.com/*', 'https://www.youtube.com/*', 'https://heatsync.org/*'],
      })
      const hit = tabs.find((t) => channelPageKey(t.url) === key)
      if (hit) {
        await browser.tabs.update(hit.id, { active: true })
        await browser.windows?.update(hit.windowId, { focused: true })
        return
      }
    } catch {}
  }
  await browser.tabs.create({ url }).catch(() => {})
}

if (browser.notifications?.onClicked) {
  browser.notifications.onClicked.addListener((id) => {
    const url = _liveNotificationUrls.get(id) || _liveNotificationUrlFromId(id)
    if (url) {
      focusOrOpenTab(url)
      _liveNotificationUrls.delete(id)
      try {
        browser.notifications.clear(id)
      } catch {}
    }
  })
}
