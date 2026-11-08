// part 4 of 8 of the multichat main body — notifs, fonts, tab bar updates, render patching, tab and channel management, watchdog.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

// (automod moved to automod.js)

// Server-side heat spike (moment detector) → inline 🔥 row in all chats.
// Dedupe per channel per 10min mirrors the server cooldown so multi-source
// delivery (reconnects) can't double-post.
const _momentSeen = new Map()
function handleMomentSpike(d) {
  if (!d?.channel) return
  // relevance filter — the server broadcasts spikes for EVERY tracked
  // channel (the site's rail/hot page want that breadth); the inline 🔥
  // alert is personal: only channels in YOUR tabs or the one you're
  // watching. without this, 199-channel coverage = spam about strangers.
  const chLc = String(d.channel).toLowerCase()
  const relevant =
    (config?.channels || []).some(
      (c) => (c?.twitch && c.twitch.toLowerCase() === chLc) || (c?.kick && c.kick.toLowerCase() === chLc),
    ) ||
    (typeof getCurrentChannel === 'function' && (getCurrentChannel() || '').toLowerCase() === chLc)
  if (!relevant) return
  const key = `${d.platform}:${d.channel}`
  const now = Date.now()
  if (now - (_momentSeen.get(key) || 0) < 10 * 60_000) return
  _momentSeen.set(key, now)
  if (_momentSeen.size > 200) {
    const k0 = _momentSeen.keys().next().value
    _momentSeen.delete(k0)
  }
  injectInlineNotif('moment', {
    type: 'moment',
    momentId: d.id != null ? String(d.id) : null,
    momentChannel: d.channel,
    momentPlatform: d.platform || 'twitch',
    text: t('mc_main_moment', [d.channel, String(d.rate), String(Math.max(1, Math.round(d.baseline)))]),
    color: '#fff',
    time: now,
  })
}

// Inject an inline notification into active chat tabs
function injectInlineNotif(notifType, msg, opts = {}) {
  // opts.force — receipts for something YOU just did (posting from chat)
  // aren't notifications about other people, so the per-type toggle that
  // silences other users' feed posts must not also silence your own.
  if (!inlineNotifs[notifType] && !opts.force) return
  const typeDef = INLINE_NOTIF_TYPES[notifType]
  if (!typeDef) return

  msg.inlineNotifType = notifType
  msg.inlineNotifColor = typeDef.color
  msg.inlineNotifBorderColor = typeDef.borderColor
  msg.inlineNotifLabel = typeDef.tag
  if (msg.type === 'feed-post' && !opts.onlyTab) saveInlineNotif(notifType, msg)

  // opts.onlyTab — scope persistence + live-append to ONE tab's buffer(s)
  // instead of broadcasting to every channel (channel-scoped command
  // receipts: a /ban shown in another channel's tab would read as a ban
  // there). 'live' resolves the anonymous live channel by name (it has no
  // config.channels entry); anything else is a configured channel id.
  if (opts.onlyTab) {
    const tabId = opts.onlyTab
    if (tabId === 'live') {
      const liveCh = getLiveChannel()?.toLowerCase()
      if (liveCh) {
        irc?.channels?.get(liveCh)?.push(msg)
        kickChat?.channels?.get(liveCh)?.push(msg)
      }
    } else {
      const ch = getChannelById(tabId)
      if (ch?.twitch) irc?.channels?.get(ch.twitch)?.push(msg)
      if (ch?.kick) kickChat?.channels?.get(ch.kick)?.push(msg)
      const ytBuf = channelYtMessages.get(tabId)
      if (ytBuf) {
        ytBuf.push(msg)
        if (ytBuf.length > PERSIST_MAX_YT) ytBuf.splice(0, ytBuf.length - PERSIST_MAX_YT)
      }
    }
    if (currentTab === tabId) appendMessage(msg, tabId)
    return
  }

  // Persist into ALL channel buffers (IRC + Kick + YouTube) so notification appears on every tab
  for (const ch of config.channels) {
    const twitchName = ch?.twitch
    const kickName = ch.kick
    const chId = ch?.id
    const buffer = (twitchName && irc?.channels?.get(twitchName)) || (kickName && kickChat?.channels?.get(kickName))
    if (buffer) buffer.push(msg)
    // Also inject into YouTube channel buffers
    const ytBuf = chId && channelYtMessages.get(chId)
    if (ytBuf) {
      ytBuf.push(msg)
      if (ytBuf.length > PERSIST_MAX_YT) ytBuf.splice(0, ytBuf.length - PERSIST_MAX_YT)
    }
  }

  // Live-append to current tab if it's a chat tab
  const active = currentTab
  const isChatTab = active === 'live' || active === 'mentions' || config.channels.some((ch) => ch.id === active)
  if (isChatTab) appendMessage(msg, active)
}

// Slash-command receipts — one inline row per side-effecting /command: the
// text as typed, pending, then a checkmark or an X + why. Driven by
// runSlashCommandWithReceipt (input.js); this half owns the row's DOM life.
// onlyTab (channel-scoped commands) is the tab the command was sent from —
// omit it for account-level commands that broadcast to every chat tab.
function beginCmdReceipt(text, onlyTab) {
  const sendId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const msg = { type: 'cmd-receipt', id: sendId, sendId, text, status: 'pending', time: Date.now() }
  injectInlineNotif('cmd', msg, { force: true, onlyTab })
  return msg
}

// Mutates the buffered message in place (so a later render of ANY tab
// holding it — global-scope commands push the SAME object into every
// buffer — picks up the final state for free) and patches every live DOM
// copy directly, the same data-send-id pattern the whisper echo uses for
// its failed-mark, so a row already on screen updates without a re-render.
function settleCmdReceipt(msg, ok, reason) {
  if (!msg) return
  msg.status = ok ? 'ok' : 'failed'
  msg.reason = ok ? '' : reason || ''
  for (const el of document.querySelectorAll(`[data-send-id="${msg.sendId}"]`)) {
    el.classList.toggle('hs-cmd-failed', !ok)
    const mark = el.querySelector('.hs-cmd-mark')
    if (mark) {
      mark.textContent = ok ? '✓' : `✗${msg.reason ? ` ${msg.reason}` : ''}`
      mark.className = `hs-cmd-mark ${ok ? 'hs-cmd-ok' : 'hs-cmd-fail'}`
    }
  }
}

// Font family + size — mirrors heatsync.org's appearance picker.
// 'monospace' (default) is the host system's monospace, 'twitch' the
// platform sans, 'custom' uses settings.customFontName. No web fonts ship.
// Apply via CSS vars on #hs-mc-container so storage.onChanged can flip
// it live without rebuilding the panel.
function resolveFontStack(family, customName) {
  if (family === 'twitch') return "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"
  if (family === 'custom') {
    const name = (customName || '').trim()
    if (name) return `'${name.replace(/'/g, '')}', monospace`
  }
  return 'monospace'
}
function applyFontSettings(fontFamily, fontSize, customFontName) {
  if (fontFamily === 'GohuFont' || fontFamily === 'CozetteVector' || fontFamily === 'DepartureMono') {
    fontFamily = 'monospace'
  }
  // One size policy, shared with the settings UI and the site: font-grid.js.
  fontSize = snapSize(fontFamily, fontSize)
  // Set the vars on :root FIRST, unconditionally — the panel often mounts
  // AFTER settings load (the load-time applier ran with no container), so a
  // non-default size used to silently fall back to 13px until the user poked
  // a setting. :root always exists and the panel inherits from it, so the
  // size lands on the first paint. Container writes below are belt-and-braces.
  const stack = resolveFontStack(fontFamily, customFontName)
  const root = document.documentElement
  root.style.setProperty('--hs-mc-font', stack)
  const sizeNum = parseInt(fontSize, 10)
  if (sizeNum >= 10 && sizeNum <= 26) {
    // One synced size drives both the panel chrome and the message area —
    // the old per-device override (F+/F-) folded into this setting.
    root.style.setProperty('--hs-mc-base-size', `${sizeNum}px`)
    root.style.setProperty('--hs-chat-font', `${sizeNum}px`)
  }
  const container = document.getElementById('hs-mc-container')
  if (!container) return
  container.style.setProperty('--hs-mc-font', stack)
  if (sizeNum >= 10 && sizeNum <= 26) {
    container.style.setProperty('--hs-mc-base-size', `${sizeNum}px`)
    container.style.setProperty('--hs-chat-font', `${sizeNum}px`)
    const msgsEl = document.getElementById('hs-mc-messages')
    if (msgsEl) msgsEl.style.setProperty('--hs-chat-font', `${sizeNum}px`)
  }
}

// Tab subsystems — a disabled subsystem hides its tab affordance too
const _TAB_SUBSYSTEM = { feed: 'feed', whispers: 'whispers', mentions: 'mentions' }
function applyHiddenTabs() {
  if (!tabBarElement) return
  for (const id of HIDABLE_TABS) {
    const btn = tabBarElement.querySelector(`.hs-mc-tab[data-tab="${id}"]`)
    const subOff = _TAB_SUBSYSTEM[id] && !isEnabled(_TAB_SUBSYSTEM[id])
    if (btn) btn.style.display = hiddenTabs.has(id) || subOff ? 'none' : ''
  }
  const curOff = _TAB_SUBSYSTEM[currentTab] && !isEnabled(_TAB_SUBSYSTEM[currentTab])
  if (hiddenTabs.has(currentTab) || curOff) {
    const to = liveTarget()
    if (to !== currentTab) switchTab(to)
  }
}

