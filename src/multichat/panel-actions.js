// chat hide/show toggle + edge pill, popout, sub button, and the panel status
// banners (api / auth / emote-login nudge) — split out of main.js (2026-10-04).
// pure move; loaded after chat-position.js (chatPosition state it reads).

// ============================================
// CHAT HIDE/SHOW TOGGLE — \ key + edge-pill.
// TAB-LOCAL on purpose (viewer ask): hiding chat on one stream must not
// hide it on every other open tab. The hidden state lives in this page's
// runtime + sessionStorage (per browser tab, survives reload/SPA nav) and
// is NEVER written to the synced chatPosition setting. chatPositionPrevious
// still syncs so restore lands on the last-known visible position.
// ============================================
let chatPositionPrevious = 'right'
let chatHiddenLocal = false

function _saveChatHiddenLocal() {
  try {
    if (chatHiddenLocal) sessionStorage.setItem('hs-chat-hidden-local', '1')
    else sessionStorage.removeItem('hs-chat-hidden-local')
  } catch (_) {}
}

function toggleChatHidden() {
  if (document.body.classList.contains('hs-popout')) return
  const visible = ['right', 'bottom', 'left', 'top']
  if (chatPosition === 'hidden') {
    chatHiddenLocal = false
    chatPosition = visible.includes(chatPositionPrevious) ? chatPositionPrevious : 'right'
    // The synced setting already holds a visible position — hide never
    // writes it (and boot heals legacy stored-'hidden'). Local apply only.
    applyChatPosition()
  } else {
    if (visible.includes(chatPosition)) {
      chatPositionPrevious = chatPosition
      saveUiSetting('chatPositionPrevious', chatPositionPrevious)
    }
    chatHiddenLocal = true
    chatPosition = 'hidden' // runtime only — the synced setting keeps the visible position
    applyChatPosition()
  }
  _saveChatHiddenLocal()
  log('[chat-toggle] →', chatPosition, 'local-only:', chatHiddenLocal, 'prev:', chatPositionPrevious)
}

// Edge-pill: orange strip pinned to the edge where chat last lived. Click to
// restore (not a resize bar) — kept visible/thick on purpose, #fff, no text.
function ensureChatRestorePill(show) {
  let pill = document.getElementById('hs-chat-restore-pill')
  if (!show) {
    if (pill) pill.remove()
    return
  }
  if (!pill) {
    pill = document.createElement('div')
    pill.id = 'hs-chat-restore-pill'
    pill.title = 'show chat (\\)'
    pill.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toggleChatHidden()
    })
    pill.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(pill)
  }
  const edge = ['right', 'bottom', 'left', 'top'].includes(chatPositionPrevious) ? chatPositionPrevious : 'right'
  pill.dataset.edge = edge
}

// Resolve the channel context to popout for the active tab.
// Returns { name, twitch, kick, youtube } or null if no channel context.
function resolvePopoutContext() {
  const id = currentTab
  if (!id) return null
  // Per-channel tab → use its config row directly
  if (_isChatTab(id) && id !== 'live') {
    const ch = (config.channels || []).find((c) => c.id === id)
    if (!ch) return null
    return { name: ch.id, twitch: ch.twitch || '', kick: ch.kick || '', youtube: ch.youtube || '' }
  }
  // Live tab → use the live channel for the host platform
  if (id === 'live') {
    const ch = (getLiveChannel() || '').toLowerCase()
    if (!ch) return null
    const ctx = { name: ch, twitch: '', kick: '', youtube: '' }
    if (hostPlatform === 'twitch') ctx.twitch = ch
    else if (hostPlatform === 'kick') ctx.kick = ch
    else if (hostPlatform === 'yt') ctx.youtube = ch
    return ctx.twitch || ctx.kick || ctx.youtube ? ctx : null
  }
  return null
}

