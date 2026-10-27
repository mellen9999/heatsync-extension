// player-volume.js — every channel remembers its own volume.
//
// Runs in the top frame of twitch / kick / youtube AND inside their player
// iframes (player.twitch.tv, player.kick.com, youtube.com/embed), so one rule
// covers the native sites, heatsync.org's embeds, and the link embeds the
// extension draws in chat. A cross-origin iframe has no API a parent page can
// call, but the extension is a content script IN that frame, with the <video>
// in reach.
//
// What it does, in one breath: you move a player's volume, we remember it for
// that channel; next time that channel's player loads, it comes back at that
// volume. Optionally a channel that has no memory yet starts at a default you
// pick (so a stranger's stream never opens at full blast).
//
// Nothing leaves the browser: the map lives in chrome.storage.local.
//
// The page races us. Twitch restores ITS volume when the player mounts, after
// the <video> exists, so the first apply can be overwritten. For a short
// window after each apply, a volume change that did not follow a click, key or
// wheel on the page is put back; once the window closes, every change is yours.

;(() => {
  if (globalThis.__hsPlayerVolumeLoaded) return
  globalThis.__hsPlayerVolumeLoaded = true

  const STORE_KEY = 'hs_channel_volume'
  const SETTINGS_KEY = 'ui_settings'
  const MAX_ENTRIES = 400
  // a volumechange this soon after a real input on the page is the reader's
  const USER_INPUT_MS = 900
  const MUTE_WINDOW_MS = 1500
  // how long after an apply we defend it against the page's own restore
  const GUARD_MS = 4000
  const SAVE_DEBOUNCE_MS = 500

  // ── pure core (exported for tests) ───────────────────────────────────────

  // first path segments that are pages, not channels
  const TWITCH_RESERVED = new Set([
    'directory',
    'videos',
    'settings',
    'subscriptions',
    'wallet',
    'inventory',
    'drops',
    'friends',
    'prime',
    'turbo',
    'jobs',
    'store',
    'search',
    'downloads',
    'p',
    'u',
    'embed',
    'clip',
    'clips',
    'following',
    'team',
    'about',
    'legal',
    'login',
    'signup',
    'messages',
    'payments',
  ])
  const KICK_RESERVED = new Set([
    'categories',
    'category',
    'browse',
    'video',
    'videos',
    'clips',
    'clip',
    'search',
    'dashboard',
    'following',
    'emotes',
    'settings',
    'subscriptions',
    'about',
    'login',
    'signup',
    'terms',
    'privacy',
    'support',
    'creator',
    'u',
    'stream',
  ])

  const clean = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()

  /** A twitch/kick login or slug: letters, digits, underscore (kick also dash). */
  const isHandle = (s, dash) => (dash ? /^[a-z0-9_-]{2,40}$/ : /^[a-z0-9_]{2,25}$/).test(s)

  /**
   * The channel this frame is playing, as a stable key — or null when it
   * cannot be known (a VOD, a directory page, a youtube embed with no channel
   * link yet). Never guesses: a wrong key would hand one channel's volume to
   * another.
   * @param {{hostname:string, pathname:string, search:string}} loc
   * @param {(sel:string)=>string|null} [ytChannelHref] reads the youtube channel link off the DOM
   */
  function channelKey(loc, ytChannelHref) {
    const host = clean(loc.hostname)
    const segs = String(loc.pathname || '')
      .split('/')
      .filter(Boolean)
    const q = new URLSearchParams(loc.search || '')

    if (host === 'player.twitch.tv') {
      // ?channel= is a live stream; ?video= is a VOD, which has no channel memory
      const ch = clean(q.get('channel'))
      return isHandle(ch) ? `twitch:${ch}` : null
    }
    if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
      let name = clean(segs[0])
      if (name === 'popout' || name === 'moderator') name = clean(segs[1])
      if (TWITCH_RESERVED.has(name)) return null
      return isHandle(name) ? `twitch:${name}` : null
    }

    if (host === 'player.kick.com') {
      const slug = clean(segs[0])
      return isHandle(slug, true) && !KICK_RESERVED.has(slug) ? `kick:${slug}` : null
    }
    if (host === 'kick.com' || host.endsWith('.kick.com')) {
      let slug = clean(segs[0])
      if (slug === 'popout') slug = clean(segs[1])
      if (KICK_RESERVED.has(slug)) return null
      return isHandle(slug, true) ? `kick:${slug}` : null
    }

    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      const p = segs[0]
      // watch pages, live pages and embeds only; never shorts, home, search
      if (!(p === 'watch' || p === 'live' || p === 'embed')) return null
      const href = ytChannelHref ? ytChannelHref() : null
      if (!href) return null
      const m = String(href).match(/\/(@[A-Za-z0-9._-]+|channel\/(UC[A-Za-z0-9_-]{20,}))/)
      if (!m) return null
      return `youtube:${clean(m[2] || m[1])}`
    }
    return null
  }

  const clamp01 = (n) => Math.min(1, Math.max(0, n))

  /** Record a channel's volume; the map stays bounded, oldest-touched first out. */
  function remember(map, key, volume, now) {
    const next = { ...map }
    delete next[key] // re-insert so insertion order is recency
    next[key] = [Math.round(clamp01(volume) * 1000) / 1000, now]
    const keys = Object.keys(next)
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete next[keys[i]]
    return next
  }

  /** The volume to start a channel at: its own memory, else the default, else leave it. */
  function volumeFor(map, key, defaultVolume) {
    const hit = map?.[key]
    if (hit && Number.isFinite(hit[0])) return clamp01(hit[0])
    return defaultVolume > 0 ? clamp01(defaultVolume) : null
  }

  globalThis.__hsPlayerVolumeCore = { channelKey, remember, volumeFor, MAX_ENTRIES }
  if (globalThis.__HS_PV_TEST__) return

  // ── page glue ────────────────────────────────────────────────────────────

  const api = typeof browser !== 'undefined' && browser.storage ? browser : chrome
  if (!api?.storage?.local) return

  let enabled = true
  let sites = { twitch: true, kick: true, youtube: true }
  let defaultVolume = 0
  let map = {}
  let lastInputAt = 0

  const readSettings = (ui) => {
    enabled = ui?.channelVolumeMemory !== false
    sites = {
      twitch: ui?.channelVolumeTwitch !== false,
      kick: ui?.channelVolumeKick !== false,
      youtube: ui?.channelVolumeYouTube !== false,
    }
    const d = Number(ui?.channelVolumeDefault)
    defaultVolume = Number.isFinite(d) && d > 0 ? clamp01(d) : 0
  }

  // Real input on THIS document: how a reader's change tells itself apart from
  // the page restoring its own volume.
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(
      ev,
      () => {
        lastInputAt = Date.now()
      },
      { capture: true, passive: true },
    )
  }
  const userJustActed = () => Date.now() - lastInputAt < USER_INPUT_MS

  // Unmuting is not a volume choice: twitch and kick answer it by rewriting
  // video.volume from their own saved state, which would pass for the reader
  // dragging the slider. A mute click (or the m key) opens a window in which
  // the remembered level wins and nothing is saved.
  const MUTE_CTL =
    '[data-a-target="player-mute-unmute-button"], .ytp-mute-button, button[aria-label*="mute" i], button[title*="mute" i]'
  let lastMuteAt = 0
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target?.closest?.(MUTE_CTL)) lastMuteAt = Date.now()
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) lastMuteAt = Date.now()
    },
    { capture: true, passive: true },
  )
  const muteJustToggled = () => Date.now() - lastMuteAt < MUTE_WINDOW_MS

  const ytChannelHref = () => {
    const sels = [
      '[itemprop="author"] link[itemprop="url"]',
      'ytd-watch-metadata ytd-video-owner-renderer a[href]',
      '#owner a[href^="/@"], #owner a[href^="/channel/"]',
      '.ytp-title-channel a[href], a.ytp-title-link[href]',
    ]
    for (const s of sels) {
      const el = document.querySelector(s)
      const h = el?.href || el?.getAttribute?.('href')
      if (h && /\/(@|channel\/)/.test(h)) return h
    }
    return null
  }

  // a key reads "<platform>:<channel>"; one platform off leaves its players alone
  const siteOn = (key) => sites[String(key).split(':')[0]] !== false
  const keyNow = () => {
    const k = channelKey(location, ytChannelHref)
    return k && siteOn(k) ? k : null
  }

  /** One state record per <video>; WeakMap so a torn-down player is simply collected. */
  const states = new WeakMap()

  function attach(video) {
    if (states.has(video)) return
    const st = { key: null, target: null, guardUntil: 0, saveTimer: 0, retry: 0 }
    states.set(video, st)

    const apply = () => {
      if (!enabled) return
      const key = keyNow()
      if (!key) return false
      if (key === st.key && st.target !== null) return true
      const v = volumeFor(map, key, defaultVolume)
      st.key = key
      st.target = v
      if (v === null) return true // nothing to restore: leave the page's own volume alone
      st.guardUntil = Date.now() + GUARD_MS
      if (Math.abs(video.volume - v) > 0.001) video.volume = v
      return true
    }

    // A channel's name can lag the <video> (youtube fills its owner link in
    // after the player). Look again a few times, then give up quietly.
    const resolve = () => {
      clearTimeout(st.retry)
      if (apply() !== false) return
      let n = 0
      const again = () => {
        if (apply() !== false || ++n >= 6) return
        st.retry = setTimeout(again, 700)
      }
      st.retry = setTimeout(again, 400)
    }

    const onVolume = () => {
      if (!enabled || st.key === null) return
      if (muteJustToggled()) {
        if (st.target !== null && !video.muted && Math.abs(video.volume - st.target) > 0.001) video.volume = st.target
        return
      }
      if (st.target !== null && Date.now() < st.guardUntil && !userJustActed()) {
        // the page's own restore, not the reader: put ours back
        if (Math.abs(video.volume - st.target) > 0.001) video.volume = st.target
        return
      }
      if (!userJustActed()) return // a programmatic change we did not cause: not a decision
      // muted is a state, not a volume: dragging to mute must not forget the level
      if (video.muted) return
      clearTimeout(st.saveTimer)
      st.saveTimer = setTimeout(() => {
        const key = st.key
        if (!key) return
        st.target = clamp01(video.volume)
        st.guardUntil = 0
        map = remember(map, key, video.volume, Date.now())
        Promise.resolve(api.storage.local.set({ [STORE_KEY]: { v: 1, map } })).catch(() => {})
      }, SAVE_DEBOUNCE_MS)
    }

    video.addEventListener('loadedmetadata', () => {
      st.key = null
      st.target = null
      resolve()
    })
    video.addEventListener('emptied', () => {
      st.key = null
      st.target = null
    })
    video.addEventListener('volumechange', onVolume)
    if (video.readyState >= 1) resolve()
  }

  const scan = (root) => {
    if (root.nodeType !== 1) return
    if (root.tagName === 'VIDEO') attach(root)
    for (const v of root.querySelectorAll?.('video') || []) attach(v)
  }

  function boot() {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) scan(n)
    }).observe(document.documentElement, { childList: true, subtree: true })
    scan(document.documentElement)
    // a youtube SPA navigation keeps the same <video>; re-resolve its channel
    document.addEventListener('yt-navigate-finish', () => {
      for (const v of document.querySelectorAll('video')) {
        const st = states.get(v)
        if (st) {
          st.key = null
          st.target = null
          v.dispatchEvent(new Event('loadedmetadata'))
        }
      }
    })
  }

  Promise.all([api.storage.local.get(STORE_KEY), api.storage.sync.get(SETTINGS_KEY)])
    .then(([local, sync]) => {
      map = local?.[STORE_KEY]?.map || {}
      readSettings(sync?.[SETTINGS_KEY])
      boot()
    })
    .catch(() => {})

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SETTINGS_KEY]) readSettings(changes[SETTINGS_KEY].newValue)
    // another frame or tab remembered a channel: take its entry, never our stale copy
    if (area === 'local' && changes[STORE_KEY]) map = changes[STORE_KEY].newValue?.map || {}
  })
})()