// Background chest-claim sweeper. Chests spawn every ~15min during active
// viewing and expire after ~15min unclaimed. 5min poll catches each within
// its claim window. Calls fetchChannelRewards (from twitch-api.js) which
// returns availableClaim id, then claimCommunityPoints fires the GQL mutation
// and emits a toast on success.
let _autoClaimPoller = null
let _autoClaimSweepInFlight = false
async function _autoClaimSweep() {
  if (_autoClaimSweepInFlight || !autoClaimPoints) return
  _autoClaimSweepInFlight = true
  try {
    const seen = new Set()
    const channels = (config.channels || [])
      .map((c) => (c.twitch || '').toLowerCase().trim())
      .filter((ch) => {
        if (!ch || seen.has(ch)) return false
        seen.add(ch)
        return true
      })
    for (let i = 0; i < channels.length; i++) {
      if (!autoClaimPoints) break
      const ch = channels[i]
      try {
        const r = await fetchChannelRewards(ch)
        if (r?.availableClaim && r.channelId) {
          await claimCommunityPoints(r.availableClaim, r.channelId, ch)
        }
      } catch (_) {}
      if (i < channels.length - 1) await new Promise((res) => setTimeout(res, 2000))
    }
  } finally {
    _autoClaimSweepInFlight = false
  }
}
function startAutoClaimPoller() {
  if (_autoClaimPoller || !autoClaimPoints) return
  cleanup.setTimeout(_autoClaimSweep, 20000)
  _autoClaimPoller = cleanup.setInterval(_autoClaimSweep, 5 * 60 * 1000)
}
function stopAutoClaimPoller() {
  if (!_autoClaimPoller) return
  cleanup.clearInterval(_autoClaimPoller)
  _autoClaimPoller = null
}

// One-shot per videoId: ask BG to turn a bare videoId into the channel's
// @handle (oEmbed, cached there) so a watch-URL tab gets a real name. Both
// outcomes are recorded — a video that can't resolve (private, deleted,
// rate-limited) must not re-fetch on every tab repaint.
const _ytLabelTried = new Set()
function resolveYtTabLabel(chId, videoId) {
  if (!videoId || _ytLabelTried.has(videoId)) return
  _ytLabelTried.add(videoId)
  safeSendMessage({ type: 'yt_channel_handle', videoId })
    .then((r) => {
      const handle = r?.handle
      if (!handle) return
      const prev = youtubeLinks.get(chId) || {}
      if (prev.channelName === handle) return
      youtubeLinks.set(chId, { ...prev, channelName: handle })
      updateTabBar()
    })
    .catch(() => {})
}

function updateTabBar() {
  if (!tabBarElement) return

  // Every add/remove-channel path calls updateTabBar() right after mutating
  // config.channels — single chokepoint to keep hs-twitch-no-channel-empty
  // (empty-panel hide) in sync without threading a call through every one of
  // those call sites. Only the empty flag: see syncTwitchNoChannelEmpty for
  // why this must never re-run the layout probe.
  if (hostPlatform === 'twitch' && typeof syncTwitchNoChannelEmpty === 'function') {
    try {
      syncTwitchNoChannelEmpty()
    } catch (_) {}
  }

  // Clear existing channel tabs (keep built-in tabs). NOTE: the exclusion list
  // must cover EVERY util button or this strips it — native + actions live in
  // the util-row (createTabBar) with their own data-tab, so without excluding
  // them updateTabBar (runs on every channel load) silently removes the ⇄ / ⚡
  // buttons right after they render. That was "BUG 1: ⇄ missing on kick".
  const existingChannelTabs = tabBarElement.querySelectorAll(
    `.hs-mc-tab[data-tab]${mcChromeTabIds()
      .map((id) => `:not([data-tab="${id}"])`)
      .join('')}`,
  )
  existingChannelTabs.forEach((t) => {
    t.remove()
  })

  // Add channel tabs before the + button in the scroll section
  const scrollSection = tabBarElement.querySelector('.hs-mc-tabs-scroll') || tabBarElement
  const addBtn = scrollSection.querySelector('[data-tab="add"]')
  config.channels.forEach((ch) => {
    const tab = document.createElement('button')
    tab.className = 'hs-mc-tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', 'false')
    const id = ch.id
    tab.dataset.tab = id
    // Show best human-readable name. Order:
    //   1. ch.twitch / ch.kick if present
    //   2. resolved channelName from youtubeLinks (set by youtube_status)
    //   3. @handle parsed from the youtube URL
    //   4. ch.id when it looks like a real handle (i.e. user-named, not a
    //      generated `linked_<ts>` / `yt-<ts>` id)
    //   5. URL fallback (last resort — would have shown "watch?v=…" before)
    let label = id
    if (ch.twitch) label = ch.twitch
    else if (ch.kick) label = ch.kick
    else if (ch.youtube) {
      const linked = youtubeLinks.get(ch.id)
      // A bare handle ("lofigirl") is what the website syncs; a pasted url
      // carries it after an @.
      const m = ch.youtube.match(/@([^/?]+)/) || ch.youtube.match(/^([\w.-]+)$/)
      const looksAuto = !ch.id || /^(linked|yt|kick|twitch|tab)[-_]\d+/.test(ch.id)
      if (linked?.channelName) label = linked.channelName
      else if (m) label = m[1]
      else if (!looksAuto) label = ch.id
      else {
        // Adding a channel by pasting a /watch?v= link lands here: no
        // @handle in the URL, and channelName only ever gets filled by a
        // youtube_status for a stream that's actually connected — so an
        // offline one kept this fallback forever and the tab read
        // "watch?v=VGe-dpUmnos". Resolve the handle off the videoId once
        // (BG already does this via oEmbed for the subscribe path) and
        // repaint. Until it lands, show the video id alone rather than the
        // URL guts.
        const vid = ch.youtube.match(/[?&]v=([\w-]{11})|\/live\/([\w-]{11})/)
        const videoId = vid ? vid[1] || vid[2] : ''
        label = videoId || ch.youtube.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '')
        if (videoId) resolveYtTabLabel(ch.id, videoId)
      }
    }
    tab.textContent = label
    // Restore live dot from cached liveChannelSet (survives tab recreate).
    // Check BOTH twitch and kick slugs — a Kick-only channel or a paired
    // channel whose twitch handle differs from its kick slug would otherwise
    // miss the dot. SW followed snapshot already populates kick slugs into
    // liveChannelSet at line ~8908.
    if (liveChannelSet.size > 0 || _swLiveSet?.size > 0) {
      if (tabIsLiveFromSets(ch)) tab.dataset.live = 'true'
      else if (ch.twitch || ch.kick || !ch.youtube) tab.dataset.live = 'false'
    }
    // YT-only tabs aren't in liveChannelSet (which is Twitch-only), so
    // re-derive live state from the resolved YouTube subscription. This
    // also wins the race when the youtube_status connected event arrived
    // before the tabbar was rendered.
    if (ch.youtube && !ch.twitch && !ch.kick) {
      const ytLink = youtubeLinks.get(ch.id)
      if (ytLink?.videoId) tab.dataset.live = 'true'
    }
    if (addBtn) addBtn.before(tab)
    else scrollSection.appendChild(tab)
  })

  // Update active state
  tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
    setTabActive(t, t.dataset.tab === currentTab)
  })

  applyHiddenTabs()
  // a saved tab may now cover the page channel (or have stopped covering it)
  syncLiveTab()
  // The tabs above were rebuilt from scratch and their labels written with
  // textContent, which drops the counter chip — repaint it, or the number
  // vanishes on every live-status poll and channel edit.
  refreshTabCounters()
}

// ============================================
// RENDER PATCHING (FFZ-STYLE CORE)
// ============================================

/**
 * Patch a component's render method to inject our UI
 * This is the FFZ approach - modify render output, don't manipulate DOM
 */
function patchChatRoomRender(component) {
  if (!component?.instance?.render) {
    log('Cannot patch - no render method')
    return false
  }

  const inst = component.instance
  if (inst._hs_multichat_patched) {
    log('Already patched')
    return true
  }

  originalRender = inst.render.bind(inst)

  inst.render = () => {
    const result = originalRender()

    // If result is null or not an object, return as-is
    if (!result || typeof result !== 'object') return result

    // Clone the result to avoid mutating React's internals
    // We'll inject our tab bar at the top level
    // Elements are in #hs-mc-container (outside React's tree)
    // so no need to re-inject on every render

    return result
  }

  inst._hs_multichat_patched = true
  log('✅ Patched chat room render')

  // Force initial re-render
  if (typeof inst.forceUpdate === 'function') {
    inst.forceUpdate()
  }

  return true
}

/**
 * FFZ-style: Fix chat column transform bug
 * Twitch applies translateX(-34rem) even when --expanded class is set
 * We fix this persistently via multiple layers
 */

// Layer 1: CSS override (always active, catches most cases)
function injectTransformOverrideCss() {
  if (document.getElementById('hs-chat-transform-fix')) return
  const style = document.createElement('style')
  style.id = 'hs-chat-transform-fix'
  style.textContent = `
      /* Fix inner column transform — must be 'none', not translateX(0),
         because any transform value creates a containing block that breaks
         position:fixed on descendant elements (tab bar goes off-screen).
         Kill the transition too — without it Twitch's 500ms transform
         transition keeps interpolating to translateX(-340px) on every
         class flip, leaving the panel partially off-screen. */
      .channel-root__right-column--expanded {
        transform: none !important;
        transition: none !important;
      }
      /* Fix collapse/expand arrow — Twitch applies translateX(-340px) to
         slide it with the chat panel animation, but our layout changes make
         the transform wrong. Kill both transform and its transition (the
         transition fights !important by interpolating from the old value). */
      .right-column__toggle-visibility {
        transform: none !important;
        transition: none !important;
      }
    `
  document.head.appendChild(cleanup.trackNode(style))
  log('✅ Injected chat column CSS fixes')
}