// Pop out the active tab to the host platform's native chat popout window
// (twitch.tv / kick.com / youtube.com). When a tab is linked to multiple
// platforms, prefer the platform we're currently browsing on so the user
// gets the chat for the page they're already watching.
function openPopoutForCurrentTab() {
  const ctx = resolvePopoutContext()
  if (!ctx) return

  // Pick which platform's native chat to open. Prefer host platform if the
  // tab has a channel for it; else fall back to whichever platform exists.
  const hostPick =
    hostPlatform === 'twitch' && ctx.twitch
      ? 'twitch'
      : hostPlatform === 'kick' && ctx.kick
        ? 'kick'
        : hostPlatform === 'yt' && ctx.youtube
          ? 'youtube'
          : null
  const platform = hostPick || (ctx.twitch ? 'twitch' : ctx.kick ? 'kick' : ctx.youtube ? 'youtube' : null)
  if (!platform) return

  let url,
    features = 'width=400,height=600,menubar=no,toolbar=no,location=no,status=no'
  if (platform === 'twitch') {
    url = `https://www.twitch.tv/popout/${ctx.twitch}/chat?popout=`
  } else if (platform === 'kick') {
    url = `https://kick.com/popout/${ctx.kick}/chat`
  } else if (platform === 'youtube') {
    // A YouTube pop-out is CHAT-ONLY (youtube.com/live_chat) — never the whole
    // watch page. Resolve a concrete live videoId from every source we trust,
    // tab-scoped first: the poller-cached link for this tab, then a watch/live
    // url stored in ctx.youtube, then (only when we're on a youtube page) the
    // current page url or the auto-live stream. A channel/handle url has NO
    // videoId → nothing to pop out; show that instead of opening a full page
    // with the video + title + description (which is not a chat pop-out).
    const link = youtubeLinks.get(currentTab)
    const videoId =
      link?.videoId ||
      extractYoutubeVideoId(ctx.youtube) ||
      (hostPlatform === 'yt' ? extractYoutubeVideoId(location.href) || _autoYtVideoId || '' : '')
    if (!videoId) {
      showToast(t('mc_main_no_yt_stream'), 'info')
      return
    }
    url = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`
  }
  try {
    window.open(url, `hs-popout-${platform}-${ctx.name}`, features)
  } catch (e) {
    log('popout open failed:', e)
  }
}

// Show the popout button when the active tab has a channel context.
// Hidden on static tabs (feed/mentions/whispers/pinned/settings/add).
function updatePopoutBtnVisibility() {
  const btn = tabBarElement?.querySelector('.hs-mc-popout-btn')
  if (!btn) return
  btn.style.display = resolvePopoutContext() ? '' : 'none'
}

// Platform subscribe deep-links for a channel tab. The money path must
// never dead-end: twitch/kick land on the real checkout, youtube lands on
// the channel with the subscribe confirm (join/membership sits right next
// to it when the channel has one — a /join deep-link 404-pages channels
// without memberships, so we deliberately don't use it).
function channelSubLinks(ch) {
  const links = []
  if (!ch) return links
  if (ch.twitch)
    links.push({ label: 'sub — twitch', url: `https://www.twitch.tv/subs/${encodeURIComponent(ch.twitch)}` })
  if (ch.kick) links.push({ label: 'sub — kick', url: `https://kick.com/${encodeURIComponent(ch.kick)}` })
  if (ch.youtube) {
    try {
      const u = new URL(ch.youtube)
      const m = u.pathname.match(/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/)
      if (u.protocol === 'https:' && /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(u.hostname) && m) {
        links.push({ label: 'sub — youtube', url: `https://www.youtube.com/${m[1]}?sub_confirmation=1` })
      }
    } catch (_) {}
  }
  return links
}

// One platform → straight to its sub page. Simulcast tab → tiny picker,
// same square black chrome as the tab context menu.
function openSubForCurrentTab(anchorEl) {
  const links = channelSubLinks(getChannelById(currentTab))
  if (!links.length) return
  if (links.length === 1) {
    window.open(links[0].url, '_blank', 'noopener')
    return
  }
  document.getElementById('hs-mc-ctx-menu')?.remove()
  const menu = document.createElement('div')
  menu.id = 'hs-mc-ctx-menu'
  menu.style.cssText =
    'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'
  for (const l of links) {
    const item = document.createElement('div')
    item.textContent = l.label
    item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#ff8700;'
    item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.06)'), {
      signal: mcSignal,
    })
    item.addEventListener('mouseleave', () => (item.style.background = ''), { signal: mcSignal })
    item.addEventListener('click', () => {
      menu.remove()
      window.open(l.url, '_blank', 'noopener')
    })
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
  const r = anchorEl?.getBoundingClientRect?.()
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight
  menu.style.left = `${Math.min(r ? r.left : 0, window.innerWidth - mw - 4)}px`
  menu.style.top = `${Math.min(r ? r.bottom + 2 : 0, window.innerHeight - mh - 4)}px`
  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove()
      document.removeEventListener('click', dismiss)
    }
  }
  cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
}

