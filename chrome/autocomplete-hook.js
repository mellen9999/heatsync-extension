;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-ac]') : () => {}

  // Kill previous instance on extension reload (old hooks accumulate otherwise)
  if (window.__heatsyncAcLifecycle) {
    try {
      window.__heatsyncAcLifecycle.abort()
    } catch (_) {}
  }

  // Lifecycle controller — inline because this runs in MAIN world (no window.HS)
  const ac = new AbortController()
  const acSignal = ac.signal
  const cleanup = {
    _intervals: new Set(),
    _timeouts: new Set(),
    _observers: new Set(),
    _listeners: [],
    setInterval(fn, ms) {
      const id = setInterval(fn, ms)
      this._intervals.add(id)
      return id
    },
    clearInterval(id) {
      clearInterval(id)
      this._intervals.delete(id)
    },
    setTimeout(fn, ms) {
      const id = setTimeout(() => {
        this._timeouts.delete(id)
        fn()
      }, ms)
      this._timeouts.add(id)
      return id
    },
    clearTimeout(id) {
      clearTimeout(id)
      this._timeouts.delete(id)
    },
    trackObserver(obs) {
      this._observers.add(obs)
      return obs
    },
    untrackObserver(obs) {
      try {
        obs.disconnect()
      } catch (_) {}
      this._observers.delete(obs)
    },
    addEventListener(target, event, handler, opts) {
      target.addEventListener(event, handler, opts)
      this._listeners.push({ target, event, handler, opts })
    },
    destroyAll() {
      for (const id of this._intervals) clearInterval(id)
      this._intervals.clear()
      for (const id of this._timeouts) clearTimeout(id)
      this._timeouts.clear()
      for (const obs of this._observers) {
        try {
          obs.disconnect()
        } catch (_) {}
      }
      this._observers.clear()
      for (const l of this._listeners) {
        try {
          l.target.removeEventListener(l.event, l.handler, l.opts)
        } catch (_) {}
      }
      this._listeners.length = 0
    },
  }
  acSignal.addEventListener('abort', () => cleanup.destroyAll())
  window.__heatsyncAcLifecycle = { abort: () => ac.abort() }

  // tab-complete subsystem gate — content.js (ISOLATED) reads
  // ui_settings.subsystems and posts this when the user turned it off.
  window.addEventListener(
    'message',
    (e) => {
      if (e.source !== window) return
      if (e.origin !== location.origin) return
      if (e.data && e.data.type === 'heatsync-gate-tab-complete-off') {
        try {
          ac.abort()
        } catch (_) {}
      }
    },
    { signal: acSignal },
  )

  // Inject CSS to make chat input emote spans auto-size to their content
  // BULLETPROOF: Wide emotes must expand span to fit, never clip
  if (!document.getElementById('heatsync-autocomplete-styles')) {
    const style = document.createElement('style')
    style.id = 'heatsync-autocomplete-styles'
    style.textContent = `
    /* Emote void elements in chat input - must be inline-block to stay on same line */
    [data-slate-editor="true"] [data-slate-void="true"] {
      display: inline-block !important;
      vertical-align: middle !important;
    }
    /* Emote button wrapper - fit content width */
    [data-slate-editor="true"] .chat-line__message--emote-button {
      display: inline-block !important;
      width: auto !important;
      min-width: auto !important;
      padding: 0 !important;
      margin: 0 !important;
      vertical-align: middle !important;
    }
    /* Emote images - respect Twitch's emote size setting */
    [data-slate-editor="true"] img.chat-line__message--emote {
      display: inline-block !important;
      vertical-align: middle !important;
      /* No forced size - inherits from Twitch settings */
    }
    /* 7TV/BTTV emotes - no forced size, respect user's Twitch setting */
    img[src*="7tv.app"],
    img[src*="betterttv.net"],
    img[src*="frankerfacez"] {
      /* Inherit from Twitch's emote size setting */
    }
    /* Hide autocomplete dropdown during heatsync cycling */
    body.heatsync-cycling .chat-input-tray__open {
      display: none !important;
    }
    /* Hide ALL text in void elements during cycling - prevents flash completely */
    body.heatsync-cycling [data-slate-editor="true"] [data-slate-void="true"] {
      color: transparent !important;
    }
    body.heatsync-cycling [data-slate-editor="true"] [data-slate-void="true"] span {
      color: transparent !important;
    }
  `
    document.head.appendChild(style)
  }

  // ========== CRITICAL: Intercept img.src setter to fix broken URLs ==========
  // Use FFZ's exact format for preview creation
  // Format: __FFZ__setId::emoteId__FFZ__ where setId must be numeric for Twitch validation
  const HEATSYNC_SET_ID = '999999' // Fake FFZ set ID (high number to avoid collision)
  const HEATSYNC_PREFIX = `__FFZ__${HEATSYNC_SET_ID}::`
  const HEATSYNC_SUFFIX = '__FFZ__'

  // Shared usage signal with the multichat picker/tab-complete (emotes.js) —
  // same origin, same localStorage keys, so native-chat completions and overlay
  // completions feed one signal. Two stores: the legacy MRU list (RECENT_KEY,
  // drives the picker's "recent" section) and the frecency map (use count with
  // a one-week half-life) that ranks tab-complete. Logic here MUST mirror
  // emotes.js loadEmoteFrecency/bumpEmoteFrecency exactly — this file runs in
  // the MAIN world and can't import it.
  const HS_RECENT_EMOTES_KEY = 'hs-mc-recent-emotes'
  const HS_FRECENCY_KEY = 'hs-mc-emote-frecency'
  const HS_FRECENCY_CAP = 200
  const HS_FRECENCY_HALF_LIFE_MS = 7 * 24 * 3600e3
  function _hsFrecScore(entry, now) {
    if (!entry || !(entry.n > 0)) return 0
    const age = Math.max(0, now - (entry.t || 0))
    return entry.n * 2 ** (-age / HS_FRECENCY_HALF_LIFE_MS)
  }
  function _hsFrecRaw() {
    try {
      const r = JSON.parse(localStorage.getItem(HS_FRECENCY_KEY))
      if (r && typeof r === 'object' && !Array.isArray(r)) return r
    } catch (_) {}
    // First run: seed from the legacy MRU list (same migration as emotes.js).
    const seeded = {}
    try {
      const legacy = JSON.parse(localStorage.getItem(HS_RECENT_EMOTES_KEY))
      if (Array.isArray(legacy)) {
        for (let i = 0; i < legacy.length; i++) seeded[legacy[i]] = { n: 1, t: Date.now() - i * 3600e3 }
      }
    } catch (_) {}
    return seeded
  }
  /** name → decayed score (>0 means the user has actually inserted this) */
  function readEmoteFrecency() {
    const raw = _hsFrecRaw()
    const now = Date.now()
    const out = new Map()
    for (const name of Object.keys(raw)) {
      const s = _hsFrecScore(raw[name], now)
      if (s > 0) out.set(name, s)
    }
    return out
  }
  function bumpEmoteFrecency(name) {
    if (!name) return
    try {
      const raw = _hsFrecRaw()
      const now = Date.now()
      raw[name] = { n: _hsFrecScore(raw[name], now) + 1, t: now }
      const names = Object.keys(raw)
      if (names.length > HS_FRECENCY_CAP) {
        names.sort((a, b) => _hsFrecScore(raw[a], now) - _hsFrecScore(raw[b], now))
        for (const dead of names.slice(0, names.length - HS_FRECENCY_CAP)) delete raw[dead]
      }
      localStorage.setItem(HS_FRECENCY_KEY, JSON.stringify(raw))
    } catch (_) {}
  }
  /** Revert one bump — used when a cycle step replaces a candidate, so only
   *  the emote the user stops on keeps the credit. Mirrors emotes.js. */
  function unbumpEmoteFrecency(name) {
    if (!name) return
    try {
      const raw = _hsFrecRaw()
      const cur = raw[name]
      if (!cur) return
      const n = (cur.n || 0) - 1
      if (n <= 0) delete raw[name]
      else raw[name] = { n, t: cur.t }
      localStorage.setItem(HS_FRECENCY_KEY, JSON.stringify(raw))
    } catch (_) {}
  }
  function recordRecentEmoteMru(name) {
    if (!name) return
    try {
      let list = []
      try {
        const r = JSON.parse(localStorage.getItem(HS_RECENT_EMOTES_KEY))
        list = Array.isArray(r) ? r : []
      } catch (_) {}
      list = list.filter((n) => n !== name)
      list.unshift(name)
      if (list.length > 24) list = list.slice(0, 24)
      localStorage.setItem(HS_RECENT_EMOTES_KEY, JSON.stringify(list))
    } catch (_) {}
    bumpEmoteFrecency(name)
  }
  // Last emote whose frecency this completion session bumped. Usage must
  // reflect where the user STOPS, not every candidate they cycle through —
  // otherwise the #1-ranked emote gets a bump on every Tab press and
  // entrenches itself (the KKonaLand loop: each "kko"+Tab attempt fed the
  // wrong emote before the user ever reached KKona).
  let _frecSessionBumped = null

  // Track insertion state to prevent autocomplete pollution (7TV-style approach)
  // After inserting an emote, Twitch re-reads input and may trigger autocomplete with emote name
  const recentlyInserted = new Set() // Track recently inserted emote names (capped at 100)
  let insertionCount = 0 // Incrementing counter to track unique insertions

  // Clean up tracking sets on page teardown
  acSignal.addEventListener('abort', () => {
    recentlyInserted.clear()
    insertionCount = 0
  })

  // Emoji shortcodes for :name: autocomplete (Discord/Slack style)
  // Use comprehensive emoji dataset from emoji-data.js (loaded before this script)
  // Build name→emoji map for quick lookup
  const EMOJI_MAP = {}
  if (typeof EMOJI_DATA !== 'undefined') {
    for (const entry of EMOJI_DATA) {
      EMOJI_MAP[entry.name] = entry.emoji
    }
  }
  const EMOJI_ENTRIES = typeof EMOJI_DATA !== 'undefined' ? EMOJI_DATA.map((e) => [e.name, e.emoji]) : []

  // ========== Extension Settings ==========
  // Read settings from localStorage (synced with heatsync-button.js panel)
  let cachedSettings = null
  let settingsLastRead = 0
  const SETTINGS_CACHE_MS = 500 // Only re-read every 500ms

  function getExtensionSettings() {
    const now = Date.now()
    // Use cached if fresh enough
    if (cachedSettings && now - settingsLastRead < SETTINGS_CACHE_MS) {
      return cachedSettings
    }
    try {
      const stored = localStorage.getItem('heatsync-extension-settings')
      if (stored) {
        cachedSettings = sanitizeUiSettings(JSON.parse(stored))
        settingsLastRead = now
        return cachedSettings
      }
    } catch (e) {
      log('Failed to parse extension settings:', e)
    }
    // Defaults match main heatsync app
    return {
      emoteWysiwyg: true,
      emoteSpaceAfter: true,
    }
  }

  // Listen for settings changes from the panel (postMessage crosses content/page boundary)
  window.addEventListener(
    'message',
    (e) => {
      if (e.origin !== location.origin) return
      if (e.source !== window) return
      if (e.data?.type === 'heatsync-settings-changed' && e.data.settings) {
        // Clone to avoid any cross-origin wrapper issues, then sanitize so a
        // corrupted page-world payload can't pollute our cache.
        cachedSettings = sanitizeUiSettings(JSON.parse(JSON.stringify(e.data.settings)))
        log(' Settings updated:', cachedSettings)
      }

      // Handle emote insertion requests from content.js (e.g., clicking emotes in stacks)
      if (e.data?.type === 'heatsync-insert-emote' && e.data.name) {
        // source===window && origin===location.origin only proves same-page —
        // ANY script on twitch.tv can forge this (no nonce reaches this MAIN
        // world). Mirror the strict payload validation content.js applies to the
        // sibling heatsync-native-emotes message: without it a malicious page
        // could stamp arbitrary text into the user's draft and force a fetch to
        // an attacker url (rendered as the emote's <img> src). Reject a bad name;
        // drop a bad url (degrade to a name-only insert) rather than break.
        const INSERT_NAME_RE = /^[A-Za-z0-9_:\-()]+$/
        // heatsync own/uploaded emotes are absolutized to cdn.heatsync.org
        // (server rewrites /uploads/* → CDN origin) — must allow it or every
        // self-hosted emote insert loses its image. Same omission bg fixed once.
        const INSERT_CDN_RE =
          /^https:\/\/(static-cdn\.jtvnw\.net\/emoticons|cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|(?:cdn\.)?heatsync\.org)\//
        const name = String(e.data.name)
        if (name.length < 1 || name.length > 64 || !INSERT_NAME_RE.test(name)) return
        const rawUrl = typeof e.data.url === 'string' ? e.data.url : ''
        const rawHash = typeof e.data.hash === 'string' && /^[\w-]{1,100}$/.test(e.data.hash) ? e.data.hash : ''
        log(' 📨 Received insert-emote request:', name)
        const emote = {
          name,
          hash: rawHash || name,
          url: rawUrl.length <= 300 && INSERT_CDN_RE.test(rawUrl) ? rawUrl : '',
        }
        const inst = chatInputInstance || findChatInput()
        if (inst && typeof insertEmoteViaSlate === 'function') {
          if (insertEmoteViaSlate(emote, inst)) {
            log(' ✅ Inserted emote via Slate:', emote.name)
            const inputEl = getInputElement()
            if (inputEl) inputEl.focus()
          } else {
            log(' ❌ Slate insertion failed, falling back to clipboard')
            navigator.clipboard.writeText(`${emote.name} `).catch(() => {})
          }
        } else {
          log(' ❌ No chat input found, copying to clipboard')
          navigator.clipboard.writeText(`${emote.name} `).catch(() => {})
        }
      }
    },
    { signal: acSignal },
  )

  // Cache for getEmotesForFix to avoid re-parsing JSON on every image fix
  let _fixEmotesCache = []
  let _fixEmotesData = ''
  // URL lookup cache - maps ID (hash or name) to resolved URL
  const _urlCache = new Map()
  // URLs of emotes WE inserted via Slate, keyed by the inner FFZ id. Survives
  // bridge changes (unlike _urlCache) so the img.src interceptor can restore the
  // real image after Twitch rebuilds the <img> from our fake id — even for emotes
  // that never made it into the heatsync-emote-bridge (remote 7TV search results,
  // unsynced channel emotes). This was the "tab-complete = broken image" bug.
  const _insertedUrls = new Map()

  // Clean up caches on page teardown
  acSignal.addEventListener('abort', () => {
    _urlCache.clear()
    _insertedUrls.clear()
    _fixEmotesCache = []
    _fixEmotesData = ''
  })

  function getEmotesForFix() {
    const bridge = document.getElementById('heatsync-emote-bridge')
    if (!bridge) return []
    try {
      const rawData = bridge.dataset.emotes || '[]'
      if (rawData === _fixEmotesData) return _fixEmotesCache
      _fixEmotesData = rawData
      _fixEmotesCache = JSON.parse(rawData)
      // Clear URL cache when emotes change
      _urlCache.clear()
      return _fixEmotesCache
    } catch {
      return []
    }
  }

  // Recently-active chatters from content.js (ISOLATED), published on the same
  // DOM bridge (dataset.recentChatters): [{ name: display, l: lower }], newest
  // first, time-windowed. Cached by raw-string compare like getEmotesForFix.
  let _rcRaw = ''
  let _rcCache = []
  function getRecentChattersFromBridge() {
    const bridge = document.getElementById('heatsync-emote-bridge')
    if (!bridge) return []
    try {
      const raw = bridge.dataset.recentChatters || '[]'
      if (raw === _rcRaw) return _rcCache
      _rcRaw = raw
      _rcCache = JSON.parse(raw)
      return _rcCache
    } catch {
      return []
    }
  }

  function fixHeatsyncUrl(value) {
    if (!value || typeof value !== 'string' || !value.includes(HEATSYNC_PREFIX)) return null
    const match = value.match(/__FFZ__999999::(.+?)__FFZ__/)
    if (!match) return null
    const id = match[1]

    // Inserted-emote URLs first — covers emotes not in the bridge (remote 7TV
    // search, unsynced channel emotes) that the bridge-only lookup missed.
    if (_insertedUrls.has(id)) return _insertedUrls.get(id)

    // Check URL cache first (instant lookup)
    if (_urlCache.has(id)) {
      return _urlCache.get(id)
    }

    const emotes = getEmotesForFix()
    // Check both hash and name - some emotes use name as ID when hash is missing
    const emote = emotes.find((e) => e.hash === id || e.name === id)
    if (emote) {
      // Cache the resolved URL
      _urlCache.set(id, emote.url)
      log(' 🔧 INTERCEPTED, fixing:', emote.name)
      return emote.url
    }
    log(' ⚠️ ID not found:', id.substring(0, 20), 'emotes:', emotes.length)
    return null
  }

  // Same fix for a srcset value: Twitch sets BOTH src and srcset on the emote
  // <img>, and the browser renders from srcset — so fixing only src left the
  // broken __FFZ__/jtvnw srcset winning (currentSrc = 404). Rewrite every URL in
  // the comma-separated srcset; descriptors (1x/2x/…) are preserved.
  function fixHeatsyncSrcset(value) {
    if (!value || typeof value !== 'string' || !value.includes(HEATSYNC_PREFIX)) return null
    let changed = false
    const out = value
      .split(',')
      .map((part) => {
        const t = part.trim()
        if (!t) return part
        const sp = t.indexOf(' ')
        const url = sp === -1 ? t : t.slice(0, sp)
        const desc = sp === -1 ? '' : t.slice(sp)
        const f = fixHeatsyncUrl(url)
        if (f) {
          changed = true
          return f + desc
        }
        return t
      })
      .join(', ')
    return changed ? out : null
  }

  // Override img.src property setter and setAttribute
  // NOTE: These overrides only work in Chrome MAIN world. On Firefox MV2 (isolated world),
  // Xray wrappers make prototypes read-only — catch and skip gracefully.
  try {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    if (origSrcDesc) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: function () {
          return origSrcDesc.get.call(this)
        },
        set: function (value) {
          const fixed = fixHeatsyncUrl(value)
          if (fixed) {
            this.dataset.heatsyncFixed = 'true'
            return origSrcDesc.set.call(this, fixed)
          }
          return origSrcDesc.set.call(this, value)
        },
        configurable: true,
        enumerable: true,
      })
    }

    // srcset setter — the browser renders from srcset over src, so this is the
    // one that actually fixes the broken emote image.
    const origSrcsetDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset')
    if (origSrcsetDesc) {
      Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
        get: function () {
          return origSrcsetDesc.get.call(this)
        },
        set: function (value) {
          const fixed = fixHeatsyncSrcset(value)
          if (fixed) {
            this.dataset.heatsyncFixed = 'true'
            return origSrcsetDesc.set.call(this, fixed)
          }
          return origSrcsetDesc.set.call(this, value)
        },
        configurable: true,
        enumerable: true,
      })
    }

    const origSetAttribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'IMG' && (name === 'src' || name === 'srcset')) {
        const fixed = name === 'src' ? fixHeatsyncUrl(value) : fixHeatsyncSrcset(value)
        if (fixed) {
          this.dataset.heatsyncFixed = 'true'
          return origSetAttribute.call(this, name, fixed)
        }
      }
      return origSetAttribute.call(this, name, value)
    }

    log(' ✅ Image src + srcset interceptors installed')
  } catch (_e) {
    // Firefox MV2: prototype overrides fail on Xray wrappers — emote URL fixing
    // relies on early-inject-main.js in MAIN world instead (Chrome-only feature)
    log(' ⚠️ Image src interceptors skipped (isolated world)')
  }

  // ── Catch-all backstop for the broken tab-complete emote image ────────────
  // Twitch renders an inserted emote across several <img> elements and sets their
  // src/srcset via parsed/cloned markup that BYPASSES the property + setAttribute
  // hooks above (verified live: the hooks fire for normal sets, but the rendered
  // img's __FFZ__ srcset slips through and wins over the fixed src → broken emote).
  // A MutationObserver scoped to the chat input fixes any __FFZ__ src/srcset on
  // whatever element appears, whenever it appears (verified: once fixed it sticks).
  function fixEmoteImgEl(img) {
    if (img?.tagName !== 'IMG') return
    const ss = img.getAttribute('srcset')
    if (ss?.includes(HEATSYNC_PREFIX)) img.setAttribute('srcset', fixHeatsyncSrcset(ss) || '')
    const sc = img.getAttribute('src')
    if (sc?.includes(HEATSYNC_PREFIX)) {
      const f = fixHeatsyncUrl(sc)
      if (f) img.setAttribute('src', f)
    }
  }
  let _inputImgObserver = null
  let _observedArea = null
  function ensureInputImgObserver() {
    const editor = document.querySelector('[data-slate-editor="true"]')
    const area = editor?.closest('.chat-input') || editor?.parentElement?.parentElement || editor
    if (!area || (_observedArea === area && _inputImgObserver)) return
    try {
      _inputImgObserver?.disconnect()
    } catch {}
    _observedArea = area
    area.querySelectorAll('img').forEach(fixEmoteImgEl)
    _inputImgObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          fixEmoteImgEl(m.target)
          continue
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue
          if (n.tagName === 'IMG') fixEmoteImgEl(n)
          else if (n.querySelectorAll) n.querySelectorAll('img').forEach(fixEmoteImgEl)
        }
      }
    })
    _inputImgObserver.observe(area, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    })
    log(' ✅ Chat-input emote-img observer installed')
  }
  // Input mounts after load + remounts on channel change — poll to install /
  // re-acquire it.
  const _obsPoll = setInterval(() => {
    try {
      ensureInputImgObserver()
    } catch {}
  }, 1500)
  acSignal.addEventListener('abort', () => {
    clearInterval(_obsPoll)
    try {
      _inputImgObserver?.disconnect()
    } catch {}
  })

  let chatInputInst = null

  // Get native Twitch emotes from React props (includes sub emotes from all channels)
  function getNativeTwitchEmotes() {
    const inst = chatInputInstance || chatInputInst
    if (!inst?.props?.emotes) return []
    const emotes = []
    for (const set of inst.props.emotes) {
      if (!set?.emotes || set.id === 'HeatSyncEmotes') continue
      // Sub/follower/bits sets carry an owner; setID '0' and ownerless sets are Twitch globals
      const ownerLogin = set.owner?.login || set.owner?.displayName || ''
      const isSub = set.id !== '0' && !!ownerLogin
      for (const e of set.emotes) {
        if (!e.token) continue
        emotes.push({
          name: e.token,
          nameLower: e.token.toLowerCase(),
          hash: e.id,
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0`,
          native: true,
          source: 'twitch',
          sub: isSub,
          owner: ownerLogin,
        })
      }
    }
    return emotes
  }

  // Get all emotes for Tab cycling (bridge + native Twitch)
  function getAllEmotesForCycling() {
    const bridgeEmotes = getEmotesForFix()
    const seen = new Set()
    const all = []
    for (const e of bridgeEmotes) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      if (!e.nameLower) e.nameLower = (e.name || '').toLowerCase()
      all.push(e)
    }
    for (const e of getNativeTwitchEmotes()) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      // sub emotes are channel-tier (0), the rest global (2); bridge emotes already
      // carry their real tier (0=channel/1=own/2=global) from content.js.
      if (e.tier == null) e.tier = e.sub ? 0 : 2
      all.push(e)
    }
    return all
  }

  // Infinite Tab-cycle: when local matches run out, pull more from the 7TV
  // search API (same source the multichat picker uses) and append to the live
  // cycle. Inserted as heatsync-style emote nodes — the name is what gets sent,
  // and renders for any recipient running the extension.
  const SEVEN_TV_GQL = `query SearchEmotes($query: String!, $page: Int!, $perPage: Int!) {
    emotes {
      search(query: $query, sort: { sortBy: TOP_ALL_TIME, order: DESCENDING }, page: $page, perPage: $perPage) {
        items { id defaultName flags { animated defaultZeroWidth } }
      }
    }
  }`
  let _hsRemoteAbort = null
  let _hsRemoteToken = 0
  // Paged catalog cycling (mirror of the overlay's fetchRemoteEmoteMatches):
  // each call pulls the NEXT 7TV page; `remoteFetched` now means "catalog
  // exhausted — no further fetch can help" and flips on a short page, an API
  // error, or the cycle size cap. Popular prefixes need this: page 1 sorted
  // by all-time top is mostly emotes already loaded locally, the dedupe
  // dropped every hit, and the cycle wrapped back to 1/N as if 7TV had
  // nothing left.
  const HS_REMOTE_PAGE = 200
  const HS_REMOTE_LOOKAHEAD = 5 // start fetching this many matches BEFORE the end
  const HS_REMOTE_MAX_MATCHES = 1000
  const HS_REMOTE_CHASE_PAGES = 4 // consecutive all-duplicate pages before giving up the trigger
  async function fetch7tvCycleMatches(search) {
    // Emote-only: skip :emoji, @user, and short fragments.
    if (!search || search.length < 2 || search.startsWith(':') || search.startsWith('@')) return
    if (cycleState.matches.length >= HS_REMOTE_MAX_MATCHES) {
      cycleState.remoteFetched = true
      return
    }
    const token = ++_hsRemoteToken
    cycleState.remotePending = true
    // Clear the "searching…" flag and refresh the tooltip — but only if a newer
    // fetch hasn't superseded this one (then it owns the flag).
    const _doneRemote = () => {
      if (token !== _hsRemoteToken) return
      cycleState.remotePending = false
      if (cycleState.lastCycledEmote != null) {
        const cur = cycleState.matches[cycleState.index]
        if (cur) showCycleTooltip(cycleState.index + 1, cycleState.matches.length, cur)
      }
    }
    if (_hsRemoteAbort) {
      try {
        _hsRemoteAbort.abort()
      } catch (_) {}
    }
    const ac = new AbortController()
    _hsRemoteAbort = ac
    // Chase: an all-duplicate page is not the end of the catalog — keep paging
    // a bounded number of times until something NEW appears or 7TV runs dry.
    let add = []
    for (let chase = 0; chase < HS_REMOTE_CHASE_PAGES; chase++) {
      const page = (cycleState._remotePage || 0) + 1
      let items
      try {
        const resp = await fetch('https://api.7tv.app/v4/gql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            operationName: 'SearchEmotes',
            query: SEVEN_TV_GQL,
            variables: { query: search, page, perPage: HS_REMOTE_PAGE },
          }),
        })
        if (!resp.ok) {
          // Retrying a failing API on every trigger helps nobody — stop here.
          cycleState.remoteFetched = true
          _doneRemote()
          return
        }
        const data = await resp.json()
        items = data?.data?.emotes?.search?.items || []
      } catch (_) {
        if (!ac.signal.aborted) cycleState.remoteFetched = true
        _doneRemote()
        return
      }
      if (ac.signal.aborted || token !== _hsRemoteToken) {
        _doneRemote()
        return
      }
      // Cycle must still be on the search this fetch was issued for.
      if (cycleState.searchTerm !== search) {
        _doneRemote()
        return
      }
      cycleState._remotePage = page
      // Short page → the catalog has no next page for this search.
      if (items.length < HS_REMOTE_PAGE) cycleState.remoteFetched = true
      // Dedupe by EXACT name (casing distinguishes emotes), matching the picker.
      const have = new Set(cycleState.matches.map((m) => m.name))
      add = []
      for (const it of items) {
        const name = it.defaultName
        if (!name || have.has(name)) continue
        have.add(name)
        const nl = name.toLowerCase()
        add.push({
          name,
          nameLower: nl,
          url: `https://cdn.7tv.app/emote/${it.id}/1x.webp`,
          remote: true,
          source: '7tv',
          zeroWidth: !!it.flags?.defaultZeroWidth,
        })
      }
      if (add.length) break // got new content; the next page fetches as the user nears the new end
      if (cycleState.remoteFetched) break // drained with nothing new — the cycle wraps
    }
    if (!add.length) {
      _doneRemote()
      return
    }
    const searchLower = search.toLowerCase()
    add = add.slice(0, Math.max(0, HS_REMOTE_MAX_MATCHES - cycleState.matches.length))
    if (cycleState.matches.length + add.length >= HS_REMOTE_MAX_MATCHES) cycleState.remoteFetched = true
    add.forEach((m) => {
      // Persistent sequence, NOT the per-merge index — page 2's counter
      // restarting at 0 would interleave it into page 1 on sort ties.
      m._ai = cycleState._aiSeq = (cycleState._aiSeq || 0) + 1
    })
    // Append-only merge — NEVER re-sort the whole list mid-cycle. The old
    // full-list re-sort let a remote exact-name hit jump above the user's
    // position, running the tooltip BACKWARDS (4/4 -> 2/70) and reshuffling
    // every ordinal they had already seen. Existing entries never move; the
    // new block is ordered internally (exact match first, then 7TV
    // TOP_ALL_TIME fetch order via the persistent _ai).
    add.sort((a, b) => {
      const ax = (a.nameLower || '') === searchLower ? 0 : 1
      const bx = (b.nameLower || '') === searchLower ? 0 : 1
      if (ax !== bx) return ax - bx
      return (a._ai || 0) - (b._ai || 0)
    })
    cycleState.matches.push(...add)
    // Clear the "searching…" flag and refresh the N/M denominator + readout.
    _doneRemote()
  }

  // Cached emotes to avoid repeated JSON parsing
  let _cachedEmotes = []
  let _lastVersion = ''

  // Get heatsync emotes from bridge (cached)
  function getHeatsyncEmotes() {
    const bridge = document.getElementById('heatsync-emote-bridge')
    if (!bridge) return []
    try {
      const version = bridge.dataset.version || ''
      // Only re-parse if version counter changed (tiny string compare vs 4MB)
      if (version === _lastVersion) return _cachedEmotes
      _lastVersion = version

      const emotes = JSON.parse(bridge.dataset.emotes || '[]')
      // Pre-index lowercase names for O(1) lookups (avoids 50k toLowerCase() calls per search)
      for (const e of emotes) {
        e.nameLower = e.name.toLowerCase()
      }
      _cachedEmotes = emotes

      // Populate URL map for early-inject.js interceptor (both in MAIN world)
      if (emotes.length > 0) {
        window.__heatsyncEmoteUrls = {}
        for (const e of emotes) {
          if (e.hash && e.url) {
            window.__heatsyncEmoteUrls[e.hash] = e.url
          }
        }
      }
      return emotes
    } catch (_e) {
      return []
    }
  }

  // React fiber walking (FFZ-style)
  function getFiber(el) {
    if (!el) return null
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    return key ? el[key] : null
  }
  // Exposed for twitch-chat-intercept.js (same MAIN-world content_scripts
  // entry, loaded second per manifest.json js[] order) so it doesn't need
  // its own copy of this walk.
  window.__hsGetFiber = getFiber

  // Find React ChatInput instance
  function findChatInput() {
    const el =
      document.querySelector('[data-a-target="chat-input"]') || document.querySelector('[data-slate-editor="true"]')
    if (!el) return null

    let fiber = getFiber(el)
    if (!fiber) return null
    let depth = 0

    while (fiber && depth < 100) {
      const inst = fiber.stateNode
      if (inst?.autocompleteInputRef?.setValue) {
        // Add our own helper methods if FFZ hasn't added them
        if (!inst.hsGetValue) {
          inst.hsGetValue = () => {
            if (inst.chatInputRef && typeof inst.chatInputRef.value === 'string') return inst.chatInputRef.value
            if (inst.state?.value && typeof inst.state.value === 'string') return inst.state.value
            // For Slate editor, get text content
            const slateEl = document.querySelector('[data-slate-editor="true"]')
            if (slateEl) return slateEl.textContent || ''
            return ''
          }
          inst.hsGetSelection = () => {
            // Simple approach: use DOM selection
            const sel = window.getSelection()
            if (!sel.rangeCount) return [0, 0]
            const slateEl = document.querySelector('[data-slate-editor="true"]')
            if (!slateEl) return [0, 0]

            const range = sel.getRangeAt(0)
            const preRange = document.createRange()
            preRange.selectNodeContents(slateEl)
            preRange.setEnd(range.startContainer, range.startOffset)
            const start = preRange.toString().length
            const end = start + range.toString().length
            return [start, end]
          }
        }
        return inst
      }
      fiber = fiber.return
      depth++
    }
    return null
  }

  // Create fake emote set for Twitch to recognize (like FFZ does)
  function createFakeEmoteSet() {
    const emotes = getHeatsyncEmotes()
    if (!emotes.length) return null

    // Include ALL emotes with full structure including images
    // This prevents Twitch from having to look up images separately (which causes text flash)
    const out = emotes.map((emote) => {
      let url = emote.url
      if (url && (url.startsWith('/uploads/') || url.startsWith('/emotes/'))) {
        url = `https://heatsync.org${url}`
      }
      return {
        __typename: 'Emote',
        id: HEATSYNC_PREFIX + (emote.hash || emote.name) + HEATSYNC_SUFFIX,
        modifiers: null,
        setID: 'HeatSyncEmotes',
        token: emote.name,
        // Include srcSet to prevent image lookup delay
        srcSet: url ? `${url} 1x` : undefined,
      }
    })

    log(' Created fake emote set with', out.length, 'emotes')

    return {
      __typename: 'EmoteSet',
      emotes: out,
      id: 'HeatSyncEmotes',
      owner: null,
    }
  }

  // Export native Twitch emotes (sub emotes) to content.js via postMessage
  // Content.js stores them to chrome.storage.local so multichat can read them
  let _lastExportCount = 0
  function exportNativeEmotes() {
    const inst = chatInputInstance || chatInputInst
    if (!inst?.props?.emotes) return

    const emotes = []
    for (const set of inst.props.emotes) {
      if (!set?.emotes || set.id === 'HeatSyncEmotes') continue
      // Set ID 0 = Twitch global; numeric set IDs with an owner = sub/follower/bits
      const ownerLogin = set.owner?.login || set.owner?.displayName || ''
      const ownerDisplay = set.owner?.displayName || set.owner?.login || ''
      const isGlobal = set.id === '0' || !ownerLogin
      // Twitch sub badge tier classification: regular sub = 1000/2000/3000, follower/bits/prime vary
      const tier = set.tier || ''
      for (const e of set.emotes) {
        if (!e.token) continue
        const emote = {
          name: e.token,
          hash: e.id,
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0`,
        }
        if (!isGlobal) {
          emote.owner = ownerLogin
          emote.ownerDisplay = ownerDisplay
          if (tier) emote.tier = tier
        }
        emotes.push(emote)
      }
    }

    // Skip if nothing changed (avoid redundant storage writes)
    if (emotes.length === 0 || emotes.length === _lastExportCount) return
    _lastExportCount = emotes.length

    window.postMessage({ type: 'heatsync-native-emotes', emotes }, location.origin)
    log('📺 Exported', emotes.length, 'native Twitch emotes via postMessage')
  }

  // Inject fake emotes into Twitch's emote array
  let chatInputInstance = null // Store instance for forceUpdate calls

  function injectFakeEmotes(inst) {
    if (!inst?.props?.emotes) {
      log(' ⚠️ No props.emotes array found on instance')
      return
    }

    chatInputInstance = inst // Store for later updates

    const idx = inst.props.emotes.findIndex((s) => s?.id === 'HeatSyncEmotes')
    const data = createFakeEmoteSet()
    let changed = false

    if (idx === -1 && data) {
      inst.props.emotes.push(data)
      changed = true
      log(' ✅ Injected', data.emotes.length, 'fake emotes for inline rendering')
      log(' Sample fake emote:', data.emotes[0])
      log(' Total emote sets now:', inst.props.emotes.length)
      // Debug: show native Twitch emote for comparison
      const nativeSet = inst.props.emotes.find((s) => s?.id !== 'HeatSyncEmotes' && s?.emotes?.length > 0)
      if (nativeSet?.emotes?.[0]) {
        log(' 📊 Native Twitch emote for comparison:', JSON.stringify(nativeSet.emotes[0], null, 2))
      }
    } else if (idx !== -1 && data) {
      inst.props.emotes.splice(idx, 1, data)
      changed = true
      log(' 🔄 Updated fake emotes')
    } else if (idx !== -1 && !data) {
      inst.props.emotes.splice(idx, 1)
      changed = true
    } else if (!data) {
      log(' ⚠️ No fake emote data created (emotes empty?)')
    }

    // Force React to re-render with new emotes (critical for preview creation!)
    if (changed && typeof inst.forceUpdate === 'function') {
      log(' 🔄 Calling forceUpdate() to re-render component')
      inst.forceUpdate()
    }
  }

  // Override emote provider's getMatches to include heatsync emotes (FFZ-style)
  function overrideEmoteProvider(inst) {
    if (!inst?.autocompleteInputRef?.providers) {
      log(' ⚠️ No autocomplete providers found')
      return
    }

    for (const provider of inst.autocompleteInputRef.providers) {
      if (provider.autocompleteType !== 'emote') continue
      if (provider._heatsync_hooked) continue

      // Enable tab completion without colon prefix (FFZ-style)
      provider.canBeTriggeredByTab = true
      log(' Setting canBeTriggeredByTab on provider:', provider.autocompleteType, 'props:', Object.keys(provider))

      const origGetMatches = provider.getMatches
      if (typeof origGetMatches !== 'function') continue

      provider.getMatches = function (input, pressedTab, ...args) {
        // Get original Twitch results first
        let results = origGetMatches.call(this, input, pressedTab, ...args)
        if (!Array.isArray(results)) results = []

        log(' getMatches:', input, 'twitch results:', results.length, 'recentlyInserted:', [...recentlyInserted])

        // Bulletproof pollution prevention:
        // If Twitch sends a polluted query (emote name instead of what user typed),
        // extract actual user input and return matches for THAT instead
        let actualInput = input
        if (recentlyInserted.has(input)) {
          // Twitch is polluted - find what user actually typed
          const inputEl = document.querySelector('[data-slate-editor="true"]')
          if (inputEl) {
            const text = inputEl.textContent || ''
            // Find text after the last recently inserted emote
            // IMPORTANT: Find LONGEST match first to avoid "Kappa" matching inside "KappaRoss"
            let lastIdx = -1
            let lastEmoteName = ''
            // Sort by length descending so longer names are checked first
            const sortedEmotes = [...recentlyInserted].sort((a, b) => b.length - a.length)
            for (const emoteName of sortedEmotes) {
              const idx = text.lastIndexOf(emoteName)
              if (idx > lastIdx) {
                lastIdx = idx
                lastEmoteName = emoteName
              }
            }
            if (lastIdx >= 0) {
              const afterEmote = text.substring(lastIdx + lastEmoteName.length)
              const cleanAfter = afterEmote.replace(/[\s\u200b\ufeff]/g, '')
              if (cleanAfter && cleanAfter.length >= 2) {
                log(' 🔄 Pollution detected! Twitch says:', input, 'but user typed:', cleanAfter)

                // CRITICAL: If we're currently cycling and the "new input" is a suffix of the cycled emote,
                // this is NOT new user input - it's Twitch picking up part of our emote name.
                // Return empty to hide dropdown and preserve cycleState for Tab cycling.
                if (cycleState.lastCycledEmote) {
                  const cycledLower = cycleState.lastCycledEmote.toLowerCase()
                  const cleanLower = cleanAfter.toLowerCase()
                  if (cycledLower.endsWith(cleanLower) || cycledLower === cleanLower) {
                    log(' ⏭️ Skipping suffix pollution during cycle:', cleanAfter, 'from', cycleState.lastCycledEmote)
                    return []
                  }
                }

                actualInput = cleanAfter
                // DON'T clear recentlyInserted here - Twitch will call getMatches again
                // and we need to keep detecting pollution until insertReplacement clears it
              } else {
                // No new user input, just skip and hide dropdown
                log(' ⏭️ Skipping - pollution with no new input:', input)
                document.body.classList.add('heatsync-cycling')
                return []
              }
            }
          } else {
            log(' ⏭️ Skipping - exact match to recently inserted:', input)
            document.body.classList.add('heatsync-cycling')
            return []
          }
        }

        // DEBUG: Log structure of first result's element (7TV-style fix needs this)
        if (results.length > 0 && results[0].element) {
          const elem = results[0].element
          log(
            ' 🔍 Result element structure:',
            'isArray:',
            Array.isArray(elem),
            'length:',
            elem?.length,
            'elem[0].key:',
            elem?.[0]?.key,
            'elem[0].props:',
            Object.keys(elem?.[0]?.props || {}),
          )
          if (elem?.[0]?.props?.children?.props) {
            log(' 🔍 children.props:', Object.keys(elem[0].props.children.props))
          }
        }

        // Strip colon prefix if present for search - use actualInput (corrected for pollution)
        const search = actualInput.startsWith(':') ? actualInput.slice(1) : actualInput
        if (search.length < 2) return results

        // Get heatsync emotes
        const hsEmotes = getHeatsyncEmotes()
        const searchLower = search.toLowerCase()

        // BTTV/FFZ modifier tokens MUST NOT autocomplete — they're not emotes.
        // (Otherwise typing "w!" + Tab inserts a random emote whose name
        // contains "w" + "!", breaking the modifier-on-previous-emote flow.)
        // Asks the shared classifier rather than a local list: the local list
        // had drifted and was missing r!/p!/s!/ffzW and every animated ffz*
        // token, so those still hit the fuzzy matcher. Also covers c!#hex and
        // chained forms ("w!h!") for free.
        if (hsModClassify(search, { allowPrefix: false }).kind === 'modifier') {
          log(' [heatsync-autocomplete] modifier token, suppressing match:', search)
          // One-shot per modifier per session — don't spam if user keeps tabbing
          if (!window.__hsModifierToastSeen) window.__hsModifierToastSeen = new Set()
          if (!window.__hsModifierToastSeen.has(search)) {
            window.__hsModifierToastSeen.add(search)
            const toast = document.createElement('div')
            toast.textContent = 'type modifier after an emote name: LUL w! h! c!#ff0000'
            toast.style.cssText =
              'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#ccc;font:13px/1.4 monospace;padding:7px 14px;border-radius:0;z-index:2147483647;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px #0008'
            document.body.appendChild(toast)
            setTimeout(() => toast.remove(), 2000)
          }
          return []
        }

        // Fuzzy match: sequential character match with scoring
        function fuzzyMatch(query, name) {
          if (name.includes(query)) return 2 + query.length / name.length // exact substring
          let qi = 0
          for (let i = 0; i < name.length && qi < query.length; i++) {
            if (name[i] === query[qi]) qi++
          }
          return qi >= query.length ? qi / name.length : 0
        }

        // Filter matching heatsync emotes (array, not Map — avoids allocation per keystroke)
        const hsMatches = []
        for (const emote of hsEmotes) {
          if (!emote.hash) continue
          const score = fuzzyMatch(searchLower, emote.nameLower)
          if (score <= 0) continue
          emote._score = score
          hsMatches.push(emote)
        }

        // Include native Twitch emotes (sub emotes, etc.) that Twitch's own getMatches missed
        // (Twitch's native getMatches returns 0 for non-colon searches)
        const hsMatchNames = new Set(hsMatches.map((e) => e.name))
        const resultNames = new Set(results.map((r) => r.replacement || r.emote?.token))
        for (const emote of getNativeTwitchEmotes()) {
          if (hsMatchNames.has(emote.name) || resultNames.has(emote.name)) continue
          const score = fuzzyMatch(searchLower, emote.nameLower)
          if (score <= 0) continue
          emote._score = score
          // Native Twitch: sub emotes are channel-tier (0), the rest are global (2).
          // Heatsync bridge emotes already carry their real tier (0/1/2) from content.js.
          emote.tier = emote.sub ? 0 : 2
          hsMatches.push(emote)
        }

        // 7TV-style fix: Modify srcSet on React elements for our emotes
        results.forEach((m) => {
          if (!m.element || !Array.isArray(m.element) || !m.element[0]) return
          const elem = m.element[0]
          const key = elem.key || ''

          // Check if this is a heatsync emote (key contains our fake FFZ ID)
          if (key.includes('__FFZ__999999::')) {
            const match = key.match(/__FFZ__999999::(.+?)__FFZ__/)
            if (match) {
              const hash = match[1]
              const emote = hsEmotes.find((e) => e.hash === hash)
              if (emote) {
                // Log what Twitch generated so we can see the URL format
                const currentSrcSet = elem.props?.children?.props?.srcSet
                log(' 🎯 Fixing srcSet for:', emote.name)
                log(' 📊 Twitch generated srcSet:', currentSrcSet?.substring?.(0, 120) || 'undefined')
                log(' 📊 Our URL:', emote.url)
                // Try different paths to srcSet AND src (both needed for display)
                if (elem.props?.children?.props) {
                  elem.props.children.props.srcSet = `${emote.url} 1x, ${emote.url} 2x`
                  elem.props.children.props.src = emote.url // Also set src for fallback
                  log(' ✅ Set srcSet+src on children.props')
                }
                if (elem.props?.srcSet !== undefined) {
                  elem.props.srcSet = `${emote.url} 1x, ${emote.url} 2x`
                  elem.props.src = emote.url
                  log(' ✅ Set srcSet+src on props directly')
                }
              }
            }
          }
        })

        // Add heatsync emotes that aren't already in results
        for (const emote of hsMatches) {
          // Check if already in results
          if (results.some((r) => r.emote?.token === emote.name)) continue

          const emoteId = emote.native ? emote.hash : HEATSYNC_PREFIX + emote.hash + HEATSYNC_SUFFIX
          const setId = emote.native ? 'TwitchEmotes' : 'HeatSyncEmotes'
          let srcSet = `${emote.url} 1x, ${emote.url} 2x`
          if (emote.native) {
            const base = `https://static-cdn.jtvnw.net/emoticons/v2/${emote.hash}`
            srcSet = `${base}/default/dark/1.0 1x, ${base}/default/dark/2.0 2x`
          }
          results.push({
            current: input,
            replacement: emote.name,
            element: null,
            emote: {
              id: emoteId,
              setID: setId,
              token: emote.name,
              srcSet: srcSet,
            },
            _heatsyncSub: !!emote.sub,
            _tier: emote.tier,
          })
        }

        // Usernames intentionally NOT injected — Twitch's native @user completion
        // covers that surface. Bare-word Tab is emote-only.

        // Emoji shortcodes (:name:) handled by Tab cycling only — not injected into dropdown

        // Sort results: EMOTES first, then USERNAMES
        // Pre-compute sort keys to avoid repeated toLowerCase() in comparator.
        // Sub emotes flagged via _heatsyncSub on the matches we pushed; for results
        // Twitch returned natively, derive from name (sub names tracked above).
        const nativeSubNames = new Set()
        for (const e of getNativeTwitchEmotes()) {
          if (e.sub) nativeSubNames.add(e.name)
        }
        const frec = readEmoteFrecency()
        for (const r of results) {
          const name = r.replacement || r.emote?.token || ''
          r._sortKey = name.toLowerCase()
          r._sortType = r.emote ? 0 : 1 // 0=emote, 1=username
          r._isSub = r._heatsyncSub || nativeSubNames.has(name)
          // channel(0) > own(1) > global(2). Pushed heatsync/native emotes carry _tier;
          // anything else (Twitch's own dropdown results) falls back via sub status —
          // sub emotes are channel-tier (0).
          r._tier = r._tier ?? (r._isSub ? 0 : 2)
          r._frec = frec.get(name) || 0
          // Exact: the typed word IS this emote's full name. Leads outright,
          // UNCONDITIONALLY — typing the whole name is the intent ("nam" →
          // NaM even if never used and the channel has a NAMarrive). Reverses
          // the old "tier beats never-used exact" call: precision wins.
          r._exact = r._sortKey === searchLower
        }
        // Same ranking as the multichat comparator (input.js compareAcMatches)
        // — keep the two in lockstep so native chat and the overlay never
        // disagree on what Tab produces.
        results.sort((a, b) => {
          // Category sort: emotes < usernames
          if (a._sortType !== b._sortType) return a._sortType - b._sortType

          // Usernames: alphabetical only
          if (a._sortType === 1) return a._sortKey.localeCompare(b._sortKey)

          // Full-name exact match beats everything.
          if (a._exact !== b._exact) return a._exact ? -1 : 1

          // Personal habit beats structure: an emote the user actually sends
          // wins over tier ("kko" → their KKona, never the channel's untouched
          // KKonaLand).
          const aUsed = a._frec > 0
          const bUsed = b._frec > 0
          if (aUsed !== bUsed) return aUsed ? -1 : 1

          const aPrefix = a._sortKey.startsWith(searchLower)
          const bPrefix = b._sortKey.startsWith(searchLower)
          if (aUsed) {
            // both used — they typed a prefix, respect it; then habit strength
            if (aPrefix !== bPrefix) return aPrefix ? -1 : 1
            if (a._frec !== b._frec) return b._frec - a._frec
            if (a._tier !== b._tier) return a._tier - b._tier
          } else {
            // neither used — channel culture leads (tier), then prefix >
            // contains > sub emote (exact already ranked above, absolutely)
            if (a._tier !== b._tier) return a._tier - b._tier
            if (aPrefix !== bPrefix) return aPrefix ? -1 : 1
            if (a._isSub !== b._isSub) return a._isSub ? -1 : 1
          }

          if (a._sortKey.length !== b._sortKey.length) return a._sortKey.length - b._sortKey.length
          return a._sortKey.localeCompare(b._sortKey)
        })
        // Clean up sort keys
        for (const r of results) {
          delete r._sortKey
          delete r._sortType
          delete r._isSub
          delete r._heatsyncSub
          delete r._tier
          delete r._frec
          delete r._exact
        }

        if (results.length > 0) {
          log(
            ' getMatches returning:',
            results.length,
            'total, first:',
            results[0]?.replacement || results[0]?.emote?.token,
          )
        }
        return results
      }
      provider._heatsync_hooked = true
      log(' ✅ Hooked emote provider (canBeTriggeredByTab enabled)')
    }
  }

  // Hook componentDidUpdate to re-inject emotes when props change (FFZ-style)
  let _exportDebounce = null
  function hookComponentDidUpdate(inst) {
    if (inst._heatsync_cdu_hooked) return

    const orig = inst.componentDidUpdate
    inst.componentDidUpdate = function (prevProps, ...args) {
      try {
        if (prevProps.emotes !== this.props.emotes && Array.isArray(this.props.emotes)) {
          injectFakeEmotes(this)
          // Re-export native emotes when Twitch lazy-loads sub/follower sets
          clearTimeout(_exportDebounce)
          _exportDebounce = cleanup.setTimeout(exportNativeEmotes, 500)
        }
      } catch (_e) {}
      if (orig) orig.call(this, prevProps, ...args)
    }
    inst._heatsync_cdu_hooked = true
    log(' ✅ Hooked componentDidUpdate')
  }

  // Hook insertReplacement (pass-through to native)
  // Track state to enable Tab cycling through matches
  const cycleState = {
    lastEmote: null,
    lastTime: 0,
    matchesTime: 0, // When matches list was populated (for initial Tab window)
    matches: [], // All matching emotes for current search
    index: 0, // Current position in matches
    lastCycledEmote: null, // Name of emote we just cycled to (to detect suffix pollution)
    searchTerm: '', // Original search term (cleaned)
  }

  // (lastEnterPressTime removed — Enter is never intercepted by this module;
  // the send-flush below only OBSERVES Enter, it never prevents/stops it.)

  // Remote-search (7TV catalog) completions inserted this session: name →
  // {url, source}. On send, any still present in the outgoing input is relayed
  // to the ISOLATED world (input.js), which routes it through the same
  // auto-add-on-send guards the overlay input uses — so a remote emote
  // tab-completed in NATIVE twitch chat joins the viewer's set exactly like
  // one completed in the overlay (parity: input.js trackCompletionForAutoAdd).
  // Send-time presence check (not add-on-insert) so cycling PAST a remote
  // emote, or completing then deleting it, never burns an inventory slot.
  const _remoteCompletions = new Map()
  const REMOTE_COMPLETION_CAP = 100
  function trackRemoteCompletion(m) {
    if (!m?.remote || !m.name || !m.url || m.source !== '7tv') return
    _remoteCompletions.delete(m.name)
    _remoteCompletions.set(m.name, { url: m.url, source: m.source, zeroWidth: !!m.zeroWidth })
    while (_remoteCompletions.size > REMOTE_COMPLETION_CAP) {
      _remoteCompletions.delete(_remoteCompletions.keys().next().value)
    }
  }
  function flushRemoteCompletionsOnSend(inputEl) {
    if (!_remoteCompletions.size || !inputEl) return
    // Emotes live as void Slate nodes (img alt) in wysiwyg mode and as plain
    // words in text mode — collect both before Twitch clears the input.
    const present = new Set((inputEl.textContent || '').split(/\s+/))
    for (const img of inputEl.querySelectorAll('img[alt]')) present.add(img.alt)
    const used = []
    for (const [name, rec] of _remoteCompletions) {
      if (present.has(name)) used.push({ name, url: rec.url, source: rec.source, zeroWidth: !!rec.zeroWidth })
    }
    if (!used.length) return
    for (const u of used) _remoteCompletions.delete(u.name)
    window.postMessage({ type: 'heatsync-remote-completion-used', emotes: used.slice(0, 20) }, location.origin)
  }

  // Track preloaded emote names (Image() preloading disabled — ORB blocks in content scripts)
  const preloadedImages = new Map()
  const MAX_PRELOADED = 500
  function _preloadEmoteImages(emotes) {
    for (const emote of emotes) {
      if (!emote.url || preloadedImages.has(emote.name)) continue
      let url = emote.url
      if (url.startsWith('/uploads/') || url.startsWith('/emotes/')) {
        url = `https://heatsync.org${url}`
      }
      preloadedImages.set(emote.name, { src: url })
    }
    // Evict oldest if over cap
    if (preloadedImages.size > MAX_PRELOADED) {
      const excess = preloadedImages.size - MAX_PRELOADED
      const keys = [...preloadedImages.keys()].slice(0, excess)
      for (const k of keys) preloadedImages.delete(k)
    }
  }

  acSignal.addEventListener('abort', () => preloadedImages.clear())

  // Cycle indicator tooltip (shows "1/5 emotename" above input)
  let cycleTooltip = null
  let cycleTooltipTimeout = null
  acSignal.addEventListener('abort', () => {
    cycleTooltip?.remove()
    cycleTooltip = null
  })

  // Cycle-depth + visibility readout — same model as the multichat overlay:
  // "cat" = where in the cycle you are (channel → your set → global → 7tv search);
  // "vis" = who actually sees the image if you send it. Colors form a breadth
  // gradient: green (everyone) → yellow (needs a provider ext) → orange (heatsync
  // only — non-heatsync viewers get plain text).
  function emoteCycleMeta(m) {
    if (!m) return { cat: '', vis: null }
    if (m.isUser || m.type === 'user') return { cat: 'chatter', vis: { t: 'everyone', c: '#5fd75f' } }
    if (m.isEmoji || m.type === 'emoji') return { cat: 'emoji', vis: { t: 'everyone', c: '#5fd75f' } }
    if (m.remote) return { cat: '7tv search', vis: { t: 'heatsync only', c: '#fff' } }
    const tier = m.tier ?? 2
    const cat = tier === 0 ? 'channel' : tier === 1 ? 'your inventory' : 'global'
    if (m.source === 'twitch' || m.native) return { cat, vis: { t: 'all twitch', c: '#5fd75f' } }
    if (tier === 1 || m.source === 'heatsync') return { cat, vis: { t: 'heatsync only', c: '#fff' } }
    return { cat, vis: { t: `${m.source || 'ext'} users`, c: '#ffd75f' } }
  }

  function showCycleTooltip(index, total, m) {
    // Create tooltip if needed
    if (!cycleTooltip) {
      cycleTooltip = document.createElement('div')
      cycleTooltip.id = 'heatsync-cycle-tooltip'
      cycleTooltip.style.cssText = `
        position: fixed;
        background: rgba(0, 0, 0, 0.95);
        color: #fff;
        padding: 4px 8px;
        border-radius: 0;
        font-size: 13px;
        font-family: inherit;
        z-index: 10000;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        opacity: 0;
        transition: opacity 0.15s;
        white-space: nowrap;
      `
      document.body.appendChild(cycleTooltip)
    }

    // Hide Twitch's native dropdown while cycling via body class
    document.body.classList.add('heatsync-cycling')

    // Update content — name + category + who-sees-it, built as nodes (no innerHTML).
    const label = (m && (m.isEmoji ? `${m.emoji} ${m.name}` : m.name)) || ''
    const meta = emoteCycleMeta(m)
    const mk = (text, css) => {
      const s = document.createElement('span')
      s.textContent = text
      if (css) s.style.cssText = css
      return s
    }
    const dot = () => mk(' · ', 'color:#555;')
    cycleTooltip.replaceChildren()
    cycleTooltip.appendChild(mk(`${index}/${total}`, 'color:#888;'))
    cycleTooltip.appendChild(mk(` ${label}`, 'color:#fff;'))
    if (meta.cat) {
      cycleTooltip.appendChild(dot())
      cycleTooltip.appendChild(mk(meta.cat, 'color:#9e9e9e;'))
    }
    if (meta.vis) {
      cycleTooltip.appendChild(dot())
      cycleTooltip.appendChild(mk(meta.vis.t, `color:${meta.vis.c};`))
    }
    if (cycleState.remotePending) {
      cycleTooltip.appendChild(dot())
      cycleTooltip.appendChild(mk('searching 7tv…', 'color:#ffd75f;'))
    }

    // Position above input
    const input = document.querySelector('[data-slate-editor="true"]')
    if (input) {
      const rect = input.getBoundingClientRect()
      cycleTooltip.style.left = `${rect.left}px`
      cycleTooltip.style.top = `${rect.top - 30}px`
    }

    // Show
    cycleTooltip.style.opacity = '1'

    // Auto-hide after 1.5s
    if (cycleTooltipTimeout) cleanup.clearTimeout(cycleTooltipTimeout)
    cycleTooltipTimeout = cleanup.setTimeout(() => {
      if (cycleTooltip) cycleTooltip.style.opacity = '0'
      // Restore dropdown visibility
      document.body.classList.remove('heatsync-cycling')
    }, 1500)
  }

  // Shared function to insert emote via Slate API (used by click and keydown handlers)
  // isCycling: if true, delete the last emote node instead of partial text
  function insertEmoteViaSlate(matchedEmote, inst, isCycling = false) {
    const slateEditor = inst?.chatInputRef?.state?.slateEditor
    if (!slateEditor) {
      log(' ⚠️ No Slate editor for insertion')
      return false
    }

    // Normalize URL - convert relative paths to absolute
    let emoteUrl = matchedEmote.url
    if (emoteUrl && (emoteUrl.startsWith('/uploads/') || emoteUrl.startsWith('/emotes/'))) {
      emoteUrl = `https://heatsync.org${emoteUrl}`
    }

    // Native Twitch emotes use real emote ID and CDN URLs
    const isNative = matchedEmote.native
    let emoteID, img1x, img2x, img4x
    if (isNative) {
      emoteID = matchedEmote.hash // Real Twitch emote ID
      const base = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteID}`
      img1x = `${base}/default/dark/1.0`
      img2x = `${base}/default/dark/2.0`
      img4x = `${base}/default/dark/3.0`
    } else {
      const innerId = matchedEmote.hash || matchedEmote.name
      emoteID = HEATSYNC_PREFIX + innerId + HEATSYNC_SUFFIX
      img1x = emoteUrl
      img2x = emoteUrl
      img4x = emoteUrl
      // Register the real URL so the img.src interceptor restores it after Twitch
      // rebuilds the <img> from this fake id — bridge-independent, so it fixes
      // broken tab-complete images for remote-search / unsynced emotes too.
      if (emoteUrl) {
        _insertedUrls.set(innerId, emoteUrl)
        if (_insertedUrls.size > 800) _insertedUrls.delete(_insertedUrls.keys().next().value)
      }
    }

    const emoteNode = {
      type: 'emote',
      emoteData: {
        type: 6,
        content: {
          images: {
            dark: { '1x': img1x, '2x': img2x, '4x': img4x },
            light: { '1x': img1x, '2x': img2x, '4x': img4x },
            themed: false,
          },
          alt: matchedEmote.name,
          // CRITICAL: Must match the ID format in fake emote set for Twitch to find it on re-render
          emoteID: emoteID,
        },
      },
      emoteName: matchedEmote.name,
      children: [{ text: '' }],
    }

    log(
      ' 🎯 Inserting emote via Slate:',
      matchedEmote.name,
      'URL:',
      emoteUrl.substring(0, 60),
      'hash:',
      matchedEmote.hash,
      isCycling ? '(cycling)' : '',
    )

    // Move to end
    const endPoint = slateEditor.end([])
    slateEditor.select(endPoint)

    // Get settings early for deletion behavior
    const settings = getExtensionSettings()
    const useWysiwyg = settings.emoteWysiwyg !== false // default true
    const addSpace = settings.emoteSpaceAfter !== false // default true
    log(' [autocomplete-hook] INSERTION - useWysiwyg:', useWysiwyg, 'addSpace:', addSpace, 'emote:', matchedEmote.name)

    if (isCycling) {
      if (useWysiwyg) {
        // FFZ-STYLE: Update the existing preview image directly instead of delete/insert
        // This prevents the flash because we're not destroying the DOM element
        const inputEl = document.querySelector('[data-slate-editor="true"]')
        const previewImg = inputEl?.querySelector('img.chat-line__message--emote, img[alt]')

        if (previewImg) {
          // Update the image directly for instant visual feedback
          previewImg.dataset.heatsyncFixed = 'true'
          previewImg.src = emoteUrl
          previewImg.alt = matchedEmote.name
          previewImg.dataset.emoteName = matchedEmote.name
          if (previewImg.srcset) {
            previewImg.srcset = `${emoteUrl} 1x`
          }

          // CRITICAL: Also update the Slate node data so correct emote is sent
          // Find the LAST emote node (the one just before cursor) instead of first
          const findLastEmotePath = (nodes, path = []) => {
            let lastEmotePath = null
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i]
              if (node.type === 'emote') {
                lastEmotePath = [...path, i]
              }
              if (node.children) {
                const found = findLastEmotePath(node.children, [...path, i])
                if (found) lastEmotePath = found
              }
            }
            return lastEmotePath
          }

          const emotePath = findLastEmotePath(slateEditor.children)
          if (emotePath) {
            // Update the emote node properties using Slate's apply
            const newEmoteData = {
              type: 6,
              content: {
                images: {
                  dark: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
                  light: { '1x': emoteUrl, '2x': emoteUrl, '4x': emoteUrl },
                  themed: false,
                },
                alt: matchedEmote.name,
                emoteID: HEATSYNC_PREFIX + (matchedEmote.hash || matchedEmote.name) + HEATSYNC_SUFFIX,
              },
            }

            try {
              slateEditor.apply({
                type: 'set_node',
                path: emotePath,
                properties: {},
                newProperties: {
                  emoteData: newEmoteData,
                  emoteName: matchedEmote.name,
                },
              })
              log(' 🔄 FFZ-style: Updated Slate node for', matchedEmote.name)
            } catch (err) {
              log(' ⚠️ set_node failed:', err.message)
            }
          }

          return true
        }

        // Fallback: delete and re-insert if no preview found
        log(' ⚠️ No preview image found, falling back to delete/insert')
        try {
          const endPt = slateEditor.end([])
          slateEditor.select(endPt)

          // Delete trailing space/ZWS
          slateEditor.deleteBackward('character')

          // Delete the emote void element (Slate treats voids as single units)
          slateEditor.deleteBackward('character')

          log(' 🗑️ Deleted emote + trailing char for cycling')
        } catch (err) {
          log(' ❌ Error deleting for cycling:', err.message)
        }
      } else {
        // Text mode cycling: delete the previous emote text + optional space
        const prevEmote = cycleState.lastCycledEmote
        if (prevEmote) {
          const deleteLen = prevEmote.length + (addSpace ? 1 : 0)
          for (let i = 0; i < deleteLen; i++) {
            slateEditor.deleteBackward('character')
          }
          log(' 🗑️ Deleted text emote for cycling:', prevEmote, `(${deleteLen} chars)`)
        }
      }
    } else {
      // Delete partial text (the search term like ":kap" or "kap")
      // Try multiple methods to get current input value
      let currentValue = inst.hsGetValue?.() || inst.ffzGetValue?.() || ''

      // Fallback: get from DOM if inst methods don't work
      if (!currentValue) {
        const inputEl = getInputElement()
        if (inputEl) {
          currentValue = inputEl.textContent || ''
        }
      }

      log(' 🔍 Deleting partial text, currentValue:', JSON.stringify(currentValue))

      const matchResult = currentValue.match(/(:?\w+)$/)
      const partialText = matchResult ? matchResult[0] : ''

      log(' 🔍 partialText to delete:', JSON.stringify(partialText), 'length:', partialText.length)

      if (partialText && partialText.length > 0) {
        // Move cursor to end first
        const endPt = slateEditor.end([])
        slateEditor.select(endPt)

        for (let i = 0; i < partialText.length; i++) {
          slateEditor.deleteBackward('character')
        }
        log(' 🗑️ Deleted', partialText.length, 'chars of partial text')
      }
    }

    // Insert emote based on WYSIWYG setting
    if (useWysiwyg) {
      // Insert emote node as inline void element (WYSIWYG mode)
      log(' [autocomplete-hook] WYSIWYG MODE - Inserting emote node for:', matchedEmote.name)
      slateEditor.insertNode(emoteNode)

      // After emote, insert space using Slate apply (like 7TV does)
      if (addSpace) {
        // Prefer insertText — it routes through the editor's selection
        // and keeps the cursor positioned correctly after the void node.
        let inserted = false
        try {
          slateEditor.select(slateEditor.end([]))
          slateEditor.insertText(' ')
          inserted = true
          log(' 📝 Inserted trailing space via insertText')
        } catch (err) {
          log(' ⚠️ insertText space failed:', err.message)
        }
        // Fallback: low-level apply (works when selection is across a void boundary)
        if (!inserted) {
          try {
            const point = slateEditor.end([])
            slateEditor.apply({
              type: 'insert_text',
              path: point.path,
              offset: point.offset,
              text: ' ',
            })
            log(' 📝 Inserted trailing space via Slate apply (fallback)')
          } catch (err) {
            log(' ❌ Slate apply space failed:', err.message)
          }
        }
      }
    } else {
      // Insert emote name as text only (text mode) - include space in text
      const textToInsert = addSpace ? `${matchedEmote.name} ` : matchedEmote.name
      log(' [autocomplete-hook] TEXT MODE - Inserting text:', textToInsert)

      slateEditor.insertText(textToInsert)
      log(' [autocomplete-hook] TEXT MODE - insertText() completed')
    }

    // Move cursor to absolute end
    const afterEmotePoint = slateEditor.end([])
    slateEditor.select(afterEmotePoint)

    // Add to recently inserted set - getMatches will skip exact matches
    // This prevents Twitch's polluted state from inserting wrong emotes
    recentlyInserted.add(matchedEmote.name)
    // Single recording authority (both the dropdown path and the Tab-cycle
    // path insert through here). A cycle step REPLACES the previous candidate
    // in the input, so its bump moves with it; a fresh insert never unbumps
    // (the prior word's emote is committed).
    if (isCycling && _frecSessionBumped && _frecSessionBumped !== matchedEmote.name) {
      unbumpEmoteFrecency(_frecSessionBumped)
    }
    // record unless a cycle wrapped back onto the emote it already credited
    if (!isCycling || _frecSessionBumped !== matchedEmote.name) recordRecentEmoteMru(matchedEmote.name)
    _frecSessionBumped = matchedEmote.name
    // Remote 7TV catalog hit — register for auto-add-on-send (flushed on Enter)
    trackRemoteCompletion(matchedEmote)
    insertionCount++

    // Limit set size to prevent memory leaks (keep last 10)
    if (recentlyInserted.size > 100) recentlyInserted.clear()

    log(' ✅ Slate emote inserted:', matchedEmote.name, 'insertion #', insertionCount)
    return true
  }

  // Keydown handler for Tab in autocomplete dropdown (Tab only, Enter never touched)
  let documentKeyHandlerInstalled = false
  function installAutocompleteKeyHandler() {
    if (documentKeyHandlerInstalled) return
    documentKeyHandlerInstalled = true

    // Use WINDOW-level handler (not document) to fire before any other listeners
    // Use CAPTURE phase to fire before Twitch's handlers
    log('🎯 Installing window keydown handler')
    window.addEventListener(
      'keydown',
      (e) => {
        // ONLY intercept Tab. NEVER touch Enter — let Twitch handle sending.
        // Enter is passively OBSERVED (capture fires before Twitch clears the
        // input) to flush remote-completion auto-add; the event is untouched.
        if (e.key === 'Enter' && !e.shiftKey && _remoteCompletions.size) {
          const enterInput = getInputElement()
          if (enterInput && (enterInput.contains(e.target) || e.target === enterInput)) {
            try {
              flushRemoteCompletionsOnSend(enterInput)
            } catch (_) {}
          }
          return
        }
        if (e.key !== 'Tab') return
        log('🔑 TAB PRESSED! target:', e.target?.tagName, e.target?.className)

        // Check if we're in the chat input
        const inputEl = getInputElement()
        if (!inputEl) {
          log(' ⌨️ No input element found')
          return
        }
        const isInInput = inputEl.contains(e.target) || e.target === inputEl
        if (!isInInput) {
          // Don't steal focus from multichat or other heatsync inputs
          const tgt = e.target
          if (tgt?.id === 'hs-mc-input' || tgt?.closest?.('#hs-mc-overlay') || tgt?.closest?.('#hs-mc-inputbar')) {
            return // Let multichat handle its own Tab
          }
          // Tab when not in any input = focus Twitch input
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault()
            inputEl.focus()
            return
          }
          return
        }

        log(' ⌨️ Key pressed:', e.key, 'shiftKey:', e.shiftKey)

        // CRITICAL: Tab should NEVER exit the input box (but let event propagate for completion)
        if (e.key === 'Tab') {
          e.preventDefault() // Stop focus from leaving input
          // Don't stopPropagation - Twitch needs the event for autocomplete
        }

        // TAB CYCLING: If we recently inserted an emote and have multiple matches,
        // cycle through them even if Twitch's dropdown is closed
        if (e.key === 'Tab' && !e.shiftKey) {
          let hasMultipleMatches = cycleState.matches.length > 1

          // Check if Twitch's dropdown is NOT visible (we need to handle cycling ourselves)
          const dropdown =
            document.querySelector('[class*="chat-autocomplete"]') || document.querySelector('[role="listbox"]')
          const dropdownVisible = dropdown && dropdown.offsetParent !== null

          // CRITICAL: Detect if user typed NEW text after last emote
          // If so, this is a new completion, NOT a cycle continuation
          if (cycleState.lastCycledEmote) {
            const inputEditor = document.querySelector('[data-slate-editor="true"]')
            if (inputEditor) {
              // Check if there are ANY emote images in the input
              const emoteImgs = inputEditor.querySelectorAll('.chat-line__message--emote, img[alt]')
              // Also check for text mode (emote name as text, not image)
              const inputText = inputEditor.textContent || ''
              const textContainsEmote = inputText.includes(cycleState.lastCycledEmote)

              if (emoteImgs.length === 0 && !textContainsEmote) {
                // No emotes in input (image or text) - user must have deleted it
                log(' 🔄 No emote in input - resetting cycle state')
                cycleState.lastCycledEmote = null
              } else if (textContainsEmote) {
                // TEXT MODE: Emote exists as text, continue cycling
                log(' 🔄 Text mode: emote found as text, continuing cycle')
              } else {
                // Check if the last cycled emote is still in the input (by alt text)
                const emoteStillExists = Array.from(emoteImgs).some((img) => img.alt === cycleState.lastCycledEmote)
                if (!emoteStillExists) {
                  log(' 🔄 Last cycled emote not found in input - resetting cycle state')
                  cycleState.lastCycledEmote = null
                } else {
                  // WYSIWYG mode: Check if text was typed AFTER the last emote image in DOM
                  // (textContent won't contain emote names, so we use DOM traversal)
                  const lastEmoteImg = Array.from(emoteImgs)
                    .reverse()
                    .find((img) => img.alt === cycleState.lastCycledEmote)
                  if (lastEmoteImg) {
                    // Walk siblings after the emote's container to find text
                    const container = lastEmoteImg.closest('[data-slate-node]') || lastEmoteImg.parentElement
                    let textAfter = ''
                    let sibling = container?.nextSibling
                    while (sibling) {
                      if (sibling.nodeType === Node.TEXT_NODE) {
                        textAfter += sibling.textContent || ''
                      } else if (sibling.textContent) {
                        textAfter += sibling.textContent
                      }
                      sibling = sibling.nextSibling
                    }
                    const cleanAfter = textAfter.replace(/[\s\u200b\ufeff]/g, '')
                    if (cleanAfter.length >= 2) {
                      log(' 🔄 New text detected after emote (DOM walk):', cleanAfter, '- resetting cycle')
                      cycleState.lastCycledEmote = null
                    }
                  }
                }
              }
            }
          }

          // CRITICAL: Check if current input matches stored search term
          // If not, we have stale matches from a previous search - reset!
          const currentInputText = inputEl.textContent || ''
          const currentSearch = currentInputText.trim().toLowerCase().split(/\s+/).pop() || ''
          const searchMatches =
            cycleState.searchTerm &&
            (currentSearch.includes(cycleState.searchTerm) || cycleState.searchTerm.includes(currentSearch))

          // Build or rebuild matches: either stale (new search term) or empty (first Tab)
          // Skip rebuild if actively cycling (lastCycledEmote set) — input contains the inserted emote, not search text
          const justCycledCheck = cycleState.lastCycledEmote !== null
          if (!justCycledCheck && (!hasMultipleMatches || !searchMatches) && currentSearch.length >= 2) {
            log(
              ' 🔄 Current input "' +
                currentSearch +
                '" doesn\'t match stored "' +
                cycleState.searchTerm +
                '" - rebuilding matches',
            )
            // Build fresh matches for current input (bridge + native Twitch sub emotes)
            const hsEmotes = getAllEmotesForCycling()
            const matches = []
            // Strip leading colon for emoji shortcode search
            const emojiSearch = currentSearch.startsWith(':') ? currentSearch.slice(1) : null
            const emoteSearch = emojiSearch || currentSearch
            // No iteration cap: sub emotes live at the tail of hsEmotes (bridge-first ordering),
            // so any cap silently hides them once the user has many custom emotes that match.
            // Substring-scanning ~5k names is sub-millisecond; correctness > micro-perf.
            for (const em of hsEmotes) {
              if (em.nameLower?.startsWith(emoteSearch)) {
                em._isPrefix = true
                matches.push(em)
              } else if (em.nameLower?.includes(emoteSearch)) {
                em._isPrefix = false
                matches.push(em)
              }
            }
            // Add emoji shortcode matches when searching with :prefix. tier 9 keeps emoji
            // below all emotes (own/channel/global), preserving "emotes first, then emoji".
            if (emojiSearch && emojiSearch.length >= 2) {
              let n = 0
              for (const [name, emoji] of EMOJI_ENTRIES) {
                if (name.startsWith(emojiSearch)) {
                  matches.push({
                    name: `:${name}:`,
                    nameLower: name,
                    isEmoji: true,
                    emoji,
                    tier: 9,
                    _isPrefix: true,
                  })
                  n++
                } else if (name.includes(emojiSearch)) {
                  matches.push({
                    name: `:${name}:`,
                    nameLower: name,
                    isEmoji: true,
                    emoji,
                    tier: 9,
                    _isPrefix: false,
                  })
                  n++
                }
                if (n >= 20) break
              }
            }
            // Same ranking as everywhere else (input.js compareAcMatches / the
            // getMatches sort above): full-name exact match beats everything
            // UNCONDITIONALLY, then used-before (frecency — "kko" → your KKona,
            // never the channel's untouched KKonaLand), then never-used by tier
            // (channel culture, emoji last) > prefix > substring > sub emote;
            // shorter > alpha tail.
            const frecCyc = readEmoteFrecency()
            matches.sort((a, b) => {
              const at = a.tier ?? 2,
                bt = b.tier ?? 2
              const ae = a.nameLower === emoteSearch,
                be = b.nameLower === emoteSearch
              if (ae !== be) return ae ? -1 : 1
              const af = frecCyc.get(a.name || '') || 0,
                bf = frecCyc.get(b.name || '') || 0
              if (af > 0 !== bf > 0) return af > 0 ? -1 : 1
              if (af > 0) {
                // both used — typed prefix first, then habit strength, then tier
                if (a._isPrefix !== b._isPrefix) return a._isPrefix ? -1 : 1
                if (af !== bf) return bf - af
                if (at !== bt) return at - bt
              } else {
                // neither used — tier outranks match-type so a channel substring
                // match beats a global prefix match ("hug" → peepoHug over "HuG")
                if (at !== bt) return at - bt
                if (a._isPrefix !== b._isPrefix) return a._isPrefix ? -1 : 1
                const aSub = a.sub ? 0 : 1,
                  bSub = b.sub ? 0 : 1
                if (aSub !== bSub) return aSub - bSub
              }
              const la = (a.name || '').length,
                lb = (b.name || '').length
              if (la !== lb) return la - lb
              return (a.name || '').localeCompare(b.name || '')
            })
            // Recent-chatter lead: a chatter who just talked and whose name
            // prefix-matches leads the cycle above all emotes (parity with the
            // overlay). Bare word only; inserted as the plain name. Source: content.js
            // via the DOM bridge, already newest-first + time-windowed. Inserted PLAIN
            // (no @) — respect what the user typed; they didn't type @.
            let cycleFinal = matches
            if (!emojiSearch && !currentSearch.startsWith('@')) {
              const recentChatters = []
              for (const c of getRecentChattersFromBridge()) {
                if (c.l?.startsWith(emoteSearch)) {
                  recentChatters.push({ name: c.name, nameLower: c.l, isUser: true })
                }
              }
              if (recentChatters.length) cycleFinal = recentChatters.concat(matches)
            }
            cycleState.matches = cycleFinal
            cycleState.searchTerm = currentSearch
            cycleState.index = 0
            cycleState.lastCycledEmote = null
            cycleState.localCount = cycleFinal.length
            cycleState.remoteFetched = false
            cycleState.remotePending = false
            cycleState._remotePage = 0
            cycleState._aiSeq = 0
            hasMultipleMatches = cycleState.matches.length > 1
            // Lazy 7TV: with ≥2 local matches, DON'T hit the catalog yet — it fires
            // once you cycle near the last local match (see the advance branch). A
            // word with ≤1 local match still searches immediately: it's the only way
            // to complete a non-owned emote, and native cycling needs ≥2 entries to
            // even engage (so a lone local could otherwise never reach the catalog).
            if (!emojiSearch && cycleFinal.length <= 1) {
              fetch7tvCycleMatches(currentSearch)
            }
            log(' 🔄 Rebuilt', cycleState.matches.length, `matches for "${currentSearch}"`)
          }

          // Allow cycling if:
          // - Multiple matches exist AND
          // - Either: emote was already inserted (justCycled), OR no dropdown visible, OR matches include emojis
          const justCycled = cycleState.lastCycledEmote !== null
          const hasEmojiMatches = cycleState.matches.some((m) => m.isEmoji)
          const shouldCycle = hasMultipleMatches && (justCycled || !dropdownVisible || hasEmojiMatches)

          log(' 🔍 Tab pressed - cycling check:', {
            hasMultipleMatches,
            matchCount: cycleState.matches.length,
            justCycled,
            dropdownVisible,
            shouldCycle,
            searchTerm: cycleState.searchTerm,
          })

          if (shouldCycle) {
            e.preventDefault()
            e.stopPropagation()
            e.stopImmediatePropagation()

            // On FIRST Tab (justCycled false): insert first match (index 0)
            // On subsequent Tabs: cycle to the next match.
            if (justCycled) {
              const atEnd = cycleState.index + 1 >= cycleState.matches.length
              // Could more 7TV catalog hits still arrive? (a fetch is in flight,
              // or the catalog isn't exhausted for a fetchable term). If so, DON'T
              // wrap to the top on reaching the end — the user asked to keep
              // cycling into 7tv (13/13 → 14/99), not loop back to 1.
              const remoteMayCome =
                cycleState.remotePending ||
                (!cycleState.remoteFetched &&
                  cycleState.searchTerm &&
                  cycleState.searchTerm.length >= 2 &&
                  !cycleState.searchTerm.startsWith(':') &&
                  !cycleState.searchTerm.startsWith('@'))
              if (atEnd && remoteMayCome) {
                // Kick off (or keep waiting on) the next catalog page and HOLD
                // here — the current emote stays inserted; the next Tab, once
                // results have appended + re-sorted (preserving this position),
                // advances into 14/99 instead of looping back to 1.
                if (!cycleState.remoteFetched && !cycleState.remotePending) {
                  fetch7tvCycleMatches(cycleState.searchTerm)
                }
                cycleState.lastTime = now
                showCycleTooltip(cycleState.index + 1, cycleState.matches.length, cycleState.matches[cycleState.index])
                return
              }
              cycleState.index = atEnd ? 0 : cycleState.index + 1
            } else {
              cycleState.index = 0 // First Tab - start at first match
            }
            const nextEmote = cycleState.matches[cycleState.index]
            cycleState.lastTime = now

            log(
              ' ⌨️ Manual Tab cycling:',
              cycleState.index + 1,
              '/',
              cycleState.matches.length,
              '→',
              nextEmote.name,
              justCycled ? '(cycling)' : '(first)',
            )
            showCycleTooltip(cycleState.index + 1, cycleState.matches.length, nextEmote)
            // Lazy 7TV pre-fetch: fire as soon as you cycle WITHIN LOOKAHEAD of
            // the end of the current list, so the next catalog page is usually
            // merged by the Tab that needs it (the end-of-list hold above is the
            // fallback if you out-tab the fetch). Each approach to the merged
            // end pulls one more page until the catalog is exhausted or the
            // cycle hits its size cap.
            if (
              justCycled &&
              !cycleState.remoteFetched &&
              !cycleState.remotePending &&
              cycleState.index >= cycleState.matches.length - 1 - HS_REMOTE_LOOKAHEAD
            ) {
              fetch7tvCycleMatches(cycleState.searchTerm)
            }

            const inst = chatInputInst || findChatInput()
            if (!inst) {
              log(' ❌ Manual Tab cycling failed - no chat input found')
              return
            }

            // Text cycling — emoji shortcode (insert the emoji char) or a recent
            // chatter (insert the @mention). Both are plain text, same delete/
            // insert path; emotes (void Slate nodes) go through insertEmoteViaSlate.
            if (nextEmote.isEmoji || nextEmote.isUser) {
              const insertStr = nextEmote.isEmoji ? nextEmote.emoji : nextEmote.name
              const slateEditor = inst?.chatInputRef?.state?.slateEditor
              const settings = getExtensionSettings()
              const addSpace = settings.emoteSpaceAfter !== false
              if (slateEditor) {
                const endPt = slateEditor.end([])
                slateEditor.select(endPt)
                if (justCycled) {
                  // Delete previous emoji + space (use spread for accurate grapheme count)
                  const prevEmoji = cycleState.lastCycledEmote
                  const graphemeLen = prevEmoji ? [...prevEmoji].length : 0
                  const deleteLen = graphemeLen + (addSpace ? 1 : 0)
                  for (let i = 0; i < deleteLen; i++) {
                    slateEditor.deleteBackward('character')
                  }
                } else {
                  // Delete the search text (e.g., ":sunr")
                  const inputText = inputEl.textContent || ''
                  const matchResult = inputText.match(/(:?\w+)$/)
                  const partialText = matchResult ? matchResult[0] : ''
                  for (let i = 0; i < partialText.length; i++) {
                    slateEditor.deleteBackward('character')
                  }
                }
                slateEditor.insertText(insertStr + (addSpace ? ' ' : ''))
                cycleState.lastCycledEmote = insertStr
                const focusEl = getInputElement()
                if (focusEl) focusEl.focus()
                log(' ✅ Emoji cycle complete:', nextEmote.name, '→', nextEmote.emoji)
              } else {
                // Slate unavailable — fall back to execCommand for contenteditable
                const inputEl2 = getInputElement()
                if (inputEl2) {
                  inputEl2.focus()
                  if (justCycled) {
                    const prevEmoji = cycleState.lastCycledEmote
                    const deleteLen = prevEmoji ? [...prevEmoji].length + (addSpace ? 1 : 0) : 0
                    for (let i = 0; i < deleteLen; i++) document.execCommand('delete', false)
                  } else {
                    const inputText = inputEl2.textContent || ''
                    const matchResult = inputText.match(/(:?\w+)$/)
                    const partialLen = matchResult ? matchResult[0].length : 0
                    for (let i = 0; i < partialLen; i++) document.execCommand('delete', false)
                  }
                  document.execCommand('insertText', false, insertStr + (addSpace ? ' ' : ''))
                  cycleState.lastCycledEmote = insertStr
                  log(' ✅ Emoji cycle via execCommand:', nextEmote.name, '→', nextEmote.emoji)
                }
              }
              return
            }

            // CRITICAL: Pass justCycled - first Tab deletes search text, subsequent Tabs update existing emote
            if (insertEmoteViaSlate(nextEmote, inst, justCycled)) {
              // Track cycled emote to detect suffix pollution (e.g., "Cool" from "KappaCool")
              cycleState.lastCycledEmote = nextEmote.name
              // Add to recently inserted (frecency/MRU recording happens inside
              // insertEmoteViaSlate — recording here too double-bumped every cycle step)
              recentlyInserted.add(nextEmote.name)
              if (recentlyInserted.size > 100) recentlyInserted.clear()
              // CRITICAL: Refocus input to ensure next Tab is captured
              const inputEl2 = getInputElement()
              if (inputEl2) {
                inputEl2.focus()
              }
              log(' ✅ Cycle complete, justCycled now:', cycleState.lastCycledEmote)
              return
            }
          }

          // No emote-match → fall through to Twitch's native Tab handling
          // (covers @user completion via Twitch's own chatter list).
        }

        // SHIFT+TAB CYCLING: Cycle backwards through matches
        if (e.key === 'Tab' && e.shiftKey) {
          const hasMultipleMatches = cycleState.matches.length > 1
          const justCycled = cycleState.lastCycledEmote !== null

          if (hasMultipleMatches && justCycled) {
            e.preventDefault()
            e.stopPropagation()
            e.stopImmediatePropagation()

            // Cycle backwards (wrap around)
            cycleState.index = (cycleState.index - 1 + cycleState.matches.length) % cycleState.matches.length
            const prevEmote = cycleState.matches[cycleState.index]
            cycleState.lastTime = Date.now()

            log(
              ' ⌨️ Shift+Tab cycling backwards:',
              cycleState.index + 1,
              '/',
              cycleState.matches.length,
              '→',
              prevEmote.name,
            )
            showCycleTooltip(cycleState.index + 1, cycleState.matches.length, prevEmote)

            const inst = chatInputInst || findChatInput()
            if (!inst) {
              log(' ❌ Shift+Tab cycling failed - no chat input found')
              return
            }

            // Emoji shortcode backwards cycling
            if (prevEmote.isEmoji) {
              const slateEditor = inst?.chatInputRef?.state?.slateEditor
              if (slateEditor) {
                const settings = getExtensionSettings()
                const addSpace = settings.emoteSpaceAfter !== false
                const endPt = slateEditor.end([])
                slateEditor.select(endPt)
                const prevEmoji = cycleState.lastCycledEmote
                const graphemeLen = prevEmoji ? [...prevEmoji].length : 0
                const deleteLen = graphemeLen + (addSpace ? 1 : 0)
                for (let i = 0; i < deleteLen; i++) {
                  slateEditor.deleteBackward('character')
                }
                slateEditor.insertText(prevEmote.emoji + (addSpace ? ' ' : ''))
                cycleState.lastCycledEmote = prevEmote.emoji
                const focusEl = getInputElement()
                if (focusEl) focusEl.focus()
                log(' ✅ Backwards emoji cycle complete:', prevEmote.name)
                return
              }
            }

            if (insertEmoteViaSlate(prevEmote, inst, true)) {
              cycleState.lastCycledEmote = prevEmote.name
              recentlyInserted.add(prevEmote.name)
              if (recentlyInserted.size > 100) recentlyInserted.clear()
              const focusEl = getInputElement()
              if (focusEl) focusEl.focus()
              log(' ✅ Backwards cycle complete')
              return
            }
          }
        }

        // Check if autocomplete dropdown is visible (Tab only from here)
        const dropdown =
          document.querySelector('[class*="chat-autocomplete"]') ||
          document.querySelector('[class*="Autocomplete"]') ||
          document.querySelector('[role="listbox"]')

        if (!dropdown) {
          // No dropdown visible - Tab already prevented above, just return
          log(' 🔍 No dropdown found, returning')
          return
        }
        log(' 🔍 Dropdown found:', dropdown.className)

        // Check if dropdown is actually visible (not just in DOM)
        // Use OR - if EITHER condition indicates hidden, let Tab through
        const isHidden =
          dropdown.offsetParent === null ||
          dropdown.style.display === 'none' ||
          dropdown.style.visibility === 'hidden' ||
          dropdown.style.opacity === '0' ||
          getComputedStyle(dropdown).display === 'none'
        if (isHidden) {
          log(' 🔍 Dropdown exists but hidden, letting Tab through')
          return
        }

        // Find highlighted/selected item with our emote image
        const highlighted =
          dropdown.querySelector('[aria-selected="true"]') ||
          dropdown.querySelector('[class*="selected"]') ||
          dropdown.querySelector('[class*="highlighted"]') ||
          dropdown.querySelector('[data-highlighted="true"]')

        // Look for our emote in highlighted item or first item if nothing highlighted
        const targetItem = highlighted || dropdown.querySelector('[role="option"]')

        if (!targetItem) return

        const img = targetItem.querySelector('img')
        const itemText = targetItem.textContent?.trim()

        if (!img) return

        const src = img.src || img.srcset || ''
        log(' 🔍 Tab - img src:', src.substring(0, 80))
        if (!src.includes('betterttv') && !src.includes('7tv') && !src.includes('frankerfacez')) {
          // Not our emote, let Twitch handle it
          log(' 🔍 Tab - img not heatsync emote, letting Twitch handle')
          return
        }

        // Find which emote this is
        const hsEmotes = getHeatsyncEmotes()
        const matchedEmote = hsEmotes.find((em) => itemText?.includes(em.name) || src.includes(em.hash))

        if (!matchedEmote) {
          return
        }

        log(' ⌨️ Tab on our emote:', matchedEmote.name)

        // Prevent Twitch's handler
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        // Insert via Slate
        const inst = chatInputInst || findChatInput()
        if (insertEmoteViaSlate(matchedEmote, inst)) {
          // Close dropdown by clicking elsewhere
          const focusEl = getInputElement()
          if (focusEl) focusEl.focus()
        }
      },
      { capture: true, signal: acSignal },
    ) // Capture phase

    log(' ✅ Autocomplete key handler installed (Tab only, Enter never touched)')
  }

  // Click handler for autocomplete items (Twitch can't resolve our fake IDs)
  function installAutocompleteClickHandler() {
    // Use capturing to intercept before Twitch's handler
    document.addEventListener(
      'click',
      (e) => {
        // Debug: log all clicks to see structure
        const target = e.target
        const parent = target.parentElement
        const _grandparent = parent?.parentElement

        // CRITICAL: Ignore clicks inside heatsync panel (import button, settings, etc)
        if (target.closest('#heatsync-panel') || target.closest('.heatsync-panel')) {
          return
        }

        // CRITICAL: Ignore clicks inside the multichat overlay — its emote picker
        // renders bttv/7tv/ffz imgs that pass the src check below, and the
        // closest('div[class*="Layout"]') item fallback resolves to the whole
        // twitch chat column the overlay sits in. Without this bail the
        // preventDefault + stopImmediatePropagation below eats the picker's own
        // click delegate (dead click) and mis-inserts into twitch's hidden
        // native input. Multichat owns every click inside its DOM.
        if (target.closest('[id^="hs-mc-"], [class*="hs-mc-"]')) {
          return
        }

        // CRITICAL: Ignore clicks on emotes already in the input field (not dropdown)
        const isInInputField =
          e.target.closest('.chat-wysiwyg-input__editor') ||
          e.target.closest('[data-slate-editor="true"]') ||
          e.target.closest('[data-slate-node="element"]')
        if (isInInputField) {
          log(' 🔍 Click is in input field, ignoring')
          return
        }

        // CRITICAL: Ignore clicks on emote stacks/wrappers in chat - let content.js handle
        const isInEmoteStack = e.target.closest('.heatsync-emote-stack')
        const isInChatMessage =
          e.target.closest('.chat-line__message') || e.target.closest('[class*="chat-scrollable"]')
        if (isInEmoteStack || (isInChatMessage && e.target.closest('.heatsync-emote-wrapper'))) {
          log(' 🔍 Click is on chat emote/stack, letting content.js handle')
          return
        }

        // CRITICAL: Ignore ALL clicks in chat message area (not autocomplete dropdown)
        // This prevents blank space clicks from triggering emote insertion
        if (isInChatMessage) {
          log(' 🔍 Click is in chat message area, ignoring')
          return
        }

        // Check if click is in autocomplete dropdown - try multiple selectors
        const autocomplete =
          e.target.closest('[class*="chat-autocomplete"]') ||
          e.target.closest('[class*="autocomplete"]') ||
          e.target.closest('[role="listbox"]') ||
          e.target.closest('[class*="Autocomplete"]')

        // Only look for emote images when inside autocomplete dropdown
        // DO NOT use querySelector fallback outside dropdowns - it catches nearby emotes on blank space clicks
        let img = null
        if (autocomplete) {
          // Inside autocomplete: can use querySelector to find emote in clicked item
          img = target.tagName === 'IMG' ? target : target.querySelector('img') || parent?.querySelector('img')
        } else {
          // Outside autocomplete: ONLY direct clicks on img elements
          img = target.tagName === 'IMG' ? target : null
        }

        if (!autocomplete && !img) {
          // Not in autocomplete and didn't click directly on an img
          return
        }

        // Check if this looks like an autocomplete click (has emote image with our URL)
        if (img) {
          const src = img.src || img.srcset || ''
          if (src.includes('betterttv') || src.includes('7tv') || src.includes('frankerfacez')) {
            log(' 🔍 Click on BTTV/7TV/FFZ img:', {
              target: `${target.tagName}.${target.className?.split(' ')[0]}`,
              inAutocomplete: !!autocomplete,
              imgSrc: src.substring(0, 60),
            })
          } else {
            // Not our emote
            return
          }
        } else if (!autocomplete) {
          return
        }

        // Find the clicked suggestion item - try multiple selectors
        const item =
          e.target.closest('[role="option"]') ||
          e.target.closest('[class*="suggestion"]') ||
          e.target.closest('[class*="Suggestion"]') ||
          e.target.closest('[data-test-selector*="emote"]') ||
          (img ? img.closest('div[class*="Layout"]') : null)
        if (!item) {
          log(' 🔍 No item found for click')
          return
        }

        // Check if this item has our emote (look for FFZ marker in img src or item text)
        const itemImg = item.querySelector('img') || img
        const itemText = item.textContent?.trim()
        const hsEmotes = getHeatsyncEmotes()

        // Match by image URL (most reliable)
        let matchedEmote = null
        if (itemImg) {
          const src = itemImg.src || itemImg.srcset || ''
          for (const emote of hsEmotes) {
            if (src.includes(emote.hash) || src.includes(encodeURIComponent(emote.url))) {
              matchedEmote = emote
              break
            }
          }
        }

        // Fallback: match by text content
        if (!matchedEmote && itemText) {
          matchedEmote = hsEmotes.find((e) => itemText.includes(e.name))
        }

        if (!matchedEmote) return

        log(' 🖱️ Intercepted click on our emote:', matchedEmote.name)

        // Prevent Twitch's handler - it won't create preview for our fake IDs
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        const inst = chatInputInstance || findChatInput()
        if (!inst) {
          return
        }

        // Use shared Slate insertion function
        if (insertEmoteViaSlate(matchedEmote, inst)) {
          const inputEl = getInputElement()
          if (inputEl) inputEl.focus()
          return
        }

        // Fallback: Use insertReplacement for text insertion
        const autocompleteInput = inst.autocompleteInputRef
        if (autocompleteInput && typeof autocompleteInput.insertReplacement === 'function') {
          const currentValue = inst.hsGetValue?.() || inst.ffzGetValue?.() || ''
          const matchResult = currentValue.match(/(:?\w+)$/)
          const current = matchResult ? matchResult[0] : ''

          log(' 🎯 Using insertReplacement fallback:', {
            replacement: matchedEmote.name,
            current: current,
          })

          autocompleteInput.insertReplacement({
            current: current,
            replacement: matchedEmote.name,
          })

          const inputEl = getInputElement()
          if (inputEl) inputEl.focus()
          return
        }

        log(' ⚠️ No insertion method found')
      },
      { capture: true, signal: acSignal },
    ) // Capture phase but don't prevent propagation

    log(' ✅ Autocomplete click handler installed')
  }

  // MutationObserver to fix heatsync emote images in input (FFZ-style)
  let imageObserver = null
  function installImageObserver() {
    if (imageObserver) return

    const chatInputContainer =
      document.querySelector('[data-a-target="chat-input"]')?.closest('.chat-input') ||
      document.querySelector('.chat-input') ||
      document.querySelector('[class*="chat-input"]')

    // Don't install yet if chat input isn't mounted — falling back to
    // document.body subtree+childList here would fire on every chat-line
    // mutation (~10-50/sec on Twitch). Retry shortly.
    if (!chatInputContainer) {
      cleanup.setTimeout(installImageObserver, 500, 'autocomplete-image-retry')
      return
    }

    imageObserver = cleanup.trackObserver(
      new MutationObserver((mutations) => {
        for (const mut of mutations) {
          // Skip mutations outside chat input area and autocomplete dropdowns
          const target = mut.target
          if (
            chatInputContainer &&
            !chatInputContainer.contains(target) &&
            !target.closest?.('[class*="autocomplete"]') &&
            !target.closest?.('[data-a-target*="emote"]')
          )
            continue
          // Check added nodes
          for (const node of mut.addedNodes) {
            if (node instanceof Element) {
              // FFZ-style: Check for input preview elements
              const previewSpan = node.matches?.('[data-a-target="chat-input-emote-preview"]')
                ? node
                : node.querySelector?.('[data-a-target="chat-input-emote-preview"]')
              if (previewSpan) {
                log(' 🎯 Found input preview span!', previewSpan)
                const previewImg = previewSpan.querySelector('img')
                if (previewImg) {
                  log(' 🖼️ Preview img src:', previewImg.src?.substring(0, 80))
                  fixEmoteImage(previewImg)
                }
              }

              // Also check for emote images in input area
              const inputPreviewImg = node.matches?.('img.chat-line__message--emote')
                ? node
                : node.querySelector?.('img.chat-line__message--emote')
              if (inputPreviewImg) {
                log(' 🎯 Found input emote img:', inputPreviewImg.src?.substring(0, 80))
                fixEmoteImage(inputPreviewImg)
              }

              // Debug: log autocomplete-related elements
              if (
                node.className?.includes?.('autocomplete') ||
                node.closest?.('[class*="autocomplete"]') ||
                node.querySelector?.('img')
              ) {
                log(' 🔍 MutationObserver saw:', node.tagName, node.className)
              }
              checkForHeatsyncImages(node)
            }
          }
          // Also check attribute changes (src or srcset being set)
          if (
            mut.type === 'attributes' &&
            (mut.attributeName === 'src' || mut.attributeName === 'srcset') &&
            mut.target.tagName === 'IMG'
          ) {
            const val = mut.attributeName === 'src' ? mut.target.src : mut.target.srcset
            log(' 🔍', mut.attributeName, 'attr changed:', val?.substring(0, 80))
            fixEmoteImage(mut.target)
          }
          // Re-apply styles when React resets them
          if (mut.type === 'attributes' && mut.attributeName === 'style') {
            const target = mut.target
            // Check if this is a heatsync-fixed image or its container
            if (target.dataset?.heatsyncFixed || target.dataset?.heatsyncWide) {
              log(' 🔄 Style reset detected, re-fixing')
              if (target.tagName === 'IMG') {
                fixEmoteImage(target)
              } else {
                // It's a container - find the image inside and re-fix
                const img = target.querySelector('img[data-heatsync-fixed]')
                if (img) fixEmoteImage(img)
              }
            }
          }
        }
      }),
      'autocomplete-image-observer',
    )

    imageObserver.observe(chatInputContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style'],
    })

    log(' ✅ Image observer installed (FFZ-style)')

    // Also watch for error events on images (failed loads = broken srcset)
    cleanup.addEventListener(
      document.body,
      'error',
      (e) => {
        if (e.target?.tagName === 'IMG') {
          const img = e.target
          const src = img.src || img.srcset || ''
          if (src.includes('__FFZ__999999::') || src.includes('jtvnw.net')) {
            log(' ❌ Image load error, attempting fix:', src.substring(0, 80))
            fixEmoteImage(img)
          }
        }
      },
      'image-error-handler',
      true,
    )

    // Safety-net polling for emote image fixes the MutationObserver might miss
    // (pre-existing images, CSS background-images on autocomplete items)
    let _lastEmoteCount = 0
    let _cachedEmoteByHash = new Map()
    cleanup.setInterval(
      () => {
        const emotes = getHeatsyncEmotes()
        if (!emotes.length) return

        // Only rebuild map when emote list changes
        if (emotes.length !== _lastEmoteCount) {
          _lastEmoteCount = emotes.length
          _cachedEmoteByHash = new Map()
          for (const e of emotes) {
            if (e.hash) _cachedEmoteByHash.set(e.hash, e)
          }
        }
        const emoteByHash = _cachedEmoteByHash

        const imgScope =
          document.querySelector(
            '[class*="chat-autocomplete"], [class*="autocomplete"], [class*="chat-input"], [class*="chat-scrollable-area"]',
          ) || document
        for (const img of imgScope.querySelectorAll('img')) {
          const src = img.src || ''
          const srcset = img.srcset || ''
          const srcsetNeedsFix = srcset.includes('jtvnw.net')
          if (img.dataset.heatsyncFixed && !srcsetNeedsFix) continue

          const checkStr = `${src} ${srcset}`

          if (checkStr.includes('__FFZ__999999::')) {
            const match = checkStr.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/)
            if (match) {
              const emote = emoteByHash.get(match[1])
              if (emote) {
                img.src = emote.url
                img.srcset = `${emote.url} 1x`
                img.dataset.heatsyncFixed = 'true'
              }
            }
          }

          if (checkStr.includes('jtvnw.net/emoticons/v2/')) {
            const match = checkStr.match(/emoticons\/v2\/([a-f0-9]{24})\/default/)
            if (match) {
              const emote = emoteByHash.get(match[1])
              if (emote) {
                img.src = emote.url
                img.srcset = `${emote.url} 1x`
                img.dataset.heatsyncFixed = 'true'
              }
            }
          }

          if (
            srcsetNeedsFix &&
            (src.includes('betterttv.net') || src.includes('7tv.app') || src.includes('frankerfacez'))
          ) {
            img.srcset = `${src} 1x`
            img.dataset.heatsyncFixed = 'true'
          }
        }

        // Fix CSS background-image on autocomplete dropdown items
        for (const el of document.querySelectorAll(
          '.emote-autocomplete-provider__image, [class*="emote"][class*="image"]',
        )) {
          if (el.dataset.heatsyncBgFixed) continue
          const bgImg = window.getComputedStyle(el).backgroundImage
          if (bgImg?.includes('__FFZ__999999::')) {
            const match = bgImg.match(/__FFZ__999999::([a-zA-Z0-9]+)__FFZ__/)
            if (match) {
              const emote = emoteByHash.get(match[1])
              if (emote) {
                const safeEmoteUrl =
                  typeof emote.url === 'string' && emote.url.startsWith('https://')
                    ? emote.url.replace(/["'()\\]/g, '')
                    : ''
                if (safeEmoteUrl) {
                  el.style.backgroundImage = `url("${safeEmoteUrl}")`
                  el.dataset.heatsyncBgFixed = 'true'
                }
              }
            }
          }
        }
      },
      2000,
      'image-polling',
    )
  }

  function checkForHeatsyncImages(node) {
    const allImages = node.querySelectorAll?.('img') ?? []
    for (const img of allImages) fixEmoteImage(img)
    if (node.tagName === 'IMG') fixEmoteImage(node)

    // Also check tooltip layer for any images
    const tooltipImages = document.querySelectorAll('.tw-tooltip-layer img')
    for (const img of tooltipImages) {
      fixEmoteImage(img)
    }

    // Check autocomplete dropdown
    const autocompleteImages = document.querySelectorAll('[class*="autocomplete"] img, [class*="Autocomplete"] img')
    for (const img of autocompleteImages) {
      fixEmoteImage(img)
    }
  }

  // Fix a single emote image if it has a heatsync fake ID
  function fixEmoteImage(img) {
    if (!img || img.dataset.heatsyncFixed) return

    // Skip images in our preview tooltips - we intentionally use max size there
    if (
      img.closest(
        '.heatsync-emote-preview, .heatsync-emote-hover-preview, #heatsync-tab-preview, #heatsync-tab-tooltip',
      )
    )
      return

    const src = img.src || ''
    const srcset = img.srcset || ''
    const checkStr = `${src} ${srcset}`
    const emotes = getHeatsyncEmotes()

    // Check for pending preview from click handler (FFZ-style)
    const pending = window.__heatsyncPendingPreview
    if (pending && Date.now() - pending.timestamp < 2000) {
      // Check if this img is in the input area (likely the preview we're waiting for)
      const isInInput = img.closest('[data-slate-editor="true"]') || img.closest('.chat-wysiwyg-input__editor')
      if (isInInput) {
        log(' 🎯 Found pending preview img, fixing:', pending.name)
        img.src = pending.url
        img.srcset = `${pending.url} 1x`
        img.dataset.heatsyncFixed = 'true'
        img.style.height = '28px'
        img.style.width = 'auto'
        window.__heatsyncPendingPreview = null // Clear pending
        return
      }
    }

    // Check if this is a Twitch URL with our fake ID (in src OR srcset)
    // Format: https://static-cdn.jtvnw.net/emoticons/v2/__FFZ__999999::hash__FFZ__/...
    if (checkStr.includes('__FFZ__999999::')) {
      const match = checkStr.match(/__FFZ__999999::(.+?)__FFZ__/)
      if (match) {
        const hash = match[1]
        const emote = emotes.find((e) => e.hash === hash)
        if (emote) {
          log(' 🖼️ Fixing emote image:', emote.name, 'hash:', hash, 'from:', src ? 'src' : 'srcset')
          img.src = emote.url
          img.srcset = `${emote.url} 1x`
          img.dataset.heatsyncFixed = 'true'

          // Preserve aspect ratio with consistent height (match input line-height to prevent box expansion)
          img.style.height = '20px'
          img.style.width = 'auto'

          // Fix all parent containers to allow wide emotes
          const cont = img.closest('.chat-image__container')
          const span = img.closest('.wysiwig-chat-input-emote')

          // Set containers to auto width initially
          if (cont) {
            cont.style.height = '28px'
            cont.style.width = 'auto'
            cont.style.maxWidth = 'none'
            cont.style.overflow = 'visible'
          }
          if (span) {
            span.style.width = 'auto'
            span.style.minWidth = 'auto'
            span.style.maxWidth = 'none'
            span.style.overflow = 'visible'
            span.style.display = 'inline-block'
          }

          // After image loads, set proper dimensions on all containers
          const fixWidth = () => {
            if (img.naturalWidth && img.naturalHeight) {
              const aspectRatio = img.naturalWidth / img.naturalHeight
              // Use 28px as base height (matches actual display height)
              const width = Math.round(28 * aspectRatio)
              const isWide = aspectRatio > 1.2
              log(' 📐 Emote:', emote.name, 'aspect:', aspectRatio.toFixed(2), 'width:', width, 'wide:', isWide)

              // Re-find elements in case DOM changed
              const currentSpan = img.closest('.wysiwig-chat-input-emote')
              const currentCont = img.closest('.chat-image__container')

              // Mark as fixed for CSS targeting
              img.dataset.heatsyncFixed = 'true'

              // Set explicit dimensions and positioning on image - ensure left-aligned, no clipping
              img.style.cssText = `width: ${width}px !important; height: 28px !important; max-width: none !important; min-width: ${width}px !important; margin: 0 !important; padding: 0 !important; position: relative !important; left: 0 !important; right: auto !important; transform: none !important; float: none !important; display: inline-block !important; vertical-align: middle !important; object-position: left center !important;`

              // Set dimensions on container using cssText for atomic update
              if (currentCont) {
                currentCont.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; margin: 0 !important; padding: 0 !important; vertical-align: middle !important;`
              }

              // Set dimensions on span wrapper using cssText for atomic update
              if (currentSpan) {
                currentSpan.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; vertical-align: middle !important; margin: 0 !important; padding: 0 !important;`
                if (isWide) {
                  currentSpan.dataset.heatsyncWide = 'true'
                }
                log(' 📐 Set span width:', `${width}px`)
              }
            }
          }

          if (img.complete && img.naturalWidth) {
            fixWidth()
          } else {
            img.addEventListener('load', fixWidth, { once: true })
          }
          return
        }
      }
    }

    // Also check jtvnw URLs that might be broken (404ing) - match by alt text
    const alt = img.alt || ''
    if (alt && (src.includes('jtvnw.net') || !src || img.complete === false)) {
      const emote = emotes.find((e) => e.name === alt)
      if (emote) {
        log(' 🖼️ Fixing emote by alt:', emote.name)
        img.src = emote.url
        img.srcset = `${emote.url} 1x`
        img.dataset.heatsyncFixed = 'true'

        // Same wide emote fix
        img.style.height = '28px'
        img.style.width = 'auto'

        const cont = img.closest('.chat-image__container')
        const span = img.closest('.wysiwig-chat-input-emote')

        if (cont) {
          cont.style.height = '28px'
          cont.style.width = 'auto'
          cont.style.maxWidth = 'none'
          cont.style.overflow = 'visible'
        }
        if (span) {
          span.style.width = 'auto'
          span.style.minWidth = 'auto'
          span.style.maxWidth = 'none'
          span.style.overflow = 'visible'
          span.style.display = 'inline-block'
        }

        const fixWidth = () => {
          if (img.naturalWidth && img.naturalHeight) {
            const aspectRatio = img.naturalWidth / img.naturalHeight
            // Use 28px as base height (matches actual display height)
            const width = Math.round(28 * aspectRatio)
            const isWide = aspectRatio > 1.2
            log(' 📐 Emote (alt):', emote.name, 'aspect:', aspectRatio.toFixed(2), 'width:', width, 'wide:', isWide)

            // Re-find elements in case DOM changed
            const currentSpan = img.closest('.wysiwig-chat-input-emote')
            const currentCont = img.closest('.chat-image__container')

            // Mark as fixed for CSS targeting
            img.dataset.heatsyncFixed = 'true'

            // Set explicit dimensions and positioning on image - ensure left-aligned, no clipping
            img.style.cssText = `width: ${width}px !important; height: 28px !important; max-width: none !important; min-width: ${width}px !important; margin: 0 !important; padding: 0 !important; position: relative !important; left: 0 !important; right: auto !important; transform: none !important; float: none !important; display: inline-block !important; vertical-align: middle !important; object-position: left center !important;`

            // Set dimensions on container using cssText for atomic update
            if (currentCont) {
              currentCont.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; margin: 0 !important; padding: 0 !important; vertical-align: middle !important;`
            }

            // Set dimensions on span wrapper using cssText for atomic update
            if (currentSpan) {
              currentSpan.style.cssText = `width: ${width}px !important; min-width: ${width}px !important; height: 28px !important; overflow: visible !important; display: inline-block !important; text-align: left !important; vertical-align: middle !important; margin: 0 !important; padding: 0 !important;`
              if (isWide) {
                currentSpan.dataset.heatsyncWide = 'true'
              }
              log(' 📐 Set span width (alt):', `${width}px`)
            }
          }
        }

        if (img.complete && img.naturalWidth) {
          fixWidth()
        } else {
          img.addEventListener('load', fixWidth, { once: true })
        }
      }
    }
  }

  // Get the chat input DOM element
  function getInputElement() {
    return (
      document.querySelector('[data-slate-editor="true"]') ||
      document.querySelector('.chat-wysiwyg-input__editor') ||
      document.querySelector('[data-a-target="chat-input"]')
    )
  }

  // Hook Slate normalizer to prevent emote conversion when WYSIWYG is off
  function hookNormalizer(inst) {
    const slateEditor = inst?.chatInputRef?.state?.slateEditor
    if (!slateEditor || slateEditor._heatsyncNormalizerHooked) return

    const originalNormalize = slateEditor.normalizeNode
    slateEditor._heatsyncOriginalNormalize = originalNormalize
    slateEditor._heatsyncNormalizerHooked = true

    // Restore original on abort (extension reload)
    acSignal.addEventListener('abort', () => {
      slateEditor.normalizeNode = originalNormalize
      slateEditor._heatsyncNormalizerHooked = false
    })

    slateEditor.normalizeNode = function (entry) {
      const settings = getExtensionSettings()
      // If WYSIWYG is OFF, skip ALL emote normalization (Twitch + ours)
      if (settings.emoteWysiwyg === false) {
        const [node, _path] = entry
        // Block normalization of text nodes - prevents ALL emote conversions
        if (node.text) {
          return
        }
        // Also block emote node normalization
        if (node.type === 'emote') {
          return
        }
      }
      return originalNormalize.call(this, entry)
    }
    log(' ✅ Hooked Slate normalizer for WYSIWYG text mode')
  }

  // Auto-convert :shortcode: → emoji as you type (on closing colon)
  function hookEmojiAutoConvert(inst) {
    const slateEditor = inst?.chatInputRef?.state?.slateEditor
    if (!slateEditor || slateEditor._heatsyncEmojiHooked) return

    const originalInsertText = slateEditor.insertText.bind(slateEditor)
    slateEditor._heatsyncEmojiHooked = true

    acSignal.addEventListener('abort', () => {
      slateEditor.insertText = originalInsertText
      slateEditor._heatsyncEmojiHooked = false
    })

    slateEditor.insertText = (text) => {
      // Only check when a colon is typed
      if (text === ':' && EMOJI_ENTRIES.length > 0) {
        try {
          // Get current text before cursor
          const { selection } = slateEditor
          if (selection) {
            const [node] = slateEditor.node(selection.anchor.path)
            if (node?.text) {
              const textBefore = node.text.slice(0, selection.anchor.offset)
              // Find opening colon — match :word_name pattern (no spaces)
              const match = textBefore.match(/:([a-z0-9_]+)$/)
              if (match) {
                const shortcode = match[1]
                const emoji = EMOJI_MAP[shortcode]
                if (emoji) {
                  // Replace :shortcode with emoji (delete back to opening colon, insert emoji)
                  const deleteFrom = selection.anchor.offset - match[0].length
                  const point = { path: selection.anchor.path, offset: deleteFrom }
                  slateEditor.select({ anchor: point, focus: selection.anchor })
                  slateEditor.deleteFragment()
                  originalInsertText.call(slateEditor, `${emoji} `)
                  log(`🎯 Auto-converted :${shortcode}: → ${emoji}`)
                  return
                }
              }
            }
          }
        } catch (e) {
          log('Emoji auto-convert error:', e.message)
        }
      }
      return originalInsertText.call(slateEditor, text)
    }
    log('✅ Hooked Slate insertText for emoji auto-convert')
  }

  function injectEmojiInputStyle() {}

  // Main init
  let clickHandlerInstalled = false
  function init() {
    log('🚀 init() called')
    injectEmojiInputStyle()
    chatInputInst = findChatInput()
    if (chatInputInst) {
      log('✅ Chat input FOUND, installing handlers')
      overrideEmoteProvider(chatInputInst) // Override getMatches like FFZ
      hookComponentDidUpdate(chatInputInst) // Re-inject when props change
      hookNormalizer(chatInputInst) // Block emote conversion when WYSIWYG off
      hookEmojiAutoConvert(chatInputInst) // Auto-convert :shortcode: → emoji on closing colon
      injectFakeEmotes(chatInputInst) // Inject fake emotes for inline rendering
      exportNativeEmotes() // Share sub emotes with multichat via storage
      installImageObserver() // Watch for images to fix
      if (!clickHandlerInstalled) {
        installAutocompleteClickHandler() // Handle clicks on our emotes
        installAutocompleteKeyHandler() // Handle Tab on our emotes (Enter never touched)
        clickHandlerInstalled = true
        log('✅ Key handlers installed')
      }
    } else {
      log('❌ Chat input NOT found')
    }
  }

  // Handle navigation — poll URL instead of a full-document subtree observer
  // (early-inject-main.js already sends heatsync-nav events; this is a cheap fallback)
  let lastUrl = location.href
  cleanup.setInterval(
    () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        cleanup.setTimeout(init, 500, 'autocomplete-nav-reinit')
      }
    },
    5000,
    'autocomplete-nav-poll',
  )

  // Initial run with retry — chat component may load after document_end
  let initAttempts = 0
  function tryInit() {
    initAttempts++
    init()
    if (!chatInputInst && initAttempts < 10) {
      cleanup.setTimeout(tryInit, 1000, `autocomplete-retry-${initAttempts}`)
    }
  }
  cleanup.setTimeout(tryInit, 1000, 'autocomplete-initial')
  document.addEventListener(
    'heatsync-emotes-updated',
    () => {
      if (chatInputInstance) {
        injectFakeEmotes(chatInputInstance)
      }
      log(' Emotes updated (tab state preserved)')
    },
    { signal: acSignal },
  )

  log(' 🎯 FFZ-style inline tab completion initialized')
})()