// Fix inline transform that Twitch's CSS-in-JS sets on the inner column.
// CSS rule handles the class-based override; this catches inline style overrides.
function fixChatTransform() {
  const expanded = document.querySelector('.channel-root__right-column--expanded')
  if (!expanded) return false

  const transform = expanded.style.transform || getComputedStyle(expanded).transform
  if (transform && transform !== 'none') {
    expanded.style.setProperty('transform', 'none', 'important')
    return true
  }
  return false
}

// Layer 3: Watch for class/style changes on BOTH column elements
let columnObserver = null
function startColumnClassWatcher() {
  if (columnObserver) return // Already watching

  const inner = document.querySelector('.channel-root__right-column')
  const outer = document.querySelector('.right-column.right-column--beside')

  if (!inner && !outer) return

  columnObserver = cleanup.trackObserver(
    new MutationObserver((records) => {
      // A style-only change is our own width write (applyChatWidth, the
      // resize drag's release) — rebuilding the panel and re-rendering every
      // row for it froze the page ~150ms per drag. Only twitch flips the class.
      const classChanged = records.some((r) => r.attributeName === 'class')
      // When class/style changes, fix both elements
      cleanup.raf(() => {
        fixChatTransform()
        applyChatWidth()
        // Re-render after expand — container was display:none while collapsed
        const rightCol = document.querySelector('.right-column')
        if (classChanged && rightCol && !rightCol.classList.contains('right-column--collapsed')) {
          ensureUIElements()
          renderMessages(currentTab)
        }
      }, 'column-transform-fix')
    }),
    'column-class-watcher',
  )

  const config = { attributes: true, attributeFilter: ['class', 'style'] }

  if (inner) columnObserver.observe(inner, config)
  if (outer) columnObserver.observe(outer, config)

  log('✅ Started column watchers (inner + outer)')
}

// Polling removed — CSS rule + MutationObserver handle all cases.
// The 500ms polling was redundant and caused layout fighting.

function ensureChatColumnVisible() {
  // CSS override + observer (no polling, no parent walking)
  injectTransformOverrideCss()
  startColumnClassWatcher()

  // One-time fix for current state
  fixChatTransform()

  // Return the chat column for injection purposes
  return (
    document.querySelector('[data-a-target="right-column-chat-bar"]') ||
    document.querySelector('.channel-root__right-column')
  )
}

/**
 * Alternative approach: Use MutationObserver + strategic element injection
 * This is more reliable than render patching for layout elements
 */
/**
 * Get or create the HeatSync container OUTSIDE React's DOM tree.
 * Placed as a sibling of chatRoom so React can't destroy our elements.
 */
function getOrCreateHsContainer(chatRoom) {
  let container = document.getElementById('hs-mc-container')
  if (container && document.contains(container)) return container
  container = Object.assign(document.createElement('div'), { id: 'hs-mc-container', dir: HS_DIR() })
  // Keep a live reference: twitch commits the chat-shell unmount BEFORE
  // pushState on some SPA transitions (channel → /directory), so by the time
  // the nav event fires the panel is detached and invisible to
  // getElementById. softTwitchNav re-adopts this node with its state intact.
  _hsMcContainerNode = container
  // The panel reserves a 28px strip while a status banner is its child. That used to be a :has() rule on
  // the container, which costs every style recalc in the page (~100ms with the list full): the class is
  // derived from the container's own children here instead, one cheap childList observer.
  const _syncBannerStrip = () =>
    container.classList.toggle(
      'hs-has-banner',
      !!container.querySelector(
        ':scope > .hs-mc-auth-banner, :scope > .hs-mc-api-banner, :scope > [class*="hs-mc-api-banner-"]',
      ),
    )
  const _bannerObs = new MutationObserver(_syncBannerStrip)
  _bannerObs.observe(container, { childList: true })
  cleanup.trackObserver(_bannerObs)
  // On Kick: insert as SIBLING of #channel-chatroom (not child!) to avoid
  // breaking Kick's React virtual scroll. React's reconciliation errors
  // corrupt native chat when our container is inside its managed tree.
  // On Twitch: insert into chat-shell (which has proper dimensions)
  // On YouTube: insert after the live chat frame in #chat-container or #secondary
  let parent
  if (hostPlatform === 'yt') {
    // Hide native YouTube chat iframe wherever it is in the tree. YT loads
    // the frame LATE on slow streams — if it isn't there yet, watch for it,
    // or the user sees the native "Live chat / open panel" card fighting
    // the overlay. data-hs-hidden marks frames we hid so teardown only
    // restores our own work.
    const hideYtFrame = () => {
      const f = document.querySelector('ytd-live-chat-frame#chat')
      if (!f) return false
      if (ytOwnsChat()) return true
      if (f.style.display !== 'none') {
        const frameHeight = f.offsetHeight || 500
        f.dataset.hsPrevDisplay = f.style.display ?? ''
        f.dataset.hsHidden = '1'
        f.style.display = 'none'
        window._hsYtChatFrameHeight = frameHeight
        container.style.cssText = `height:${frameHeight}px;overflow:hidden;`
      }
      return true
    }
    if (!hideYtFrame()) {
      const frameWatch = new MutationObserver(() => {
        if (hideYtFrame()) frameWatch.disconnect()
      })
      frameWatch.observe(document.documentElement, { childList: true, subtree: true })
      mcSignal.addEventListener('abort', () => frameWatch.disconnect(), { once: true })
    }
    // Append to <body> instead of nesting inside #chat-container. On
    // narrow / single-column viewports YT collapses the right sidebar and
    // moves #chat-container into #below, which YT (and our own CSS at
    // body.hs-platform-yt #below) sets to display:none — taking our
    // position:fixed panel down with it. Body is the only stable parent.
    parent = document.body
    parent.appendChild(container)
    // Teardown: restore native iframe display and remove our body-appended
    // container so disabling/reloading the extension doesn't leave the YT
    // chat permanently hidden. mcSignal aborts on pagehide and on full
    // lifecycle teardown.
    mcSignal.addEventListener(
      'abort',
      () => {
        const f = document.querySelector('ytd-live-chat-frame#chat[data-hs-hidden]')
        if (f) {
          f.style.display = f.dataset.hsPrevDisplay || ''
          delete f.dataset.hsHidden
          delete f.dataset.hsPrevDisplay
        }
        if (container && container.parentElement === document.body) {
          container.remove()
        }
      },
      { once: true },
    )
  } else if (isKick) {
    if (chatRoom) {
      parent = chatRoom.parentElement
      chatRoom.after(container)
      // Same teardown contract as the body-mount branches: without it,
      // disabling/reloading the extension strands a zombie panel in kick's DOM.
      mcSignal.addEventListener(
        'abort',
        () => {
          if (container?.isConnected) container.remove()
        },
        { once: true },
      )
    } else {
      // No #channel-chatroom on this Kick URL (browse, settings, search,
      // categories, …) — body-mount as a position:fixed overlay via the
      // hs-kick-no-channel CSS rules. Same teardown contract as Twitch.
      parent = document.body
      parent.appendChild(container)
      mcSignal.addEventListener(
        'abort',
        () => {
          if (container && container.parentElement === document.body) container.remove()
        },
        { once: true },
      )
    }
  } else {
    // Twitch: prefer chat-shell on channel pages (preserves theatre/persistent
    // -player layout). Fall back to <body> on non-channel pages (directory,
    // settings, videos, …) where chat-shell doesn't exist — panel becomes a
    // position:fixed overlay via the hs-twitch-no-channel CSS rules.
    const chatShell =
      document.querySelector('.chat-shell') || document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL)
    if (chatShell) {
      parent = chatShell
      parent.appendChild(container)
      mcSignal.addEventListener(
        'abort',
        () => {
          if (container?.isConnected) container.remove()
        },
        { once: true },
      )
    } else {
      parent = document.body
      parent.appendChild(container)
      mcSignal.addEventListener(
        'abort',
        () => {
          if (container && container.parentElement === document.body) container.remove()
        },
        { once: true },
      )
    }
  }
  log('Created #hs-mc-container in', `${parent.tagName}.${[...parent.classList].join('.')}`)
  // Reposition the unified resize handle now that the container has a real
  // rect. On no-chat pages (Twitch /directory etc) applyChatPosition fired
  // before this point with cont=null, so the handle was stranded at 0,0.
  requestAnimationFrame(() => {
    try {
      positionChatResizeHandle()
    } catch (_) {}
  })
  return container
}

