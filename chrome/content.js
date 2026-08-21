// Content script - Inject into Twitch/Kick chat
;(() => {
  // Debug logging - set to false for production
  const HEATSYNC_DEBUG = false
  const log = HEATSYNC_DEBUG ? console.log.bind(console, '[heatsync]') : () => {}
  const warn = HEATSYNC_DEBUG ? console.warn.bind(console, '[heatsync]') : () => {}

  // Cooldown for extension-reload postMessage handler — prevents page JS
  // from hammering chrome.runtime.reload() in a tight loop.
  let _lastExtReloadMs = 0

  log('🚀 Script loaded on:', window.location.href)

  const isKick = window.location.hostname.includes('kick.com')

  // The overlay (#hs-mc-container) fully replaces + hides native chat once mounted.
  // After that, all native-chat-row DOM enhancement (per-message emote render,
  // cosmetics, coloring, heat borders, timeout-dim, msg cache, the native emote
  // bridge, existing-message re-sweeps) is invisible dead work on a display:none
  // subtree. Gate those paths on this. Latches true once the container is seen (it
  // persists), so it's a single O(1) check thereafter. Safe-degradation: if the
  // overlay ever fails to mount, this stays false → native processing runs as a
  // fallback, so gating can't blank the screen.
  let _hsOverlayActive = false
  function isOverlayActive() {
    return _hsOverlayActive || (_hsOverlayActive = !!document.getElementById('hs-mc-container'))
  }

  // --- user-key helpers (content script) ---
  // Inlined because lib/ is bundled into other targets only.
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

  // Chrome compatibility - use 'browser' namespace like Firefox
  // Firefox uses native browser API

  const API_URL = 'https://heatsync.org' // Production server

  // heatsync.org gate — return BEFORE any chat/style injection runs. The
  // extension's content script gets matched on heatsync.org for OAuth-token
  // pickup (auth_token query param after Twitch login redirect), but the
  // rest of this file (~3000 lines: emote stacking, profile cards, native
  // chat decoration, style block injection) is designed for twitch.tv /
  // kick.com chat overlays. Letting any of it run on heatsync.org pollutes
  // the site with !important style rules (.hs-pc-live red badge etc.) and
  // makes heatsync.org's own CSS fight the extension's cascade. Handle the
  // OAuth case + bail. Valid `return` because this file is wrapped in an
  // IIFE (line 2).
  if (window.location.hostname === 'heatsync.org' || window.location.hostname.endsWith('.heatsync.org')) {
    log(' 🔍 Content script on heatsync.org — OAuth-only mode')
    // Announce presence so the site's install nudge can detect the ext.
    // ISOLATED world shares the DOM — page main-world JS reads dataset.hsExt.
    document.documentElement.dataset.hsExt = '1'
    // Kick-send-via-relay capability beacon — this version wires
    // kick:relay_send / kick:relay_ack in background.js, so any install
    // running this code supports it. (The comment used to name a third
    // message, chat:send_kick, which appears nowhere but the comment; the
    // relay itself is real and is what the beacon promises.) Same dataset-on-shared-DOM
    // mechanism as hsExt above (a page-injected window global isn't visible
    // across the isolated/main world boundary). heatsync.org's chips UI
    // feature-detects via document.documentElement.dataset.hsKickRelay === '1'.
    document.documentElement.dataset.hsKickRelay = '1'
    try {
      const urlParams = new URLSearchParams(window.location.search)
      const urlToken = urlParams.get('auth_token')
      if (urlToken && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(urlToken)) {
        log(' ✓ Found auth_token in URL, sending to background (length:', urlToken.length, ')')
        // backend echoes the nonce as ext_state (plain `state` is the OAuth CSRF token)
        const urlState = urlParams.get('ext_state') || null
        try {
          chrome.runtime.sendMessage({ type: 'set_auth_token', token: urlToken, state: urlState })
        } catch {}
        window.history.replaceState({}, document.title, window.location.pathname)
      }
    } catch {}
    return
  }

  // Native emote selectors for stackAdjacentOverlayEmotes — pre-joined to avoid per-call allocation
  const NATIVE_EMOTE_SELECTORS = [
    'img.chat-line__message--emote', // Classic Twitch
    'img[data-a-target="emote-name"]', // Data attribute variant
    '.chat-image__container', // Container variant
    'img.chat-image', // Simple chat image
    '.emote-button img', // Button wrapped
    '[class*="emote"] img', // Any class containing "emote"
    'img[alt][src*="static-cdn.jtvnw.net"]', // Twitch CDN emotes by URL
    'img[alt][src*="emoticons"]', // Emoticons URL pattern
    'img[alt][src*="files.kick.com"]', // Kick CDN emotes
    'img[alt][src*="kick-emote"]', // Kick emote variant
  ].join(', ')

  // Combined selector for stackAdjacentOverlayEmotes (heatsync + native, single querySelectorAll)
  const COMBINED_EMOTE_SELECTOR = `.heatsync-emote-wrapper, ${NATIVE_EMOTE_SELECTORS}`

  // Re-injection guard. background.js re-executes content.js on extension
  // update/reload (manifest content scripts don't auto re-inject). Without this,
  // OLD + NEW both run: doubled MutationObservers, doubled listeners, 2x CPU.
  try {
    if (typeof window.__heatsyncContentLifecycle?.abort === 'function') {
      window.__heatsyncContentLifecycle.abort()
    }
  } catch (_) {}

  // Lifecycle controller — abort() tears down ALL listeners, timers, observers
  const lifecycle = new AbortController()
  const { signal } = lifecycle
  const _timers = { intervals: [], timeouts: [], observers: [] }
  signal.addEventListener('abort', () => {
    _timers.intervals.forEach(clearInterval)
    _timers.timeouts.forEach(clearTimeout)
    _timers.observers.forEach((o) => o.disconnect())
    try {
      chrome.runtime.onMessage.removeListener(_onMessageMain)
    } catch (_) {}
    try {
      chrome.runtime.onMessage.removeListener(_onMessageKickRelay)
    } catch (_) {}
    try {
      chrome.storage.onChanged.removeListener(_onStorageChanged)
    } catch (_) {}
    try {
      chrome.storage.onChanged.removeListener(_onAutoClaimStorageChanged)
    } catch (_) {}
  })
  // Bug #4 (bfcache): only abort on REAL unloads. For bfcache-bound pagehide
  // (ev.persisted) the page is frozen intact and may be restored — the
  // AbortController is single-use, so aborting would leave every { signal }
  // listener permanently unattachable on restore. Keeping the lifecycle alive
  // means the restored page resumes with observers/timers intact; if the page
  // is evicted instead, it's destroyed wholesale — nothing leaks.
  window.addEventListener('pagehide', (ev) => {
    if (!ev.persisted) lifecycle.abort()
  })
  // On bfcache restore, re-hook the chat observer + rescan — the restored DOM
  // is the pre-nav snapshot and may have missed messages / a swapped container.
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return
    try {
      watchForNewMessages()
    } catch (_) {}
    try {
      if (emoteInventory.length > 0 || globalEmotes.length > 0) processExistingMessages()
    } catch (_) {}
  })
  // Export abort handle so a future re-injection of this script can tear us down.
  // _hsTakenOver flips iff someone outside this closure called our abort — i.e.
  // a NEW content.js instance took over. Internal abort() calls go via
  // `lifecycle.abort()` directly and leave the flag false.
  let _hsTakenOver = false
  window.__heatsyncContentLifecycle = {
    abort: () => {
      _hsTakenOver = true
      try {
        lifecycle.abort()
      } catch (_) {}
    },
  }

  // Twitch URL path segments that are NEVER channels. ONE list — the
  // open-channel reporter fed 'login' (oauth redirect page) to the BG as a
  // live channel on 2026-07-14, which IRC-joined it and spawned ghost tabs.
  const TWITCH_EXCLUDED_PATHS = [
    'login',
    'logout',
    'signup',
    'oauth',
    'oauth2',
    'activate',
    'checkout',
    'directory',
    'settings',
    'downloads',
    'p',
    'videos',
    'search',
    'subscriptions',
    'inventory',
    'wallet',
    'drops',
    'prime',
    'turbo',
    'products',
    'bits',
    'u',
    'moderator',
    'broadcast',
    'clip',
  ]

  // Fast context-death detector. chrome.runtime.id becomes undefined sync on
  // extension reload. Once dead: tear down listeners immediately, then defer
  // the page reload to visibility — active tab reloads in 1–5s, background
  // tabs wait until user focuses them. This avoids the N-tab thundering React
  // mount herd that crashes Chrome when many Twitch tabs reload at once.
  // If a NEW content.js instance arrives before reload fires, skip the reload.
  const _hsCtxDeathTimer = setInterval(() => {
    // chrome.runtime?.id access can throw "Extension context invalidated" on
    // orphaned content scripts — without try/catch the detector silently dies
    // each tick and reload never arms.
    let alive = false
    try {
      alive = !!chrome.runtime?.id
    } catch (_) {
      alive = false
    }
    if (alive) return
    clearInterval(_hsCtxDeathTimer)
    extensionContextValid = false
    try {
      lifecycle.abort()
    } catch (_) {}
    if (window.__heatsyncReloadScheduled) return
    window.__heatsyncReloadScheduled = true
    const doReload = () => {
      if (_hsTakenOver) return
      try {
        location.reload()
      } catch (_) {}
    }
    if (document.visibilityState === 'visible') {
      setTimeout(doReload, 1000 + Math.random() * 4000)
    } else {
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState !== 'visible') return
        document.removeEventListener('visibilitychange', once)
        setTimeout(doReload, 500 + Math.random() * 2000)
      })
    }
  }, 2000)
  _timers.intervals.push(_hsCtxDeathTimer)

  // Port-based ctx-death detector. chrome.runtime.connect() opens a long-lived
  // port to BG. When the extension is invalidated, port.onDisconnect fires
  // SYNCHRONOUSLY before chrome.runtime becomes undefined and before Chrome
  // can suspend the orphaned script's setInterval — catches the cases the 2s
  // interval misses. The port also distinguishes "ext gone" from "SW just
  // idle-suspended": on disconnect, if chrome.runtime?.id still resolves, the
  // ext is alive (SW restarting), so we re-open the port and don't reload.
  function _hsOpenCtxDeathPort() {
    let port
    try {
      if (!chrome?.runtime?.connect) return
      port = chrome.runtime.connect({ name: 'heatsync-ctx-death' })
    } catch (_) {
      return
    }
    port.onDisconnect.addListener(() => {
      let alive = false
      try {
        alive = !!chrome.runtime?.id
      } catch (_) {
        alive = false
      }
      if (alive) {
        // SW idle-suspended (ext alive). Re-open after a beat — that wakes SW.
        setTimeout(_hsOpenCtxDeathPort, 500)
        return
      }
      // Ext truly gone — arm reload via the same dedupe flag.
      extensionContextValid = false
      try {
        lifecycle.abort()
      } catch (_) {}
      if (window.__heatsyncReloadScheduled) return
      window.__heatsyncReloadScheduled = true
      const doReload = () => {
        if (_hsTakenOver) return
        try {
          location.reload()
        } catch (_) {}
      }
      if (document.visibilityState === 'visible') {
        setTimeout(doReload, 1000 + Math.random() * 4000)
      } else {
        document.addEventListener('visibilitychange', function once() {
          if (document.visibilityState !== 'visible') return
          document.removeEventListener('visibilitychange', once)
          setTimeout(doReload, 500 + Math.random() * 2000)
        })
      }
    })
  }
  _hsOpenCtxDeathPort()

  // WeakMap for emote overlay references — avoids DOM property leaks
  const overlayMap = new WeakMap()

  // Optional perf tracer. window.__hsPerfTrace = true at runtime to log slow
  // callbacks into window.__hsPerfLog. Source captured at registration so
  // anonymous arrows still get a stable identifier.
  function _hsPerfWrap(fn, ms, kind) {
    let src = ''
    try {
      const stack = new Error().stack || ''
      const lines = stack.split('\n')
      for (const line of lines) {
        if (!line || (line.includes('content.js') && line.includes('_hsPerfWrap'))) continue
        if (!line || line.includes('_hsPerfWrap') || line.includes('cleanup.set')) continue
        src = line.trim().slice(0, 160)
        break
      }
    } catch {}
    return function () {
      if (!window.__hsPerfTrace) return fn.apply(this, arguments)
      const t = performance.now()
      try {
        return fn.apply(this, arguments)
      } finally {
        const d = performance.now() - t
        if (d > 50) {
          ;(window.__hsPerfLog ||= []).push({ side: 'twitch', kind, ms, dur: Math.round(d), at: Math.round(t), src })
          if (window.__hsPerfLog.length > 300) window.__hsPerfLog.shift()
        }
      }
    }
  }

  // Helpers matching old cleanup API but wired to AbortController
  const cleanup = {
    setInterval(fn, ms) {
      const id = setInterval(_hsPerfWrap(fn, ms, 'interval'), ms)
      _timers.intervals.push(id)
      return id
    },
    setIntervalIfVisible(fn, ms) {
      const w = _hsPerfWrap(fn, ms, 'intervalIfVisible')
      const id = setInterval(() => {
        if (!document.hidden) w()
      }, ms)
      _timers.intervals.push(id)
      return id
    },
    clearInterval(id) {
      clearInterval(id)
      const idx = _timers.intervals.indexOf(id)
      if (idx !== -1) _timers.intervals.splice(idx, 1)
    },
    clearTimeout(id) {
      clearTimeout(id)
      const idx = _timers.timeouts.indexOf(id)
      if (idx !== -1) _timers.timeouts.splice(idx, 1)
    },
    setTimeout(fn, ms) {
      const w = _hsPerfWrap(fn, ms, 'timeout')
      const id = setTimeout(() => {
        const idx = _timers.timeouts.indexOf(id)
        if (idx !== -1) _timers.timeouts.splice(idx, 1)
        w()
      }, ms)
      _timers.timeouts.push(id)
      return id
    },
    addEventListener(target, event, handler) {
      target.addEventListener(event, handler, { signal })
    },
    trackObserver(obs) {
      _timers.observers.push(obs)
      return obs
    },
    untrackObserver(obs) {
      const i = _timers.observers.indexOf(obs)
      if (i !== -1) _timers.observers.splice(i, 1)
    },
  }

  // hsSched — cooperative scheduler used by boot-burst processors. Goal: never
  // hold the main thread > ~4ms while we still have a backlog. Burns time in
  // budget slices, yields, resumes. Listens for scroll/wheel/touchmove and
  // pauses non-urgent work while the user is actively scrolling, so chat-page
  // scroll never competes with backfill processing for the main thread.
  const hsSched = (() => {
    let _scrollIdle = true
    let _scrollIdleTimer = null
    const markBusy = () => {
      _scrollIdle = false
      if (_scrollIdleTimer) clearTimeout(_scrollIdleTimer)
      _scrollIdleTimer = setTimeout(() => {
        _scrollIdle = true
        _scrollIdleTimer = null
      }, 180)
    }
    // capture+passive so we don't perturb wheel/scroll perf ourselves
    for (const ev of ['scroll', 'wheel', 'touchmove', 'pointerdown']) {
      try {
        window.addEventListener(ev, markBusy, { passive: true, capture: true, signal })
      } catch (e) {
        // Lose these and the busy-yield never engages: emote processing stops
        // backing off during scroll, which reads as jank, not as an error.
        swallow(e, 'busy-listener-content')
      }
    }
    const _yield = () => {
      // scheduler.yield() (Chrome 129+) returns priority back to caller after
      // browser deals with input/paint. Falls back to a macrotask which lets
      // the event loop process input before resuming us.
      if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield()
      }
      return new Promise((r) => setTimeout(r, 0))
    }
    const untilIdle = async () => {
      // Bounded wait — never starve processing if scroll never stops.
      let waited = 0
      while (!_scrollIdle && waited < 2000) {
        await new Promise((r) => setTimeout(r, 60))
        waited += 60
      }
    }
    const idle = (fn, { timeout = 2000, priority = 'background' } = {}) => {
      if (typeof scheduler !== 'undefined' && typeof scheduler.postTask === 'function') {
        return scheduler.postTask(fn, { priority })
      }
      if (typeof window.requestIdleCallback === 'function') {
        return new Promise((r) =>
          requestIdleCallback(
            () => {
              try {
                r(fn())
              } catch (_e) {
                r()
              }
            },
            { timeout },
          ),
        )
      }
      return new Promise((r) =>
        setTimeout(() => {
          try {
            r(fn())
          } catch (_e) {
            r()
          }
        }, 0),
      )
    }
    // Process items[] with `fn`. Yield to browser whenever the current slice
    // exceeds budgetMs. Pauses during active scroll. Total wall-clock can be
    // anything — caller cares about main-thread smoothness, not total time.
    const chunk = async (items, fn, { budgetMs = 4, respectScroll = true } = {}) => {
      let t0 = performance.now()
      for (let i = 0; i < items.length; i++) {
        if (respectScroll && !_scrollIdle) await untilIdle()
        try {
          fn(items[i], i)
        } catch (e) {
          try {
            log(' chunk fn err:', e?.message)
          } catch {}
        }
        if (performance.now() - t0 > budgetMs) {
          await _yield()
          t0 = performance.now()
        }
      }
    }
    return {
      yield: _yield,
      idle,
      chunk,
      untilIdle,
      get scrollIdle() {
        return _scrollIdle
      },
    }
  })()

  // React fiber walking — use shared-utils if available, inline fallback
  const _getFiber =
    window.HS?.getFiber ||
    ((el) => {
      if (!el) return null
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
      return key ? el[key] : null
    })

  // Track if extension context is still valid
  let extensionContextValid = true

  // Cached allEmotes map — rebuilt only when emote data changes
  let cachedAllEmotes = null
  // Same as cachedAllEmotes but with viewer-inventory variants stripped. Used as
  // the channel/global fallback for OTHER senders' messages so the viewer's
  // personal set doesn't bleed into renders of users who don't actually have
  // the emote. cachedAllEmotes (with inventory) is still used for own renders
  // + picker + autocomplete + tab-complete suggestions.
  let cachedNonInventoryEmotes = null
  // Channel-only render map (non-inventory, non-global). Channel emotes are
  // authoritative in their own channel for EVERY sender, so they must beat a
  // sender's colliding personal set — but only for names the channel carries;
  // names it doesn't fall through to the sender's set, then global. Mirrors the
  // multichat panel's channel > senderEmotes > global order.
  let cachedChannelEmotes = null
  // Own-message render map: channel > inventory > global. Channel emotes are
  // authoritative in their own channel for EVERYONE — so the viewer's own messages
  // render a channel emote identically to how other chatters see it. Inventory still
  // fills every name the channel doesn't carry (emote sovereignty preserved). Without
  // this, a personal-inventory emote sharing a name with a (different) channel emote
  // made the viewer's own messages diverge from the rest of chat.
  let cachedOwnEmotes = null
  // name → emote[] in priority order (inventory[0], channel[1..], global[N..]).
  // Same-named emotes from different sources are kept as siblings so right-click
  // block on the active one swaps to the next non-blocked variant in DOM.
  let cachedAllEmoteVariants = null
  let allEmotesDirty = true
  let emoteGeneration = 0

  // Emote display size
  let hsEmoteSize = 1
  const HS_EMOTE_BASE_PX = 28
  function applyEmoteSize() {
    document.documentElement.style.setProperty('--hs-emote-height', `${HS_EMOTE_BASE_PX * hsEmoteSize}px`)
  }

  // Unicode emoji size (1x/2x/4x) — mirrors multichat's hs_emoji_size.
  let hsEmojiSize = 2
  function applyEmojiSize() {
    document.documentElement.style.setProperty('--hs-emoji-scale', String(hsEmojiSize))
  }

  // Diag probe — writes a small page-state snapshot to chrome.storage.local.hs_diag_page
  // so the SW's buildDiagSnapshot() can include "what browser context did the bug fire in"
  // alongside the error ring buffer. DOM-probes peer extensions (7TV/FFZ/BTTV/Chatterino)
  // because their injected DOM is the #1 source of repro-only-on-some-users breakage.
  // (Unhandled errors are captured by lib/error-reporter.js writing hs_errors directly.)
  // Cached peer-ext presence — refreshed by _writeDiagPage (2s/8s/URL change).
  // Gates native-chat cosmetic injection: when the real 7TV/BTTV/FFZ extension
  // is co-installed it renders its own badges/paints on native rows — injecting
  // ours too produces visible duplicates.
  let _peerExts = []
  function _detectPeerExts() {
    const c = []
    try {
      if (window.FrankerFaceZ || document.querySelector('.ffz-emoticon, .ffz-badge, [class^="ffz-"]')) c.push('ffz')
    } catch {}
    try {
      if (window.SevenTV || document.querySelector('[class^="seventv-"], .seventv-emote')) c.push('7tv')
    } catch {}
    try {
      if (window.BetterTTV || document.querySelector('[data-provider="bttv"], .bttv-emote')) c.push('bttv')
    } catch {}
    try {
      if (document.querySelector('chatterino-injected, [class^="chatterino-"]')) c.push('chatterino')
    } catch {}
    return c
  }
  function _writeDiagPage() {
    try {
      const plat = window.location.hostname.includes('kick.com')
        ? 'kick'
        : window.location.hostname.includes('youtube.com')
          ? 'yt'
          : window.location.hostname.includes('twitch.tv')
            ? 'twitch'
            : 'other'
      _peerExts = _detectPeerExts()
      const snap = {
        ts: Date.now(),
        plat,
        channel: getPageChannel(),
        conflicts: _peerExts,
      }
      chrome.storage.local.set({ hs_diag_page: snap }, () => {
        void chrome.runtime.lastError
      })
    } catch {}
  }
  // Initial + re-probe after host SPA settles + on URL change.
  cleanup.setTimeout(_writeDiagPage, 2000)
  cleanup.setTimeout(_writeDiagPage, 8000)
  let _lastDiagUrl = location.href
  cleanup.setIntervalIfVisible(() => {
    if (location.href !== _lastDiagUrl) {
      _lastDiagUrl = location.href
      _writeDiagPage()
    }
  }, 5000)

  // Safe wrapper for chrome.runtime.sendMessage - handles context invalidation
  async function safeSendMessage(message, _retry = 0) {
    if (!extensionContextValid) {
      warn(' Extension context invalidated - please refresh the page')
      return { success: false, error: 'Extension context invalidated' }
    }
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (err) {
      if (err.message?.includes('Extension context invalidated') || err.message?.includes('context invalidated')) {
        extensionContextValid = false
        warn(' ⚠️ Extension was reloaded - please refresh this page')
        showToast(t('common_extension_updated'), 'warning')
      } else if (
        _retry < 5 &&
        (err.message?.includes('Receiving end does not exist') ||
          err.message?.includes('Could not establish connection'))
      ) {
        // Service worker waking up — retry with backoff (200, 400, 800, 1600, 3200ms)
        await new Promise((r) => setTimeout(r, 200 * 2 ** _retry))
        return safeSendMessage(message, _retry + 1)
      }
      throw err
    }
  }

  // Auth bridge removed — it wrote the raw heatsync token into a
  // page-readable DOM dataset (host-page JS could exfiltrate it). The only
  // consumer (heatsync-button.js, ISOLATED world) now reads chrome.storage
  // directly. Remove any bridge node a previous version left in the DOM.
  try {
    document.getElementById('__heatsync_auth_bridge')?.remove()
  } catch {}

  function _onStorageChanged(changes, areaName) {
    if (changes.hs_emote_size != null) {
      hsEmoteSize = parseFloat(changes.hs_emote_size.newValue) || 1
      applyEmoteSize()
    }
    if (changes.hs_emoji_size != null) {
      const v = changes.hs_emoji_size.newValue
      hsEmojiSize = v === 1 || v === 2 || v === 4 ? v : 2
      applyEmojiSize()
    }
    // Live-apply ui_settings changes from options page (sync storage)
    if (areaName === 'sync' && changes.ui_settings) {
      const next = changes.ui_settings.newValue
      if (next) applyUiSettings(next)
    }
    // Keyword highlights — update regex + reapply
    if (changes.keyword_highlights) {
      rebuildKeywordRegex(changes.keyword_highlights.newValue)
      applyKeywordHighlightsToVisibleMessages()
    }
    // Per-user color overrides — update map + reapply
    if (changes.hs_user_colors) {
      rebuildUserColorMap(changes.hs_user_colors.newValue)
      applyUserColorsToVisibleMessages()
    }
    if (changes.hs_dim_timeouts) dimTimeoutsEnabled = changes.hs_dim_timeouts.newValue !== false
    // User notes — refresh the native cache when the overlay (or another tab) writes.
    if (changes[HS_NOTE_STORE_KEY]) _noteSetBlob(changes[HS_NOTE_STORE_KEY].newValue)
  }
  chrome.storage.onChanged.addListener(_onStorageChanged)

  // ── Cross-platform user notes (native surface) ──────────────────────────────
  // A private note on a chatter, editable from the native user card. The storage
  // shape here is the CONTRACT shared with src/multichat/user-notes.js (the
  // overlay): both read/write { notes:{canonical:{text,updatedAt}}, index:{alias:
  // canonical} } under hs_user_notes_v1, so notes made on either surface merge.
  // Native chat is single-platform, so we key by the bare handle; the overlay's
  // alias graph links identities across platforms later via the index.
  const HS_NOTE_STORE_KEY = 'hs_user_notes_v1'
  const HS_NOTE_MAX = 2000
  let _noteBlob = { notes: {}, index: {} }
  function _noteSetBlob(raw) {
    _noteBlob =
      raw && typeof raw === 'object'
        ? {
            notes: raw.notes && typeof raw.notes === 'object' ? raw.notes : {},
            index: raw.index && typeof raw.index === 'object' ? raw.index : {},
          }
        : { notes: {}, index: {} }
  }
  function _noteCanonical(handle) {
    const h = String(handle).toLowerCase()
    const c = _noteBlob.index[h]
    if (c && _noteBlob.notes[c]) return c
    return h
  }
  function noteGet(handle) {
    if (!handle) return null
    return _noteBlob.notes[_noteCanonical(handle)] || null
  }
  function noteSave(handle, text) {
    const h = String(handle || '').toLowerCase()
    if (!h) return
    const clean = String(text == null ? '' : text)
      .slice(0, HS_NOTE_MAX)
      .trim()
    if (!clean) return noteDelete(h)
    const c = _noteCanonical(h)
    _noteBlob.notes[c] = { text: clean, updatedAt: Date.now() }
    _noteBlob.index[h] = c
    try {
      chrome.storage.local.set({ [HS_NOTE_STORE_KEY]: _noteBlob }, () => void chrome.runtime?.lastError)
    } catch {}
  }
  function noteDelete(handle) {
    const h = String(handle || '').toLowerCase()
    const c = _noteCanonical(h)
    delete _noteBlob.notes[c]
    for (const k of Object.keys(_noteBlob.index)) if (_noteBlob.index[k] === c) delete _noteBlob.index[k]
    try {
      chrome.storage.local.set({ [HS_NOTE_STORE_KEY]: _noteBlob }, () => void chrome.runtime?.lastError)
    } catch {}
  }
  try {
    chrome.storage.local.get(HS_NOTE_STORE_KEY, (d) => _noteSetBlob(d?.[HS_NOTE_STORE_KEY]))
  } catch {}

  // Keyword highlights (BTTV/FFZ-style custom highlight word list)
  let _keywordRegex = null
  function rebuildKeywordRegex(raw) {
    if (!raw) {
      _keywordRegex = null
      return
    }
    const list = (typeof raw === 'string' ? raw.split(/[\n,]/) : Array.isArray(raw) ? raw : [])
      .map((s) => String(s).trim())
      .filter((s) => s && s.length < 64)
      .slice(0, 50)
    if (!list.length) {
      _keywordRegex = null
      return
    }
    const escaped = list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    try {
      _keywordRegex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'i')
    } catch {
      _keywordRegex = null
    }
  }
  function highlightKeywords(messageElement) {
    if (!_keywordRegex) return
    const txt = messageElement.textContent || ''
    if (!_keywordRegex.test(txt)) return
    let parent = messageElement
    while (parent && !parent.classList.contains('chat-line__message') && !parent.hasAttribute('data-index')) {
      parent = parent.parentElement
    }
    const target =
      parent && (parent.classList.contains('chat-line__message') || parent.hasAttribute('data-index'))
        ? parent
        : messageElement
    target.classList.add('hs-keyword-match')
  }
  function applyKeywordHighlightsToVisibleMessages() {
    document.querySelectorAll('.hs-keyword-match').forEach((el) => el.classList.remove('hs-keyword-match'))
    if (!_keywordRegex) return
    document.querySelectorAll('.chat-line__message, [data-index]').forEach(highlightKeywords)
  }

  // Per-user color overrides (right-click username → set color)
  const _userColors = new Map() // username (lower) → '#rrggbb'
  function rebuildUserColorMap(raw) {
    _userColors.clear()
    if (!raw) return
    const arr = Array.isArray(raw)
      ? raw
      : typeof raw === 'object'
        ? Object.entries(raw).map(([username, color]) => ({ username, color }))
        : []
    for (const entry of arr) {
      if (entry?.username && /^#[0-9a-fA-F]{6}$/.test(entry.color || '')) {
        _userColors.set(String(entry.username).toLowerCase(), entry.color)
      }
    }
  }
  function applyUserColorToMessage(messageElement, username) {
    const lower = String(username || '').toLowerCase()
    if (!lower) return
    const color = _userColors.get(lower)
    if (!color) return
    const userEl = messageElement.querySelector(
      '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
    )
    if (userEl) {
      userEl.style.setProperty('--hs-user-color', color)
      userEl.classList.add('hs-user-colored')
    }
  }
  function applyUserColorsToVisibleMessages() {
    document.querySelectorAll('.hs-user-colored').forEach((el) => {
      el.classList.remove('hs-user-colored')
      el.style.removeProperty('--hs-user-color')
    })
    if (!_userColors.size) return
    document.querySelectorAll('.chat-line__message, [data-index]').forEach((msg) => {
      const userEl = msg.querySelector(
        '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
      )
      if (!userEl) return
      const lower = (userEl.textContent || '').toLowerCase().trim()
      const color = _userColors.get(lower)
      if (color) {
        userEl.style.setProperty('--hs-user-color', color)
        userEl.classList.add('hs-user-colored')
      }
    })
  }

  // Initial load of keyword + user color settings
  chrome.storage.local
    .get(['keyword_highlights', 'hs_user_colors'])
    .then((d) => {
      rebuildKeywordRegex(d.keyword_highlights)
      rebuildUserColorMap(d.hs_user_colors)
    })
    .catch(() => {})

  // User color picker popup (right-click username → open)
  const HS_USER_COLOR_SWATCHES = [
    '#fff',
    '#ffd700',
    '#ff4d4d',
    '#ff66cc',
    '#cc66ff',
    '#6666ff',
    '#33ccff',
    '#33ffcc',
    '#66ff66',
    '#a3ff00',
    '#ffaa00',
    '#ff5500',
    '#ffffff',
    '#bbbbbb',
    '#888888',
    '#000000',
  ]
  let _ucpEl = null
  let _ucpOffClick = null // outside-click listener — removed on EVERY close path
  let _ucpAttachTimer = null // pending deferred-attach; cancelled if we close first
  function closeUserColorPicker() {
    if (_ucpAttachTimer) {
      clearTimeout(_ucpAttachTimer)
      _ucpAttachTimer = null
    }
    if (_ucpOffClick) {
      document.removeEventListener('mousedown', _ucpOffClick, true)
      _ucpOffClick = null
    }
    if (_ucpEl) {
      _ucpEl.remove()
      _ucpEl = null
    }
  }
  function persistUserColors() {
    const arr = Array.from(_userColors.entries()).map(([username, color]) => ({ username, color }))
    chrome.storage.local.set({ hs_user_colors: arr }).catch(() => {})
  }
  function setUserColor(username, color) {
    const lower = String(username || '').toLowerCase()
    if (!lower) return
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      _userColors.set(lower, color)
    } else {
      _userColors.delete(lower)
    }
    persistUserColors()
    applyUserColorsToVisibleMessages()
  }
  function openUserColorPicker(username, x, y) {
    closeUserColorPicker()
    const lower = username.toLowerCase()
    const current = _userColors.get(lower) || '#fff'

    const el = document.createElement('div')
    el.id = 'hs-user-color-picker'
    el.style.left = `${Math.min(x, window.innerWidth - 240)}px`
    el.style.top = `${Math.min(y, window.innerHeight - 200)}px`

    const header = document.createElement('div')
    header.className = 'hs-ucp-header'
    header.textContent = `color for ${username}`
    el.appendChild(header)

    const swatches = document.createElement('div')
    swatches.className = 'hs-ucp-swatches'
    for (const sw of HS_USER_COLOR_SWATCHES) {
      const cell = document.createElement('div')
      cell.className = 'hs-ucp-swatch'
      cell.style.background = sw
      cell.title = sw
      cell.addEventListener('click', () => {
        setUserColor(username, sw)
        closeUserColorPicker()
      })
      swatches.appendChild(cell)
    }
    el.appendChild(swatches)

    const row = document.createElement('div')
    row.className = 'hs-ucp-row'
    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    colorInput.value = current
    const hexInput = document.createElement('input')
    hexInput.type = 'text'
    hexInput.value = current
    hexInput.maxLength = 7
    hexInput.placeholder = '#fff'
    colorInput.addEventListener('input', () => {
      hexInput.value = colorInput.value
    })
    hexInput.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) colorInput.value = hexInput.value
    })
    const applyBtn = document.createElement('button')
    applyBtn.textContent = 'set'
    applyBtn.addEventListener('click', () => {
      setUserColor(username, hexInput.value || colorInput.value)
      closeUserColorPicker()
    })
    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'clear'
    clearBtn.addEventListener('click', () => {
      setUserColor(username, null)
      closeUserColorPicker()
    })
    row.appendChild(colorInput)
    row.appendChild(hexInput)
    row.appendChild(applyBtn)
    row.appendChild(clearBtn)
    el.appendChild(row)

    document.body.appendChild(el)
    _ucpEl = el

    // Deferred one tick so the click that opened the picker doesn't immediately
    // trip the outside-click handler. closeUserColorPicker owns removal (via
    // _ucpOffClick) AND cancels this pending attach (via _ucpAttachTimer), so a
    // reopen before the tick fires can't strand off1 as a permanent document
    // listener — the bug this whole path guards against.
    _ucpAttachTimer = setTimeout(() => {
      _ucpAttachTimer = null
      const off = (ev) => {
        if (!_ucpEl || _ucpEl.contains(ev.target)) return
        closeUserColorPicker()
      }
      _ucpOffClick = off
      document.addEventListener('mousedown', off, true)
    }, 0)
  }

  // Predictions/polls chip — fed by MAIN-world GQL captures
  let _eventChipEl = null
  let _eventChipDismissTimer = null
  function closeEventChip() {
    if (_eventChipEl) {
      _eventChipEl.remove()
      _eventChipEl = null
    }
    cleanup.clearTimeout(_eventChipDismissTimer)
    _eventChipDismissTimer = null
  }
  function renderEventChip({ kind, title, rows }) {
    closeEventChip()
    const el = document.createElement('div')
    el.className = 'hs-event-chip'

    const close = document.createElement('span')
    close.className = 'hs-event-close'
    close.textContent = '×'
    close.addEventListener('click', closeEventChip)
    el.appendChild(close)

    const t = document.createElement('div')
    t.className = 'hs-event-title'
    t.textContent = (kind === 'poll' ? '📊 poll · ' : '🎯 prediction · ') + (title || '(active)')
    el.appendChild(t)

    for (const r of (rows || []).slice(0, 8)) {
      const row = document.createElement('div')
      row.className = 'hs-event-row'
      const lbl = document.createElement('span')
      lbl.textContent = r.label || ''
      const val = document.createElement('span')
      val.textContent = r.value || ''
      row.appendChild(lbl)
      row.appendChild(val)
      el.appendChild(row)
    }

    document.body.appendChild(el)
    _eventChipEl = el
    _eventChipDismissTimer = cleanup.setTimeout(closeEventChip, 5 * 60 * 1000)
  }
  function renderEventChipFromGql(op, data) {
    if (!data || typeof data !== 'object') return
    // Best-effort shape extraction — Twitch GQL shapes vary
    const u = data.user || data.channel || data
    const event = u?.predictionEvent || u?.activePoll || data?.event || data?.poll || data?.prediction
    if (!event) return
    const isPoll = /Poll/i.test(op) || event.choices
    if (isPoll) {
      const choices = event.choices || []
      const total = choices.reduce((s, c) => s + (c.totalVotes || c.votes || 0), 0) || 1
      const rows = choices.map((c) => ({
        label: (c.title || c.text || '').slice(0, 32),
        value: `${(((c.totalVotes || c.votes || 0) / total) * 100).toFixed(0)}%`,
      }))
      renderEventChip({ kind: 'poll', title: (event.title || '').slice(0, 64), rows })
      return
    }
    // Prediction shape
    const outcomes = event.outcomes || []
    const totalPts = outcomes.reduce((s, o) => s + (o.totalPoints || 0), 0) || 1
    const rows = outcomes.map((o) => ({
      label: (o.title || '').slice(0, 32),
      value: `${(((o.totalPoints || 0) / totalPts) * 100).toFixed(0)}%`,
    }))
    renderEventChip({ kind: 'prediction', title: (event.title || '').slice(0, 64), rows })
  }

  // FFZ/BTTV modifier WYSIWYG preview in chat input box.
  // As the user types `Kappa w! h! ffzX c!#888`, the inserted Kappa <img>
  // inside `.wysiwig-chat-input-emote` previews wide+tall+flipped+tinted live.
  const HS_INPUT_EMOTE_SELECTOR = '.wysiwig-chat-input-emote, span[data-slate-node="element"][data-slate-void]'
  const HS_INPUT_EDITOR_SELECTOR = '[data-slate-editor="true"], .chat-wysiwyg-input__editor, [data-testid="chat-input"]'
  // Walk forward from emoteSpan and collect modifier text nodes (until the next emote).
  // Returns { mods, hue, modTextElements } — elements are the parent spans we need to chip-style.
  function _hsCollectModsAfterSpan(emoteSpan) {
    const out = { mods: [], hue: null, modTextElements: [], plainTextEncountered: false }
    const block = emoteSpan.closest('p, [data-slate-node="element"]:not([data-slate-void])') || emoteSpan.parentElement
    if (!block) return out
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let n = walker.nextNode()
    let found = false
    while (n) {
      if (n === emoteSpan) {
        found = true
      } else if (found) {
        if (n.nodeType === 1 && n !== emoteSpan && n.matches?.(HS_INPUT_EMOTE_SELECTOR)) break
        if (n.nodeType === 3) {
          const tx = (n.textContent || '').trim()
          if (!tx) {
            n = walker.nextNode()
            continue
          }
          // Try parsing tokens; stop at first non-modifier
          const tokens = tx.split(/\s+/).filter(Boolean)
          let allConsumed = true
          for (const tok of tokens) {
            if (HS_MODIFIER_CLASSES[tok]) {
              out.mods.push(HS_MODIFIER_CLASSES[tok])
              continue
            }
            const m = tok.match(HS_C_HEX_RE)
            if (m) {
              out.hue = hsHexToHueDeg(m[1])
              continue
            }
            allConsumed = false
            break
          }
          if (allConsumed) {
            // Mark for chip styling — entire text is modifiers
            if (n.parentElement) out.modTextElements.push(n.parentElement)
          } else {
            out.plainTextEncountered = true
            break
          }
        }
      }
      n = walker.nextNode()
    }
    return out
  }

  function applyInputModifierPreview(editor) {
    if (!editor || !_uiPrefs.emoteModifiers) return
    const spans = editor.querySelectorAll(HS_INPUT_EMOTE_SELECTOR)
    for (const span of spans) {
      const img = span.querySelector('img')
      if (!img) continue
      const { mods, hue, modTextElements } = _hsCollectModsAfterSpan(span)
      const key = `${mods.join(',')}|${hue == null ? '' : hue}`
      if (span.dataset.hsModCache === key) continue
      span.dataset.hsModCache = key

      // Reset previous mod styles on this span/img
      span.style.removeProperty('transform')
      span.style.removeProperty('transform-origin')
      span.style.removeProperty('margin-left')
      span.style.removeProperty('margin-right')
      span.style.removeProperty('margin-top')
      span.style.removeProperty('margin-bottom')
      span.style.removeProperty('--hs-mod-scale')
      img.style.removeProperty('filter')

      if (!mods.length && hue == null) {
        // Restore any previously-chipped mod-text spans we no longer recognize
        continue
      }

      // Multiset compose then clamp at ±4x per axis (layout limit)
      let sx = 1,
        sy = 1,
        filter = ''
      for (const m of mods) {
        if (m === 'wide') sx *= 2
        else if (m === 'tall') sy *= 2
        else if (m === 'hflip') sx *= -1
        else if (m === 'vmirror') sy *= -1
      }
      sx = Math.min(Math.max(sx, -4), 4)
      sy = Math.min(Math.max(sy, -4), 4)
      if (mods.includes('cursed')) filter += ' hue-rotate(45deg) saturate(2)'
      if (hue != null) filter += ` hue-rotate(${hue}deg) saturate(1.6)`

      // Apply transform to the WRAPPER span (so all visual artifacts scale together)
      if (sx !== 1 || sy !== 1) {
        span.style.setProperty('transform', `scale(${sx}, ${sy})`, 'important')
        span.style.setProperty('transform-origin', 'center', 'important')
        const fx = Math.abs(sx),
          fy = Math.abs(sy)
        if (fx > 1) {
          const halfX = `calc(1em * ${(fx - 1) / 2})`
          span.style.setProperty('margin-left', halfX, 'important')
          span.style.setProperty('margin-right', halfX, 'important')
        }
        if (fy > 1) {
          const halfY = `calc(1em * ${(fy - 1) / 2})`
          span.style.setProperty('margin-top', halfY, 'important')
          span.style.setProperty('margin-bottom', halfY, 'important')
        }
        span.style.setProperty('--hs-mod-scale', String(Math.max(fx, fy)))
      }
      if (filter.trim()) img.style.setProperty('filter', filter, 'important')

      // Style the modifier text as an invisible chip + make non-editable so
      // it merges with the preceding emote — single backspace removes both.
      for (const el of modTextElements) {
        el.classList.add('hs-input-mod-chip')
        el.setAttribute('contenteditable', 'false')
        el.dataset.hsModChipText = el.textContent || ''
      }
    }
    // Clean stale chips: any element with the chip class whose text is no longer
    // a pure modifier sequence gets reset.
    editor.querySelectorAll('.hs-input-mod-chip').forEach((el) => {
      const tx = (el.textContent || '').trim()
      const tokens = tx.split(/\s+/).filter(Boolean)
      const allMods = tokens.length && tokens.every((t) => HS_MODIFIER_CLASSES[t] || HS_C_HEX_RE.test(t))
      if (!allMods) el.classList.remove('hs-input-mod-chip')
    })

    // Zero-width overlay stacking in input — when a known-overlay emote (rain0,
    // hat0, RainTime, cvMask, etc.) sits AFTER another emote, pull it back over
    // the previous emote with negative margin so it visually overlays.
    // Walk through emote spans in order; track previous BASE.
    let prevBaseSpan = null
    const allInputEmotes = editor.querySelectorAll(HS_INPUT_EMOTE_SELECTOR)
    for (const span of allInputEmotes) {
      const img = span.querySelector('img')
      const name = img?.alt || ''
      const isOverlayName = _hsIsLikelyOverlayName(name)
      if (isOverlayName && prevBaseSpan) {
        span.classList.add('hs-input-overlay-on-prev')
      } else {
        span.classList.remove('hs-input-overlay-on-prev')
        prevBaseSpan = span
      }
    }
  }
  // Hardcoded zero-width / known-overlay heuristic for input
  const HS_KNOWN_OVERLAY_NAMES = new Set([
    'RainTime',
    'IceCold',
    'cvMask',
    'cvHazmat',
    'SoSnowy',
    'SantaHat',
    'ReinDeer',
    'TombStone',
    'HypeChat',
    'Hyperextend',
    '3Below',
    'TwitchVibes',
    'SoCool',
    'CandyCane',
    'Holidays',
    'Holiday',
    'withcoffee',
    'rain',
    'fog',
    'snow',
    'ash',
    'fire',
  ])
  function _hsIsLikelyOverlayName(name) {
    if (!name) return false
    if (HS_KNOWN_OVERLAY_NAMES.has(name)) return true
    // A real emote literally named "lerolero0" is standalone — honor only its
    // own zero-width flag, never the trailing-0 heuristic. Defer to the shared
    // detector when we have a direct cache hit.
    const direct = cachedAllEmotes?.get(name)
    if (direct) return isZeroWidthEmote(name, direct, cachedAllEmotes)
    // ends-with-0 convention: "rain0" → "rain" is the base, this is overlay.
    if (name.endsWith('0') && name.length > 1) return true
    return false
  }
  function applyInputModifiersToAllEditors() {
    document.querySelectorAll(HS_INPUT_EDITOR_SELECTOR).forEach(applyInputModifierPreview)
  }
  let _hsInputModRaf = 0
  function scheduleInputModifierPreview() {
    if (_hsInputModRaf) return
    _hsInputModRaf = requestAnimationFrame(() => {
      _hsInputModRaf = 0
      applyInputModifiersToAllEditors()
    })
  }
  cleanup.addEventListener(
    document,
    'input',
    (e) => {
      if (!_uiPrefs.emoteModifiers) return
      if (e.target.closest?.(HS_INPUT_EDITOR_SELECTOR)) scheduleInputModifierPreview()
    },
    'input-modifier-preview',
  )

  // Backspace handler: when cursor is right after a modifier chip,
  // delete the chip + the preceding emote atomically (single keypress).
  cleanup.addEventListener(
    document,
    'keydown',
    (e) => {
      if (!_uiPrefs.emoteModifiers) return
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      const editor = e.target.closest?.(HS_INPUT_EDITOR_SELECTOR)
      if (!editor) return
      const sel = window.getSelection?.()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return
      // Look for a chip immediately before cursor
      const node = range.startContainer
      let probe = null
      if (node.nodeType === 3 && range.startOffset === 0) {
        probe = node.previousSibling || node.parentElement?.previousSibling
      } else if (node.nodeType === 1) {
        probe = range.startOffset > 0 ? node.childNodes[range.startOffset - 1] : null
      }
      // Walk up to find a chip element
      while (probe && probe.nodeType === 1 && !probe.classList?.contains('hs-input-mod-chip')) {
        if (probe.querySelector?.('.hs-input-mod-chip')) break
        probe = probe.previousSibling
      }
      if (probe?.nodeType !== 1) return
      const chip = probe.classList?.contains('hs-input-mod-chip') ? probe : probe.querySelector?.('.hs-input-mod-chip')
      if (!chip) return
      // Found a chip — also find the preceding emote span to delete with it
      let prev = chip.previousSibling
      while (prev && !(prev.nodeType === 1 && prev.matches?.(HS_INPUT_EMOTE_SELECTOR))) {
        prev = prev.previousSibling
      }
      e.preventDefault()
      e.stopPropagation()
      // Remove chip + preceding emote in one go
      try {
        chip.remove()
        if (prev) prev.remove()
        scheduleInputModifierPreview()
        // Trigger Slate to re-normalize
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      } catch {}
    },
    { capture: true },
    // Capture on purpose: this stops propagation to keep Twitch's own
    // backspace handling from running, which only works ahead of it.
    'input-modifier-backspace',
  )
  cleanup.addEventListener(
    document,
    'keyup',
    (e) => {
      if (!_uiPrefs.emoteModifiers) return
      if (e.target.closest?.(HS_INPUT_EDITOR_SELECTOR)) scheduleInputModifierPreview()
    },
    'input-modifier-preview-keyup',
  )
  // Also catch programmatic changes (Slate void inserts) via observer
  const _hsInputObserver = cleanup.trackObserver(new MutationObserver(scheduleInputModifierPreview))
  function attachInputModifierObserver() {
    if (!_uiPrefs.emoteModifiers) return
    document.querySelectorAll(HS_INPUT_EDITOR_SELECTOR).forEach((ed) => {
      if (ed.dataset.hsInputModObserver) return
      ed.dataset.hsInputModObserver = '1'
      _hsInputObserver.observe(ed, { childList: true, subtree: true, characterData: true })
    })
  }
  cleanup.setTimeout(attachInputModifierObserver, 1500)
  cleanup.setInterval(attachInputModifierObserver, 5000)

  // Shared right-click menu state + placement/dismiss (used by the username menu).
  let _emoteMenuEl = null
  let _emoteMenuCleanup = null
  function closeEmoteMenu() {
    if (_emoteMenuEl) {
      _emoteMenuEl.remove()
      _emoteMenuEl = null
    }
    if (_emoteMenuCleanup) {
      try {
        _emoteMenuCleanup()
      } catch {}
      _emoteMenuCleanup = null
    }
  }
  // Shared placement + dismiss wiring for right-click menus (emote + message).
  // Measures off-screen, edge-flips, then wires mousedown/key/blur/scroll dismiss.
  function placeAndWireMenu(el, x, y, kbdHandlers = {}) {
    el.style.visibility = 'hidden'
    el.style.left = '0px'
    el.style.top = '0px'
    document.body.appendChild(el)
    _emoteMenuEl = el

    const mw = el.offsetWidth
    const mh = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const flipX = x + mw + 8 > vw
    const flipY = y + mh + 8 > vh
    const left = flipX ? Math.max(4, x - mw) : Math.min(x, vw - mw - 4)
    const top = flipY ? Math.max(4, y - mh) : Math.min(y, vh - mh - 4)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    if (flipX) el.classList.add('hs-em-flip-x')
    if (flipY) el.classList.add('hs-em-flip-y')
    el.style.visibility = ''
    try {
      el.focus({ preventScroll: true })
    } catch {}

    const onDown = (ev) => {
      if (!_emoteMenuEl || _emoteMenuEl.contains(ev.target)) return
      closeEmoteMenu()
    }
    const onKey = (ev) => {
      if (!_emoteMenuEl) return
      if (ev.key === 'Escape') {
        ev.preventDefault()
        closeEmoteMenu()
        return
      }
      const fn = kbdHandlers[ev.key]
      if (fn) {
        ev.preventDefault()
        try {
          fn()
        } catch {}
        closeEmoteMenu()
      }
    }
    const onScroll = () => closeEmoteMenu()
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('blur', closeEmoteMenu, { once: true })
      // No capture: a capturing scroll listener fires on the chat container's
      // constant auto-scroll, killing the menu the instant it opens. Menu is
      // position:fixed so it stays put — only dismiss on genuine window scroll.
      window.addEventListener('scroll', onScroll, { passive: true, once: true })
      _emoteMenuCleanup = () => {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('blur', closeEmoteMenu)
        window.removeEventListener('scroll', onScroll)
      }
    }, 0)
  }

  // Non-sensitive postMessage handlers (no tokens)
  cleanup.addEventListener(
    window,
    'message',
    async (event) => {
      if (event.source !== window) return
      if (event.origin !== window.location.origin) return

      if (event.data?.type === 'heatsync-settings-changed' && event.data.settings) {
        const expected = window.HS?.getMainWorldNonce?.()
        if (!expected || event.data.nonce !== expected) return
        log(' Settings changed via postMessage:', event.data.settings)
        applyUiSettings(event.data.settings)
      }

      // Native Twitch emotes from autocomplete-hook.js (MAIN world) — store for multichat.
      // Nonce not available here (autocomplete-hook.js has no nonce access); apply strict
      // payload validation instead: safe name charset, CDN-only URLs, array cap.
      if (event.data?.type === 'heatsync-native-emotes' && Array.isArray(event.data.emotes)) {
        const EMOTE_CDN_RE =
          /^https:\/\/(static-cdn\.jtvnw\.net\/emoticons|cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com)\//
        const EMOTE_NAME_RE = /^[A-Za-z0-9_:\-()]+$/
        const raw = event.data.emotes.slice(0, 2000) // cap array to 2000 entries
        const emotes = raw
          .filter(
            (e) =>
              e &&
              typeof e.name === 'string' &&
              e.name.length >= 1 &&
              e.name.length <= 64 &&
              EMOTE_NAME_RE.test(e.name) &&
              (!e.url || (typeof e.url === 'string' && e.url.length <= 300 && EMOTE_CDN_RE.test(e.url))),
          )
          // Rebuild fresh whitelisted objects — never store page-supplied objects
          // verbatim (extra fields = storage bloat + fake owned-emote injection).
          .map((e) => {
            const out = { name: e.name }
            if (e.url) out.url = e.url
            if (typeof e.hash === 'string' && /^[\w-]{1,100}$/.test(e.hash)) out.hash = e.hash
            if (typeof e.owner === 'string' && /^\w{1,25}$/.test(e.owner)) out.owner = e.owner
            if (out.owner && typeof e.ownerDisplay === 'string' && e.ownerDisplay.length <= 50) {
              out.ownerDisplay = e.ownerDisplay
            }
            if (typeof e.tier === 'string' && /^[a-z0-9]{1,16}$/i.test(e.tier)) out.tier = e.tier
            return out
          })
        log(' Received', emotes.length, 'native Twitch emotes from MAIN world')
        chrome.storage.local.set({ native_twitch_emotes: emotes })
      }

      // Predictions/polls chip from MAIN-world GQL interception
      if (event.data?.type === 'heatsync-gql-data' && _uiPrefs.showPredictionsChip) {
        const expected = window.HS?.getMainWorldNonce?.()
        if (!expected || event.data.nonce !== expected) return
        const op = String(event.data.operation || '')
        if (/Prediction|Poll/i.test(op)) {
          try {
            renderEventChipFromGql(op, event.data.data)
          } catch {}
        }
      }
    },
    'auth-message-handler',
  )

  // Inject CSS for emote hover effects (full emote background like website)
  const style = document.createElement('style')
  style.id = 'heatsync-emote-styles'
  style.textContent = `
  /* CSS containment localizes layout/paint changes to a single message —
     when a badge or paint is applied async, only that message reflows. */
  .chat-line__message {
    contain: layout style;
  }

  /* Backfilled messages — slightly dimmed to distinguish from live */
  .heatsync-backfill {
    opacity: 0.85 !important;
    padding: 5px 20px !important;
    line-height: 20px !important;
    font-size: 13px !important;
  }
  .heatsync-backfill .chat-author__display-name {
    font-weight: 700 !important;
    font-size: 13px !important;
  }
  .heatsync-backfill .text-fragment {
    font-size: 13px !important;
    color: #fff !important;
  }

  /* Heatsync emote base styles */
  .heatsync-emote-wrapper {
    position: relative !important;
    display: inline-block !important;
    vertical-align: middle !important;
    line-height: 0 !important;
    font-size: 0 !important;
  }
  .heatsync-emote-wrapper > img {
    display: block !important;
    width: auto !important;
    height: auto !important;
    max-width: none !important;
    max-height: none !important;
    /* Lift the emote above the hover ::before plate (wrapper z1, stack z3) so
       it shows in full color on the gray hover bg instead of being hidden. */
    position: relative !important;
    z-index: 4 !important;
  }
  .heatsync-emote-wrapper.heatsync-own-emote > img {
    height: var(--hs-emote-height, 28px) !important;
  }
  .heatsync-emote-wrapper.heatsync-overlay > img {
    height: auto !important;
  }

  /* Tighten gap between consecutive heatsync emotes (e.g. "eel1 eel2 eel3")
     so the run reads as one continuous image instead of spaced-out tiles.
     Negative margin pulls the wrapper over the preceding whitespace text node. */
  .heatsync-emote-wrapper + .heatsync-emote-wrapper,
  .heatsync-emote-wrapper + .heatsync-emote-stack,
  .heatsync-emote-stack + .heatsync-emote-wrapper,
  .heatsync-emote-stack + .heatsync-emote-stack {
    margin-left: -3px !important;
  }

  /* Emote cursor */
  img[src*="cdn.7tv.app"],
  img[src*="cdn.betterttv.net"],
  img[src*="cdn.frankerfacez.com"] {
    cursor: pointer !important;
  }

  /* Locally name-blocked emotes — fully hidden but kept in flow (not display:none)
     so the element stays right-clickable for unblock; a dim/grayscale image was
     still legible for gore/NSFW content, which defeats the point of blocking. */
  img[data-hs-name-blocked] {
    opacity: 0 !important;
    filter: grayscale(1) !important;
    cursor: pointer !important;
  }

  /* Blocked emotes - gray outline always visible (compensate for modifier scale via --hs-mod-scale) */
  img[data-heatsync-state="blocked"] {
    outline: calc(2px / var(--hs-mod-scale, 1)) solid #7f7f7f !important;
    outline-offset: calc(-2px / var(--hs-mod-scale, 1)) !important;
  }

  /* Blocked emotes - subtle gray outline normally
     Outline width inverse-scales with modifier transform so visual stays 2px
     even when wrapper has scale(2,1) etc. */
  .heatsync-emote-wrapper.emote-overlay-blocked > img.heatsync-emote {
    opacity: 0 !important;
    outline: calc(2px / var(--hs-mod-scale, 1)) dashed #7f7f7f !important;
    outline-offset: calc(-2px / var(--hs-mod-scale, 1)) !important;
  }

  /* Blocked emotes inside expanded stacks - keep dimensions locked so layout doesn't shift */
  .heatsync-emote-stack.expanded .heatsync-emote-wrapper.emote-overlay-blocked {
    min-width: var(--hs-emote-width, 28px) !important;
    min-height: var(--hs-emote-height, 28px) !important;
  }

  /* Blocked emotes - white outline when expanded (managing) */
  .heatsync-emote-stack.expanded .heatsync-emote-wrapper.emote-overlay-blocked > img.heatsync-emote {
    outline-color: #fff !important;
  }

  /* Emote preview tooltip - OUR ONLY TOOLTIP (minimal Chatterino style) */
  .heatsync-emote-preview {
    position: fixed !important;
    z-index: 5000 !important;
    pointer-events: none !important;
    background: #000000 !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 6px !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.6) !important;
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    display: none !important; /* Hidden by default, shown on hover */
  }

  .heatsync-emote-preview img {
    display: block !important;
    object-fit: contain !important;
    margin: 0 auto !important;
    image-rendering: pixelated !important;
  }

  .heatsync-emote-preview-name {
    color: #fff !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    text-align: center !important;
    margin-top: 4px !important;
    font-family: Inter, -apple-system, system-ui, sans-serif !important;
  }

  /* Stacked emotes preview - horizontal layout */
  .heatsync-stacked-preview {
    display: flex !important;
    flex-direction: row !important;
    gap: 12px !important;
    align-items: flex-start !important;
  }

  .heatsync-stacked-emote-item {
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
  }

  .heatsync-stacked-emote-item img {
    display: block !important;
    max-width: 128px !important;
    max-height: 128px !important;
    width: auto !important;
    height: auto !important;
    object-fit: contain !important;
  }

  /* ============================================ */
  /* HEAT MESSAGE BORDERS (by heat tier)          */
  /* ============================================ */
  @keyframes hs-heat-breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.85; }
  }
  /* Pause our infinite heat-breathe animation when the host page is
     hidden. Scoped to chat-line messages that we've decorated, not
     the whole document — universal selector against twitch's massive
     subtree caused selector-match thrash. */
  body.hs-ext-hidden .chat-line__message[data-hs-heat-applied] {
    animation-play-state: paused !important;
  }

  /* ============================================ */
  /* PROFILE CARD (username click)               */
  /* ============================================ */
  .hs-profile-card {
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #808080 !important;
    border: 1px solid #404040 !important;
    border-radius: 0 !important;
    padding: 10px 6px 6px 6px !important;
    display: flex !important;
    align-items: flex-start !important;
    gap: 6px !important;
    font-family: 'Courier New', Courier, monospace !important;
    font-size: 13px !important;
    color: #fff !important;
    max-width: 400px !important;
    min-width: 200px !important;
    box-shadow: 0 4px 12px rgba(0,0,0,0.6) !important;
    transition: none !important;
    cursor: grab !important;
  }
  .hs-profile-card:active { cursor: grabbing !important; }
  .hs-profile-card a, .hs-profile-card button { cursor: pointer !important; }

  .hs-pc-close {
    position: absolute !important;
    top: 2px !important;
    right: 4px !important;
    background: none !important;
    border: none !important;
    color: #fff !important;
    font-size: 14px !important;
    cursor: pointer !important;
    padding: 0 4px !important;
    line-height: 1 !important;
    font-family: monospace !important;
  }

  .hs-pc-avatar {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    border-radius: 0 !important;
    border: 1px solid #000 !important;
    object-fit: cover !important;
    flex-shrink: 0 !important;
  }

  .hs-pc-info {
    flex: 1 !important;
    min-width: 0 !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
  }

  .hs-pc-header-line,
  .hs-pc-stats-line,
  .hs-pc-actions {
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    flex-wrap: wrap !important;
    line-height: 1.2 !important;
  }

  .hs-pc-platform {
    padding: 1px 2px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
    white-space: nowrap !important;
  }
  .hs-pc-platform.twitch {
    background: #9146ff !important;
    color: #fff !important;
    border: 1px solid #000 !important;
  }
  .hs-pc-platform.kick {
    background: #53fc18 !important;
    color: #000 !important;
    border: 1px solid #000 !important;
  }

  .hs-pc-name {
    font-size: 14px !important;
    font-weight: 600 !important;
    background: #fff !important;
    color: #000 !important;
    border: 1px solid #000 !important;
    padding: 2px 3px !important;
    border-radius: 0 !important;
    box-shadow: 0 1px 1px rgba(0,0,0,0.3) !important;
    white-space: nowrap !important;
  }

  .hs-pc-role {
    padding: 2px 3px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
    white-space: nowrap !important;
  }
  .hs-pc-role.admin { background: #ff0000 !important; color: #fff !important; border: 1px solid #000 !important; }
  .hs-pc-role.staff { background: #ff8700 !important; color: #000 !important; border: 1px solid #000 !important; }
  .hs-pc-role.partner { background: #000 !important; color: #fff !important; border: 1px solid #fff !important; }
  .hs-pc-role.affiliate { background: #404040 !important; color: #fff !important; border: 1px solid #fff !important; }
  .hs-pc-role.sub-status { background: #9146ff !important; color: #fff !important; border: 1px solid #6b30d4 !important; }

  .hs-pc-age {
    padding: 2px 3px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    background: #ffff00 !important;
    color: #000 !important;
    border: 1px solid #000 !important;
    letter-spacing: 0.3px !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
    white-space: nowrap !important;
  }

  .hs-pc-verified {
    display: inline-block !important;
    width: 14px !important;
    height: 14px !important;
    vertical-align: middle !important;
    margin-left: 2px !important;
    background: none !important;
    border: none !important;
    box-shadow: none !important;
    padding: 0 !important;
  }
  .hs-pc-verified svg {
    width: 14px !important;
    height: 14px !important;
    display: block !important;
  }

  .hs-pc-live {
    background: #ff0000 !important;
    color: #fff !important;
    padding: 2px 3px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    border: 1px solid #000 !important;
    letter-spacing: 0.3px !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
    white-space: nowrap !important;
  }
  .hs-pc-live-kick {
    background: #53fc18 !important;
    color: #000 !important;
  }

  .hs-pc-subbed {
    background: #9146ff !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }

  .hs-pc-follows-you {
    background: #00aaaa !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-following {
    background: #5f87ff !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-subs-you {
    background: #fff !important;
    color: #000 !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-mutual-follow {
    background: #000 !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border: 1px solid #00aaaa !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-mutual-sub {
    background: #000 !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border: 1px solid #fff !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-followage {
    background: #00aa00 !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-followage.hs-pc-nofollow {
    background: transparent !important;
    color: #808080 !important;
    border: 1px solid #000 !important;
  }
  .hs-pc-channel-follows {
    background: #daa520 !important;
    color: #000 !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-sub-tenure {
    background: #e91e8c !important;
    color: #fff !important;
    padding: 2px 4px !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    font-weight: 900 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
  }
  .hs-pc-bio {
    color: #fff !important;
    font-size: 11px !important;
    margin-top: 4px !important;
    max-width: 250px !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    display: -webkit-box !important;
    -webkit-line-clamp: 2 !important;
    -webkit-box-orient: vertical !important;
  }

  .hs-pc-heat {
    background: #000 !important;
    border: 1px solid #fff !important;
    font-weight: 900 !important;
    font-size: 12px !important;
    padding: 2px 6px !important;
    border-radius: 0 !important;
    white-space: nowrap !important;
  }

  .hs-pc-op, .hs-pc-re {
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    background: transparent !important;
    color: #fff !important;
    padding: 0 6px !important;
    height: 20px !important;
    border-radius: 0 !important;
    font-size: 11px !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    letter-spacing: 0.3px !important;
  }
  .hs-pc-op { border: 1px solid #ff0000 !important; }
  .hs-pc-re { border: 1px solid #00ffff !important; }
  .hs-pc-badge-op { color: #ff0000 !important; }
  .hs-pc-badge-re { color: #00ffff !important; }

  .hs-pc-followers {
    background: #000 !important;
    color: #fff !important;
    border: 1px solid #808080 !important;
    padding: 2px 6px !important;
    border-radius: 0 !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    white-space: nowrap !important;
  }

  .hs-pc-streak {
    background: #000 !important;
    color: #fff !important;
    border: 1px solid #fff !important;
    padding: 2px 6px !important;
    border-radius: 0 !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    white-space: nowrap !important;
  }

  .hs-pc-actions {
    margin-top: 4px !important;
    gap: 6px !important;
  }

  .hs-pc-actions a {
    color: #ffff00 !important;
    font-size: 10px !important;
    text-decoration: none !important;
    font-family: monospace !important;
  }
  .hs-pc-actions a:hover { background: #fff !important; color: #000 !important; }

  .hs-pc-actions button {
    background: #808080 !important;
    color: #fff !important;
    border: 1px solid #808080 !important;
    border-radius: 0 !important;
    padding: 1px 6px !important;
    font-size: 10px !important;
    font-family: monospace !important;
    cursor: pointer !important;
    transition: none !important;
  }
  .hs-pc-actions button:hover { background: #fff !important; color: #000 !important; }

  .hs-pc-loading {
    color: #fff !important;
    font-style: italic !important;
    font-size: 11px !important;
    padding: 4px !important;
  }

  /* ============================================ */
  /* USER CARD — FULL TAKEOVER PANEL              */
  /* ============================================ */
  .hs-pc-panel {
    position: absolute !important;
    inset: 0 !important;
    z-index: 9999 !important;
    background: #000 !important;
    color: #fff !important;
    font-family: Inter, -apple-system, sans-serif !important;
    font-size: 13px !important;
    display: flex !important;
    flex-direction: column !important;
    overflow: hidden !important;
    cursor: default !important;
  }
  .hs-pc-panel * { box-sizing: border-box !important; }
  .hs-pc-panel a, .hs-pc-panel button { cursor: pointer !important; }

  .hs-pc-panel-header {
    flex: 0 0 auto !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 8px 10px !important;
    border-bottom: 1px solid #808080 !important;
    background: #000 !important;
  }
  .hs-pc-panel-header .hs-pc-panel-close {
    background: none !important;
    border: 1px solid #808080 !important;
    color: #fff !important;
    width: 24px !important;
    height: 24px !important;
    line-height: 1 !important;
    font-size: 16px !important;
    padding: 0 !important;
    cursor: pointer !important;
  }
  .hs-pc-panel-header .hs-pc-panel-close:hover {
    background: #fff !important;
    border-color: #fff !important;
    color: #000 !important;
  }
  .hs-pc-panel-header .hs-pc-panel-title {
    font-size: 13px !important;
    font-weight: 700 !important;
    color: #808080 !important;
    text-transform: uppercase !important;
    letter-spacing: 1px !important;
  }
  .hs-pc-panel-header .hs-pc-panel-name {
    font-size: 14px !important;
    font-weight: 700 !important;
    color: #fff !important;
    margin-left: auto !important;
  }

  .hs-pc-panel-body {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow: hidden !important;
    padding: 0 !important;
    display: flex !important;
    flex-direction: column !important;
  }

  /* Identity row inside panel */
  .hs-pc-panel-identity {
    display: flex !important;
    gap: 12px !important;
    padding: 12px !important;
    border-bottom: 1px solid #808080 !important;
    background: #000 !important;
  }
  .hs-pc-panel-identity .hs-pc-avatar {
    width: 64px !important;
    height: 64px !important;
    min-width: 64px !important;
    min-height: 64px !important;
    border: 1px solid #808080 !important;
  }
  .hs-pc-panel-identity .hs-pc-info {
    flex: 1 !important;
    gap: 4px !important;
  }

  /* Section blocks */
  .hs-pc-section {
    border-bottom: 1px solid #808080 !important;
    padding: 8px 12px !important;
  }
  .hs-pc-section-title {
    font-size: 10px !important;
    font-weight: 700 !important;
    color: #808080 !important;
    text-transform: uppercase !important;
    letter-spacing: 1px !important;
    margin-bottom: 6px !important;
  }
  .hs-pc-section-title .hs-pc-count {
    color: #fff !important;
    margin-left: 4px !important;
  }
  /* User note textarea — inline editable, terminal palette, square */
  .hs-pc-note-ta {
    display: block !important;
    width: 100% !important;
    box-sizing: border-box !important;
    background: #000 !important;
    color: #fff !important;
    border: 1px solid #333 !important;
    border-radius: 0 !important;
    padding: 6px 8px !important;
    margin: 0 !important;
    resize: vertical !important;
    min-height: 44px !important;
    font-family: inherit !important;
    font-size: 13px !important;
    line-height: 1.4 !important;
    outline: none !important;
  }
  .hs-pc-note-ta:focus { box-shadow: inset 0 0 0 1px #ff8700 !important; }
  .hs-pc-note-ta::placeholder { color: #555 !important; }

  /* Mod tools grid — groups stack vertically (timeout row, then hard actions row) */
  .hs-pc-mod-grid {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
  }
  .hs-pc-mod-grid .hs-pc-mod-group {
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    gap: 4px !important;
  }
  .hs-pc-mod-grid .hs-pc-mod-group-label {
    font-size: 10px !important;
    color: #808080 !important;
    margin-right: 4px !important;
  }
  .hs-pc-btn {
    background: #000 !important;
    color: #fff !important;
    border: 1px solid #808080 !important;
    padding: 4px 10px !important;
    font: inherit !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    border-radius: 0 !important;
    text-transform: lowercase !important;
    transition: none !important;
  }
  .hs-pc-btn:hover {
    background: #fff !important;
    color: #000 !important;
    border-color: #fff !important;
  }
  .hs-pc-btn.danger:hover {
    background: #fff !important;
    color: #000 !important;
    border-color: #fff !important;
  }
  .hs-pc-btn.subtle {
    border-color: #404040 !important;
    color: #808080 !important;
  }
  .hs-pc-btn.subtle:hover {
    background: #fff !important;
    color: #000 !important;
    border-color: #fff !important;
  }
  .hs-pc-follow-btn {
    border-color: #404040 !important;
    color: #808080 !important;
  }
  .hs-pc-follow-btn:hover:not(:disabled) {
    background: #fff !important;
    color: #000 !important;
    border-color: #fff !important;
  }
  .hs-pc-follow-btn.hs-pc-following {
    border-color: #fff !important;
    color: #fff !important;
  }
  .hs-pc-follow-btn.hs-pc-following:hover:not(:disabled) {
    background: #fff !important;
    color: #000 !important;
    border-color: #fff !important;
  }
  .hs-pc-follow-btn:disabled {
    opacity: 0.5 !important;
    cursor: default !important;
  }

  /* Message history */
  .hs-pc-history {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    overscroll-behavior: contain !important;
    padding: 4px 12px 12px !important;
    font-family: 'Courier New', Courier, monospace !important;
    font-size: 13px !important;
    line-height: 1.4 !important;
  }
  .hs-pc-history .hs-pc-history-empty {
    color: #808080 !important;
    font-style: italic !important;
    padding: 12px 0 !important;
  }
  .hs-pc-history .hs-pc-history-msg {
    display: flex !important;
    gap: 6px !important;
    padding: 2px 0 !important;
    border-bottom: 1px solid rgba(128,128,128,0.2) !important;
    word-break: break-word !important;
  }
  .hs-pc-history .hs-pc-history-time {
    color: #808080 !important;
    flex-shrink: 0 !important;
    font-size: 10px !important;
    font-variant-numeric: tabular-nums !important;
  }
  .hs-pc-history .hs-pc-history-text {
    color: #fff !important;
    flex: 1 !important;
  }
  .hs-pc-history .hs-pc-history-msg.system .hs-pc-history-text {
    color: #fff !important;
    font-style: italic !important;
  }

  /* Footer */
  .hs-pc-panel-footer {
    flex: 0 0 auto !important;
    display: flex !important;
    gap: 6px !important;
    padding: 8px 12px !important;
    border-top: 1px solid #808080 !important;
    background: #000 !important;
    flex-wrap: wrap !important;
  }

  /* Override identity styling inside panel for readability */
  .hs-pc-panel-identity .hs-pc-name { font-size: 18px !important; }
  .hs-pc-panel-identity .hs-pc-bio {
    color: #808080 !important;
    font-style: italic !important;
    margin-top: 4px !important;
    font-size: 11px !important;
  }

  /* NUCLEAR: Kill ALL native Twitch tooltips on heatsync emotes */
  .heatsync-emote-wrapper,
  .heatsync-emote-wrapper * {
    pointer-events: none !important;
  }

  /* But wrapper itself needs pointer events for our hover */
  .heatsync-emote-wrapper {
    pointer-events: auto !important;
  }

  /* NUCLEAR: Hide ALL Twitch tooltips when our preview is active - but ONLY inside chat message area */
  body.heatsync-preview-active .chat-scrollable-area__message-container .tw-tooltip-layer,
  body.heatsync-preview-active .chat-scrollable-area__message-container .tw-tooltip,
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="balloon"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="Tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [role="tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container .ScTokenTooltip-sc-,
  body.heatsync-preview-active .chat-scrollable-area__message-container [data-a-target*="tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="emote-tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="chat-image-tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container .Layout-sc-1xcs6mc-0[role="tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container [class*="ScTokenTooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container .InjectLayout-sc-1i43xsx-0[role="tooltip"],
  body.heatsync-preview-active .chat-scrollable-area__message-container div[data-popper-placement] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
    position: absolute !important;
    left: -9999px !important;
  }

  /* Scoped: only hide tooltip layer inside chat area when our preview is active */
  body.heatsync-preview-active .chat-scrollable-area__message-container .tw-tooltip-layer,
  body.heatsync-preview-active .chat-scrollable-area__message-container .tw-tooltip-layer * {
    display: none !important;
    visibility: hidden !important;
  }

  /* Suppress ALL hover backgrounds on heatsync emotes */
  .heatsync-emote-wrapper:hover,
  .heatsync-emote-wrapper *:hover,
  .chat-image__container:has(.heatsync-emote-wrapper):hover,
  .chat-line__message--emote-button:has(.heatsync-emote-wrapper):hover,
  [class*="emote"]:has(.heatsync-emote-wrapper):hover {
    background: transparent !important;
    background-color: transparent !important;
  }


  /* Wide emotes in chat input - force left alignment and no clipping */
  .wysiwig-chat-input-emote {
    overflow: visible !important;
    overflow-x: visible !important;
    overflow-y: visible !important;
  }

  .wysiwig-chat-input-emote .chat-image__container {
    overflow: visible !important;
    overflow-x: visible !important;
    overflow-y: visible !important;
    display: inline-flex !important;
    justify-content: flex-start !important;
    align-items: center !important;
    width: max-content !important;
  }

  /* Wide emotes: span/container must expand to fit image, left-aligned */
  .wysiwig-chat-input-emote {
    width: max-content !important;
    min-width: max-content !important;
    display: inline-block !important;
    overflow: visible !important;
    text-align: left !important;
  }
  .wysiwig-chat-input-emote img[data-heatsync-fixed="true"] {
    display: block !important;
    max-width: none !important;
    width: auto !important;
    height: 28px !important;
    margin: 0 !important;
    padding: 0 !important;
    transform: none !important;
    position: static !important;
    object-fit: contain !important;
    object-position: 0% 50% !important;
    float: none !important;
  }

  /* Hide the emote name label div inside input emotes (adds invisible height) */
  .wysiwig-chat-input-emote > div:last-child {
    display: none !important;
  }

  /* Loading indicator with coggers */
  /* Mention highlight - Chatterino-style dark red background on entire message.
     Dark blood-red so full-color Twitch usernames render on top. */
  .chat-line__message.hs-mentioned,
  .hs-mentioned,
  div.hs-mentioned,
  [class*="chat-line"].hs-mentioned,
  .chat-scrollable-area__message-container .hs-mentioned {
    background-color: #5c1212 !important;
    background: #5c1212 !important;
  }

  /* Emojis — scaled by --hs-emoji-scale (1/2/4x) from hs_emoji_size storage. */
  .heatsync-emoji {
    font-size: calc(1em * var(--hs-emoji-scale, 1)) !important;
    line-height: 1 !important;
    vertical-align: middle !important;
    display: inline-block !important;
  }

  /* Emote overlay stacking (7TV zero-width emotes) */
  .heatsync-emote-stack {
    display: inline-flex !important;
    position: relative !important;
    vertical-align: middle !important;
    align-items: center !important;
    justify-content: center !important;
    overflow: visible !important;
    transition: gap 0.12s ease, padding 0.12s ease, background 0.12s ease !important;
  }

  /* Force overflow visible on Twitch emote containers inside stacks */
  .heatsync-emote-stack .chat-line__message--emote-button,
  .heatsync-emote-stack .chat-line__message--emote-button *,
  .heatsync-emote-stack [class*="emote-button"],
  .heatsync-emote-stack [class*="emote-button"] * {
    overflow: visible !important;
  }

  /* Base emote in stack - sets the size */
  /* Note: collapse button (×) is first-child, so use :not(.heatsync-overlay) for base */
  .heatsync-emote-stack > .heatsync-emote-wrapper:not(.heatsync-overlay) {
    position: relative !important;
    z-index: 1 !important;
  }

  /* Overlay emotes - absolute positioned, centered on base */
  .heatsync-emote-stack > .heatsync-overlay,
  .heatsync-emote-stack > .heatsync-emote-wrapper.heatsync-overlay {
    position: absolute !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: auto !important;
    height: auto !important;
    z-index: 2 !important;
    /* Cancel the adjacent-emote -3px gap-pull above: the overlay is a
       .heatsync-emote-wrapper sibling of the base, so that rule matched it and
       shifted it 3px left of centre (on an absolutely-positioned box the margin
       applies as a full-px offset, not halved). Centring is done by left:50% +
       translate, so any margin just de-centres it. */
    margin-left: 0 !important;
    /* pointer-events: auto so wide overlays can be hovered directly */
    pointer-events: auto !important;
  }

  /* Overlay images keep native 1x size, no constraints */
  .heatsync-emote-stack > .heatsync-overlay img,
  .heatsync-emote-stack > .heatsync-emote-wrapper.heatsync-overlay img {
    width: auto !important;
    height: auto !important;
    max-width: none !important;
    max-height: none !important;
    object-fit: none !important;
  }

  /* Emote hover color status indicator via ::before.
     background-color transitions 250ms so block↔unblock during hover
     feels like a directional state shift (color flows in/out) rather than
     a snap. Opacity stays snappy (0.1s) for hover-in/hover-out. */
  .heatsync-emote-wrapper::before {
    content: '' !important;
    position: absolute !important;
    inset: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
    z-index: 1 !important;
    transition: opacity 0.1s, background-color 0.25s ease-out !important;
  }
  .heatsync-emote-wrapper:hover::before {
    opacity: 1 !important;
  }
  /* Darken the emote on the white hover plate (brightness 0.2 — dark shape on
     white, not a pure silhouette). Uniform with the overlay/picker/site. */
  .heatsync-emote-wrapper:hover > img {
    filter: brightness(0.2) !important;
  }
  /* 2-state model: every pasteable overlay tier (owned/global/unadded) gets a
     WHITE plate behind the emote (img lifted via z-index, darkened on top) —
     matches the multichat overlay + picker + site clickable convention. Only
     blocked has its own fill. */
  .heatsync-emote-wrapper.emote-overlay-owned::before,
  .heatsync-emote-wrapper.emote-overlay-global::before,
  .heatsync-emote-wrapper.emote-overlay-unadded::before { background: #fff !important; }
  .heatsync-emote-wrapper.emote-overlay-blocked::before { background: #ff0000 !important; }

  /* Collapsed stack: suppress per-wrapper hover overlays — show one unified
     overlay on the stack itself sized to the base emote (largest in the nest). */
  .heatsync-emote-stack:not(.expanded) .heatsync-emote-wrapper::before {
    display: none !important;
  }
  .heatsync-emote-stack:not(.expanded) .heatsync-emote-wrapper:hover > img {
    visibility: visible !important;
  }
  .heatsync-emote-stack:not(.expanded)::before {
    content: '' !important;
    position: absolute !important;
    inset: 0 !important;
    /* White hover plate behind the stack, matching the multichat overlay stack
       ::before. img is lifted above (z-index:4) and darkened (brightness 0.2 via
       the wrapper:hover rule) so it reads as a dark shape on white. */
    background: #fff !important;
    opacity: 0 !important;
    pointer-events: none !important;
    z-index: 3 !important;
    transition: opacity 0.1s !important;
  }
  .heatsync-emote-stack:not(.expanded):hover::before {
    opacity: 1 !important;
  }

  /* ============================================ */
  /* EMOTE STACK EXPAND/COLLAPSE (website parity) */
  /* ============================================ */

  /* Clickable indicator on collapsed stacks */
  .heatsync-emote-stack {
    cursor: pointer !important;
  }

  /* Collapsed stack count badge */
  .heatsync-emote-stack:not(.expanded)::after {
    content: attr(data-stack-count) !important;
    position: absolute !important;
    top: -4px !important;
    right: -6px !important;
    background: #fff !important;
    color: #000 !important;
    font-size: 9px !important;
    font-weight: bold !important;
    line-height: 1 !important;
    padding: 1px 3px !important;
    border-radius: 6px !important;
    z-index: 10 !important;
    pointer-events: none !important;
    opacity: 0 !important;
    transition: opacity 0.1s !important;
  }
  .heatsync-emote-stack:not(.expanded):hover::after {
    opacity: 1 !important;
  }

  /* Expanded state - spread emotes horizontally as an absolute popout
     so the wider expanded width doesn't push subsequent text to a new line.
     Anchored to the static position of the collapsed stack via auto left/top. */
  .heatsync-emote-stack.expanded {
    display: inline-flex !important;
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    align-items: center !important;
    gap: 6px !important;
    background: #000000 !important;
    border-radius: 4px !important;
    padding: 4px 8px !important;
    position: absolute !important;
    z-index: 100 !important;
  }

  /* When expanded, overlays become relative (side-by-side) */
  .heatsync-emote-stack.expanded > .heatsync-overlay,
  .heatsync-emote-stack.expanded > .heatsync-emote-wrapper.heatsync-overlay {
    position: relative !important;
    top: auto !important;
    left: auto !important;
    transform: none !important;
    pointer-events: auto !important;
    transition: position 0s, top 0s, left 0s, transform 0.12s ease !important;
  }


  /* Collapse button (×) - hidden by default */
  .heatsync-stack-collapse {
    display: none !important;
  }
  /* Show collapse button when expanded */
  .heatsync-emote-stack.expanded .heatsync-stack-collapse {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 16px !important;
    height: 16px !important;
    background: rgba(255,255,255,0.12) !important;
    color: #fff !important;
    border-radius: 0 !important;
    font-size: 12px !important;
    cursor: pointer !important;
    margin-right: 4px !important;
    flex-shrink: 0 !important;
    z-index: 10 !important;
    pointer-events: auto !important;
  }
  .heatsync-emote-stack.expanded .heatsync-stack-collapse:hover {
    background: #fff !important;
    color: #000 !important;
  }

  /* Block all button (⊘) - hidden by default */
  .heatsync-stack-block-all {
    display: none !important;
  }
  /* Show block-all button when expanded */
  .heatsync-emote-stack.expanded .heatsync-stack-block-all {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 16px !important;
    height: 16px !important;
    background: #7f0000 !important;
    color: #fff !important;
    border-radius: 0 !important;
    font-size: 10px !important;
    cursor: pointer !important;
    margin-left: 4px !important;
    flex-shrink: 0 !important;
    z-index: 10 !important;
    pointer-events: auto !important;
  }
  .heatsync-emote-stack.expanded .heatsync-stack-block-all:hover {
    background: #c00000 !important;
    color: #fff !important;
  }

  /* Username mention links — hover underline */
  .hs-username-colored,
  .hs-mention-colored {
    text-decoration: none !important;
    transition: text-decoration 0.1s !important;
  }
  .hs-username-colored:hover,
  .hs-mention-colored:hover {
    text-decoration: underline !important;
  }

  /* Muted users — grey username, hide all message content via CSS (React-safe) */
  .hs-user-muted .chat-author__display-name,
  .hs-user-muted [data-a-target="chat-message-username"],
  .hs-user-muted button.inline.font-bold {
    color: #808080 !important;
    background: none !important;
    -webkit-background-clip: unset !important;
    -webkit-text-fill-color: #808080 !important;
    animation: none !important;
    text-shadow: none !important;
  }
  /* Hide message body, text, emotes, links — everything after the username */
  .hs-user-muted [data-a-target="chat-line-message-body"],
  .hs-user-muted .text-fragment,
  .hs-user-muted .mention-fragment,
  .hs-user-muted .heatsync-emote-wrapper,
  .hs-user-muted .heatsync-emote-stack,
  .hs-user-muted .link-fragment,
  .hs-user-muted span.font-normal,
  .hs-user-muted .chat-line__message--emote-button,
  .hs-user-muted [class*="emote-button"] {
    display: none !important;
  }

  /* Timed-out / banned user messages — dimmed but visible */
  .hs-timed-out {
    opacity: 0.5 !important;
  }

  /* Third-party cosmetic badges (BTTV/FFZ/7TV) */
  .hs-cosmetic-badge {
    /* !important + max-* so the site's native chat image CSS can't balloon
       these in lite mode (native chat has no competing CSS in the overlay,
       so the bug only showed with the panel off). */
    display: inline-block !important;
    width: 18px !important;
    height: 18px !important;
    max-width: 18px !important;
    max-height: 18px !important;
    vertical-align: middle !important;
    margin-right: 2px !important;
    cursor: default !important;
  }

  /* Badge hover tooltip — 4x preview with name */
  #hs-badge-tooltip {
    position: fixed;
    z-index: 999999;
    background: #000;
    border: 2px solid #808080;
    border-radius: 0;
    padding: 8px;
    pointer-events: none;
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.6);
  }
  #hs-badge-tooltip.active {
    display: flex;
  }
  #hs-badge-tooltip img {
    display: block !important;
    width: 72px !important;
    height: 72px !important;
    object-fit: contain;
    image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
  }
  #hs-badge-tooltip .hs-badge-tooltip-name {
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  #hs-badge-tooltip .hs-badge-tooltip-source {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    margin: 2px -8px -8px;
    width: calc(100% + 16px);
    text-align: center;
    background: #808080;
    color: #fff;
  }

  /* FFZ-style emote modifiers (w! h! ffzX ffzY c!#hex etc.) */
  .heatsync-emote-wrapper.heatsync-mod-wide { padding-right: 1ch !important; }
  .heatsync-emote-wrapper.heatsync-mod-tall { vertical-align: top !important; }

  /* Modifier text in chat input — fully hidden (transparent + zero-size).
     The modifier still exists in the Slate model so backspace/edit work,
     but it takes zero visual space → next emote (raintime overlay) sits
     directly adjacent to the actual emote, not past a "w!" placeholder. */
  .hs-input-mod-chip {
    display: inline-block !important;
    font-size: 0 !important;
    line-height: 0 !important;
    width: 0 !important;
    height: 0 !important;
    color: transparent !important;
    opacity: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    vertical-align: middle !important;
    user-select: text !important;
    pointer-events: none !important;
  }
  /* Zero-width overlay emotes in input — pull the next emote back over
     the previous one so it visually stacks (raintime sits over Kappa). */
  .wysiwig-chat-input-emote.hs-input-overlay-on-prev {
    margin-left: calc(-1 * var(--hs-emote-width, 28px)) !important;
    position: relative !important;
    z-index: 2 !important;
    pointer-events: none !important;
  }
  .heatsync-emote-wrapper.heatsync-mod-cursed > img {
    animation: hs-mod-cursed 1.2s linear infinite !important;
  }
  @keyframes hs-mod-cursed {
    0%   { filter: hue-rotate(0deg)   saturate(1.4); }
    25%  { filter: hue-rotate(90deg)  saturate(1.4); }
    50%  { filter: hue-rotate(180deg) saturate(1.4); }
    75%  { filter: hue-rotate(270deg) saturate(1.4); }
    100% { filter: hue-rotate(360deg) saturate(1.4); }
  }

  /* Custom keyword highlight (BTTV/FFZ-style) */
  .chat-line__message.hs-keyword-match,
  .hs-keyword-match {
    background-color: rgba(255,255,255,0.08) !important;
    box-shadow: inset 0 0 0 1px #808080 !important;
  }

  /* Show deleted/timeout messages (toggle .hs-show-cleared on <html>) */
  .hs-show-cleared .chat-line__message--deleted,
  .hs-show-cleared [class*="chat-line__message"][class*="deleted"],
  .hs-show-cleared .chat-line__message--moderated {
    display: block !important;
    opacity: 0.55 !important;
  }
  .hs-show-cleared .chat-line__message--deleted *,
  .hs-show-cleared [class*="chat-line__message"][class*="deleted"] * {
    text-decoration: line-through !important;
  }

  /* Per-user color override (right-click username → set color) */
  .hs-user-colored {
    color: var(--hs-user-color, inherit) !important;
  }

  /* User color picker popup */
  #hs-user-color-picker {
    position: fixed; z-index: 2147483646;
    background: #000; color: #fff;
    border: 1px solid #fff;
    padding: 8px; min-width: 220px;
    font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6);
  }
  #hs-user-color-picker .hs-ucp-header {
    font-size: 11px; opacity: 0.8; margin-bottom: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #hs-user-color-picker .hs-ucp-swatches {
    display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; margin-bottom: 6px;
  }
  #hs-user-color-picker .hs-ucp-swatch {
    width: 20px; height: 20px; cursor: pointer;
    border: 1px solid #444;
  }
  #hs-user-color-picker .hs-ucp-swatch:hover { border-color: #fff; }
  #hs-user-color-picker .hs-ucp-row { display: flex; gap: 4px; }
  #hs-user-color-picker input[type=color] { width: 32px; height: 24px; padding: 0; border: 1px solid #444; background: #000; }
  #hs-user-color-picker input[type=text] { flex: 1; background: #000; color: #fff; border: 1px solid #444; padding: 2px 4px; font-family: inherit; font-size: 11px; }
  #hs-user-color-picker button {
    background: #000; color: #fff; border: 1px solid #444;
    padding: 2px 8px; cursor: pointer; font: inherit;
  }
  #hs-user-color-picker button:hover { background: #fff; color: #000; }

  /* Right-click username menu */
  .hs-ctx-menu {
    position: fixed; z-index: 2147483646;
    background: #000; color: #fff;
    border: 1px solid #fff;
    padding: 0; min-width: 220px; max-width: 280px;
    font-family: ui-monospace, Menlo, monospace; font-size: 13px;
    box-shadow: 0 6px 32px rgba(0,0,0,0.75);
    animation: hs-em-in 80ms ease-out;
    transform-origin: top left;
  }
  @keyframes hs-em-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .hs-ctx-menu.hs-em-flip-x { transform-origin: top right; }
  .hs-ctx-menu.hs-em-flip-y { transform-origin: bottom left; }
  .hs-ctx-menu.hs-em-flip-x.hs-em-flip-y { transform-origin: bottom right; }
  .hs-ctx-menu .hs-em-header {
    padding: 4px 10px; font-size: 10px; color: #666;
    text-transform: uppercase; letter-spacing: 0.5px;
    background: #050505;
  }
  .hs-ctx-menu .hs-em-item {
    padding: 6px 10px; cursor: pointer; user-select: none;
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
  }
  .hs-ctx-menu .hs-em-item:hover { background: #fff; color: #000; }
  .hs-ctx-menu .hs-em-item:hover .hs-em-kbd { background: #000; color: #fff; border-color: #000; }
  .hs-ctx-menu .hs-em-item.hs-em-danger { color: #ff0000; }
  .hs-ctx-menu .hs-em-item.hs-em-danger:hover { background: #fff; color: #000; }
  .hs-ctx-menu .hs-em-item.hs-em-good { color: #00ff00; }
  .hs-ctx-menu .hs-em-item.hs-em-good:hover { background: #fff; color: #000; }
  .hs-ctx-menu .hs-em-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hs-ctx-menu .hs-em-kbd {
    display: inline-block; min-width: 14px; padding: 0 4px;
    border: 1px solid #333; background: #0a0a0a; color: #888;
    font-size: 10px; line-height: 14px; text-align: center;
  }
  .hs-ctx-menu .hs-em-sep { height: 1px; background: #1a1a1a; margin: 2px 0; }

  /* Predictions/polls chip */
  .hs-event-chip {
    position: fixed; right: 12px; bottom: 12px;
    z-index: 9999;
    background: #000; color: #fff;
    border: 1px solid #fff;
    padding: 6px 10px;
    font-family: ui-monospace, Menlo, monospace; font-size: 13px;
    max-width: 280px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.6);
  }
  .hs-event-chip .hs-event-title { font-weight: 600; margin-bottom: 4px; }
  .hs-event-chip .hs-event-row {
    display: flex; justify-content: space-between; gap: 8px;
    padding: 1px 0; opacity: 0.85;
  }
  .hs-event-chip .hs-event-close {
    position: absolute; top: 2px; right: 4px;
    cursor: pointer; opacity: 0.5;
  }
  .hs-event-chip .hs-event-close:hover { opacity: 1; background: #fff; color: #000; }
`
  // Twitch SPA navigations can sweep injected <style> tags from <head>.
  // Keep the node referenced and re-append whenever it goes missing — the
  // message observer calls this per batch (getElementById when healthy).
  function ensureEmoteStyles() {
    if (document.getElementById('heatsync-emote-styles')) return
    try {
      document.head.appendChild(style)
    } catch (_) {}
  }
  ensureEmoteStyles()
  log(' 🎨 CSS injected for emote hover effects')

  // Badge hover tooltip for cosmetic badges (BTTV/FFZ/7TV/Chatterino)
  function createBadgeTooltip() {
    const tooltip = document.createElement('div')
    tooltip.id = 'hs-badge-tooltip'
    const img = document.createElement('img')
    const name = document.createElement('span')
    name.className = 'hs-badge-tooltip-name'
    const source = document.createElement('span')
    source.className = 'hs-badge-tooltip-source'
    tooltip.appendChild(img)
    tooltip.appendChild(name)
    tooltip.appendChild(source)
    document.body.appendChild(tooltip)
    return tooltip
  }

  // Inline badges render at 18px (1x). The tooltip shows them at 72px, so we want
  // the CDN's largest variant for a crisp preview. Only 7TV/FFZ expose size
  // variants — and their max differs (7TV badges top out at 3x, FFZ at 4), so we
  // list candidates descending and probe each (see upgradeBadgeImg). BTTV and
  // Chatterino are single-resolution: nothing to upgrade.
  function hiResBadgeCandidates(src) {
    if (!src) return []
    if (src.includes('7tv'))
      return ['4x', '3x', '2x'].map((s) =>
        src.replace(/\/[1-4]x(\.\w+)?(\?.*)?$/i, (_m, ext, q) => `/${s}${ext || ''}${q || ''}`),
      )
    if (src.includes('frankerfacez'))
      return ['4', '2'].map((s) => src.replace(/\/[1-4](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
    // Twitch native badges (sub/bits/mod/vip) — URLs end in /1, /2, /3 (max 3, no 4x)
    if (src.includes('jtvnw'))
      return ['3', '2'].map((s) => src.replace(/\/[1-3](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
    return []
  }

  // Mirror the emote-preview pattern: keep the 1x showing, probe each hi-res
  // candidate in turn, swap img.src to the first that loads. No blank flash, no
  // broken-image icon when a variant 404s.
  function upgradeBadgeImg(img, src) {
    const cands = hiResBadgeCandidates(src).filter((u) => u && u !== src)
    let i = 0
    const tryNext = () => {
      if (i >= cands.length || !img.isConnected) return
      const url = cands[i++]
      const probe = new Image()
      probe.onload = () => {
        if (img.isConnected && img.dataset.hsBadgeOrig === src) img.src = url
      }
      probe.onerror = tryNext
      probe.src = url
    }
    tryNext()
  }

  function showBadgeTooltip(badgeImg) {
    const tooltip = document.getElementById('hs-badge-tooltip') || createBadgeTooltip()
    const img = tooltip.querySelector('img')
    // 1x first (always renders), then silently upgrade to the crispest variant.
    img.dataset.hsBadgeOrig = badgeImg.src
    img.src = badgeImg.src
    upgradeBadgeImg(img, badgeImg.src)
    img.alt = badgeImg.alt || ''
    const nameEl = tooltip.querySelector('.hs-badge-tooltip-name')
    if (nameEl) nameEl.textContent = badgeImg.title || badgeImg.alt || ''
    const src = badgeImg.src
    const sourceLabel = src.includes('betterttv')
      ? 'BTTV'
      : src.includes('frankerfacez')
        ? 'FFZ'
        : src.includes('7tv')
          ? '7TV'
          : src.includes('chatterino')
            ? 'Chatterino'
            : ''
    const srcEl = tooltip.querySelector('.hs-badge-tooltip-source')
    if (srcEl) srcEl.textContent = sourceLabel

    // Reset position before measuring so stale offsets don't bias offsetWidth
    tooltip.style.left = '0px'
    tooltip.style.top = '0px'
    tooltip.style.transform = 'none'
    tooltip.classList.add('active')
    // Force reflow + measure
    const ttW = tooltip.offsetWidth || 200
    const ttH = tooltip.offsetHeight || 100
    const rect = badgeImg.getBoundingClientRect()
    const pad = 8
    const centerX = rect.left + rect.width / 2
    // Clamp left edge directly (no transform translateX) so we never assume width prematurely
    let leftPx = centerX - ttW / 2
    if (leftPx < pad) leftPx = pad
    if (leftPx + ttW > window.innerWidth - pad) leftPx = window.innerWidth - ttW - pad
    // Above badge by default. If no room above, flip below.
    let topPx
    if (rect.top >= ttH + pad) {
      topPx = rect.top - ttH - pad
    } else {
      topPx = rect.bottom + pad
    }
    if (topPx < pad) topPx = pad
    if (topPx + ttH > window.innerHeight - pad) topPx = window.innerHeight - ttH - pad
    tooltip.style.left = `${leftPx}px`
    tooltip.style.top = `${topPx}px`
    tooltip.style.transform = 'none'
  }

  function hideBadgeTooltip() {
    const tooltip = document.getElementById('hs-badge-tooltip')
    if (tooltip) tooltip.classList.remove('active')
  }
  // Delegated badge tooltip — single listener on document instead of per-image
  ;(function setupBadgeTooltipDelegation() {
    document.addEventListener(
      'mouseover',
      (e) => {
        const badge = e.target.closest('.hs-cosmetic-badge')
        if (badge) showBadgeTooltip(badge)
      },
      { capture: true, signal },
    )
    document.addEventListener(
      'mouseout',
      (e) => {
        if (e.target.closest('.hs-cosmetic-badge')) hideBadgeTooltip()
      },
      { capture: true, signal },
    )
    // Hide a cosmetic badge whose image fails to load (e.g. 7TV CDN QUIC errors)
    // so we never render a broken-image icon. error doesn't bubble, but it fires
    // in the capture phase on document. Later messages create fresh imgs that
    // retry once the CDN recovers.
    document.addEventListener(
      'error',
      (e) => {
        const t = e.target
        if (t instanceof HTMLImageElement && t.classList.contains('hs-cosmetic-badge')) t.style.display = 'none'
      },
      { capture: true, signal },
    )
  })()

  // =============================================================================
  // EMOTE HOVER OVERLAY (solid colored rectangle on hover)
  // Uses event delegation - survives React re-renders
  // =============================================================================

  let activeOverlay = null

  function isEmoteImage(el) {
    if (el.tagName !== 'IMG') return false
    if (el.classList.contains('pfp') || el.classList.contains('cluster-pfp-img')) return false
    if (el.classList.contains('hs-mc-badge-img')) return false
    if (el.closest('#emote-picker-btn')) return false
    // Multichat WYSIWYG input chip — class match keeps the hover-overlay
    // working on blocked input emotes whose src has been swapped to a 1×1
    // transparent placeholder (none of the URL checks below would match).
    if (el.classList.contains('hs-input-emote')) return true
    const src = el.src || ''
    // Exclude icon images (not emotes)
    if (src.includes('/icons/')) return false
    // Exclude FFZ badge images (room mod/vip badges use cdn.frankerfacez.com/room-badge/)
    if (src.includes('cdn.frankerfacez.com/room-badge/')) return false
    return (
      src.includes('cdn.7tv.app') ||
      src.includes('cdn.betterttv.net') ||
      src.includes('cdn.frankerfacez.com') ||
      src.includes('heatsync.org') ||
      src.includes('static-cdn.jtvnw.net/emoticons')
    )
  }

  function getEmoteColor(img) {
    // 2-state palette: blocked = red, else white (project hover convention).
    // Input chips are an exception — solid-white overlay blends into the
    // multichat input chrome and the emote becomes invisible mid-hover. Use
    // #808080 there so the hover state is visually distinct without obscuring
    // the chip image underneath.
    const state = img.dataset?.heatsyncState
    if (state === 'blocked') return '#ff0000'
    if (img.classList?.contains('hs-state-blocked') || img.dataset?.state === 'blocked') return '#ff0000'
    // Blocked heatsync emotes live in .heatsync-emote-wrapper.emote-overlay-blocked
    // (the prior .emote-hover-wrapper/.blocked names matched nothing, so this always
    // fell through to white — and the white hover overlay then covered the red block
    // plate, hiding the indicator entirely in native chat / lite mode). Paint red so
    // the hover state matches the ::before block plate and stays visible on any bg.
    const wrapper = img.closest?.('.heatsync-emote-wrapper')
    if (wrapper?.classList.contains('emote-overlay-blocked')) return '#ff0000'
    return '#fff'
  }

  function showEmoteOverlay(img) {
    if (activeOverlay) activeOverlay.remove()

    // Use the rendered content dimensions (excludes CSS padding/border)
    // For <img>, clientWidth/Height includes padding, so subtract it
    const rect = img.getBoundingClientRect()
    const cs = getComputedStyle(img)
    const padT = parseFloat(cs.paddingTop) || 0
    const padL = parseFloat(cs.paddingLeft) || 0
    const padR = parseFloat(cs.paddingRight) || 0
    const padB = parseFloat(cs.paddingBottom) || 0
    const bT = parseFloat(cs.borderTopWidth) || 0
    const bL = parseFloat(cs.borderLeftWidth) || 0
    const bR = parseFloat(cs.borderRightWidth) || 0
    const bB = parseFloat(cs.borderBottomWidth) || 0
    const contentW = rect.width - padL - padR - bL - bR
    const contentH = rect.height - padT - padB - bT - bB
    const contentX = rect.left + padL + bL
    const contentY = rect.top + padT + bT
    const color = getEmoteColor(img)

    const overlay = document.createElement('div')
    overlay.className = 'heatsync-hover-overlay'
    overlay.style.cssText = `
    position: fixed;
    top: ${contentY}px;
    left: ${contentX}px;
    width: ${contentW}px;
    height: ${contentH}px;
    background: ${color};
    pointer-events: none;
    z-index: 4999;
  `
    // White (non-blocked) hover: a fixed overlay sits OVER the emote, so we can't
    // put white *behind* it — instead paint white and lay a DARKENED copy of the
    // emote on top (brightness 0.2 = dark shape on white, not a silhouette). Same
    // white-bg + dark-emote look as the multichat overlay / picker / site. Blocked
    // stays a solid red cover.
    if (color === '#fff') {
      const di = document.createElement('img')
      di.src = img.currentSrc || img.src
      di.style.cssText = 'width:100%;height:100%;object-fit:contain;filter:brightness(0.2);'
      overlay.appendChild(di)
    }

    document.body.appendChild(overlay)
    activeOverlay = overlay

    // Store reference on img for cleanup
    overlayMap.set(img, overlay)
  }

  function hideEmoteOverlay(img) {
    const overlay = overlayMap.get(img)
    if (overlay) {
      overlay.remove()
      overlayMap.delete(img)
    }
    if (activeOverlay) {
      activeOverlay.remove()
      activeOverlay = null
    }
  }

  // Event delegation for emote hover
  document.addEventListener(
    'mouseover',
    (e) => {
      if (isEmoteImage(e.target)) {
        showEmoteOverlay(e.target)
      }
    },
    { capture: true, signal },
  )

  document.addEventListener(
    'mouseout',
    (e) => {
      if (isEmoteImage(e.target)) {
        hideEmoteOverlay(e.target)
      }
    },
    { capture: true, signal },
  )

  // Combined mousemove killswitch (overlay + preview). Single dispatch, passive.
  // _hsPreviewKill is registered later by the emote hover module.
  document.addEventListener(
    'mousemove',
    throttle((e) => {
      if (activeOverlay && !isEmoteImage(e.target)) {
        activeOverlay.remove()
        activeOverlay = null
      }
      if (typeof window._hsPreviewKill === 'function') window._hsPreviewKill(e)
    }, 16),
    { passive: true, signal },
  )

  // Emote preloading removed — browser caches images natively after first render.
  // Firefox ORB blocks moz-extension:// origin preloads anyway.

  // UI hiding settings (Chatterino-style)
  let uiHidingStyle = null

  // =============================================================================
  // SIMPLE HEADER/LEADERBOARD HIDING
  // Dead simple CSS injection - no React patching complexity
  // =============================================================================

  let headerHidingStyle = null

  function enableHeaderHiding() {
    if (headerHidingStyle) return // Already enabled

    log(' Enabling header hiding...')

    headerHidingStyle = document.createElement('style')
    headerHidingStyle.id = 'heatsync-hide-header-css'

    // Target chat header AND leaderboard/banners
    headerHidingStyle.textContent = `
    /* Main chat header - "Stream Chat" bar */
    .stream-chat-header,
    [class*="stream-chat-header"],
    [data-a-target="chat-room-header-label"],
    [class*="chat-header"],
    [class*="ChatHeader"] {
      display: none !important;
    }

    /* Channel leaderboard - the marquee ticker at top of chat */
    .channel-leaderboard,
    [class*="channel-leaderboard"],
    [class*="marquee-animation"],
    [class*="LeaderboardFlex"],
    [class*="leaderboard-flex"] {
      display: none !important;
    }

    /* Pinned cheers, community highlights, hype trains — intentionally NOT hidden.
       These are live event UIs that users and streamers rely on. */
  `

    document.head.appendChild(headerHidingStyle)
    log(' Header hiding CSS injected')
  }

  function disableHeaderHiding() {
    if (!headerHidingStyle) return // Already disabled

    log(' Disabling header hiding...')

    headerHidingStyle.remove()
    headerHidingStyle = null
    log(' Header hiding CSS removed')
  }

  // =============================================================================
  // END HEADER HIDING
  // =============================================================================

  // Cached UI prefs for runtime feature gating (default-on except where noted)
  const _uiPrefs = {
    emoteModifiers: true,
    userColors: true,
    showClearedMessages: false,
    showPredictionsChip: true,
    anonChat: false,
    highlightMentions: true,
  }

  function applyUiSettings(settings) {
    if (!settings) return

    log(' Applying UI hiding settings:', settings)
    // Update cached UI prefs (default-on if absent in settings)
    for (const k of Object.keys(_uiPrefs)) {
      if (settings[k] !== undefined) _uiPrefs[k] = !!settings[k]
    }
    // These native chat-column elements live inside chat-room__content, which the
    // overlay hides entirely — so their per-element toggles were dead UI clutter and
    // were removed from the settings schema. Force-hide them unconditionally: this
    // still guards each element during the brief cold-boot / SPA-nav flash before
    // hs-native-hidden engages, at zero settings-UI cost. (hideChatHeader stays
    // default-on via its own `!== false` gate below.)
    for (const k of [
      'hideChannelPoints',
      'hideHypeTrain',
      'hideHypeChat',
      'hidePinnedHypeChats',
      'hideCombos',
      'hideBitsBtns',
      'hideCharity',
      'hideDrops',
      'hidePolls',
      'hidePredictions',
      'hideGiftBanner',
      'hideCommunityHighlights',
      'hideSharedChatBanner',
    ]) {
      settings[k] = true
    }
    // Toggle deleted-message visibility CSS
    document.documentElement.classList.toggle('hs-show-cleared', !!_uiPrefs.showClearedMessages)
    // Anon-mode flag — read by typing/presence interceptors
    document.documentElement.classList.toggle('hs-anon-chat', !!_uiPrefs.anonChat)

    // Remove existing UI hiding style
    if (uiHidingStyle) {
      uiHidingStyle.remove()
      uiHidingStyle = null
    }

    // Also remove any old hide-header style
    document.getElementById('heatsync-hide-header')?.remove()

    // Build CSS for enabled settings
    const rules = []

    // Popout: always hide (no collapse arrow, bar is useless)
    // Normal: default to hidden (collapse arrow is separate DOM element, survives)
    // Only show header if user explicitly set hideChatHeader to false
    const isPopout = /^\/(popout|embed)\//.test(location.pathname)
    if (isPopout || settings.hideChatHeader !== false) {
      enableHeaderHiding()
    } else {
      disableHeaderHiding()
    }

    if (settings.hideStreamTitle) {
      // Twitch stream title only — NOT .channel-info-content (that container
      // holds subscribe/share/viewer-count/about too; hiding it nukes the bar)
      rules.push('[data-a-target="stream-title"] { display: none !important; }')
      // Kick
      rules.push('.stream-username-wrapper { display: none !important; }')
    }

    if (settings.hideViewerCount) {
      // Twitch viewer count
      rules.push('[data-a-target="animated-channel-viewers-count"] { display: none !important; }')
      rules.push('.tw-animated-number { display: none !important; }')
      // Kick
      rules.push('.viewer-count { display: none !important; }')
    }

    // ─── anti-features pack — Twitch UI noise toggles ─────────────────────────
    // Each toggle adds one or more selectors to the hide rules block. Pure CSS,
    // no JS observer — Twitch DOM regenerates and our display:none re-matches.
    // Selectors target both data-a-target attrs (stable) and class substrings.
    if (settings.hideChannelPoints) {
      rules.push('[data-test-selector="community-points-summary"] { display: none !important; }')
      rules.push('.community-points-summary { display: none !important; }')
      rules.push('button[aria-label*="Channel Points"i] { display: none !important; }')
    }
    if (settings.hideHypeTrain) {
      rules.push(
        '[class*="hype-train-banner"], [class*="hype-train-rewards"], [class*="hype-train-progress"] { display: none !important; }',
      )
    }
    if (settings.hideHypeChat) {
      rules.push('[data-a-target="hype-chat-button"], [aria-label*="Hype Chat"i] { display: none !important; }')
    }
    if (settings.hidePinnedHypeChats) {
      rules.push('[class*="pinned-paid-chat"], [class*="paid-pinned-chat"] { display: none !important; }')
    }
    if (settings.hideCharity) {
      rules.push(
        '[data-test-selector*="charity"i], [class*="charity-callout"], [class*="charity-banner"] { display: none !important; }',
      )
    }
    if (settings.hideDrops) {
      rules.push(
        '[data-test-selector*="drops"i], [class*="drops-callout"], [class*="drops-banner"], [aria-label*="Drops"i] { display: none !important; }',
      )
    }
    if (settings.hidePolls) {
      rules.push(
        '[data-test-selector*="poll"i]:not([data-test-selector*="settings"i]), [class*="poll-banner"], [class*="active-poll"] { display: none !important; }',
      )
    }
    if (settings.hidePredictions) {
      rules.push(
        '[data-test-selector*="prediction"i], [class*="prediction-banner"], [class*="active-prediction"], [aria-label*="Prediction"i] { display: none !important; }',
      )
    }
    if (settings.hideGiftBanner) {
      rules.push(
        '[class*="gift-sub-banner"], [class*="mass-gift-sub"], [class*="community-gift"] { display: none !important; }',
      )
    }
    if (settings.hideCommunityHighlights) {
      rules.push(
        '.community-highlight-stack__top, .community-highlight-stack__backlog, [class*="community-highlight"] { display: none !important; }',
      )
    }
    if (settings.hidePrimeLoot) {
      rules.push(
        '[class*="prime-offers"], [aria-label*="Prime Gaming"i], [aria-label*="Prime Loot"i] { display: none !important; }',
      )
    }
    if (settings.hideRecommendedChannels) {
      // 2026 twitch renamed the shelves: "Live Channels" + "<name> Viewers Also
      // Watch" — the section div's aria-label is the only stable hook (no
      // data-a-target / data-test-selector on it). English-locale only, like
      // every aria selector in this block. Legacy selectors kept for
      // logged-out / older DOM.
      rules.push(
        '.side-nav-section[aria-label="Live Channels"], .side-nav-section[aria-label*="Viewers Also Watch"i], [aria-label*="Recommended Channels"i], [data-a-target="recommended-channels"], [data-test-selector="recommended-channels"] { display: none !important; }',
      )
    }
    if (settings.hideStories) {
      // storiesLeftNavSection* covers collapsed + expanded left-nav entries
      rules.push(
        '[aria-label*="Stories"i], [class*="storiesLeftNavSection"], [class*="stories-rail"], [class*="story-rail"] { display: none !important; }',
      )
    }
    if (settings.hideLiveNotifBtn) {
      // channel bell has no data-a-target in 2026 DOM — aria-label
      // "Modify channel notification preferences" is the only hook
      rules.push(
        'button[aria-label*="channel notification"i], [data-a-target="live-notifications-toggle"], button[aria-label*="Subscribe to notifications"i] { display: none !important; }',
      )
    }
    if (settings.hideUnfollowBtn) {
      rules.push('[data-a-target="unfollow-button"], button[aria-label*="Unfollow"i] { display: none !important; }')
    }
    if (settings.hideSubscribeBtn) {
      rules.push(
        '[data-a-target="subscribe-button"], [data-test-selector="subscribe-button"] { display: none !important; }',
      )
    }
    if (settings.hideSharedChatBanner) {
      rules.push('[class*="shared-chat-banner"], [data-test-selector*="shared-chat"i] { display: none !important; }')
    }
    if (settings.hideSubtember) {
      rules.push('[class*="subtember"], [aria-label*="Subtember"i] { display: none !important; }')
    }
    if (settings.hideTwitchTurbo) {
      rules.push(
        '[class*="turbo-upsell"], [class*="turbo-cta"], [aria-label*="Twitch Turbo"i] { display: none !important; }',
      )
    }
    if (settings.hideCombos) {
      rules.push(
        '[data-a-target="combo-button"], [class*="combo-button"], [class*="combos-bar"] { display: none !important; }',
      )
    }
    if (settings.hideBitsBtns) {
      rules.push(
        '[data-a-target="bits-button"], [aria-label*="Cheer with Bits"i], [aria-label*="Get Bits"i] { display: none !important; }',
      )
    }
    if (settings.hideOnscreenCelebrations) {
      rules.push(
        '[class*="celebration-pane"], [class*="celebration-stack"], [class*="onscreen-celebration"], [class*="celebration-overlay"] { pointer-events: none !important; display: none !important; }',
      )
    }
    if (settings.hidePlayerExtensions) {
      rules.push(
        '.extension-taskbar, [class*="extension-overlay"], [class*="extensions-dock"], .video-player__overlay [class*="extension"] { display: none !important; }',
      )
    }

    if (rules.length > 0) {
      uiHidingStyle = document.createElement('style')
      uiHidingStyle.id = 'heatsync-ui-hiding'
      uiHidingStyle.textContent = rules.join('\n')
      document.head.appendChild(uiHidingStyle)
      log(' Applied UI hiding CSS:', rules.length, 'rules')
    }

    // Cosmetics toggle — legacy showCosmetics key OR the cosmetics subsystem gate
    if (settings.showCosmetics === false || settings.subsystems?.cosmetics === false) {
      cosmeticsEnabled = false
      // Remove existing cosmetic badges from DOM
      document.querySelectorAll('.hs-cosmetic-badge').forEach((b) => b.remove())
      document.querySelectorAll('[data-hs-paint-applied]').forEach((el) => {
        el.style.removeProperty('background-image')
        el.style.removeProperty('background-size')
        el.style.removeProperty('-webkit-background-clip')
        el.style.removeProperty('-webkit-text-fill-color')
        el.style.removeProperty('background-clip')
        el.style.removeProperty('filter')
        delete el.dataset.hsPaintApplied
      })
    } else {
      cosmeticsEnabled = true
    }

    // Debug logging toggle — sync localStorage so next page load picks up the new state.
    // (DEBUG is captured at IIFE start; runtime change requires reload.)
    try {
      if (settings.debugLogging === true) {
        localStorage.setItem('heatsync_debug', 'true')
      } else if (settings.debugLogging === false) {
        localStorage.removeItem('heatsync_debug')
      }
    } catch (_e) {}
  }
  // Load and apply UI settings on startup
  ;(async function loadUiSettings() {
    try {
      const stored = await chrome.storage.sync.get('ui_settings')
      const settings = sanitizeUiSettings(stored.ui_settings || {})
      // Always run applyUiSettings so popout auto-hides header even with no stored settings
      applyUiSettings(settings)
    } catch (err) {
      warn(' Failed to load UI settings:', err)
    }
  })()
  // Load emote size setting
  ;(async function loadEmoteSize() {
    try {
      const stored = await chrome.storage.local.get('hs_emote_size')
      if (stored.hs_emote_size != null) {
        hsEmoteSize = parseFloat(stored.hs_emote_size) || 1
      }
      applyEmoteSize()
    } catch {
      applyEmoteSize()
    }
  })()

  // Load emoji size setting (1x/2x/4x — replaces legacy bigEmoji toggle)
  ;(async function loadEmojiSize() {
    try {
      const stored = await chrome.storage.local.get('hs_emoji_size')
      const v = stored.hs_emoji_size
      if (v === 1 || v === 2 || v === 4) hsEmojiSize = v
      applyEmojiSize()
    } catch {
      applyEmojiSize()
    }
  })()

  // Emote-load progress — rendered inline in the multichat overlay's top
  // statusbar via the shared HsNotifs layer (set on window by multichat.js,
  // same isolated world). No floating box. On heatsync.org the overlay isn't
  // injected, so HsNotifs is absent and these calls no-op.
  function showLoadingStatus(text) {
    log(' showLoadingStatus:', text)
    try {
      window.HsNotifs?.emit('emote-loading', { text })
    } catch (_) {}
  }

  function hideLoadingStatus() {
    try {
      window.HsNotifs?.dismissByKey('emote-loading', 'emote-loading')
    } catch (_) {}
  }

  let emoteInventory = []
  let globalEmotes = []
  let channelEmotes = [] // Channel owner's emotes (for THIS tab's channel only)
  let currentChannelOwner = null // Track channel owner for emote filtering

  // Hoisted regex constants — avoids per-call allocation in hot paths
  const COLOR_RE = /^(#[0-9a-f]{3,8}|rgb\(.+\)|[a-z]+)$/i
  const SUB_TENURE_RE = /(\d+)-Month Subscriber/i

  // Get channel name from current page URL
  function getPageChannel() {
    const url = window.location.href
    if (url.includes('twitch.tv')) {
      const match = url.match(/\/popout\/([^/]+)\/chat/) || url.match(/twitch\.tv\/([^/?]+)/)
      const ch = match ? match[1]?.toLowerCase() : null
      const excluded = [
        'directory',
        'settings',
        'videos',
        'moderator',
        'subscriptions',
        'search',
        'downloads',
        'inventory',
      ]
      return ch && !excluded.includes(ch) ? ch : null
    }
    if (url.includes('kick.com')) {
      // Handle popout/embed URLs: /popout/channel/chat or /embed/channel/chat
      const popoutMatch = url.match(/kick\.com\/(?:popout|embed)\/([^/?]+)/)
      if (popoutMatch) return popoutMatch[1]?.toLowerCase() || null
      const match = url.match(/kick\.com\/([^/?]+)/)
      const ch = match ? match[1]?.toLowerCase() : null
      const kickExcluded = [
        'categories',
        'following',
        'settings',
        'browse',
        'search',
        'dashboard',
        'category',
        'password',
        'popout',
        'embed',
      ]
      return ch && !kickExcluded.includes(ch) ? ch : null
    }
    return null
  }
  let _mentionRegex = null // Cached mention regex (rebuilt on username change)
  let _mentionUser = null // Username the regex was built for
  const HS_WS_SPLIT = /(\s+)/ // Hoisted: avoids per-message regex allocation in hot paths
  let blockedEmotes = new Set()
  // Names blocked locally — covers emotes we never wrap (native Twitch sub/follower/bits).
  // Right-click any img[alt] in chat to toggle. Persisted in chrome.storage.local.
  let localBlockedEmoteNames = new Set()
  // Tracks user-initiated block/unblock per hash so a late `emote_blocked` /
  // `emote_unblocked` broadcast (from server WS echo of the previous action)
  // can't reverse a fresh local toggle. Symptom this fixes: scrolled-to-bottom
  // chat keeps re-blocking emotes the user just unblocked because each new
  // message runs processMessage with a stale blockedEmotes set.
  const recentBlockToggle = new Map() // hash -> { state: 'blocked'|'unblocked', at: ms }
  const BLOCK_TOGGLE_GRACE_MS = 5000
  function markLocalBlockToggle(hash, state) {
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
  const mutedUsers = new Set()
  let blockedUsers = new Set()
  let followedByCurrentUser = new Set()
  const pendingEmoteBroadcasts = new Map() // "username:emoteName" -> { ...emoteData, addedAt }
  // Secondary index: username (lowercase) -> Set of emote names (for O(1) lookup in processMessage)
  const pendingBroadcastsByUser = new Map()
  function _addBroadcast(key, data) {
    pendingEmoteBroadcasts.set(key, data)
    const colon = key.indexOf(':')
    if (colon !== -1) {
      const user = key.slice(0, colon)
      const emoteName = key.slice(colon + 1)
      if (!pendingBroadcastsByUser.has(user)) pendingBroadcastsByUser.set(user, new Map())
      pendingBroadcastsByUser.get(user).set(emoteName, data)
    }
  }
  function _deleteBroadcast(key) {
    pendingEmoteBroadcasts.delete(key)
    const colon = key.indexOf(':')
    if (colon !== -1) {
      const user = key.slice(0, colon)
      const emoteName = key.slice(colon + 1)
      const userMap = pendingBroadcastsByUser.get(user)
      if (userMap) {
        userMap.delete(emoteName)
        if (userMap.size === 0) pendingBroadcastsByUser.delete(user)
      }
    }
  }
  cleanup.setIntervalIfVisible(() => {
    const now = Date.now()
    for (const [key, entry] of pendingEmoteBroadcasts) {
      if (now - entry.addedAt > 30000) _deleteBroadcast(key)
    }
  }, 30000)

  // Per-sender heatsync + personal (7TV/BTTV) emote sets, keyed "twitch:<id>".
  // PERSISTENT (no TTL) overlay layered under live broadcasts — unlike the 10s
  // broadcast window, this renders another user's ADDED emotes (e.g. a BTTV emote
  // they added to heatsync that isn't in their BTTV account) in chat history and
  // after refresh, not just while they're actively posting. Twitch-only: the
  // endpoint + 7TV/BTTV fetches need a numeric platform id, which getTwitchUserId
  // provides but Kick's DOM path does not. Mirrors the cosmetics fetch machinery.
  const senderHeatsyncEmotes = new Map() // "twitch:<id>" / "kick:<username>" -> Map<name, {name,url,hash,zeroWidth,source}> | null (fetched-empty)
  const SENDER_EMOTE_MAX = 500
  const senderEmotePending = new Set()
  const SENDER_EMOTE_PENDING_MAX = 10
  let senderEmoteBatchTimer = null
  // Freshness so a sender's newly-added emotes propagate — without a TTL the set was
  // fetched once and never re-validated. In-memory, so a reload also re-fetches.
  const senderEmoteFetchedAt = new Map() // "twitch:<id>" -> ts
  const SENDER_EMOTE_REFETCH_MS = 5 * 60 * 1000
  const pendingOperations = new Set() // Track in-flight operations to prevent double-clicks
  const pendingRemovals = new Set() // Emote names pending removal — suppress inventory_update re-adds
  const _pendingRemovalSnapshots = new Map() // name → emote object, for rollback on emote_removing_cancel
  // O(1) lookup sets — rebuilt when arrays change (via allEmotesDirty flag)
  let inventoryHashSet = new Set()
  let cachedEmotesByHash = new Map() // hash → emote, O(1) lookup for hover previews
  let inventoryNameSet = new Set()
  let globalNameSet = new Set()

  // Rebuild combined emote map eagerly (called from event handlers + fallback in processMessage)
  function rebuildEmoteMapIfDirty() {
    if (!allEmotesDirty && cachedAllEmotes) return
    allEmotesDirty = false
    cachedAllEmotes = new Map()
    cachedAllEmoteVariants = new Map()

    // Normalize + push a variant into the per-name array. Inventory variants
    // go first (highest priority), then channel, then global. Dedupe by hash so
    // a single source can't list the same emote twice.
    const _addVariant = (emote, source) => {
      const rawUrl = emote.url || ''
      const url = rawUrl.startsWith('http') ? rawUrl : `${API_URL}${rawUrl}`
      const norm = Object.assign({}, emote, {
        url,
        hash: emote.hash || btoa(rawUrl),
        isGlobal: source === 'global',
        inInventory: source === 'inventory',
      })
      norm.isThirdParty =
        url.includes('cdn.7tv.app') ||
        url.includes('cdn.betterttv.net') ||
        url.includes('cdn.frankerfacez.com') ||
        url.includes('static-cdn.jtvnw.net')
      let arr = cachedAllEmoteVariants.get(emote.name)
      if (!arr) {
        arr = []
        cachedAllEmoteVariants.set(emote.name, arr)
      }
      if (arr.some((v) => v.hash === norm.hash)) return
      arr.push(norm)
    }

    // Inventory FIRST (highest priority — user's own emotes always win).
    // Subscription emotes are skipped: Twitch's native DOM gates them via the
    // IRC emotes= tag, so re-imagifying them would surface them for non-entitled senders.
    emoteInventory.forEach((emote) => {
      if (emote.subscription) return
      _addVariant(emote, 'inventory')
    })

    // Channel emotes (third-party only — BTTV/FFZ/7TV/Twitch).
    // Skip Twitch sub/follower/bits-tier emotes for the same reason as above.
    channelEmotes.forEach((emote) => {
      if (!emote.source) return
      if (
        emote.source === 'twitch' &&
        (emote.tier ||
          emote.emote_type === 'subscriptions' ||
          emote.emote_type === 'follower' ||
          emote.emote_type === 'bitstier')
      )
        return
      _addVariant(emote, 'channel')
    })

    // Global emotes LAST (lowest priority, fallback only).
    globalEmotes.forEach((emote) => {
      _addVariant(emote, 'global')
    })

    // cachedAllEmotes points to the highest-priority variant — preserves existing
    // single-lookup callers (replaceEmotesWithStacking, autocomplete, picker).
    for (const [name, variants] of cachedAllEmoteVariants) {
      cachedAllEmotes.set(name, variants[0])
    }
    // cachedNonInventoryEmotes: first non-inventory variant per name. Channel
    // and global variants only — what other senders can legitimately render.
    cachedNonInventoryEmotes = new Map()
    for (const [name, variants] of cachedAllEmoteVariants) {
      const v = variants.find((x) => !x.inInventory)
      if (v) cachedNonInventoryEmotes.set(name, v)
    }
    // cachedOwnEmotes: channel-first for own renders. Prefer a channel variant
    // (non-inventory, non-global) so channel emotes win in their own channel just
    // as they do for other chatters; fall back to variants[0] (inventory > global)
    // for names the channel doesn't provide.
    cachedOwnEmotes = new Map()
    cachedChannelEmotes = new Map()
    for (const [name, variants] of cachedAllEmoteVariants) {
      const channelV = variants.find((x) => !x.inInventory && !x.isGlobal)
      cachedOwnEmotes.set(name, channelV || variants[0])
      if (channelV) cachedChannelEmotes.set(name, channelV)
    }

    // Rebuild O(1) lookup sets
    inventoryHashSet = new Set()
    for (const e of emoteInventory) inventoryHashSet.add(e.hash)
    inventoryNameSet = new Set()
    for (const e of emoteInventory) inventoryNameSet.add(e.name)
    globalNameSet = new Set()
    for (const e of globalEmotes) globalNameSet.add(e.name)
    // Index every variant hash so hover preview / tooltip can resolve a swapped-in
    // variant just as well as the original primary.
    cachedEmotesByHash = new Map()
    for (const variants of cachedAllEmoteVariants.values()) {
      for (const v of variants) {
        if (v.hash) cachedEmotesByHash.set(v.hash, v)
      }
    }
  }

  // Toast — use shared-utils if available, inline fallback
  const showToast =
    window.HS?.showToast ||
    ((msg, type) => {
      try {
        if (window.HsNotifs && document.getElementById('hs-notif-layer-statusbar')) {
          window.HsNotifs.emit('toast', { text: msg, level: type })
          return
        }
      } catch (_) {}
      const el = document.getElementById('heatsync-toast')
      if (el) el.remove()
      const t = document.createElement('div')
      t.id = 'heatsync-toast'
      t.textContent = msg
      t.style.cssText =
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid #fff;padding:6px 14px;font:bold 12px monospace;z-index:10001;border-radius:0;'
      document.body.appendChild(t)
      cleanup.setTimeout(() => t.remove(), 2500)
    })

  // heatsync.org gate moved to the top of this file (right after API_URL).
  // The early-return there means we never reach this point on heatsync.org,
  // so the legacy block here is removed — OAuth handling already done.

  // Normalize emote URL - fix URLs that got saved with wrong base domain
  function normalizeEmoteUrl(url) {
    if (!url) return url
    // Fix URLs that were resolved to wrong domain (e.g., twitch.tv, kick.com)
    const wrongDomains = ['twitch.tv', 'kick.com', 'localhost']
    for (const domain of wrongDomains) {
      if (url.includes(domain) && (url.includes('/emotes/') || url.includes('/uploads/'))) {
        // Extract the path after /emotes/ or /uploads/
        const match = url.match(/\/(emotes|uploads)\/.+$/)
        if (match) {
          return `${API_URL}${match[0]}`
        }
      }
    }
    // If relative URL, add API_URL
    if (url.startsWith('/emotes/') || url.startsWith('/uploads/')) {
      return `${API_URL}${url}`
    }
    return url
  }

  // Request inventory - try storage first, then message
  async function loadInventory() {
    const loadStart = performance.now()
    showLoadingStatus('loading emotes...')

    // Try storage first (instant access)
    try {
      const storageStart = performance.now()
      const stored = await chrome.storage.local.get([
        'global_emotes',
        'emote_inventory',
        'blocked_emotes',
        'channel_emotes_map',
        'blocked_users',
        'local_blocked_emote_names',
      ])
      if (Array.isArray(stored.local_blocked_emote_names)) {
        localBlockedEmoteNames = new Set(stored.local_blocked_emote_names)
      }
      log(` ⏱️ Storage read took ${(performance.now() - storageStart).toFixed(0)}ms`)

      if (stored.global_emotes && stored.global_emotes.length > 0) {
        globalEmotes = stored.global_emotes
        // Normalize URLs when loading from storage
        emoteInventory = (stored.emote_inventory || []).map((e) => ({
          ...e,
          url: normalizeEmoteUrl(e.url),
        }))
        blockedEmotes = new Set(stored.blocked_emotes || [])
        if (stored.blocked_users) blockedUsers = new Set(stored.blocked_users)
        // Load only THIS channel's emotes from the per-channel map
        const myChannel = getPageChannel()
        const myPlatform = window.location.hostname.includes('kick.com') ? 'kick' : 'twitch'
        const myEmotes =
          myChannel && stored.channel_emotes_map
            ? stored.channel_emotes_map[`${myPlatform}/${myChannel}`] || stored.channel_emotes_map[myChannel] || []
            : []
        channelEmotes = myEmotes.map((e) => ({
          ...e,
          url: normalizeEmoteUrl(e.url),
        }))
        currentChannelOwner = myChannel

        log(
          ` ✅ Loaded from storage in ${(performance.now() - loadStart).toFixed(0)}ms:`,
          emoteInventory.length,
          'personal,',
          globalEmotes.length,
          'global,',
          channelEmotes.length,
          'channel',
        )
        // If globals are warm but channel emotes are missing, ask BG to refetch.
        // Channel emotes only refilled via the join_channel handler chain, which
        // is racing the live-paint that's about to render existing DOM messages.
        // Without an explicit refetch trigger here, channel emotes for the
        // current page can stay empty for several seconds (or forever on a
        // cold-cache page-load if BG init misses the trigger).
        if (myChannel && channelEmotes.length === 0) {
          try {
            safeSendMessage({ type: 'get_picker_emotes', channel: myChannel }).catch(() => {})
          } catch {}
        }
        hideLoadingStatus()
        debouncedProcessExistingMessages()
        updateEmoteBridge() // Update Twitch autocomplete hook
        // Fetch cosmetic badges (BTTV/FFZ/Chatterino) — not cached in storage
        fetchCosmeticBadges()
        return
      }
    } catch (err) {
      warn(' Storage read failed:', err)
    }

    // Fallback: message passing with retry (service worker will wait for init)
    log(' Storage empty, trying message passing...')
    showLoadingStatus('fetching emotes...')
    let attempts = 0
    const maxAttempts = 10 // More retries for MV3 service worker wakeup
    const baseDelay = 300

    while (attempts < maxAttempts) {
      try {
        showLoadingStatus(`loading emotes... (${attempts + 1}/${maxAttempts})`)
        const response = await safeSendMessage({ type: 'get_inventory' })

        if (response) {
          emoteInventory = response.emotes || []
          globalEmotes = response.globalEmotes || []
          blockedEmotes = new Set(response.blocked || [])
          window.postMessage({ type: 'heatsync-blocked-sync', hashes: Array.from(blockedEmotes) }, location.origin)

          // Fetch followed users for profile card
          safeSendMessage({ type: 'get_followed_users' })
            .then((r) => {
              if (r?.users) followedByCurrentUser = new Set(r.users)
            })
            .catch(() => {})

          // Fetch bulk BTTV/FFZ/Chatterino badges
          fetchCosmeticBadges()

          // Fetch HeatSync API colors for followed users + current user
          safeSendMessage({ type: 'get_follow_history' })
            .then((resp) => {
              if (resp?.colors && typeof resp.colors === 'object') {
                for (const [login, color] of Object.entries(resp.colors)) {
                  if (color) heatsyncColorMap.set(login.toLowerCase(), color)
                }
              }
              // Also load current user's own HeatSync color from storage
              chrome.storage.local
                .get('user_info')
                .then((data) => {
                  if (data.user_info?.color && data.user_info?.username) {
                    heatsyncColorMap.set(data.user_info.username.toLowerCase(), data.user_info.color)
                  }
                  log(' HeatSync colors loaded:', heatsyncColorMap.size)
                  applyHeatsyncColorsToExisting()
                })
                .catch(() => {
                  log(' HeatSync colors loaded:', heatsyncColorMap.size)
                  applyHeatsyncColorsToExisting()
                })
            })
            .catch(() => {})

          log(' Received inventory via message:', emoteInventory.length, 'personal,', globalEmotes.length, 'global')

          if (globalEmotes.length > 0) {
            log(
              ' Sample global emotes:',
              globalEmotes.slice(0, 5).map((e) => e.name),
            )
            hideLoadingStatus()
            debouncedProcessExistingMessages()
            updateEmoteBridge() // Update Twitch autocomplete hook
            return
          }
        }
      } catch (err) {
        if (err?.message?.includes('Extension context invalidated')) {
          extensionContextValid = false
          return
        }
        log('loadInventory attempt', attempts, 'failed:', err?.message)
      }

      attempts++
      if (attempts < maxAttempts) {
        // Exponential backoff: 300, 450, 675, 1012, etc (capped at 2s)
        const delay = Math.min(baseDelay * 1.5 ** (attempts - 1), 2000)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    hideLoadingStatus()
    log(' Will receive emotes when service worker broadcasts them')

    // Safety net: if emotes arrive late via broadcast, we need to ensure existing messages get processed.
    // Set up a one-shot listener that fires processExistingMessages on first emote data arrival.
    const _lateEmoteHandler = (msg) => {
      if (msg.type === 'inventory_update' || msg.type === 'global_emotes_update') {
        chrome.runtime.onMessage.removeListener(_lateEmoteHandler)
        // Emote data just arrived — make sure observer is running and reprocess
        watchForNewMessages()
        setupUsernameColoringObserver()
      }
    }
    chrome.runtime.onMessage.addListener(_lateEmoteHandler)
    // Also clean up if emotes never come (don't leak listener forever)
    cleanup.setTimeout(() => chrome.runtime.onMessage.removeListener(_lateEmoteHandler), 120000)
  }

  // Create emote bridge BEFORE loading inventory so updateEmoteBridge() works
  if (window.location.hostname.includes('twitch.tv')) {
    injectTwitchAutocompleteHook()
    // Persist the real Twitch local_storage_device_id to chrome.storage as soon
    // as early-inject-main.js populates the dataset. SW reads this for off-twitch
    // follow propagation (gql.twitch.tv/integrity wants the localStorage device
    // id, not unique_id cookie). Without this, off-twitch follows get
    // "failed integrity check" from twitch.
    const _pollDeviceId = cleanup.setInterval(() => {
      try {
        const id = document.documentElement.dataset.hsTwitchDeviceId
        if (!id) return
        cleanup.clearInterval(_pollDeviceId)
        chrome.storage?.local?.set?.({ hs_twitch_device_id: id })
      } catch {}
    }, 500)
  }

  loadInventory()

  // Listen for updates from background script
  // Named function + remove-before-add prevents listener stacking on extension reload
  function _onMessageMain(message) {
    // Validate message
    if (!message || typeof message !== 'object' || !message.type) {
      warn(' Invalid message received:', message)
      return
    }

    log(' Received message:', message.type, message)

    try {
      switch (message.type) {
        case 'loading_status':
          if (message.done) {
            hideLoadingStatus()
          } else {
            showLoadingStatus(message.text)
          }
          break

        case 'inventory_update': {
          // Normalize URLs when receiving inventory update
          let newInv = (message.emotes || []).map((e) => ({
            ...e,
            url: normalizeEmoteUrl(e.url),
          }))
          // Filter out emotes pending removal (race: fetchEmoteInventory runs before DELETE completes)
          if (pendingRemovals.size > 0) {
            const serverNames = new Set(newInv.map((e) => e.name))
            // Clear pendingRemovals for emotes confirmed gone from server
            for (const name of pendingRemovals) {
              if (!serverNames.has(name)) pendingRemovals.delete(name)
            }
            // Filter any still-pending (server hasn't caught up yet)
            if (pendingRemovals.size > 0) {
              newInv = newInv.filter((e) => !pendingRemovals.has(e.name))
            }
          }

          // Skip reprocessing if inventory hasn't actually changed (prevents stack rebuild on 60s poll)
          const oldHashes = new Set(emoteInventory.map((e) => e.hash))
          const newHashes = new Set(newInv.map((e) => e.hash))
          const removedHashes = [...oldHashes].filter((h) => !newHashes.has(h))
          const addedHashes = [...newHashes].filter((h) => !oldHashes.has(h))
          const inventoryChanged = removedHashes.length > 0 || addedHashes.length > 0
          // When the only delta is removal of emotes we already know are blocked,
          // skip the full reprocess — updateEmoteState/hideBlockedEmote already
          // swapped the wrapper visuals. Avoids a chat-wide DOM rebuild flicker
          // every time the user blocks an emote that was in their inventory.
          const blockOnlyRemoval =
            addedHashes.length === 0 && removedHashes.length > 0 && removedHashes.every((h) => blockedEmotes.has(h))

          emoteInventory = newInv
          allEmotesDirty = true
          _tabEmoteMapDirty = true
          rebuildEmoteMapIfDirty()
          log(
            ' Inventory updated:',
            emoteInventory.length,
            'emotes',
            inventoryChanged
              ? blockOnlyRemoval
                ? '(BLOCK-ONLY REMOVAL — skipping reprocess)'
                : '(CHANGED)'
              : '(unchanged)',
          )

          // If on own channel, sync channel emotes with inventory (remove stale ones)
          // Channel emotes for owner = their personal inventory, so keep them in sync
          if (channelEmotes.length > 0) {
            const inventoryHashes = new Set(emoteInventory.map((e) => e.hash))
            const before = channelEmotes.length
            channelEmotes = channelEmotes.filter((e) => inventoryHashes.has(e.hash))
            if (channelEmotes.length !== before) {
              log(' 🔄 Synced channel emotes with inventory:', before, '→', channelEmotes.length)
            }
          }

          // Surgical add updates: when emotes are added back (e.g. unblock restored
          // them to inventory), wrappers already in the DOM just need their overlay
          // class flipped to "owned". Skip reprocess if every added hash already
          // has wrappers — saves a chat-wide rebuild.
          let surgicalAddOnly = false
          if (inventoryChanged && !blockOnlyRemoval && removedHashes.length === 0 && addedHashes.length > 0) {
            const updates = []
            let allHaveWrappers = true
            for (const h of addedHashes) {
              const els = document.querySelectorAll(`[data-emote-hash="${h}"]`)
              if (els.length === 0) {
                allHaveWrappers = false
                break
              }
              els.forEach((el) => {
                const name = el.dataset.emoteName || el.querySelector('.heatsync-emote')?.dataset?.emoteName
                if (name) updates.push([h, name])
              })
            }
            if (allHaveWrappers && updates.length > 0) {
              for (const [h, n] of updates) updateEmoteState(h, n, 'added')
              surgicalAddOnly = true
            }
          }

          if (inventoryChanged && !blockOnlyRemoval && !surgicalAddOnly) {
            emoteGeneration++
            debouncedProcessExistingMessages()
          }
          updateEmoteBridge() // Update Twitch autocomplete hook
          // Notify MAIN world (heatsync-button.js) to refresh panel if open
          window.postMessage({ type: 'heatsync-inventory-update', count: emoteInventory.length }, location.origin)
          break
        }

        case 'emote_added':
          // Emote was successfully added to your set
          pendingRemovals.delete(message.emoteName)
          allEmotesDirty = true
          emoteGeneration++
          log(' ✅ Emote added to your set:', message.emoteName)
          if (!emoteInventory.some((e) => e.hash === message.hash)) {
            emoteInventory.push({
              name: message.emoteName,
              hash: message.hash,
              url: message.url,
            })
          }
          rebuildEmoteMapIfDirty()
          updateEmoteState(message.hash, message.emoteName, 'added')
          updateEmoteBridge() // Update Twitch autocomplete hook
          // Notify MAIN world (heatsync-button.js) to refresh panel if open
          window.postMessage({ type: 'heatsync-inventory-update', count: emoteInventory.length }, location.origin)
          break

        case 'emote_removing': {
          // Background is about to remove this emote — suppress it in new messages immediately.
          // Snapshot the emote before filtering so a cancel can restore it without waiting
          // for the periodic re-fetch.
          pendingRemovals.add(message.emoteName)
          const _snap = emoteInventory.find(
            (e) => e.name === message.emoteName || (message.hash && e.hash === message.hash),
          )
          if (_snap) _pendingRemovalSnapshots.set(message.emoteName, _snap)
          emoteInventory = emoteInventory.filter((e) => e.name !== message.emoteName)
          allEmotesDirty = true
          _tabEmoteMapDirty = true
          rebuildEmoteMapIfDirty()
          // Optimistic visual tier-drop on existing rendered messages: pickActiveVariant
          // now sees inventoryHashSet sans this emote and skips the inventory variant in
          // favor of channel/global siblings.
          if (message.hash || message.emoteName) {
            updateEmoteState(message.hash || '', message.emoteName, 'neutral')
          }
          log(' ⏳ Emote removal starting:', message.emoteName)
          break
        }

        case 'emote_removing_cancel': {
          // Removal failed — restore the eagerly-removed emote so existing wrappers
          // tier-up back to the inventory variant and new messages re-render with it.
          pendingRemovals.delete(message.emoteName)
          const _snap = _pendingRemovalSnapshots.get(message.emoteName)
          if (_snap && !emoteInventory.some((e) => e.name === _snap.name)) {
            emoteInventory.push(_snap)
          }
          _pendingRemovalSnapshots.delete(message.emoteName)
          allEmotesDirty = true
          _tabEmoteMapDirty = true
          rebuildEmoteMapIfDirty()
          if (_snap) {
            updateEmoteState(_snap.hash || '', _snap.name, 'added')
          }
          log(' ↩️ Emote removal cancelled:', message.emoteName)
          break
        }

        case 'emote_removed':
          // Emote was successfully removed from your set
          pendingRemovals.add(message.emoteName)
          _pendingRemovalSnapshots.delete(message.emoteName)
          allEmotesDirty = true
          emoteGeneration++
          _tabEmoteMapDirty = true
          log(' ✅ Emote removed from your set:', message.emoteName)
          emoteInventory = emoteInventory.filter((e) => e.hash !== message.hash && e.name !== message.emoteName)
          // Clear any stale broadcasts for this emote
          for (const key of pendingEmoteBroadcasts.keys()) {
            if (key.endsWith(`:${message.emoteName}`)) {
              _deleteBroadcast(key)
            }
          }
          rebuildEmoteMapIfDirty()
          updateEmoteState(message.hash, message.emoteName, 'neutral')
          updateEmoteBridge()
          window.postMessage({ type: 'heatsync-inventory-update', count: emoteInventory.length }, location.origin)
          break

        case 'global_emotes_update':
          globalEmotes = message.emotes
          allEmotesDirty = true
          emoteGeneration++
          rebuildEmoteMapIfDirty()
          log(' Global emotes updated:', globalEmotes.length)
          if (globalEmotes.length > 0) {
            log(
              ' Sample global emotes:',
              globalEmotes.slice(0, 5).map((e) => e.name),
            )
          }
          debouncedProcessExistingMessages() // Re-process existing messages with new globals
          updateEmoteBridge() // Update Twitch autocomplete hook
          break

        case 'channel_emotes_update': {
          // Only accept emotes for THIS tab's channel and platform
          const myChannel = getPageChannel()
          const emoteOwner = (message.channelOwner || '').toLowerCase()
          if (myChannel && emoteOwner && emoteOwner !== myChannel) {
            log(' Ignoring channel emotes for', emoteOwner, '(this tab is', `${myChannel})`)
            break
          }
          if (message.platform) {
            const myPlatform = window.location.hostname.includes('kick.com') ? 'kick' : 'twitch'
            if (message.platform !== myPlatform) {
              log(' Ignoring channel emotes for platform', message.platform, '(this tab is', `${myPlatform})`)
              break
            }
          }
          const newEmotes = (message.emotes || []).map((e) => ({
            ...e,
            url: normalizeEmoteUrl(e.url),
          }))
          // Skip reprocessing if emotes haven't actually changed (e.g. cached broadcast on rejoin)
          if (
            channelEmotes.length === newEmotes.length &&
            channelEmotes.length > 0 &&
            channelEmotes.every((e, i) => e.hash === newEmotes[i]?.hash && e.name === newEmotes[i]?.name)
          ) {
            log(' Channel emotes unchanged for', emoteOwner, '- skipping reprocess')
            break
          }
          channelEmotes = newEmotes
          allEmotesDirty = true
          emoteGeneration++
          rebuildEmoteMapIfDirty()
          currentChannelOwner = emoteOwner || null
          log(' Channel owner emotes updated:', channelEmotes.length, 'for channel:', currentChannelOwner)
          if (channelEmotes.length > 0) {
            log(
              ' Sample channel emotes:',
              channelEmotes.slice(0, 5).map((e) => e.name),
            )
          }
          debouncedProcessExistingMessages()
          updateEmoteBridge()
          break
        }

        case 'emote_blocked':
          // Drop the broadcast if the user just locally unblocked this hash —
          // it's a stale echo from a prior block, not a fresh action.
          if (recentBlockToggleState(message.hash) === 'unblocked') break
          blockedEmotes.add(message.hash)
          hideBlockedEmote(message.hash)
          window.postMessage({ type: 'heatsync-blocked-sync', hashes: Array.from(blockedEmotes) }, location.origin)
          break

        case 'emote_unblocked':
          if (recentBlockToggleState(message.hash) === 'blocked') break
          blockedEmotes.delete(message.hash)
          showUnblockedEmote(message.hash)
          window.postMessage({ type: 'heatsync-blocked-sync', hashes: Array.from(blockedEmotes) }, location.origin)
          break

        case 'followed_users_updated':
          followedByCurrentUser = new Set(message.users || [])
          log(' Followed users updated:', followedByCurrentUser.size)
          break

        case 'emote_add_failed': {
          log(' ❌ Failed to add emote:', message.emoteName, message.error)
          // Logged-out is the common case, not a failure — collapse the per-emote
          // red errors into one gentle deduped nudge (statusbar dedupes identical
          // text to ×N). Real failures still surface the actual error.
          const addErr = String(message.error || '')
          if (/not logged in/i.test(addErr)) {
            showToast('log in to heatsync.org to add emotes', 'info')
          } else {
            showToast(t('content_toast_failed_add', [message.emoteName, addErr]), 'error')
          }
          // 2-state model: no `add:` pendingOperations keys exist anymore;
          // stack-click + auto-add-on-send register under different keys.
          // No emote_remove_failed handler — chat-row right-click is block-only
          // now, so the background never emits emote_remove_failed to content.js.
          break
        }

        case 'user_muted': {
          // Key may be namespaced (twitch:alice) or legacy bare (alice). Store as
          // received; DOM ops need the bare display name so extract it.
          const muteBare = message.username?.includes(':') ? message.username.split(':')[1] : message.username
          mutedUsers.add(message.username)
          muteUser(muteBare || message.username)
          break
        }

        case 'user_unmuted': {
          const unmuteBare = message.username?.includes(':') ? message.username.split(':')[1] : message.username
          mutedUsers.delete(message.username)
          if (unmuteBare && unmuteBare !== message.username) mutedUsers.delete(unmuteBare) // clear legacy bare
          unmuteUser(unmuteBare || message.username)
          break
        }

        case 'user_blocked': {
          const blockBare = message.username?.includes(':') ? message.username.split(':')[1] : message.username
          blockedUsers.add(message.username)
          hideBlockedUser(blockBare || message.username)
          break
        }

        case 'user_unblocked': {
          const unblockBare = message.username?.includes(':') ? message.username.split(':')[1] : message.username
          blockedUsers.delete(message.username)
          if (unblockBare && unblockBare !== message.username) blockedUsers.delete(unblockBare) // clear legacy bare
          unhideBlockedUser(unblockBare || message.username)
          break
        }

        case 'channel_emote_added':
          // Handled by multichat.js as a persistent stream-event. Also clear the
          // stale-ghost class from any previously-rendered emote of that name in
          // the native Twitch/Kick chat DOM (we use Twitch's own wrapper class).
          if (message.emote?.name) {
            try {
              const sel = `[data-emote-name="${CSS.escape(message.emote.name)}"]`
              document.querySelectorAll(sel).forEach((el) => {
                el.classList.remove('hs-state-stale')
                delete el.dataset.staleActor
                delete el.dataset.staleAt
              })
            } catch (_e) {}
          }
          break

        case 'cosmetics_invalidated':
          // 7TV EventAPI pushed a user update — drop the local cache for that
          // twitch ID and trigger a fresh lookup. We DON'T strip badges from DOM
          // here (no flicker): applyCosmeticsToMessage diff-updates the badge
          // src in-place if changed, removes if revoked, or no-ops if unchanged.
          if (message.twitchId) {
            cosmeticsCache.delete(message.twitchId)
            // Clear the fast-path bail flag on existing messages so applyPending
            // can re-run the diff-update after the next fetch lands.
            const sel = `[data-hs-cosmetic-applied-for="${CSS.escape(message.twitchId)}"]`
            document.querySelectorAll(sel).forEach((el) => {
              delete el.dataset.hsCosmeticDone
            })
            queueCosmeticsLookup(message.twitchId)
          }
          break

        case 'channel_emote_removed':
          // Handled by multichat.js as a persistent stream-event. Also patch the
          // native Twitch/Kick chat DOM: query existing rendered emotes by name
          // and add hs-state-stale + actor metadata so they dim in-place.
          if (message.emoteName) {
            try {
              const sel = `[data-emote-name="${CSS.escape(message.emoteName)}"]`
              document.querySelectorAll(sel).forEach((el) => {
                el.classList.add('hs-state-stale')
                if (message.actor) el.dataset.staleActor = message.actor
                el.dataset.staleAt = String(Date.now())
              })
            } catch (_e) {}
          }
          break

        case 'emote_removed_broadcast': {
          // Another user removed an emote, clear their pending broadcast
          const removeKey = `${message.username.toLowerCase()}:${message.emoteName}`
          if (pendingEmoteBroadcasts.has(removeKey)) {
            log(' 🗑️ Clearing broadcast (user removed emote):', removeKey)
            _deleteBroadcast(removeKey)
          }
          // Also drop the name from any cached sender_emote_set so old messages
          // from that user stop imagifying it. Matches multichat panel behavior.
          if (message.emoteName) {
            for (const [, inner] of senderHeatsyncEmotes) {
              if (inner?.delete?.(message.emoteName)) {
                // Removed — also bust freshness so next message triggers refetch
              }
            }
          }
          break
        }

        case 'emote_added_broadcast':
          // Different user added an emote. Drop freshness for all cached senders
          // so next message render refetches their set and picks up the new emote.
          senderEmoteFetchedAt.clear()
          break

        case 'emote_broadcast': {
          // Reject broadcasts for emotes we're actively removing (WS echo race condition)
          if (pendingRemovals.has(message.emoteName)) {
            log(' 🚫 Rejecting broadcast for removed emote:', message.emoteName)
            break
          }
          // Defense-in-depth: re-validate emote URL at content-script intake.
          // Background already filters, but content trusts no one.
          {
            const u = message.emoteData?.url
            if (typeof u !== 'string' || !u) break
            const isAbs = u.startsWith('http://') || u.startsWith('https://')
            const isRel = u.startsWith('/')
            if (!isAbs && !isRel) break
            if (isAbs && !u.startsWith('https://')) break
            if (
              typeof message.emoteName !== 'string' ||
              message.emoteName.length === 0 ||
              message.emoteName.length > 100
            )
              break
            if (typeof message.username !== 'string' || !/^[a-zA-Z0-9_]{1,32}$/.test(message.username)) break
          }
          // Another user sent an emote, store for upcoming message
          const broadcastKey = `${message.username.toLowerCase()}:${message.emoteName}`
          log(' 📥 RECEIVED BROADCAST:', {
            username: message.username,
            emoteName: message.emoteName,
            key: broadcastKey,
            emoteUrl: message.emoteData?.url,
            pendingCount: pendingEmoteBroadcasts.size,
          })
          _addBroadcast(broadcastKey, { ...message.emoteData, addedAt: Date.now() })

          // Retroactively process recent messages from this user
          retroactivelyProcessBroadcast(message.username, message.emoteName, message.emoteData)

          // Clear after 10 seconds - long enough for race conditions, short enough to prevent stale renders
          cleanup.setTimeout(() => {
            if (pendingEmoteBroadcasts.has(broadcastKey)) {
              log(' ⏰ Broadcast expired:', broadcastKey)
              _deleteBroadcast(broadcastKey)
            }
          }, 10000)
          break
        }

        case 'ui_settings_changed':
          applyUiSettings(message.settings)
          break

        case 'cosmetics_update': {
          const bttv = Object.entries(message.bttvBadges || {})
          const ffz = Object.entries(message.ffzBadges || {})
          const chat = Object.entries(message.chatterinoBadges || {})
          // Never let an empty broadcast wipe populated maps.
          if (bttv.length + ffz.length + chat.length > 0) {
            bttvBadgeMap = new Map(bttv)
            ffzBadgeMap = new Map(ffz)
            chatterinoBadgeMap = new Map(chat)
            reapplyBadgesToExistingMessages()
          }
          break
        }

        case 'follow_colors':
          if (message.colors && typeof message.colors === 'object') {
            for (const [login, color] of Object.entries(message.colors)) {
              if (color) heatsyncColorMap.set(login.toLowerCase(), color)
            }
            while (heatsyncColorMap.size > HEATSYNC_COLOR_MAP_MAX)
              heatsyncColorMap.delete(heatsyncColorMap.keys().next().value)
            log(' HeatSync colors loaded:', heatsyncColorMap.size)
            applyHeatsyncColorsToExisting()
          }
          break

        case 'heat_batch_update':
          // Server pushes user-heat updates every 60s for changed users.
          // Update the username-keyed cache directly — saves a full /api/users/heat
          // round-trip per user. Re-render heat borders so visible messages reflect
          // the new tier without waiting for the next batch flush.
          if (Array.isArray(message.updates)) {
            const now = Date.now()
            for (const u of message.updates) {
              if (!u || typeof u.username !== 'string') continue
              const key = u.username.toLowerCase()
              if (heatCache.size >= HEAT_CACHE_MAX) {
                heatCache.delete(heatCache.keys().next().value)
              }
              heatCache.set(key, {
                heat: typeof u.userHeat === 'number' ? u.userHeat : 0,
                op: typeof u.op === 'number' ? u.op : 0,
                re: typeof u.re === 'number' ? u.re : 0,
                fetchedAt: now,
              })
            }
            applyHeatBorders()
          }
          break

        default:
          log(' Unknown message type:', message.type)
      }
    } catch (err) {
      console.error('[heatsync] onMessage handler error:', err)
    }
  }
  chrome.runtime.onMessage.removeListener(_onMessageMain)
  chrome.runtime.onMessage.addListener(_onMessageMain)

  // Kick chat-mode relay — PUT /api/v1/chatrooms/<id>. Route confirmed by kick
  // itself: GET on it answers 405 "Supported methods: PUT". Body mirrors the
  // shape GET /api/v2/channels/<slug>/chatroom returns (laravel resource
  // symmetry), e.g. { slow_mode: { enabled: true, message_interval: 10 } }.
  // Lives here for the same reason the send relay does: kick's mutations need
  // the tab's own cookies alongside the XSRF + bearer pair.
  function _onMessageKickChatMode(message, _sender, sendResponse) {
    if (message.type !== 'kick_chatmode_relay') return
    const headers = {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': decodeURIComponent(message.xsrfToken),
    }
    if (message.sessionToken) headers.Authorization = `Bearer ${decodeURIComponent(message.sessionToken)}`
    fetch(`https://kick.com/api/v1/chatrooms/${encodeURIComponent(message.chatroomId)}`, {
      method: 'PUT',
      headers,
      credentials: 'include',
      body: JSON.stringify(message.body || {}),
      signal: AbortSignal.timeout(10000),
    })
      .then((r) =>
        r.text().then((t) => {
          let row = null
          try {
            row = JSON.parse(t)
          } catch {}
          // The PUT echoes the authoritative chatroom row — hand it back so the
          // caller can confirm without a second (cached, stale) read.
          if (r.ok) sendResponse({ ok: true, row })
          else sendResponse({ ok: false, error: `${r.status}: ${t.slice(0, 160)}` })
        }),
      )
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async sendResponse
  }
  chrome.runtime.onMessage.removeListener(_onMessageKickChatMode)
  chrome.runtime.onMessage.addListener(_onMessageKickChatMode)

  // Kick send relay — only active on kick.com tabs
  // Separate listener because it needs async sendResponse (return true)
  function _onMessageKickRelay(message, _sender, sendResponse) {
    if (message.type !== 'kick_send_relay') return
    // Reply-shaped when the caller carries a parent ref (kick's own client
    // payload shape: type 'reply' + original_message/original_sender metadata).
    // kick-send.js falls back to a flat send if kick 4xxes the reply shape.
    const _kickBody = message.reply?.id
      ? {
          content: message.content,
          type: 'reply',
          metadata: {
            original_message: { id: message.reply.id, content: message.reply.content || '' },
            original_sender: {
              id: message.reply.senderId != null ? Number(message.reply.senderId) : 0,
              username: message.reply.senderUsername || '',
            },
          },
        }
      : { content: message.content, type: 'message' }
    const _kickSendHeaders = {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': decodeURIComponent(message.xsrfToken),
    }
    // Kick requires Authorization: Bearer <session_token> on sends now —
    // cookies+XSRF alone 403 "User is not authenticated" (2026-07).
    if (message.sessionToken) _kickSendHeaders.Authorization = `Bearer ${decodeURIComponent(message.sessionToken)}`
    fetch(`https://kick.com/api/v2/messages/send/${message.channelId}`, {
      method: 'POST',
      headers: _kickSendHeaders,
      credentials: 'include',
      body: JSON.stringify(_kickBody),
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => {
        if (r.ok) sendResponse({ ok: true })
        else
          r.text()
            .then((t) => sendResponse({ ok: false, error: `${r.status}: ${t}` }))
            .catch(() => sendResponse({ ok: false, error: `${r.status}` }))
      })
      // A 10s AbortSignal.timeout beats kick-send.js's own 11s sentinel, so the
      // abort — not the sentinel — is what sendKickMessage sees. Normalize it to
      // the literal 'timeout' so it hits the no-auto-retry path (the POST may
      // already be live in chat; retrying would double-post). Other errors keep
      // their message — a connection failure means the POST never landed, so a
      // retry is safe there.
      .catch((e) => sendResponse({ ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message }))
    return true // async sendResponse
  }
  if (window.location.hostname.includes('kick.com')) {
    chrome.runtime.onMessage.removeListener(_onMessageKickRelay)
    chrome.runtime.onMessage.addListener(_onMessageKickRelay)
  }

  // Kick mod relay — ban / timeout / unban / delete-message.
  // Runs on kick.com tab so X-XSRF-TOKEN + session cookies are same-origin.
  function _onMessageKickModRelay(message, _sender, sendResponse) {
    if (message.type !== 'kick_mod_relay') return
    const xsrf = decodeURIComponent(message.xsrfToken || '')
    const baseHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': xsrf,
    }
    // Same bearer requirement as kick_send_relay (2026-07 kick auth change).
    if (message.sessionToken) baseHeaders.Authorization = `Bearer ${decodeURIComponent(message.sessionToken)}`
    let url, method, body
    const slug = encodeURIComponent(String(message.slug || ''))
    const username = String(message.username || '').replace(/^@/, '')
    if (message.action === 'ban') {
      url = `https://kick.com/api/v2/channels/${slug}/bans`
      method = 'POST'
      body = { banned_username: username, permanent: true }
      if (message.reason) body.reason = message.reason
    } else if (message.action === 'timeout') {
      url = `https://kick.com/api/v2/channels/${slug}/bans`
      method = 'POST'
      body = {
        banned_username: username,
        permanent: false,
        duration: Math.max(1, Math.floor(Number(message.durationMin) || 10)),
      }
      if (message.reason) body.reason = message.reason
    } else if (message.action === 'unban') {
      url = `https://kick.com/api/v2/channels/${slug}/bans/${encodeURIComponent(username)}`
      method = 'DELETE'
      body = null
    } else if (message.action === 'delete') {
      if (!message.chatroomId || !message.messageId) {
        sendResponse({ ok: false, error: 'missing params' })
        return true
      }
      url = `https://kick.com/api/v2/chatrooms/${encodeURIComponent(message.chatroomId)}/messages/${encodeURIComponent(message.messageId)}`
      method = 'DELETE'
      body = null
    } else {
      sendResponse({ ok: false, error: 'unknown action' })
      return true
    }
    const init = {
      method,
      headers: baseHeaders,
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    }
    if (body) init.body = JSON.stringify(body)
    // Translate the raw HTTP status into something a moderator can act on, instead
    // of surfacing "403: {json blob}" in the toast.
    const explain = (status, raw) => {
      if (status === 401 || status === 403) return "you're not a mod on kick here (or your kick session expired)"
      if (status === 404) return 'user or message not found on kick'
      if (status === 429) return 'kick rate limited — wait a moment'
      if (status >= 500) return `kick server error (${status})`
      return `${status}: ${String(raw || '').slice(0, 160)}`
    }
    fetch(url, init)
      .then((r) => {
        if (r.ok || r.status === 204) {
          sendResponse({ ok: true })
          return
        }
        r.text()
          .then((t) => sendResponse({ ok: false, error: explain(r.status, t) }))
          .catch(() => sendResponse({ ok: false, error: explain(r.status, '') }))
      })
      .catch((e) =>
        sendResponse({ ok: false, error: e.name === 'TimeoutError' ? 'kick request timed out' : e.message }),
      )
    return true
  }
  if (window.location.hostname.includes('kick.com')) {
    chrome.runtime.onMessage.removeListener(_onMessageKickModRelay)
    chrome.runtime.onMessage.addListener(_onMessageKickModRelay)
  }

  // Debounce reprocessing so rapid emote updates only trigger one pass
  let reprocessDebounce = null
  function debouncedProcessExistingMessages() {
    clearTimeout(reprocessDebounce)
    reprocessDebounce = cleanup.setTimeout(() => processExistingMessages(), 200)
  }

  // Collect chatters from a message without full processing (for two-pass approach)
  function collectChatterFromMessage(messageElement) {
    if (messageElement.dataset.hsChattersCollected) return
    const usernameElement = messageElement.querySelector(
      '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
    )
    if (!usernameElement) return

    const username = usernameElement.textContent?.trim().toLowerCase()
    if (!username || username.length === 0 || username.length > 30) return

    messageElement.dataset.hsChattersCollected = '1'
    // Skip if already known (don't override with potentially different computed color)
    if (knownChatters.has(username)) return

    const color = usernameElement.style.color || '#ffffff'
    knownChatters.set(username, color)
  }

  // Process existing chat messages
  function processExistingMessages() {
    // Overlay up → native rows are hidden; skip the full re-sweep (fires on channel
    // switch + every inventory/emote change).
    if (isOverlayActive()) return
    const startTime = performance.now()
    const chatContainer = findChatContainer()
    log(' 🔍 processExistingMessages: chatContainer=', chatContainer ? 'FOUND' : 'NULL')
    if (!chatContainer) return

    const gen = emoteGeneration

    // Single combined query — Twitch (chat-line + user-notice) + Kick ([data-index]).
    // Two separate querySelectorAll calls on chat root cost ~2 full subtree scans.
    const messages = chatContainer.querySelectorAll('.chat-line__message, .user-notice-line, [data-index]')

    log(' 📨 Found', messages.length, 'messages to process')

    // TWO-PASS APPROACH for username coloring (Chatterino-style):
    // Pass 1: Collect ALL chatters first so we know everyone who has spoken
    const messageArray = Array.from(messages)
    for (const msg of messageArray) {
      collectChatterFromMessage(msg)
    }
    log(` 👥 Collected ${knownChatters.size} chatters for username coloring`)
    if (knownChatters.size > 0 && knownChatters.size <= 20) {
      log(' Known chatters:', [...knownChatters.keys()].join(', '))
    }

    // Pass 2: Process messages (now username coloring will work for all known chatters)
    // Filter by generation: messages from older generations need reprocessing
    const unprocessed = messageArray.filter((msg) => msg.dataset.heatsyncGeneration !== gen)
    if (unprocessed.length === 0) return

    // Process visible tail first (bottom = on-screen). Both halves go through
    // hsSched.chunk: 4ms budget per slice, yields between, pauses while user
    // is actively scrolling. Replaces the old "10 msgs per rAF" loop that
    // could spend 150ms on one frame when processMessage hit a heavy msg.
    const VISIBLE_ESTIMATE = 50
    const tail = unprocessed.slice(-VISIBLE_ESTIMATE)
    const head = unprocessed.length > VISIBLE_ESTIMATE ? unprocessed.slice(0, -VISIBLE_ESTIMATE) : []

    ;(async () => {
      // Tail gets a slightly larger budget — these are on-screen, user is
      // most likely to notice "missing cosmetics" on them, so we err toward
      // painting them sooner. Still bounded so scroll never feels locked.
      await hsSched.chunk(tail, processMessage, { budgetMs: 5 })
      if (head.length > 0) {
        // Head is offscreen by definition (chat is bottom-anchored). Drop to
        // background priority so it never competes with input or animation.
        await hsSched.idle(async () => {
          await hsSched.chunk(head, processMessage, { budgetMs: 3 })
        })
      }
      log(
        ` ⏱️ Processed ${unprocessed.length} messages (${tail.length} tail, ${head.length} head) in ${(performance.now() - startTime).toFixed(0)}ms`,
      )
    })()
  }

  // ============================================================
  // Chat message cache — persist messages across page reloads
  // Matches website behavior: 2000 msgs/channel, 24h TTL, debounced saves
  // ============================================================
  const MSG_CACHE_MAX = 500
  const MSG_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
  let msgCacheBuffer = [] // in-memory buffer of {id, user, text, color, ts}
  const msgCacheIds = new Set() // O(1) dedup lookup for message IDs
  let msgCacheSaveTimer = null
  let msgCacheChannel = null

  function getMsgCacheKey(channel) {
    return `hs_msg_cache_${channel}`
  }

  // Extract serializable data from a DOM message element
  function serializeMessage(el) {
    const id = el.getAttribute('data-msg-id') || ''
    const user = getUsername(el)
    if (!user) return null
    const textEl = el.querySelector('[data-a-target="chat-message-text"], .text-fragment, span.font-normal')
    const text = textEl?.textContent?.trim() || ''
    if (!text) return null
    const nameEl = el.querySelector('.chat-author__display-name, button.inline.font-bold')
    const color = nameEl?.style?.color || '#ffffff'
    // Twitch user-id (for cosmetic re-application on restore — without this,
    // restored cached messages get no 7TV badge / paint / BTTV / FFZ / Chatterino)
    const uid = el.getAttribute('data-user-id') || ''
    return { id, user, text, color, uid, ts: Date.now() }
  }

  // Capture a message into the cache buffer (called from MutationObserver)
  function captureMessageToCache(el) {
    if (!msgCacheChannel) return
    const msg = serializeMessage(el)
    if (!msg) return
    // Dedup by id (O(1) via Set)
    if (msg.id && msgCacheIds.has(msg.id)) return
    if (msg.id) msgCacheIds.add(msg.id)
    msgCacheBuffer.push(msg)
    // Trim to cap
    if (msgCacheBuffer.length > MSG_CACHE_MAX) {
      const removed = msgCacheBuffer.splice(0, msgCacheBuffer.length - MSG_CACHE_MAX)
      for (const r of removed) if (r.id) msgCacheIds.delete(r.id)
    }
    // Debounced save
    scheduleMsgCacheSave()
  }

  function scheduleMsgCacheSave() {
    if (msgCacheSaveTimer) return
    msgCacheSaveTimer = cleanup.setTimeout(() => {
      msgCacheSaveTimer = null
      saveMsgCache()
    }, 5000) // 5s debounce
  }

  function saveMsgCache() {
    if (!msgCacheChannel || msgCacheBuffer.length === 0) return
    try {
      const key = getMsgCacheKey(msgCacheChannel)
      localStorage.setItem(
        key,
        JSON.stringify({
          messages: msgCacheBuffer.slice(-MSG_CACHE_MAX),
          channel: msgCacheChannel,
          savedAt: Date.now(),
        }),
      )
    } catch (_e) {
      // localStorage full — evict oldest channel caches
      try {
        const keys = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k?.startsWith('hs_msg_cache_')) keys.push(k)
        }
        if (keys.length > 5) {
          // Remove oldest 3
          const sorted = keys
            .map((k) => {
              try {
                return { k, t: JSON.parse(localStorage.getItem(k)).savedAt || 0 }
              } catch {
                return { k, t: 0 }
              }
            })
            .sort((a, b) => a.t - b.t)
          for (let i = 0; i < 3 && i < sorted.length; i++) localStorage.removeItem(sorted[i].k)
          // Retry save
          localStorage.setItem(
            getMsgCacheKey(msgCacheChannel),
            JSON.stringify({
              messages: msgCacheBuffer.slice(-MSG_CACHE_MAX),
              channel: msgCacheChannel,
              savedAt: Date.now(),
            }),
          )
        }
      } catch {}
    }
  }

  // Load cached messages and render them into the chat container
  function restoreMsgCache(channel, chatContainer) {
    // Skip on Kick — injecting Twitch-classed DOM into React virtual scroll corrupts it
    if (isKick) return 0
    try {
      const raw = localStorage.getItem(getMsgCacheKey(channel))
      if (!raw) return 0
      const data = JSON.parse(raw)
      if (!data.messages?.length) return 0
      // Check TTL
      if (Date.now() - (data.savedAt || 0) > MSG_CACHE_TTL) {
        localStorage.removeItem(getMsgCacheKey(channel))
        return 0
      }

      // Collect existing message IDs from DOM for dedup
      const existingIds = new Set()
      const existingTexts = new Set()
      chatContainer.querySelectorAll('[data-msg-id]').forEach((el) => existingIds.add(el.dataset.msgId))
      chatContainer.querySelectorAll('.chat-line__message').forEach((el) => {
        const user = el.querySelector('.chat-author__display-name')?.textContent?.trim()
        const text = el.querySelector('[data-a-target="chat-message-text"]')?.textContent?.trim()
        if (user && text) existingTexts.add(`${user.toLowerCase()}:${text.substring(0, 80)}`)
      })

      const fragment = document.createDocumentFragment()
      let inserted = 0

      for (const msg of data.messages) {
        // skip malformed cache entries (legacy/partial blobs) instead of letting
        // one bad item throw and abort the whole scrollback restore
        if (!msg || typeof msg.user !== 'string' || typeof msg.text !== 'string') continue
        if (msg.id && existingIds.has(msg.id)) continue
        const dedupKey = `${msg.user.toLowerCase()}:${msg.text.substring(0, 80)}`
        if (existingTexts.has(dedupKey)) continue
        existingTexts.add(dedupKey)

        const div = document.createElement('div')
        div.className = `chat-line__message heatsync-cached${msg.timedOut ? ' hs-timed-out' : ''}`
        div.setAttribute('data-heatsync-cached', 'true')
        if (msg.id) div.setAttribute('data-msg-id', msg.id)
        // Restore twitch user id so cosmetics pipeline picks up these messages
        if (msg.uid && /^\d+$/.test(msg.uid)) div.setAttribute('data-user-id', msg.uid)
        if (msg.user) div.setAttribute('data-a-user', msg.user.toLowerCase())

        const nameSpan = document.createElement('span')
        nameSpan.className = 'chat-author__display-name'
        nameSpan.setAttribute('data-a-target', 'chat-message-username')
        nameSpan.style.color = msg.color
        nameSpan.textContent = msg.user

        const colonSpan = document.createElement('span')
        colonSpan.setAttribute('aria-hidden', 'true')
        colonSpan.textContent = ': '

        const textSpan = document.createElement('span')
        textSpan.className = 'text-fragment'
        textSpan.setAttribute('data-a-target', 'chat-message-text')
        textSpan.textContent = msg.text

        div.appendChild(nameSpan)
        div.appendChild(colonSpan)
        div.appendChild(textSpan)
        fragment.appendChild(div)
        inserted++
      }

      if (inserted > 0) {
        chatContainer.insertBefore(fragment, chatContainer.firstChild)
        log(` 💾 Restored ${inserted} cached messages`)
        // Seed the in-memory buffer with cached data
        msgCacheBuffer = data.messages
        // Cosmetics back-fill: cached entries from older builds didn't store
        // the twitch id. Look up uid by username from any live (uid-bearing)
        // message in the chat and stamp it on cached messages so 7TV/BTTV/
        // FFZ/Chatterino badges + 7TV paint apply to history too.
        backfillCachedMessageUids(chatContainer)
      }
      return inserted
    } catch (e) {
      log(' Cache restore error:', e)
      return 0
    }
  }

  function backfillCachedMessageUids(chatContainer) {
    try {
      const usernameToUid = new Map()
      chatContainer.querySelectorAll('.chat-line__message[data-user-id]').forEach((el) => {
        const uid = el.getAttribute('data-user-id')
        const username =
          el.dataset.aUser || el.querySelector('.chat-author__display-name')?.textContent?.trim().toLowerCase()
        if (uid && username) usernameToUid.set(username, uid)
      })
      if (usernameToUid.size === 0) return 0
      let stamped = 0
      chatContainer.querySelectorAll('.chat-line__message:not([data-user-id])').forEach((el) => {
        const username =
          el.dataset.aUser || el.querySelector('.chat-author__display-name')?.textContent?.trim().toLowerCase()
        if (!username) return
        const uid = usernameToUid.get(username)
        if (!uid) return
        el.setAttribute('data-user-id', uid)
        el.dataset.hsCosmeticUserId = uid
        const usernameEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
        applyCosmeticsToMessage(el, uid, usernameEl)
        queueCosmeticsLookup(uid)
        stamped++
      })
      if (stamped > 0) log(` 🎨 Back-filled uid on ${stamped} cached messages from username map`)
      return stamped
    } catch (e) {
      log(' backfillCachedMessageUids error:', e?.message)
      return 0
    }
  }

  // Initialize cache for current channel
  function initMsgCache(channel) {
    msgCacheChannel = channel
    if (msgCacheBuffer.length === 0) {
      // Load existing cache into memory buffer
      try {
        const raw = localStorage.getItem(getMsgCacheKey(channel))
        if (raw) {
          const data = JSON.parse(raw)
          if (data.messages?.length && Date.now() - (data.savedAt || 0) < MSG_CACHE_TTL) {
            msgCacheBuffer = data.messages
          }
        }
      } catch {}
    }
  }

  // Backfill chat history from robotty recent-messages API
  // Fires once per channel join, fetches ~500 recent messages, deduplicates against
  // native Twitch messages, and inserts missing ones at the top of the chat container.
  async function backfillChatHistory() {
    const chatContainer = findChatContainer()
    if (!chatContainer) return
    if (chatContainer.dataset.heatsyncBackfilled) return
    chatContainer.dataset.heatsyncBackfilled = 'true'

    // Extract channel name from URL
    const match =
      window.location.href.match(/\/popout\/([^/]+)\/chat/) || window.location.href.match(/twitch\.tv\/([^/?]+)/)
    const channel = match?.[1]?.toLowerCase()
    if (!channel) return

    if (TWITCH_EXCLUDED_PATHS.includes(channel)) return

    log(' 📜 Backfilling chat history for', channel)

    try {
      // Relayed through the SW: direct cross-origin fetches from content
      // scripts trip Cloudflare bot heuristics (edge 503).
      const data = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'fetch_recent_messages', channel }, (resp) => {
            if (chrome.runtime.lastError) resolve(null)
            else resolve(resp)
          })
        } catch {
          resolve(null)
        }
      })
      if (!data) {
        log(' Backfill fetch failed')
        return
      }
      if (!data.messages?.length) return

      // Collect existing message IDs from DOM for dedup
      const existingIds = new Set()
      const existingTexts = new Set()
      chatContainer.querySelectorAll('[data-msg-id]').forEach((el) => {
        existingIds.add(el.dataset.msgId)
      })
      // Fallback dedup: collect username+text combos from visible messages
      chatContainer.querySelectorAll('.chat-line__message').forEach((el) => {
        const user = el.querySelector('.chat-author__display-name')?.textContent?.trim()
        const text = el.querySelector('[data-a-target="chat-message-text"]')?.textContent?.trim()
        if (user && text) existingTexts.add(`${user.toLowerCase()}:${text.substring(0, 80)}`)
      })

      const fragment = document.createDocumentFragment()
      let inserted = 0

      for (const line of data.messages) {
        // Parse PRIVMSG
        const m = line.match(/@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #(\w+) :(.+)/)
        if (!m) continue

        const tags = {}
        m[1].split(';').forEach((t) => {
          const [k, v] = t.split('=')
          tags[k] = v
        })
        const msgId = tags.id || ''
        const username = tags['display-name'] || m[2]
        const text = m[4]
        const color = tags.color || '#ffffff'
        const userId = tags['user-id'] || ''

        // Dedup: skip if message ID already in DOM
        if (msgId && existingIds.has(msgId)) continue
        // Dedup: skip if username+text matches (fallback)
        const dedupKey = `${username.toLowerCase()}:${text.substring(0, 80)}`
        if (existingTexts.has(dedupKey)) continue
        existingTexts.add(dedupKey) // prevent dupes within backfill batch too

        // Build DOM element matching Twitch chat structure
        const div = document.createElement('div')
        div.className = 'chat-line__message heatsync-backfill'
        div.setAttribute('data-heatsync-backfill', 'true')
        if (msgId) div.setAttribute('data-msg-id', msgId)
        // Stamp twitch user-id from IRC tag so cosmetics (7tv badge/paint, bttv,
        // ffz, chatterino) work on backfilled messages too — robotty's tags
        // include this; without it the cosmetic pipeline silently no-ops.
        if (/^\d+$/.test(userId)) div.setAttribute('data-user-id', userId)
        if (username) div.setAttribute('data-a-user', username.toLowerCase())

        const nameSpan = document.createElement('span')
        nameSpan.className = 'chat-author__display-name'
        nameSpan.setAttribute('data-a-target', 'chat-message-username')
        nameSpan.style.color = color
        nameSpan.textContent = username

        const colonSpan = document.createElement('span')
        colonSpan.setAttribute('aria-hidden', 'true')
        colonSpan.textContent = ': '

        const textSpan = document.createElement('span')
        textSpan.className = 'text-fragment'
        textSpan.setAttribute('data-a-target', 'chat-message-text')
        textSpan.textContent = text // textContent is safe, no innerHTML

        div.appendChild(nameSpan)
        div.appendChild(colonSpan)
        div.appendChild(textSpan)
        fragment.appendChild(div)
        inserted++
      }

      if (inserted > 0) {
        // Preserve scroll position: inserting 500 messages at the top would push
        // the user's view up by ~500 message-heights. Capture scrollTop relative
        // to scrollHeight, insert, then restore so the visible content stays put.
        const scroller =
          chatContainer.closest('[class*="chat-scrollable-area__message-container"]')?.parentElement ||
          chatContainer.parentElement
        const wasAtBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 50
        const prevScrollHeight = scroller?.scrollHeight || 0
        chatContainer.insertBefore(fragment, chatContainer.firstChild)
        if (scroller) {
          if (wasAtBottom) {
            scroller.scrollTop = scroller.scrollHeight
          } else {
            // Maintain visual stability: anchor by adding the height delta
            scroller.scrollTop += scroller.scrollHeight - prevScrollHeight
          }
        }
        log(` 📜 Backfilled ${inserted} messages`)
        // Process emotes in backfilled messages
        processExistingMessages()
        // Re-run cosmetic uid back-fill: robotty backfill adds new usernames
        // (with uids) that may match older cached messages still missing uid.
        backfillCachedMessageUids(chatContainer)
      }

      // Capture all native Twitch messages into cache (ones that were already in DOM)
      if (msgCacheChannel) {
        chatContainer
          .querySelectorAll('.chat-line__message:not([data-heatsync-cached]):not([data-heatsync-backfill])')
          .forEach((el) => {
            captureMessageToCache(el)
          })
        saveMsgCache() // Force save after initial capture
      }
    } catch (e) {
      log(' Backfill error:', e)
    }
  }

  // Find Twitch or Kick chat container (cached — invalidated on nav via invalidateChatContainerCache)
  let _cachedChatContainer = null
  function findChatContainer() {
    // Return cache if still in DOM
    if (_cachedChatContainer && document.contains(_cachedChatContainer)) return _cachedChatContainer

    // Twitch popout chat
    if (window.location.hostname.includes('twitch.tv')) {
      _cachedChatContainer =
        document.querySelector('.chat-scrollable-area__message-container') ||
        document.querySelector('.chat-list--default')
    } else if (window.location.hostname.includes('kick.com')) {
      _cachedChatContainer =
        document.querySelector('#chatroom-messages .no-scrollbar') ||
        document.querySelector('#chatroom-messages') ||
        document.querySelector('#channel-chatroom')
    } else {
      _cachedChatContainer = null
    }

    return _cachedChatContainer
  }
  function invalidateChatContainerCache() {
    _cachedChatContainer = null
  }

  // Cache username once detected
  let cachedUsername = null
  let usernameDetectionAttempts = 0
  const MAX_USERNAME_ATTEMPTS = 30 // More attempts to handle slow page loads
  let usernameDetectionRetryTimer = null

  // Track all chatters who have sent messages (for username coloring)
  // LRU Map: re-insert on get to maintain access order, evict oldest when > 500
  const knownChatters = new (class extends Map {
    get(k) {
      if (!this.has(k)) return undefined
      const v = super.get(k)
      super.delete(k)
      super.set(k, v)
      return v
    }
  })()

  // Recently-active chatters — feeds the native autocomplete hooks so a chatter
  // you just saw talk leads bare-word Tab completion above emotes (parity with the
  // overlay's getRecencyMap). Time-windowed (last 10 min, cap 150 unique) so
  // "recent" matches what the user sees, not a flat count that ages out in seconds
  // on fast chat. Newest kept at the Map tail via delete-then-set.
  const RECENT_CHATTER_MAX = 150
  const RECENT_CHATTER_WINDOW_MS = 10 * 60 * 1000
  const recentChatterTimes = new Map() // lower -> { dn, t }
  function recordRecentChatter(lower, display) {
    if (!lower) return
    recentChatterTimes.delete(lower)
    recentChatterTimes.set(lower, { dn: display || lower, t: Date.now() })
    while (recentChatterTimes.size > 600) recentChatterTimes.delete(recentChatterTimes.keys().next().value)
    scheduleRecentChatterBridge()
  }
  function buildRecentChatterList() {
    // newest-first, within the time window, capped — { name: display, l: lower }
    // Absolute floor (last 10 REAL minutes), not relative to the newest entry —
    // otherwise a channel that went quiet would still lead with whoever talked in
    // its final pre-quiet 10 min. Stamps are Date.now(), so this is exact.
    const entries = [...recentChatterTimes.entries()]
    const floor = Date.now() - RECENT_CHATTER_WINDOW_MS
    const out = []
    for (let k = entries.length - 1; k >= 0 && out.length < RECENT_CHATTER_MAX; k--) {
      const [l, v] = entries[k]
      if (v.t && v.t < floor) break
      out.push({ name: v.dn, l })
    }
    return out
  }
  let _recentChatterBridgeTimer = null
  function scheduleRecentChatterBridge() {
    // Twitch's hook is MAIN-world — push the serialized list onto the DOM bridge,
    // throttled (recency changes every message; autocomplete reads the cache).
    if (_recentChatterBridgeTimer) return
    _recentChatterBridgeTimer = cleanup.setTimeout(() => {
      _recentChatterBridgeTimer = null
      try {
        const bridge = document.getElementById('heatsync-emote-bridge')
        if (bridge) bridge.dataset.recentChatters = JSON.stringify(buildRecentChatterList())
      } catch (_) {}
    }, 1500)
  }

  // Sub tenure tracking — extracted from Twitch badge alt text (subscriber badge)
  const subTenureMap = new Map() // usernameLC -> months

  function formatSubTenure(months) {
    // Concise: drop months when year-resolution is sufficient.
    if (months >= 12) return `${Math.floor(months / 12)}y`
    return `${months}mo`
  }

  // ============================================
  // HEAT CACHE + BATCH FETCHER
  // ============================================
  const HEAT_CACHE_MAX = 1000
  // 10min TTL — heat doesn't change fast enough to justify the 2min refetch
  // storm. At 30k users this drops /api/users/heat traffic by ~5x. The full
  // fix is server-pushed heat updates over WS (tracked server-side).
  const HEAT_CACHE_TTL = 600000 // 10 min
  // 5s debounce + per-client jitter — at 30k users a 2s synchronized debounce
  // produced ~15k req/sec spikes against the same 100-user batch endpoint.
  const HEAT_BATCH_INTERVAL = 5000
  const heatCache = new Map() // username -> { heat, op, re, fetchedAt }
  // Periodic cleanup — prune stale entries every 5 min
  cleanup.setIntervalIfVisible(() => {
    const now = Date.now()
    for (const [k, v] of heatCache) {
      if (now - v.fetchedAt > HEAT_CACHE_TTL) heatCache.delete(k)
    }
  }, 300000)
  const heatPending = new Set() // usernames awaiting batch fetch
  let heatBatchTimer = null
  let heatFirstBatch = true // first batch fires immediately

  // Third-party cosmetics
  let bttvBadgeMap = new Map()
  let ffzBadgeMap = new Map()
  let chatterinoBadgeMap = new Map()
  const heatsyncColorMap = new Map() // username → HeatSync API color (from follow:colors)
  const HEATSYNC_COLOR_MAP_MAX = 2000
  let cosmeticsEnabled = true // toggle for BTTV/FFZ/7TV cosmetics
  let dimTimeoutsEnabled = true // dim timed-out/banned messages instead of hiding
  const originalMessageBodies = new Map() // msg-id → cloned childNodes array (for restoring on timeout)
  const cosmeticsCache = new Map()
  const chatterTwitchIds = new Map() // lowerUser → twitch uid (mention cosmetics lookup)
  const CHATTER_IDS_MAX = 500
  let _selfTwitchIdRegistered = false
  const COSMETICS_TTL = 30 * 60 * 1000
  // Re-fetch null-cosmetic users every 5min so newly-added 7TV badges/paints
  // don't get masked for the full 30min TTL.
  const COSMETICS_NEGATIVE_TTL = 5 * 60 * 1000
  const COSMETICS_MAX = 500
  const cosmeticsPending = new Set()
  const COSMETICS_PENDING_MAX = 500
  let cosmeticsBatchTimer = null

  // Kick cosmetics (7TV paints/badges by username)
  const kickCosmeticsCache = new Map() // username → { paint, badge, fetchedAt }
  const kickCosmeticsPending = new Set()
  let kickCosmeticsBatchTimer = null

  // Heat tier config — monochrome intensity ramp (ext is taste-neutral; the
  // site keeps the orange gradient). Dark grey = cold, white = hot.
  const HEAT_GRADIENT = [
    '#808080',
    '#909090',
    '#a0a0a0',
    '#b0b0b0',
    '#c0c0c0',
    '#cccccc',
    '#d6d6d6',
    '#e2e2e2',
    '#f0f0f0',
    '#ffffff',
  ]

  function getHeatTier(heat) {
    if (heat >= 5000) return 9
    if (heat >= 1000) return 8
    if (heat >= 500) return 7
    if (heat >= 200) return 6
    if (heat >= 100) return 5
    if (heat >= 50) return 4
    if (heat >= 20) return 3
    if (heat >= 5) return 2
    if (heat >= 1) return 1
    return 0
  }

  function getHeatColor(heat) {
    return HEAT_GRADIENT[getHeatTier(heat)]
  }

  function queueHeatLookup(username) {
    const key = username.toLowerCase()
    if (heatCache.has(key) && Date.now() - heatCache.get(key).fetchedAt < HEAT_CACHE_TTL) return
    heatPending.add(key)

    if (heatFirstBatch) {
      // First batch fires immediately after initial chat load
      heatFirstBatch = false
      cleanup.setTimeout(() => flushHeatBatch(), 0)
    } else if (!heatBatchTimer) {
      // Add per-client jitter so 30k tabs don't synchronize their batches.
      const jitter = Math.random() * HEAT_BATCH_INTERVAL
      heatBatchTimer = cleanup.setTimeout(() => {
        heatBatchTimer = null
        flushHeatBatch()
      }, HEAT_BATCH_INTERVAL + jitter)
    }
  }

  async function flushHeatBatch() {
    if (heatPending.size === 0) return
    const batch = [...heatPending].slice(0, 100)
    batch.forEach((u) => heatPending.delete(u))

    try {
      const data = await HS.apiFetch('/api/users/heat', {
        method: 'POST',
        body: { usernames: batch },
      })
      if (!data) return

      const users = data.users
      const now = Date.now()
      for (const [name, data] of Object.entries(users)) {
        if (heatCache.size >= HEAT_CACHE_MAX) {
          heatCache.delete(heatCache.keys().next().value)
        }
        heatCache.set(name, { ...data, fetchedAt: now })
      }
      // Mark users not in response as 0 heat (they exist but no posts)
      for (const name of batch) {
        if (!heatCache.has(name) || heatCache.get(name).fetchedAt !== now) {
          if (heatCache.size >= HEAT_CACHE_MAX) {
            heatCache.delete(heatCache.keys().next().value)
          }
          heatCache.set(name, { heat: 0, op: 0, re: 0, fetchedAt: now })
        }
      }

      applyHeatBorders()
    } catch (err) {
      log(' Heat batch fetch failed:', err.message)
    }

    // If more pending, schedule another batch (jittered)
    if (heatPending.size > 0 && !heatBatchTimer) {
      const jitter = Math.random() * HEAT_BATCH_INTERVAL
      heatBatchTimer = cleanup.setTimeout(() => {
        heatBatchTimer = null
        flushHeatBatch()
      }, HEAT_BATCH_INTERVAL + jitter)
    }
  }

  function applyHeatBorderToElement(messageElement, heat) {
    if (heat < 5) return // no visual for low heat
    const tier = getHeatTier(heat)
    const color = HEAT_GRADIENT[tier]
    const borderWidth = tier >= 8 ? 6 : tier >= 5 ? 5 : tier >= 3 ? 4 : 3
    const s = messageElement.style
    // box-shadow inset doesn't reflow the chat (border-left did) — kills flicker
    // when heat data arrives after messages render.
    s.setProperty('box-shadow', `inset ${borderWidth}px 0 0 0 ${color}`)
    if (tier >= 5) {
      const glowAlpha = Math.min(0.3 + (tier - 5) * 0.1, 0.7)
      s.setProperty(
        'filter',
        `drop-shadow(0 0 ${10 + (tier - 5) * 3}px rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${glowAlpha}))`,
      )
    }
    if (tier >= 8) {
      s.setProperty('animation', 'hs-heat-breathe 2s ease-in-out infinite')
    }
    messageElement.dataset.hsHeatApplied = '1'
  }

  function applyHeatBorders() {
    const chatContainer = findChatContainer()
    if (!chatContainer) return

    const messages = chatContainer.querySelectorAll(
      '.chat-line__message:not([data-hs-heat-applied]), [data-index]:not([data-hs-heat-applied])',
    )
    for (const msg of messages) {
      const username = getUsername(msg)
      if (!username) continue
      const cached = heatCache.get(username.toLowerCase())
      if (cached) {
        applyHeatBorderToElement(msg, cached.heat)
      }
    }
  }

  // Get current user's username from Twitch DOM
  function getCurrentUsername() {
    // Return cached value if we already found it
    if (cachedUsername) {
      return cachedUsername
    }

    // Stop trying after MAX_USERNAME_ATTEMPTS (prevent console spam)
    if (usernameDetectionAttempts >= MAX_USERNAME_ATTEMPTS) {
      return null
    }

    usernameDetectionAttempts++

    // Try multiple methods to find username
    let username = null

    // Method 1: localStorage JSON object (most reliable - works everywhere)
    try {
      const twitchUserJson = localStorage.getItem('twilight.user')
      if (twitchUserJson) {
        const parsed = JSON.parse(twitchUserJson)
        username = parsed?.displayName || parsed?.login
        // Self twitch ID — register with background NOW (no need to wait for
        // a chat message) so 7TV cosmetics fetch + EventAPI sub start ASAP.
        const selfTwitchId = parsed?.id
        if (selfTwitchId && /^\d+$/.test(String(selfTwitchId)) && !_selfTwitchIdRegistered) {
          _selfTwitchIdRegistered = true
          safeSendMessage({ type: 'register_self_twitch_id', twitchId: String(selfTwitchId) })
        }
        if (username && username.length > 0 && username.length < 30) {
          log(' ✅ Found username from localStorage JSON:', username)
          cachedUsername = username.toLowerCase()
          return cachedUsername
        }
      }
    } catch (_e) {
      // JSON parse might fail
    }

    // Method 2: localStorage displayName string
    try {
      const twitchStorage = localStorage.getItem('twilight.user.displayName')
      if (twitchStorage) {
        username = twitchStorage.replace(/"/g, '').trim()
        if (username && username.length > 0 && username.length < 30) {
          log(' ✅ Found username from localStorage displayName:', username)
          cachedUsername = username.toLowerCase()
          return cachedUsername
        }
      }
    } catch (_e) {
      // localStorage access might fail
    }

    // Method 3: User menu button
    const userButton = document.querySelector('[data-a-target="user-menu-toggle"]')
    if (userButton) {
      const ariaLabel = userButton.getAttribute('aria-label')
      if (ariaLabel) {
        // Try different patterns
        username = ariaLabel
          .replace('User Menu. The user name is ', '')
          .replace('User menu: ', '')
          .replace('User Menu ', '')
          .trim()
        if (username && username.length > 0 && username.length < 30 && !username.includes(' ')) {
          log(' ✅ Found username from user menu button:', username)
          cachedUsername = username.toLowerCase()
          return cachedUsername
        }
      }
    }

    // Method 4: Figure element
    const figure = document.querySelector('[data-a-target="user-menu-toggle"] figure[aria-label]')
    if (figure) {
      username = figure.getAttribute('aria-label')
      if (username && username.length > 0 && username.length < 30 && !username.includes(' ')) {
        log(' ✅ Found username from figure:', username)
        cachedUsername = username.toLowerCase()
        return cachedUsername
      }
    }

    // Method 5: Chat input data attribute
    const chatInput = document.querySelector('[data-a-target="chat-input"]')
    if (chatInput) {
      username = chatInput.getAttribute('data-a-user')
      if (username && username.length > 0 && username.length < 30) {
        log(' ✅ Found username from chat input:', username)
        cachedUsername = username.toLowerCase()
        return cachedUsername
      }
    }

    // Method 6: Cookie fallback - look for twilight-user or name cookie
    try {
      const cookies = document.cookie
      // Twitch stores username in 'name' cookie
      const nameMatch = cookies.match(/(?:^|;\s*)name=([^;]+)/)
      if (nameMatch) {
        username = decodeURIComponent(nameMatch[1]).replace(/"/g, '')
        // Validate: must be alphanumeric/underscore, not a timestamp
        if (username && username.length > 0 && username.length < 30 && /^[a-zA-Z0-9_]+$/.test(username)) {
          log(' ✅ Found username from name cookie:', username)
          cachedUsername = username.toLowerCase()
          return cachedUsername
        }
      }
    } catch (_e) {
      // Cookie access might fail
    }

    // Kick methods
    if (window.location.hostname.includes('kick.com')) {
      // Method K1: Kick stores session data in localStorage
      try {
        const kickSession = localStorage.getItem('kick-session')
        if (kickSession) {
          const session = JSON.parse(kickSession)
          const name = session?.user?.username || session?.username
          if (name && /^[a-zA-Z0-9_]+$/.test(name)) {
            log(' ✅ Found Kick username from session storage:', name)
            cachedUsername = name.toLowerCase()
            return cachedUsername
          }
        }
      } catch {}
      // Method K2: Kick nav bar username link (current DOM)
      const kickUserLink = document.querySelector('a[href*="/dashboard"], nav a[href^="/"]')
      if (kickUserLink) {
        const href = kickUserLink.getAttribute('href')
        const match = href?.match(/^\/([a-zA-Z0-9_]+)(?:\/|$)/)
        if (
          match?.[1] &&
          !['categories', 'following', 'settings', 'search', 'dashboard'].includes(match[1].toLowerCase())
        ) {
          log(' ✅ Found Kick username from nav link:', match[1])
          cachedUsername = match[1].toLowerCase()
          return cachedUsername
        }
      }
      // Method K3: Kick chat input identity — look for "Send a message" placeholder owner
      const kickChatIdentity = document.querySelector('.chat-identity-name, [class*="chat-identity"] span')
      if (kickChatIdentity?.textContent?.trim()) {
        const name = kickChatIdentity.textContent.trim()
        if (name.length > 0 && name.length < 30 && /^[a-zA-Z0-9_]+$/.test(name)) {
          log(' ✅ Found Kick username from chat identity:', name)
          cachedUsername = name.toLowerCase()
          return cachedUsername
        }
      }
    }

    // Schedule retry if we haven't found it yet and attempts < MAX
    if (usernameDetectionAttempts < MAX_USERNAME_ATTEMPTS && !usernameDetectionRetryTimer) {
      usernameDetectionRetryTimer = cleanup.setTimeout(() => {
        usernameDetectionRetryTimer = null
        const found = getCurrentUsername()
        if (found) {
          log(' ✅ Username found on retry:', found)
        }
      }, 1000)
    }

    // Only log failure on first and every 10th attempt (reduce spam)
    if (usernameDetectionAttempts === 1 || usernameDetectionAttempts % 10 === 0) {
      log(' ⚠️ Could not find username after', usernameDetectionAttempts, 'attempts')
    }

    return null
  }

  // Highlight messages that mention the current user ONLY
  function highlightUserMentions(messageElement, authorElement, preQueriedTextElements) {
    const currentUser = getCurrentUsername()
    if (!currentUser) {
      return // Skip if username not detected yet
    }
    // Cache mention regex — only rebuild when username changes
    if (currentUser !== _mentionUser) {
      _mentionRegex = new RegExp(`\\b${currentUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      _mentionUser = currentUser
    }

    // CRITICAL: Skip messages sent BY the current user (don't highlight your own messages)
    const _authorEl =
      authorElement ||
      messageElement.querySelector(
        '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
      )
    const messageAuthor = _authorEl?.textContent?.toLowerCase()?.trim()
    if (messageAuthor === currentUser) {
      return // Don't highlight your own messages
    }
    // Blocked users can't ping you — no highlight, no notification (covers the
    // unprotected observer path where the message is hidden but still in DOM).
    // userSetMatches checks legacy bare keys first so pre-namespace entries still work.
    if (messageAuthor && userSetMatches(blockedUsers, messageAuthor, isKick ? 'kick' : 'twitch', [])) {
      return
    }

    let shouldHighlight = false

    // Check explicit @mention elements (Twitch has .mention-fragment, Kick uses inline text)
    const mentions = messageElement.querySelectorAll('.mention-fragment, [data-a-target="chat-message-mention"]')

    // Check each mention to see if it matches current user
    for (const mention of mentions) {
      const mentionText = mention.textContent.toLowerCase().replace('@', '').trim()
      if (mentionText === currentUser) {
        shouldHighlight = true
        break
      }
    }

    // Also check if username appears as standalone word in message BODY (not author)
    if (!shouldHighlight) {
      const textFragments =
        preQueriedTextElements ||
        messageElement.querySelectorAll('.text-fragment, [data-a-target="chat-message-text"], span.font-normal')
      for (const frag of textFragments) {
        const fragText = frag.textContent.toLowerCase()
        if (_mentionRegex?.test(fragText)) {
          shouldHighlight = true
          break
        }
      }
    }

    if (shouldHighlight) {
      // FFZ-style: Just add a CSS class - let the stylesheet handle it
      log(' 🔴 FOUND MENTION OF YOU! Adding .hs-mentioned class')

      // Find the parent message element (Twitch: .chat-line__message, Kick: [data-index])
      let parent = messageElement
      while (parent && !parent.classList.contains('chat-line__message') && !parent.hasAttribute('data-index')) {
        parent = parent.parentElement
      }

      const targetElement =
        parent && (parent.classList.contains('chat-line__message') || parent.hasAttribute('data-index'))
          ? parent
          : messageElement

      // One notification per message: emote re-sweeps re-run this on rows
      // already marked — re-sending mention_detected spams notifications.
      if (targetElement.classList.contains('hs-mentioned')) return

      // Add the class (CSS handles the rest with high specificity)
      targetElement.classList.add('hs-mentioned')

      log(' 🔴 Added .hs-mentioned class to:', targetElement.className)

      // Notify background for browser notification (if hs_notifications enabled)
      const msgText = Array.from(
        messageElement.querySelectorAll(
          '.text-fragment, [data-a-target="chat-message-text"], .mention-fragment, span.font-normal',
        ),
      )
        .map((el) => el.textContent)
        .join(' ')
        .trim()
      safeSendMessage({
        type: 'mention_detected',
        username: messageAuthor || '',
        text: msgText.slice(0, 200),
        platform: isKick ? 'kick' : 'twitch',
      }).catch(() => {})
    }
  }

  // Color @username mentions AND any username from known chatters (Chatterino-style)
  // Uses inline span injection - called repeatedly by MutationObserver
  function colorUsernameMentions(messageElement, preQueriedFragments) {
    if (!knownChatters.size) return
    // Use pre-queried fragments when available (avoids redundant DOM query from processMessage)
    const textFragments =
      preQueriedFragments ||
      messageElement.querySelectorAll('.text-fragment, [data-a-target="chat-message-text"], span.font-normal')

    for (const fragment of textFragments) {
      // Skip if already has our colored spans (check for our marker class)
      if (fragment.querySelector('.hs-username-colored')) continue
      if (!fragment.textContent) continue
      if (!document.contains(fragment)) continue

      // Rewrite TEXT NODES only. The fragment may already contain rendered
      // emote <img>s (our injection pass runs first) — the old
      // textContent-split + replaceChildren flattened the whole fragment and
      // destroyed them (emotes reverted to text/vanished whenever the same
      // fragment also named a known chatter). Element children stay put.
      const textNodes = []
      for (const n of fragment.childNodes) {
        if (n.nodeType === Node.TEXT_NODE && n.nodeValue) textNodes.push(n)
      }
      for (const tn of textNodes) {
        const words = tn.nodeValue.split(HS_WS_SPLIT) // Keep whitespace
        const newNodes = []
        let hasMatch = false

        for (const word of words) {
          const cleanWord = word
            .replace(/[@,.:!?]/g, '')
            .trim()
            .toLowerCase()

          // Check if this word is a known chatter
          if (cleanWord && knownChatters.has(cleanWord)) {
            const color = knownChatters.get(cleanWord)
            const span = document.createElement('span')
            span.className = 'hs-username-colored'
            const safeColor = COLOR_RE.test(color) ? color : '#ffffff'
            span.style.cssText = `color: ${safeColor}; font-weight: bold; cursor: pointer;`
            span.textContent = word
            span.dataset.hsUsername = cleanWord
            applyMentionCosmetics(span, cleanWord)
            newNodes.push(span)
            hasMatch = true
          } else {
            newNodes.push(document.createTextNode(word))
          }
        }

        if (!hasMatch) continue
        try {
          tn.replaceWith(...newNodes)
        } catch (_e) {
          // Silently skip on React conflict
        }
      }
    }

    // Also color @mention elements (Twitch's explicit mentions)
    // Always make mentions hoverable for profile cards, even if user hasn't chatted yet
    const mentions = messageElement.querySelectorAll('.mention-fragment, [data-a-target="chat-message-mention"]')
    for (const mention of mentions) {
      if (mention.classList.contains('hs-mention-colored')) continue
      const username = mention.textContent.replace('@', '').trim().toLowerCase()
      if (!username) continue
      const color = knownChatters.get(username) || heatsyncColorMap.get(username) || '#fff'
      const safeColor = COLOR_RE.test(color) ? color : '#fff'
      mention.style.cssText = `color: ${safeColor}; font-weight: bold; cursor: pointer; pointer-events: auto;`
      mention.classList.add('hs-mention-colored')
      mention.dataset.hsUsername = username
      applyMentionCosmetics(mention, username)
    }
  }

  // Mentions carry the mentioned user's 7TV paint, same as their username
  // element does. Paint may arrive after the mention rendered — the
  // data-hs-cosmetic-mention stamp lets applyPendingCosmetics catch up.
  function applyMentionCosmetics(el, username) {
    if (!cosmeticsEnabled) return
    if (isKick) {
      const c = kickCosmeticsCache.get(username)
      if (c?.paint && !el.dataset.hsPaintApplied) applyPaintToElement(el, c.paint)
      return
    }
    const uid = chatterTwitchIds.get(username)
    if (!uid) return
    el.dataset.hsCosmeticMention = uid
    const c = cosmeticsCache.get(uid)
    if (c?.paint) {
      if (!el.dataset.hsPaintApplied) applyPaintToElement(el, c.paint)
    } else if (!c) {
      queueCosmeticsLookup(uid)
    }
  }

  // MutationObserver for persistent username coloring (survives React re-renders)
  // usernameColoringObserver merged into messageObserver (single observer pattern).
  let usernameClickHandlerInstalled = false

  // Lock/unlock helpers for emote stacks. Per-stack MutationObserver attached
  // only when locked — bounded by # locked stacks (typically 0-2). Replaces the
  // old subtree-on-chat scan that fired on every React class mutation in the
  // entire chat tree (major OOM source over long sessions).
  function lockStack(stack) {
    if (!stack || stack._hsLockObserver) return
    stack.dataset.hsLocked = '1'
    stack.classList.add('expanded')
    const obs = new MutationObserver(() => {
      if (stack.dataset.hsLocked === '1' && !stack.classList.contains('expanded')) {
        stack.classList.add('expanded')
      }
    })
    obs.observe(stack, { attributes: true, attributeFilter: ['class'] })
    // Track it: if twitch prunes this locked row from chat before the user
    // closes it, unlockStack never runs and the observer would keep the
    // detached subtree alive for the whole session. Tracked, teardown
    // disconnects it instead.
    cleanup.trackObserver(obs)
    stack._hsLockObserver = obs
  }
  function unlockStack(stack) {
    if (!stack) return
    delete stack.dataset.hsLocked
    stack.classList.remove('expanded')
    if (stack._hsLockObserver) {
      stack._hsLockObserver.disconnect()
      cleanup.untrackObserver(stack._hsLockObserver)
      stack._hsLockObserver = null
    }
  }

  function setupUsernameColoringObserver() {
    log(' setupUsernameColoringObserver called')

    // ALWAYS install click handler first (before any early returns)
    // NOTE: Profile card click handler in setupProfileCard() handles username clicks now.
    // This handler only prevents default navigation on colored usernames.
    if (!usernameClickHandlerInstalled) {
      usernameClickHandlerInstalled = true
      log(' ✅ Username click handler deferred to profile card')

      // Emote stack expand/collapse handlers
      // Click-to-expand, stays open until × button. Bulletproof — nothing else collapses.

      // CRITICAL: Intercept mousedown/pointerdown on stacks in capture phase
      // Right-click generates mousedown BEFORE contextmenu — Twitch React handles
      // mousedown on emote buttons and re-renders the message, destroying our stack DOM.
      // Must stop propagation before it reaches any React handler.
      for (const evt of ['mousedown', 'pointerdown']) {
        document.addEventListener(
          evt,
          (e) => {
            // Block right/middle-click on ANY emote wrapper (stack or standalone) from
            // reaching Twitch React. Otherwise React handles the mousedown, re-renders
            // the chat message, and wipes our wrapper mid-block — visible flicker.
            const target = e.target.closest('.heatsync-emote-stack, .heatsync-emote-wrapper')
            if (!target) return
            if (e.button === 2 || e.button === 1) {
              e.stopPropagation()
            }
          },
          { capture: true, signal },
        )
      }

      document.addEventListener(
        'click',
        (e) => {
          // Handle collapse button (×) — the ONLY way to close an expanded stack
          const collapseBtn = e.target.closest('.heatsync-stack-collapse')
          if (collapseBtn) {
            e.preventDefault()
            e.stopPropagation()
            const stack = collapseBtn.closest('.heatsync-emote-stack')
            unlockStack(stack)
            return
          }

          // Handle block-all / show-all toggle button (⊘ ↔ ◉)
          const blockAllBtn = e.target.closest('.heatsync-stack-block-all')
          if (blockAllBtn) {
            e.preventDefault()
            e.stopPropagation()
            const stack = blockAllBtn.closest('.heatsync-emote-stack')
            if (stack) {
              const emoteWrappers = stack.querySelectorAll('.heatsync-emote-wrapper')
              const allBlocked = Array.from(emoteWrappers).every((wrapper) =>
                wrapper.classList.contains('emote-overlay-blocked'),
              )
              const names = []

              // Server stores blocks by hash only — skip emotes without a hash to
              // avoid corrupting state with name-keyed entries that won't sync.
              // Reconcile every leg: the background reports an HTTP failure by
              // RESOLVING {success:false}, so the old fire-and-forget sends left
              // a "blocked: A, B, C" toast standing even when the server took
              // none of them. Apply optimistically, await each, revert the ones
              // that failed, and toast the truth.
              const type = allBlocked ? 'unblock_emote' : 'block_emote'
              const applied = []
              emoteWrappers.forEach((wrapper) => {
                const hash = wrapper.dataset.emoteHash
                const name = wrapper.dataset.emoteName
                if (!hash) return // server can't (un)block without a hash
                if (allBlocked) {
                  blockedEmotes.delete(hash)
                  markLocalBlockToggle(hash, 'unblocked')
                  updateEmoteState(hash, name, globalNameSet.has(name) ? 'global' : 'neutral')
                } else {
                  blockedEmotes.add(hash)
                  markLocalBlockToggle(hash, 'blocked')
                  updateEmoteState(hash, name, 'blocked')
                }
                if (name) names.push(name)
                applied.push({ hash, name, wrapper })
              })
              blockAllBtn.textContent = allBlocked ? '⊘' : '◉'
              blockAllBtn.title = allBlocked ? t('btn_block_all') : t('btn_show_all')
              showToast(
                t(allBlocked ? 'content_toast_unblocked' : 'content_toast_blocked', [names.join(', ')]),
                allBlocked ? 'success' : 'info',
              )
              ;(async () => {
                const results = await Promise.all(
                  applied.map((a) =>
                    safeSendMessage({ type, hash: a.hash })
                      .then((r) => (r && r.success === false ? { ...a, ok: false } : { ...a, ok: true }))
                      .catch(() => ({ ...a, ok: false })),
                  ),
                )
                const failed = results.filter((r) => !r.ok)
                if (!failed.length) return
                // Revert the failed legs to their pre-click state so local state
                // stops disagreeing with the server.
                for (const f of failed) {
                  if (allBlocked) {
                    blockedEmotes.add(f.hash)
                    markLocalBlockToggle(f.hash, 'blocked')
                    updateEmoteState(f.hash, f.name, 'blocked')
                  } else {
                    blockedEmotes.delete(f.hash)
                    markLocalBlockToggle(f.hash, 'unblocked')
                    updateEmoteState(f.hash, f.name, globalNameSet.has(f.name) ? 'global' : 'neutral')
                  }
                }
                // If every leg failed, the whole toggle didn't happen — put the
                // button label back too.
                if (failed.length === results.length) {
                  blockAllBtn.textContent = allBlocked ? '◉' : '⊘'
                  blockAllBtn.title = allBlocked ? t('btn_show_all') : t('btn_block_all')
                }
                showToast(
                  t(allBlocked ? 'content_toast_unblock_failed' : 'content_toast_block_failed', [
                    failed
                      .map((f) => f.name)
                      .filter(Boolean)
                      .join(', '),
                  ]),
                  'error',
                )
              })()
            }
            return
          }

          // Click anywhere on a stack → absorb click (prevent mute/other handlers)
          const stack = e.target.closest('.heatsync-emote-stack')
          if (stack) {
            if (!stack.classList.contains('expanded')) {
              // Collapsed → bulk-insert every emote in the stack in DOM order,
              // adding unowned heatsync emotes to the user's inventory first.
              // Right-click still expands (for per-emote interaction).
              e.preventDefault()
              e.stopPropagation()
              const wrappers = stack.querySelectorAll('.heatsync-emote-wrapper')
              const addPromises = []
              wrappers.forEach((wrapper) => {
                const hash = wrapper.dataset.emoteHash || ''
                const emoteName = wrapper.dataset.emoteName
                if (!emoteName) return
                const isBlocked = hash ? blockedEmotes.has(hash) : blockedEmotes.has(emoteName)
                if (isBlocked) return // Skip blocked emotes — don't insert or add
                const imgEl = wrapper.querySelector('img')
                const emoteUrl = imgEl?.src || ''
                const inInv = inventoryHashSet.has(hash) || inventoryNameSet.has(emoteName)
                const isGlobalEmote = wrapper.classList.contains('emote-overlay-global') || globalNameSet.has(emoteName)
                // Add to inventory: only own heatsync emotes (have hash, not third-party global)
                if (!inInv && hash && !isGlobalEmote) {
                  // Resolve to the name only if it actually persisted — the old
                  // code pushed the name synchronously and toasted "added" before
                  // the write resolved, so a {success:false} (rate limit, expired
                  // token, dup slot) or reject claimed a save that never happened,
                  // then reverted on the next inventory poll with no explanation.
                  addPromises.push(
                    safeSendMessage({
                      type: 'add_to_inventory',
                      emoteName,
                      emoteHash: hash,
                      emoteUrl,
                    })
                      .then((result) => {
                        if (result?.success) {
                          inventoryHashSet.add(result.hash || hash)
                          inventoryNameSet.add(emoteName)
                          updateEmoteState(hash, emoteName, 'added')
                          return emoteName
                        }
                        return null
                      })
                      .catch(() => null),
                  )
                }
                // Insert into chat input via MAIN-world hook (handles Slate editor)
                window.postMessage(
                  {
                    type: 'heatsync-insert-emote',
                    name: emoteName,
                    hash: hash || emoteName,
                    url: emoteUrl,
                  },
                  location.origin,
                )
              })
              if (addPromises.length) {
                Promise.all(addPromises).then((names) => {
                  const added = names.filter(Boolean)
                  if (added.length) showToast(`added: ${added.join(', ')}`, 'success')
                })
              }
            } else {
              // Expanded stack — absorb ALL clicks to prevent Twitch React re-render
              // which would destroy the stack DOM. Emote insert handled below.
              e.preventDefault()
              e.stopImmediatePropagation()
              // If clicked on an emote wrapper, trigger insert directly (since bubble handler won't fire)
              const wrapper = e.target.closest('.heatsync-emote-wrapper')
              if (wrapper) {
                const hash = wrapper.dataset.emoteHash || ''
                const emoteName = wrapper.dataset.emoteName
                const isBlocked = hash ? blockedEmotes.has(hash) : blockedEmotes.has(emoteName)
                if (isBlocked) {
                  // BLOCKED → UNBLOCK on left click
                  safeSendMessage({ type: 'unblock_emote', hash }).then((result) => {
                    if (result?.success) {
                      blockedEmotes.delete(hash)
                      markLocalBlockToggle(hash, 'unblocked')
                      updateEmoteState(hash, emoteName, 'neutral')
                      showToast(t('content_toast_unblocked', [emoteName]), 'success')
                    } else {
                      showToast(t('content_toast_unblock_failed', [emoteName]), 'error')
                    }
                  })
                } else {
                  // NOT BLOCKED → INSERT into chat
                  const imgEl = wrapper.querySelector('img')
                  const emoteUrl = imgEl?.src || ''
                  window.postMessage(
                    {
                      type: 'heatsync-insert-emote',
                      name: emoteName,
                      hash: hash || emoteName,
                      url: emoteUrl,
                    },
                    location.origin,
                  )
                }
              }
            }
            return
          }

          // Click outside does NOT close expanded stacks — only × button closes them
        },
        { capture: true, signal },
      )

      // Right-click on stack — capture phase so we beat Twitch React + bubble
      // handlers. Instant block/unblock toggle on the wrapper under the cursor;
      // stack auto-expands (lockStack) so siblings stay visible during the op.
      document.addEventListener(
        'contextmenu',
        (e) => {
          if (!hsGateOn('right-click-block')) return // live subsystem gate
          const stack = e.target.closest('.heatsync-emote-stack')
          if (!stack) return
          e.preventDefault()
          e.stopImmediatePropagation()
          if (!stack.classList.contains('expanded')) {
            lockStack(stack)
          }
          const wrapper = e.target.closest('.heatsync-emote-wrapper')
          if (!wrapper) return
          const hash = wrapper.dataset.emoteHash
          const emoteName = wrapper.dataset.emoteName
          if (!hash) return

          const isBlocked = blockedEmotes.has(hash)
          const isGlobalEmote = wrapper.classList.contains('emote-overlay-global') || globalNameSet.has(emoteName)
          const inInv = inventoryHashSet.has(hash) || inventoryNameSet.has(emoteName)
          if (isBlocked) {
            const restoredState = isGlobalEmote ? 'global' : 'neutral'
            blockedEmotes.delete(hash)
            markLocalBlockToggle(hash, 'unblocked')
            updateEmoteState(hash, emoteName, restoredState)
            safeSendMessage({ type: 'unblock_emote', hash }).then((result) => {
              if (!result?.success) {
                blockedEmotes.add(hash)
                markLocalBlockToggle(hash, 'blocked')
                updateEmoteState(hash, emoteName, 'blocked')
                showToast(t('content_toast_failed_unblock', [String(result?.error || 'Unknown error')]), 'error')
              }
              stack.classList.add('expanded')
            })
          } else {
            blockedEmotes.add(hash)
            markLocalBlockToggle(hash, 'blocked')
            updateEmoteState(hash, emoteName, 'blocked')
            safeSendMessage({ type: 'block_emote', hash }).then((result) => {
              if (!result?.success) {
                blockedEmotes.delete(hash)
                markLocalBlockToggle(hash, 'unblocked')
                updateEmoteState(hash, emoteName, inInv ? 'added' : isGlobalEmote ? 'global' : 'neutral')
                showToast(t('content_toast_failed_block', [String(result?.error || 'Unknown error')]), 'error')
              } else {
                showToast(t('content_toast_blocked', [emoteName]), 'info')
              }
              stack.classList.add('expanded')
            })
          }
        },
        { capture: true, signal },
      )

      log(' ✅ Emote stack expand/collapse handler installed')
    }

    // Observer setup folded into watchForNewMessages (single unified observer).
    // This function now only installs click handlers above.
  }

  // Mixed-content emote replacement for text leaves that also hold native platform
  // emote <img> inline (Kick renders message text in `span.font-normal` with native
  // emotes interleaved as <img>). replaceEmotesWithStacking() reads textContent +
  // replaceChildren(), which would WIPE those native <img>. So for mixed leaves we
  // wrap each bare text-node child in its own span and run the existing emote
  // machinery on the span only — native <img> are siblings outside the spans and
  // are never touched. Pure-text leaves (all of Twitch) never hit this path.
  // Re-entry (retro pass after a sender's emote set resolves) finds the
  // hs-textfrag spans from the first pass and re-runs the machinery on the
  // still-unresolved ones — spans that already hold a wrapper are skipped
  // (same guard the pure-leaf path uses), so nothing double-wraps.
  function replaceEmotesPreservingImgs(leaf, allEmotes) {
    // Snapshot — replaceWith mutates the live childNodes list mid-iteration.
    for (const node of Array.from(leaf.childNodes)) {
      if (node.nodeType === 3) {
        if (!node.nodeValue?.trim()) continue
        const span = document.createElement('span')
        span.className = 'hs-textfrag'
        span.textContent = node.nodeValue
        node.replaceWith(span)
        replaceEmotesWithStacking(span, allEmotes)
      } else if (node.nodeType === 1 && node.classList.contains('hs-textfrag')) {
        // Retro-upgrade: text was wrapped on a prior pass but its emotes
        // hadn't resolved yet (kick sender sets arrive after first render).
        if (node.querySelector('.heatsync-emote-wrapper')) continue
        replaceEmotesWithStacking(node, allEmotes)
      }
    }
  }

  // Process individual message for emote replacement
  function processMessage(messageElement) {
    if (!messageElement?.isConnected) return
    if (messageElement.dataset.heatsyncGeneration === emoteGeneration) return

    messageElement.dataset.heatsyncGeneration = emoteGeneration

    // Cache message body for timeout restoration (before emote processing modifies it)
    if (dimTimeoutsEnabled) {
      const msgId = messageElement.dataset.msgId || messageElement.getAttribute('data-msg-id')
      if (msgId && !originalMessageBodies.has(msgId)) {
        const body = messageElement.querySelector('[data-a-target="chat-line-message-body"]')
        if (body) {
          // Snapshot child nodes as clones — avoids per-message innerHTML
          // serialization of the live subtree (the largest per-message CPU cost).
          const nodes = []
          for (const n of body.childNodes) nodes.push(n.cloneNode(true))
          originalMessageBodies.set(msgId, { nodes, ts: Date.now() })
          if (originalMessageBodies.size > 300) {
            originalMessageBodies.delete(originalMessageBodies.keys().next().value)
          }
        }
      }
    }

    const textElements = messageElement.querySelectorAll('.text-fragment, span.font-normal')
    if (textElements.length === 0) return

    // Query author element once — passed to highlightUserMentions/colorUsernameMentions to avoid re-querying
    const usernameElement = messageElement.querySelector(
      '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
    )
    const username = usernameElement ? usernameElement.textContent.trim() : ''
    const lowerUser = username ? username.toLowerCase() : ''

    if (username) {
      // Add to known chatters (for username coloring) - HeatSync API color > Twitch native > white
      const hsColor = heatsyncColorMap.get(lowerUser)
      if (hsColor) {
        if (usernameElement) usernameElement.style.color = hsColor
        knownChatters.set(lowerUser, hsColor)
      } else if (!knownChatters.has(lowerUser)) {
        const color = usernameElement?.style.color || '#ffffff'
        knownChatters.set(lowerUser, color)
        while (knownChatters.size > 500) knownChatters.delete(knownChatters.keys().next().value)
      }
      // Stamp recency for native tab-complete (preserves canonical display case).
      recordRecentChatter(lowerUser, username)

      // Extract sub tenure from Twitch subscriber badge alt text
      if (!subTenureMap.has(lowerUser)) {
        const badgeImgs = messageElement.querySelectorAll('[data-a-target="chat-badge"] img, .chat-badge img')
        for (const img of badgeImgs) {
          const alt = img.alt || img.getAttribute('aria-label') || ''
          const match = alt.match(SUB_TENURE_RE)
          if (match) {
            subTenureMap.set(lowerUser, parseInt(match[1], 10))
            while (subTenureMap.size > 500) subTenureMap.delete(subTenureMap.keys().next().value)
            break
          }
        }
      }

      // Heat border — apply from cache or queue for batch fetch
      const cached = heatCache.get(lowerUser)
      if (cached && Date.now() - cached.fetchedAt < HEAT_CACHE_TTL) {
        applyHeatBorderToElement(messageElement, cached.heat)
      } else {
        queueHeatLookup(lowerUser)
      }
    }

    // Resolve the sender's id once — drives BOTH cosmetics and the
    // sender-emote overlay. Tagging + the emote fetch run regardless of the
    // cosmetics toggle so disabling cosmetics never stops emotes from resolving.
    let twitchUid = ''
    if (!isKick && username) {
      twitchUid = getTwitchUserId(messageElement) || ''
      if (twitchUid) {
        messageElement.dataset.hsCosmeticUserId = twitchUid
        if (!chatterTwitchIds.has(lowerUser)) {
          chatterTwitchIds.set(lowerUser, twitchUid)
          while (chatterTwitchIds.size > CHATTER_IDS_MAX) chatterTwitchIds.delete(chatterTwitchIds.keys().next().value)
        }
        // Lazy-fetch this sender's heatsync + personal emote set (persistent
        // overlay) so their added emotes resolve in native chat, not just during
        // a live broadcast. Deduped/cached — fires at most once per sender.
        queueSenderEmotes(`twitch:${twitchUid}`)
      }
    } else if (isKick && username) {
      // Kick native rows have no numeric id in the DOM — the BG resolves
      // kick:<username> (7TV /users/kick/{name} + server batch endpoint),
      // same as the overlay's cross-user path. Stamp the dataset here (not
      // only in the cosmetics branch) so retro-render works with cosmetics off.
      messageElement.dataset.hsCosmeticKickUser = lowerUser
      queueSenderEmotes(`kick:${lowerUser}`)
    }

    // Apply third-party cosmetics (BTTV/FFZ badges + 7TV paints/badges)
    if (cosmeticsEnabled) {
      if (isKick) {
        if (username) {
          messageElement.dataset.hsCosmeticKickUser = lowerUser
          applyKickCosmeticsToMessage(messageElement, lowerUser)
          queueKickCosmeticsLookup(lowerUser)
        }
      } else if (twitchUid) {
        applyCosmeticsToMessage(messageElement, twitchUid, usernameElement)
        queueCosmeticsLookup(twitchUid)
        // Discover self twitch ID once per session and register with the
        // background so 7TV EventAPI can push real-time cosmetic updates.
        if (!_selfTwitchIdRegistered) {
          const me = getCurrentUsername()
          if (me && username && me.toLowerCase() === lowerUser) {
            _selfTwitchIdRegistered = true
            safeSendMessage({ type: 'register_self_twitch_id', twitchId: twitchUid })
          }
        }
      }
    }

    // Check if user is blocked (hard hide). userSetMatches checks legacy bare keys
    // first (global-match) then the platform-scoped key, so pre-namespace stored
    // entries keep working and twitch:alice never hides an unrelated kick:alice.
    if (userSetMatches(blockedUsers, lowerUser, isKick ? 'kick' : 'twitch', [])) {
      messageElement.style.display = 'none'
      return
    }

    // Check if user is muted — strip content, gray username.
    // Same userSetMatches pattern so overlay-mute's namespaced keys reach native chat.
    if (userSetMatches(mutedUsers, username, isKick ? 'kick' : 'twitch', [])) {
      stripMutedMessage(messageElement)
      return
    }

    // Highlight mentions of current user (FFZ-style red background on entire line)
    if (_uiPrefs.highlightMentions) highlightUserMentions(messageElement, usernameElement, textElements)

    // Highlight custom keywords (BTTV/FFZ-style custom highlight list)
    highlightKeywords(messageElement)

    // Apply per-user color override (right-click on username sets color)
    if (_userColors.size && username) applyUserColorToMessage(messageElement, username)

    // Ensure emote map is current (rebuilt eagerly by event handlers, fallback here)
    rebuildEmoteMapIfDirty()

    // Guard: emotes not yet loaded — reprocess will catch this message once inventory arrives
    if (cachedAllEmotes === null) return

    // 2-tier lookup: cached base + per-user broadcast emotes (avoids cloning entire Map)
    // Fast path: skip broadcast scan when no broadcasts pending (common case)
    // For our own messages, skip broadcasts — our inventory is authoritative
    let allEmotes
    const currentUser = getCurrentUsername()
    const isOwnMessage = currentUser && lowerUser && lowerUser === currentUser.toLowerCase()
    // Sender's persistent heatsync/personal set (null until fetched or
    // fetched-empty). Skipped for own messages — our own inventory is authoritative.
    let senderKey = ''
    if (!isOwnMessage) {
      if (isKick) {
        const ku = messageElement.dataset.hsCosmeticKickUser
        if (ku) senderKey = `kick:${ku}`
      } else if (messageElement.dataset.hsCosmeticUserId) {
        senderKey = `twitch:${messageElement.dataset.hsCosmeticUserId}`
      }
    }
    const senderSet = senderKey ? senderHeatsyncEmotes.get(senderKey) : null
    // Live 10s broadcast overlay (highest priority, freshest).
    let userBroadcasts = null
    if (pendingEmoteBroadcasts.size > 0 && username && !isOwnMessage) {
      const userBroadcastMap = pendingBroadcastsByUser.get(lowerUser)
      if (userBroadcastMap && userBroadcastMap.size > 0) {
        // Defer Map alloc — most messages have no surviving entries after the
        // pendingRemovals filter. At 1000 msgs/min with one broadcaster active,
        // this skipped 1000 Map allocs/min.
        for (const [emoteName, emoteData] of userBroadcastMap) {
          if (pendingRemovals.has(emoteName)) continue
          if (!userBroadcasts) userBroadcasts = new Map()
          userBroadcasts.set(emoteName, {
            name: emoteName,
            url: emoteData.url?.startsWith('http') ? emoteData.url : `${API_URL}${emoteData.url}`,
            hash: emoteData.hash,
            width: emoteData.width,
            height: emoteData.height,
          })
        }
      }
    }
    // Own renders see viewer inventory; other senders see only channel/global +
    // their own sender_emote_set + live broadcasts. Without this split, mellen
    // adding "Catge" to inventory would have made every chatter's "Catge" render
    // as the image even when they don't have the emote in any of their sets.
    const baseMap = isOwnMessage ? cachedOwnEmotes : cachedNonInventoryEmotes
    if (!userBroadcasts && (!senderSet || senderSet.size === 0)) {
      // Fast path — no overlays, no Map alloc.
      allEmotes = baseMap
    } else {
      // Precedence: live broadcast > channel (authoritative in its own channel) >
      // sender's persistent set > global. cachedChannelEmotes sits ABOVE senderSet
      // so a channel emote isn't shadowed by a sender's colliding personal emote —
      // without it, others' messages diverged from the viewer's own (own renders
      // via cachedOwnEmotes, channel-first). baseMap still backstops with globals +
      // any name the channel doesn't carry. Own messages never reach this branch
      // (no broadcast/senderSet) → fast path, cachedOwnEmotes.
      allEmotes = {
        get(name) {
          return (
            userBroadcasts?.get(name) || cachedChannelEmotes?.get(name) || senderSet?.get(name) || baseMap.get(name)
          )
        },
        has(name) {
          return (
            !!userBroadcasts?.has(name) ||
            !!cachedChannelEmotes?.has(name) ||
            !!senderSet?.has(name) ||
            baseMap.has(name)
          )
        },
        get size() {
          return (
            baseMap.size +
            (userBroadcasts ? userBroadcasts.size : 0) +
            (cachedChannelEmotes ? cachedChannelEmotes.size : 0) +
            (senderSet ? senderSet.size : 0)
          )
        },
      }
    }

    // Process ALL text fragments with overlay stacking support
    if (!messageElement.isConnected) return
    for (const textElement of textElements) {
      // Mixed leaf from a PRIOR pass (kick) — hs-textfrag spans mark it. Must
      // route BEFORE the leaf-level wrapper guard: one resolved span would
      // otherwise strand its still-text siblings, so kick rows rendered before
      // the sender's set arrived never retro-upgraded. Per-span guard lives
      // inside replaceEmotesPreservingImgs.
      if (textElement.querySelector('.hs-textfrag')) {
        replaceEmotesPreservingImgs(textElement, allEmotes)
        continue
      }
      if (textElement.querySelector('.heatsync-emote-wrapper')) continue

      // Mixed leaf (native platform emote <img> inline with text, e.g. Kick) —
      // replace per text-node so native <img> survive. Pure-text leaves take the
      // fast path. querySelector('img') is the cheap discriminator.
      if (textElement.querySelector('img')) {
        replaceEmotesPreservingImgs(textElement, allEmotes)
      } else {
        replaceEmotesWithStacking(textElement, allEmotes)
      }
    }

    // Also wrap any existing heatsync emote images (from tab completion)
    wrapExistingHeatsyncEmotes(messageElement, allEmotes)

    // Post-process: Stack overlay emotes that are adjacent to base emotes
    stackAdjacentOverlayEmotes(messageElement, allEmotes)

    // FFZ modifiers across DOM boundaries — text-fragments split modifiers
    // from preceding emotes, so do a post-pass walking the message timeline.
    if (_uiPrefs.emoteModifiers) applyModifiersAcrossMessage(messageElement)

    // Color all @username mentions (Chatterino-style) - AFTER emote replacement
    // so replaceChildren() doesn't wipe out the colored spans
    colorUsernameMentions(messageElement, textElements)

    // Apply local name-blocks to native Twitch/Kick emotes in this message
    if (localBlockedEmoteNames.size > 0) {
      const imgs = messageElement.querySelectorAll(
        'img[src*="static-cdn.jtvnw.net/emoticons"], img[src*="files.kick.com/emotes/"]',
      )
      for (const im of imgs) {
        if (im.alt && localBlockedEmoteNames.has(im.alt)) {
          im.setAttribute('data-hs-name-blocked', '1')
        }
      }
    }
  }

  // Check if an emote is a zero-width/overlay emote
  // Checks: 7TV zeroWidth property, flags bitmask, and "0" suffix convention
  function isZeroWidthEmote(emoteName, emoteData, allEmotes) {
    if (!emoteName) return false

    // Method 1: Check zeroWidth property (direct from 7TV API)
    if (emoteData?.zeroWidth === true) return true

    // Method 2: Check flags bitmask
    // 7TV: bit 0 (1) = private/zw override, bit 8 (256) = zero-width
    if (typeof emoteData?.flags === 'number' && emoteData.flags & 257) return true

    // Method 3: "0" suffix convention (channel overlay emotes)
    // If emote name ends with "0" and the base name (without "0") exists as an
    // emote. ONLY when the literal "name0" is NOT itself a real emote — a channel
    // emote actually named "lerolero0" is standalone, not the "lerolero" overlay.
    if (emoteName.endsWith('0') && emoteName.length > 1 && !allEmotes?.has(emoteName)) {
      const baseName = emoteName.slice(0, -1)
      if (allEmotes?.has(baseName)) {
        return true
      }
    }

    return false
  }

  // Post-process message to stack overlay emotes on adjacent base emotes
  function stackAdjacentOverlayEmotes(messageElement, allEmotes) {
    if (!messageElement.querySelector('.heatsync-emote-wrapper')) return
    // Find ALL emotes: heatsync wrappers AND native Twitch/platform emotes.
    // Single querySelectorAll preserves DOM order — no sort needed. Single-pass
    // collect avoids spread-into-array + filter allocation per message.
    const _emoteNl = messageElement.querySelectorAll(COMBINED_EMOTE_SELECTOR)
    const allEmoteElements = []
    for (let _i = 0; _i < _emoteNl.length; _i++) {
      const _el = _emoteNl[_i]
      if (!_el.closest('.heatsync-emote-stack')) allEmoteElements.push(_el)
    }
    if (allEmoteElements.length < 2) return

    // Simple logic: start at index 1, check if current is overlay, stack on previous
    for (let i = 1; i < allEmoteElements.length; i++) {
      const currentElement = allEmoteElements[i]
      const prevElement = allEmoteElements[i - 1]

      // Skip if current already in a stack
      if (currentElement.closest('.heatsync-emote-stack')) continue

      // Get emote name - different for heatsync vs native
      let currentEmoteName
      if (currentElement.classList.contains('heatsync-emote-wrapper')) {
        currentEmoteName = currentElement.dataset.emoteName
      } else {
        const img = currentElement.tagName === 'IMG' ? currentElement : currentElement.querySelector('img')
        currentEmoteName = img?.alt || img?.getAttribute('data-a-target')?.replace('emote-name-', '')
      }

      const currentEmote = allEmotes.get(currentEmoteName)

      // Check if current emote is an overlay/zero-width emote
      const isOverlay = isZeroWidthEmote(currentEmoteName, currentEmote, allEmotes)

      if (!isOverlay) {
        log(' 🔍 NOT overlay:', currentEmoteName)
        continue
      }

      log(' 🔍 Overlay found:', currentEmoteName)

      // Find base: check if previous emote is in a stack, otherwise use it directly as base
      const existingStack = prevElement.closest('.heatsync-emote-stack')
      const baseElement = existingStack ? null : prevElement
      const _targetStack = existingStack || null

      // Check adjacency - only whitespace should separate them
      const checkElement = existingStack || prevElement
      if (!checkElement) continue

      // Walk siblings between checkElement and currentElement — skip if any non-whitespace
      let onlyWhitespace = true
      let node = checkElement.nextSibling
      while (node && node !== currentElement) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent.trim() !== '') {
            onlyWhitespace = false
            break
          }
        } else {
          onlyWhitespace = false
          break
        }
        node = node.nextSibling
      }
      const textBetween = onlyWhitespace ? '' : 'non-empty'

      log(' 🔍 Text between:', JSON.stringify(textBetween))

      // Only stack if there's just whitespace between them
      if (!onlyWhitespace) continue

      // Wrap current element if it's a native emote (not already a heatsync wrapper)
      let currentWrapper = currentElement
      if (!currentElement.classList.contains('heatsync-emote-wrapper')) {
        currentWrapper = document.createElement('span')
        // Native emotes get emote-overlay-global (gray) since they're platform emotes
        currentWrapper.className = 'heatsync-emote-wrapper heatsync-overlay emote-overlay-global'
        currentWrapper.dataset.emoteName = currentEmoteName
        // Use outermost emote container to escape overflow:hidden from Twitch button structure
        const outerContainer =
          currentElement.closest('.chat-line__message--emote-button') ||
          currentElement.closest('[class*="emote-button"]') ||
          currentElement
        if (!outerContainer.parentNode) continue
        outerContainer.parentNode.insertBefore(currentWrapper, outerContainer)
        currentWrapper.appendChild(outerContainer)
      } else {
        currentWrapper.classList.add('heatsync-overlay')
      }

      // Force overlay positioning — use overflow: visible so wide overlays aren't clipped
      currentWrapper.style.cssText =
        'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: auto; height: auto; display: flex; align-items: center; justify-content: center; z-index: 2; pointer-events: auto; overflow: visible;'
      // Ensure overlay image renders at native resolution, centered
      const overlayImgEl = currentWrapper.querySelector('img')
      if (overlayImgEl) {
        overlayImgEl.style.cssText =
          'display: block !important; width: auto !important; height: auto !important; max-width: none !important; max-height: none !important;'
      }

      if (existingStack) {
        // Add to existing stack (insert before block-all button if present)
        log(' ✅ Adding to existing stack:', currentEmoteName)
        const blockAllBtn = existingStack.querySelector('.heatsync-stack-block-all')
        if (blockAllBtn) {
          existingStack.insertBefore(currentWrapper, blockAllBtn)
        } else {
          existingStack.appendChild(currentWrapper)
        }
        // Update stack count
        const count = existingStack.querySelectorAll('.heatsync-emote-wrapper').length
        existingStack.dataset.stackCount = String(count)
      } else if (baseElement) {
        // Wrap base element if it's a native emote
        let baseWrapper = baseElement
        if (!baseElement.classList.contains('heatsync-emote-wrapper')) {
          baseWrapper = document.createElement('span')
          // Native emotes get emote-overlay-global (gray) since they're platform emotes
          baseWrapper.className = 'heatsync-emote-wrapper emote-overlay-global'
          const img = baseElement.tagName === 'IMG' ? baseElement : baseElement.querySelector('img')
          baseWrapper.dataset.emoteName = img?.alt || 'native'
          baseWrapper.dataset.emoteHash = img?.dataset?.emoteHash || ''
          // Use outermost emote container to escape overflow:hidden from Twitch button structure
          const outerContainer =
            baseElement.closest('.chat-line__message--emote-button') ||
            baseElement.closest('[class*="emote-button"]') ||
            baseElement
          if (!outerContainer.parentNode) continue
          outerContainer.parentNode.insertBefore(baseWrapper, outerContainer)
          baseWrapper.appendChild(outerContainer)
        }

        log(' ✅ Creating stack:', baseWrapper.dataset.emoteName, '+', currentEmoteName)

        const stackContainer = document.createElement('span')
        stackContainer.className = 'heatsync-emote-stack'
        stackContainer.dataset.stackCount = '2' // Will be updated when more overlays added
        stackContainer.title = t('btn_click_expand')

        // Add collapse button (×)
        const collapseBtn = document.createElement('span')
        collapseBtn.className = 'heatsync-stack-collapse'
        collapseBtn.textContent = '×'
        collapseBtn.title = t('btn_collapse')
        stackContainer.appendChild(collapseBtn)

        // Insert stack container before baseWrapper
        if (!baseWrapper.parentNode) continue
        baseWrapper.parentNode.insertBefore(stackContainer, baseWrapper)

        // Move baseWrapper into stack (as base)
        stackContainer.appendChild(baseWrapper)

        // Move overlay into stack
        stackContainer.appendChild(currentWrapper)

        // Add block-all button (⊘)
        const blockAllBtn = document.createElement('span')
        blockAllBtn.className = 'heatsync-stack-block-all'
        blockAllBtn.textContent = '⊘'
        blockAllBtn.title = t('btn_block_all')
        stackContainer.appendChild(blockAllBtn)

        log('[hs-overlay] Stack HTML:', stackContainer.outerHTML.substring(0, 500))

        // Force overlay re-center when images load (fixes centering on first render).
        // {once:true} + signal lets the closure release once it fires or on lifecycle abort.
        const imgs = stackContainer.querySelectorAll('img')
        imgs.forEach((img) => {
          if (!img.complete) {
            img.addEventListener(
              'load',
              () => {
                if (!stackContainer.isConnected) return
                requestAnimationFrame(() => {
                  if (!stackContainer.isConnected) return
                  const overlays = stackContainer.querySelectorAll('.heatsync-overlay')
                  overlays.forEach((overlay) => {
                    overlay.style.transform = ''
                  })
                })
              },
              { once: true, signal },
            )
          }
        })
      }
    }

    // Clean up empty containers left by emote replacement (only heatsync-created ones)
    const emptyContainers = messageElement.querySelectorAll('.text-fragment:empty, span.font-normal:empty')
    emptyContainers.forEach((el) => {
      if (!el.closest('.heatsync-emote-stack') && !el.classList.contains('heatsync-emote-stack')) {
        el.remove()
      }
    })
  }

  // Wrap existing heatsync emote images (from tab completion) with our overlay wrapper
  function wrapExistingHeatsyncEmotes(messageElement, allEmotes) {
    if (!messageElement.querySelector('img')) return
    // Find all images in the message that aren't already wrapped
    const images = messageElement.querySelectorAll('img:not(.heatsync-emote)')

    for (const img of images) {
      if (img.closest('.heatsync-emote-wrapper')) continue

      const src = img.src || ''
      const alt = img.alt || ''

      // Wrap emotes from known CDNs — but only wrap native Twitch emotes if they're
      // in our emote map (otherwise we break Twitch's animated emote rendering)
      const isHeatsyncCdn = src.includes('heatsync.org')
      const isThirdPartyEmoteCdn =
        src.includes('cdn.7tv.app') || src.includes('cdn.betterttv.net') || src.includes('cdn.frankerfacez.com')
      const isNativeTwitch = src.includes('static-cdn.jtvnw.net/emoticons')

      if (!isHeatsyncCdn && !isThirdPartyEmoteCdn && !isNativeTwitch) continue

      const matchedEmote = allEmotes.get(alt)

      // Never wrap native Twitch emotes — reparenting breaks animated emote rendering
      if (isNativeTwitch) continue

      // Use matched emote or create placeholder data
      const emote = matchedEmote || { name: alt, hash: alt, url: src }

      const blocked = blockedEmotes.has(emote.hash)
      const inInventory = inventoryHashSet.has(emote.hash) || inventoryNameSet.has(emote.name)

      // Third-party CDN emotes (7tv, bttv, ffz, twitch) are all "global" - can only block, not add to inventory
      // Only heatsync.org emotes can be added to inventory (blue)
      const isCdnEmote = isThirdPartyEmoteCdn || isNativeTwitch

      let overlayClass = ''
      if (blocked) overlayClass = 'emote-overlay-blocked'
      else if (inInventory) overlayClass = 'emote-overlay-owned'
      else if (isCdnEmote)
        overlayClass = 'emote-overlay-global' // gold - non-ownable
      else overlayClass = 'emote-overlay-unadded' // blue - can be added (heatsync.org)

      // Create wrapper and move image into it
      const wrapper = document.createElement('span')
      wrapper.className = `heatsync-emote-wrapper ${overlayClass}${isHeatsyncCdn ? ' heatsync-own-emote' : ''}`
      wrapper.dataset.emoteName = emote.name
      wrapper.dataset.emoteHash = emote.hash || ''
      wrapper.dataset.inInventory = String(inInventory)
      wrapper.style.cssText =
        'display: inline-block; vertical-align: middle; cursor: pointer; position: relative; line-height: 0; font-size: 0;'

      // Add heatsync-emote class to img and remove any width constraints
      img.classList.add('heatsync-emote')
      img.dataset.emoteName = emote.name
      img.dataset.emoteHash = emote.hash || ''

      // Remove title to prevent native browser tooltip (we have our own)
      img.removeAttribute('title')

      // Native size - remove any constraints from other extensions
      img.style.height = 'auto'
      img.style.width = 'auto'
      img.style.maxWidth = 'none'
      img.style.maxHeight = 'none'

      // Insert wrapper before image, then move image into wrapper
      if (!img.parentNode) {
        log(' ❌ SKIP - img has no parentNode:', emote.name)
        continue
      }
      img.parentNode.insertBefore(wrapper, img)
      wrapper.appendChild(img)

      // Verify it's actually in DOM
      const inDOM = document.contains(wrapper)
      log(' ✅ WRAPPED emote:', emote.name, 'inDOM:', inDOM, 'parent:', wrapper.parentNode?.tagName)
    }
  }

  // Unicode emoji detection — matches emoji sequences (presentation + ZWJ combos)
  const UNICODE_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+$/u

  // BTTV/FFZ modifier definitions live in src/lib/modifiers.js (bundled).
  // Aliases for backward-compat across this file:
  const HS_MODIFIER_CLASSES = HS_MOD_TOKENS
  const HS_C_HEX_RE = HS_MOD_C_HEX_RE
  // Static, sorted longest-first — used inside per-word hot path of applyModifiersAcrossMessage.
  // Hoisting saves ~167k allocations/min at 1000 msgs/min × 10 words/msg.
  const HS_MOD_KEYS_SORTED = Object.keys(HS_MODIFIER_CLASSES).sort((a, b) => b.length - a.length)
  // Walk a chat message left→right; build groups of {base, overlays, mods, hue},
  // then apply transform/filter to each base. Modifiers in a group ALWAYS target
  // the base (skipping overlays), and chain multiplicatively (w! w! = 4x wide).
  function applyModifiersAcrossMessage(messageElement) {
    if (!messageElement?.isConnected) return
    // Modifiers can only ever attach to an emote; a message with no emote
    // candidates (wrapper or emote-CDN img — mirrors the timeline filter
    // below; badge imgs live on /badges paths and don't match) is a
    // guaranteed no-op — skip the full element+text TreeWalk (~most
    // plain-text messages on a busy channel) for one cheap selector probe.
    if (
      !messageElement.querySelector(
        '.heatsync-emote-wrapper, img[src*="/emoticons/"], img[src*="cdn.7tv.app"], img[src*="cdn.betterttv.net"], img[src*="cdn.frankerfacez.com"]',
      )
    )
      return
    const walker = document.createTreeWalker(messageElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    const timeline = []
    let n = walker.nextNode()
    while (n) {
      if (n.nodeType === 1) {
        if (n.matches?.('.heatsync-emote-wrapper')) {
          timeline.push({ kind: 'emote', el: n, isOverlay: n.classList.contains('heatsync-overlay') })
        } else if (
          n.tagName === 'IMG' &&
          !n.closest('.heatsync-emote-wrapper') &&
          !n.closest('.hs-cosmetic-badge') &&
          (n.alt || '').length > 0
        ) {
          const src = n.src || ''
          if (
            src.includes('static-cdn.jtvnw.net/emoticons') ||
            src.includes('cdn.7tv.app') ||
            src.includes('cdn.betterttv.net') ||
            src.includes('cdn.frankerfacez.com')
          ) {
            timeline.push({ kind: 'emote', el: n, isOverlay: false })
          }
        }
      } else if (n.nodeType === 3) {
        const tx = n.textContent || ''
        if (tx.trim()) timeline.push({ kind: 'text', text: tx })
      }
      n = walker.nextNode()
    }
    // FFZ semantic: modifier attaches to IMMEDIATELY PRECEDING emote (base
    // OR overlay). Track currentTarget = last emote seen.
    let currentTarget = null
    let currentMods = []
    let currentHue = null
    const flushTo = (targetInfo) => {
      if (!targetInfo) return
      if (!currentMods.length && currentHue == null) return
      const { el } = targetInfo
      const isHsWrapper = el.matches?.('.heatsync-emote-wrapper')
      const targetImg = el.tagName === 'IMG' ? el : el.querySelector('img')
      if (!targetImg) return
      let sx = 1,
        sy = 1,
        filter = ''
      for (const m of currentMods) {
        if (m === 'wide') sx *= 2
        else if (m === 'tall') sy *= 2
        else if (m === 'hflip') sx *= -1
        else if (m === 'vmirror') sy *= -1
      }
      sx = Math.min(Math.max(sx, -4), 4)
      sy = Math.min(Math.max(sy, -4), 4)
      if (currentMods.includes('cursed')) filter += ' hue-rotate(45deg) saturate(2)'
      if (currentHue != null) filter += ` hue-rotate(${currentHue}deg) saturate(1.6)`
      if (sx !== 1 || sy !== 1) {
        const fx = Math.abs(sx),
          fy = Math.abs(sy)
        if (isHsWrapper) {
          el.style.setProperty('transform', `scale(${sx}, ${sy})`, 'important')
          el.style.setProperty('transform-origin', 'center', 'important')
          if (fx > 1) {
            const halfX = `calc(var(--hs-emote-width, 28px) * ${(fx - 1) / 2})`
            el.style.setProperty('margin-left', halfX, 'important')
            el.style.setProperty('margin-right', halfX, 'important')
          }
          if (fy > 1) {
            const halfY = `calc(var(--hs-emote-height, 28px) * ${(fy - 1) / 2})`
            el.style.setProperty('margin-top', halfY, 'important')
            el.style.setProperty('margin-bottom', halfY, 'important')
          }
          el.style.setProperty('--hs-mod-scale', String(Math.max(fx, fy)))
        } else {
          targetImg.style.setProperty('transform', `scale(${sx}, ${sy})`, 'important')
          targetImg.style.setProperty('transform-origin', 'center', 'important')
          if (fx > 1) targetImg.style.setProperty('margin-right', 'var(--hs-emote-width, 28px)', 'important')
          if (fy > 1)
            targetImg.style.setProperty('margin-bottom', 'calc(var(--hs-emote-height, 28px) * 0.6)', 'important')
        }
      }
      if (filter.trim()) targetImg.style.setProperty('filter', filter, 'important')
      if (el.classList) for (const m of new Set(currentMods)) el.classList.add(`heatsync-mod-${m}`)
    }
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i]
      if (item.kind === 'emote') {
        // Any emote (base or overlay) becomes the new modifier target.
        // Flush pending mods to whatever was previous, then retarget.
        flushTo(currentTarget)
        currentTarget = item
        currentMods = []
        currentHue = null
      } else if (item.kind === 'text') {
        const tokens = item.text.trim().split(/\s+/).filter(Boolean)
        let allConsumed = true
        for (const tok of tokens) {
          if (HS_MODIFIER_CLASSES[tok]) {
            currentMods.push(HS_MODIFIER_CLASSES[tok])
            continue
          }
          const m = tok.match(HS_C_HEX_RE)
          if (m) {
            currentHue = hsHexToHueDeg(m[1])
            continue
          }
          allConsumed = false
          break
        }
        if (!allConsumed) {
          flushTo(currentTarget)
          currentTarget = null
          currentMods = []
          currentHue = null
        }
      }
    }
    flushTo(currentTarget)
  }

  // hex → hue degrees. Delegates to lib/modifiers.js
  function hsHexToHueDeg(hex) {
    return hsModHexToHue(hex)
  }

  // Replace emotes with overlay stacking support (emotes ending in 0 stack on previous)
  // Using DOM nodes instead of innerHTML to avoid React conflicts
  function replaceEmotesWithStacking(element, allEmotes) {
    const text = element.textContent
    const words = text.split(HS_WS_SPLIT)

    // Process words to find emotes and group overlays
    // Key insight: whitespace between emotes should be absorbed into stack
    // "4Head TriHard0" should stack TriHard on 4Head despite the space
    const resultNodes = []
    let currentStack = []
    let pendingWhitespace = ''
    let pendingModifiers = [] // BTTV/FFZ modifier classes (chain) — applied to PREVIOUS emote
    let pendingModColor = null // c!#hex parsed hue degrees

    // FFZ semantic: modifier attaches to the IMMEDIATELY PRECEDING emote.
    // For "Kappa RainTime w!" — w! applies to RainTime (last entry), not Kappa.
    // Multiset semantics: chain `w! w!` on same emote = 4x wide.
    const applyPendingToLast = () => {
      if (!currentStack.length) return
      const target = currentStack[currentStack.length - 1]
      if (pendingModifiers.length) {
        target.modifiers = (target.modifiers || []).concat(pendingModifiers)
        pendingModifiers = []
      }
      if (pendingModColor != null) {
        target.modColorHue = pendingModColor
        pendingModColor = null
      }
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const trimmed = word.trim()

      // Whitespace - accumulate, don't flush yet
      if (!trimmed) {
        pendingWhitespace += word
        continue
      }

      // Chained modifier word (e.g. "w!h!ffzX" or "w!c!#888") — peel into parts.
      if (_uiPrefs.emoteModifiers && !HS_MODIFIER_CLASSES[trimmed] && !HS_C_HEX_RE.test(trimmed)) {
        const _hsPeel = (() => {
          if (!trimmed || trimmed.length < 2) return null
          // All modifier tokens contain '!' — fast reject before the loop
          if (!trimmed.includes('!')) return null
          const mods = []
          let hue = null
          let rem = trimmed
          while (rem.length > 0) {
            let matched = false
            for (const k of HS_MOD_KEYS_SORTED) {
              if (rem.startsWith(k)) {
                mods.push(HS_MODIFIER_CLASSES[k])
                rem = rem.slice(k.length)
                matched = true
                break
              }
            }
            if (matched) continue
            const cm = rem.match(/^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/)
            if (cm) {
              hue = hsHexToHueDeg(cm[1])
              rem = rem.slice(cm[0].length)
              continue
            }
            return null
          }
          return mods.length || hue != null ? { mods, hue } : null
        })()
        if (_hsPeel) {
          for (const m of _hsPeel.mods) pendingModifiers.push(m)
          if (_hsPeel.hue != null) pendingModColor = _hsPeel.hue
          pendingWhitespace = ''
          applyPendingToLast()
          continue
        }
      }
      // FFZ-style modifier — applies to BASE of current group.
      // Chain: "Kappa w! raintime0 h! w!" → all mods apply to Kappa, raintime overlays.
      if (_uiPrefs.emoteModifiers && HS_MODIFIER_CLASSES[trimmed]) {
        pendingModifiers.push(HS_MODIFIER_CLASSES[trimmed])
        pendingWhitespace = ''
        applyPendingToLast()
        continue
      }
      // c!#RRGGBB color modifier
      const cHexMatch = _uiPrefs.emoteModifiers ? trimmed.match(HS_C_HEX_RE) : null
      if (cHexMatch) {
        pendingModColor = hsHexToHueDeg(cHexMatch[1])
        pendingWhitespace = ''
        applyPendingToLast()
        continue
      }

      // Resolve the emote. A literal full-name hit ALWAYS wins — an emote
      // actually named "lerolero0" is standalone, NOT the "lerolero" overlay.
      // Only when the literal name has no emote do we strip the trailing 0 and
      // overlay the base ("TriHard0" → overlay TriHard). Mirrors processEmotes
      // and lookupEmoteWithOverlay so the multichat and native renders agree.
      const endsWithZero = trimmed.endsWith('0') && trimmed.length > 1
      let emote = null
      let isOverlay = false

      emote = allEmotes.get(trimmed)
      if (emote) {
        // Real literal hit — overlay detection via zeroWidth flag / bitmask only.
        // isZeroWidthEmote's "name0" branch self-skips here (trimmed is in
        // allEmotes), so a real "lerolero0" stays standalone.
        isOverlay = isZeroWidthEmote(trimmed, emote, allEmotes)
      } else if (endsWithZero) {
        // No literal "name0" emote — strip the 0 and overlay the base.
        emote = allEmotes.get(trimmed.slice(0, -1))
        if (emote) isOverlay = true
      }

      if (emote && isOverlay && currentStack.length > 0) {
        // Overlay emote with existing base — add to stack as overlay (no mods)
        const entry = { emote, isOverlay: true, originalWord: trimmed }
        currentStack.push(entry)
        pendingWhitespace = ''
      } else if (emote && isOverlay && currentStack.length === 0) {
        // Overlay with no base — promote to standalone (modifiers may still
        // apply since this becomes the "base" of a new group)
        if (pendingWhitespace) {
          resultNodes.push(document.createTextNode(pendingWhitespace))
          pendingWhitespace = ''
        }
        const overlayEntry = { emote, isOverlay: true, originalWord: trimmed }
        // No base anchor — apply pending mods/hue to this standalone entry.
        if (pendingModifiers.length) overlayEntry.modifiers = pendingModifiers
        if (pendingModColor != null) overlayEntry.modColorHue = pendingModColor
        pendingModifiers = []
        pendingModColor = null
        resultNodes.push(generateEmoteElement(emote, true, overlayEntry.modifiers, overlayEntry.modColorHue))
      } else if (emote) {
        // Non-overlay (base) emote — flush previous group, start new group
        if (currentStack.length > 0) {
          resultNodes.push(flushEmoteStack(currentStack))
          currentStack = []
        }
        // Add accumulated whitespace before this emote
        if (pendingWhitespace) {
          resultNodes.push(document.createTextNode(pendingWhitespace))
          pendingWhitespace = ''
        }
        const entry = { emote, isOverlay: false, originalWord: trimmed }
        currentStack.push(entry)
        // Apply any pending mods (floating before base, e.g. "w! Kappa") to this base
        applyPendingToLast()
      } else {
        // Emoji :shortcode: (stackable base) OR ":shortcode:0" (overlay that sits
        // on top of the previous token — mirrors the emote "name0" convention).
        if (typeof EMOJI_BY_NAME !== 'undefined' && trimmed.startsWith(':') && trimmed.length > 2) {
          const emojiOverlay = trimmed.endsWith(':0') && trimmed.length > 3
          const core = emojiOverlay ? trimmed.slice(0, -1) : trimmed // ":smile:0" -> ":smile:"
          if (core.endsWith(':') && core.length > 2) {
            const emojiName = core.slice(1, -1)
            const emojiEntry = EMOJI_BY_NAME.get(emojiName)
            if (emojiEntry) {
              if (emojiOverlay && currentStack.length > 0) {
                currentStack.push({
                  emoji: emojiEntry.emoji,
                  emojiName,
                  isOverlay: true,
                  isEmoji: true,
                  originalWord: trimmed,
                })
                pendingWhitespace = ''
                continue
              }
              // Base emoji (overlays can sit on top)
              if (currentStack.length > 0) {
                resultNodes.push(flushEmoteStack(currentStack))
                currentStack = []
              }
              if (pendingWhitespace) {
                resultNodes.push(document.createTextNode(pendingWhitespace))
                pendingWhitespace = ''
              }
              currentStack.push({
                emoji: emojiEntry.emoji,
                emojiName,
                isOverlay: false,
                isEmoji: true,
                originalWord: trimmed,
              })
              continue
            }
          }
        }
        // Check for Unicode emoji (🏙️, 💵, etc.) — stackable base
        if (UNICODE_EMOJI_RE.test(trimmed)) {
          if (currentStack.length > 0) {
            resultNodes.push(flushEmoteStack(currentStack))
            currentStack = []
          }
          if (pendingWhitespace) {
            resultNodes.push(document.createTextNode(pendingWhitespace))
            pendingWhitespace = ''
          }
          currentStack.push({ emoji: trimmed, isOverlay: false, isEmoji: true, originalWord: trimmed })
          continue
        }
        // Not an emote - flush stack and add word
        if (currentStack.length > 0) {
          resultNodes.push(flushEmoteStack(currentStack))
          currentStack = []
        }
        // Add accumulated whitespace
        if (pendingWhitespace) {
          resultNodes.push(document.createTextNode(pendingWhitespace))
          pendingWhitespace = ''
        }
        resultNodes.push(document.createTextNode(word))
      }
    }

    // Flush any remaining stack
    if (currentStack.length > 0) {
      resultNodes.push(flushEmoteStack(currentStack))
    }
    // Add any trailing whitespace
    if (pendingWhitespace) {
      resultNodes.push(document.createTextNode(pendingWhitespace))
    }

    // Use replaceChildren() instead of innerHTML (React-safe)
    // CRITICAL: Validate element is still in DOM before modification
    if (!element || !document.contains(element)) {
      log('⚠️ Element removed from DOM, skipping emote replacement')
      return
    }

    try {
      element.replaceChildren(...resultNodes)
    } catch (e) {
      log('⚠️ replaceChildren failed (likely React conflict), skipping:', e.message)
    }

    // Helper to flush emote stack to DOM node
    function generateEmojiElement(emoji, title, isOverlay, modifiers, modColorHue) {
      const span = document.createElement('span')
      // heatsync-overlay triggers the stack's absolute-centered, z-index:2 layout
      // so an overlay emoji lands ON TOP of the base instead of beside it.
      span.className = isOverlay ? 'heatsync-emoji heatsync-overlay' : 'heatsync-emoji'
      span.textContent = emoji
      if (title) span.title = `:${title}:`
      let css = 'display: inline-block; vertical-align: middle; position: relative; z-index: 1;'
      // FFZ-style modifiers: w!/h!/l!/c! etc. — transform + hue filter on the span
      // itself (emoji has no <img>, so both go on the element directly).
      if (modifiers?.length || modColorHue != null) {
        const { sx, sy } = hsModComposeTransform(modifiers)
        if (sx !== 1 || sy !== 1) {
          css += `transform: scale(${sx}, ${sy}) !important; transform-origin: center !important;`
          const fx = Math.abs(sx)
          if (fx > 1) css += `margin: 0 calc(0.5em * ${fx - 1}) !important;`
        }
        const filter = hsModComposeFilter(modifiers, modColorHue)
        if (filter) css += `filter: ${filter} !important;`
      }
      span.style.cssText = css
      return span
    }

    function flushEmoteStack(stack) {
      if (stack.length === 0) return document.createTextNode('')
      if (stack.length === 1) {
        const entry = stack[0]
        if (entry.isEmoji)
          return generateEmojiElement(entry.emoji, entry.emojiName, entry.isOverlay, entry.modifiers, entry.modColorHue)
        return generateEmoteElement(entry.emote, entry.isOverlay, entry.modifiers, entry.modColorHue)
      }
      // Multiple emotes - wrap in stack container with buttons
      const stackContainer = document.createElement('span')
      stackContainer.className = 'heatsync-emote-stack'
      stackContainer.dataset.stackCount = String(stack.length)
      stackContainer.title = t('btn_click_expand')

      // Add collapse button (×)
      const collapseBtn = document.createElement('span')
      collapseBtn.className = 'heatsync-stack-collapse'
      collapseBtn.textContent = '×'
      collapseBtn.title = t('btn_collapse')
      stackContainer.appendChild(collapseBtn)

      // Add emotes and emojis
      stack.forEach((entry) => {
        if (entry.isEmoji) {
          stackContainer.appendChild(
            generateEmojiElement(entry.emoji, entry.emojiName, entry.isOverlay, entry.modifiers, entry.modColorHue),
          )
        } else {
          stackContainer.appendChild(
            generateEmoteElement(entry.emote, entry.isOverlay, entry.modifiers, entry.modColorHue),
          )
        }
      })

      // Add block-all button (⊘)
      const blockAllBtn = document.createElement('span')
      blockAllBtn.className = 'heatsync-stack-block-all'
      blockAllBtn.textContent = '⊘'
      blockAllBtn.title = t('btn_block_all')
      stackContainer.appendChild(blockAllBtn)

      // Force overlay re-center when images load (fixes centering on first render).
      // {once:true} + signal lets the closure release once it fires or on lifecycle abort.
      const imgs = stackContainer.querySelectorAll('img')
      imgs.forEach((img) => {
        if (!img.complete) {
          img.addEventListener(
            'load',
            () => {
              if (!stackContainer.isConnected) return
              requestAnimationFrame(() => {
                if (!stackContainer.isConnected) return
                const overlays = stackContainer.querySelectorAll('.heatsync-overlay')
                overlays.forEach((overlay) => {
                  overlay.style.transform = ''
                })
              })
            },
            { once: true, signal },
          )
        }
      })

      return stackContainer
    }
  }

  // Retry broken emote imgs — 7TV/BTTV/FFZ CDNs occasionally serve 503 and
  // Chrome surfaces them as broken (complete=true, naturalWidth=0). Re-assigning
  // the same src refetches and recovers. Backoff: 1s, 3s, 8s; max 3 tries.
  function hsArmEmoteRetry(img) {
    let tries = 0
    img.addEventListener('error', () => {
      if (tries >= 3 || !img.src || !img.isConnected) return
      tries++
      const delay = tries === 1 ? 1000 : tries === 2 ? 3000 : 8000
      const target = img.src
      cleanup.setTimeout(() => {
        if (!img.isConnected || img.src !== target) return
        img.removeAttribute('src')
        img.src = target
      }, delay)
    })
  }

  // Generate DOM element for a single emote (React-safe, no innerHTML)
  // modifiers: array of class suffixes like ['wide','hflip']  (FFZ-style chained)
  // modColorHue: optional 0-359 deg from c!#hex
  function generateEmoteElement(emote, isOverlay, modifiers, modColorHue) {
    const blocked = blockedEmotes.has(emote.hash)
    const inInventory = inventoryHashSet.has(emote.hash) || inventoryNameSet.has(emote.name)

    // Third-party CDN emotes are all "global" (gray) — flag precomputed in
    // rebuildEmoteMapIfDirty. Fall back to url scan only if missing (broadcast path).
    let isThirdPartyCdn = emote.isThirdParty
    if (isThirdPartyCdn === undefined) {
      const url = emote.url || ''
      isThirdPartyCdn =
        url.includes('cdn.7tv.app') ||
        url.includes('cdn.betterttv.net') ||
        url.includes('cdn.frankerfacez.com') ||
        url.includes('static-cdn.jtvnw.net')
    }

    // Determine overlay class based on state
    let overlayClass = ''
    if (blocked) {
      overlayClass = 'emote-overlay-blocked'
    } else if (inInventory) {
      overlayClass = 'emote-overlay-owned'
    } else if (isThirdPartyCdn) {
      overlayClass = 'emote-overlay-global' // gold - non-ownable
    } else {
      overlayClass = 'emote-overlay-unadded' // blue - can be added
    }

    const cssClasses = ['heatsync-emote']
    if (blocked) cssClasses.push('emote-blocked')
    else if (inInventory) cssClasses.push('emote-in-set')
    else if (isThirdPartyCdn) cssClasses.push('emote-global')

    const overlayWrapperClass = isOverlay ? ' heatsync-overlay' : ''
    // FFZ-style modifier multiset (chain: w! w! → 4x wide)
    const modList = modifiers?.length ? modifiers.slice() : null
    // CSS classes use deduped names (one each is enough for state CSS)
    const modClass = modList
      ? ' ' +
        Array.from(new Set(modList))
          .map((m) => `heatsync-mod-${m}`)
          .join(' ')
      : ''

    // Create wrapper span
    const wrapper = document.createElement('span')
    const ownClass = !isThirdPartyCdn ? ' heatsync-own-emote' : ''
    wrapper.className = `heatsync-emote-wrapper ${overlayClass}${overlayWrapperClass}${ownClass}${modClass}`
    wrapper.dataset.emoteHash = emote.hash
    wrapper.dataset.emoteName = emote.name
    wrapper.dataset.inInventory = String(inInventory)
    // Compose multiset modifier transform — repeats compound (w! w! → 4x wide).
    // Cap each axis at ±4x: chat layout breaks past 4x (line-height etc.) and
    // recipients can't reserve more vertical/horizontal space without overlap.
    const _composeMods = (mods) => {
      let sx = 1,
        sy = 1
      if (mods)
        for (const m of mods) {
          if (m === 'wide') sx *= 2
          else if (m === 'tall') sy *= 2
          else if (m === 'hflip') sx *= -1
          else if (m === 'vmirror') sy *= -1
        }
      sx = Math.min(Math.max(sx, -4), 4)
      sy = Math.min(Math.max(sy, -4), 4)
      return { sx, sy }
    }
    if (isOverlay) {
      // Overlay wrapper: absolute positioned, centered on base emote.
      // Modifier composes with translate to keep centering: translate(-50%,-50%) scale(...)
      const ov = _composeMods(modList)
      const overlayTransform =
        ov.sx !== 1 || ov.sy !== 1 ? `translate(-50%, -50%) scale(${ov.sx}, ${ov.sy})` : 'translate(-50%, -50%)'
      wrapper.style.cssText = `position: absolute; top: 50%; left: 50%; transform: ${overlayTransform}; transform-origin: center; width: auto; height: auto; display: inline-block; z-index: 2; pointer-events: auto; overflow: visible; cursor: pointer;`
    } else {
      // Base wrapper. Modifier scale goes here (not on img) so the green
      // ::before indicator and hit-box scale with the visual emote.
      // Symmetric margins so the scaled visual fits exactly within layout
      // (no off-screen bleed, no overlap with neighbors).
      let baseTransform = ''
      let layoutMargin = ''
      let modScaleVar = ''
      if (modList) {
        const { sx, sy } = _composeMods(modList)
        if (sx !== 1 || sy !== 1) {
          const fx = Math.abs(sx),
            fy = Math.abs(sy)
          baseTransform = `transform: scale(${sx}, ${sy}) !important; transform-origin: center !important;`
          if (fx > 1) {
            const halfX = `calc(var(--hs-emote-width, 28px) * ${(fx - 1) / 2})`
            layoutMargin += `margin-left: ${halfX} !important; margin-right: ${halfX} !important;`
          }
          if (fy > 1) {
            const halfY = `calc(var(--hs-emote-height, 28px) * ${(fy - 1) / 2})`
            layoutMargin += `margin-top: ${halfY} !important; margin-bottom: ${halfY} !important;`
          }
          // Inverse-scale CSS var so outline/box-shadow widths can compensate
          // and look 2px regardless of modifier scale.
          modScaleVar = `--hs-mod-scale: ${Math.max(fx, fy)};`
        }
      }
      wrapper.style.cssText = `display: inline-block; vertical-align: middle; cursor: pointer; position: relative; line-height: 0; font-size: 0; ${baseTransform} ${layoutMargin} ${modScaleVar}`
    }

    // Overlay emotes render at 1x native size (their designed display size)
    const imgSrc = emote.url

    // Create image - native size, no constraints
    const img = document.createElement('img')
    img.src = imgSrc
    img.alt = emote.name
    img.decoding = 'async'
    // Filters (cursed animation, hue tint) stay on img — wrapper-level transform
    // handles scale/flip so the green ::before indicator scales with the emote.
    let modFilter = ''
    if (modList?.includes('cursed')) modFilter += ' hue-rotate(0deg)' // anchor; CSS animation overrides
    if (modColorHue != null) modFilter += ` hue-rotate(${modColorHue}deg) saturate(1.6)`
    const filterStyle = modFilter.trim() ? `filter:${modFilter} !important;` : ''
    img.style.cssText = `display: block !important; width: auto !important; height: ${isOverlay ? 'auto' : 'var(--hs-emote-height, 28px)'} !important; max-width: none !important; max-height: none !important; ${blocked ? 'opacity: 0;' : ''} cursor: pointer; ${filterStyle}`
    // Overlay images need explicit natural dims so Twitch CSS can't constrain them.
    // Fire even when blocked so a later unblock has correct dims (img is opacity:0
    // while blocked, so this is layout-only — no visual flash).
    // Non-overlay blocked emotes deliberately stay at the cssText height (28px) —
    // locking to naturalWidth would push chat rows to 4x for high-DPI assets.
    if (isOverlay) {
      img.onload = function () {
        const nw = this.naturalWidth,
          nh = this.naturalHeight
        this.style.setProperty('width', `${nw}px`, 'important')
        this.style.setProperty('height', `${nh}px`, 'important')
        this.style.setProperty('min-width', `${nw}px`, 'important')
        this.style.setProperty('min-height', `${nh}px`, 'important')
      }
    }
    img.className = cssClasses.join(' ')
    img.dataset.emoteHash = emote.hash
    img.dataset.emoteName = emote.name

    hsArmEmoteRetry(img)
    wrapper.appendChild(img)

    // Multi-variant fallback: if the same name exists in other sources (e.g.,
    // user inventory + 7TV global), append the other variants as hidden sibling
    // imgs with lazy src. Right-clicking to block the active variant then swaps
    // to the next non-blocked sibling in-place — no DOM rebuild, no fetch round-trip
    // (subsequent swaps are instant once the variant img loads once).
    const variants = cachedAllEmoteVariants?.get(emote.name)
    if (variants && variants.length > 1) {
      wrapper.dataset.hasVariants = '1'
      // Tag the primary img with its priority index + classification so
      // pickActiveVariant can sort + categorize it on later state changes.
      const primaryIdx = variants.findIndex((v) => v.hash === emote.hash)
      img.dataset.variantIndex = String(primaryIdx >= 0 ? primaryIdx : 0)
      img.dataset.variantClass = emote.inInventory ? 'inventory' : emote.isGlobal ? 'global' : 'channel'
      img.dataset.emoteUrl = emote.url

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i]
        if (v.hash === emote.hash) continue
        const alt = document.createElement('img')
        alt.alt = emote.name
        alt.dataset.emoteHash = v.hash
        alt.dataset.emoteName = emote.name
        alt.dataset.emoteUrl = v.url
        alt.dataset.variantIndex = String(i)
        alt.dataset.variantClass = v.inInventory ? 'inventory' : v.isGlobal ? 'global' : 'channel'
        alt.decoding = 'async'
        alt.className = 'heatsync-emote'
        // Match primary img dims so layout doesn't reflow when swapping in.
        alt.style.cssText = `display:none !important; width:auto !important; height:${isOverlay ? 'auto' : 'var(--hs-emote-height, 28px)'} !important; max-width:none !important; max-height:none !important; cursor:pointer;`
        if (isOverlay) {
          alt.onload = function () {
            const nw = this.naturalWidth,
              nh = this.naturalHeight
            this.style.setProperty('width', `${nw}px`, 'important')
            this.style.setProperty('height', `${nh}px`, 'important')
            this.style.setProperty('min-width', `${nw}px`, 'important')
            this.style.setProperty('min-height', `${nh}px`, 'important')
          }
        }
        hsArmEmoteRetry(alt)
        wrapper.appendChild(alt)
      }

      // If the primary is already blocked at render time, swap to first available.
      if (blockedEmotes.has(emote.hash)) pickActiveVariant(wrapper)
    }

    return wrapper
  }

  // Retroactive emote replacement — DOM-based (no innerHTML round-trip)
  // Walks text nodes only, splits on emote name, inserts DOM elements directly.
  function replaceEmoteInText(element, emote) {
    const regex = createEmoteRegex(emote.name)
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const matches = []

    // Collect matching text nodes first (mutating during walk is unsafe)
    let node
    while ((node = walker.nextNode())) {
      if (regex.test(node.textContent)) {
        matches.push(node)
        regex.lastIndex = 0
      }
    }

    for (const textNode of matches) {
      const parts = textNode.textContent.split(regex)
      if (parts.length <= 1) continue

      const frag = document.createDocumentFragment()
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) frag.appendChild(document.createTextNode(parts[i]))
        if (i < parts.length - 1) {
          // Use generateEmoteElement if available, otherwise build manually
          const emoteEl = generateEmoteElement(emote)
          frag.appendChild(emoteEl)
        }
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(frag, textNode)
      }
    }
  }

  // Setup event delegation for all emote clicks (ONE listener for all emotes)
  function setupEmoteClickHandlers() {
    cleanup.addEventListener(
      document,
      'click',
      async (e) => {
        const wrapper = e.target.closest('.heatsync-emote-wrapper')
        if (!wrapper) return

        e.preventDefault()
        e.stopPropagation()

        const hash = wrapper.dataset.emoteHash || ''
        const emoteName = wrapper.dataset.emoteName
        const operationKey = `click:${hash || emoteName}`

        // Prevent double-clicks while operation in progress
        if (pendingOperations.has(operationKey)) {
          log(' ⏳ Operation already in progress:', emoteName)
          return
        }

        const isBlocked = hash ? blockedEmotes.has(hash) : blockedEmotes.has(emoteName)
        log(' LEFT CLICK - emote:', emoteName, 'hash:', hash, 'blocked:', isBlocked)

        if (isBlocked) {
          // BLOCKED → left-click means "I want this" → unblock + restore in one go.
          // restoredState lands on 'added' when the hash is still in inventory, so a
          // single click brings it straight back to the set. Right-click → menu for
          // block/other options.
          pendingOperations.add(operationKey)
          try {
            const result = await safeSendMessage({ type: 'unblock_emote', hash })
            if (result?.success) {
              blockedEmotes.delete(hash)
              markLocalBlockToggle(hash, 'unblocked')
              const restoredState = inventoryHashSet.has(hash)
                ? 'added'
                : globalNameSet.has(emoteName)
                  ? 'global'
                  : 'neutral'
              updateEmoteState(hash, emoteName, restoredState)
              log(' ✅ Unblocked:', emoteName)
              showToast(t('content_toast_unblocked', [emoteName]), 'success')
            } else {
              showToast(t('content_toast_failed_unblock', [String(result?.error || 'Unknown error')]), 'error')
            }
          } finally {
            pendingOperations.delete(operationKey)
          }
        } else {
          // NOT BLOCKED → INSERT into chat via Slate (postMessage to autocomplete-hook)
          log(' INSERTING EMOTE via Slate:', emoteName)
          // Get emote URL and hash for Slate insertion
          const imgEl = wrapper.querySelector('img')
          const emoteUrl = imgEl?.src || ''
          window.postMessage(
            {
              type: 'heatsync-insert-emote',
              name: emoteName,
              hash: hash || emoteName,
              url: emoteUrl,
            },
            location.origin,
          )
          log(' 💬 Sent insert request for:', emoteName)
        }
      },
      { capture: true },
      // Capture on purpose — stops propagation so the page's click handler
      // never sees an emote click.
      'emote-click',
    )

    // Right-click on native Twitch/Kick emotes (sub/follower/bits, Kick channel
    // emotes) — these never get wrapped, so no hash exists for server-side block.
    // Instant local-block-by-name toggle (persisted to chrome.storage.local).
    cleanup.addEventListener(
      document,
      'contextmenu',
      async (e) => {
        const img = e.target.closest('img')
        if (!img) return
        if (img.closest('.heatsync-emote-wrapper')) return
        if (img.closest('.heatsync-emote-stack')) return

        const src = img.src || ''
        const nativeCdnFrag = src.includes('static-cdn.jtvnw.net/emoticons')
          ? 'static-cdn.jtvnw.net/emoticons'
          : src.includes('files.kick.com/emotes/')
            ? 'files.kick.com/emotes/'
            : null
        if (!nativeCdnFrag) return

        const name = img.alt
        if (!name) return

        e.preventDefault()
        e.stopPropagation()

        const escName = window.CSS && CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"')
        const sel = `img[alt="${escName}"][src*="${nativeCdnFrag}"]`
        if (localBlockedEmoteNames.has(name)) {
          localBlockedEmoteNames.delete(name)
          document.querySelectorAll(sel).forEach((el) => el.removeAttribute('data-hs-name-blocked'))
        } else {
          localBlockedEmoteNames.add(name)
          document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-hs-name-blocked', '1'))
        }
        try {
          chrome.storage.local.set({ local_blocked_emote_names: Array.from(localBlockedEmoteNames) })
        } catch {}
      },
      { capture: true },
      // Capture on purpose — preempts the page's own context menu.
      'native-twitch-block-contextmenu',
    )

    cleanup.addEventListener(
      document,
      'contextmenu',
      async (e) => {
        const wrapper = e.target.closest('.heatsync-emote-wrapper')
        if (!wrapper) return
        // Stacks are handled by the capture-phase contextmenu handler in
        // setupUsernameColoringObserver — bail so we don't double-toggle.
        if (wrapper.closest('.heatsync-emote-stack')) return

        e.preventDefault()
        e.stopPropagation()

        const hash = wrapper.dataset.emoteHash
        const emoteName = wrapper.dataset.emoteName
        const operationKey = `rightclick:${hash}`

        // Prevent double-clicks while operation in progress
        if (pendingOperations.has(operationKey)) {
          log(' ⏳ Operation already in progress:', emoteName)
          return
        }

        const isBlocked = blockedEmotes.has(hash)
        // Check if this is a global emote - globals can only be blocked, not added/removed from your set
        const isGlobalEmote = wrapper.classList.contains('emote-overlay-global') || globalNameSet.has(emoteName)

        if (isBlocked) {
          // BLOCKED → restored state — optimistic so the UI doesn't lag the server roundtrip
          pendingOperations.add(operationKey)
          const restoredState = inventoryHashSet.has(hash) ? 'added' : isGlobalEmote ? 'global' : 'neutral'
          blockedEmotes.delete(hash)
          markLocalBlockToggle(hash, 'unblocked')
          updateEmoteState(hash, emoteName, restoredState)
          try {
            const result = await safeSendMessage({ type: 'unblock_emote', hash })
            if (result?.success) {
              log(' ✅ Unblocked:', emoteName)
            } else {
              // Rollback
              blockedEmotes.add(hash)
              markLocalBlockToggle(hash, 'blocked')
              updateEmoteState(hash, emoteName, 'blocked')
              showToast(t('content_toast_failed_unblock', [String(result?.error || 'Unknown error')]), 'error')
            }
          } catch (err) {
            if (!extensionContextValid) return
            blockedEmotes.add(hash)
            markLocalBlockToggle(hash, 'blocked')
            updateEmoteState(hash, emoteName, 'blocked')
            showToast(t('content_toast_failed_unblock', [String(err.message)]), 'error')
          } finally {
            pendingOperations.delete(operationKey)
          }
        } else {
          // 2-state model: chat-row right-click only toggles block↔unblock.
          // The old "tier-drop on right-click" (DELETE the inventory variant so
          // the wrapper falls to its lower-tier sibling) was the same accidental-
          // remove footgun the overlay picker had — destructive intent inferred
          // from a casual right-click, no way to recover without a manual re-add.
          // Block is the right operation: hides the inventory variant, the
          // existing lower-tier sibling (channel/global) renders in its place,
          // and an unblock restores the inventory pick. No DELETE round-trip.

          // NEUTRAL/LAST-TIER → BLOCKED
          pendingOperations.add(operationKey)

          // Optimistically block
          blockedEmotes.add(hash)
          markLocalBlockToggle(hash, 'blocked')
          updateEmoteState(hash, emoteName, 'blocked')

          try {
            const result = await safeSendMessage({ type: 'block_emote', hash })
            if (result?.success) {
              log(' 🚫 Blocked:', emoteName)
              showToast(t('content_toast_blocked', [emoteName]), 'info')
            } else {
              // Rollback on failure
              blockedEmotes.delete(hash)
              markLocalBlockToggle(hash, 'unblocked')
              updateEmoteState(hash, emoteName, 'neutral')
              showToast(t('content_toast_failed_block', [String(result?.error || 'Unknown error')]), 'error')
            }
          } catch (err) {
            if (!extensionContextValid) return // Don't rollback/show error if context invalidated
            // Rollback on error
            blockedEmotes.delete(hash)
            markLocalBlockToggle(hash, 'unblocked')
            updateEmoteState(hash, emoteName, 'neutral')
            showToast(t('content_toast_failed_block', [String(err.message)]), 'error')
          } finally {
            pendingOperations.delete(operationKey)
          }
        }
      },
      { capture: true },
      // Capture on purpose — preempts the page's own context menu.
      'emote-contextmenu',
    )

    log(' ✅ Event delegation setup for emote clicks')
  }

  // Multi-variant fallback: when an emote name has variants from different sources
  // (e.g., user inventory + 7TV global), each variant lives as a sibling img in the
  // wrapper. This picks the first non-blocked variant by priority and makes it the
  // active one — moving it to be first child so wrapper.querySelector('img') still
  // returns the visible emote (tooltips, hover preview, etc. read it that way).
  function pickActiveVariant(wrapper) {
    if (wrapper?.dataset.hasVariants !== '1') return
    const imgs = Array.from(wrapper.querySelectorAll(':scope > img.heatsync-emote'))
    if (imgs.length <= 1) return

    // Priority order is encoded in data-variant-index (0 = highest).
    imgs.sort((a, b) => (+a.dataset.variantIndex || 0) - (+b.dataset.variantIndex || 0))

    // First non-blocked, non-stale variant wins. Stale = an `inventory` variant
    // whose hash is no longer in inventoryHashSet (user removed it from their set).
    // Without the stale skip, removing an inventory emote leaves the heatsync img
    // active and re-classed as 'unadded' instead of dropping to the next tier
    // (e.g. 7TV channel) sibling that's still valid.
    // If everything fails both checks, fall back to primary so the standard blocked
    // rendering still applies (greyed-out highest-priority emote).
    let activeImg = null
    for (const img of imgs) {
      const h = img.dataset.emoteHash
      if (blockedEmotes.has(h)) continue
      if (img.dataset.variantClass === 'inventory' && !inventoryHashSet.has(h)) continue
      activeImg = img
      break
    }
    if (!activeImg) activeImg = imgs[0]

    // Keep active as firstElementChild so legacy wrapper.querySelector('img') hits it.
    if (wrapper.firstElementChild !== activeImg) {
      wrapper.insertBefore(activeImg, wrapper.firstElementChild)
    }

    for (const img of imgs) {
      if (img === activeImg) {
        img.style.removeProperty('display')
        // Primary img rendered while blocked has inline opacity:0 — clear it so
        // unblock-via-variant-swap restores visibility. Blocked rendering re-applies
        // via the emote-overlay-blocked class CSS rule, not inline opacity.
        img.style.removeProperty('opacity')
        // Lazy-load src on first activation. Subsequent swaps are instant (cached).
        if (!img.src && img.dataset.emoteUrl) img.src = img.dataset.emoteUrl
      } else {
        img.style.setProperty('display', 'none', 'important')
      }
    }

    const hash = activeImg.dataset.emoteHash
    const name = activeImg.dataset.emoteName
    wrapper.dataset.emoteHash = hash
    wrapper.dataset.emoteName = name

    const variantClass = activeImg.dataset.variantClass
    const inInventory = variantClass === 'inventory' || inventoryHashSet.has(hash)
    const isThirdPartyCdn = !inInventory && (variantClass === 'global' || variantClass === 'channel')
    const isBlocked = blockedEmotes.has(hash)
    wrapper.dataset.inInventory = String(inInventory)

    // Reset overlay + own-emote class to reflect the active variant's category.
    wrapper.classList.remove(
      'emote-overlay-blocked',
      'emote-overlay-owned',
      'emote-overlay-global',
      'emote-overlay-unadded',
    )
    if (isBlocked) wrapper.classList.add('emote-overlay-blocked')
    else if (inInventory) wrapper.classList.add('emote-overlay-owned')
    else if (isThirdPartyCdn) wrapper.classList.add('emote-overlay-global')
    else wrapper.classList.add('emote-overlay-unadded')
    if (inInventory) wrapper.classList.add('heatsync-own-emote')
    else wrapper.classList.remove('heatsync-own-emote')

    // Img state classes — set on the active img only, clear on hidden siblings.
    for (const img of imgs) {
      img.classList.remove('emote-blocked', 'emote-in-set', 'emote-global')
      if (img !== activeImg) continue
      if (isBlocked) img.classList.add('emote-blocked')
      else if (inInventory) img.classList.add('emote-in-set')
      else if (isThirdPartyCdn) img.classList.add('emote-global')
    }
  }

  // Update visual state of all instances of an emote
  function updateEmoteState(hash, emoteName, state) {
    log(` Updating emote "${emoteName}" to state: ${state}, hash: ${hash}`)

    // Query by hash OR name (handles old vs normalized hash mismatch)
    const selector = `[data-emote-hash="${hash}"], [data-emote-name="${emoteName}"]`
    const elements = (findChatContainer() || document).querySelectorAll(selector)
    log(` updateEmoteState found ${elements.length} elements for selector:`, selector)

    // Multi-variant wrappers: re-pick from blockedEmotes state, skip the
    // single-variant class-stamping logic entirely. Dedupe via Set since the
    // selector matches both wrapper and inner img for the same wrapper.
    const variantWrappers = new Set()
    elements.forEach((el) => {
      const w = el.classList?.contains('heatsync-emote-wrapper') ? el : el.tagName === 'IMG' ? el.parentElement : null
      if (w && w.dataset.hasVariants === '1') variantWrappers.add(w)
    })
    variantWrappers.forEach((w) => pickActiveVariant(w))

    elements.forEach((el) => {
      // Handle both wrapper divs and direct img elements
      const img = el.tagName === 'IMG' ? el : el.querySelector('.heatsync-emote')
      if (!img) {
        warn(' No img found for hash:', hash)
        return
      }

      const wrapper = el.tagName === 'IMG' ? el.parentElement : el
      // Variant wrappers already handled above — pickActiveVariant owns their state.
      if (wrapper && wrapper.dataset.hasVariants === '1') return
      const emoteUrl = wrapper?.dataset?.emoteUrl || img?.src || ''

      // Check if third-party CDN emote (7TV, BTTV, FFZ, Twitch native)
      const isThirdPartyCdn =
        emoteUrl.includes('cdn.7tv.app') ||
        emoteUrl.includes('cdn.betterttv.net') ||
        emoteUrl.includes('cdn.frankerfacez.com') ||
        emoteUrl.includes('static-cdn.jtvnw.net')

      // Third-party emotes have no inventory state — collapse neutral/unadded
      // legacy state tags down to 'global' so the rest of this function reads
      // the same path as a Twitch native global.
      let effectiveState = state
      if (isThirdPartyCdn && (state === 'neutral' || state === 'unadded')) {
        effectiveState = 'global'
      }

      // Skip work if state already matches — eliminates redundant attr mutations
      // for popular emotes (a 46-instance block was generating 161 attr mutations,
      // half of them no-ops because the broadcast handler reapplies the same state).
      const targetWrapperClass =
        effectiveState === 'blocked'
          ? 'emote-overlay-blocked'
          : effectiveState === 'added'
            ? 'emote-overlay-owned'
            : effectiveState === 'global'
              ? 'emote-overlay-global'
              : 'emote-overlay-unadded'
      if (wrapper?.classList.contains(targetWrapperClass)) return

      // Remove all state classes
      img.classList.remove('emote-blocked', 'emote-in-set')

      if (wrapper) {
        wrapper.classList.remove(
          'emote-overlay-blocked',
          'emote-overlay-owned',
          'emote-overlay-unadded',
          'emote-overlay-global',
        )
        wrapper.style.removeProperty('--hs-emote-width')
        wrapper.style.removeProperty('--hs-emote-height')
      }

      // CSS handles opacity via .emote-overlay-blocked > img — no inline write needed.
      // Earlier versions read offsetWidth/offsetHeight per element to "lock" dims,
      // forcing N synchronous layouts for popular emotes (visible jank). The lock
      // was for outline accuracy on blocked emotes, but opacity:0 hides the outline
      // too, so it served no visual purpose. Removed.
      switch (effectiveState) {
        case 'blocked':
          if (wrapper) {
            wrapper.classList.add('emote-overlay-blocked')
            // Stack wrappers: lock --hs-emote-width/height so expanded stack
            // layout doesn't collapse around the now-invisible blocked emote.
            // Only one layout read here, only for stacked wrappers.
            if (wrapper.closest('.heatsync-emote-stack')) {
              const w = wrapper.offsetWidth,
                h = wrapper.offsetHeight
              if (w && h) {
                wrapper.style.setProperty('--hs-emote-width', `${w}px`)
                wrapper.style.setProperty('--hs-emote-height', `${h}px`)
              }
            }
          }
          img.classList.add('emote-blocked')
          break

        case 'added':
          if (wrapper) wrapper.classList.add('emote-overlay-owned')
          if (img.style.opacity) img.style.removeProperty('opacity')
          img.classList.add('emote-in-set')
          break

        case 'global':
          if (wrapper) wrapper.classList.add('emote-overlay-global')
          if (img.style.opacity) img.style.removeProperty('opacity')
          break
        default:
          if (wrapper) wrapper.classList.add('emote-overlay-unadded')
          if (img.style.opacity) img.style.removeProperty('opacity')
          break
      }
    })
  }
  // BULLETPROOF emote hover preview - uses stored emote data, not URL parsing
  ;(function setupEmoteHoverPreview() {
    // Single global preview element
    const previewEl = document.createElement('div')
    previewEl.className = 'heatsync-emote-preview'
    previewEl.id = 'heatsync-emote-preview-singleton'
    document.body.appendChild(previewEl)

    let currentWrapper = null
    const hideTimeout = null

    // Largest scale <= 4x whose footprint still fits the viewport, so a wide
    // (up to 384x128) emote is shown WHOLE instead of clipping off-screen.
    // Per-item here (native stack preview lays emotes out as separate labeled
    // items, not a composite) — mirrors the multichat fitPreviewScale.
    function fitPreviewScale(baseW, baseH) {
      if (!baseW || !baseH) return 4
      const availW = window.innerWidth - 24 - 16
      const availH = window.innerHeight - 24 - 60 // label + padding below each item
      return Math.min(4, availW / baseW, availH / baseH)
    }

    function showPreview(wrapper) {
      if (currentWrapper === wrapper) return
      currentWrapper = wrapper
      clearTimeout(hideTimeout)

      // Check if this emote is in a stack - if so, show all stacked emotes
      const stack = wrapper.closest('.heatsync-emote-stack')
      const emotesToShow = []

      // upgradeUrl upgrades the img src directly to max resolution
      // (no hash lookup — hash can match wrong emote)
      function upgradeUrl(url) {
        if (!url) return url
        if (url.includes('cdn.7tv.app'))
          return url.includes('.webp') ? url.replace(/\/[123]x\.webp/, '/4x.webp') : url.replace(/\/[123]x$/, '/4x')
        if (url.includes('cdn.betterttv.net'))
          return url.includes('.webp') ? url.replace(/\/[12]x\.webp/, '/3x.webp') : url.replace(/\/[12]x/, '/3x')
        if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/[123]$/, '/4').replace(/\/[123]\?/, '/4?')
        if (url.includes('static-cdn.jtvnw.net')) return url.replace(/\/[12]\.0/, '/3.0')
        return url
      }

      if (stack) {
        const stackedWrappers = stack.querySelectorAll('.heatsync-emote-wrapper')
        stackedWrappers.forEach((w) => {
          // Blocked emotes are hidden in chat via CSS only — never repaint
          // their asset in the hover preview.
          if (w.classList.contains('emote-overlay-blocked')) return
          const wImg = w.querySelector('img')
          if (wImg?.hasAttribute('data-hs-name-blocked')) return
          const wName = w.dataset.emoteName || wImg?.alt || ''
          const wSrc = wImg ? wImg.src : ''
          if (wSrc) {
            const bw = wImg?.offsetWidth || 28,
              bh = wImg?.offsetHeight || 28
            const s = fitPreviewScale(bw, bh)
            emotesToShow.push({ name: wName, src: wSrc, hiRes: upgradeUrl(wSrc), w: bw * s, h: bh * s })
          }
        })
      } else {
        const img = wrapper.querySelector('img')
        const blocked = wrapper.classList.contains('emote-overlay-blocked') || img?.hasAttribute('data-hs-name-blocked')
        const emoteName = wrapper.dataset.emoteName || img?.alt || ''
        const src = blocked ? '' : img ? img.src : ''
        if (src) {
          const bw = img?.offsetWidth || 28,
            bh = img?.offsetHeight || 28
          const s = fitPreviewScale(bw, bh)
          emotesToShow.push({ name: emoteName, src: src, hiRes: upgradeUrl(src), w: bw * s, h: bh * s })
        }
      }

      if (emotesToShow.length === 0) return

      log(' Preview:', emotesToShow.length, 'emotes')

      // Aggressively strip ALL tooltip attributes from wrapper, img, AND parent elements
      const img = wrapper.querySelector('img')
      wrapper.removeAttribute('aria-describedby')
      wrapper.removeAttribute('data-a-target')
      wrapper.removeAttribute('title')
      if (img) {
        img.removeAttribute('title')
        img.removeAttribute('aria-label')
        img.removeAttribute('aria-describedby')
        img.removeAttribute('data-a-target')
      }
      // Also strip from parent containers that Twitch might use
      let parent = wrapper.parentElement
      for (let i = 0; i < 5 && parent; i++) {
        parent.removeAttribute('aria-describedby')
        parent.removeAttribute('title')
        if (parent.matches('[data-a-target*="emote"]')) {
          parent.removeAttribute('data-a-target')
        }
        parent = parent.parentElement
      }

      // Build emote preview via DOM (no innerHTML — emote src/name from our own data)
      previewEl.textContent = ''
      function makeEmoteItem(e) {
        const item = document.createElement('div')
        item.className = 'heatsync-stacked-emote-item'
        const img = document.createElement('img')
        img.src = e.src
        img.alt = e.name
        img.style.width = `${e.w}px`
        img.style.height = `${e.h}px`
        const label = document.createElement('div')
        label.className = 'heatsync-emote-preview-name'
        label.textContent = e.name
        item.appendChild(img)
        item.appendChild(label)
        return item
      }
      if (emotesToShow.length > 1) {
        const stack = document.createElement('div')
        stack.className = 'heatsync-stacked-preview'
        for (const e of emotesToShow) stack.appendChild(makeEmoteItem(e))
        previewEl.appendChild(stack)
      } else {
        previewEl.appendChild(makeEmoteItem(emotesToShow[0]))
      }

      // Show immediately but position later (after image loads)
      previewEl.style.setProperty('display', 'block', 'important')

      // Initial positioning (will adjust after image loads)
      const rect = wrapper.getBoundingClientRect()
      previewEl.style.left = `${rect.left + rect.width / 2}px`
      previewEl.style.top = `${rect.top - 8}px`
      previewEl.style.transform = 'translate(-50%, -100%)'

      // Reposition after image loads (accurate dimensions for wide emotes)
      const previewImg = previewEl.querySelector('img')
      function repositionPreview() {
        const tooltipRect = previewEl.getBoundingClientRect()
        let left = rect.left + rect.width / 2 - tooltipRect.width / 2
        let top = rect.top - tooltipRect.height - 8
        const pad = 8
        if (left < pad) left = pad
        else if (left + tooltipRect.width > window.innerWidth - pad) left = window.innerWidth - tooltipRect.width - pad
        if (top < pad) top = rect.bottom + 8
        previewEl.style.left = `${left}px`
        previewEl.style.top = `${top}px`
        previewEl.style.transform = 'none'
      }
      if (previewImg) {
        previewImg.addEventListener(
          'load',
          () => {
            if (!previewEl.isConnected) return
            repositionPreview()
          },
          { once: true, signal },
        )
        // Try hi-res upgrade — swap in silently if it loads
        const e0 = emotesToShow[0]
        if (e0.hiRes && e0.hiRes !== e0.src) {
          const probe = new Image()
          probe.addEventListener(
            'load',
            () => {
              if (!previewEl.isConnected) return
              previewEl.querySelectorAll('img').forEach((img, i) => {
                const hi = emotesToShow[i]?.hiRes
                if (hi) {
                  img.src = hi
                  repositionPreview()
                }
              })
            },
            { once: true, signal },
          )
          probe.src = e0.hiRes
        }
      }

      // Add body class to suppress ALL native tooltips
      document.body.classList.add('heatsync-preview-active')

      // NUCLEAR: Hide any visible Twitch tooltips immediately
      document.querySelectorAll('.tw-tooltip, [role="tooltip"], .ReactModal__Overlay').forEach((el) => {
        if (!el.closest('.heatsync-emote-preview')) {
          el.style.display = 'none'
        }
      })
    }

    function hidePreview() {
      clearTimeout(hideTimeout)
      currentWrapper = null
      previewEl.style.setProperty('display', 'none', 'important')
      document.body.classList.remove('heatsync-preview-active')
    }

    // Tooltip hiding disabled - was causing issues with chat identity badge

    // Event delegation - capture phase to fire before Twitch handlers
    cleanup.addEventListener(
      document,
      'mouseover',
      (e) => {
        const wrapper = e.target.closest('.heatsync-emote-wrapper')
        if (wrapper) {
          showPreview(wrapper)
        } else if (currentWrapper && !e.target.closest('.heatsync-emote-preview')) {
          hidePreview()
        }
      },
      'emote-hover-mouseover',
      true,
    )

    cleanup.addEventListener(
      document,
      'mouseout',
      (e) => {
        const wrapper = e.target.closest('.heatsync-emote-wrapper')
        if (wrapper) {
          const related = e.relatedTarget
          if (!related || !wrapper.contains(related)) {
            hidePreview()
          }
        }
      },
      'emote-hover-mouseout',
      true,
    )

    // mousemove preview killswitch — dispatched by the combined listener above
    // (single addEventListener for both overlay+preview, passive, 60fps).
    window._hsPreviewKill = (e) => {
      if (!currentWrapper) return
      const target = e.target
      if (!target?.closest) return
      if (target.closest('.heatsync-emote-wrapper') || target.closest('.heatsync-emote-preview')) return
      hidePreview()
    }

    log(' ✅ Emote hover preview setup')
  })()

  // Profile card on username click — matches website profile-card-pro style
  ;(function setupProfileCard() {
    let cardEl = null
    let cardPollInterval = null
    const profileCache = new Map()
    const PROFILE_TTL = 300000 // 5 min
    const PROFILE_CACHE_MAX = 50

    // Username selectors for click interception (capture phase)
    // Modern Twitch wraps display name span inside button.inline.font-bold —
    // clicks land on the button, so closest() needs to match the button itself.
    const usernameSelectors = [
      '.chat-author__display-name',
      '[data-a-target="chat-message-username"]',
      '.chat-line__username',
      'button.inline.font-bold',
      '.hs-username-colored',
      '.hs-mention-colored',
      '[data-hs-username]',
      '.hs-mc-user', // multichat usernames
    ].join(', ')

    // safeUrl is provided by the auto-bundled lib (src/lib/utils.js) at an
    // enclosing scope — it adds zero-width/control-char stripping (_INVISIBLE_RE)
    // this file's old local copy lacked. Do NOT re-add a local one: it would
    // shadow the hardened version and silently miss future lib hardening.

    function formatNum(n) {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
      return String(n)
    }

    function formatAge(dateStr) {
      if (!dateStr) return null
      const ms = Date.now() - new Date(dateStr).getTime()
      const years = Math.floor(ms / (365.25 * 86400000))
      if (years > 0) return `${years}y`
      const months = Math.floor(ms / (30.44 * 86400000))
      if (months > 0) return `${months}mo`
      const days = Math.floor(ms / 86400000)
      return `${days}d`
    }

    function formatRelTime(dateStr) {
      if (!dateStr) return ''
      const d = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
      if (d > 365) return ` ${Math.floor(d / 365)}y`
      if (d > 30) return ` ${Math.floor(d / 30)}mo`
      if (d > 0) return ` ${d}d`
      return ''
    }

    // Detect current platform
    function getPlatform() {
      if (window.location.hostname.includes('kick.com')) return 'kick'
      return 'twitch'
    }

    // Get current channel login from URL (works on both Twitch and Kick)
    function getChannelLogin() {
      const hostname = window.location.hostname
      if (hostname.includes('twitch.tv')) {
        const match = window.location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_]+)/)
        if (!match) return null
        const ch = match[1].toLowerCase()
        const excluded = ['directory', 'settings', 'videos', 'moderator', 'subscriptions', 'search', 'downloads', 'p']
        return excluded.includes(ch) ? null : ch
      }
      if (hostname.includes('kick.com')) {
        const match = window.location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/)
        if (!match) return null
        const ch = match[1].toLowerCase()
        const excluded = ['categories', 'following', 'settings', 'search', 'dashboard', 'messages']
        return excluded.includes(ch) ? null : ch
      }
      return null
    }

    // Followage + follow counts lookup via Twitch GQL (MAIN world proxy)
    const followageCache = new Map()
    const FOLLOWAGE_TTL = 300000
    async function lookupFollowage(username, channelLogin) {
      if (!username || !channelLogin) return undefined
      if (username.toLowerCase() === channelLogin.toLowerCase()) return undefined
      const key = `${username.toLowerCase()}:${channelLogin.toLowerCase()}`
      const cached = followageCache.get(key)
      if (cached) {
        if (Date.now() - cached.ts >= FOLLOWAGE_TTL) {
          followageCache.delete(key)
        } else return cached.result
      }

      return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2)
        const handler = (e) => {
          if (e.source !== window || e.origin !== location.origin) return
          if (e.data?.type === 'heatsync-gql-response' && e.data.id === id) {
            window.removeEventListener('message', handler)
            clearTimeout(timer)
            const user = e.data.data?.data?.user
            const result = {
              followedAt: user?.follow?.followedAt || null,
              followingCount: user?.follows?.totalCount ?? null,
              followerCount: user?.followers?.totalCount ?? null,
              channelFollowedAt: e.data.data?.data?.channel?.follow?.followedAt || null,
            }
            followageCache.set(key, { result, ts: Date.now() })
            while (followageCache.size > 500) followageCache.delete(followageCache.keys().next().value)
            resolve(result)
          }
        }
        window.addEventListener('message', handler, { signal })
        const safeUser = username.replace(/[^a-z0-9_]/gi, '')
        const safeChan = channelLogin.replace(/[^a-z0-9_]/gi, '')
        window.postMessage(
          {
            type: 'heatsync-gql-request',
            nonce: window.HS?.getMainWorldNonce?.() || null,
            id,
            operation: null,
            variables: {},
            rawQuery: `{ user(login: "${safeUser}") { follow(targetLogin: "${safeChan}") { followedAt } follows { totalCount } followers { totalCount } } channel: user(login: "${safeChan}") { follow(targetLogin: "${safeUser}") { followedAt } } }`,
          },
          location.origin,
        )
        const timer = cleanup.setTimeout(() => {
          window.removeEventListener('message', handler)
          resolve(undefined)
        }, 5000)
      })
    }

    // Fetch profile (cached)
    async function fetchProfile(username, force = false) {
      const key = username.toLowerCase()
      const cached = profileCache.get(key)
      if (!force) {
        if (cached) {
          const ttl = cached.data?.twitch_is_live || cached.data?.kick_is_live ? 60000 : PROFILE_TTL
          if (Date.now() - cached.ts >= ttl) {
            profileCache.delete(key)
          } else return cached.data
        }
      }

      try {
        const data = await HS.apiFetch(`/api/profile/${encodeURIComponent(username)}`, { auth: true })
        const profile = data.profile || data
        profileCache.set(key, { data: profile, ts: Date.now() })
        while (profileCache.size > PROFILE_CACHE_MAX) profileCache.delete(profileCache.keys().next().value)
        return profile
      } catch (err) {
        log(' Profile fetch failed:', username, err.message)
        return null
      }
    }

    // Build card DOM safely — no innerHTML with user data
    function buildCardDOM(profile, username) {
      const frag = document.createDocumentFragment()

      if (!profile) {
        const msg = document.createElement('div')
        msg.className = 'hs-pc-loading'
        msg.textContent = t('common_user_not_found')
        frag.appendChild(msg)
        return frag
      }

      const avatarUrl = safeUrl(
        profile.profile_image_url || profile.twitch_profile_pic || profile.kick_profile_pic || '',
      )
      const displayName = profile.display_name || profile.username || username
      const stats = profile.stats || {}
      const heat = stats.total_heat || 0
      const op = stats.op_count || 0
      const re = stats.re_count || 0
      const twitchFollowers = profile.twitch_followers || 0
      const hsFollowers = stats.followers || 0
      const followers = hsFollowers || twitchFollowers
      const platform = getPlatform()
      // Filter out 'user' and 'broadcaster' — those are not display-worthy global roles.
      // Match website behavior in client/renderers/profile-renderer.js.
      const rawRole = profile.role || (profile.is_admin ? 'admin' : null)
      const role = rawRole && rawRole !== 'user' && rawRole !== 'broadcaster' ? rawRole : null
      const broadcasterType = profile.twitch_broadcaster_type

      // Account age
      const dates = [profile.account_created_at, profile.twitch_created_at, profile.created_at].filter(Boolean)
      const age =
        dates.length > 0
          ? formatAge(new Date(Math.min(...dates.map((d) => new Date(d).getTime()))).toISOString())
          : null

      // Avatar
      if (avatarUrl) {
        const img = document.createElement('img')
        img.className = 'hs-pc-avatar'
        img.src = avatarUrl
        img.alt = ''
        frag.appendChild(img)
      }

      // Info container
      const info = document.createElement('div')
      info.className = 'hs-pc-info'

      // ROW 1: Identity
      const row1 = document.createElement('div')
      row1.className = 'hs-pc-header-line'

      const platSpan = document.createElement('span')
      platSpan.className = `hs-pc-platform ${platform}`
      platSpan.textContent = platform
      row1.appendChild(platSpan)

      const nameSpan = document.createElement('span')
      nameSpan.className = 'hs-pc-name'
      nameSpan.textContent = displayName
      row1.appendChild(nameSpan)

      if (role) {
        // Sanitize: only allow alphanumeric chars in className to prevent
        // injection of arbitrary CSS classes from server-controlled role string
        const safeRoleClass = String(role).replace(/[^a-zA-Z0-9_-]/g, '')
        const roleSpan = document.createElement('span')
        roleSpan.className = `hs-pc-role ${safeRoleClass}`
        roleSpan.textContent = role
        row1.appendChild(roleSpan)
      }
      if (broadcasterType === 'partner') {
        const pSpan = document.createElement('span')
        pSpan.className = 'hs-pc-role partner'
        pSpan.textContent = t('content_card_partner')
        row1.appendChild(pSpan)
      } else if (broadcasterType === 'affiliate') {
        const aSpan = document.createElement('span')
        aSpan.className = 'hs-pc-role affiliate'
        aSpan.textContent = t('content_card_affiliate')
        row1.appendChild(aSpan)
      }
      // Sub-status badge: lazy-fetch after card renders (Twitch only, not own card)
      if (platform === 'twitch' && profile.twitch_id) {
        const subStatusSpan = document.createElement('span')
        subStatusSpan.className = 'hs-pc-role sub-status'
        subStatusSpan.style.display = 'none'
        row1.appendChild(subStatusSpan)
        const targetTwitchId = String(profile.twitch_id)
        queueMicrotask(async () => {
          try {
            const currentUser = getCurrentUsername()
            if (!currentUser || currentUser.toLowerCase() === username.toLowerCase()) return
            const result = await HS.apiFetch('/api/twitch/check-sub', {
              method: 'POST',
              auth: true,
              body: { broadcaster_id: targetTwitchId },
            })
            // Card may have been closed during the fetch — bail before mutating a detached node
            if (!subStatusSpan.isConnected) return
            if (result?.subscribed) {
              const tier = result.tier ? Math.round(Number(result.tier) / 1000) : 1
              subStatusSpan.textContent = tier > 1 ? `subbed T${tier}` : 'subbed'
              subStatusSpan.style.display = ''
            }
          } catch (_e) {
            /* silent */
          }
        })
      }
      if (profile.twitch_verified) {
        const vSpan = document.createElement('span')
        vSpan.className = 'hs-pc-verified'
        vSpan.title = t('content_card_twitch_verified')
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('fill', 'none')
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        bg.setAttribute(
          'd',
          'M14.54 6.29L13.09 4.63l.26-2.17-2.13-.49L10.09.24 8 1.14 5.91.24 4.78 1.97l-2.13.49.26 2.17L1.46 6.29 2.72 8 1.46 9.71l1.45 1.66-.26 2.17 2.13.49L5.91 15.76 8 14.86l2.09.9 1.13-1.73 2.13-.49-.26-2.17 1.45-1.66L13.28 8l1.26-1.71z',
        )
        bg.setAttribute('fill', '#9146ff')
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        check.setAttribute('d', 'M6.5 11.17L3.83 8.5l1.18-1.17L6.5 8.83l4.49-4.5L12.17 5.5 6.5 11.17z')
        check.setAttribute('fill', '#fff')
        svg.appendChild(bg)
        svg.appendChild(check)
        vSpan.appendChild(svg)
        row1.appendChild(vSpan)
      }
      if (profile.kick_verified) {
        const vSpan = document.createElement('span')
        vSpan.className = 'hs-pc-verified'
        vSpan.title = t('content_card_kick_verified')
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('fill', 'none')
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        bg.setAttribute(
          'd',
          'M14.54 6.29L13.09 4.63l.26-2.17-2.13-.49L10.09.24 8 1.14 5.91.24 4.78 1.97l-2.13.49.26 2.17L1.46 6.29 2.72 8 1.46 9.71l1.45 1.66-.26 2.17 2.13.49L5.91 15.76 8 14.86l2.09.9 1.13-1.73 2.13-.49-.26-2.17 1.45-1.66L13.28 8l1.26-1.71z',
        )
        bg.setAttribute('fill', '#53fc18')
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        check.setAttribute('d', 'M6.5 11.17L3.83 8.5l1.18-1.17L6.5 8.83l4.49-4.5L12.17 5.5 6.5 11.17z')
        check.setAttribute('fill', '#000')
        svg.appendChild(bg)
        svg.appendChild(check)
        vSpan.appendChild(svg)
        row1.appendChild(vSpan)
      }
      if (age) {
        const ageSpan = document.createElement('span')
        ageSpan.className = 'hs-pc-age'
        ageSpan.textContent = age
        row1.appendChild(ageSpan)
      }
      // Live status
      if (profile.twitch_is_live) {
        const liveSpan = document.createElement('span')
        liveSpan.className = 'hs-pc-live'
        liveSpan.textContent = t('content_card_live', [
          String(profile.twitch_viewer_count > 0 ? formatNum(profile.twitch_viewer_count) : ''),
        ])
        if (profile.twitch_game) liveSpan.title = profile.twitch_game
        row1.appendChild(liveSpan)
      }
      if (profile.kick_is_live) {
        const liveSpan = document.createElement('span')
        liveSpan.className = 'hs-pc-live hs-pc-live-kick'
        liveSpan.textContent = t('content_card_live', [
          String(profile.kick_viewer_count > 0 ? formatNum(profile.kick_viewer_count) : ''),
        ])
        if (profile.kick_category) liveSpan.title = profile.kick_category
        row1.appendChild(liveSpan)
      }

      // Relationship badges — full suite, every angle and reverse angle.
      // Server's relationship object covers heatsync (isFollowing/isSubscribed),
      // Twitch (followsOnTwitch, subscribedOnTwitch, profileFollowsViewerOnTwitch,
      // profileSubbedToViewerOnTwitch), and Kick (followsOnKick).
      const rel = profile.relationship || {}

      // ─ they → you direction
      const followsYou = rel.profileFollowsViewerOnTwitch || rel.profileFollowsViewerOnKick || rel.followsYou
      const followsYouSince =
        rel.profileFollowsViewerOnTwitchSince || rel.profileFollowsViewerOnKickSince || rel.followsYouSince
      const subsYou = rel.profileSubbedToViewerOnTwitch || rel.profileSubbedToViewerOnKick || rel.subscribesToYou
      const subsYouSince = rel.profileTwitchSubSince || rel.profileKickSubSince || rel.subscribesToYouSince
      const subsYouTier = rel.profileTwitchSubTier || rel.profileKickSubTier || rel.subscribesToYouTier

      // ─ you → them direction
      const youFollow = rel.youFollow ?? rel.isFollowing ?? rel.followsOnTwitch ?? rel.followsOnKick
      const youFollowSince = rel.youFollowSince || rel.followsOnTwitchSince || rel.followsOnKickSince || rel.followedAt
      const youSub = rel.subscribedOnTwitch || rel.subscribedOnKick || rel.isSubscribed
      const youSubSince = rel.subscribedAt || rel.twitchSubSince || rel.kickSubSince
      const youSubTier = rel.twitchSubTier || rel.kickSubTier || rel.subTier

      // 1. THEY follow YOU
      if (followsYou) {
        const fySpan = document.createElement('span')
        fySpan.className = 'hs-pc-follows-you'
        fySpan.textContent = t('content_card_follows_you') + formatRelTime(followsYouSince)
        row1.appendChild(fySpan)
      }
      // 2. THEY sub YOU (with tier)
      if (subsYou) {
        const subSpan = document.createElement('span')
        subSpan.className = 'hs-pc-subs-you'
        const tierStr =
          subsYouTier && subsYouTier > 1 ? ` T${Math.round(Number(subsYouTier) / 1000) || subsYouTier}` : ''
        subSpan.textContent = t('content_card_subs_to_you') + tierStr + formatRelTime(subsYouSince)
        row1.appendChild(subSpan)
      }
      // 3. YOU follow THEM
      if (youFollow) {
        const fgSpan = document.createElement('span')
        fgSpan.className = 'hs-pc-following'
        fgSpan.textContent = t('content_card_you_follow') + formatRelTime(youFollowSince)
        row1.appendChild(fgSpan)
      }
      // 4. YOU sub THEM (with tier)
      if (youSub) {
        const subSpan = document.createElement('span')
        subSpan.className = 'hs-pc-subbed'
        const tier = youSubTier && youSubTier > 1 ? Math.round(Number(youSubTier) / 1000) || youSubTier : null
        subSpan.textContent =
          (tier ? t('content_card_you_sub_tier', [String(tier)]) : t('content_card_you_sub')) +
          formatRelTime(youSubSince)
        row1.appendChild(subSpan)
      }
      // 5. Mutual follow indicator (both directions)
      if (followsYou && youFollow) {
        const mSpan = document.createElement('span')
        mSpan.className = 'hs-pc-mutual-follow'
        mSpan.textContent = 'mutual'
        row1.appendChild(mSpan)
      }
      // 6. Mutual sub indicator (both directions)
      if (subsYou && youSub) {
        const mSpan = document.createElement('span')
        mSpan.className = 'hs-pc-mutual-sub'
        mSpan.textContent = 'mutual sub'
        row1.appendChild(mSpan)
      }
      // Sub tenure from chat badge data (how long they've been subbed to this channel)
      const subMonths = subTenureMap.get(username.toLowerCase())
      if (subMonths) {
        const channelLogin = getChannelLogin()
        const stSpan = document.createElement('span')
        stSpan.className = 'hs-pc-sub-tenure'
        stSpan.textContent = t('content_card_subbed', [channelLogin || '', formatSubTenure(subMonths)])
        row1.appendChild(stSpan)
      }
      info.appendChild(row1)

      // Bio
      if (profile.bio) {
        const bioDiv = document.createElement('div')
        bioDiv.className = 'hs-pc-bio'
        bioDiv.textContent = profile.bio
        info.appendChild(bioDiv)
      }

      // ROW 2: Stats
      const streak = profile.streak || profile.daily_streak || stats.streak || 0
      const hasStats = heat > 0 || op > 0 || re > 0 || followers > 0 || streak > 0
      if (hasStats) {
        const row2 = document.createElement('div')
        row2.className = 'hs-pc-stats-line'

        if (heat > 0) {
          const heatSpan = document.createElement('span')
          heatSpan.className = 'hs-pc-heat'
          heatSpan.style.color = getHeatColor(heat)
          heatSpan.textContent = `${heat}\u00B0`
          row2.appendChild(heatSpan)
        }
        if (op > 0) {
          const opSpan = document.createElement('span')
          opSpan.className = 'hs-pc-op'
          const opNum = document.createElement('span')
          opNum.textContent = op
          const opBadge = document.createElement('span')
          opBadge.className = 'hs-pc-badge-op'
          opBadge.textContent = '[OP]'
          opSpan.append(opNum, opBadge)
          row2.appendChild(opSpan)
        }
        if (re > 0) {
          const reSpan = document.createElement('span')
          reSpan.className = 'hs-pc-re'
          const reNum = document.createElement('span')
          reNum.textContent = re
          const reBadge = document.createElement('span')
          reBadge.className = 'hs-pc-badge-re'
          reBadge.textContent = '[RE]'
          reSpan.append(reNum, reBadge)
          row2.appendChild(reSpan)
        }
        if (followers > 0) {
          const fSpan = document.createElement('span')
          fSpan.className = 'hs-pc-followers'
          fSpan.textContent = t('content_card_followers', [String(formatNum(followers))])
          row2.appendChild(fSpan)
        }
        if (streak > 0) {
          const strkSpan = document.createElement('span')
          strkSpan.className = 'hs-pc-streak'
          strkSpan.textContent = `🔥${streak} day streak`
          row2.appendChild(strkSpan)
        }
        info.appendChild(row2)
      }

      // ROW 3: Actions
      const row3 = document.createElement('div')
      row3.className = 'hs-pc-actions'

      const link = document.createElement('a')
      link.href = `https://heatsync.org/${platform}/${encodeURIComponent(username)}/posts`
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = t('content_view_on_heatsync')
      row3.appendChild(link)

      const actions = [
        { action: 'timeout', label: '10m' },
        { action: 'ban', label: 'ban' },
        { action: 'unban', label: 'unban' },
        { action: 'block', label: 'block' },
      ]
      for (const { action, label } of actions) {
        const btn = document.createElement('button')
        btn.className = 'hs-pc-action'
        btn.dataset.action = action
        btn.dataset.user = username
        btn.textContent = label
        row3.appendChild(btn)
      }
      info.appendChild(row3)

      frag.appendChild(info)

      // Close button
      const closeBtn = document.createElement('button')
      closeBtn.className = 'hs-pc-close'
      closeBtn.textContent = '\u00D7'
      closeBtn.addEventListener('mousedown', (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        closeCard()
      })
      frag.appendChild(closeBtn)

      return frag
    }

    // Position card near click, bounded to viewport
    function positionCard(card, e) {
      card.style.display = 'flex'
      const rect = card.getBoundingClientRect()
      let x = e.clientX + 10
      let y = e.clientY - 10
      if (x + rect.width > window.innerWidth - 10) x = e.clientX - rect.width - 10
      if (y + rect.height > window.innerHeight - 10) y = window.innerHeight - rect.height - 10
      if (x < 10) x = 10
      if (y < 10) y = 10
      card.style.left = `${x}px`
      card.style.top = `${y}px`
    }

    // Find the chat container to host the takeover panel.
    // Prefer multichat container when mounted (always visible when active);
    // otherwise fall back to native chat shell. Selectors intentionally broad
    // because Twitch hashes class names (chat-shell--abc123).
    function findChatPanelTarget() {
      const mcContainer = document.getElementById('hs-mc-container')
      if (mcContainer) return mcContainer
      const host = window.location.hostname
      if (host.includes('twitch.tv')) {
        return document.querySelector(
          CONFIG.SELECTORS.TWITCH_CHAT_SHELL +
            ', section.chat-shell, .chat-shell, .chat-room__content, [data-test-selector="chat-shell"], [data-test-selector="chat-room-component"]',
        )
      }
      if (host.includes('kick.com')) {
        return document.querySelector('#chatroom') || document.querySelector('#channel-chatroom')
      }
      return null
    }

    // Detect if current user has mod abilities in this channel.
    // Heuristic: presence of mod/broadcaster icons in the chat input area or message hover actions.
    function isCurrentUserMod() {
      return !!(
        document.querySelector('[data-a-target="chat-input-buttons-container"] [aria-label*="oderator" i]') ||
        document.querySelector('[data-test-selector="moderator-actions-trigger"]') ||
        document.querySelector('button[aria-label*="oderator" i][aria-label*="ools" i]') ||
        document.querySelector('.moderation-icon, .chat-line__moderator-actions')
      )
    }

    // Pull recent messages by user from multichat IRC buffer + DOM scan.
    async function fetchUserMessages(username, channel, limit = 100) {
      const lower = username.toLowerCase()
      const out = []
      const seenIds = new Set()
      // 1. multichat IRC buffer (persisted by irc.js — most complete history)
      if (channel && chrome?.storage?.local) {
        try {
          const data = await chrome.storage.local.get(`hs_irc_${channel.toLowerCase()}`)
          const stored = data[`hs_irc_${channel.toLowerCase()}`]
          if (stored?.msgs) {
            for (const m of stored.msgs) {
              if (!m.user || m.user.toLowerCase() !== lower) continue
              if (m.id) {
                if (seenIds.has(m.id)) continue
                seenIds.add(m.id)
              }
              out.push({
                time: m.time || 0,
                text: m.text || '',
                system: m.type === 'notice' || m.type === 'usernotice',
              })
            }
          }
        } catch {}
      }
      // 2. Currently-rendered chat DOM (catches messages newer than the persist debounce)
      try {
        const container = findChatContainer()
        if (container) {
          const lines = container.querySelectorAll('.chat-line__message, [data-a-target="chat-line-message"]')
          for (const line of lines) {
            const userEl = line.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
            if (!userEl) continue
            if ((userEl.textContent || '').trim().toLowerCase() !== lower) continue
            const textEl = line.querySelector('[data-a-target="chat-message-text"], .text-fragment')
            const ts = line.querySelector('.chat-line__timestamp')
            // Parse timestamp like "12:34" — best-effort
            let time = 0
            if (ts?.textContent) {
              const m = ts.textContent.match(/(\d{1,2}):(\d{2})/)
              if (m) {
                const d = new Date()
                d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0)
                time = d.getTime()
              }
            }
            out.push({ time, text: (textEl?.textContent || line.textContent || '').trim(), system: false })
          }
        }
      } catch {}
      // Sort newest-last (chronological), dedup by (time, text)
      out.sort((a, b) => a.time - b.time)
      const dedup = []
      let prev = null
      for (const m of out) {
        const key = `${m.time}|${m.text}`
        if (prev === key) continue
        prev = key
        dedup.push(m)
      }
      return dedup.slice(-limit)
    }

    function formatChatTime(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      const today = new Date()
      const sameDay = d.toDateString() === today.toDateString()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      if (sameDay) return `${hh}:${mm}`
      const mo = String(d.getMonth() + 1).padStart(2, '0')
      const da = String(d.getDate()).padStart(2, '0')
      return `${mo}/${da} ${hh}:${mm}`
    }

    // Build the expanded mod-actions section
    function buildModSection(username, _channelLogin, isMod) {
      const section = document.createElement('div')
      section.className = 'hs-pc-section'

      const title = document.createElement('div')
      title.className = 'hs-pc-section-title'
      title.textContent = isMod ? 'mod tools' : 'mod tools (no permission)'
      section.appendChild(title)

      const grid = document.createElement('div')
      grid.className = 'hs-pc-mod-grid'

      // Timeout group — durations only, label is implied by the action
      const toGroup = document.createElement('div')
      toGroup.className = 'hs-pc-mod-group'
      const durations = [
        ['1m', 60],
        ['5m', 300],
        ['10m', 600],
        ['30m', 1800],
        ['1h', 3600],
        ['6h', 21600],
        ['24h', 86400],
      ]
      for (const [label, secs] of durations) {
        const b = document.createElement('button')
        b.className = 'hs-pc-btn'
        b.textContent = label
        b.dataset.action = 'timeout'
        b.dataset.user = username
        b.dataset.duration = String(secs)
        toGroup.appendChild(b)
      }
      grid.appendChild(toGroup)

      // Hard actions — own group so they wrap to a new row under timeout buttons
      const hardGroup = document.createElement('div')
      hardGroup.className = 'hs-pc-mod-group'
      const hardActions = [
        { action: 'ban', label: 'ban', danger: true },
        { action: 'unban', label: 'unban' },
        { action: 'mod', label: 'mod' },
        { action: 'unmod', label: 'unmod' },
        { action: 'vip', label: 'vip' },
        { action: 'unvip', label: 'unvip' },
        { action: 'purge', label: 'x', danger: true },
      ]
      for (const { action, label, danger } of hardActions) {
        const b = document.createElement('button')
        b.className = `hs-pc-btn${danger ? ' danger' : ''}`
        b.textContent = label
        b.dataset.action = action
        b.dataset.user = username
        hardGroup.appendChild(b)
      }
      grid.appendChild(hardGroup)

      section.appendChild(grid)
      return section
    }

    // Notes section — private cross-platform note on this chatter, editable
    // inline. Auto-saves (debounced) to the shared note store; the overlay
    // surfaces the same note keyed to this person's identity.
    function buildNotesSection(username) {
      const section = document.createElement('div')
      section.className = 'hs-pc-section'
      const title = document.createElement('div')
      title.className = 'hs-pc-section-title'
      title.textContent = 'note'
      section.appendChild(title)

      const ta = document.createElement('textarea')
      ta.className = 'hs-pc-note-ta'
      ta.rows = 2
      ta.maxLength = HS_NOTE_MAX
      ta.spellcheck = false
      ta.placeholder = 'private note — only you see this'
      ta.value = noteGet(username)?.text || ''
      let t = null
      const save = () => noteSave(username, ta.value)
      ta.addEventListener('input', () => {
        if (t) clearTimeout(t)
        t = setTimeout(save, 400)
      })
      ta.addEventListener('blur', () => {
        if (t) clearTimeout(t)
        save()
      })
      section.appendChild(ta)
      return section
    }

    // Build message history shell (filled async)
    function buildHistorySection(_username) {
      const section = document.createElement('div')
      section.className = 'hs-pc-section hs-pc-history-section'
      section.style.cssText =
        'flex: 1 1 auto !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; padding-bottom: 0 !important;'

      const title = document.createElement('div')
      title.className = 'hs-pc-section-title'
      const titleText = document.createElement('span')
      titleText.textContent = 'message history'
      title.appendChild(titleText)
      const count = document.createElement('span')
      count.className = 'hs-pc-count'
      count.textContent = '…'
      title.appendChild(count)
      section.appendChild(title)

      const list = document.createElement('div')
      list.className = 'hs-pc-history'
      const empty = document.createElement('div')
      empty.className = 'hs-pc-history-empty'
      empty.textContent = 'loading…'
      list.appendChild(empty)
      section.appendChild(list)

      return { section, list, count }
    }

    function populateHistory(list, count, messages, channelLogin) {
      list.textContent = ''
      if (!messages.length) {
        const e = document.createElement('div')
        e.className = 'hs-pc-history-empty'
        e.textContent = channelLogin ? `no messages from this user in ${channelLogin}` : 'no message history'
        list.appendChild(e)
        count.textContent = '0'
        return
      }
      count.textContent = String(messages.length)
      for (const m of messages) {
        const row = document.createElement('div')
        row.className = `hs-pc-history-msg${m.system ? ' system' : ''}`
        const time = document.createElement('span')
        time.className = 'hs-pc-history-time'
        time.textContent = formatChatTime(m.time)
        const text = document.createElement('span')
        text.className = 'hs-pc-history-text'
        text.textContent = m.text
        row.appendChild(time)
        row.appendChild(text)
        list.appendChild(row)
      }
      // Auto-scroll to bottom (newest). Defer so the layout pass settles first —
      // setting scrollTop before layout means scrollHeight is wrong.
      requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight
      })
    }

    // Build panel footer (block / view profile / open twitch popout / copy)
    function buildPanelFooter(username, profile) {
      const footer = document.createElement('div')
      footer.className = 'hs-pc-panel-footer'
      const platform = getPlatform()

      const viewLink = document.createElement('a')
      viewLink.href = `https://heatsync.org/${platform}/${encodeURIComponent(username)}/posts`
      viewLink.target = '_blank'
      viewLink.rel = 'noopener'
      viewLink.className = 'hs-pc-btn'
      viewLink.textContent = 'view profile'
      footer.appendChild(viewLink)

      // Follow/unfollow on HeatSync — skip own card and cards with no profile id
      const currentUser = getCurrentUsername()
      const profileId = profile?.id
      const isSelf = currentUser && username && currentUser.toLowerCase() === username.toLowerCase()
      if (profileId && !isSelf) {
        // Server uses youFollow on /api/profile responses; isFollowing on some other endpoints. Accept either.
        let following = !!(profile.relationship && (profile.relationship.youFollow ?? profile.relationship.isFollowing))
        const followBtn = document.createElement('button')
        followBtn.className = `hs-pc-btn hs-pc-follow-btn${following ? ' hs-pc-following' : ''}`
        followBtn.textContent = following ? 'unfollow' : 'follow'
        followBtn.addEventListener('click', async () => {
          if (followBtn.disabled) return
          followBtn.disabled = true
          // HS.apiFetch throws on non-2xx — server returns 400 with
          // "Already following this user" or "Not following" when state is
          // already at the target. Treat those as idempotent success.
          const targetFollowing = !following
          const method = targetFollowing ? 'POST' : 'DELETE'
          try {
            // kick_ ids need the username hint — the server can't resolve a
            // kick id to a profile on its own; it verifies the pair.
            const hint =
              method === 'POST' && username && /^kick_\d+$/.test(String(profileId))
                ? `?kickUsername=${encodeURIComponent(username)}`
                : ''
            await HS.apiFetch(`/api/follow/${encodeURIComponent(profileId)}${hint}`, { method, auth: true })
            following = targetFollowing
          } catch (e) {
            const msg = (e?.message || '').toLowerCase()
            if (msg.includes('already following') || msg.includes('not following')) {
              following = targetFollowing
            } else {
              // Every other failure (network, 401, 500, rate-limit) used to be
              // swallowed with no toast and no log: the button snapped back to
              // its old label, so a real failure was indistinguishable from
              // "the click did nothing".
              log('follow toggle failed:', e?.message || e)
              showToast(t(targetFollowing ? 'content_toast_follow_failed' : 'content_toast_unfollow_failed'), 'error')
            }
          }
          if (followBtn.isConnected) {
            followBtn.textContent = following ? 'unfollow' : 'follow'
            followBtn.classList.toggle('hs-pc-following', following)
            followBtn.disabled = false
          }
        })
        footer.appendChild(followBtn)
      }

      if (platform === 'twitch') {
        const popout = document.createElement('a')
        popout.href = `https://www.twitch.tv/popout/${encodeURIComponent(username)}/chat`
        popout.target = '_blank'
        popout.rel = 'noopener'
        popout.className = 'hs-pc-btn subtle'
        popout.textContent = 'twitch profile'
        popout.href = `https://www.twitch.tv/${encodeURIComponent(username)}`
        footer.appendChild(popout)
      }

      if (platform === 'twitch' && profile && profile.twitch_is_live) {
        const clipBtn = document.createElement('button')
        clipBtn.className = 'hs-pc-btn subtle'
        clipBtn.textContent = 'clip'
        let clipEditUrl = null
        clipBtn.addEventListener('click', async () => {
          if (clipEditUrl) {
            window.open(safeUrl(clipEditUrl), '_blank', 'noopener')
            return
          }
          if (clipBtn.disabled) return
          clipBtn.disabled = true
          clipBtn.textContent = 'clipping…'
          const channelLogin = getChannelLogin()
          try {
            const result = await HS.apiFetch('/api/twitch/clip', {
              method: 'POST',
              auth: true,
              body: { channel: channelLogin || username },
            })
            clipEditUrl = result?.edit_url || result?.editUrl || null
            const clipShareUrl = result?.clip_url || result?.clipUrl || null
            if (clipShareUrl) {
              try {
                await navigator.clipboard.writeText(clipShareUrl)
              } catch (_e) {}
            }
            if (!clipBtn.isConnected) return
            clipBtn.textContent = clipShareUrl ? '✓ url copied' : '✓ clip created'
            clipBtn.disabled = false
          } catch (_e) {
            clipBtn.textContent = 'clip'
            clipBtn.disabled = false
            clipBtn.style.borderColor = '#ff0000'
            clipBtn.style.color = '#ff0000'
            cleanup.setTimeout(() => {
              clipBtn.style.borderColor = ''
              clipBtn.style.color = ''
            }, 1500)
          }
        })
        footer.appendChild(clipBtn)
      }

      const copyBtn = document.createElement('button')
      copyBtn.className = 'hs-pc-btn subtle'
      copyBtn.textContent = 'copy name'
      copyBtn.dataset.action = 'copy'
      copyBtn.dataset.user = username
      footer.appendChild(copyBtn)

      const mentionBtn = document.createElement('button')
      mentionBtn.className = 'hs-pc-btn subtle'
      mentionBtn.textContent = 'mention'
      mentionBtn.dataset.action = 'mention'
      mentionBtn.dataset.user = username
      footer.appendChild(mentionBtn)

      const blockBtn = document.createElement('button')
      blockBtn.className = 'hs-pc-btn danger'
      blockBtn.textContent = 'block'
      blockBtn.dataset.action = 'block'
      blockBtn.dataset.user = username
      footer.appendChild(blockBtn)

      return footer
    }

    let cardDragAC = null
    function closeCard() {
      if (cardPollInterval) {
        cleanup.clearInterval(cardPollInterval)
        cardPollInterval = null
      }
      if (cardDragAC) {
        cardDragAC.abort()
        cardDragAC = null
      }
      if (cardEl) {
        cardEl.remove()
        cardEl = null
      }
    }

    // Inject chat command into Twitch input
    // Mod-card actions drive Twitch's own chat input. Both bail-outs used to be
    // silent: clicking "ban" with an invalidated context or no chat input on
    // screen typed nothing, closed nothing, and said nothing.
    function injectChatCommand(command) {
      if (!extensionContextValid) {
        showToast(t('common_extension_updated'), 'warning')
        return
      }
      const chatInput = document.querySelector('[data-a-target="chat-input"]')
      if (!chatInput) {
        showToast(t('content_toast_no_chat_input'), 'error')
        return
      }

      chatInput.focus()
      // Clear existing text and insert command without touching clipboard
      document.execCommand('selectAll')
      document.execCommand('insertText', false, command)
      cleanup.setTimeout(() => {
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
        chatInput.dispatchEvent(enterEvent)
      }, 100)
    }

    // Handle action button clicks
    function handleAction(action, username, opts = {}) {
      switch (action) {
        case 'timeout': {
          const secs = opts.duration || 600
          injectChatCommand(`/timeout ${username} ${secs}`)
          break
        }
        case 'ban':
          injectChatCommand(`/ban ${username}`)
          break
        case 'unban':
          injectChatCommand(`/unban ${username}`)
          break
        case 'mod':
          injectChatCommand(`/mod ${username}`)
          break
        case 'unmod':
          injectChatCommand(`/unmod ${username}`)
          break
        case 'vip':
          injectChatCommand(`/vip ${username}`)
          break
        case 'unvip':
          injectChatCommand(`/unvip ${username}`)
          break
        case 'block':
          // Namespace the key so twitch:alice and kick:alice are independent.
          safeSendMessage({ type: 'block_user', username: userKey(username, isKick ? 'kick' : 'twitch') }).catch(
            () => {},
          )
          closeCard()
          break
        case 'copy':
          try {
            navigator.clipboard.writeText(username)
          } catch {}
          break
        case 'mention': {
          const input = document.querySelector('[data-a-target="chat-input"]')
          if (input) {
            const currentText = input.textContent || ''
            input.focus()
            if (currentText.trim() === '') {
              document.execCommand('selectAll')
              document.execCommand('insertText', false, `@${username} `)
            } else {
              const needsSpace = !currentText.endsWith(' ')
              document.execCommand('insertText', false, `${needsSpace ? ' ' : ''}@${username} `)
            }
          }
          closeCard()
          break
        }
        case 'purge': {
          // Local mass-purge: hide all visible chat lines from this user.
          // Mod-side cleanup is up to /timeout/ban — this is the client view.
          const lower = String(username || '').toLowerCase()
          if (!lower) break
          let n = 0
          document.querySelectorAll('.chat-line__message, [data-index]').forEach((msg) => {
            const userEl = msg.querySelector(
              '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold',
            )
            const u = (userEl?.textContent || '').toLowerCase().trim()
            if (u && u === lower) {
              msg.classList.add('hs-message-purged')
              msg.style.opacity = '0.25'
              msg.style.textDecoration = 'line-through'
              n++
            }
          })
          log(' 🗑️ purged', n, 'messages from', username)
          break
        }
      }
    }

    // Show full-takeover panel on username click. Falls back to floating popup
    // if no chat-panel target is found (e.g., on heatsync.org pages).
    async function showCard(target, e) {
      try {
        const username =
          target.dataset?.hsUsername || target.dataset?.username || target.textContent?.replace(/^@/, '').trim()
        if (!username) return

        const panelTarget = findChatPanelTarget()
        const usePanelMode = !!panelTarget

        // Tear down any existing card before rebuilding
        if (cardEl) closeCard()

        cardEl = document.createElement('div')
        cardEl.className = usePanelMode ? 'hs-pc-panel' : 'hs-profile-card'
        if (usePanelMode) {
          // Ensure host is positioned so absolute inset:0 fills it
          const cs = getComputedStyle(panelTarget)
          if (cs.position === 'static') panelTarget.style.position = 'relative'
          panelTarget.appendChild(cardEl)
        } else {
          document.body.appendChild(cardEl)
          // Drag support for popup mode only
          let dragX, dragY
          cardEl.addEventListener('mousedown', (ev) => {
            if (ev.target.closest('a, button')) return
            ev.preventDefault()
            if (cardDragAC) cardDragAC.abort()
            cardDragAC = new AbortController()
            dragX = ev.clientX - cardEl.offsetLeft
            dragY = ev.clientY - cardEl.offsetTop
            let dragRaf = null
            const onMove = (me) => {
              if (dragRaf) return
              dragRaf = requestAnimationFrame(() => {
                dragRaf = null
                cardEl.style.left = `${me.clientX - dragX}px`
                cardEl.style.top = `${me.clientY - dragY}px`
              })
            }
            const onUp = () => {
              if (cardDragAC) {
                cardDragAC.abort()
                cardDragAC = null
              }
            }
            document.addEventListener('mousemove', onMove, { signal: cardDragAC.signal })
            document.addEventListener('mouseup', onUp, { signal: cardDragAC.signal })
          })
        }

        const channelLogin = getChannelLogin()
        const platform = getPlatform()
        const isMod = isCurrentUserMod()

        // Show loading state
        cardEl.textContent = ''
        const loadingDiv = document.createElement('div')
        loadingDiv.className = 'hs-pc-loading'
        loadingDiv.textContent = t('common_loading')
        cardEl.appendChild(loadingDiv)
        if (!usePanelMode) {
          cardEl.style.display = 'flex'
          positionCard(cardEl, e)
        }

        const profile = await fetchProfile(username)
        // Card may have been closed during the await — bail to avoid NPE on cardEl.textContent
        if (!cardEl) return
        cardEl.textContent = ''

        if (usePanelMode) {
          // Header
          const header = document.createElement('div')
          header.className = 'hs-pc-panel-header'
          const closeBtn = document.createElement('button')
          closeBtn.className = 'hs-pc-panel-close'
          closeBtn.textContent = '×'
          closeBtn.title = 'close (Esc)'
          closeBtn.addEventListener('click', closeCard)
          header.appendChild(closeBtn)
          const hTitle = document.createElement('span')
          hTitle.className = 'hs-pc-panel-title'
          hTitle.textContent = 'user card'
          header.appendChild(hTitle)
          const hName = document.createElement('span')
          hName.className = 'hs-pc-panel-name'
          hName.textContent = profile?.display_name || username
          header.appendChild(hName)
          cardEl.appendChild(header)

          // Identity (avatar + existing card body)
          const identity = document.createElement('div')
          identity.className = 'hs-pc-panel-identity'
          identity.appendChild(buildCardDOM(profile, username))
          // Remove the old close button rendered inside buildCardDOM (panel has its own)
          identity.querySelectorAll('.hs-pc-close, .hs-pc-actions').forEach((el) => el.remove())
          cardEl.appendChild(identity)

          // Mod actions
          cardEl.appendChild(buildModSection(username, channelLogin, isMod))

          // Notes — private cross-platform note on this chatter
          cardEl.appendChild(buildNotesSection(username))

          // Message history (filled async)
          const { section: histSection, list: histList, count: histCount } = buildHistorySection(username)
          cardEl.appendChild(histSection)

          // Footer
          cardEl.appendChild(buildPanelFooter(username, profile))

          // Populate history async
          fetchUserMessages(username, channelLogin, 200)
            .then((messages) => {
              if (!cardEl || !histList.isConnected) return
              populateHistory(histList, histCount, messages, channelLogin)
            })
            .catch(() => {
              if (!cardEl || !histList.isConnected) return
              populateHistory(histList, histCount, [], channelLogin)
            })
        } else {
          cardEl.appendChild(buildCardDOM(profile, username))
          positionCard(cardEl, e)
        }

        // Channel-relationship dimension is distinct from viewer-relationship.
        // - profile ↔ viewer    : rendered by buildCardDOM (you follow / follows you / etc)
        // - profile ↔ channel   : rendered HERE via Twitch GQL (does profile follow channel
        //                          shown in chat → "following nl_kripp 4y", and does channel
        //                          follow profile → "followed by nl_kripp")
        // Don't use rel.youFollow here — that's viewer-relationship and would mislabel.

        // Twitch: enhance with live GQL — only upgrade, never downgrade.
        if (channelLogin && platform === 'twitch') {
          // Capture the cardEl ref so a fast card-close + reopen for a different
          // user can't write user A's followage into user B's card.
          const cardElForFollowage = cardEl
          lookupFollowage(username, channelLogin).then((result) => {
            if (!result || !cardEl || cardEl !== cardElForFollowage || cardEl.style.display === 'none') return
            const headerLine = cardEl.querySelector('.hs-pc-header-line')
            if (!headerLine) return
            if (result.followedAt) {
              const existing = headerLine.querySelector('.hs-pc-followage')
              if (existing) existing.remove()
              const badge = document.createElement('span')
              badge.className = 'hs-pc-followage'
              badge.textContent = t('content_card_following', [channelLogin, formatAge(result.followedAt)])
              headerLine.appendChild(badge)
            }
            if (result.channelFollowedAt && !headerLine.querySelector('.hs-pc-channel-follows')) {
              const cfBadge = document.createElement('span')
              cfBadge.className = 'hs-pc-channel-follows'
              const age = formatAge(result.channelFollowedAt)
              cfBadge.textContent = t('content_card_followed_by', [channelLogin]) + (age ? ` ${age}` : '')
              headerLine.appendChild(cfBadge)
            }
            const statsLine = cardEl.querySelector('.hs-pc-stats-line')
            if (statsLine && result.followingCount != null) {
              let followingEl = statsLine.querySelector('.hs-pc-following-count')
              if (!followingEl) {
                followingEl = document.createElement('span')
                followingEl.className = 'hs-pc-following-count'
                statsLine.appendChild(followingEl)
              }
              followingEl.textContent = t('content_card_following_count', [String(formatNum(result.followingCount))])
            }
            if (statsLine && result.followerCount != null) {
              const followersEl = statsLine.querySelector('.hs-pc-followers')
              if (followersEl) {
                followersEl.textContent = t('content_card_followers', [String(formatNum(result.followerCount))])
              }
            }
          })
        }

        // Live-poll viewer count every 10s while card is visible (lightweight endpoint)
        if (cardPollInterval) {
          cleanup.clearInterval(cardPollInterval)
          cardPollInterval = null
        }
        if (profile && (profile.twitch_is_live || profile.kick_is_live)) {
          cardPollInterval = cleanup.setInterval(async () => {
            if (!cardEl) {
              cleanup.clearInterval(cardPollInterval)
              cardPollInterval = null
              return
            }
            // Snapshot the card element — a fast close+reopen for another user can
            // reassign cardEl during the await, writing user A's viewer count into
            // user B's card (mirrors the followage guard above).
            const cardElForPoll = cardEl
            try {
              const fresh = await HS.apiFetch(`/api/profile/${encodeURIComponent(username)}/live`)
              if (!fresh || !cardEl || cardEl !== cardElForPoll || cardEl.style.display === 'none') return
              // Update twitch live span
              const twitchLive = cardEl.querySelector('.hs-pc-live:not(.hs-pc-live-kick)')
              if (twitchLive && fresh.twitch_is_live) {
                twitchLive.textContent = t('content_card_live', [
                  String(fresh.twitch_viewer_count > 0 ? formatNum(fresh.twitch_viewer_count) : ''),
                ])
              } else if (twitchLive && !fresh.twitch_is_live) {
                twitchLive.remove()
              }
              // Update kick live span
              const kickLive = cardEl.querySelector('.hs-pc-live-kick')
              if (kickLive && fresh.kick_is_live) {
                kickLive.textContent = t('content_card_live', [
                  String(fresh.kick_viewer_count > 0 ? formatNum(fresh.kick_viewer_count) : ''),
                ])
              } else if (kickLive && !fresh.kick_is_live) {
                kickLive.remove()
              }
            } catch (_err) {
              // Silently ignore poll failures
            }
          }, 10000)
        }
      } catch (err) {
        warn(' showCard error:', err)
        if (cardEl) {
          cardEl.textContent = ''
          cardEl.style.display = 'none'
        }
      }
    }

    // Click listener (signal-bound — cleaned up on abort).
    // Click any chat username → open full-takeover user card panel.
    // Click handler — capture phase to intercept before Twitch
    document.addEventListener(
      'click',
      (e) => {
        // Anything inside the card — handle action buttons and stop bubbling
        if (cardEl && e.target.closest('.hs-profile-card, .hs-pc-panel')) {
          e.stopPropagation()
          e.preventDefault()
          if (e.target.closest('.hs-pc-close, .hs-pc-panel-close')) {
            closeCard()
            return
          }
          const actionBtn = e.target.closest('.hs-pc-action, .hs-pc-btn')
          if (actionBtn?.dataset.action && actionBtn.dataset.user) {
            const opts = {}
            if (actionBtn.dataset.duration) opts.duration = parseInt(actionBtn.dataset.duration, 10)
            handleAction(actionBtn.dataset.action, actionBtn.dataset.user, opts)
          }
          return
        }

        const target = e.target.closest(usernameSelectors)
        if (target) {
          const inner = target.querySelector?.('.chat-author__display-name, [data-a-target="chat-message-username"]')
          const src = inner || target
          const raw = src.dataset?.hsUsername || src.dataset?.username || src.textContent?.replace(/^@/, '').trim()
          const username = raw?.replace(/[:\s]+$/, '').trim()
          if (!username) return
          e.stopPropagation()
          e.preventDefault()
          showCard(src, e)
          return
        }

        // Click outside card (and not on a username) → close
        if (cardEl) closeCard()
      },
      { capture: true, signal },
    ) // capture phase, tied to lifecycle

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && cardEl) {
          closeCard()
        }
      },
      { signal },
    )

    // Right-click on username → user color picker
    document.addEventListener(
      'contextmenu',
      (e) => {
        if (!_uiPrefs.userColors) return
        // Multichat panel messages own their own right-click menu (mute/whisper/
        // copy/profile). Don't hijack panel usernames for the color picker.
        if (e.target.closest('.hs-mc-msg')) return
        const target = e.target.closest(usernameSelectors)
        if (!target) return
        const inner = target.querySelector?.('.chat-author__display-name, [data-a-target="chat-message-username"]')
        const src = inner || target
        const raw = src.dataset?.hsUsername || src.dataset?.username || src.textContent?.replace(/^@/, '').trim()
        const username = raw?.replace(/[:\s]+$/, '').trim()
        if (!username) return
        e.preventDefault()
        e.stopPropagation()
        openUserColorPicker(username, e.clientX, e.clientY)
      },
      { capture: true, signal },
    )

    log(' ✅ Profile card (click) setup')
  })()

  // Retroactively process messages when broadcast arrives
  function retroactivelyProcessBroadcast(username, emoteName, emoteData) {
    log(' 🔄 Retroactively processing messages for:', username, emoteName)

    const chatContainer = findChatContainer()
    if (!chatContainer) {
      log(' ⚠️ Chat container not found for retroactive processing')
      return
    }

    // Get only the LAST message - retroactive is just for race condition where message
    // appears a split second before broadcast arrives. Old messages should not be replaced.
    let messages = chatContainer.querySelectorAll('.chat-line__message')
    if (messages.length === 0) {
      messages = chatContainer.querySelectorAll('[data-index]')
    }

    // Process last 5 messages - handles fast chats where message appears after broadcast
    const recentMessages = Array.from(messages).slice(-5)
    let processedCount = 0

    recentMessages.forEach((messageElement) => {
      const messageUsername = getUsername(messageElement)
      if (messageUsername.toLowerCase() !== username.toLowerCase()) return

      const textElement =
        messageElement.querySelector('.text-fragment') ||
        messageElement.querySelector('span.font-normal') ||
        messageElement.querySelector('[class*="message"]')

      if (!textElement) return

      // Skip if emote already replaced (check for existing img with this hash)
      const alreadyReplaced = textElement.querySelector(`img[data-emote-hash="${emoteData.hash}"]`)
      if (alreadyReplaced) return

      // Get text-only content (avoid matching alt text in existing imgs)
      const textContent = Array.from(textElement.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')

      const regex = createEmoteRegex(emoteName)

      if (textContent.match(regex)) {
        log(' ✅ RETROACTIVE REPLACE:', {
          username,
          emoteName,
          messageText: textElement.textContent.substring(0, 50),
        })

        replaceEmoteInText(textElement, {
          name: emoteName,
          url: emoteData.url.startsWith('http') ? emoteData.url : `${API_URL}${emoteData.url}`,
          hash: emoteData.hash,
          width: emoteData.width,
          height: emoteData.height,
        })
        processedCount++
      }
    })

    log(' Retroactively processed', processedCount, 'message(s)')
  }

  // Get username from message element
  function getUsername(messageElement) {
    const usernameEl = messageElement.querySelector(
      '.chat-author__display-name, .chat-line__username, button.inline.font-bold',
    )

    return usernameEl ? usernameEl.textContent.trim() : ''
  }

  // Get Twitch user ID from message element via React fiber
  function getTwitchUserId(messageElement) {
    if (isKick) return null
    // Read data-user-id stamped by early-inject-main.js (MAIN world)
    // Content scripts can't access __reactFiber$ (isolated world)
    return messageElement.getAttribute('data-user-id') || null
  }

  // Apply 7TV paint gradient to a username element
  function applyPaintToElement(el, paint) {
    if (!paint) return
    // Coexistence with 7TV, not an arms race: their paint renders free in our
    // overlay, but it stands down for a saved heatsync paint — the user's own
    // explicit choice. Not optional politeness: this sets INLINE style, which
    // outranks the class-based hsp-<hash> rule, so without the check a 7TV
    // batch resolving second silently erases a paint someone paid for.
    // Mirrors client/chat/seventv-cosmetics.js on the website.
    if (el?.classList) {
      for (const c of el.classList) if (c.startsWith('hsp-')) return
    }
    const fn = (paint.function || '').toLowerCase()
    if (fn === 'url' && paint.image_url) {
      const safe = safeUrl(paint.image_url)
      if (!safe) return
      const safeCssUrl = safe.replace(/[()'"\\]/g, encodeURIComponent)
      el.style.backgroundImage = `url(${safeCssUrl})`
      el.style.backgroundSize = 'cover'
    } else if ((fn === 'linear-gradient' || fn === 'radial-gradient') && paint.stops?.length) {
      const stops = paint.stops
        .map((s) => {
          const r = (s.color >>> 24) & 0xff
          const g = (s.color >>> 16) & 0xff
          const b = (s.color >>> 8) & 0xff
          const a = (s.color & 0xff) / 255
          return `rgba(${r},${g},${b},${a.toFixed(2)}) ${Math.round(s.at * 100)}%`
        })
        .join(', ')
      const safeAngle = Number.isFinite(Number(paint.angle)) ? Number(paint.angle) : 0
      const safeShape = /^(circle|ellipse)$/.test(paint.shape) ? paint.shape : 'circle'
      if (fn === 'linear-gradient') {
        el.style.backgroundImage = `linear-gradient(${safeAngle}deg, ${stops})`
      } else {
        el.style.backgroundImage = `radial-gradient(${safeShape}, ${stops})`
      }
    } else if (paint.color) {
      const r = (paint.color >>> 24) & 0xff
      const g = (paint.color >>> 16) & 0xff
      const b = (paint.color >>> 8) & 0xff
      const a = (paint.color & 0xff) / 255
      el.style.color = `rgba(${r},${g},${b},${a.toFixed(2)})`
      return
    } else {
      return
    }
    el.style.webkitBackgroundClip = 'text'
    el.style.webkitTextFillColor = 'transparent'
    el.style.backgroundClip = 'text'
    if (paint.shadows?.length) {
      el.style.filter = paint.shadows
        .map((s) => {
          const r = (s.color >>> 24) & 0xff
          const g = (s.color >>> 16) & 0xff
          const b = (s.color >>> 8) & 0xff
          const a = (s.color & 0xff) / 255
          return `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px rgba(${r},${g},${b},${a.toFixed(2)}))`
        })
        .join(' ')
    }
    el.dataset.hsPaintApplied = '1'
  }

  // Get the best URL from a 7TV badge host object
  function get7TVBadgeUrl(badge) {
    if (!badge?.host) return ''
    const files = badge.host.files || []
    const file =
      files.find((f) => f.name?.endsWith('.webp')) || files.find((f) => f.name?.endsWith('.avif')) || files[0]
    if (!file) return ''
    const base = badge.host.url || ''
    const fullBase = base.startsWith('//') ? `https:${base}` : base
    return (fullBase.endsWith('/') ? fullBase : `${fullBase}/`) + file.name
  }

  // Apply BTTV/FFZ badges and 7TV paints/badges to a message element
  function applyCosmeticsToMessage(el, userId, preQueriedNameEl) {
    if (!userId) return
    // Fast path: same user + already fully applied → no work, no queries
    if (el.dataset.hsCosmeticAppliedFor === userId && el.dataset.hsCosmeticDone === '1') return

    // Detect recycled DOM node — clear stale cosmetics if userId changed
    const prevUserId = el.dataset.hsCosmeticAppliedFor
    if (prevUserId && prevUserId !== userId) {
      el.querySelectorAll('.hs-cosmetic-badge').forEach((b) => b.remove())
      delete el.dataset.hsCosmeticDone
      delete el.dataset.hsBttvDone
      delete el.dataset.hsFfzDone
      delete el.dataset.hsChatterinoDone
      delete el.dataset.hs7tvBadgeDone
      const oldNameEl =
        preQueriedNameEl || el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
      if (oldNameEl) {
        delete oldNameEl.dataset.hsPaintApplied
        oldNameEl.style.removeProperty('background-image')
        oldNameEl.style.removeProperty('background-size')
        oldNameEl.style.removeProperty('-webkit-background-clip')
        oldNameEl.style.removeProperty('-webkit-text-fill-color')
        oldNameEl.style.removeProperty('background-clip')
        oldNameEl.style.removeProperty('filter')
      }
    }
    el.dataset.hsCosmeticAppliedFor = userId
    const nameEl =
      preQueriedNameEl || el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
    if (!nameEl) return

    // BTTV badge — dataset flag avoids querySelector
    if (!el.dataset.hsBttvDone && !_peerExts.includes('bttv') && bttvBadgeMap.has(userId)) {
      const b = bttvBadgeMap.get(userId)
      const img = document.createElement('img')
      img.className = 'hs-bttv-badge hs-cosmetic-badge'
      img.src = b.url
      img.title = b.description
      img.alt = b.description
      nameEl.parentNode.insertBefore(img, nameEl)
      el.dataset.hsBttvDone = '1'
    }

    // FFZ badges
    if (!el.dataset.hsFfzDone && !_peerExts.includes('ffz') && ffzBadgeMap.has(userId)) {
      for (const b of ffzBadgeMap.get(userId)) {
        const img = document.createElement('img')
        img.className = 'hs-ffz-badge hs-cosmetic-badge'
        img.src = b.url
        img.title = b.title
        img.alt = b.title
        if (b.color && COLOR_RE.test(b.color)) img.style.backgroundColor = b.color
        nameEl.parentNode.insertBefore(img, nameEl)
      }
      el.dataset.hsFfzDone = '1'
    }

    // Chatterino badge
    if (!el.dataset.hsChatterinoDone && chatterinoBadgeMap.has(userId)) {
      const b = chatterinoBadgeMap.get(userId)
      const img = document.createElement('img')
      img.className = 'hs-chatterino-badge hs-cosmetic-badge'
      img.src = b.url
      img.title = b.tooltip
      img.alt = b.tooltip
      nameEl.parentNode.insertBefore(img, nameEl)
      el.dataset.hsChatterinoDone = '1'
    }

    // 7TV cosmetics — diff-update so cosmetics_invalidated swaps cleanly.
    // Skipped when the real 7TV extension is co-installed: it paints/badges
    // native rows itself and doubling up renders duplicates.
    const cosmetic = _peerExts.includes('7tv') ? null : cosmeticsCache.get(userId)
    if (cosmetic) {
      if (cosmetic.badge) {
        const url = get7TVBadgeUrl(cosmetic.badge)
        if (url) {
          const existing = el.querySelector('.hs-7tv-badge')
          if (!existing) {
            const img = document.createElement('img')
            img.className = 'hs-7tv-badge hs-cosmetic-badge'
            img.src = url
            img.title = cosmetic.badge.tooltip || cosmetic.badge.name || '7TV'
            img.alt = '7TV'
            nameEl.parentNode.insertBefore(img, nameEl)
          } else if (existing.src !== url) {
            existing.src = url
            existing.title = cosmetic.badge.tooltip || cosmetic.badge.name || '7TV'
          }
          el.dataset.hs7tvBadgeDone = '1'
        }
      } else if (el.dataset.hs7tvBadgeDone) {
        // Cosmetic was revoked — remove existing badge
        el.querySelector('.hs-7tv-badge')?.remove()
        delete el.dataset.hs7tvBadgeDone
      }
      if (cosmetic.paint && !nameEl.dataset.hsPaintApplied) {
        applyPaintToElement(nameEl, cosmetic.paint)
      } else if (!cosmetic.paint && nameEl.dataset.hsPaintApplied) {
        // Paint revoked — clear paint styles
        nameEl.style.removeProperty('background-image')
        nameEl.style.removeProperty('background-size')
        nameEl.style.removeProperty('-webkit-background-clip')
        nameEl.style.removeProperty('-webkit-text-fill-color')
        nameEl.style.removeProperty('background-clip')
        nameEl.style.removeProperty('filter')
        delete nameEl.dataset.hsPaintApplied
      }
      el.dataset.hsCosmeticDone = '1'
    }
  }

  // Queue a Twitch user ID for 7TV cosmetics batch fetch
  function queueCosmeticsLookup(userId) {
    if (isKick || !userId) return
    const cached = cosmeticsCache.get(userId)
    const isNegative = cached && !cached.paint && !cached.badge
    const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : COSMETICS_TTL
    if (cached && Date.now() - cached.fetchedAt < ttl) return
    cosmeticsPending.add(userId)
    if (cosmeticsPending.size >= COSMETICS_PENDING_MAX) {
      if (cosmeticsBatchTimer) {
        cleanup.clearTimeout(cosmeticsBatchTimer)
        cosmeticsBatchTimer = null
      }
      flushCosmeticsBatch()
      return
    }
    if (!cosmeticsBatchTimer) {
      // Jitter so 30k tabs joining the same channel don't fan out to 7TV in lockstep.
      const delay = 500 + Math.random() * 1500
      cosmeticsBatchTimer = cleanup.setTimeout(() => {
        cosmeticsBatchTimer = null
        flushCosmeticsBatch()
      }, delay)
    }
  }

  async function flushCosmeticsBatch() {
    if (cosmeticsPending.size === 0) return
    const batch = [...cosmeticsPending].slice(0, 10)
    batch.forEach((id) => cosmeticsPending.delete(id))
    try {
      const resp = await safeSendMessage({ type: 'get_user_cosmetics', twitchIds: batch })
      if (!resp?.cosmetics) return
      const now = Date.now()
      for (const [userId, cosmetic] of Object.entries(resp.cosmetics)) {
        if (cosmeticsCache.size >= COSMETICS_MAX) {
          cosmeticsCache.delete(cosmeticsCache.keys().next().value)
        }
        cosmeticsCache.set(userId, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: now })
      }
      applyPendingCosmetics(Object.keys(resp.cosmetics))
    } catch (e) {
      log(' flushCosmeticsBatch failed:', e?.message)
    }
    if (cosmeticsPending.size > 0 && !cosmeticsBatchTimer) {
      cosmeticsBatchTimer = cleanup.setTimeout(
        () => {
          cosmeticsBatchTimer = null
          flushCosmeticsBatch()
        },
        2000 + Math.random() * 2000,
      )
    }
  }

  function applyPendingCosmetics(userIds) {
    const container = findChatContainer()
    if (!container) return
    const idSet = new Set(userIds)
    container.querySelectorAll('[data-hs-cosmetic-user-id]').forEach((el) => {
      if (el.dataset.hsCosmeticDone === '1') return
      const uid = el.dataset.hsCosmeticUserId
      if (idSet.has(uid)) applyCosmeticsToMessage(el, uid)
    })
    // Late-arriving paints for @mention / colored-username spans
    container.querySelectorAll('[data-hs-cosmetic-mention]').forEach((el) => {
      if (el.dataset.hsPaintApplied) return
      const uid = el.dataset.hsCosmeticMention
      if (!idSet.has(uid)) return
      const paint = cosmeticsCache.get(uid)?.paint
      if (paint) applyPaintToElement(el, paint)
    })
  }

  // Queue a one-time fetch of a sender's heatsync + personal emote set. Deduped via
  // the cache (presence = fetched), batched + jittered like cosmetics so 30k tabs
  // don't fan out in lockstep. Keys are platform-prefixed: twitch:<numeric id>
  // (from React internals) or kick:<username> (kick DOM carries no numeric id).
  function queueSenderEmotes(key) {
    if (!key || !/^twitch:\d+$|^kick:[\w-]+$/.test(key)) return
    if (senderEmotePending.has(key)) return
    // Misses re-validate on a short ttl — an empty set is the window where a
    // sender's brand-new emote renders as text if the live broadcast was missed.
    const fetchedAt = senderEmoteFetchedAt.get(key)
    const knownSet = senderHeatsyncEmotes.get(key)
    const refetchMs = knownSet && Object.keys(knownSet).length > 0 ? SENDER_EMOTE_REFETCH_MS : 90 * 1000
    if (fetchedAt && Date.now() - fetchedAt < refetchMs) return
    senderEmotePending.add(key)
    if (senderEmotePending.size >= SENDER_EMOTE_PENDING_MAX) {
      if (senderEmoteBatchTimer) {
        cleanup.clearTimeout(senderEmoteBatchTimer)
        senderEmoteBatchTimer = null
      }
      flushSenderEmoteBatch()
      return
    }
    if (!senderEmoteBatchTimer) {
      const delay = 500 + Math.random() * 1500
      senderEmoteBatchTimer = cleanup.setTimeout(() => {
        senderEmoteBatchTimer = null
        flushSenderEmoteBatch()
      }, delay)
    }
  }

  async function flushSenderEmoteBatch() {
    if (senderEmotePending.size === 0) return
    const batch = [...senderEmotePending].slice(0, SENDER_EMOTE_PENDING_MAX)
    batch.forEach((k) => senderEmotePending.delete(k))
    try {
      const resp = await safeSendMessage({ type: 'get_sender_emotes', senderKeys: batch })
      const emotes = resp?.emotes || {}
      // BG-flagged errored keys: partial result — replacing would clobber a
      // good cached set (raw-text regression). Keep current data + stamp.
      const errored = new Set(resp?.errored || [])
      for (const key of batch) {
        if (errored.has(key)) {
          senderEmoteFetchedAt.set(key, Date.now())
          continue
        }
        const nameToData = emotes[key] || {}
        let inner = null
        for (const [name, data] of Object.entries(nameToData)) {
          if (!data?.url) continue
          if (!inner) inner = new Map()
          inner.set(name, {
            name,
            url: data.url,
            hash: data.hash || '',
            zeroWidth: !!data.zeroWidth,
            source: data.source,
          })
        }
        // Store the Map (or null for fetched-empty); freshness stamp gates re-fetch
        // until the TTL so newly-added emotes propagate without re-fetching forever.
        if (senderHeatsyncEmotes.size >= SENDER_EMOTE_MAX) {
          senderHeatsyncEmotes.delete(senderHeatsyncEmotes.keys().next().value)
        }
        senderHeatsyncEmotes.set(key, inner)
        senderEmoteFetchedAt.set(key, Date.now())
      }
      // Retro-render: messages from these senders already drawn (as text) need a re-pass.
      applySenderEmotesToMessages(batch.filter((k) => senderHeatsyncEmotes.get(k)))
    } catch (e) {
      // Drop the pending mark on failure so a later message can retry.
      for (const k of batch) senderEmotePending.delete(k)
      log(' flushSenderEmoteBatch failed:', e?.message)
    }
  }

  // Re-run emote replacement on already-rendered messages from senders whose set
  // just arrived. Bounded to the live container; resets the generation guard so
  // processMessage runs again (its per-fragment .heatsync-emote-wrapper check keeps
  // it from double-wrapping text that already resolved).
  function applySenderEmotesToMessages(senderKeys) {
    if (!senderKeys || senderKeys.length === 0) return
    const container = findChatContainer()
    if (!container) return
    const twitchIds = new Set()
    const kickUsers = new Set()
    for (const k of senderKeys) {
      const id = k.slice(k.indexOf(':') + 1)
      if (k.startsWith('kick:')) kickUsers.add(id)
      else twitchIds.add(id)
    }
    if (twitchIds.size) {
      container.querySelectorAll('[data-hs-cosmetic-user-id]').forEach((el) => {
        if (!twitchIds.has(el.dataset.hsCosmeticUserId)) return
        el.dataset.heatsyncGeneration = ''
        processMessage(el)
      })
    }
    if (kickUsers.size) {
      container.querySelectorAll('[data-hs-cosmetic-kick-user]').forEach((el) => {
        if (!kickUsers.has(el.dataset.hsCosmeticKickUser)) return
        el.dataset.heatsyncGeneration = ''
        processMessage(el)
      })
    }
  }

  // Apply HeatSync API colors to existing messages in the chat container
  function applyHeatsyncColorsToExisting() {
    const container = findChatContainer()
    if (!container) return
    container.querySelectorAll('.chat-line__message, [data-index]').forEach((el) => {
      const nameEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
      if (!nameEl) return
      const username = nameEl.textContent?.trim().toLowerCase()
      if (!username) return
      const hsColor = heatsyncColorMap.get(username)
      if (hsColor && !nameEl.dataset.hsPaintApplied) {
        nameEl.style.color = hsColor
        knownChatters.set(username, hsColor)
      }
    })
  }

  // Re-apply BTTV/FFZ badges to messages that were processed before badge maps loaded
  function reapplyBadgesToExistingMessages() {
    if (bttvBadgeMap.size === 0 && ffzBadgeMap.size === 0 && chatterinoBadgeMap.size === 0) {
      return
    }
    const container = findChatContainer()
    // Defensive: findChatContainer can return a stale reference whose node was
    // detached between sync check and call (Twitch SPA-nav reparents the chat
    // tree). Verify it still has querySelectorAll before calling. Without this,
    // the runtime onMessage handler crashed with "Cannot read properties of
    // null (reading 'querySelectorAll')" on rare reparent races.
    if (!container || typeof container.querySelectorAll !== 'function') return
    let matched = 0
    container.querySelectorAll('[data-hs-cosmetic-user-id]').forEach((el) => {
      const uid = el.dataset.hsCosmeticUserId
      if (!uid) return
      const needsBttv = bttvBadgeMap.has(uid) && !el.querySelector('.hs-bttv-badge')
      const needsFfz = ffzBadgeMap.has(uid) && !el.querySelector('.hs-ffz-badge')
      const needsChatterino = chatterinoBadgeMap.has(uid) && !el.querySelector('.hs-chatterino-badge')
      if (needsBttv || needsFfz || needsChatterino) {
        applyCosmeticsToMessage(el, uid)
        matched++
      }
    })
    if (matched > 0) log(` ✅ Reapplied cosmetic badges to ${matched} messages`)
  }

  // Fetch BTTV/FFZ/Chatterino badge maps from background.
  // A cold service worker can respond before its storage restore lands, returning
  // empty maps. Retry with backoff until non-empty so badges aren't suppressed
  // until the next ~24h refresh (background also pushes a warm-cache cosmetics_update).
  function fetchCosmeticBadges(attempt = 0) {
    safeSendMessage({ type: 'get_bulk_badges' })
      .then((resp) => {
        const bttv = resp?.bttvBadges ? Object.entries(resp.bttvBadges) : []
        const ffz = resp?.ffzBadges ? Object.entries(resp.ffzBadges) : []
        const chat = resp?.chatterinoBadges ? Object.entries(resp.chatterinoBadges) : []
        if (bttv.length + ffz.length + chat.length === 0) {
          if (attempt < 8)
            cleanup.setTimeout(() => fetchCosmeticBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
          return
        }
        bttvBadgeMap = new Map(bttv)
        ffzBadgeMap = new Map(ffz)
        chatterinoBadgeMap = new Map(chat)
        log(
          ' Initial cosmetics: BTTV',
          bttvBadgeMap.size,
          'FFZ',
          ffzBadgeMap.size,
          'Chatterino',
          chatterinoBadgeMap.size,
        )
        reapplyBadgesToExistingMessages()
      })
      .catch(() => {
        if (attempt < 8) cleanup.setTimeout(() => fetchCosmeticBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
      })
  }

  // =============================================================================
  // TIMEOUT / BAN DIMMING
  // =============================================================================
  // Restores cached message body when Twitch replaces it with "message deleted"
  // entry.html is Twitch's serialized chat DOM captured at render time (no user-typed raw text).
  // template parsing is inert — no scripts execute — and we strip dangerous tags before attach.

  function restoreDeletedMessage(bodyEl, msgId) {
    const entry = originalMessageBodies.get(msgId)
    if (!entry?.nodes) return
    // Clone the snapshot so the restore is repeatable (e.g. re-render). Strip
    // executable/resource nodes defensively even though Twitch's chat DOM never
    // contains them.
    const clones = entry.nodes.map((n) => n.cloneNode(true))
    for (const c of clones) {
      if (c.nodeType === 1) {
        c.querySelectorAll?.('script,link,style,iframe,object,embed').forEach((n) => n.remove())
      }
    }
    bodyEl.replaceChildren(...clones)
  }

  // Mark a message as timed out in the localStorage cache so it persists across reloads
  function markCachedMessageTimedOut(msgId) {
    const idx = msgCacheBuffer.findIndex((m) => m.id === msgId)
    if (idx !== -1) {
      msgCacheBuffer[idx].timedOut = true
      scheduleMsgCacheSave()
    }
  }

  // Load dimTimeouts setting from storage
  chrome.storage.local
    .get('hs_dim_timeouts')
    .then((data) => {
      if (data.hs_dim_timeouts !== undefined) dimTimeoutsEnabled = data.hs_dim_timeouts
    })
    .catch(() => {})

  // =============================================================================
  // KICK COSMETICS (7TV paints + badges by username)
  // =============================================================================
  // BTTV/FFZ badges use Twitch user IDs — not available on Kick.
  // 7TV supports Kick natively via /v3/users/kick/{username}.

  function applyKickCosmeticsToMessage(el, kickSlug) {
    if (!kickSlug) return
    const prevSlug = el.dataset.hsCosmeticAppliedFor
    if (prevSlug && prevSlug !== kickSlug) {
      el.querySelectorAll('.hs-cosmetic-badge').forEach((b) => b.remove())
      delete el.dataset.hsCosmeticDone
      delete el.dataset.hsBttvDone
      delete el.dataset.hsFfzDone
      const nameEl = el.querySelector('button.inline.font-bold')
      if (nameEl) {
        delete nameEl.dataset.hsPaintApplied
        nameEl.style.removeProperty('background-image')
        nameEl.style.removeProperty('background-size')
        nameEl.style.removeProperty('-webkit-background-clip')
        nameEl.style.removeProperty('-webkit-text-fill-color')
        nameEl.style.removeProperty('background-clip')
        nameEl.style.removeProperty('filter')
      }
    }
    el.dataset.hsCosmeticAppliedFor = kickSlug
    const nameEl = el.querySelector('button.inline.font-bold')
    if (!nameEl) return

    const cosmetic = kickCosmeticsCache.get(kickSlug)
    if (!cosmetic) return

    // 7TV badge (skip when the real 7TV ext is co-installed — duplicate render)
    if (cosmetic.badge && !_peerExts.includes('7tv') && !el.querySelector('.hs-7tv-badge')) {
      const url = get7TVBadgeUrl(cosmetic.badge)
      if (url) {
        const img = document.createElement('img')
        img.className = 'hs-7tv-badge hs-cosmetic-badge'
        img.src = url
        img.title = cosmetic.badge.tooltip || cosmetic.badge.name || '7TV'
        img.alt = '7TV'
        nameEl.parentNode.insertBefore(img, nameEl)
      }
    }

    // BTTV + FFZ badges (Kick users with a linked Twitch account)
    const twitchId = cosmetic.twitchId
    if (twitchId) {
      if (!el.dataset.hsBttvDone && !_peerExts.includes('bttv') && bttvBadgeMap.has(twitchId)) {
        const b = bttvBadgeMap.get(twitchId)
        const img = document.createElement('img')
        img.className = 'hs-bttv-badge hs-cosmetic-badge'
        img.src = b.url
        img.title = b.description
        img.alt = b.description
        nameEl.parentNode.insertBefore(img, nameEl)
        el.dataset.hsBttvDone = '1'
      }
      if (!el.dataset.hsFfzDone && !_peerExts.includes('ffz') && ffzBadgeMap.has(twitchId)) {
        for (const b of ffzBadgeMap.get(twitchId)) {
          const img = document.createElement('img')
          img.className = 'hs-ffz-badge hs-cosmetic-badge'
          img.src = b.url
          img.title = b.title
          img.alt = b.title
          if (b.color && COLOR_RE.test(b.color)) img.style.backgroundColor = b.color
          nameEl.parentNode.insertBefore(img, nameEl)
        }
        el.dataset.hsFfzDone = '1'
      }
    }

    // 7TV paint (same co-install skip as the badge above)
    if (cosmetic.paint && !_peerExts.includes('7tv') && !nameEl.dataset.hsPaintApplied) {
      applyPaintToElement(nameEl, cosmetic.paint)
    }
    el.dataset.hsCosmeticDone = '1'
  }

  function queueKickCosmeticsLookup(kickSlug) {
    if (!isKick || !kickSlug) return
    const cached = kickCosmeticsCache.get(kickSlug)
    const isNegative = cached && !cached.paint && !cached.badge
    const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : COSMETICS_TTL
    if (cached && Date.now() - cached.fetchedAt < ttl) return
    kickCosmeticsPending.add(kickSlug)
    if (kickCosmeticsPending.size >= COSMETICS_PENDING_MAX) {
      if (kickCosmeticsBatchTimer) {
        cleanup.clearTimeout(kickCosmeticsBatchTimer)
        kickCosmeticsBatchTimer = null
      }
      flushKickCosmeticsBatch()
      return
    }
    if (!kickCosmeticsBatchTimer) {
      kickCosmeticsBatchTimer = cleanup.setTimeout(() => {
        kickCosmeticsBatchTimer = null
        flushKickCosmeticsBatch()
      }, 500)
    }
  }

  async function flushKickCosmeticsBatch() {
    if (kickCosmeticsPending.size === 0) return
    const batch = [...kickCosmeticsPending].slice(0, 10)
    batch.forEach((slug) => kickCosmeticsPending.delete(slug))
    try {
      const resp = await safeSendMessage({ type: 'get_kick_user_cosmetics', kickUsernames: batch })
      if (!resp?.cosmetics) return
      const now = Date.now()
      for (const [slug, cosmetic] of Object.entries(resp.cosmetics)) {
        if (kickCosmeticsCache.size >= COSMETICS_MAX) {
          kickCosmeticsCache.delete(kickCosmeticsCache.keys().next().value)
        }
        kickCosmeticsCache.set(slug, { ...(cosmetic || { paint: null, badge: null }), fetchedAt: now })
      }
      applyPendingKickCosmetics(Object.keys(resp.cosmetics))
    } catch (e) {
      log(' flushKickCosmeticsBatch failed:', e?.message)
    }
    if (kickCosmeticsPending.size > 0 && !kickCosmeticsBatchTimer) {
      kickCosmeticsBatchTimer = cleanup.setTimeout(() => {
        kickCosmeticsBatchTimer = null
        flushKickCosmeticsBatch()
      }, 2000)
    }
  }

  function applyPendingKickCosmetics(slugs) {
    const container = findChatContainer()
    if (!container) return
    const slugSet = new Set(slugs)
    container.querySelectorAll('[data-hs-cosmetic-kick-user]').forEach((el) => {
      if (el.dataset.hsCosmeticDone === '1') return
      const slug = el.dataset.hsCosmeticKickUser
      if (slugSet.has(slug)) applyKickCosmeticsToMessage(el, slug)
    })
  }

  // Right-click on chat message or username → instant 24h mute
  function setupMessageContextMenu() {
    cleanup.addEventListener(
      document,
      'contextmenu',
      (e) => {
        // Don't intercept emote right-clicks (heatsync wrappers or native Twitch
        // emotes) — those instant block/unblock via their own handlers.
        if (e.target.closest('.heatsync-emote-wrapper')) return
        const imgEl = e.target.closest('img')
        if (imgEl && (imgEl.src || '').includes('static-cdn.jtvnw.net/emoticons')) return

        const msgEl = e.target.closest('.chat-line__message, #chatroom-messages [data-index]')
        if (!msgEl) return

        const username = getUsername(msgEl)
        if (!username) return

        e.preventDefault()
        openMessageActionMenu(msgEl, username, e.clientX, e.clientY)
      },
      { signal },
    )
  }

  function _toggleUserMute(username) {
    const pagePlatform = isKick ? 'kick' : 'twitch'
    const key = userKey(username, pagePlatform)
    const bareLower = username.toLowerCase()
    if (userSetMatches(mutedUsers, username, pagePlatform, [])) {
      mutedUsers.delete(key)
      if (bareLower !== key) mutedUsers.delete(bareLower) // clear legacy bare entry
      safeSendMessage({ type: 'unmute_user', username: key }).catch(() => {})
      unmuteUser(username) // bare for DOM matching
      showToast(t('content_toast_unmuted', [username]))
    } else {
      mutedUsers.add(key)
      safeSendMessage({ type: 'mute_user', username: key, expiresAt: Date.now() + 86400000 }).catch(() => {})
      muteUser(username) // bare for DOM matching
      showToast(t('content_toast_muted_24h', [username]))
    }
  }

  // Readable message body: walk fragments + emote alts, skip badges/timestamps.
  function _extractMessageText(msgEl) {
    const frags = msgEl.querySelectorAll(
      '[data-a-target="chat-message-text"], .text-fragment, .message [class*="text-fragment"]',
    )
    if (frags.length) {
      // Drop fragments nested inside another matched fragment so a container +
      // its children don't double-emit the same text.
      const top = Array.from(frags).filter((f) => !Array.from(frags).some((o) => o !== f && o.contains(f)))
      const parts = []
      // Recursive walk: a fragment can interleave an inline-imagified emote and
      // text (e.g. "<emote> Kripp, when..."). The old img-or-textContent map kept
      // only the emote alt and dropped the trailing text. Walk every node so both
      // land in reading order.
      const walk = (node) => {
        if (node.nodeType === 3) {
          parts.push(node.textContent)
          return
        }
        if (node.nodeType !== 1) return
        // Skip emote-stack control glyphs (× collapse, ⊘ block-all) — they're UI
        // affordances, not message content, and would leak into the clipboard.
        const cls = node.classList
        if (cls && (cls.contains('heatsync-stack-collapse') || cls.contains('heatsync-stack-block-all'))) return
        if (node.tagName === 'IMG') {
          if (node.alt) parts.push(node.alt)
          return
        }
        for (const child of node.childNodes) walk(child)
      }
      for (const f of top) walk(f)
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    }
    const body = msgEl.querySelector(
      '.chat-line__message-body, [data-test-selector="chat-line-message-body"], .chat-entry',
    )
    return ((body || msgEl).textContent || '').replace(/\s+/g, ' ').trim()
  }

  // Right-click action menu for a chat message (mirrors the multichat panel menu).
  // Replaces the old insta-mute so an accidental right-click can't silently 24h-mute.
  function openMessageActionMenu(msgEl, username, x, y) {
    closeEmoteMenu()
    // Namespace-aware (+ legacy-bare) so the mute/unmute label is correct for
    // platform-scoped mutes, matching the render-filter check above.
    const isMuted = userSetMatches(mutedUsers, username, isKick ? 'kick' : 'twitch', [])

    const el = document.createElement('div')
    el.id = 'hs-msg-menu'
    el.className = 'hs-ctx-menu'
    el.tabIndex = -1
    el.addEventListener('contextmenu', (ev) => ev.preventDefault())

    let kbdIndex = 1
    const kbdHandlers = {}
    const addHeader = (text) => {
      const h = document.createElement('div')
      h.className = 'hs-em-header'
      h.textContent = text
      el.appendChild(h)
    }
    const addItem = (label, fn, { danger = false, good = false } = {}) => {
      const it = document.createElement('div')
      it.className = `hs-em-item${danger ? ' hs-em-danger' : ''}${good ? ' hs-em-good' : ''}`
      const lab = document.createElement('span')
      lab.className = 'hs-em-label'
      lab.textContent = label
      it.appendChild(lab)
      if (kbdIndex <= 9) {
        const k = document.createElement('span')
        k.className = 'hs-em-kbd'
        k.textContent = String(kbdIndex)
        it.appendChild(k)
        kbdHandlers[String(kbdIndex)] = fn
        kbdIndex++
      }
      it.addEventListener('click', () => {
        try {
          fn()
        } catch {}
        closeEmoteMenu()
      })
      el.appendChild(it)
    }
    const addSep = () => {
      const s = document.createElement('div')
      s.className = 'hs-em-sep'
      el.appendChild(s)
    }

    addHeader(username)
    addItem('copy username', () => navigator.clipboard?.writeText(username))
    addItem('copy message', () => navigator.clipboard?.writeText(_extractMessageText(msgEl)))

    addSep()
    if (isMuted) addItem('unmute', () => _toggleUserMute(username), { good: true })
    else addItem('mute (24h)', () => _toggleUserMute(username), { danger: true })

    addSep()
    addItem('profile', () =>
      window.open(`https://heatsync.org/user/${encodeURIComponent(username)}`, '_blank', 'noopener,noreferrer'),
    )

    placeAndWireMenu(el, x, y, kbdHandlers)
  }

  // Hide all messages from a blocked user
  function hideBlockedUser(username) {
    ;(findChatContainer() || document).querySelectorAll('.chat-line__message, [data-index]').forEach((msg) => {
      if (getUsername(msg) === username) msg.style.display = 'none'
    })
  }

  // Unhide all messages from an unblocked user
  function unhideBlockedUser(username) {
    ;(findChatContainer() || document).querySelectorAll('.chat-line__message, [data-index]').forEach((msg) => {
      if (getUsername(msg) === username) msg.style.display = ''
    })
  }

  // Undo mute — can't restore stripped DOM, just remove class for future messages
  function unmuteUser(username) {
    ;(findChatContainer() || document).querySelectorAll('.hs-user-muted').forEach((msg) => {
      if (getUsername(msg) === username) {
        msg.classList.remove('hs-user-muted')
      }
    })
  }

  // Hide blocked emote everywhere — idempotent (skips wrappers already blocked).
  // Opacity is handled by CSS via .emote-overlay-blocked > img — no inline writes.
  function hideBlockedEmote(hash) {
    const elements = document.querySelectorAll(`[data-emote-hash="${hash}"]`)
    elements.forEach((wrapper) => {
      if (wrapper.classList.contains('emote-overlay-blocked')) return
      wrapper.classList.remove('emote-overlay-owned', 'emote-overlay-unadded', 'emote-overlay-global')
      wrapper.classList.add('emote-overlay-blocked')
      const img = wrapper.querySelector('.heatsync-emote')
      if (img) {
        img.classList.add('emote-blocked')
        img.classList.remove('emote-in-set')
      }
    })
  }

  // Show unblocked emote everywhere — idempotent (skips wrappers already in target state)
  function showUnblockedEmote(hash) {
    const elements = document.querySelectorAll(`[data-emote-hash="${hash}"]`)
    elements.forEach((wrapper) => {
      const img = wrapper.querySelector('.heatsync-emote')
      const emoteName = wrapper.dataset.emoteName
      const emoteUrl = wrapper.dataset.emoteUrl || img?.src || ''

      const isThirdPartyCdn =
        emoteUrl.includes('cdn.7tv.app') ||
        emoteUrl.includes('cdn.betterttv.net') ||
        emoteUrl.includes('cdn.frankerfacez.com') ||
        emoteUrl.includes('static-cdn.jtvnw.net')

      const inInventory = inventoryHashSet.has(hash) || inventoryNameSet.has(emoteName)
      const isGlobalEmote = globalNameSet.has(emoteName)

      const targetClass = inInventory
        ? 'emote-overlay-owned'
        : isThirdPartyCdn || isGlobalEmote
          ? 'emote-overlay-global'
          : 'emote-overlay-unadded'
      if (wrapper.classList.contains(targetClass)) return

      wrapper.classList.remove(
        'emote-overlay-blocked',
        'emote-overlay-owned',
        'emote-overlay-unadded',
        'emote-overlay-global',
      )
      wrapper.classList.add(targetClass)

      if (img) {
        if (img.style.opacity) img.style.removeProperty('opacity')
        img.classList.remove('emote-blocked')
        if (inInventory) img.classList.add('emote-in-set')
        else img.classList.remove('emote-in-set')
      }
    })
  }

  // Hide muted user content, gray username
  function muteUser(username) {
    ;(findChatContainer() || document).querySelectorAll('.chat-line__message, [data-index]').forEach((msg) => {
      if (getUsername(msg) === username) {
        stripMutedMessage(msg)
      }
    })
  }

  // Mark a message as muted — CSS hides the content (React-safe, survives re-renders)
  function stripMutedMessage(messageElement) {
    messageElement.classList.add('hs-user-muted')
  }

  // Escape regex special characters
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Create emote matching regex that handles both word and non-word character emotes.
  // \b doesn't work for emotes like ")))" since ) is not a word character.
  // Cache per-emote-name so we don't recompile on retroactive replacement passes.
  const _emoteRegexCache = new Map()
  function createEmoteRegex(emoteName) {
    const cached = _emoteRegexCache.get(emoteName)
    if (cached) {
      cached.lastIndex = 0
      return cached
    }
    const escaped = escapeRegex(emoteName)
    const hasWordChars = /\w/.test(emoteName)
    const re = hasWordChars ? new RegExp(`\\b${escaped}\\b`, 'g') : new RegExp(`(?<=^|\\s)${escaped}(?=\\s|$)`, 'g')
    if (_emoteRegexCache.size > 5000) {
      const toDelete = Math.floor(_emoteRegexCache.size * 0.1)
      const it = _emoteRegexCache.keys()
      for (let i = 0; i < toDelete; i++) _emoteRegexCache.delete(it.next().value)
    }
    _emoteRegexCache.set(emoteName, re)
    return re
  }

  // Watch for new messages (MutationObserver)
  let messageObserver = null
  let observedContainer = null
  let watchRetryCount = 0
  function watchForNewMessages() {
    // Overlay is up → native chat is hidden → skip wiring the dead message pipeline
    // (isOverlayActive defined at the top of the IIFE). self-twitch-id still registers
    // at boot from localStorage['twilight.user'] (~5307), not this observer.
    if (isOverlayActive()) return
    const chatContainer = findChatContainer()
    if (!chatContainer) {
      if (++watchRetryCount > 60) return
      const delay = watchRetryCount <= 30 ? 1000 : 2000
      log(' ⏳ watchForNewMessages: no container found, retrying in', delay, 'ms (attempt', watchRetryCount, ')')
      cleanup.setTimeout(watchForNewMessages, delay)
      return
    }
    watchRetryCount = 0

    log(' ✅ watchForNewMessages: found container:', chatContainer.className?.substring(0, 100))

    // Disconnect and untrack existing observer if any
    if (messageObserver) {
      messageObserver.disconnect()
      cleanup.untrackObserver(messageObserver)
      messageObserver = null
      log(' 🔌 Disconnected previous message observer')
    }

    // Batch processing queue to avoid React conflicts.
    // Cap at MAX_QUEUE — sustained 1k+ msg/min raids can outpace processMessage's
    // ~16ms per call, leaving the queue unbounded between rAF flushes. Drop oldest
    // when full so live messages always win over backlog.
    const MAX_QUEUE = 500
    const processingQueue = []
    let processingScheduled = false
    let processingDropped = 0
    function pushToQueue(node) {
      if (processingQueue.length >= MAX_QUEUE) {
        processingQueue.shift()
        processingDropped++
        if (processingDropped % 100 === 0) {
          log(' ⚠️ message queue dropped', processingDropped, 'old messages (raid backlog)')
        }
      }
      processingQueue.push(node)
    }

    // Unified chat observer: replaces 3 separate observers (messages, username
    // coloring, userId attribute) on the same chatContainer subtree. Browser
    // fires every observer's callback per mutation, so 3 observers = 3x dispatch
    // cost on every Twitch React reconciliation. One observer = one dispatch.
    const newColoringMessages = []
    const cosmeticRefresh = []
    messageObserver = cleanup.trackObserver(
      new MutationObserver((mutations) => {
        // Overlay mounted after we wired this observer → native chat is now hidden;
        // stop doing per-message work on it (see isOverlayActive above).
        if (isOverlayActive()) return
        ensureEmoteStyles()
        newColoringMessages.length = 0
        cosmeticRefresh.length = 0
        mutations.forEach((mutation) => {
          // === ATTRIBUTE MUTATION (was userIdObserver) ===
          if (mutation.type === 'attributes') {
            if (!cosmeticsEnabled || isKick) return
            if (mutation.attributeName !== 'data-user-id') return
            const el = mutation.target
            if (!el?.classList?.contains('chat-line__message')) return
            const userId = el.getAttribute('data-user-id')
            if (!userId) return
            if (el.dataset.hsCosmeticUserId === userId) return
            el.dataset.hsCosmeticUserId = userId
            const usernameEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
            applyCosmeticsToMessage(el, userId, usernameEl)
            queueCosmeticsLookup(userId)
            if (!_selfTwitchIdRegistered) {
              const me = getCurrentUsername()
              const username = usernameEl?.textContent?.trim().toLowerCase()
              if (me && username && me === username) {
                _selfTwitchIdRegistered = true
                safeSendMessage({ type: 'register_self_twitch_id', twitchId: userId })
              }
            }
            return
          }

          // === CHILD-LIST MUTATION ===
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              // Twitch chat message
              if (node.classList.contains('chat-line__message')) {
                pushToQueue(node)
                if (!node.dataset.heatsyncUsernamesColored) newColoringMessages.push(node)
              }
              // Kick chat message (div with data-index inside #chatroom-messages)
              else if (node.hasAttribute?.('data-index') && node.closest?.('#chatroom-messages')) {
                pushToQueue(node)
                if (!node.dataset.heatsyncUsernamesColored) newColoringMessages.push(node)
              }
              // Check if it has chat-line__message inside
              else if (node.querySelector?.('.chat-line__message')) {
                node.querySelectorAll('.chat-line__message').forEach((msg) => pushToQueue(msg))
                // Username-coloring fallback: collect uncolored inner messages
                for (const msg of node.querySelectorAll(
                  '.chat-line__message:not([data-heatsync-usernames-colored]), [data-index]:not([data-heatsync-usernames-colored])',
                )) {
                  newColoringMessages.push(msg)
                }
                // Detect React replacing username elements inside already-processed messages
                const msgParent = node.closest?.('.chat-line__message, [data-index]')
                if (msgParent?.dataset.hsCosmeticDone === '1') {
                  const nameEl = msgParent.querySelector(
                    '.chat-author__display-name, [data-a-target="chat-message-username"]',
                  )
                  if (nameEl && !nameEl.dataset.hsPaintApplied) cosmeticRefresh.push(msgParent)
                }
              }
            }
          })

          // Detect timeout/ban: two cases to handle.
          // Short-circuit: if we have no recent message bodies cached, neither
          // case can match — skip the closest()/querySelector() walks entirely.
          if (dimTimeoutsEnabled && originalMessageBodies.size > 0) {
            // Case 1: Twitch replaces body with "message deleted" (mod view / show deleted msgs)
            if (mutation.target) {
              const msgEl = mutation.target.closest?.('.chat-line__message')
              if (msgEl && !msgEl.classList.contains('hs-timed-out')) {
                const msgId = msgEl.dataset.msgId || msgEl.getAttribute('data-msg-id')
                if (msgId && originalMessageBodies.has(msgId)) {
                  const body = msgEl.querySelector('[data-a-target="chat-line-message-body"]')
                  // Structural detection (locale-independent) — Twitch stamps a
                  // deleted/moderated class on the line and/or swaps the body
                  // for a placeholder. Never match on localized text.
                  const isDeleted =
                    msgEl.matches(
                      '.chat-line__message--deleted, .chat-line__message--moderated, [class*="chat-line__message"][class*="deleted"]',
                    ) || !!msgEl.querySelector('[data-a-target="chat-deleted-message-placeholder"]')
                  if (body && isDeleted) {
                    restoreDeletedMessage(body, msgId)
                    msgEl.classList.add('hs-timed-out')
                    markCachedMessageTimedOut(msgId)
                  }
                }
              }
            }

            // Case 2: Twitch removes the message entirely (non-mod viewer timeout/purge)
            // Only re-insert recent messages (<60s) — old removals are scroll-off, not timeouts
            mutation.removedNodes.forEach((node) => {
              if (node.nodeType !== 1) return
              const msgs = node.classList?.contains('chat-line__message')
                ? [node]
                : Array.from(node.querySelectorAll?.('.chat-line__message') || [])
              for (const msgEl of msgs) {
                if (msgEl.classList.contains('hs-timed-out')) continue
                const msgId = msgEl.dataset.msgId || msgEl.getAttribute('data-msg-id')
                if (!msgId) continue
                const entry = originalMessageBodies.get(msgId)
                if (!entry || Date.now() - entry.ts > 60000) continue
                // Re-insert at original position with dimmed styling
                msgEl.classList.add('hs-timed-out')
                markCachedMessageTimedOut(msgId)
                const container = mutation.target
                if (container && container.nodeType === 1) {
                  if (mutation.nextSibling) {
                    container.insertBefore(msgEl, mutation.nextSibling)
                  } else {
                    container.appendChild(msgEl)
                  }
                }
              }
            })
          }
        })

        // Defer processing to let React settle (prevents DOM conflicts).
        // Small batches (≤8 msgs — live chat trickle) get the tight rAF+16ms
        // path. Large batches (boot backfill, raid burst, scroll-back hydration)
        // route through hsSched.chunk so no single frame blocks > ~4ms.
        if (!processingScheduled && processingQueue.length > 0) {
          processingScheduled = true
          log(' 📬 Queued', processingQueue.length, 'messages for processing')
          requestAnimationFrame(() => {
            cleanup.setTimeout(async () => {
              const batch = processingQueue.splice(0) // Copy and clear queue
              log(' 🔄 Processing batch of', batch.length, 'messages')

              const processOne = (msg) => {
                try {
                  // Cache BEFORE processMessage: it replaces emote words with
                  // <img> (no textContent) and inserts stack '×'/'⊘' glyphs, so
                  // capturing after serialized a corrupted body that dropped
                  // every emote and leaked the button chars. Snapshot raw text
                  // first (mirrors the timeout-restore cache ordering).
                  if (!msg.dataset.heatsyncCached && !msg.dataset.heatsyncBackfill) {
                    captureMessageToCache(msg)
                  }
                  processMessage(msg)
                } catch (e) {
                  log(' ❌ processMessage error:', e.message)
                }
              }

              if (batch.length <= 8) {
                for (const msg of batch) processOne(msg)
              } else {
                await hsSched.chunk(batch, processOne, { budgetMs: 4 })
              }
              processingScheduled = false
            }, 16) // Wait one frame for React to settle (animated emotes need this)
          })
        }

        // Re-apply cosmetics where React replaced username elements inside
        // already-processed messages (was usernameColoringObserver's branch).
        if (cosmeticRefresh.length > 0) {
          const refreshBatch = cosmeticRefresh.slice()
          requestAnimationFrame(() => {
            for (const msg of refreshBatch) {
              delete msg.dataset.hsCosmeticDone
              const uid = msg.dataset.hsCosmeticUserId
              const kickUser = msg.dataset.hsCosmeticKickUser
              if (uid) applyCosmeticsToMessage(msg, uid)
              else if (kickUser) applyKickCosmeticsToMessage(msg, kickUser)
            }
          })
        }

        // Username-coloring rAF batch (was usernameColoringObserver's main path).
        if (newColoringMessages.length > 0) {
          const thisObserver = messageObserver
          if (!thisObserver) return
          if (thisObserver._coloringPending) {
            const q = thisObserver._coloringQueued || []
            q.push(...newColoringMessages)
            thisObserver._coloringQueued = q
          } else {
            thisObserver._coloringPending = true
            thisObserver._coloringQueued = newColoringMessages.slice()
            requestAnimationFrame(() => {
              thisObserver._coloringPending = false
              const batch = thisObserver._coloringQueued || []
              thisObserver._coloringQueued = null
              const allEmotes = cachedAllEmotes || new Map()
              const vh = window.innerHeight
              const visible = []
              for (const msg of batch) {
                if (msg.dataset.heatsyncUsernamesColored) continue
                const rect = msg.getBoundingClientRect()
                if (rect.top < vh && rect.bottom > 0) visible.push(msg)
              }
              for (const msg of visible) {
                msg.dataset.heatsyncUsernamesColored = '1'
                // Gate on the setting — processMessage's own call is gated, but
                // this observer path ran unconditionally, so turning
                // highlightMentions off had no effect (dead toggle).
                if (_uiPrefs.highlightMentions) highlightUserMentions(msg)
                colorUsernameMentions(msg)
                if (msg.dataset.heatsyncGeneration !== emoteGeneration) {
                  stackAdjacentOverlayEmotes(msg, allEmotes)
                }
              }
            })
          }
        }
      }),
      'message-observer',
    )

    observedContainer = chatContainer
    // childList+subtree for messages, attributes for cosmetic data-user-id stamping.
    messageObserver.observe(chatContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-user-id'],
    })
    log(' 👁️ Watching for new messages in chat container')
    // Sweep existing messages where data-user-id was already stamped before our
    // observer attached (page load with backfill / live messages already there).
    // Also build a username→uid map from live (uid-bearing) messages, then
    // back-fill data-user-id onto cached/backfilled messages by username so
    // their cosmetics work too (cached entries from older builds didn't store
    // the twitch id, and robotty backfill may not have it for every user).
    //
    // The querySelectorAll calls themselves are cheap, but the per-msg
    // applyCosmeticsToMessage (creates badge imgs, walks fiber for paints) is
    // not. On 150-msg backfill it was the second-biggest boot stall after
    // processExistingMessages. Both sweeps now go through hsSched.chunk.
    const usernameToUid = new Map()
    const stampedEls = Array.from(chatContainer.querySelectorAll('.chat-line__message[data-user-id]'))
    for (const el of stampedEls) {
      const uid = el.getAttribute('data-user-id')
      const username =
        el.dataset.aUser || el.querySelector('.chat-author__display-name')?.textContent?.trim().toLowerCase()
      if (uid && username) usernameToUid.set(username, uid)
    }
    const applyStamped = (el) => {
      const uid = el.getAttribute('data-user-id')
      if (!uid) return
      if (el.dataset.hsCosmeticUserId === uid) return
      el.dataset.hsCosmeticUserId = uid
      const usernameEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
      applyCosmeticsToMessage(el, uid, usernameEl)
      queueCosmeticsLookup(uid)
      if (!_selfTwitchIdRegistered) {
        const me = getCurrentUsername()
        const username = el.dataset.aUser || usernameEl?.textContent?.trim().toLowerCase()
        if (me && username && me === username) {
          _selfTwitchIdRegistered = true
          safeSendMessage({ type: 'register_self_twitch_id', twitchId: uid })
        }
      }
    }
    const unstampedEls = Array.from(chatContainer.querySelectorAll('.chat-line__message:not([data-user-id])'))
    const applyUnstamped = (el) => {
      const username =
        el.dataset.aUser || el.querySelector('.chat-author__display-name')?.textContent?.trim().toLowerCase()
      if (!username) return
      const uid = usernameToUid.get(username)
      if (!uid) return
      el.setAttribute('data-user-id', uid)
      el.dataset.hsCosmeticUserId = uid
      const usernameEl = el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
      applyCosmeticsToMessage(el, uid, usernameEl)
      queueCosmeticsLookup(uid)
    }
    ;(async () => {
      await hsSched.chunk(stampedEls, applyStamped, { budgetMs: 4 })
      await hsSched.chunk(unstampedEls, applyUnstamped, { budgetMs: 4 })
    })()
  }

  // Extract Twitch channel ID from page (needed for 7TV API)
  function getTwitchChannelId() {
    try {
      // Method 0 (fast): dataset attribute set by early-inject MAIN-world script
      // when it captures channel ID from Twitch's own GQL traffic / Apollo cache.
      // This is the modern path — the others only work on legacy SPA hydration.
      const slug = location.pathname.match(/^\/([^/?#]+)/)?.[1]?.toLowerCase()
      const dsId = document.documentElement.dataset.hsTwitchChannelId
      const dsLogin = document.documentElement.dataset.hsTwitchChannelLogin
      if (dsId && dsLogin && dsLogin === slug) return dsId

      // Method 1: Check __NEXT_DATA__ for channel ID
      const nextData = document.getElementById('__NEXT_DATA__')
      if (nextData) {
        const data = JSON.parse(nextData.textContent)
        const channelId =
          data?.props?.pageProps?.channelId || data?.props?.relayEnvironment?.store?.['client:root']?.channel?.id
        if (channelId) return channelId
      }

      // Method 2: Look for it in window object (Twitch sometimes exposes it)
      if (window.__twilight_client__?.store) {
        const state = window.__twilight_client__.store.getState()
        const channelId = state?.channel?.currentChannelID
        if (channelId) return channelId
      }

      // Method 3: Parse from any script containing channel data
      const scripts = document.querySelectorAll('script:not([src])')
      for (const script of scripts) {
        const text = script.textContent
        if (text.includes('"channelId"') || text.includes('"channel_id"')) {
          const match = text.match(/"channel_?[iI]d"\s*:\s*"?(\d+)"?/)
          if (match) return match[1]
        }
      }
    } catch (e) {
      log(' Error getting Twitch channel ID:', e)
    }
    return null
  }

  // Detect channel and join room
  // Wait briefly for early-inject (MAIN world) to deliver channel ID via the
  // dataset attribute it stamps on documentElement. Resolves to ID or null on timeout.
  function waitForTwitchChannelId(slug, timeoutMs) {
    return new Promise((resolve) => {
      const sync = getTwitchChannelId()
      if (sync) return resolve(sync)
      // AbortController guarantees handler is removed even if a slow response arrives post-timeout
      const ac = new AbortController()
      const handler = (e) => {
        if (e.source !== window || e.origin !== location.origin) return
        if (e.data?.type === 'heatsync-page-channel-id' && e.data.login === slug && e.data.channelId) {
          // Require nonce (set by content.js initMainWorldNonce) — blocks rogue
          // MAIN-world page scripts that satisfy source+origin checks
          const nonce = window.HS?.getMainWorldNonce?.()
          if (!nonce || e.data.nonce !== nonce) return
          // Strictly numeric channel IDs only
          const cid = String(e.data.channelId)
          if (!/^\d+$/.test(cid)) return
          ac.abort()
          clearTimeout(timer)
          resolve(cid)
        }
      }
      const timer = setTimeout(() => {
        ac.abort()
        resolve(null)
      }, timeoutMs)
      window.addEventListener('message', handler, { signal: ac.signal })
    })
  }

  async function detectAndJoinChannel() {
    const url = window.location.href
    let platform, channelName, channelId

    if (url.includes('twitch.tv')) {
      platform = 'twitch'
      // Extract channel from URL: /popout/CHANNEL/chat or just /CHANNEL
      const match = url.match(/\/popout\/([^/]+)\/chat/) || url.match(/twitch\.tv\/([^/?]+)/)
      channelName = match ? match[1] : null
      // Exclude system paths that aren't actual channels
      const excludedPaths = TWITCH_EXCLUDED_PATHS
      if (channelName && excludedPaths.includes(channelName.toLowerCase())) {
        log(' Skipping system path:', channelName)
        channelName = null
      }
      // Try to get channel ID for 7TV API — wait briefly for early-inject if not yet available
      if (channelName) {
        const slug = channelName.toLowerCase()
        channelId = await waitForTwitchChannelId(slug, 600)
        if (channelId) log(' Got Twitch channel ID:', channelId)
        else log(' No channel ID after 600ms wait — background will GQL-resolve')
      }
    } else if (url.includes('kick.com')) {
      platform = 'kick'
      // Handle popout/embed URLs: /popout/channel/chat or /embed/channel/chat
      const popoutMatch = url.match(/kick\.com\/(?:popout|embed)\/([^/?]+)/)
      if (popoutMatch) {
        channelName = popoutMatch[1]?.toLowerCase() || null
      } else {
        const match = url.match(/kick\.com\/([^/?]+)/)
        const slug = match ? match[1]?.toLowerCase() : null
        const kickExcluded = [
          'categories',
          'following',
          'settings',
          'browse',
          'search',
          'dashboard',
          'category',
          'password',
          'popout',
          'embed',
        ]
        channelName = slug && !kickExcluded.includes(slug) ? slug : null
      }
    }

    if (platform && channelName) {
      log(' Detected channel:', platform, channelName)
      safeSendMessage({
        type: 'join_channel',
        platform,
        channel: channelName,
        channelId: channelId || null,
      })
        .then((response) => {
          log(' ✅ join_channel sent, response:', response)
        })
        .catch((err) => {
          if (!extensionContextValid) return
          log(' ⚠️ detectAndJoinChannel error:', err?.message || err)
        })

      // If we still don't have an ID but early-inject discovers it later,
      // forward to background so it's available for subsequent operations / next reload.
      if (platform === 'twitch' && !channelId) {
        const slug = channelName.toLowerCase()
        const lateHandler = (e) => {
          if (e.source !== window || e.origin !== location.origin) return
          if (e.data?.type === 'heatsync-page-channel-id' && e.data.login === slug && e.data.channelId) {
            // Mirror the primary handler's nonce + numeric guards — blocks rogue
            // MAIN-world page scripts that satisfy source+origin checks
            const nonce = window.HS?.getMainWorldNonce?.()
            if (!nonce || e.data.nonce !== nonce) return
            const cid = String(e.data.channelId)
            if (!/^\d+$/.test(cid)) return
            window.removeEventListener('message', lateHandler)
            safeSendMessage({
              type: 'update_channel_id',
              platform,
              channel: channelName,
              channelId: cid,
            }).catch(() => {})
          }
        }
        cleanup.addEventListener(window, 'message', lateHandler)
        // Auto-cleanup after 30s to avoid lingering listeners
        cleanup.setTimeout(() => window.removeEventListener('message', lateHandler), 30000)
      }
    }
  }

  // =============================================================================
  // TAB COMPLETION FOR EMOTES
  // =============================================================================
  // Works like heatsync.org: type partial emote name, Tab to complete/cycle
  // Shows preview popup with emote image and counter (1/5)
  // Arrow keys navigate, Escape cancels

  const tabCompleteState = {
    active: false,
    matches: [],
    index: 0,
    startPos: 0,
    originalWord: '',
    lastInserted: '', // Track what we last inserted for cycling
    inputElement: null,
    completing: false, // Prevent re-entry during completion
  }

  // Build combined emote map for searching (inventory + globals)
  // Tier order matches input.js: channel (0) > inventory/own (1) > global (2)
  // Channel emotes are inserted first so they win dedup on name collision.
  let _tabEmoteMap = null
  let _tabEmoteMapDirty = true
  function buildEmoteMap() {
    if (_tabEmoteMap && !_tabEmoteMapDirty && !allEmotesDirty) return _tabEmoteMap
    _tabEmoteMapDirty = false
    const map = new Map()

    // Tier 0 — channel emotes win dedup (inserted first, highest priority)
    channelEmotes.forEach((emote) => {
      if (!emote.source) return
      const key = emote.name.toLowerCase()
      map.set(key, {
        name: emote.name,
        url: emote.url?.startsWith('http') ? emote.url : `${API_URL}${emote.url}`,
        hash: emote.hash,
        provider: 'channel',
      })
    })

    // Tier 1 — viewer's own inventory (doesn't override channel)
    emoteInventory.forEach((emote) => {
      const key = emote.name.toLowerCase()
      if (!map.has(key)) {
        map.set(key, {
          name: emote.name,
          url: emote.url?.startsWith('http') ? emote.url : `${API_URL}${emote.url}`,
          hash: emote.hash,
          provider: 'inventory',
        })
      }
    })

    // Tier 2 — global emotes (BTTV, FFZ, 7TV) — lowest priority
    globalEmotes.forEach((emote) => {
      const key = emote.name.toLowerCase()
      if (!map.has(key)) {
        map.set(key, {
          name: emote.name,
          url: emote.url,
          hash: emote.hash || btoa(emote.url),
          provider: emote.source || 'global',
        })
      }
    })

    _tabEmoteMap = map
    return map
  }

  // Get text and cursor position from contenteditable or textarea
  function getInputState(element) {
    const isContentEditable = element.getAttribute('contenteditable') === 'true'

    if (isContentEditable) {
      const selection = window.getSelection()
      if (!selection.rangeCount) return { text: '', cursorPos: 0 }

      const range = selection.getRangeAt(0)
      // Use textContent - innerText adds newlines in contenteditable
      const text = (element.textContent || '').replace(/\n/g, '')

      // Calculate cursor position by walking through text nodes
      let cursorPos = 0
      const treeWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node
      while ((node = treeWalker.nextNode())) {
        if (node === range.startContainer) {
          cursorPos += range.startOffset
          break
        }
        cursorPos += node.textContent.length
      }

      return { text, cursorPos, isContentEditable: true }
    } else {
      return {
        text: element.value || '',
        cursorPos: element.selectionStart || 0,
        isContentEditable: false,
      }
    }
  }

  // Find matches for partial emote name
  function findEmoteMatches(partialWord) {
    const emoteMap = buildEmoteMap()
    const matches = []
    const partial = partialWord.toLowerCase()

    log(
      ` 🔍 Searching for "${partial}" in ${emoteMap.size} emotes (inv: ${emoteInventory.length}, global: ${globalEmotes.length}, channel: ${channelEmotes.length})`,
    )

    for (const [name, emote] of emoteMap.entries()) {
      if (name.includes(partial)) {
        matches.push(emote)
      }
    }

    // Add emoji matches for :prefix style (Discord/Slack)
    if (partialWord.startsWith(':') && partial.length >= 3) {
      const emojiSearch = partial.slice(1)
      if (typeof EMOJI_DATA !== 'undefined') {
        let emojiCount = 0
        for (const entry of EMOJI_DATA) {
          if (entry.name.includes(emojiSearch)) {
            matches.push({
              name: entry.emoji,
              url: '',
              provider: 'emoji',
              emojiName: entry.name,
            })
            if (++emojiCount >= 10) break
          }
        }
      }
    }

    // Sort: channel (tier 0) > inventory (tier 1) > global/other (tier 2) > emoji
    // Matches input.js tier ordering (channel-first — reversed 2026-06-13)
    const _tier = (p) => (p === 'channel' ? 0 : p === 'inventory' ? 1 : p === 'emoji' ? 3 : 2)
    matches.sort((a, b) => {
      const at = _tier(a.provider),
        bt = _tier(b.provider)
      if (at !== bt) return at - bt
      return (a.emojiName || a.name).localeCompare(b.emojiName || b.name)
    })

    return matches
  }

  // Show TAB COMPLETION preview popup (different from hover preview!)
  function showEmotePreview(emote, currentIndex, totalCount) {
    const isTwitch = window.location.hostname.includes('twitch.tv')
    let preview = document.getElementById('heatsync-tab-preview')

    if (!preview) {
      preview = document.createElement('div')
      preview.id = 'heatsync-tab-preview'
      preview.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 20px;
      background: #000000;
      border: 1px solid rgba(255,0,0,0.4);
      padding: 4px 8px;
      z-index: 10001;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      pointer-events: none;
      font-family: Inter, -apple-system, sans-serif;
    `

      const counter = document.createElement('div')
      counter.id = 'heatsync-tab-counter'
      counter.style.cssText = 'color: #fff; font-size: 11px; font-weight: bold;'

      const img = document.createElement('img')
      img.id = 'heatsync-tab-img'
      img.style.cssText = 'max-width: 64px; max-height: 28px;'

      const name = document.createElement('div')
      name.id = 'heatsync-tab-name'
      name.style.cssText = 'color: #808080; font-size: 11px;'

      const hint = document.createElement('div')
      hint.id = 'heatsync-tab-hint'
      hint.style.cssText = 'color: #9146ff; font-size: 10px; margin-left: 4px;'

      preview.appendChild(counter)
      preview.appendChild(img)
      preview.appendChild(name)
      preview.appendChild(hint)
      document.body.appendChild(preview)
    }

    const counter = preview.querySelector('#heatsync-tab-counter')
    const img = preview.querySelector('#heatsync-tab-img')
    const nameEl = preview.querySelector('#heatsync-tab-name')
    const hint = preview.querySelector('#heatsync-tab-hint')

    if (counter) counter.textContent = `${currentIndex}/${totalCount}`
    if (emote.provider === 'emoji') {
      if (img) {
        img.style.display = 'none'
      }
      if (nameEl) nameEl.textContent = `${emote.name} :${emote.emojiName}:`
    } else {
      if (img) {
        img.src = emote.url
        img.style.display = ''
      }
      if (nameEl) nameEl.textContent = emote.name
    }
    if (hint) hint.textContent = isTwitch ? 'Ctrl+V' : ''

    preview.style.display = 'flex'
  }

  // Hide TAB COMPLETION preview popup
  function hideEmotePreview() {
    const preview = document.getElementById('heatsync-tab-preview')
    if (preview) preview.style.display = 'none'
  }

  // FFZ Inline Tab Completion style - intercepts Tab, uses setValue()
  // Based on https://github.com/FrankerFaceZ/Add-Ons/blob/master/src/inline-tab-completion/index.jsx
  function injectTwitchAutocompleteHook() {
    // MV3: autocomplete-hook.js is loaded via manifest in MAIN world
    // We just need to create the data bridge div
    if (document.getElementById('heatsync-emote-bridge')) return

    const bridge = document.createElement('div')
    bridge.id = 'heatsync-emote-bridge'
    bridge.style.display = 'none'
    bridge.dataset.emotes = '[]'
    document.documentElement.appendChild(bridge)

    log(' Emote bridge created for autocomplete-hook.js')
  }

  // Update emotes in the bridge for the injected script
  let _emoteBridgeDebounce = null
  let _bridgeVersion = 0
  function updateEmoteBridgeImmediate() {
    // The bridge feeds the native Slate-input autocomplete (hidden under the overlay).
    // Skip rebuilding it when the overlay is up — this is separate from the LIVE
    // sub-emote export (autocomplete-hook.js exportNativeEmotes), which we keep.
    if (isOverlayActive()) return
    const bridge = document.getElementById('heatsync-emote-bridge')
    if (!bridge) return
    // Combine all emote sources: personal inventory + global + channel
    const allEmotes = []
    const seen = new Set()
    // Don't leak blocked emotes into the native tab-complete bridge. The kick/YT
    // hooks already filter blocked; twitch was the gap — a blocked emote could be
    // tab-completed and sent. Block by name (all tiers) or by specific hash.
    const isBridgeBlocked = (e) => localBlockedEmoteNames.has(e.name) || (e.hash && blockedEmotes.has(e.hash))

    // tier rides on each emote (0=channel, 1=own inventory, 2=global) so the MAIN-world
    // Twitch autocomplete hook can rank channel > own > global. Channel emotes are
    // emitted FIRST so first-seen dedup keeps the CHANNEL image for a name you also
    // own (e.g. nl_kripp's BTTV "SoupTime" over an owned same-named 7TV emote) — the
    // channel emote is what actually renders in this channel.
    // Channel emotes (highest priority). source rides along so the autocomplete
    // hook can show WHO sees each emote (7tv/bttv users vs heatsync-only).
    for (const e of channelEmotes) {
      if (isBridgeBlocked(e)) continue
      if (!seen.has(e.name)) {
        seen.add(e.name)
        allEmotes.push({ name: e.name, hash: e.hash, url: e.url, zeroWidth: e.zeroWidth, tier: 0, source: e.source })
      }
    }

    // Personal inventory
    for (const e of emoteInventory) {
      if (isBridgeBlocked(e)) continue
      if (!seen.has(e.name)) {
        seen.add(e.name)
        allEmotes.push({ name: e.name, hash: e.hash, url: e.url, zeroWidth: e.zeroWidth, tier: 1, source: e.source })
      }
    }

    // Global emotes
    for (const e of globalEmotes) {
      if (isBridgeBlocked(e)) continue
      if (!seen.has(e.name)) {
        seen.add(e.name)
        allEmotes.push({ name: e.name, hash: e.hash, url: e.url, zeroWidth: e.zeroWidth, tier: 2, source: e.source })
      }
    }

    log(' Updating emote bridge:', allEmotes.length, 'total emotes')
    bridge.dataset.emotes = JSON.stringify(allEmotes)
    bridge.dataset.version = String(++_bridgeVersion)
    // Dispatched on `document`, NOT on the bridge element. autocomplete-hook.js
    // listens for this from the MAIN world, and it is registered in an EARLIER
    // content_scripts group than content.js — so at the moment it attaches its
    // listener the bridge div does not exist yet, and a listener on the element
    // could never fire. `document` is shared across worlds and present from
    // document_start, so the ordering stops mattering. Locked by
    // tests/emote-bridge-event-target.test.js.
    document.dispatchEvent(new Event('heatsync-emotes-updated'))

    // Populate window.__heatsyncEmoteUrls for early-inject interceptor via postMessage
    const urlMap = {}
    for (const e of allEmotes) {
      if (e.hash && e.url) urlMap[e.hash] = e.url
    }
    // Use postMessage to communicate with MAIN world (early-inject.js)
    window.postMessage({ type: 'heatsync-url-map', urlMap }, location.origin)
  }

  function updateEmoteBridge() {
    if (_emoteBridgeDebounce) {
      cleanup.clearTimeout(_emoteBridgeDebounce)
      _emoteBridgeDebounce = null
    }
    _emoteBridgeDebounce = cleanup.setTimeout(() => updateEmoteBridgeImmediate(), 100)
  }

  // NOTE: injectTwitchAutocompleteHook() is called earlier, before loadInventory()

  // Complete emote in input (Kick only - textarea)
  // NOTE: Twitch uses FFZ-style native autocomplete, not this function
  function completeEmoteInInput(element, emote, startPos) {
    const emoteName = emote.name
    const wordToReplace = tabCompleteState.lastInserted || tabCompleteState.originalWord || ''

    const replaceLen = wordToReplace.length
    const textToInsert = `${emoteName} `

    if (element.isContentEditable) {
      // Kick: contenteditable div.editor-input
      const sel = window.getSelection()
      const text = element.textContent || ''
      const beforeText = text.substring(0, startPos)
      const afterText = text.substring(startPos + replaceLen)
      element.textContent = beforeText + textToInsert + afterText
      const newPos = startPos + textToInsert.length
      const newNode = element.firstChild
      if (newNode) {
        const range = document.createRange()
        range.setStart(newNode, Math.min(newPos, newNode.length))
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      // Fallback for textarea
      const beforeText = element.value.substring(0, startPos)
      const afterText = element.value.substring(startPos + replaceLen)
      element.value = beforeText + textToInsert + afterText
      element.dispatchEvent(new Event('input', { bubbles: true }))
      const newCursorPos = startPos + textToInsert.length
      element.setSelectionRange(newCursorPos, newCursorPos)
    }
    tabCompleteState.lastInserted = textToInsert
  }

  // Reset tab completion state
  function resetTabComplete() {
    tabCompleteState.active = false
    tabCompleteState.matches = []
    tabCompleteState.index = 0
    tabCompleteState.lastInserted = ''
    tabCompleteState.startAnchor = null
    hideEmotePreview()
  }

  // Setup tab completion on chat input
  // NOTE: For Twitch, we use FFZ-style hooking into native autocomplete (see injectTwitchAutocompleteHook)
  // This custom handler is only for Kick (which uses regular textarea)
  function setupTabCompletion() {
    // Only run on Kick - Twitch uses native autocomplete with our hooked emotes
    if (!window.location.hostname.includes('kick.com')) {
      log(' Skipping custom tab handler - using Twitch native autocomplete')
      return
    }

    // Remove old handler if extension reloaded (DOM persists, JS context is fresh)
    if (window._heatsyncTabHandler) {
      document.removeEventListener('keydown', window._heatsyncTabHandler, true)
    }

    log(' ✅ Tab completion handler installed for Kick')

    const findChatInput = () => {
      return (
        document.querySelector('div.editor-input') || // Kick
        document.querySelector('.chat-input textarea')
      )
    }

    // Document-level capture to intercept Tab before Twitch
    const tabHandler = (e) => {
      const chatInput = findChatInput()
      if (!chatInput) return

      // Only handle if focus is in/near chat input
      const activeEl = document.activeElement
      const isInChat =
        activeEl === chatInput ||
        chatInput.contains(activeEl) ||
        activeEl?.closest('[data-a-target="chat-input"]') ||
        activeEl?.closest('.chat-input')

      if (!isInChat) return

      // Don't capture when Twitch modals are open (predictions, polls, rewards, dialogs)
      if (
        document.querySelector(
          '[class*="prediction"], [class*="reward-queue"], [role="dialog"], [class*="poll-overlay"]',
        )
      )
        return

      // Handle active autocomplete navigation
      if (tabCompleteState.active && tabCompleteState.matches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          tabCompleteState.index = (tabCompleteState.index + 1) % tabCompleteState.matches.length
          const emote = tabCompleteState.matches[tabCompleteState.index]
          showEmotePreview(emote, tabCompleteState.index + 1, tabCompleteState.matches.length)
          completeEmoteInInput(chatInput, emote, tabCompleteState.startPos)
          return
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          tabCompleteState.index =
            tabCompleteState.index <= 0 ? tabCompleteState.matches.length - 1 : tabCompleteState.index - 1
          const emote = tabCompleteState.matches[tabCompleteState.index]
          showEmotePreview(emote, tabCompleteState.index + 1, tabCompleteState.matches.length)
          completeEmoteInInput(chatInput, emote, tabCompleteState.startPos)
          return
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          resetTabComplete()
          return
        } else if (e.key === 'Enter') {
          // Confirm selection and reset
          resetTabComplete()
          // Don't prevent default - let Enter submit the message
          return
        }
      }

      // Tab key - start or cycle autocomplete
      if (e.key === 'Tab') {
        // Prevent re-entry during completion
        if (tabCompleteState.completing) {
          e.preventDefault()
          e.stopPropagation()
          return
        }

        e.preventDefault()
        e.stopPropagation()

        log(' 🎯 Tab pressed, active:', tabCompleteState.active, 'matches:', tabCompleteState.matches.length)

        // If cycling through existing matches - just cycle, don't re-read input
        if (tabCompleteState.active && tabCompleteState.matches.length > 0) {
          tabCompleteState.completing = true
          const len = tabCompleteState.matches.length
          tabCompleteState.index = (tabCompleteState.index + (e.shiftKey ? len - 1 : 1)) % len
          const emote = tabCompleteState.matches[tabCompleteState.index]
          log(' Cycling to:', emote.name, '(', tabCompleteState.index + 1, '/', len, ')')
          showEmotePreview(emote, tabCompleteState.index + 1, len)
          completeEmoteInInput(chatInput, emote, tabCompleteState.startPos)
          tabCompleteState.completing = false
          return
        }

        // New autocomplete session - read input state
        const { text, cursorPos } = getInputState(chatInput)
        log(' Input state:', { text: text.substring(0, 50), cursorPos, len: text.length })
        const textBeforeCursor = text.substring(0, cursorPos)
        const lastSpaceIndex = textBeforeCursor.lastIndexOf(' ')
        const wordStart = lastSpaceIndex + 1
        const currentWord = textBeforeCursor.substring(wordStart)
        const partialWord = currentWord.trim()
        log(' Partial word:', JSON.stringify(partialWord), 'from', JSON.stringify(currentWord))

        if (!partialWord) {
          log(' No partial word, aborting')
          return
        }

        // Find matches
        const matches = findEmoteMatches(partialWord)
        log(` New session: "${partialWord}" → ${matches.length} matches`)

        if (matches.length > 0) {
          tabCompleteState.completing = true
          tabCompleteState.active = true
          tabCompleteState.matches = matches
          tabCompleteState.index = 0
          tabCompleteState.startPos = wordStart
          tabCompleteState.originalWord = partialWord

          const emote = matches[0]
          showEmotePreview(emote, 1, matches.length)
          completeEmoteInInput(chatInput, emote, wordStart)
          tabCompleteState.completing = false
        }
      } else if (!['ArrowUp', 'ArrowDown', 'Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) {
        // Any other key (except modifiers) resets autocomplete
        if (tabCompleteState.active) {
          resetTabComplete()
        }
      }
    }

    // Store reference for cleanup on extension reload
    window._heatsyncTabHandler = tabHandler
    document.addEventListener('keydown', tabHandler, { capture: true, signal }) // CAPTURE phase - runs before Twitch handlers

    log(' Tab completion ready')
  }

  // Intercept message input to detect emote usage
  let interceptRetryCount = 0
  // Message history — up/down arrow recalls previously sent messages (like terminal/IRC)
  const messageHistory = []
  const MESSAGE_HISTORY_MAX = 50
  let historyIndex = -1
  let historyDraft = '' // saves current draft when entering history

  function interceptMessageSending() {
    // Only run on Twitch/Kick
    if (!window.location.hostname.includes('twitch.tv') && !window.location.hostname.includes('kick.com')) {
      return
    }

    const chatInput =
      document.querySelector('[data-a-target="chat-input"]') || // Twitch
      document.querySelector('div.editor-input') || // Kick
      document.querySelector('textarea')

    if (!chatInput) {
      if (++interceptRetryCount > 30) return
      log(' ⏳ Chat input not found, retrying in 1s...')
      cleanup.setTimeout(interceptMessageSending, 1000)
      return
    }
    interceptRetryCount = 0

    // Prevent stacking listeners on SPA re-navigation
    if (chatInput._hsInterceptBound) return
    chatInput._hsInterceptBound = true

    log(' 📝 Found chat input:', chatInput.tagName, chatInput.className)

    function getInputText() {
      return (chatInput.isContentEditable ? chatInput.innerText : chatInput.value || chatInput.innerText || '').trim()
    }

    function setInputText(text) {
      chatInput.focus()
      if (chatInput.isContentEditable) {
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, text)
      } else {
        chatInput.value = text
        chatInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    chatInput.addEventListener(
      'keydown',
      (e) => {
        // Message history navigation (ArrowUp/ArrowDown or vi j/k via synthetic events)
        if (
          (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          !e.shiftKey &&
          !e.ctrlKey &&
          !e.altKey &&
          messageHistory.length > 0
        ) {
          const currentText = getInputText()
          // Only activate history when input is empty or already browsing history
          if (
            historyIndex >= 0 ||
            (e.key === 'ArrowUp' && currentText.length === 0) ||
            (e.key === 'ArrowUp' && messageHistory.includes(currentText))
          ) {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'ArrowUp') {
              if (historyIndex < 0) historyDraft = currentText
              historyIndex = Math.min(historyIndex + 1, messageHistory.length - 1)
            } else {
              historyIndex--
            }
            if (historyIndex < 0) {
              historyIndex = -1
              setInputText(historyDraft)
            } else {
              setInputText(messageHistory[historyIndex])
            }
            return
          }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          // textarea uses .value, contenteditable uses .innerText
          const message = (
            chatInput.isContentEditable ? chatInput.innerText : chatInput.value || chatInput.innerText || ''
          ).trim()
          log(' 📤 Enter pressed, message:', message)
          if (!message) return

          // Push to message history (dedup consecutive, cap at max)
          if (messageHistory[0] !== message) {
            messageHistory.unshift(message)
            if (messageHistory.length > MESSAGE_HISTORY_MAX) messageHistory.length = MESSAGE_HISTORY_MAX
          }
          historyIndex = -1

          // Check if message contains any of MY emotes (use cached regex from createEmoteRegex)
          emoteInventory.forEach((emote) => {
            if (!emote._outgoingRegex) {
              emote._outgoingRegex = new RegExp(`\\b${escapeRegex(emote.name)}\\b`)
            }
            if (emote._outgoingRegex.test(message)) {
              // Notify background script to broadcast
              safeSendMessage({
                type: 'emote_sent',
                emoteName: emote.name,
                emoteHash: emote.hash,
              })
                .then((response) => {
                  if (response?.success) {
                    log(' ✅ Emote broadcast sent successfully')
                  } else {
                    warn(' ⚠️ Emote broadcast FAILED:', response)
                  }
                })
                .catch((err) => {
                  if (!extensionContextValid) return
                  // A real (non-teardown) failure must not vanish silently —
                  // sibling handlers on this path log/toast (see ~10807).
                  warn(' ⚠️ Emote broadcast error:', err)
                })
            }
          })
        }
      },
      { signal },
    )

    log(' Message interceptor attached')
  }

  // SPA navigation handler — event-driven via early-inject-main.js history hooks
  let lastChatUrl = location.href
  function handleNavigation() {
    if (location.href === lastChatUrl) return
    log(' 🔄 URL changed from', lastChatUrl, 'to', location.href)
    lastChatUrl = location.href
    channelEmotes = []
    currentChannelOwner = null
    msgCacheBuffer = []
    msgCacheIds.clear()
    subTenureMap.clear()
    originalMessageBodies.clear()
    invalidateChatContainerCache()
    allEmotesDirty = true
    rebuildEmoteMapIfDirty()
    detectAndJoinChannel()
    setupAutoClaimPoints()
    watchRetryCount = 0
    interceptRetryCount = 0
    cleanup.setTimeout(
      () => {
        watchForNewMessages()
        setupUsernameColoringObserver()
        interceptMessageSending()
        if (emoteInventory.length > 0 || globalEmotes.length > 0) {
          processExistingMessages()
        }
        // Backfill new channel after native messages load
        cleanup.setTimeout(() => backfillChatHistory(), 500)
      },
      500,
      'url-change-rescan',
    )
  }

  // Primary: instant notification from MAIN world history hooks
  window.addEventListener(
    'message',
    (event) => {
      if (event.origin !== location.origin) return
      // Same-frame only: legit senders are our MAIN-world hooks in THIS window.
      // The origin check alone lets same-origin child frames (popout/clip embeds)
      // trigger destructive handlers (clear_history, extension_reload) — require
      // the message to come from our own window, not a sub-frame.
      if (event.source !== window) return
      if (event.data?.type === 'heatsync-nav') handleNavigation()
      // heatsync-clear-history window hook removed: no internal MAIN-world caller;
      // clear_history is now triggered only from extension popup via chrome.runtime.
      // Dev/automation hook: extension reload, gated on per-session nonce so rogue
      // page scripts can't trigger it without first observing the init-nonce exchange.
      // Usage (dev console, after capturing nonce from heatsync-init-nonce message):
      //   window.postMessage({ type: 'heatsync-reload-extension', nonce: <captured> }, location.origin)
      if (event.data?.type === 'heatsync-reload-extension') {
        // Two accept paths:
        //  • nonce — any build; gated on the per-session nonce a rogue page can't
        //    observe (the original hook).
        //  • dev build — locally-built (unminified) bundles ALSO accept a
        //    nonce-less reload so remote automation (ssh-from-phone dev) can reload
        //    without a manual chrome://extensions click. __HS_DEV_BUILD__ is
        //    replaced with `false` by esbuild define in every packaged/store build
        //    (see build.js minifyDist), so this relaxation is compiled out for real
        //    users — no host page can ever reload a published extension.
        const nonce = window.HS?.getMainWorldNonce?.()
        const nonceOk = !!nonce && event.data.nonce === nonce
        const devBuild = typeof __HS_DEV_BUILD__ !== 'undefined' ? __HS_DEV_BUILD__ : true
        if (!nonceOk && !devBuild) return
        const now = Date.now()
        // Tighter spacing on dev so back-to-back iteration reloads aren't silently
        // swallowed; the 30s guard still throttles the nonce/prod path.
        if (now - _lastExtReloadMs < (devBuild ? 3000 : 30000)) return
        _lastExtReloadMs = now
        safeSendMessage({ type: 'extension_reload' }).catch(() => {})
      }
      // Self twitch ID resolved by early-inject MAIN world via currentUser GQL —
      // critical for popout chat where twilight.user localStorage is null and
      // every other detection path fails.
      if (
        event.data?.type === 'heatsync-self-twitch-id' &&
        event.data.twitchId &&
        /^\d+$/.test(String(event.data.twitchId))
      ) {
        const expected = window.HS?.getMainWorldNonce?.()
        if (!expected || event.data.nonce !== expected) return
        if (!_selfTwitchIdRegistered) {
          _selfTwitchIdRegistered = true
          if (event.data.login && !cachedUsername) cachedUsername = String(event.data.login).toLowerCase()
          safeSendMessage({ type: 'register_self_twitch_id', twitchId: String(event.data.twitchId) })
        }
      }
    },
    { signal },
  )

  // Read self twitch ID from documentElement dataset if MAIN world already
  // stamped it before this listener attached (race on fast loads).
  try {
    const stampedSelfId = document.documentElement.dataset.hsSelfTwitchId
    const stampedSelfLogin = document.documentElement.dataset.hsSelfTwitchLogin
    if (stampedSelfId && /^\d+$/.test(stampedSelfId) && !_selfTwitchIdRegistered) {
      _selfTwitchIdRegistered = true
      if (stampedSelfLogin && !cachedUsername) cachedUsername = stampedSelfLogin.toLowerCase()
      safeSendMessage({ type: 'register_self_twitch_id', twitchId: stampedSelfId })
    }
  } catch {}

  // Fallback: polling in case MAIN world script didn't load (e.g. Firefox edge cases)
  cleanup.setIntervalIfVisible(() => handleNavigation(), 5000)

  // Check if observed container was replaced by React (e.g. after sending a message)
  // Always compare against live DOM — old container may still be isConnected but orphaned from React tree
  cleanup.setIntervalIfVisible(() => {
    const freshContainer = findChatContainer()
    if (freshContainer && freshContainer !== observedContainer) {
      log(' 🔄 Chat container changed, re-hooking observer')
      watchForNewMessages()
    } else if (!freshContainer && observedContainer && !observedContainer.isConnected) {
      log(' ⚠️ Chat container removed from DOM, clearing observer')
      if (messageObserver) {
        messageObserver.disconnect()
        cleanup.untrackObserver(messageObserver)
        messageObserver = null
      }
      observedContainer = null
    }
  }, 2000)

  // Periodic re-scan to catch messages that might have been missed (10s — observer handles most)
  cleanup.setIntervalIfVisible(() => {
    if (emoteInventory.length > 0 || globalEmotes.length > 0) {
      processExistingMessages()
    }
  }, 10000)

  // Flush message cache on page hide/unload so we don't lose the last 5s.
  // pagehide+visibilitychange are more reliable than beforeunload on mobile/bfcache.
  function flushMsgCacheNow() {
    if (msgCacheSaveTimer) {
      clearTimeout(msgCacheSaveTimer)
      msgCacheSaveTimer = null
    }
    saveMsgCache()
  }
  window.addEventListener('pagehide', flushMsgCacheNow, { signal })
  window.addEventListener('beforeunload', flushMsgCacheNow, { signal })
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') flushMsgCacheNow()
      // Toggle the body class our injected stylesheet uses to pause
      // CSS animations (hs-heat-breathe and similar) while hidden.
      document.body?.classList.toggle('hs-ext-hidden', document.hidden)
    },
    { signal },
  )
  // Apply initial state.
  if (document.hidden) document.body?.classList.add('hs-ext-hidden')

  // Auto-claim Twitch channel points bonus
  let autoClaimObserver = null
  let autoClaimEnabled = true
  let autoClaimGen = 0

  function setupAutoClaimPoints() {
    const gen = ++autoClaimGen
    if (autoClaimObserver) {
      autoClaimObserver.disconnect()
      cleanup.untrackObserver(autoClaimObserver)
      autoClaimObserver = null
    }
    if (!autoClaimEnabled || !location.hostname.includes('twitch.tv')) return

    function tryClaimBonus(container) {
      if (!container) return
      // Positively match the claim button — locale-independent class marker first,
      // English aria-label as fallback. Never click unrecognized buttons.
      const marker = container.querySelector('[class*="claimable"], [class*="click-claim"]')
      const btn =
        (marker && (marker.closest('button') || marker.querySelector('button') || marker)) ||
        container.querySelector('button[aria-label*="claim" i]')
      if (!btn) return
      if (btn.closest('[role="dialog"]') || btn.closest('[role="menu"]')) return
      log(' 🎁 Auto-claiming channel points bonus')
      btn.click()
    }

    let attachAttempts = 0
    function attachObserver() {
      // Stale-cycle guard: a nav re-runs setupAutoClaimPoints; pending retry
      // timers from the old cycle must not attach a second observer.
      if (gen !== autoClaimGen || !autoClaimEnabled) return
      const container = document.querySelector('[data-test-selector="community-points-summary"]')
      if (!container) {
        // No permanent give-up — handleNavigation re-arms on SPA nav, so this
        // cap only bounds retries within one page view (e.g. directory pages).
        if (++attachAttempts >= 20) return
        cleanup.setTimeout(attachObserver, 3000)
        return
      }

      // Check immediately in case bonus is already showing
      tryClaimBonus(container)

      autoClaimObserver = cleanup.trackObserver(
        new MutationObserver(() => {
          tryClaimBonus(container)
        }),
      )
      autoClaimObserver.observe(container, { childList: true, subtree: true })
      log(' 💰 Auto-claim channel points observer active')
    }

    attachObserver()
  }
  // Load auto-claim setting and start. Default ON — multichat (main.js) seeds
  // hs_auto_claim_points:true on first run, so we follow that. Off only if the
  // user explicitly toggled it off (storage === false).
  ;(async function loadAutoClaimSetting() {
    try {
      const stored = await chrome.storage.local.get('hs_auto_claim_points')
      autoClaimEnabled = stored.hs_auto_claim_points !== false
    } catch {
      /* default on */
    }
    setupAutoClaimPoints()
  })()

  // React to setting changes
  function _onAutoClaimStorageChanged(changes) {
    if (changes.hs_auto_claim_points) {
      autoClaimEnabled = changes.hs_auto_claim_points.newValue !== false
      setupAutoClaimPoints()
    }
  }
  chrome.storage.onChanged.addListener(_onAutoClaimStorageChanged)

  // Initialize
  if (window.HS?.initMainWorldNonce) window.HS.initMainWorldNonce() // secure MAIN world GQL/Helix handlers

  // Emote-layer subsystem gates — ui_settings.subsystems (set in multichat
  // settings → system → subsystems; default ON). A gated-off subsystem never
  // registers its observers/handlers. emote-render and tab-complete apply on
  // reload and are hydrated once below, before bootEmoteLayer.
  //
  // right-click-block has NO registry entry, so nothing can ever set it false
  // and its gate is permanently on. The user-facing control for that behaviour
  // is `rightClickBlockMode` (instant/menu/off) in heatsync-button.js — a
  // separate setting. Kept as the live-update shape in case it is ever
  // promoted; tests/subsystem-switches-enforced.js records it as the one
  // known gate id with no switch behind it.
  const HS_GATES = { 'emote-render': true, 'tab-complete': true, 'right-click-block': true }
  function hsGateOn(id) {
    return HS_GATES[id] !== false
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.ui_settings) return
    const subs = changes.ui_settings.newValue?.subsystems
    if (subs) HS_GATES['right-click-block'] = subs['right-click-block'] !== false
  })

  function bootEmoteLayer() {
    setupEmoteClickHandlers()
    detectAndJoinChannel()
    setupMessageContextMenu()
    if (hsGateOn('emote-render')) watchForNewMessages()
    interceptMessageSending()
    if (hsGateOn('tab-complete')) {
      setupTabCompletion()
    } else {
      // Kick hook shares this ISOLATED window; Twitch hook is MAIN-world and
      // listens for the gate message. Both tear down via their lifecycles.
      try {
        window.__heatsyncKickAcLifecycle?.abort()
      } catch (_) {}
      try {
        window.postMessage({ type: 'heatsync-gate-tab-complete-off' }, location.origin)
      } catch (_) {}
    }
    log(' Extension loaded')

    if (!hsGateOn('emote-render')) return
    // Process any chat history that's already loaded in the DOM
    // (Twitch loads recent messages on page load, but we need to process them with emotes)
    cleanup.setTimeout(() => {
      log(' Processing chat history from page load...')
      const channel = getPageChannel()

      // Restore cached messages FIRST for instant render (before robotty backfill)
      if (channel) {
        initMsgCache(channel)
        const chatContainer = findChatContainer()
        if (chatContainer) {
          const restored = restoreMsgCache(channel, chatContainer)
          if (restored > 0) processExistingMessages()
        }
      }

      processExistingMessages()
      setupUsernameColoringObserver() // Start persistent username coloring
      // Backfill after a short delay so native Twitch messages are loaded for dedup
      cleanup.setTimeout(() => backfillChatHistory(), 500)
    }, 1000)
  }

  chrome.storage.sync.get('ui_settings', (d) => {
    try {
      const subs = d?.ui_settings?.subsystems || {}
      for (const k in HS_GATES) if (subs[k] === false) HS_GATES[k] = false
    } catch (_) {}
    bootEmoteLayer()
  })

  // Expose the recency list for the Kick autocomplete hook (ISOLATED, shares this
  // window). Twitch's hook is MAIN-world and reads the DOM bridge instead.
  window.heatsyncGetRecentChatters = buildRecentChatterList
})()