// $ shows only when the active tab has at least one platform sub target.
function updateSubBtnVisibility() {
  const btn = tabBarElement?.querySelector('.hs-mc-sub-btn')
  if (!btn) return
  btn.style.display = channelSubLinks(getChannelById(currentTab)).length ? '' : 'none'
}

// Drop a panel callout (status/error banner) directly below the search/filter
// bar — never above it, where it would shove the filter input down on reload.
// Falls back to the container top only if the overlay isn't mounted yet.
function _insertPanelCallout(el) {
  const searchBar = document.getElementById('hs-mc-search-bar')
  if (searchBar?.parentNode) {
    searchBar.parentNode.insertBefore(el, searchBar.nextSibling)
    return
  }
  const container = document.getElementById('hs-mc-container')
  if (container) container.insertBefore(el, container.firstChild)
}

// Render a small banner inside the multichat panel when an upstream API is unreachable.
// Auto-removes when state flips back to 'up'. Only renders when our panel is mounted.
function showApiStatusBanner(source, state) {
  const container = document.getElementById('hs-mc-container')
  if (!container) return
  const id = `hs-mc-api-banner-${(source || 'unknown').replace(/[^a-z0-9_-]/gi, '')}`
  const existing = document.getElementById(id)
  if (state === 'up') {
    existing?.remove()
    return
  }
  if (existing) return
  const banner = document.createElement('div')
  banner.id = id
  banner.className = 'hs-mc-api-banner'
  banner.style.cssText =
    'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
  const label = source === 'heatsync' ? 'heatsync.org unreachable — reconnecting' : `${source} unreachable`
  const text = document.createElement('span')
  text.textContent = label
  const dismiss = hsXButton('hs-x-inline', 'dismiss', () => banner.remove())
  banner.append(text, dismiss)
  _insertPanelCallout(banner)
}

// Auth banner: shown when bg signals loggedIn=false AND the user has at least
// one channel with a youtube URL — YT chat needs server-side scraping, which
// requires auth, so without it the user sees zero YT messages and no clue why.
function showAuthLoginBanner(loggedIn) {
  const container = document.getElementById('hs-mc-container')
  if (!container) return
  const id = 'hs-mc-auth-banner'
  const existing = document.getElementById(id)
  if (loggedIn) {
    existing?.remove()
    return
  }
  const hasYt = Array.isArray(config?.channels) && config.channels.some((c) => c.youtube)
  if (!hasYt) {
    existing?.remove()
    return
  }
  if (existing) return
  const banner = document.createElement('div')
  banner.id = id
  banner.className = 'hs-mc-auth-banner'
  banner.style.cssText =
    'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
  const text = document.createElement('span')
  text.textContent = 'youtube chat needs heatsync login —'
  const link = document.createElement('a')
  link.href = 'https://heatsync.org/settings/account'
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = 'sign in'
  link.style.cssText = 'color:#000;text-decoration:underline;font-weight:700;'
  const dismiss = hsXButton('hs-x-inline', 'dismiss', () => banner.remove())
  dismiss.style.marginLeft = '4px'
  banner.append(text, link, dismiss)
  _insertPanelCallout(banner)
}

// Persistent one-click login nudge — shown when someone tries to collect/use an
// emote while signed out of heatsync. Their emotes render for nobody and vanish
// on refresh until they log in; a transient toast never conveys that, so people
// conclude the ext is broken. Square, terminal, dead-simple: one button to
// login. Auto-dismisses on successful login (auth_changed) and on any
// successful add (emote_added). Idempotent.
function showEmoteLoginNudge() {
  const container = document.getElementById('hs-mc-container')
  if (!container) return
  const id = 'hs-mc-emote-login-nudge'
  if (document.getElementById(id)) return
  const banner = document.createElement('div')
  banner.id = id
  banner.className = 'hs-mc-auth-banner'
  banner.style.cssText =
    'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
  const text = document.createElement('span')
  text.textContent = 'log in to heatsync so your emotes work for everyone'
  const link = document.createElement('a')
  link.href = 'https://heatsync.org/login'
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = 'log in'
  // nowrap so the link never splits across lines when the panel is narrow
  link.style.cssText = 'color:#000;text-decoration:underline;font-weight:700;cursor:pointer;white-space:nowrap;'
  const dismiss = hsXButton('hs-x-inline', 'dismiss', () => banner.remove())
  dismiss.style.marginLeft = '4px'
  banner.append(text, link, dismiss)
  _insertPanelCallout(banner)
}
function dismissEmoteLoginNudge() {
  document.getElementById('hs-mc-emote-login-nudge')?.remove()
}