function ensureUIElements() {
  // Re-assert the stylesheet — twitch SPA navigations can sweep injected
  // <style> tags from <head>, leaving a remounted overlay fully unstyled
  // (raw text flow). injectStyles is idempotent (id check), so this is a
  // getElementById per call when healthy.
  try {
    injectStyles()
  } catch (_) {}

  // Always watch for collapse/expand class changes so we can clean up
  // inline styles when the user clicks the expand arrow
  if (hostPlatform !== 'yt') startColumnClassWatcher()

  // Don't fight Twitch when chat is collapsed — let the native expand arrow work
  if (hostPlatform !== 'yt') {
    const rightCol = document.querySelector('.right-column')
    const collapsed = rightCol?.classList.contains('right-column--collapsed')
    if (collapsed) return
    // Make sure chat column is visible (only when expanded)
    ensureChatColumnVisible()
  }

  // Find the React-controlled chat room
  let chatRoom
  if (hostPlatform === 'yt') {
    chatRoom =
      document.querySelector('#chat-container') ||
      document.querySelector('ytd-live-chat-frame#chat')?.parentElement ||
      document.querySelector('#secondary')
  } else if (isKick) {
    chatRoom = document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]')
  } else {
    chatRoom =
      document.querySelector('[class*="chat-room__content"]') ||
      document.querySelector('[data-a-target="chat-room-component"]') ||
      document.querySelector('.chat-shell') ||
      document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT) ||
      document.querySelector('.chat-room')
  }

  // Non-channel pages (Twitch /directory, Kick /browse, /categories,
  // YT home/search) have no chat-shell / #channel-chatroom. Fall
  // through with chatRoom=null so getOrCreateHsContainer body-mounts
  // the panel as a position:fixed overlay. Panel persists across
  // every SPA nav on all three platforms.

  // Transform fix handled by CSS (#hs-chat-transform-fix) + MutationObserver.
  // No parent tree walking — it displaced the collapse arrow.

  // Get our container outside React's tree
  const container = getOrCreateHsContainer(chatRoom)

  // Ensure tab bar exists
  if (!tabBarElement || !document.contains(tabBarElement)) {
    const existing = document.getElementById('hs-mc-tabbar')
    if (existing) {
      tabBarElement = existing
      log('Reclaimed existing tab bar')
    } else {
      tabBarElement = createTabBar()
      updateTabBar()
      if (!liveStatusInterval) startLiveStatusPolling()
      log('Created tab bar')
    }
  }
  if (!container.contains(tabBarElement)) {
    container.insertBefore(tabBarElement, container.firstChild)
    log('Inserted tab bar into container')
  }

  // Ensure overlay exists
  if (!overlayElement || !document.contains(overlayElement)) {
    const existing = document.getElementById('hs-mc-overlay')
    if (existing) {
      overlayElement = existing
      log('Reclaimed existing overlay')
    } else {
      overlayElement = createOverlay()
      log('Created overlay')
    }
  }
  if (!container.contains(overlayElement)) {
    container.appendChild(overlayElement)
    log('Injected overlay into container')
  }

  // Ensure emote picker panel exists (between overlay and inputbar)
  let pickerEl = document.getElementById('hs-mc-emote-picker')
  if (!pickerEl) {
    pickerEl = document.createElement('div')
    pickerEl.id = 'hs-mc-emote-picker'
  }
  if (!container.contains(pickerEl)) {
    container.appendChild(pickerEl)
  }

  // Ensure input bar exists
  if (!inputBarElement || !document.contains(inputBarElement)) {
    inputBarElement = createInputBar()
    // Start hidden — typing reveals it (never in the pop-out: it stays put +
    // focused). A rebuild with a draft pending (twitch swapped the container
    // mid-typing) must stay visible, or the restored draft hides with the
    // bar and reads as "my message got eaten".
    if (!tabAcceptsInput(currentTab) || (canAutoHideInput() && !pendingMessage.trim())) {
      inputBarElement.classList.add('hs-hidden')
      inputBarVisible = false
    } else {
      // Born visible — say so. A rebuild during the keepComposerOpen window
      // (or with a draft pending) left the flag on its pre-rebuild `false`
      // while the fresh bar carried no hs-hidden class, and that stranded
      // combination is unrecoverable on its own: hideInputBar() bails on the
      // flag, so the empty bar stays up until something types into it.
      inputBarVisible = true
    }
    log('Created input bar')
  }
  if (!container.contains(inputBarElement)) {
    container.appendChild(inputBarElement)
    log('Injected input bar into container')

    // Wire handlers + restore the draft NOW — createInputBar defers its own
    // initInput behind setTimeout(0), and keystrokes landing in that gap
    // bypass pendingMessage tracking (the draft then vanishes on the next
    // rebuild). initInput is idempotent, so the deferred call no-ops.
    initInput()
    // Restore pending message if any (skip if initInput already did, or the
    // user typed into the fresh input first — never clobber live content)
    const input = document.getElementById('hs-mc-input')
    if (input && pendingMessage && !(input.value || input.textContent || '').trim()) {
      if (input.isContentEditable) input.textContent = pendingMessage
      else input.value = pendingMessage
    }
  }

  // Adjust overlay/inputbar/tabbar geometry based on actual tabbar+inputbar
  // dimensions — handles multi-row tabbar wrapping AND vertical tab columns.
  // Single source of truth so CSS hardcodes don't drift from real layout.
  let _lastMcLayoutSig = ''
  _updateMcLayout = () => {
    if (!tabBarElement || !overlayElement) return
    // Every read comes before every <html> custom-property write (the layer
    // vars, --hs-panel-w): a read after one restyles the whole host page on
    // the spot — on twitch that froze the drag release.
    const tabRect = tabBarElement.getBoundingClientRect()
    const tw = tabRect.width
    const th = tabRect.height
    const ih = inputBarElement ? inputBarElement.getBoundingClientRect().height : 0
    // No-op when nothing that drives the insets changed. The ResizeObserver
    // fires on every inputbar box mutation — while TYPING in the wysiwyg
    // composer that's every keystroke, and the remove+reapply below
    // invalidates layout for the whole overlay each time (visible churn on
    // the rows above the composer). Signature covers every input the
    // positioning + HsNotifs geometry read.
    const _containerEl = document.getElementById('hs-mc-container')
    // Search-bar visibility feeds the statusbar layer's top offset — include
    // it in the signature or a mentions↔chat tab hop with identical channel
    // sets would skip the recompute and leave the toast strip misanchored.
    const _searchVis = document.getElementById('hs-mc-search-bar')?.classList.contains('visible') ? 1 : 0
    const _sig = `${tabPosition}|${tw}|${th}|${ih}|${_searchVis}|${_containerEl ? _containerEl.offsetHeight : 0}|${[...getActiveViewedChannels()].join(',')}`
    // Panel width (chat + tab strip) drives the chat-left player inset via
    // --hs-panel-w. Published on every pass — this runs on cold-load layout
    // and via the tab/input ResizeObserver — so the inset is correct before
    // the first drag-resize. Measured now, written last.
    const panelW = _containerEl ? _containerEl.offsetWidth : 0
    if (_sig === _lastMcLayoutSig) {
      publishPanelWidth(panelW)
      return
    }
    _lastMcLayoutSig = _sig

    // Reset before re-applying to avoid stale rules between transitions
    for (const el of [overlayElement, inputBarElement, tabBarElement]) {
      if (!el) continue
      el.style.removeProperty('top')
      el.style.removeProperty('bottom')
      el.style.removeProperty('left')
      el.style.removeProperty('right')
    }

    if (tabPosition === 'top') {
      if (th > 0) overlayElement.style.top = `${th}px`
      overlayElement.style.bottom = `${ih}px`
    } else if (tabPosition === 'bottom') {
      overlayElement.style.top = '0px'
      overlayElement.style.bottom = `${th + ih}px`
      // Park tabbar directly above inputbar
      if (tabBarElement) tabBarElement.style.bottom = `${ih}px`
    } else if (tabPosition === 'right') {
      overlayElement.style.top = '0px'
      overlayElement.style.bottom = `${ih}px`
      if (tw > 0) {
        overlayElement.style.right = `${tw}px`
        if (inputBarElement) inputBarElement.style.right = `${tw}px`
      }
    } else if (tabPosition === 'left') {
      overlayElement.style.top = '0px'
      overlayElement.style.bottom = `${ih}px`
      if (tw > 0) {
        overlayElement.style.left = `${tw}px`
        if (inputBarElement) inputBarElement.style.left = `${tw}px`
      }
    }

    // An open picker mirrors the message list's box exactly — re-measure it
    // here, the one place that knows the chat body just moved (tab bar grew a
    // row, composer shown/hidden, tab position rotated).
    syncPickerBox()

    // Recompute geometry for ALL HsNotifs layers in one place. Each layer's
    // CSS vars (--hs-layer-*-{top|left|right|bottom}) drive its container's
    // CSS positioning. Adding a new layer = registerLayer + matching CSS.
    const containerEl = document.getElementById('hs-mc-container')
    try {
      HsNotifs.updateLayout({
        overlayElement,
        inputBarElement,
        tabBarElement,
        containerElement: containerEl,
        tabPosition,
        activeChannels: getActiveViewedChannels(),
      })
    } catch (_) {}
    publishPanelWidth(panelW)
  }

  // Re-observe on every pass, not just the first. The bug this fixes: the tab
  // bar is `flex-wrap: wrap` with a max-height, so during boot it measures
  // ~307px while still wrapped to five rows, then settles to 55px a moment
  // later. The ResizeObserver that should catch that shrink was created once
  // behind a `!resizeObserver` guard — so after any rebuild it was pointed at
  // a DETACHED tab bar, the shrink never fired _updateMcLayout, and the
  // overlay kept the boot-time inset for the rest of the session: ~510px of
  // chat instead of ~828px, with 318px of dead space under it.
  if (tabBarElement && overlayElement) {
    const watch = inputBarElement ? [tabBarElement, inputBarElement] : [tabBarElement]
    const stale = !resizeObserver || watch.length !== _roWatched.length || watch.some((el, i) => el !== _roWatched[i])
    if (stale) {
      if (resizeObserver) cleanup.untrackObserver(resizeObserver)
      resizeObserver = new ResizeObserver(_updateMcLayout)
      for (const el of watch) resizeObserver.observe(el)
      cleanup.trackObserver(resizeObserver)
      _roWatched = watch
    }
    // Always recompute: a rebuild gives _updateMcLayout a fresh closure with
    // an empty _lastMcLayoutSig, and the fresh tab/input nodes carry none of
    // the inline insets the old ones had.
    _updateMcLayout()
  }

  // Twitch resub-share callout: swap the native Pin toggle for our own X
  // close button. The native Pin pins the resub message to Twitch's chat
  // (which we hide), so it just dismisses the callout with nothing visible
  // afterward. Our X just clears the callout from view — Share button is
  // untouched.
  setupHsCalloutCloseButton()

  // Auto-show overlay if not already visible
  if (overlayElement && !overlayElement.classList.contains('visible')) {
    overlayElement.classList.add('visible')
    if (!currentTab) {
      currentTab = 'live'
      if (tabBarElement) {
        tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
          setTabActive(t, t.dataset.tab === 'live')
        })
      }
    }
    renderMessages(currentTab)
    log('Auto-showed overlay on load')
  }
  // Always reveal container — when overlay is reclaimed (SPA persist /
  // re-mount), the visible-gated branch above is skipped and the
  // container would stay at opacity:0. Idempotent — no-ops when no prepaint.
  tearDownPrepaint()

  // Ensure resize handle exists on left edge of chat panel
  if (hostPlatform === 'yt') {
    setupYouTubeResizeHandle()
  } else if (isKick) {
    setupKickResizeHandle()
    watchKickViewportClamp()
  } else {
    setupResizeHandle()
    watchTwitchPersistentPlayer()
  }
  // Platform-specific handles are only used when chatPosition === 'right'.
  // hidePlatformResizeHandles ran earlier from applyChatPosition before
  // these setup* calls created the handle elements, so any non-right mode
  // would leave a stray handle (e.g. the orange vertical bar on the left
  // of chat-bottom). Re-apply now with the freshly-created handles in DOM.
  if (chatPosition && chatPosition !== 'right') hidePlatformResizeHandles(true)

  // Ensure native chat is hidden when our UI is active.
  setNativeChatHidden(true)
}

