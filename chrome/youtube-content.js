// YouTube Live Chat content script — message extraction, emote overlay, autocomplete, send relay
// Runs in the live_chat iframe. Lib-bundled at build time (CONFIG, cleanup, utils, browser-api available).
;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[hs-youtube]') : () => {}

  const ac = new AbortController()
  const signal = ac.signal

  // Skip chat replays (VODs) — only process live chat
  if (window.location.pathname.includes('live_chat_replay')) return

  // Extract videoId from URL (?v= param or /live_chat?v=)
  const videoId = new URLSearchParams(window.location.search).get('v') || ''

  // Context validity tracking
  let extensionContextValid = true
  async function safeSendMessage(message) {
    if (!extensionContextValid) return null
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (err) {
      if (err.message?.includes('context invalidated')) extensionContextValid = false
      return null
    }
  }

  // ─── Emote display size ──────────────────────────────────────────────────────
  // Mirrors content.js: the `hs_emote_size` setting ("native chat emote scale",
  // 1x/2x/4x) drives `--hs-emote-height`, which .heatsync-emote-yt reads. content.js
  // only runs on twitch/kick, so YT must set the var itself or emotes would ignore
  // the user's size choice and stay locked at 28px.
  const HS_EMOTE_BASE_PX = 28
  function applyEmoteSize(size) {
    const n = parseFloat(size) || 1
    document.documentElement.style.setProperty('--hs-emote-height', `${HS_EMOTE_BASE_PX * n}px`)
  }

  // ─── Emote Inventory ─────────────────────────────────────────────────────────

  let emoteMap = new Map() // name → { name, url, hash, ... }
  let blockedEmotes = new Set()
  let inventoryLoaded = false

  let channelEmotesByOwner = {} // { ownerName: emote[] } — populated from background broadcasts

  function rebuildEmoteMap(inventory, globals) {
    const map = new Map()
    // tier rides on each emote (0=channel/1=own/2=global) so findEmoteMatches ranks
    // channel > own > global — a channel emote beats own/global on a closer name match.
    // Channel emotes are written LAST so the map keeps the CHANNEL image for a name
    // you also own (the channel emote is what renders in this channel).
    // Globals first (lowest priority) — tier 2
    if (globals) {
      for (const e of globals) {
        if (e?.name && !blockedEmotes.has(e.hash || e.name)) {
          e._ytTier = 2
          map.set(e.name, e)
        }
      }
    }
    // Inventory — tier 1
    if (inventory) {
      for (const e of inventory) {
        if (e?.name && !blockedEmotes.has(e.hash || e.name)) {
          e._ytTier = 1
          map.set(e.name, e)
        }
      }
    }
    // Channel emotes (BTTV/FFZ/7TV/Twitch sub) override — tier 0
    for (const ownerEmotes of Object.values(channelEmotesByOwner)) {
      if (!Array.isArray(ownerEmotes)) continue
      for (const e of ownerEmotes) {
        if (e?.name && !blockedEmotes.has(e.hash || e.name)) {
          e._ytTier = 0
          map.set(e.name, e)
        }
      }
    }
    emoteMap = map
    log('emote map rebuilt:', map.size, 'emotes')
  }

  async function loadEmoteInventory() {
    try {
      // Fast path: storage
      const stored = await chrome.storage.local.get([
        'emote_inventory',
        'global_emotes',
        'blocked_emotes',
        'channel_emotes_map',
      ])
      if (stored.blocked_emotes) blockedEmotes = new Set(stored.blocked_emotes)
      if (stored.channel_emotes_map && typeof stored.channel_emotes_map === 'object') {
        channelEmotesByOwner = stored.channel_emotes_map
      }
      if (stored.emote_inventory || stored.global_emotes) {
        rebuildEmoteMap(stored.emote_inventory || [], stored.global_emotes || [])
        inventoryLoaded = true
      }
      // Background fallback
      if (!inventoryLoaded) {
        const resp = await safeSendMessage({ type: 'get_inventory' })
        if (resp?.emotes) {
          rebuildEmoteMap(resp.emotes, stored.global_emotes || [])
          inventoryLoaded = true
        }
      }
    } catch (e) {
      log('emote load failed:', e.message)
    }
  }

  // Listen for inventory updates from background
  const ytInventoryListener = (msg, _sender, sendResponse) => {
    if (msg.type === 'inventory_update' && msg.emotes) {
      chrome.storage.local
        .get(['global_emotes'])
        .then((stored) => {
          rebuildEmoteMap(msg.emotes, stored.global_emotes || [])
        })
        .catch((e) => log('storage read failed (inventory_update):', e?.message))
    } else if (msg.type === 'global_emotes_update' && msg.emotes) {
      chrome.storage.local
        .get(['emote_inventory'])
        .then((stored) => {
          rebuildEmoteMap(stored.emote_inventory || [], msg.emotes)
        })
        .catch((e) => log('storage read failed (global_emotes_update):', e?.message))
    } else if (msg.type === 'blocked_update' && Array.isArray(msg.blocked)) {
      blockedEmotes = new Set(msg.blocked)
      chrome.storage.local
        .get(['emote_inventory', 'global_emotes'])
        .then((stored) => {
          rebuildEmoteMap(stored.emote_inventory || [], stored.global_emotes || [])
        })
        .catch((e) => log('storage read failed (blocked_update):', e?.message))
    } else if (msg.type === 'channel_emotes_update' && Array.isArray(msg.emotes) && msg.channelOwner) {
      channelEmotesByOwner[msg.channelOwner] = msg.emotes
      // Cap to most-recent 20 owners — long sessions with many channel switches
      // would otherwise grow this object forever.
      const keys = Object.keys(channelEmotesByOwner)
      if (keys.length > 20) {
        for (let i = 0; i < keys.length - 20; i++) delete channelEmotesByOwner[keys[i]]
      }
      chrome.storage.local
        .get(['emote_inventory', 'global_emotes'])
        .then((stored) => {
          rebuildEmoteMap(stored.emote_inventory || [], stored.global_emotes || [])
        })
        .catch((e) => log('storage read failed (channel_emotes_update):', e?.message))
    } else if (msg.type === 'youtube_send_relay') {
      // When awaitConfirm is set (server-relay path), wait for the message to
      // appear in the chat list before acking. Either way, forward the real
      // relay result — never report a dropped/failed send as "sent".
      if (msg.awaitConfirm) {
        handleSendRelay(msg).then((result) => {
          try {
            sendResponse(result || { ok: false, error: 'no_result' })
          } catch {}
        })
        return true
      }
      handleSendRelay(msg)
        .then((result) => {
          try {
            sendResponse(result || { ok: false, error: 'no_result' })
          } catch {}
        })
        .catch((e) => {
          try {
            sendResponse({ ok: false, error: e?.message || 'send_failed' })
          } catch {}
        })
      return true
    } else if (msg.type === 'youtube_insert_emote') {
      handleInsertEmote(msg.emoteName)
      sendResponse({ ok: true })
      return true
    } else if (msg.type === 'youtube_mod_relay') {
      handleYtModAction(msg)
        .then((result) => {
          try {
            sendResponse(result || { ok: false, error: 'no_result' })
          } catch {}
        })
        .catch((e) => {
          try {
            sendResponse({ ok: false, error: e?.message || 'yt_mod_failed' })
          } catch {}
        })
      return true
    } else if (msg.type === 'youtube_bridge_ping') {
      // Background polls this on an auto-opened live_chat bridge tab to learn
      // when it's actually ready to send: chat input present AND not disabled.
      // A logged-out / members-only / slow-mode box is present-but-disabled, so
      // we report both flags and never claim "ready" until the send would land.
      try {
        const inputRenderer = document.querySelector('yt-live-chat-text-input-field-renderer')
        const input = inputRenderer?.querySelector('div#input[contenteditable]')
        const disabled = input ? input.getAttribute('aria-disabled') === 'true' : false
        // Restricted participation (subscribers-only / members-only) removes
        // the input entirely — report the reason so background can fail fast
        // with it instead of polling into a 12s bridge_timeout.
        const restrictedMsg = input
          ? null
          : document
              .querySelector('yt-live-chat-restricted-participation-renderer')
              ?.querySelector('#message, yt-formatted-string')
              ?.textContent?.trim() || null
        sendResponse({ ok: true, hasInput: !!input, disabled, restrictedMsg })
      } catch (e) {
        try {
          sendResponse({ ok: false, error: e?.message || 'ping_failed' })
        } catch {}
      }
      return true
    }
  }
  chrome.runtime.onMessage.addListener(ytInventoryListener)
  // Live-apply the emote-size choice (hs_emote_size, local) from the picker / options.
  const ytStorageListener = (changes, area) => {
    if (area === 'local' && changes.hs_emote_size) applyEmoteSize(changes.hs_emote_size.newValue)
  }
  chrome.storage.onChanged.addListener(ytStorageListener)
  window.addEventListener(
    'pagehide',
    () => {
      try {
        chrome.runtime.onMessage.removeListener(ytInventoryListener)
      } catch {}
      try {
        chrome.storage.onChanged.removeListener(ytStorageListener)
      } catch {}
    },
    { once: true },
  )

  // ─── Emote Replacement ────────────────────────────────────────────────────────

  function isZeroWidth(emote) {
    if (!emote) return false
    if (emote.zeroWidth === true) return true
    if (typeof emote.flags === 'number' && emote.flags & 257) return true
    return false
  }

  function replaceEmotesInElement(messageEl) {
    if (!messageEl || emoteMap.size === 0) return

    const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT)
    const textNodes = []
    while (walker.nextNode()) textNodes.push(walker.currentNode)

    for (const textNode of textNodes) {
      const text = textNode.textContent
      if (!text?.trim()) continue

      const words = text.split(/(\s+)/)
      let hasEmote = false
      for (const w of words) {
        if (emoteMap.has(w)) {
          hasEmote = true
          break
        }
      }
      if (!hasEmote) continue

      const frag = document.createDocumentFragment()
      let currentStack = null // active <span class="heatsync-emote-stack"> or null

      for (const word of words) {
        const emote = emoteMap.get(word)
        if (emote) {
          const img = document.createElement('img')
          img.src = emote.url
          img.alt = emote.name
          img.title = emote.name
          img.className = 'heatsync-emote-yt'
          img.loading = 'lazy'

          if (isZeroWidth(emote) && currentStack) {
            // Stack onto the previous non-zero-width emote
            currentStack.appendChild(img)
          } else {
            // Non-zero-width emote: start a new potential stack anchor
            currentStack = document.createElement('span')
            currentStack.className = 'heatsync-emote-stack'
            currentStack.appendChild(img)
            frag.appendChild(currentStack)
          }
        } else {
          // Any non-emote token breaks the stacking chain
          currentStack = null
          frag.appendChild(document.createTextNode(word))
        }
      }
      textNode.parentNode.replaceChild(frag, textNode)
    }
  }

  // ─── 7TV Cosmetics (via heatsync profile linkage) ────────────────────────────

  const YT_COSMETICS_TTL = 30 * 60 * 1000 // 30 minutes
  const YT_COSMETICS_MAX = 500
  const YT_COSMETICS_PENDING_MAX = 8

  // username → { paint, badge, fetchedAt } | null (null = no profile/no cosmetics
  // via twitch AND no cosmetics via the yt-google fallback)
  const ytCosmeticsCache = new Map()
  // username → channelId (UC id, or null if not yet seen) — carried from queue
  // time to flush time so the google-id fallback has something to look up.
  const ytCosmeticsPending = new Map()
  let ytCosmeticsBatchTimer = null

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

  function applyPaintToElement(el, paint) {
    if (!paint) return
    // 7TV paints stand down for a saved heatsync paint — inline style outranks
    // the hsp-<hash> class rule, so without this a 7TV batch resolving second
    // erases a paid paint. Same guard as chrome/content.js.
    if (el?.classList) {
      for (const c of el.classList) if (c.startsWith('hsp-')) return
    }
    const fn = (paint.function || '').toLowerCase()
    if (fn === 'url' && paint.image_url) {
      if (!/^https:\/\//.test(paint.image_url)) return
      const safeCssUrl = paint.image_url.replace(/[()'"\\]/g, encodeURIComponent)
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

  function applyYtCosmeticsToMessage(node, username) {
    // Guard: this is called after async cosmetics fetch (~1-2s); the message
    // node may have been recycled by YouTube's chat virtualizer or the page
    // may have torn down. Avoid mutating detached DOM.
    if (!node?.isConnected) return
    const cosmetic = ytCosmeticsCache.get(username)
    if (!cosmetic) return

    const nameEl = node.querySelector('#author-name')
    if (!nameEl) return

    // Badge — insert before author name element
    if (cosmetic.badge && !node.dataset.hs7tvYtBadgeDone) {
      const url = get7TVBadgeUrl(cosmetic.badge)
      if (url && /^https:\/\//.test(url)) {
        const img = document.createElement('img')
        img.className = 'hs-7tv-badge hs-yt-cosmetic-badge'
        img.src = url
        const title = cosmetic.badge.tooltip || cosmetic.badge.name || '7TV'
        img.title = title
        img.alt = title
        nameEl.parentNode.insertBefore(img, nameEl)
        node.dataset.hs7tvYtBadgeDone = '1'
      }
    }

    // Paint — gradient/color on author name text
    if (cosmetic.paint && !nameEl.dataset.hsPaintApplied) {
      applyPaintToElement(nameEl, cosmetic.paint)
    }
  }

  function queueYtCosmeticsLookup(username, channelId) {
    if (!username) return
    const cached = ytCosmeticsCache.get(username)
    if (cached !== undefined && Date.now() - (cached?.fetchedAt ?? 0) < YT_COSMETICS_TTL) return
    if (ytCosmeticsPending.has(username)) return
    ytCosmeticsPending.set(username, channelId || null)
    if (ytCosmeticsPending.size >= YT_COSMETICS_PENDING_MAX) {
      if (ytCosmeticsBatchTimer) {
        clearTimeout(ytCosmeticsBatchTimer)
        ytCosmeticsBatchTimer = null
      }
      flushYtCosmeticsBatch()
      return
    }
    if (!ytCosmeticsBatchTimer) {
      if (signal.aborted) return
      ytCosmeticsBatchTimer = cleanup.setTimeout(() => {
        ytCosmeticsBatchTimer = null
        if (signal.aborted) return
        flushYtCosmeticsBatch()
      }, 600)
    }
  }
  signal.addEventListener(
    'abort',
    () => {
      if (ytCosmeticsBatchTimer) {
        cleanup.clearTimeout(ytCosmeticsBatchTimer)
        ytCosmeticsBatchTimer = null
      }
      if (_setupAutocompleteRetryTimer) {
        cleanup.clearTimeout(_setupAutocompleteRetryTimer)
        _setupAutocompleteRetryTimer = null
      }
      // Clear cosmetics caches so cross-video bleed can't happen on next mount
      ytCosmeticsCache.clear()
      ytCosmeticsPending.clear()
      // HS spec-paint state too (sheet node is cleanup-tracked separately)
      if (ytHsPaintTimer) {
        cleanup.clearTimeout(ytHsPaintTimer)
        ytHsPaintTimer = null
      }
      ytHsPaintCache.clear()
      ytHsPaintPending.clear()
      ytHsPaintHashes.clear()
      ytHsPaintSheet = null
    },
    { once: true },
  )

  async function flushYtCosmeticsBatch() {
    if (ytCosmeticsPending.size === 0) return
    const entries = [...ytCosmeticsPending].slice(0, YT_COSMETICS_PENDING_MAX)
    entries.forEach(([u]) => ytCosmeticsPending.delete(u))

    const now = Date.now()

    await Promise.all(
      entries.map(async ([username, channelId]) => {
        try {
          // Step 1: resolve heatsync profile → twitch_id
          const profileResp = await safeSendMessage({
            type: 'api_fetch',
            path: `/api/profile/${encodeURIComponent(username)}`,
            method: 'GET',
          })
          const twitchId = profileResp?.data?.twitch_id || profileResp?.twitch_id || null
          if (twitchId) {
            // Step 2a: fetch 7TV cosmetics via the twitch-id path
            const cosmeticResp = await safeSendMessage({
              type: 'get_user_cosmetics',
              twitchIds: [twitchId],
            })
            const cosmetic = cosmeticResp?.cosmetics?.[twitchId] || null
            evictYtCache()
            ytCosmeticsCache.set(username, {
              paint: cosmetic?.paint || null,
              badge: cosmetic?.badge || null,
              fetchedAt: now,
            })
            return
          }

          // No linked Twitch account — fall back to 7TV's YouTube/"google" id
          // space so yt-only chatters still get their paint/badge. A missing
          // twitch_id must never get cached as a bare negative here; it has
          // to fall through to this lookup every time before landing on a
          // real result (positive or genuine double-negative).
          if (channelId) {
            const googleResp = await safeSendMessage({
              type: 'get_youtube_user_cosmetics',
              channelIds: [channelId],
            })
            const cosmetic = googleResp?.cosmetics?.[channelId] || null
            evictYtCache()
            ytCosmeticsCache.set(username, {
              paint: cosmetic?.paint || null,
              badge: cosmetic?.badge || null,
              fetchedAt: now,
            })
            return
          }

          // Neither twitch_id nor a resolvable channel id — genuinely nothing
          // to look up. Cache null so we don't refetch for 30min.
          evictYtCache()
          ytCosmeticsCache.set(username, { paint: null, badge: null, fetchedAt: now })
        } catch (e) {
          log('yt cosmetics fetch failed for', username, e?.message)
          evictYtCache()
          ytCosmeticsCache.set(username, { paint: null, badge: null, fetchedAt: now })
        }
      }),
    )

    // Apply to any already-rendered messages waiting on cosmetics
    applyPendingYtCosmetics(entries.map(([u]) => u))

    // Drain remainder if any
    if (ytCosmeticsPending.size > 0 && !ytCosmeticsBatchTimer) {
      if (signal.aborted) return
      ytCosmeticsBatchTimer = cleanup.setTimeout(() => {
        ytCosmeticsBatchTimer = null
        if (signal.aborted) return
        flushYtCosmeticsBatch()
      }, 2000)
    }
  }

  function evictYtCache() {
    if (ytCosmeticsCache.size >= YT_COSMETICS_MAX) {
      ytCosmeticsCache.delete(ytCosmeticsCache.keys().next().value)
    }
  }

  // ─── HeatSync spec paints (bought paints, yt_<UCid> id-space) ────────────────
  // Mirrors the overlay pipeline (src/multichat/paints.js): batch fetch_paints
  // via the BG SW (content scripts never fetch heatsync.org — CF 503s them),
  // compile each distinct spec ONCE via the embedded lib/paint-spec.js
  // compiler (build.js appends it to this bundle's lib — behavior parity with
  // the overlay/site is the whole point), inject per-hash CSS into one sheet,
  // apply as an .hsp-<hash> class. HS paint outranks the 7TV paint: the 7TV
  // branch keys off nameEl.dataset.hsPaintApplied, and applying clears the
  // inline style 7TV may have set (inline beats class in the cascade).
  const YT_HSPAINT_BATCH = 50
  const YT_HSPAINT_DELAY = 250
  const YT_HSPAINT_CACHE_MAX = 500
  const ytHsPaintCache = new Map() // uid -> { spec: object|null, hash: string|null }
  const ytHsPaintPending = new Set()
  const ytHsPaintHashes = new Set()
  let ytHsPaintTimer = null
  let ytHsPaintSheet = null

  // The compiler comes from the build-time paint-spec.js embed; typeof-guard
  // every entry point so a bundle built without it degrades to no HS paints
  // instead of a ReferenceError killing the whole content script.
  function ytHsPaintReady() {
    return (
      typeof compilePaintCss === 'function' &&
      typeof hashPaintSpec === 'function' &&
      // paintNeedsSpans is the compiler's name for this. It was renamed on
      // 2026-08-16 ("resync the compiler with the site") and this file never
      // followed, so the guard was false from that day on and HeatSync paints
      // stopped rendering on native youtube chat entirely.
      typeof paintNeedsSpans === 'function'
    )
  }

  function ensureYtHsPaintSheet() {
    if (ytHsPaintSheet?.isConnected) return ytHsPaintSheet
    ytHsPaintSheet = document.getElementById('hs-yt-paints')
    if (!ytHsPaintSheet) {
      ytHsPaintSheet = document.createElement('style')
      ytHsPaintSheet.id = 'hs-yt-paints'
      // Same base rules as the overlay sheet (paints.js ensureHsPaintSheet):
      // one animatePaints kill-switch + the hover freeze (plain white/black
      // chip, transform:none so rotation effects don't freeze edge-on).
      // Gated on the setting, NOT prefers-reduced-motion — see the long note in
      // paints.js: the media query is a browser flag, and a chromium run with
      // --force-prefers-reduced-motion froze every paint on the page forever.
      ytHsPaintSheet.textContent =
        'html[data-hs-paint-anim="never"] [class*="hsp-"],html[data-hs-paint-anim="never"] [class*="hsp-"] *{animation-play-state:paused !important;}' +
        '[class*="hsp-"]:hover,[class*="hsp-"]:hover span{animation-play-state:paused !important;background:#fff !important;-webkit-background-clip:border-box !important;background-clip:border-box !important;color:#000 !important;transform:none !important;}'
      document.head.appendChild(cleanup.trackNode ? cleanup.trackNode(ytHsPaintSheet) : ytHsPaintSheet)
    }
    return ytHsPaintSheet
  }

  function queueYtHsPaint(uid) {
    if (!uid || !ytHsPaintReady()) return
    if (ytHsPaintCache.has(uid) || ytHsPaintPending.has(uid)) return
    ytHsPaintPending.add(uid)
    if (ytHsPaintPending.size >= YT_HSPAINT_BATCH) {
      if (ytHsPaintTimer) {
        cleanup.clearTimeout(ytHsPaintTimer)
        ytHsPaintTimer = null
      }
      flushYtHsPaintBatch()
      return
    }
    if (!ytHsPaintTimer && !signal.aborted) {
      ytHsPaintTimer = cleanup.setTimeout(() => {
        ytHsPaintTimer = null
        if (!signal.aborted) flushYtHsPaintBatch()
      }, YT_HSPAINT_DELAY)
    }
  }

  async function flushYtHsPaintBatch() {
    if (!ytHsPaintPending.size) return
    const batch = [...ytHsPaintPending].slice(0, YT_HSPAINT_BATCH)
    batch.forEach((id) => ytHsPaintPending.delete(id))
    let paints = null
    try {
      const resp = await safeSendMessage({ type: 'fetch_paints', userIds: batch })
      if (resp?.paints && typeof resp.paints === 'object') paints = resp.paints
    } catch (_) {}
    const changed = []
    if (paints) {
      // BG only includes CONFIRMED answers (spec or null). An absent key is a
      // transient failure — requeue it, never cache a false negative.
      for (const id of batch) {
        if (!Object.hasOwn(paints, id)) {
          ytHsPaintPending.add(id)
          continue
        }
        const spec = paints[id]
        let hash = null
        if (spec) {
          try {
            hash = hashPaintSpec(spec)
            if (hash && !ytHsPaintHashes.has(hash)) {
              const css = compilePaintCss(spec, `.hsp-${hash}`, { hash })
              if (css) {
                ensureYtHsPaintSheet().textContent += css
                ytHsPaintHashes.add(hash)
              } else hash = null
            }
          } catch (_) {
            hash = null
          }
        }
        if (ytHsPaintCache.size >= YT_HSPAINT_CACHE_MAX) {
          ytHsPaintCache.delete(ytHsPaintCache.keys().next().value)
        }
        ytHsPaintCache.set(id, { spec: hash ? spec : null, hash })
        if (hash) changed.push(id)
      }
    } else {
      for (const id of batch) ytHsPaintPending.add(id)
    }
    // Retro-apply to rows already rendered before the fetch resolved.
    if (changed.length) {
      const container = document.querySelector('yt-live-chat-item-list-renderer #items')
      if (container) {
        const uidSet = new Set(changed)
        container.querySelectorAll('[data-hs-yt-paint-uid]').forEach((node) => {
          if (!uidSet.has(node.dataset.hsYtPaintUid)) return
          applyYtHsPaint(node.querySelector('#author-name'), node.dataset.hsYtPaintUid)
        })
      }
    }
    if (ytHsPaintPending.size && !ytHsPaintTimer && !signal.aborted) {
      ytHsPaintTimer = cleanup.setTimeout(() => {
        ytHsPaintTimer = null
        if (!signal.aborted) flushYtHsPaintBatch()
      }, YT_HSPAINT_DELAY * 5)
    }
  }

  /** Apply a cached HS paint to the author-name element. Returns true when a
   * paint class was applied (caller/7TV branch must then leave it alone). */
  function applyYtHsPaint(nameEl, uid) {
    if (!nameEl || !uid || !ytHsPaintReady()) return false
    const entry = ytHsPaintCache.get(uid)
    if (!entry?.hash) return false
    const cls = `hsp-${entry.hash}`
    if (!nameEl.classList.contains(cls)) {
      for (const c of [...nameEl.classList]) if (c.startsWith('hsp-')) nameEl.classList.remove(c)
      nameEl.classList.add(cls)
    }
    // Inline style (yt's own color, or a 7TV paint applied earlier) has higher
    // specificity than any class rule — clear it or the paint silently loses.
    if (nameEl.hasAttribute('style')) nameEl.removeAttribute('style')
    if (paintNeedsSpans(entry.spec) && !nameEl.dataset.hsPaintSplit && nameEl.textContent) {
      // DOM-built per-glyph spans (--i/--mid drive the effect delays) — same
      // output shape as the overlay's splitHsLettersHtml, no innerHTML.
      const chars = [...nameEl.textContent]
      const mid = (chars.length - 1) / 2
      nameEl.textContent = ''
      chars.forEach((ch, i) => {
        const s = document.createElement('span')
        s.style.setProperty('--i', i)
        s.style.setProperty('--mid', mid)
        s.textContent = ch
        nameEl.appendChild(s)
      })
      nameEl.dataset.hsPaintSplit = '1'
    }
    nameEl.dataset.hsPaintApplied = '1'
    return true
  }

  function applyPendingYtCosmetics(usernames) {
    const container = document.querySelector('yt-live-chat-item-list-renderer #items')
    if (!container) return
    const userSet = new Set(usernames)
    container.querySelectorAll('[data-hs-yt-user]').forEach((node) => {
      if (node.dataset.hs7tvYtDone === '1') return
      const username = node.dataset.hsYtUser
      if (userSet.has(username)) {
        applyYtCosmeticsToMessage(node, username)
        node.dataset.hs7tvYtDone = '1'
      }
    })
  }

  // ─── CSS Injection ────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('heatsync-yt-styles')) return
    const style = document.createElement('style')
    style.id = 'heatsync-yt-styles'
    style.textContent = `
      .heatsync-emote-yt {
        height: var(--hs-emote-height, 28px) !important;
        width: auto !important;
        max-width: none !important;
        max-height: none !important;
        vertical-align: middle !important;
        margin: -2px 1px !important;
        display: inline !important;
      }
      .hs-yt-cosmetic-badge {
        height: 18px !important;
        width: auto !important;
        vertical-align: middle !important;
        margin-right: 3px !important;
        display: inline-block !important;
        cursor: default;
      }
      .hs-yt-autocomplete {
        position: absolute;
        bottom: 100%;
        left: 0;
        right: 0;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 0;
        max-height: 200px;
        overflow-y: auto;
        z-index: 10000;
        display: none;
      }
      .hs-yt-autocomplete.active { display: block; }
      .hs-yt-ac-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 13px;
        color: #ddd;
      }
      .hs-yt-ac-item:hover, .hs-yt-ac-item.selected {
        background: #fff;
        color: #000;
      }
      .hs-yt-ac-item:hover *, .hs-yt-ac-item.selected * {
        color: #000;
      }
      .hs-yt-ac-item img {
        height: 24px;
        width: auto;
      }
      .hs-yt-ac-emoji {
        font-size: 16px;
        width: 20px;
        text-align: center;
        flex-shrink: 0;
      }
      .hs-yt-ac-vis { margin-left: auto; flex-shrink: 0; padding-left: 8px; }
      .hs-yt-ac-vis.v-all { color: #5fd75f; }
      .hs-yt-ac-vis.v-ext { color: #ffd75f; }
      .hs-yt-ac-vis.v-hs  { color: #fff; }
      .hs-yt-ac-vis.v-dim { color: #9e9e9e; }
      .hs-yt-toast {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(30,30,30,0.92);
        color: #eee;
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 0;
        pointer-events: none;
        z-index: 99999;
        opacity: 1;
        transition: opacity 0.3s;
      }
      .hs-yt-toast.fade { opacity: 0; }
    `
    document.head.appendChild(style)
  }

  // ─── Message Extraction (existing logic) ──────────────────────────────────────

  function waitForContainer() {
    return new Promise((resolve, reject) => {
      let elapsed = 0
      const check = () => {
        if (signal.aborted) return reject(new Error('aborted'))
        const el = document.querySelector('yt-live-chat-item-list-renderer #items')
        if (el) return resolve(el)
        if (elapsed >= 15000) return reject(new Error('YouTube chat container not found'))
        elapsed += 500
        cleanup.setTimeout(check, 500)
      }
      check()
    })
  }

  function extractColor(authorEl) {
    if (!authorEl) return '#ffffff'
    const computed = window.getComputedStyle(authorEl)
    const color = computed.color
    if (!color || color === 'rgba(0, 0, 0, 0)') return '#ffffff'
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (!m) return '#ffffff'
    const r = parseInt(m[1], 10),
      g = parseInt(m[2], 10),
      b = parseInt(m[3], 10)
    if (r > 200 && g > 200 && b > 200) return '#ffffff'
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
  }

  function extractAvatar(el) {
    const img = el.querySelector('#author-photo img')
    if (!img?.src) return ''
    return img.src.replace(/=s\d+[^=]*$/, '=s64-k-c0x00ffffff-no-rj')
  }

  function extractBadges(el) {
    const authorType = el.getAttribute('author-type') || ''
    const badges = []
    if (authorType === 'owner') badges.push({ type: 'owner', label: 'Owner' })
    else if (authorType === 'moderator') badges.push({ type: 'moderator', label: 'Mod' })

    const badgeContainer = el.querySelector('#author-badges')
    if (badgeContainer) {
      for (const br of badgeContainer.querySelectorAll('yt-live-chat-author-badge-renderer')) {
        const img = br.querySelector('img')
        if (img?.src) {
          const tooltip =
            br.getAttribute('aria-label') ||
            br.getAttribute('shared-tooltip-text') ||
            img.alt ||
            img.getAttribute('shared-tooltip-text') ||
            'Member'
          badges.push({ type: 'member', label: tooltip, url: img.src })
        }
      }
    }
    return badges.length > 0 ? badges : undefined
  }

  // YT's live-chat renderer elements bind the raw innertube renderer JSON to
  // a `.data` property (not a DOM attribute) — `authorExternalChannelId` is
  // the message author's real UC... channel id. Verified live: it's present
  // on text/paid-message/membership renderers alike. UC ids are base64url
  // (can contain '-'/'_'), so validate with the same regex background.js
  // uses for the 7TV google-id lookup — never a no-hyphen guard.
  function extractAuthorChannelId(el) {
    // el.data is a page-world Polymer property — invisible from this ISOLATED
    // world (reads undefined). The MAIN-world yt-data-bridge.js mirrors the id
    // onto a DOM attribute, which does cross worlds; keep the direct read
    // first in case worlds ever merge (it costs nothing and is authoritative).
    const id = el.data?.authorExternalChannelId || el.getAttribute('data-hs-author-id')
    return typeof id === 'string' && /^UC[\w-]{20,}$/i.test(id) ? id : null
  }

  // Same cross-world bridge pattern as extractAuthorChannelId, for the
  // renderer's real send time (YouTube's timestampUsec, microseconds since
  // epoch). Without this the DOM-scrape tap stamped every message with
  // Date.now() at SCRAPE time, not send time — unlike the innertube-JSON tap
  // (background.js ytTapTimestamp) and the server relay, which both already
  // use the real timestamp. Falls back to null (caller uses Date.now()) if
  // the bridge hasn't stamped it yet (Polymer binds a frame or two late).
  function extractTimestampMs(el) {
    const usec = el.data?.timestampUsec || el.getAttribute('data-hs-timestamp')
    const n = Number.parseInt(usec, 10)
    return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : null
  }

  // Paint stamp + fetch for one row — shared by the immediate path (bridge
  // already stamped the author id) and the late retry (Polymer bound after us).
  function stampYtHsPaint(node, ucid) {
    const paintUid = `yt_${ucid}`
    node.dataset.hsYtPaintUid = paintUid
    if (ytHsPaintCache.has(paintUid)) {
      applyYtHsPaint(node.querySelector('#author-name'), paintUid)
    } else {
      queueYtHsPaint(paintUid)
    }
  }

  function extractMessage(el) {
    const authorEl = el.querySelector('#author-name')
    // Fall through selectors and prefer the first one with non-whitespace
    // content — gift renderers often have an empty #message but populated
    // #header-primary-text, so static-priority lookup misses them.
    let messageEl = null
    for (const sel of ['#message', '#header-subtext', '#header-primary-text', '#primary-text']) {
      const e = el.querySelector(sel)
      if (e?.textContent?.trim()) {
        messageEl = e
        break
      }
    }
    if (!messageEl)
      messageEl =
        el.querySelector('#message') || el.querySelector('#header-subtext') || el.querySelector('#header-primary-text')
    if (!authorEl || !messageEl) return null

    const user = authorEl.textContent.trim()
    if (!user) return null

    const color = extractColor(authorEl)
    const avatar = extractAvatar(el)
    const badges = extractBadges(el)
    const channelId = extractAuthorChannelId(el)

    let text = ''
    const emotes = []
    const seenAlts = new Set()
    for (const node of messageEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent
      } else if (node.nodeName === 'IMG') {
        const alt = node.alt || ''
        text += alt
        if (alt && node.src && !seenAlts.has(alt)) {
          seenAlts.add(alt)
          emotes.push({ alt, url: node.src })
        }
      } else if (node.textContent) {
        text += node.textContent
      }
    }
    text = text.trim()
    if (!text) return null

    return { user, text, emotes, color, avatar, badges, channelId }
  }

  const SUPPORTED_RENDERERS = new Set([
    'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER',
    'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
    'YT-LIVE-CHAT-PAID-STICKER-RENDERER',
    'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
    'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-PURCHASE-ANNOUNCEMENT-RENDERER',
    'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-REDEMPTION-ANNOUNCEMENT-RENDERER',
    'YT-LIVE-CHAT-SPONSORSHIPS-HEADER-RENDERER',
  ])

  // Track recent message authors so we can announce moderator deletions
  // upstream — YouTube clears the renderer's text and stamps `is-deleted`
  // (or replaces it with yt-live-chat-deleted-message-renderer); both lose
  // the user, so we cache it on the node before the wipe.
  function broadcastDeletion(node, reason) {
    const user = node?.dataset?.hsYtUser
    if (!user) return
    if (node.dataset.hsYtDeletedSent) return
    node.dataset.hsYtDeletedSent = '1'
    safeSendMessage({
      type: 'youtube_msg_deleted',
      videoId,
      user,
      reason: reason || '',
    })
  }

  // Tag → msgType mapping lives in lib/utils.js (classifyYtRendererType,
  // bundled into this content script) so it's tested once and shared with
  // the multichat overlay's event-banner dispatch — not duplicated here.

  function extractSuperchatData(el) {
    const amountEl = el.querySelector('#purchase-amount, #purchase-amount-chip')
    const amount = amountEl?.textContent?.trim() || ''
    const header = el.querySelector('#header, #card')
    const bg = header?.style?.backgroundColor || ''
    return { amount, scColor: bg }
  }

  function extractStickerData(el) {
    const amountEl = el.querySelector('#purchase-amount-chip')
    const amount = amountEl?.textContent?.trim() || ''
    const stickerEl = el.querySelector('#sticker img')
    const url = stickerEl?.src || ''
    const alt = stickerEl?.alt || 'sticker'
    return { amount, sticker: { url, alt } }
  }

  function processNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return
    if (!SUPPORTED_RENDERERS.has(node.tagName)) return
    if (node.dataset.hsYtProcessed) return
    node.dataset.hsYtProcessed = '1'

    const msg = extractMessage(node)
    if (!msg) return

    // First real message → probe whether this account can moderate (deduped).
    if (!_ytModProbed) probeYtMod()

    const msgType = classifyYtRendererType(node.tagName)

    // Emote overlay — replace emote text with images in the message element
    const messageEl = node.querySelector('#message')
    if (messageEl && emoteMap.size > 0) {
      replaceEmotesInElement(messageEl)
    }

    // HeatSync spec paint — yt_<UCid> id-space (same minting as the overlay's
    // social.js). Applied/queued BEFORE 7TV so the hsPaintApplied stamp wins.
    if (msg.channelId) {
      stampYtHsPaint(node, msg.channelId)
    } else {
      // The MAIN-world yt-data-bridge mirrors el.data.authorExternalChannelId
      // onto data-hs-author-id, but Polymer can bind after our observer fires —
      // retry once after the bridge's own retry window.
      setTimeout(() => {
        const late = extractAuthorChannelId(node)
        if (late) {
          stampYtHsPaint(node, late)
          if (msg.user && !ytCosmeticsPending.has(msg.user) && ytCosmeticsCache.get(msg.user) === undefined) {
            queueYtCosmeticsLookup(msg.user, late)
          }
        }
      }, 300)
    }

    // 7TV cosmetics via heatsync profile linkage
    if (msg.user) {
      recordYtChatter(msg.user)
      node.dataset.hsYtUser = msg.user
      const cached = ytCosmeticsCache.get(msg.user)
      if (cached !== undefined) {
        // Already resolved — apply immediately if there's something to show
        if (cached.paint || cached.badge) applyYtCosmeticsToMessage(node, msg.user)
      } else {
        // Queue a profile lookup (deduped, batched)
        queueYtCosmeticsLookup(msg.user, msg.channelId)
      }
    }

    const payload = {
      type: 'youtube_chat_message',
      videoId,
      channelId: videoId,
      // renderer id attribute = youtube's own per-message id — same identity
      // space as the server relay's innertube id, so the overlay's id-exact
      // dedup collapses DOM-scraped and server-relayed copies of one message
      id: node.id || undefined,
      user: msg.user,
      text: msg.text,
      msgType,
      color: msg.color,
      // Real send time when yt-data-bridge got there in time; Date.now() (scrape
      // time, not send time) is a last-resort fallback, not the normal case.
      time: extractTimestampMs(node) ?? Date.now(),
      platform: 'youtube',
      emotes: msg.emotes.length > 0 ? msg.emotes : undefined,
      avatar: msg.avatar || undefined,
      badges: msg.badges,
      // Author's real UC… channel id — social.js uses this for the yt_<UCid>
      // HeatSync paint uid AND (see cosmetics.js flushYtNameLookups) the 7TV
      // google-id cosmetics fallback for chatters with no linked Twitch.
      authorChannelId: msg.channelId || undefined,
    }

    if (msgType === 'superchat') {
      const sc = extractSuperchatData(node)
      payload.amount = sc.amount
      payload.scColor = sc.scColor
    } else if (msgType === 'supersticker') {
      const st = extractStickerData(node)
      payload.amount = st.amount
      payload.sticker = st.sticker
    } else if (
      msgType === 'membership' ||
      msgType === 'giftpurchase' ||
      msgType === 'giftredemption' ||
      msgType === 'giftheader'
    ) {
      // Pull the system text from whichever header slot YouTube populated for
      // this renderer variant — gift announcements tend to use #header-primary-text,
      // memberships use #header-subtext, but selectors overlap so we accept any.
      const headerEl = node.querySelector('#header-subtext, #header-primary-text, #primary-text')
      if (headerEl) payload.systemMsg = headerEl.textContent.trim()
    }

    log('yt msg:', msgType, msg.user, msg.text)
    safeSendMessage(payload)
  }

  // ─── Autocomplete ─────────────────────────────────────────────────────────────

  // subsystems.tab-complete gate ("tab-complete in native chat" — applies to
  // all 3 platforms per settings-schema.js; Twitch/Kick already respect it,
  // this brings youtube's native-input autocomplete to the same parity).
  // reload-only (matches content.js's HS_GATES — read once at init).
  let tabCompleteEnabled = true
  async function readTabCompleteGate() {
    try {
      const stored = await chrome.storage.sync.get('ui_settings')
      tabCompleteEnabled = stored?.ui_settings?.subsystems?.['tab-complete'] !== false
    } catch (e) {
      log('tab-complete gate read failed:', e?.message)
    }
  }

  let autocompleteEl = null
  let acItems = []
  let acSelectedIndex = -1
  let acVisible = false

  // Recently-active YouTube chatters → lead bare-word Tab autocomplete above
  // emotes (parity with overlay/twitch/kick). Time-windowed (10 min, cap-pruned)
  // so "recent" matches what the user sees. Inserted as the plain name (no @).
  const ytRecentChatters = new Map() // lower -> { dn, t }
  function recordYtChatter(display) {
    if (!display) return
    const lower = display.toLowerCase()
    ytRecentChatters.delete(lower)
    ytRecentChatters.set(lower, { dn: display, t: Date.now() })
    while (ytRecentChatters.size > 600) ytRecentChatters.delete(ytRecentChatters.keys().next().value)
  }
  // Shared newest-first, time-windowed scan over ytRecentChatters — both the
  // bare-word lead and '@'-mention completion read the same harvested set.
  function matchRecentChatters(ql, extra) {
    const entries = [...ytRecentChatters.entries()]
    const floor = Date.now() - 10 * 60 * 1000 // last 10 REAL minutes, not relative to newest
    const out = []
    for (let k = entries.length - 1; k >= 0; k--) {
      const [l, v] = entries[k]
      if (v.t && v.t < floor) break
      if (l.startsWith(ql)) out.push({ name: v.dn, isChatter: true, ...extra })
    }
    return out
  }
  function ytRecentChatterMatches(prefix) {
    const ql = prefix.toLowerCase()
    if (!ql || ql.startsWith('@')) return []
    return matchRecentChatters(ql)
  }
  // '@'-prefixed mention completion — same harvested chatters, '@' stripped
  // for the match and restored on insert (see completeEmote's isMention branch).
  function ytMentionMatches(query) {
    const ql = query.toLowerCase()
    if (!ql) return []
    return matchRecentChatters(ql, { isMention: true })
  }

  // Emoji shortcode (':prefix') completion — same EMOJI_DATA global emoji-data.iso.js
  // defines for the Kick hook (chrome/kick-autocomplete-hook.js), loaded earlier in
  // this frame per the manifest so it's already a global by the time this runs.
  const EMOJI_ENTRIES = typeof EMOJI_DATA !== 'undefined' ? EMOJI_DATA : []
  function searchYtEmoji(query) {
    if (!query || !EMOJI_ENTRIES.length) return []
    const q = query.toLowerCase()
    const exact = [],
      prefix = [],
      contains = []
    for (const e of EMOJI_ENTRIES) {
      if (e.name === q) exact.push(e)
      else if (e.name.startsWith(q)) prefix.push(e)
      else if (e.name.includes(q)) contains.push(e)
    }
    return [...exact, ...prefix, ...contains].slice(0, 8).map((e) => ({ name: e.name, emoji: e.emoji, isEmoji: true }))
  }

  let _setupAutocompleteRetryTimer = null
  function setupAutocomplete() {
    if (signal.aborted) return
    if (!tabCompleteEnabled) {
      log('tab-complete subsystem off — skipping native autocomplete')
      return
    }
    const inputRenderer = document.querySelector('yt-live-chat-text-input-field-renderer')
    if (!inputRenderer) {
      if (_setupAutocompleteRetryTimer) cleanup.clearTimeout(_setupAutocompleteRetryTimer)
      if (signal.aborted) return
      _setupAutocompleteRetryTimer = cleanup.setTimeout(setupAutocomplete, 1000)
      return
    }

    const input = inputRenderer.querySelector('div#input[contenteditable]')
    if (!input) {
      if (_setupAutocompleteRetryTimer) cleanup.clearTimeout(_setupAutocompleteRetryTimer)
      if (signal.aborted) return
      _setupAutocompleteRetryTimer = cleanup.setTimeout(setupAutocomplete, 1000)
      return
    }
    // Found — clear any pending retry
    if (_setupAutocompleteRetryTimer) {
      cleanup.clearTimeout(_setupAutocompleteRetryTimer)
      _setupAutocompleteRetryTimer = null
    }

    // Create autocomplete dropdown
    autocompleteEl = document.createElement('div')
    autocompleteEl.className = 'hs-yt-autocomplete'
    inputRenderer.style.position = 'relative'
    inputRenderer.appendChild(autocompleteEl)

    input.addEventListener(
      'input',
      () => {
        const word = getWordAtCaret(input)
        if (word && word.length >= 2) {
          // '@' and ':' are dedicated modes — neither can prefix an emote name,
          // so route them before the bare-word chatter+emote path (parity with
          // kick-autocomplete-hook.js's activeMode split).
          if (word[0] === '@') {
            const mentionMatches = ytMentionMatches(word.slice(1))
            if (mentionMatches.length > 0) showAutocomplete(mentionMatches, input)
            else hideAutocomplete()
            return
          }
          if (word[0] === ':') {
            const emojiMatches = searchYtEmoji(word.slice(1))
            if (emojiMatches.length > 0) showAutocomplete(emojiMatches, input)
            else hideAutocomplete()
            return
          }
          // Recent chatters lead, then emotes. Shows even when no emotes are
          // loaded yet, so a name prefix still completes.
          const chatters = ytRecentChatterMatches(word)
          const emoteMatches = emoteMap.size > 0 ? findEmoteMatches(word, 8) : []
          const matches = chatters.length ? chatters.concat(emoteMatches) : emoteMatches
          if (matches.length > 0) {
            showAutocomplete(matches, input)
            return
          }
        }
        hideAutocomplete()
      },
      { signal },
    )

    input.addEventListener(
      'keydown',
      (e) => {
        if (!acVisible) return
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          const selected = acItems[acSelectedIndex >= 0 ? acSelectedIndex : 0]
          if (selected) completeEmote(input, selected)
          hideAutocomplete()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          acSelectedIndex = Math.min(acSelectedIndex + 1, acItems.length - 1)
          updateAcSelection()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          acSelectedIndex = Math.max(acSelectedIndex - 1, 0)
          updateAcSelection()
        } else if (e.key === 'Escape') {
          hideAutocomplete()
        }
      },
      { capture: true, signal },
    )

    log('autocomplete ready')
  }

  function getWordAtCaret(el) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return ''
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return ''

    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return ''
    const text = node.textContent.substring(0, range.startOffset)
    const match = text.match(/(\S+)$/)
    return match ? match[1] : ''
  }

  function findEmoteMatches(prefix, limit) {
    const lower = prefix.toLowerCase()
    // Full scan (no early break): channel emotes (tier 0) sit at the map's tail, so
    // an early cap would hide them. Rank tier (channel>own>global) > exact >
    // prefix>substring > alpha, then slice — a channel emote beats own/global on a
    // closer match ("hug" → channel peepoHug over global "HuG").
    const matches = []
    for (const [name, emote] of emoteMap) {
      const nl = name.toLowerCase()
      const isExact = nl === lower
      const isPrefix = !isExact && nl.startsWith(lower)
      const isSubstring = !isPrefix && !isExact && nl.includes(lower)
      if (isExact || isPrefix || isSubstring) {
        matches.push({ emote, name, tier: emote._ytTier ?? 2, isExact, priority: isPrefix || isExact ? 0 : 1 })
      }
    }
    // Strong exact — full-name match that's channel/own tier OR used before
    // (shared 'hs-mc-recent-emotes' MRU with the multichat picker) leads
    // outright ("clap" → Clap first). A never-used coincidental global exact
    // ("HuG") has no MRU entry and still loses to channel emotes.
    let recentSet
    try {
      const r = JSON.parse(localStorage.getItem('hs-mc-recent-emotes'))
      recentSet = new Set(Array.isArray(r) ? r : [])
    } catch (_) {
      recentSet = new Set()
    }
    matches.sort((a, b) => {
      const as = a.isExact && (a.tier <= 1 || recentSet.has(a.name)) ? 0 : 1
      const bs = b.isExact && (b.tier <= 1 || recentSet.has(b.name)) ? 0 : 1
      if (as !== bs) return as - bs
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.isExact !== b.isExact) return a.isExact ? -1 : 1
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.name.localeCompare(b.name)
    })
    return matches.slice(0, limit).map((m) => m.emote)
  }

  // Per-row visibility tag — same wedge signal as the cycle readout on the other
  // surfaces: who sees this emote if you send it. green everyone → yellow {provider}
  // (needs that ext) → orange heatsync only. Unknown source falls back to the
  // neutral category so it never asserts a wrong visibility.
  function hsVisTag(e) {
    if (e.isChatter || e.isEmoji) return { t: 'everyone', cls: 'v-all' }
    const tier = e._ytTier ?? 2
    const src = (e.source || '').toLowerCase()
    if (src === 'twitch' || src === 'youtube') return { t: src, cls: 'v-all' }
    if (tier === 1 || src === 'heatsync' || src === 'inventory') return { t: 'heatsync', cls: 'v-hs' }
    if (src === '7tv' || src === 'bttv' || src === 'ffz') return { t: src, cls: 'v-ext' }
    return { t: tier === 0 ? 'channel' : tier === 1 ? 'mine' : 'global', cls: 'v-dim' }
  }

  function showAutocomplete(matches, input) {
    acItems = matches
    acSelectedIndex = 0
    acVisible = true

    // Build items using safe DOM methods
    autocompleteEl.textContent = ''
    matches.forEach((emote, i) => {
      const item = document.createElement('div')
      item.className = `hs-yt-ac-item${i === 0 ? ' selected' : ''}`
      item.dataset.index = String(i)

      if (emote.isEmoji) {
        const emojiSpan = document.createElement('span')
        emojiSpan.className = 'hs-yt-ac-emoji'
        emojiSpan.textContent = emote.emoji
        item.appendChild(emojiSpan)
      } else if (!emote.isChatter) {
        const img = document.createElement('img')
        img.src = emote.url
        img.alt = emote.name
        img.loading = 'lazy'
        item.appendChild(img)
      }

      const span = document.createElement('span')
      span.textContent = emote.isEmoji ? `:${emote.name}:` : emote.name
      item.appendChild(span)

      const vis = hsVisTag(emote)
      const visSpan = document.createElement('span')
      visSpan.className = `hs-yt-ac-vis ${vis.cls}`
      visSpan.textContent = vis.t
      item.appendChild(visSpan)

      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        completeEmote(input, emote)
        hideAutocomplete()
      })

      autocompleteEl.appendChild(item)
    })

    autocompleteEl.classList.add('active')
  }

  function hideAutocomplete() {
    if (!autocompleteEl) return
    acVisible = false
    acSelectedIndex = -1
    acItems = []
    autocompleteEl.classList.remove('active')
    autocompleteEl.textContent = ''
  }

  function updateAcSelection() {
    const items = autocompleteEl.querySelectorAll('.hs-yt-ac-item')
    items.forEach((el, i) => el.classList.toggle('selected', i === acSelectedIndex))
  }

  // item: the acItems entry — a heatsync emote, or an {isChatter}/{isEmoji} row.
  // Mentions restore the '@' stripped for matching; emoji insert the unicode
  // char, not the shortcode text. Only genuine emote picks feed the shared
  // recent-emotes MRU — chatter names and emoji shortcodes aren't emote usage.
  function completeEmote(input, item) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return

    const insertValue = item.isMention ? `@${item.name}` : item.isEmoji ? item.emoji : item.name

    const text = node.textContent
    const offset = range.startOffset
    let wordStart = offset
    while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart--

    const before = text.substring(0, wordStart)
    const after = text.substring(offset)
    node.textContent = `${before + insertValue} ${after}`

    const newOffset = wordStart + insertValue.length + 1
    range.setStart(node, newOffset)
    range.setEnd(node, newOffset)
    sel.removeAllRanges()
    sel.addRange(range)

    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (!item.isChatter && !item.isEmoji) recordRecentEmoteMru(item.name)
  }

  // Shared MRU with the multichat picker ('hs-mc-recent-emotes', same origin) —
  // native-input completions feed the same usage signal that strong-exact
  // ranking reads in searchEmotes.
  function recordRecentEmoteMru(name) {
    if (!name) return
    try {
      let list = []
      try {
        const r = JSON.parse(localStorage.getItem('hs-mc-recent-emotes'))
        list = Array.isArray(r) ? r : []
      } catch (_) {}
      list = list.filter((n) => n !== name)
      list.unshift(name)
      if (list.length > 24) list = list.slice(0, 24)
      localStorage.setItem('hs-mc-recent-emotes', JSON.stringify(list))
    } catch (_) {}
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────

  function showYtToast(text) {
    const el = document.createElement('div')
    el.className = 'hs-yt-toast'
    el.textContent = text
    document.body.appendChild(el)
    const timer = setTimeout(() => {
      el.classList.add('fade')
      const rmTimer = setTimeout(() => el.remove(), 350)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(rmTimer)
          el.remove()
        },
        { once: true },
      )
    }, 1800)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        el.remove()
      },
      { once: true },
    )
  }

  // ─── Right-click block on YT emotes ───────────────────────────────────────────

  document.addEventListener(
    'contextmenu',
    (e) => {
      const img = e.target
      if (img?.nodeName !== 'IMG' || !img.classList.contains('heatsync-emote-yt')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const emoteName = img.alt || img.title || ''
      if (!emoteName) return
      const emote = emoteMap.get(emoteName)
      if (!emote?.hash) return
      blockedEmotes.add(emote.hash)
      img.style.opacity = '0.3'
      safeSendMessage({ type: 'block_emote', emoteHash: emote.hash, emoteName: emote.name }).then((result) => {
        if (result?.success === false) {
          blockedEmotes.delete(emote.hash)
          img.style.opacity = ''
          showYtToast('block failed')
        } else {
          showYtToast(`blocked: ${escapeHtml(emote.name)}`)
        }
      })
    },
    { capture: true, signal },
  )

  // ─── Insert emote from picker ─────────────────────────────────────────────────

  function handleInsertEmote(emoteName) {
    if (!emoteName) return
    const input = document.querySelector('yt-live-chat-text-input-field-renderer div#input[contenteditable]')
    if (!input) return
    input.focus()

    const sel = window.getSelection()
    if (!sel) return

    // Use existing caret if inside input, else place at end
    let range
    if (sel.rangeCount && input.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0)
    } else {
      range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }

    const textNode = document.createTextNode(`${emoteName} `)
    range.deleteContents()
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.setEndAfter(textNode)
    sel.removeAllRanges()
    sel.addRange(range)

    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: `${emoteName} `, inputType: 'insertText' }))
  }

  // Direct handle for heatsync-button.js. Both scripts are ISOLATED content
  // scripts on youtube.com (manifest groups 15 and 16), so they share one
  // window — the same way content.js exposes heatsyncGetRecentChatters to the
  // kick autocomplete hook.
  //
  // It used to go chrome.runtime.sendMessage → this file's onMessage listener,
  // which does not work: runtime.sendMessage delivers to the background and
  // extension pages, NOT to content scripts. Verified in a real chromium with
  // tabs.sendMessage as the control — same payload, same listener, only the
  // tabs call arrived. The message branch below stays for the background,
  // which can reach it via tabs.sendMessage.
  window.__hsYtInsertEmote = handleInsertEmote

  // ─── Send Relay ───────────────────────────────────────────────────────────────

  /**
   * Inject text into YT live chat, click send, and (when the server is
   * waiting for confirmation) wait for the user's own message to appear in
   * the chat list — that's our proof of delivery, and it's also how we
   * recover the YT username under which it was sent (server uses that for
   * single-consume dedup against the heatsync local echo).
   *
   * Returns when awaitConfirm is set:
   *   { ok: true, ytUsername }              — message landed in the chat list
   *   { ok: false, error: 'no_input' }      — chat input not present
   *   { ok: false, error: 'chat_disabled' } — input present but disabled (slow mode, sub-only, signed-out)
   *   { ok: false, error: 'send_disabled' } — send button not clickable
   *   { ok: false, error: 'send_not_confirmed' } — clicked but never appeared (rate-limited, banned, etc.)
   */
  async function handleSendRelay(msg) {
    const inputRenderer = document.querySelector('yt-live-chat-text-input-field-renderer')
    // No input at all can mean YT is restricting participation (subscribers-only
    // mode, members-only, follower age gates) — the restricted renderer carries
    // the human reason. Surface it instead of a generic failure (lofigirl case:
    // logged-in non-subscriber gets NO input, send died as an opaque toast).
    if (!inputRenderer?.querySelector('div#input[contenteditable]')) {
      const restricted = document.querySelector('yt-live-chat-restricted-participation-renderer')
      const reason = restricted?.querySelector('#message, yt-formatted-string')?.textContent?.trim()
      if (reason) return { ok: false, error: 'chat_restricted', reason }
      return { ok: false, error: 'no_input' }
    }
    const input = inputRenderer.querySelector('div#input[contenteditable]')
    if (input.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'chat_disabled' }

    // Pre-arm the chat-list observer BEFORE we click send — otherwise a fast
    // YT roundtrip can append the message before we start watching.
    const itemList =
      document.querySelector('yt-live-chat-item-list-renderer #items') ||
      document.querySelector('#items.yt-live-chat-item-list-renderer')
    let observer = null
    let seenResolve
    const seenPromise = new Promise((resolve) => {
      seenResolve = resolve
    })
    if (itemList) {
      observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (!(node instanceof Element)) continue
            // Either the message renderer itself or a wrapper holding one
            const messageEl = node.querySelector?.('#message')
            if (!messageEl) continue
            // Loose match: YouTube transforms emotes/emoji to <img> and
            // normalizes whitespace, so an exact compare false-negatives on any
            // emote/emoji-bearing send (the echo IS in chat, we just fail to
            // recognize it → a bogus "didn't confirm" toast). Normalize
            // whitespace and accept exact / either-direction prefix / a shared
            // leading run, enough to recognize our own echo without over-matching
            // an unrelated message.
            const txt = (messageEl.textContent || '').replace(/\s+/g, ' ').trim()
            const want = (msg.text || '').replace(/\s+/g, ' ').trim()
            const lead = want.slice(0, Math.min(want.length, 12))
            if (
              want &&
              (txt === want ||
                txt.startsWith(want) ||
                want.startsWith(txt) ||
                (lead.length >= 4 && txt.startsWith(lead)))
            ) {
              const authorEl = node.querySelector?.('#author-name')
              const ytUsername = (authorEl?.textContent || '').trim()
              seenResolve(ytUsername || '')
              return
            }
          }
        }
      })
      observer.observe(itemList, { childList: true, subtree: true })
    }

    input.focus()
    input.textContent = ''

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    const textNode = document.createTextNode(msg.text)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.setEndAfter(textNode)
    sel.removeAllRanges()
    sel.addRange(range)

    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg.text, inputType: 'insertText' }))

    // Brief delay so YouTube enables the send button after the input event.
    // 200ms (was 120): on slower machines/connections YT hadn't enabled the
    // button yet, producing a spurious send_disabled.
    await new Promise((r) => setTimeout(r, 200))

    const sendBtn =
      document.querySelector('#send-button button') || document.querySelector('yt-button-shape button[aria-label]')
    if (!sendBtn || sendBtn.disabled) {
      observer?.disconnect()
      return { ok: false, error: 'send_disabled' }
    }
    sendBtn.click()

    if (!msg.awaitConfirm) {
      observer?.disconnect()
      return { ok: true }
    }

    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000))
    const ytUsername = await Promise.race([seenPromise, timeout])
    observer?.disconnect()
    if (ytUsername === null) return { ok: false, error: 'send_not_confirmed' }
    return { ok: true, ytUsername: ytUsername || undefined }
  }

  // ─── Moderation Relay ───────────────────────────────────────────────────────────
  //
  // YouTube has no simple "ban user id" API — every mod action is an opaque,
  // per-message token minted by YT's own context-menu endpoint, and it only
  // returns those tokens to accounts that actually moderate the channel. So we
  // drive YT's OWN moderation flow (get_item_context_menu → moderate), exactly
  // as youtube.com does: correct-by-construction (a non-mod simply gets no mod
  // items) and permission-safe. Config is read from the page HTML rather than
  // the `ytcfg` MAIN-world global so this works whichever world we run in.
  //
  // BULLETPROOF CONTRACT: this NEVER reports success unless YT accepted the
  // moderate call. No matching menu item (not a mod / YT changed shape) →
  // { ok:false, error:'not_moderator' }, surfaced to the user — it can never
  // silently fail to moderate.

  let _ytCfgCache = null
  function _ytModConfig() {
    if (_ytCfgCache) return _ytCfgCache
    const html = document.documentElement.innerHTML
    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1]
    const clientVersion = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) ||
      html.match(/"clientVersion":"([\d.]+)"/) ||
      [])[1]
    const visitorData = (html.match(/"visitorData":"([^"]+)"/) || [])[1]
    if (!apiKey || !clientVersion) return null
    _ytCfgCache = { apiKey, context: { client: { clientName: 'WEB', clientVersion, visitorData, hl: 'en' } } }
    return _ytCfgCache
  }

  async function _ytSapisidHash() {
    const ck = document.cookie
    const get = (n) => {
      const m = ck.match(new RegExp(`(?:^|; )${n}=([^;]+)`))
      return m ? m[1] : null
    }
    const sapisid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID')
    if (!sapisid) return null
    const ts = Math.floor(Date.now() / 1000)
    const buf = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${ts} ${sapisid} https://www.youtube.com`),
    )
    const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `SAPISIDHASH ${ts}_${hash}`
  }

  async function _ytInnertube(apiUrl, cfg, params) {
    const auth = await _ytSapisidHash()
    if (!auth) throw new Error('not_signed_in')
    const resp = await fetch(`${apiUrl}?key=${cfg.apiKey}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'X-Origin': 'https://www.youtube.com',
        'X-Goog-AuthUser': '0',
      },
      body: JSON.stringify({ context: cfg.context, params }),
    })
    return resp.json()
  }

  // The pure action-matching + mod-detection logic lives in src/lib/utils.js
  // (ytResolveModAction / ytHasModItems / ytItemModEndpoint / ytItemText) so it
  // is unit-tested against realistic menu JSON — see tests/yt-moderation.test.js.
  function _ytMenuDebug(items) {
    return items
      .map((it) => {
        const m = it.menuServiceItemRenderer
        return `${m?.icon?.iconType || '?'}:${ytItemText(m)}${ytItemModEndpoint(m) ? ':MOD' : ''}`
      })
      .join(' | ')
  }

  async function handleYtModAction(msg) {
    const { action, msgId } = msg
    try {
      const cfg = _ytModConfig()
      if (!cfg) return { ok: false, error: 'no_config' }
      // YT sets the renderer element's id to the chat-item id (verified live:
      // el.id === el.data.id), and that's the same id the tap reports upstream,
      // so the row is a direct id lookup. Both this and the menu token come off
      // DOM attributes, never `el.data` — `.data` is a page-world Polymer
      // property and reads as undefined here (see chrome/yt-data-bridge.js,
      // which mirrors both across the world boundary for exactly this reason).
      const row = msgId ? document.getElementById(msgId) : null
      if (!row) return { ok: false, error: 'message_not_found' }
      const menuParams = row.getAttribute('data-hs-ctx-params')
      if (!menuParams) return { ok: false, error: 'no_context_menu' }

      const menu = await _ytInnertube('/youtubei/v1/live_chat/get_item_context_menu', cfg, menuParams)
      const items = menu?.liveChatItemContextMenuSupportedRenderers?.menuRenderer?.items || []
      const { fireEp, sawMod } = ytResolveModAction(items, action)
      if (!fireEp) {
        // Not a mod (no moderate items at all) vs. mod but this verb didn't map
        // (YT changed text/icon) — both fail loud; the log reveals ground truth.
        log(`yt mod: no "${action}" item (sawMod=${sawMod}); menu=${_ytMenuDebug(items)}`)
        return { ok: false, error: sawMod ? 'action_unmapped' : 'not_moderator' }
      }

      const apiUrl = fireEp.commandMetadata?.webCommandMetadata?.apiUrl || '/youtubei/v1/live_chat/moderate'
      const actParams = fireEp.moderateEndpoint?.params || fireEp.liveChatActionEndpoint?.params
      if (!actParams) return { ok: false, error: 'no_action_params' }
      const res = await _ytInnertube(apiUrl, cfg, actParams)
      // Success returns actions/no error; auth/permission failure returns an
      // error block. Any error field ⇒ failure (fail loud, never a false ok).
      if (res?.error || res?.responseContext?.errors) return { ok: false, error: 'yt_rejected' }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'yt_mod_failed' }
    }
  }

  // One-shot mod-status probe: ask YT's own context menu whether THIS account
  // can moderate here — the presence of ANY moderate token ⇒ mod (ground truth,
  // no iconType guessing). Cached in storage so the overlay ctx-menu can gate
  // its yt mod items synchronously. Cheap (one authed call/channel), silent on
  // any failure (defaults to non-mod).
  let _ytModProbed = false
  async function probeYtMod() {
    if (_ytModProbed) return
    try {
      const cfg = _ytModConfig()
      if (!cfg) return
      // Attribute, not `el.data` — same world-boundary reason as handleYtModAction.
      const row = document.querySelector('yt-live-chat-text-message-renderer[data-hs-ctx-params]')
      const params = row?.getAttribute('data-hs-ctx-params')
      if (!params) return // no stamped message yet — try again on the next batch
      _ytModProbed = true
      const menu = await _ytInnertube('/youtubei/v1/live_chat/get_item_context_menu', cfg, params)
      const items = menu?.liveChatItemContextMenuSupportedRenderers?.menuRenderer?.items || []
      const isMod = ytHasModItems(items)
      // Ground-truth diagnostic: reveals YT's real item text/icons so the verb
      // mapping can be corrected if YT ever diverges. (log() is debug-gated.)
      log(`yt mod probe: isMod=${isMod} menu=${_ytMenuDebug(items)}`)
      chrome.storage.local.set({ hs_yt_mod_status: { isMod, ts: Date.now() } }, () => void chrome.runtime.lastError)
    } catch {
      _ytModProbed = false // let a later message retry
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    // Apply the user's emote-size choice before styles so the first paint is correct.
    try {
      const { hs_emote_size } = await chrome.storage.local.get(['hs_emote_size'])
      applyEmoteSize(hs_emote_size)
    } catch (e) {
      log('emote-size read failed:', e?.message)
    }

    await readTabCompleteGate()

    injectStyles()

    // Load emotes first, then start processing
    await loadEmoteInventory()

    // Channel emotes for the native surface. join_channel only fires for
    // channels the user added to the multichat overlay — a pure-yt viewer
    // watching native chat never joins, so the streamer's 7TV/BTTV set never
    // loaded here. Fire-and-forget: background resolves the channel (from
    // videoId when the iframe URL has ?v=, else from the sender tab's
    // watch?v=/@handle URL — embedded chat iframes only carry ?continuation=)
    // and fetches; the channel_emotes_update broadcast lands in this file's
    // listener and rebuilds the map.
    safeSendMessage({ type: 'yt_ensure_channel_emotes', videoId })

    try {
      let container = await waitForContainer()
      log('found chat container')

      // Observers bind to a single #items node. YT can swap the chat list in
      // place — replay-chat toggle, membership-gate flip, or its own chat
      // reload — without a document reload, orphaning that node. The old
      // observers then watch a detached element that never fires again, so
      // ingest and deletion detection go silently dead for the rest of the
      // session. attach() (re)binds to the current node; a liveness poll below
      // re-attaches on a swap.
      let liveObservers = []
      const attach = (el, processExisting) => {
        // untrackObserver (not bare disconnect) so re-attaches don't grow
        // cleanup's tracked-observer set unbounded across repeated swaps.
        for (const o of liveObservers) cleanup.untrackObserver(o)
        liveObservers = []

        // Only seed from existing children on the first attach. On a re-attach
        // the new list may redisplay messages we already ingested (e.g. a
        // live→replay flip), and re-processing them would double-post; missing
        // a few in-flight rows during a rare mode switch is the safer trade.
        if (processExisting) {
          for (const child of el.children) {
            cleanup.raf(() => processNode(child))
          }
        }

        // Watch for new messages
        const observer = new MutationObserver((mutations) => {
          for (const mut of mutations) {
            for (const node of mut.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue
              cleanup.raf(() => processNode(node))
            }
          }
        })
        cleanup.trackObserver(observer)
        observer.observe(el, { childList: true })

        // Detect moderator deletions: YT either swaps in a deleted-message-renderer
        // or stamps `is-deleted` / clears #message text on the original renderer.
        const deletionObserver = new MutationObserver((mutations) => {
          for (const mut of mutations) {
            // Renderer replaced with deleted variant
            for (const node of mut.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue
              if (node.tagName === 'YT-LIVE-CHAT-DELETED-MESSAGE-RENDERER') {
                broadcastDeletion(node, 'deleted')
              }
            }
            // Existing renderer mutated
            if (mut.type === 'attributes' && mut.attributeName === 'is-deleted') {
              broadcastDeletion(mut.target, mut.target.getAttribute('is-deleted') || 'deleted')
            }
          }
        })
        cleanup.trackObserver(deletionObserver)
        deletionObserver.observe(el, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['is-deleted'],
        })

        liveObservers = [observer, deletionObserver]
      }

      attach(container, true)

      // Self-heal: poll the node's liveness rather than watch a stable ancestor
      // subtree — on a busy chat that would fire our callback on every message
      // (needless work on low-RAM hardware). One isConnected check every few
      // seconds costs nothing and re-attaches within the poll interval.
      let reattaching = false
      const reattachIfSwapped = () => {
        if (signal.aborted) return
        // waitForContainer can pend up to 15s; the poll keeps firing meanwhile,
        // so guard against stacking concurrent waits on the same dead node.
        if (!container.isConnected && !reattaching) {
          reattaching = true
          log('chat container swapped — re-attaching observers')
          waitForContainer()
            .then((el) => {
              if (signal.aborted) return
              container = el
              attach(container, false)
            })
            .catch((err) => {
              if (!signal.aborted && err?.message !== 'aborted') log('re-attach failed:', err.message)
            })
            .finally(() => {
              reattaching = false
            })
        }
        if (!signal.aborted) cleanup.setTimeout(reattachIfSwapped, 5000)
      }
      cleanup.setTimeout(reattachIfSwapped, 5000)

      // bfcache: only abort on real unloads — a persisted page may be
      // restored with this same closure, and the AbortController is
      // single-use (mirrors content.js/bootstrap.js pagehide handling).
      window.addEventListener(
        'pagehide',
        (ev) => {
          if (!ev.persisted) ac.abort()
        },
        { signal },
      )

      log('observer active, videoId:', videoId)

      // Setup autocomplete after a short delay (input may not be ready yet)
      if (!signal.aborted) cleanup.setTimeout(setupAutocomplete, 500)
    } catch (err) {
      log('init failed:', err.message)
      // waitForContainer rejecting means YouTube's chat list never mounted —
      // chat disabled or members-gated, a replay-only page, or YT moved the
      // markup. Every native surface (emote images, cosmetics, the mod probe)
      // then silently never turns on, which from the outside is identical to a
      // quiet channel. This script only runs on /live_chat*, so there is no
      // ordinary page where the timeout is expected and toasting is noise.
      // 'aborted' is our own teardown on nav/pagehide, not a failure.
      if (!signal.aborted && err?.message !== 'aborted') {
        try {
          showYtToast('heatsync could not attach to this chat')
        } catch (_) {}
      }
    }
  }

  init()
})()