// ============================================
// TAB/CHANNEL MANAGEMENT
// ============================================

// Tab id → the surface name the server counts (site-stats.ts EXT_SURFACES),
// reported from switchTab because that is the one choke point every surface
// change goes through.
//
// Only the social surfaces and "is using chat at all" are named. The tabs
// below are deliberately uncounted — they say nothing about whether anyone
// reaches the social layer, which is the only question this measures. Any id
// that is neither is a channel tab (the SPECIAL set in renderTabs is the
// other half of this list) and means multichat is in use.
const _UNCOUNTED_TABS = new Set(['discover', 'pinned', 'modlog', 'add', 'settings'])
function _reportSurfaceOpen(id) {
  const surface =
    id === 'feed'
      ? 'feed'
      : id === 'whispers'
        ? 'dm'
        : id === 'mentions'
          ? 'mentions'
          : _UNCOUNTED_TABS.has(id)
            ? null
            : 'multichat'
  if (!surface) return
  // Never awaited and never retried past safeSendMessage's own backoff: a
  // counter must not be able to delay or break a tab switch.
  try {
    safeSendMessage({ type: 'hs_surface_open', surface })
  } catch (_) {}
}

// switchTab(tab, sub): a tab with a 2nd row opens at `sub`, else the cell
// last used there, else its first. Same tab + new cell only swaps the cell.
function switchTab(id, sub, subOpts) {
  const _swStart = performance.now()
  const _swPhase = {}
  _restoreParts = null
  log('switchTab called:', id, sub || '')
  if (!_autoSwitching) _bouncedFromLive = ''
  // the temp tab is gone while a saved tab covers the page channel (or the page
  // has none): any stray 'live' lands on liveTarget() instead
  if (id === 'live' && _liveSyncArmed && !liveTabShown()) id = liveTarget()
  ;({ id, sub } = mcCanonTab(id, sub))
  const nextSub = mcResolveSub(id, sub, lastSubByTab)
  if (id === currentTab && sub && nextSub === sub) {
    applySub(id, nextSub, subOpts)
    return
  }
  if (id === 'settings' && nextSub) _setSettingsSubtab(nextSub) // before the pane renders
  _reportSurfaceOpen(id)
  // Leaving an edit form: drop the outgoing tab's cache and clear msgsEl so
  // the upcoming snapshotTabState doesn't capture the form (which would then
  // be restored when switching back to the same channel id and look like
  // "save didn't exit").
  if (editingChannel) {
    _dropTabCache(currentTab)
    const _msgsEl = document.getElementById('hs-mc-messages')
    if (_msgsEl) _msgsEl.textContent = ''
  }
  editingChannel = false
  // Tab switch is the user telling us they care about live state right
  // now — kick a debounced refresh so any stale red dots on channel tabs
  // get corrected without waiting up to 30s for the next poll cycle.
  try {
    refreshLiveStatusSoon()
  } catch {}
  // …and a full-size picture: the switch repaints the pane itself
  if (typeof imgViewDrop === 'function') imgViewDrop()
  // Tab switch closes profile card without re-rendering (we'll render the tab below)
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) {
    activeProfileCard = null
    // the card's DOM must not be snapshotted as the outgoing tab's rows: it
    // would come back on a later switch with no card state behind it, and
    // ← back (which reads that state) would have nothing to close
    _dropTabCache(currentTab)
    const _cardEl = document.getElementById('hs-mc-messages')
    if (_cardEl) _cardEl.textContent = ''
  }
  hsTakeoverSync()
  // …and so does an open confirm panel (the switch repaints the 2nd row itself)
  hsPanePanelAbort()

  // Clicking feed tab (relabeled "back") while in thread view → close the
  // thread. If we entered from a channel tab, return THERE, not the feed —
  // switchTab(rt) with currentTab still 'feed' also runs the thread-cleanup
  // block below (nulls activeThread, resets the feed tab label). Otherwise
  // just close and stay on the feed.
  if (id === 'feed' && currentTab === 'feed' && activeThread) {
    if (threadReturnTab && threadReturnTab !== 'feed') {
      const rt = threadReturnTab
      threadReturnTab = null
      switchTab(rt)
    } else {
      closeThread()
    }
    return
  }

  // Close thread view when leaving feed
  if (currentTab === 'feed' && id !== 'feed') {
    activeThread = null
    feedThreadSync(null)
    _clearFeedReplyChip()
    const feedTabBtn = tabBarElement?.querySelector('[data-tab="feed"]')
    if (feedTabBtn) feedTabBtn.textContent = t('mc_tab_feed')
  }
  if (currentTab !== 'settings') prevTab = currentTab
  // Snapshot the outgoing tab's DOM into the cache so a future switch back
  // restores it instantly (no rebuild). Skipped for static tabs which manage
  // their own DOM. Must run BEFORE currentTab flips.
  finishFirstPaint()
  flushHeldOlder()
  snapshotTabState(currentTab)
  currentTab = id
  _scrollbackWindow = 0 // new tab starts at the live tail, not prior scrollback depth
  markTabSeen(id)

  // Update settings button icon: X when settings open, cog otherwise
  if (tabBarElement) {
    const settingsBtn = tabBarElement.querySelector('[data-tab="settings"]')
    if (settingsBtn) {
      const open = id === 'settings'
      settingsBtn.classList.toggle('hs-x', open)
      if (open) settingsBtn.innerHTML = HS_X_SVG
      else settingsBtn.textContent = '\u2699'
    }
  }
  updatePopoutBtnVisibility()
  updateSubBtnVisibility()

  // Channel/tab switch flips which channel-emote cache the picker reads —
  // mark cache dirty + queue idle prebuild for the new context.
  markPickerDirty()
  prebuildPickerIdle()

  // Mark mentions as seen when switching to that tab
  if (id === 'mentions') {
    bumpSeen('mentions')
    updateTabBadges()
  }
  if (id === 'feed') bumpSeen('live')

  // Search bar: server search on mentions, instant local filter on live/channel tabs.
  const searchBar = document.getElementById('hs-mc-search-bar')
  if (searchBar) searchBar.classList.toggle('visible', id === 'mentions' || isLiveSearchTab(id))
  // Reset the query on tab switch so a live filter doesn't bleed across
  // channels; placeholder reflects the active mode.
  const _searchInputEl = document.getElementById('hs-mc-search-input')
  if (_searchInputEl) {
    _searchInputEl.value = ''
    _searchInputEl.placeholder = isLiveSearchTab(id) ? t('mc_main_filter_ph') : t('mc_main_search_ph')
  }
  const _searchCountEl = document.getElementById('hs-mc-search-count')
  if (_searchCountEl) _searchCountEl.classList.remove('visible')

  // Discover/pinned refresh bars removed — auto-poll handles freshness

  // looking at the mentions tab reads the heatsync notifications (toolbar badge, other devices)
  if (id === 'mentions' && mentionsBuffer.some((x) => x.type === 'inline-notif' && !x.read)) hsNotifsRead()

  // Clear whisper unread when switching to whispers tab — server-backed.
  if (id === 'whispers') {
    bumpSeen('whispers')
    whisperSaveDebounced()
  }

  // Persist active tab across refreshes/popouts (skip transient tabs, and the
  // auto-bounce off an empty watching tab — that is the page's doing, not a pick)
  if (id !== 'add' && !_autoSwitching) {
    try {
      saveUiSetting('activeTab', id)
    } catch (_) {
      /* context invalidated */
    }
  }

  // Update tab bar active state
  if (tabBarElement) {
    const liveCh = getLiveChannel()?.toLowerCase()
    tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
      setTabActive(t, t.dataset.tab === mcRowOwner(id))
      if (t.dataset.tab === id) {
        t.classList.remove('has-new')
        t.classList.remove('has-stream-event')
        t.classList.remove('has-mentions')
        clearTabUnread(t.dataset.tab)
      }
      // Switching to live also clears the matching channel tab's indicators
      if (id === 'live' && liveCh && t.dataset.tab !== 'live') {
        const ch = getChannelById(t.dataset.tab)
        if (ch) {
          const tw = ch.twitch?.toLowerCase()
          const ki = ch.kick?.toLowerCase()
          if (tw === liveCh || ki === liveCh) {
            t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
            clearTabUnread(t.dataset.tab)
          }
        }
      }
      // Switching to a channel tab that matches live clears the live tab too
      if (id !== 'live' && liveCh && t.dataset.tab === 'live') {
        const ch = getChannelById(id)
        if (ch) {
          const tw = ch.twitch?.toLowerCase()
          const ki = ch.kick?.toLowerCase()
          if (tw === liveCh || ki === liveCh) {
            t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
            clearTabUnread(t.dataset.tab)
          }
        }
      }
    })
    // One repaint after the sweep — the loop above may have cleared several
    // tabs, and the newly-active tab's own count has to drop to nothing.
    refreshTabCounters()
  }

  // Update live tab label when switching to it
  if (id === 'live') updateLiveTabLabel()

  // Reset scroll state BEFORE rendering - always start at bottom when switching tabs
  isScrolledUp = false
  newMessageCount = 0
  const newBtn = document.getElementById('hs-mc-new-msgs')
  if (newBtn) newBtn.style.display = 'none'

  // Native chat always hidden — multichat handles all tabs including live on Kick

  // Hide input bar on add-channel form, or when auto-hide is on
  if (inputBarElement) {
    const pickerOpen = document.getElementById('hs-mc-emote-picker')?.classList.contains('visible')
    // No send target on this tab ⇒ no composer, auto-hide setting or not.
    if (!tabAcceptsInput(id)) {
      inputBarElement.classList.add('hs-hidden')
      inputBarVisible = false
    } else if (autoHideEligible() && !pickerOpen) {
      // Eligibility WITHOUT the keepComposerOpen time window: a tab switch
      // isn't the rapid-fire send flow, and force-showing here during the
      // window left an empty bar stuck (nothing re-hides until a later blur).
      const input = document.getElementById('hs-mc-input')
      const hasContent =
        input &&
        ((input.value || input.textContent || '').trim().length > 0 || input.querySelector('img, span.hs-mc-emoji'))
      if (hasContent) {
        inputBarElement.classList.remove('hs-hidden')
        inputBarVisible = true
      } else {
        inputBarElement.classList.add('hs-hidden')
        inputBarVisible = false
      }
    } else {
      inputBarElement.classList.remove('hs-hidden')
      inputBarVisible = true
    }
  }

  if (overlayElement) {
    overlayElement.classList.add('visible')
    // Overlay bottom inset is NOT written here. _updateMcLayout (called at
    // the end of switchTab) owns it, measured from the real inputbar box.
    // Clearing it here dropped the overlay to the stylesheet's 52px
    // fallback, and the layout recompute then skipped the repair (its
    // signature — tab/input sizes — is unchanged by a tab switch), leaving
    // a dead band between the last message and the composer.
    // Restore cached fragment for the incoming tab if we have one. The
    // existing renderMessages diff then operates against pre-painted DOM —
    // it re-adds whatever arrived while the tab was inactive.
    _swPhase.pre = performance.now() - _swStart
    _swPhase.restored = !!restoreTabState(id)
    _swPhase.restore = performance.now() - _swStart - _swPhase.pre
    renderMessages(id)
    _swPhase.render = performance.now() - _swStart - _swPhase.pre - _swPhase.restore
  } else {
    log('No overlay element to show!')
  }

  const _tl0 = performance.now()
  applySub(id, nextSub, subOpts)
  const _tl1 = performance.now()

  // Update input placeholder for new tab
  updateInputPlaceholder()

  // Hide native chat when our overlay is active
  setNativeChatHidden(true)
  const _tl2 = performance.now()

  // Refresh HsNotifs channel scope so per-channel callouts (resub-share,
  // watchstreak) hide when leaving their channel's tab and reappear when
  // returning. Layout call piggybacks on the existing recompute path.
  try {
    _updateMcLayout?.()
  } catch (_) {}
  _swPhase.tail = {
    sub: Math.round(_tl1 - _tl0),
    misc: Math.round(_tl2 - _tl1),
    layout: Math.round(performance.now() - _tl2),
  }
  // A switch that holds the page past a quarter second says where it went —
  // the ring is the only eye on a tab that was too busy to answer.
  const _swTotal = performance.now() - _swStart
  if (_swTotal > 250) {
    hsDiag('tab-switch-slow', {
      id: String(id).slice(0, 24),
      totalMs: Math.round(_swTotal),
      preMs: Math.round(_swPhase.pre || 0),
      restored: !!_swPhase.restored,
      restoreMs: Math.round(_swPhase.restore || 0),
      renderMs: Math.round(_swPhase.render || 0),
      parts: _restoreParts,
      tail: _swPhase.tail,
      rows: document.getElementById('hs-mc-messages')?.childElementCount || 0,
    })
  }
}

// Render-success gate for native-tap.js's suppression decision (point 1)
// and this file's own dead-man watchdog (below). Flips true only after a
// full ensureUIElements/switchTab/startLayoutWatcher pass completes without
// throwing — see the waitForMount/tryHookReact call sites. A throw resets
// it to false so both mechanisms fail open to native chat being visible.
let _hsOverlayRenderOk = false
// Set only by the dead-man watchdog below, cleared the moment a mount pass
// proves the overlay healthy again. Distinguishes "we forced native chat
// back" from "the user asked for it" — only the former may be re-armed.
let _watchdogForcedNative = false
function _markOverlayRenderOk(ok) {
  _hsOverlayRenderOk = !!ok
  // A confirmed mount pass after the watchdog fired means the overlay came
  // good. Re-hide native chat ONCE so a transient boot stall doesn't cost the
  // takeover until reload. If the overlay is genuinely broken this never runs
  // (the pass has to complete without throwing), and if it stalls again the
  // watchdog simply fires again 15s later — the pair self-corrects.
  if (ok && _watchdogForcedNative) {
    _watchdogForcedNative = false
    try {
      setNativeChatHidden(true)
    } catch (_) {}
  }
  try {
    if (typeof setOverlayRenderOk === 'function') setOverlayRenderOk(!!ok)
  } catch (_) {}
  // A successful mount pass proves this boot didn't hit the failure loop —
  // reset early-layout.js's pre-arm retry budget so the NEXT load gets a
  // clean slate (see src/content/early-layout.js's takeoverArms gate).
  if (ok) {
    try {
      localStorage.setItem('hs_layout_takeoverArms', '0')
    } catch (_) {}
  }
}

// Runs one ensureUIElements/switchTab/startLayoutWatcher mount pass. These
// used to run unguarded with `done=true` set beforehand — a throw anywhere
// in the triplet left the overlay container present but empty AND native
// chat already hidden, with nothing to ever undo either. Any throw here
// must fail OPEN: mark render-not-ok (native-tap.js stops suppressing),
// force native chat visible again, and clear the takeover mirror so
// early-layout.js's next-load pre-arm doesn't re-arm suppression blind.
function _runOverlayMountPass(label, fn) {
  try {
    fn()
    _markOverlayRenderOk(true)
  } catch (e) {
    console.warn('[heatsync-ext] overlay mount pass threw:', label, e?.message || e, e?.stack)
    hsDiag('mount_fail', {
      label,
      msg: String(e?.message || e).slice(0, 160),
      at: String(e?.stack || '')
        .split('\n')[1]
        ?.trim()
        .slice(0, 160),
    })
    _markOverlayRenderOk(false)
    try {
      setNativeChatHidden(false)
    } catch (_) {}
    try {
      localStorage.setItem('hs_layout_nativeTakeover', '0')
    } catch (_) {}
  }
}

// Dead-man switch for setNativeChatHidden(true): once `.hs-native-hidden`
// was applied it persisted regardless of whether the overlay kept
// rendering. Poll the heartbeat native-tap.js writes (hsSuppressBeat) plus
// our own render-success flag; force native chat back the moment either
// goes stale so it VISUALLY returns, not just resumes internal message
// flow. Twitch-only — that's the only platform the suppress dataset and
// native-tap.js apply to.
let _nativeHiddenWatchdogStarted = false
function startNativeHiddenWatchdog() {
  if (_nativeHiddenWatchdogStarted || hostPlatform !== 'twitch') return
  _nativeHiddenWatchdogStarted = true
  cleanup.setInterval(() => {
    // Never fire hidden: nothing is visually wrong in a hidden tab, and a
    // hidden force-reveal hands twitch back its untrimmed native chat AND
    // disarms the next-load pre-arm — the failure it guards against can be
    // re-checked on the first visible tick instead.
    if (document.hidden) return
    const ds = document.body?.dataset
    if (ds?.hsSuppressNative !== '1') return
    const beat = parseInt(ds.hsSuppressBeat, 10)
    const stale = !Number.isFinite(beat) || Date.now() - beat > 45000
    if (!stale && _hsOverlayRenderOk) return
    // Say WHICH condition tripped and by how much. The old line named both
    // and committed to neither, so a correct fire (slow cold boot, tap not
    // started yet — working as designed) was indistinguishable from a
    // spurious one on a healthy overlay. One occurrence should be enough to
    // tell them apart, because this is not reproducible on demand.
    const age = Number.isFinite(beat) ? `${Math.round((Date.now() - beat) / 1000)}s` : 'never-written'
    const rows = document.getElementById('hs-mc-messages')?.childElementCount ?? -1
    console.warn(
      `[heatsync-ext] native-hidden watchdog: restoring native chat — beat=${age} stale=${stale} renderOk=${_hsOverlayRenderOk} overlayRows=${rows}`,
    )
    // Remember that WE revealed native chat, not the user. Without this the
    // reveal latches forever: _updateNativeSuppress (native-tap.js) only
    // suppresses while native chat is invisible, so our own remedy trips the
    // "user revealed native chat" guard and suppression can never resume —
    // one 45s timing blip cost the takeover for the rest of the page load.
    _watchdogForcedNative = true
    setNativeChatHidden(false)
    ds.hsSuppressNative = '0'
    try {
      localStorage.setItem('hs_layout_nativeTakeover', '0')
    } catch (_) {}
  }, 15000)
}

/**
 * Toggle native Twitch chat visibility (FFZ-style)
 * Adds class to parent container rather than relying on :has() selector
 */
function setNativeChatHidden(hidden) {
  if (isKick) {
    // A body class, not a class on #channel-chatroom: kick's React rewrites that node's className on its
    // own schedule (seen ~4s after our hide), which silently brought native chat back under the strip.
    document.body.classList.toggle('hs-kick-native-hidden', hidden)
    return
  }

  // Twitch: Add class to chat-shell (outermost container)
  const chatShell = document.querySelector('.chat-shell') || document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL)
  if (chatShell) {
    chatShell.classList.toggle('hs-native-hidden', hidden)
  }

  // Add class to chat-room__content (where our elements are injected)
  const chatRoom =
    document.querySelector('[class*="chat-room__content"]') ||
    document.querySelector('[data-a-target="chat-room-component"]')
  if (chatRoom) {
    chatRoom.classList.toggle('hs-native-hidden', hidden)
  }

  // Also try stream-chat for popout mode
  const streamChat =
    document.querySelector('.stream-chat') || document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT)
  if (streamChat) {
    streamChat.classList.toggle('hs-native-hidden', hidden)
  }
}

function updateTabBadges() {
  refreshSeenBadges()
  if (!tabBarElement) return
  const mentionsTab = tabBarElement.querySelector('[data-tab="mentions"]')
  if (mentionsTab && mentionsTab.textContent !== t('mc_tab_mentions')) mentionsTab.textContent = t('mc_tab_mentions')
}

// Dedup helper: check against actual message buffers (survives WS reconnects)
function isYtDuplicate(user, text, channelId, id) {
  const needle = `${user}:${text.slice(0, 50)}`
  // When both sides carry the server's innertube id, identity is exact —
  // same id = duplicate, different id = genuinely repeated text (a user
  // legitimately spamming the same line must NOT be collapsed). Only the
  // id-less legacy path falls back to the user:text heuristic.
  const isDup = (m) => (id && m.id ? m.id === id : `${m.user}:${(m.text || '').slice(0, 50)}` === needle)
  // Pace queue FIRST: duplicates re-delivered inside the 60-400ms pacing
  // window used to race past the committed-buffer check below, then drain
  // sequentially — the "3 identical copies in a row" bug.
  const q = _ytPaceQueue.get(channelId)
  if (q) {
    for (const m of q) if (isDup(m)) return true
  }
  const buf = channelYtMessages.get(channelId)
  if (!buf || buf.length === 0) return false
  // check last 200 messages in buffer (matches server recentMessages cap)
  const start = Math.max(0, buf.length - 200)
  for (let i = buf.length - 1; i >= start; i--) {
    if (isDup(buf[i])) return true
  }
  return false
}

// Build a message div element (shared by full rebuild and incremental append)
// Note: innerHTML here is safe — badges/emotes are from extension data, user text
// goes through escapeHtml() and processEmotes() which sanitize content
// Compute a message's rendered text HTML (emotes + YT emoji + mention
// highlights + cheermotes), cached on m._renderedHtml. Extracted from
// buildMessageDiv so the in-place emote reload (reprocessEmoteTextInPlace)
// produces BYTE-IDENTICAL output to a fresh rebuild — one source of truth,
// no drift.
// @param {object} m  message object (m.text, m.channel, m.twitchEmotes, …)
// @returns {string}  sanitized HTML for the message text span
function computeMessageText(m) {
  if (m._renderedHtml != null) return m._renderedHtml
  // Pass Twitch native emotes (per-message IRC tags) into processEmotes so
  // they participate in the overlay-stack pipeline alongside 7TV emotes.
  const isOwn = isSelf(m)
  let twitchExtra = null
  if (m.twitchEmotes) {
    twitchExtra = new Map()
    // Lock detection: viewer can post a Twitch native sub emote only with a
    // subscriber/founder badge in this channel. Own outgoing msgs bypass.
    const viewerBadges = viewerBadgesPerChannel.get(m.channel)
    const viewerCanPostSub = isOwn || (viewerBadges && (viewerBadges.has('subscriber') || viewerBadges.has('founder')))
    for (const [name, url] of Object.entries(m.twitchEmotes)) {
      let state = 'locked'
      if (viewerCanPostSub) state = 'global'
      else {
        const alt = typeof lookupEmote === 'function' ? lookupEmote(name) : null
        if (alt && (alt.state === 'owned' || alt.state === 'global' || alt.state === 'channel')) state = 'global'
      }
      // Key by the HTML-ESCAPED name: processEmotes below receives
      // escapeHtml(m.text), so its per-word lookups see escaped tokens.
      // Native emote names can contain HTML specials (`<3`, `:-&` style
      // smilies) — a raw-name key never matches `&lt;3` and the emote
      // renders as text. escapeHtml is identity for names without specials.
      twitchExtra.set(escapeHtml(name), { url, source: 'twitch', state, zeroWidth: false })
    }
  }
  // Sender-perma emote resolution: own → viewerPersonalEmotes, others →
  // senderEmoteSets["plat:uid"] (lazy-fetched, perma cached).
  let senderEmotes = null
  const senderKey = resolveSenderEmoteKey(m)
  if (isOwn) {
    // Honest wysiwyg: the local owned set is only truthful when the identity
    // this message was sent under resolves to the signed-in HS account —
    // otherwise render exactly what other viewers get (usually plain text)
    // and warn, instead of showing the sender an emote nobody else sees.
    // hsSenderKeys null (old server / logged out) fails open to old behavior.
    if (senderKey && Array.isArray(hsSenderKeys) && !hsSenderKeys.includes(senderKey)) {
      senderEmotes = getSenderEmotes(senderKey)
      queueSenderEmoteFetch(senderKey, m)
      warnIdentityMismatch(senderKey)
    } else {
      senderEmotes = viewerPersonalEmotes
    }
  } else if (senderKey) {
    senderEmotes = getSenderEmotes(senderKey)
    queueSenderEmoteFetch(senderKey, m)
  }
  // skipMentions=true: highlightMentionsInHtml (below) is the single source
  // of truth for mention anchors on this surface (uid resolution, HeatSync
  // paint/7TV precedence, letter-split). Letting processEmotes ALSO wrap
  // "@name" in its own plain <a> here would produce a nested <a>…<a>…</a></a>
  // — invalid HTML5 that browsers "fix" by auto-closing the outer anchor
  // empty, leaving a permanently blank username node next to its painted
  // sibling. See processEmotes' skipMentions doc comment (emotes.js).
  // m.emoteChannel: explicit channel-emote cache key for messages whose
  // channel is display-only (yt-only config channels + yt auto-live key by
  // config id / videoId, not a twitch/kick name). See social.js ytEmoteKey.
  // Server-enriched third-party refs (name→{url,provider,zeroWidth}) for THIS
  // message. Keyed by ESCAPED name so it matches processEmotes' per-word
  // lookups against escapeHtml(m.text) (mirrors twitchExtra above). Renders
  // the sender's inventory emotes without any per-sender fetch.
  let hsMsgRefs = null
  if (m.hsEmotes && typeof m.hsEmotes === 'object') {
    for (const name in m.hsEmotes) {
      const r = m.hsEmotes[name]
      if (!r) continue
      // cw stub — server hid a filter-flagged emote for THIS viewer and sent
      // {name, cw} with no url (mirrors background.js's get_sender_emotes
      // stub handling, see cw-stub-passthrough.test.js). `!r.url` alone used
      // to drop these entirely, so the name fell through to the next lookup
      // tier (sender/global cache) and rendered the REAL image — exactly the
      // leak the server-side cw filter exists to stop. Keep the stub so
      // processEmotes' emote.cw check (emotes.js ~3879) paints the
      // dashed-cyan placeholder instead of nothing.
      const isStub = !r.url && typeof r.cw === 'string' && r.cw
      if (!r.url && !isStub) continue
      ;(hsMsgRefs ||= new Map()).set(escapeHtml(name), {
        url: r.url || '',
        source: r.provider || 'heatsync',
        state: isStub ? 'cw' : 'global',
        zeroWidth: !!r.zeroWidth,
        cw: isStub ? r.cw : null,
        // own-inventory cw annotation — camelCase to match hsOwnCwHiddenCat's
        // reader (emotes.js); the server sends cw_cats snake_case.
        cwCats: Array.isArray(r.cw_cats) && r.cw_cats.length ? r.cw_cats : null,
        nsfw: !!r.nsfw,
      })
    }
  }
  // Own messages: fall back to click-pasted refs (never rolled back) so an
  // emote you pasted from someone else's message renders in your echo even if
  // the auto-add-on-send commit failed. Own-only — clickPastedRefs is keyed by
  // escaped name and carries {url,source,state,zeroWidth} already.
  if (isOwn && typeof clickPastedRefs !== 'undefined' && clickPastedRefs.size) {
    for (const [k, v] of clickPastedRefs) {
      if (!(hsMsgRefs ||= new Map()).has(k)) hsMsgRefs.set(k, v)
    }
  }
  let processedText = processEmotes(
    escapeHtml(m.text),
    m.emoteChannel || m.channel,
    twitchExtra,
    senderEmotes,
    m.time,
    true,
    hsMsgRefs,
  )
  if (m.emotes && m.emotes.length > 0) {
    processedText = processYtEmotes(processedText, m.emotes, true)
  }
  // Safety net: strip any remaining escaped HTML img tag fragments that leaked through.
  if (processedText.includes('&lt;img')) {
    processedText = processedText.replace(/&lt;img\b[^<]*/g, '')
  }
  // Highlight mentions AFTER emote processing so emote-name <img> tags aren't touched.
  processedText = highlightMentionsInHtml(processedText, m.platform)
  // Magenta #hashtags — mirrors the feed (renderFeedContent) so tags read the same everywhere.
  processedText = highlightHashtagsInHtml(processedText)
  // Yellow >>id thread references — links a HeatSync thread from inside platform
  // chat, mirroring the feed's >>id convention. Click opens the thread in the
  // overlay (wired per-row in buildMessageDiv), not a new tab.
  processedText = highlightThreadRefsInHtml(processedText)
  // Partial/defanged links ("watch?v=…", "heatsync (dot) org") — html
  // post-pass, skips existing anchors/tags. Rides the links master toggle.
  if (linksEnabled) {
    processedText = linkifyPartialLinks(processedText)
  }
  // Cheermotes — only when twitch IRC tagged bits=N (server-confirmed cheer).
  if (m.bits) processedText = renderCheermotesInText(processedText, m.bits)
  m._renderedHtml = processedText
  return processedText
}
pcLineHtmlHook = computeMessageText // the profile card draws its live lines with it

// Shared post-render reconcile of heatsync emote states (blocked vs pasteable)
// against current inventory/blocked. Used by buildMessageDiv (root=div) and the
// in-place emote reload (root=swapped text span).
function reconcileHeatsyncEmoteStates(root) {
  for (const w of root.querySelectorAll('.hs-mc-emote-wrapper[data-source="heatsync"]')) {
    const name = w.dataset.emoteName
    // judged per emote, not per name (rules 9, 10): a heatsync W beside the one you own is
    // not yours, and blocking one W does not box another
    const wEmote = { hash: w.dataset.emoteHash, url: w.dataset.emoteUrl }
    const newState = emoteIsBlocked(name, wEmote)
      ? 'blocked'
      : isViewerEmoteUrl(name, w.dataset.emoteUrl, w.dataset.emoteHash)
        ? 'owned'
        : 'global'
    if (w.dataset.state !== newState) {
      w.classList.remove(
        'hs-state-owned',
        'hs-state-unadded',
        'hs-state-blocked',
        'hs-state-global',
        'hs-state-channel',
      )
      w.classList.add(`hs-state-${newState}`)
      w.dataset.state = newState
    }
  }
}

// In-place emote reload. When a channel/global emote set FIRST loads, plain-text
// history rows must pick up the now-renderable emotes. The old path called
// clearRenderedHtmlCache() → _renderEpoch++ → renderMessages tore down + rebuilt
// every row → every avatar/emote/badge img reloaded = the "loads then shifts"
// flash. Instead, swap ONLY each rendered row's text span (.hs-mc-text), computed
// by the SAME computeMessageText helper buildMessageDiv uses (byte-identical to a
// rebuild), so the row/avatar/badges keep their identity and never reload.
function reprocessEmoteTextInPlace() {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  // Snapshot rows ONCE — DOM may mutate across async chunks. Newest first: those are the
  // rows on screen, and they swap in one task; every older chunk lands above the viewport.
  const rows = [...msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')].reverse()
  if (rows.length === 0) return

  const CHUNK = 50

  function _processRow(div) {
    if (!div.isConnected) return // removed mid-iteration — skip
    const span = div.querySelector(':scope > .hs-mc-text')
    const m = div._hsMsg
    if (!span || !m) return
    const html = computeMessageText(m) // m._renderedHtml cleared by caller → recomputes
    // No-op when the recompute produced identical HTML — innerHTML assignment
    // recreates every <img> even for byte-identical markup, and a recreated
    // emote paints its alt TEXT for a frame before the image decodes (the
    // "emotes flash to text" jank on every emote-set broadcast).
    if (div._hsAppliedText === html) return
    span.innerHTML = html
    div._hsAppliedText = html
    if (html.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(span)
    // The swap recreated mention anchors — re-index so updateCosmeticsInPlace
    // still finds them (stale refs would silently fail to repaint paints).
    _unindexMessageDiv(div)
    div._hsMentionEls = null
    _indexMessageDiv(div, div.dataset.msgKey)
  }

  // A text row that becomes an emote row grows (20px line -> 36px emote box), so every swap
  // moves what is below it. Pinned to the bottom the reader is put back on the bottom; reading
  // up the list the scroll offset follows the growth. Either way nothing slides under them.
  function _holdPlace(work) {
    const h0 = msgsEl.scrollHeight
    const top0 = msgsEl.scrollTop
    work()
    if (!isScrolledUp) scrollMsgsToBottom(msgsEl)
    else msgsEl.scrollTop = top0 + (msgsEl.scrollHeight - h0)
  }

  // Fast path: ≤50 rows — run synchronously, no rAF overhead
  if (rows.length <= CHUNK) {
    _holdPlace(() => {
      for (const div of rows) _processRow(div)
    })
    return
  }

  // Chunked path: capture invalidation state ONCE at start. Each chunk bails
  // immediately if the tab switches, epoch bumps, or msgsEl is replaced —
  // stale work must never paint after a channel change or full rebuild.
  const snapTab = currentTab
  const snapEpoch = _renderEpoch

  function processChunk(offset) {
    if (currentTab !== snapTab || _renderEpoch !== snapEpoch || document.getElementById('hs-mc-messages') !== msgsEl)
      return
    const end = Math.min(offset + CHUNK, rows.length)
    _holdPlace(() => {
      for (let i = offset; i < end; i++) _processRow(rows[i])
    })
    // Schedule next chunk via rafOrTimeout — tracked timers/rafs, cancelled
    // by destroyAll() on teardown so the loop never outlives the panel, and
    // starvation-proof: a bare rAF here would stall a rebuild mid-chunks in
    // an occluded window whose visibility flip never arrived.
    if (end < rows.length) rafOrTimeout(() => processChunk(end))
  }

  // First chunk runs synchronously on the current frame; subsequent chunks
  // each get their own animation frame (~50 rows/frame, no stall).
  processChunk(0)
}

// First-emote-load handler: clear cached HTML everywhere so every tab recomputes
// with the new emotes, repaint the CURRENT tab in place (no flash), and drop
// other tabs' snapshot caches so they rebuild fresh on switch. NO _renderEpoch
// bump → no full teardown (mirrors invalidateRenderedForEmotes' tab handling).
function reloadEmotesInPlace(reprocess = true) {
  const clearBuf = (msgs) => {
    for (const m of msgs) delete m._renderedHtml
  }
  if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
  if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
  clearBuf(mentionsBuffer)
  for (const msgs of channelYtMessages.values()) clearBuf(msgs)
  // Skip the visible-row swap when scrolled up (caller passes reprocess=false) —
  // the cleared cache means those rows recompute with emotes on the next natural
  // render, without disturbing the user's scroll position now.
  if (reprocess) reprocessEmoteTextInPlace()
  _dropAllTabCaches()
}

// Platform→accent map lives in palette.js (HS_PLAT_COLORS).
const PLAT_COLORS = HS_PLAT_COLORS

// Pure builder for the inline feed-post quote row's username anchor (hoisted
// out of buildMessageDiv, same reasoning as PLAT_COLORS above). Mirrors the
// sender/mention/reply-bar precedence exactly: a resolved HeatSync paint
// (already-rendered `hsPaint` — cls/html/splitAttr from hsPaintRender) wins;
// otherwise a resolved 7TV `paintStyle` string; otherwise the plain
// per-post color. Takes the resolved paint/style in rather than resolving
// them itself so it stays unit-testable without any cache/DOM/network state.
function buildFeedQuoteUserLink(feedUser, uid, hsPaint, paintStyle, color) {
  const name = feedUser || 'anon'
  const lower = name.toLowerCase()
  const cls = `hs-mc-user hs-mc-mention hs-mention${hsPaint ? ` ${hsPaint.cls}` : ''}`
  const uidAttr = uid ? ` data-uid="${escapeHtml(uid)}"` : ''
  const splitAttr = hsPaint ? hsPaint.splitAttr : ''
  // Mount stamp (not a color decl) when painted — phase-locks this copy to
  // the same wall-clock frame as every other copy of the paint.
  const style = hsPaint
    ? `--hsp-t:${paintPhaseNow()};${hsNameColourDecl(sanitizeColor(color || '#fff'))}`
    : paintStyle || `color:${sanitizeColor(color || '#fff')}`
  const inner = hsPaint ? hsPaint.html : escapeHtml(name)
  // feedUid above is always resolved twitch-space (userKey(..., 'twitch')) —
  // an inline feed quote only ever names a twitch chatter, same convention
  // as the mention/reply-bar platform default elsewhere in this file.
  return `<a href="https://heatsync.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer" class="${cls}" data-username="${escapeHtml(lower)}" data-platform="twitch"${uidAttr}${splitAttr} style="${escapeHtml(style)}">${inner}</a>`
}

// Shared-chat room-id → login. Keys are twitch numeric channel ids (from
// source-room-id); values are the resolved login, `null` while a lookup is
// in flight (never re-fired), or '' once a lookup has failed (never
// retried — a shared-chat session that never resolves shouldn't hammer the
// background on every message it relays).
const _sharedChatLoginCache = new Map()
function resolveSharedChatLogin(roomId) {
  _sharedChatLoginCache.set(roomId, null)
  safeSendMessage({ type: 'resolve_twitch_login_by_id', userId: roomId })
    .then((r) => {
      const login = r?.login || ''
      _sharedChatLoginCache.set(roomId, login)
      if (!login) return
      // Retroactively upgrade every 'shared' chip already on screen from
      // this room — the resolve is async, so rows rendered before it landed
      // only got the plain chip.
      for (const el of document.querySelectorAll(`.hs-mc-shared[data-hs-shared-room="${CSS.escape(roomId)}"]`)) {
        if (!el.dataset.hsSharedLogin) el.dataset.hsSharedLogin = login
      }
    })
    .catch(() => {
      _sharedChatLoginCache.set(roomId, '')
    })
}
