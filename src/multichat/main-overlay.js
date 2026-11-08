// part 3 of 8 of the multichat main body — react utilities, subpanes, tab bar creation, input bar, overlay creation, search, overlay keys.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

// ============================================
// REACT UTILITIES (FFZ-STYLE)
// ============================================

/**
 * Find the chat room container component
 */
function findChatRoomComponent() {
  // Try multiple starting points (including popout chat selectors)
  const selectors = [
    '[class*="chat-room"]',
    CONFIG.SELECTORS.TWITCH_STREAM_CHAT,
    '[data-test-selector="chat-room-component"]',
    '[data-a-target="chat-room-component"]',
    CONFIG.SELECTORS.TWITCH_CHAT_SHELL,
    '.chat-room',
  ]

  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (!el) continue

    // Look for component with render method and chat-related props
    const result = findComponent(
      el,
      (inst, fiber) => {
        // Check if this is a class component with render
        if (typeof inst?.render !== 'function') return false

        // Check fiber type name for chat-related components
        const typeName = fiber?.type?.displayName || fiber?.type?.name || ''
        if (typeName.toLowerCase().includes('chat')) return true

        // Check for chat-related props (direct key probe — JSON.stringify per
        // fiber level was burning ~30× on every retry)
        const props = inst.props
        if (props) {
          for (const k in props) {
            if (k === 'channel' || k === 'room' || k.startsWith('channel') || k.startsWith('room')) return true
          }
        }

        return false
      },
      30,
    )

    if (result) return result
  }

  return null
}

// ============================================
// UI CREATION (React-compatible elements)
// ============================================

/** Mark a tab active. Keeps aria-selected in lockstep with the `active`
 * class — three separate call sites used to toggle the class by hand, and a
 * screen reader reads aria-selected, not a css class. Only real tabs carry
 * role="tab"; the utility buttons share the class and must not claim it. */
function setTabActive(el, on) {
  if (!el) return
  el.classList.toggle('active', on)
  if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', String(on))
}

// One button per registry cell. 'add' is a plain button (no tab role); live
// is born active. Labels come from locale keys, '+' is literal.
function mcTabButtonHtml(tab) {
  const label = tab.labelKey ? t(tab.labelKey) : tab.label
  if (tab.id === 'add') return `<button class="hs-mc-tab" data-tab="add">${escapeHtml(label)}</button>`
  const on = tab.id === 'live'
  return `<button class="hs-mc-tab${on ? ' active' : ''}" role="tab" aria-selected="${on}" data-tab="${escapeHtml(tab.id)}">${escapeHtml(label)}</button>`
}

// Rebuild the 2nd row for the active tab; hidden when the tab has no cells.
function renderSubRow() {
  const row = tabBarElement?.querySelector('#hs-mc-subrow')
  if (!row) return
  const cells = mcHasOwnRow(currentTab) || !mcShowsRow(currentTab) ? [] : mcSubCells(currentTab)
  row.hidden = cells.length === 0
  row.replaceChildren(
    ...cells.map((c) => {
      const b = document.createElement('button')
      b.className = 'hs-mc-subcell'
      b.type = 'button'
      b.dataset.sub = c.id
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(c.id === currentSub))
      b.classList.toggle('active', c.id === currentSub)
      b.textContent = c.labelKey ? t(c.labelKey) : c.label
      return b
    }),
  )
}

// Land on a cell: remember it for the tab, repaint the row, mount its pane.
function applySub(tabId, sub, opts) {
  currentSub = sub
  // no visible row, no memory: coming back to a channel tab lands on chat
  if (sub && mcShowsRow(tabId)) lastSubByTab[tabId] = sub
  // settings draws its own row; landing on one of its cells swaps the pane
  if (tabId === 'settings' && sub && _setSettingsSubtab(sub) && currentTab === 'settings') renderSettingsTab()
  renderSubRow()
  mountSubPane(tabId, sub, opts || {})
}

// ── cell panes ──────────────────────────────────────────────────────────
// A non-home cell draws into #hs-mc-subpane, a layer over the overlay. The
// chat rows underneath are never touched, so coming back to `chat` is free.
// Panes are rebuilt on every mount, which makes a stale async fill harmless
// (its pane is gone, `isConnected` says so).
let _paneHidInput = false

// The channel a channel tab (or live) is about.
function subChannelOf(tabId) {
  if (tabId === 'live') return getLiveChannel()
  const ch = getChannelById(tabId)
  return (ch && (ch.twitch || ch.kick)) || tabId
}

// Tabs showing `channel`: its own tab(s) first, then live when it is the pick.
function channelTabIdsFor(channel) {
  const c = String(channel || '').toLowerCase()
  if (!c) return []
  const ids = (config.channels || [])
    .filter((ch) => [ch.id, ch.twitch, ch.kick].some((n) => String(n || '').toLowerCase() === c))
    .map((ch) => ch.id)
  if (String(getLiveChannel() || '').toLowerCase() === c) ids.push('live')
  return ids
}

// Shortcut target for slash commands and right-click items: open `sub` on the
// tab that shows `channel` (this tab if it does, or has no channel to name).
function mcOpenChannelCell(sub, channel, opts = {}) {
  const ids = channelTabIdsFor(channel)
  const here = mcSubCells(currentTab).some((c) => c.id === sub)
  const tab = channel ? (ids.includes(currentTab) ? currentTab : ids[0] || 'live') : here ? currentTab : 'live'
  switchTab(tab, sub, { ...opts, channel: channel || undefined })
}

// Leave a pane for the tab's home cell (×, Esc).
function mcLeaveSubPane() {
  const home = mcSubCells(currentTab)[0]?.id
  if (home && currentSub !== home) switchTab(currentTab, home)
}

function _paneNote(pane, text) {
  const d = document.createElement('div')
  d.className = 'hs-mc-status-loading hs-mc-subpane-pad'
  d.textContent = text
  pane.replaceChildren(d)
}

// The status pane is the hub: links to the panes that have no strip cell, and
// a × back to chat. Shown for the loaded panel and for a failed fetch alike.
function _paneHub(ctx) {
  const row = document.createElement('div')
  row.className = 'hs-cl-ctrls'
  const link = (label, tab, sub) => {
    const b = document.createElement('button')
    b.className = 'hs-cl-export'
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', () => switchTab(tab, sub))
    row.appendChild(b)
  }
  link('summary', ctx.tab, 'summary')
  link('my logs', ctx.tab, 'logs')
  if (ctx.tab === 'live') link('platforms', 'live', 'platforms')
  const x = hsXButton('hs-x-inline', t('mc_main_back_to_chat'), mcLeaveSubPane)
  x.title = t('mc_main_back_to_chat_esc')
  x.style.marginLeft = 'auto'
  row.appendChild(x)
  return row
}

// Which platform owns the channel name a pane was opened for. Live tab: the page's
// (when the name is the page's channel). A channel tab: whichever leg holds the
// name; a youtube-only tab is 'yt'. Unknown names stay twitch (the typed-arg default).
function _paneChannelPlatform(ctx) {
  const ch = String(ctx.channel || '').toLowerCase()
  if (ctx.tab === 'live') return ch === String(getLiveChannel() || '').toLowerCase() ? hostPlatform : 'twitch'
  const e = getChannelById(ctx.tab)
  if (e?.twitch?.toLowerCase() === ch) return 'twitch'
  if (e?.kick?.toLowerCase() === ch) return 'kick'
  return e && !e.twitch && !e.kick && e.youtube ? 'yt' : 'twitch'
}

const MC_SUB_PANES = {
  summary: (pane, ctx) => {
    pane.classList.add('hs-mc-subpane-pad')
    mountLiveStreamSummary(pane, ctx.channel, mcLeaveSubPane)
  },
  status: async (pane, ctx) => {
    const ch = String(ctx.channel || '').toLowerCase()
    const hub = _paneHub(ctx)
    const note = (text) => {
      _paneNote(pane, text)
      pane.prepend(hub)
    }
    const plat = _paneChannelPlatform(ctx)
    if (plat === 'yt') return note(t('mc_main_status_no_yt'))
    note(t('mc_main_status_fetching', [ch]))
    let panel = null
    try {
      panel = plat === 'kick' ? await buildKickStatusPanel(ch) : await buildChatStatusPanel(ch)
    } catch (_) {}
    if (!pane.isConnected) return
    if (!panel) return note(t('mc_main_status_fetch_failed', [ch, plat]))
    panel.classList.add('hs-mc-subpane-pad')
    pane.replaceChildren(hub, panel)
  },
  platforms: (pane) => renderLivePlatformsPane(pane),
  // Your own messages in this channel, or the user a right-click named.
  logs: (pane, ctx) => {
    const paneP = _paneChannelPlatform(ctx)
    const platform = ctx.platform || (paneP === 'yt' ? 'youtube' : paneP)
    // currentUsername is the twitch login: it names you only on twitch. On kick/yt the
    // viewer's own name isn't known here, so only a right-clicked chatter has logs.
    const username = ctx.username || (platform === 'twitch' ? currentUsername : '')
    if (!username)
      return _paneNote(pane, platform === 'twitch' ? t('mc_main_logs_signin') : t('mc_main_logs_rclick', [platform]))
    openChatLogsView(username, { platform, channel: ctx.channel })
  },
}

function mountSubPane(tabId, sub, opts) {
  const home = mcSubCells(tabId)[0]?.id
  document.getElementById('hs-mc-subpane')?.remove()
  dropChatLogsState()
  if (mcHasOwnRow(tabId)) return
  const render = MC_SUB_PANES[sub]
  if (!sub || sub === home || !render || !overlayElement) {
    if (_paneHidInput) {
      _paneHidInput = false
      showInputBar()
    }
    return
  }
  const pane = document.createElement('div')
  pane.id = 'hs-mc-subpane'
  pane.tabIndex = -1
  overlayElement.appendChild(pane)
  // no composer behind a pane: nothing typed there could be sent anywhere
  if (inputBarElement && !inputBarElement.classList.contains('hs-hidden')) {
    inputBarElement.classList.add('hs-hidden')
    inputBarVisible = false
    _paneHidInput = true
  }
  render(pane, {
    tab: tabId,
    channel: opts.channel || subChannelOf(tabId),
    username: opts.username,
    platform: opts.platform,
  })
}

// Esc in any pane goes back to chat — the cell's own back door.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !currentSub) return
    if (e.target?.closest?.('#hs-mc-inputbar') || mcHasOwnRow(currentTab)) return
    const home = mcSubCells(currentTab)[0]?.id
    if (!home || currentSub === home) return
    e.preventDefault()
    switchTab(currentTab, home)
  },
  { signal: mcSignal, capture: true },
)

// A clickable notice row (stream event, inline DM, moment) holds a name that
// is its own link. On the name only the name inverts, so the row is flagged
// and the universal row hover stands down (17-platform-position.css). An
// attribute on one row, not :has(:hover) — that restyled ~28k elements on
// every hover (300ms vs 10ms, traced 2026-10-30). Bound on the document: the
// chat rows live in the panel, not the tab bar it used to sit on, where no
// row ever reported a hover.
const hoveredName = (el) => el?.closest?.('.hs-mc-user, a')
document.addEventListener(
  'mouseover',
  (e) => {
    const row = hoveredName(e.target)?.closest('#hs-mc-container [data-hs-clickable]')
    if (row && !('hsNameHover' in row.dataset)) row.dataset.hsNameHover = ''
  },
  { signal: mcSignal },
)
document.addEventListener(
  'mouseout',
  (e) => {
    const name = hoveredName(e.target)
    if (!name || name.contains(e.relatedTarget)) return
    const row = name.closest('[data-hs-clickable]')
    if (row) delete row.dataset.hsNameHover
  },
  { signal: mcSignal },
)

function createTabBar() {
  const container = document.createElement('div')
  container.id = 'hs-mc-tabbar'
  container.dir = HS_DIR()
  // Static hardcoded tab buttons — no user input, safe innerHTML
  // Two sections: scrollable channel tabs + fixed utility buttons (always visible)
  // Static hardcoded buttons — all in one wrapping flow, no user input
  container.innerHTML = `
      <div class="hs-mc-tabs-scroll" role="tablist" aria-label="${t('mc_main_tabs_aria')}">
        ${MC_TABS.filter((tab) => tab.bar === 'scroll')
          .map(mcTabButtonHtml)
          .join('')}
      </div>
      <div class="hs-mc-right-cluster">
        <div class="hs-mc-util-row">
          <button class="hs-mc-tab hs-mc-util-btn" data-tab="settings" title="${t('mc_btn_settings')}">\u2699</button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-collapse-btn" id="hs-mc-collapse-btn" data-tab="collapse" title="${t('mc_main_hide_chat_title')}" aria-label="${t('mc_main_hide_chat')}"></button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-popout-btn" data-tab="popout" title="${t('mc_main_popout_title')}" style="display:none">\u26f6</button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-sub-btn" data-tab="subscribe" title="${t('mc_main_subscribe_title')}" style="display:none">$</button>
        </div>
      </div>
      <div id="hs-mc-subrow" role="tablist" aria-label="${t('mc_main_views_aria')}" hidden></div>
    `

  // native-chat escape hatch removed (too fragile across chat positions/boot).

  // Event delegation for tab clicks
  container.addEventListener('click', (e) => {
    const tab = e.target.closest('.hs-mc-tab')
    if (!tab) return

    const tabId = tab.dataset.tab
    log('Tab clicked:', tabId)
    // Acknowledge unread indicators on click — guarantees clearing even on
    // paths that don't run switchTab (live picker), and survives any new
    // mention that lands in the same frame between click and render.
    tab.classList.remove('has-mentions', 'has-new', 'has-stream-event')
    markTabRead(tabId)
    if (tabId === 'mentions') bumpSeen('mentions')
    else if (tabId === 'whispers') bumpSeen('whispers')
    else if (tabId === 'feed') bumpSeen('live')
    if (tabId === 'add') {
      switchTab('add')
    } else if (tabId === 'popout') {
      openPopoutForCurrentTab()
    } else if (tabId === 'subscribe') {
      openSubForCurrentTab(tab)
    } else if (tabId === 'collapse') {
      toggleChatHidden()
    } else if (tabId === 'settings' && currentTab === 'settings') {
      switchTab(prevTab || 'feed')
    } else {
      switchTab(tabId)
    }
  })

  // 2nd row: a cell is an address inside the active tab
  container.querySelector('#hs-mc-subrow').addEventListener('click', (e) => {
    const cell = e.target.closest('.hs-mc-subcell')
    if (cell) switchTab(currentTab, cell.dataset.sub)
  })

  // Right-click tabs → mark as read + channel context menu
  container.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.hs-mc-tab')
    if (!tab) return
    const tabId = tab.dataset.tab
    // Right-click clears the attention states (mentions red, stream-event, whispers) —
    // never the plain unread count: on a fast chat it refills at once, and a tab that
    // always reads "unread" would swallow every right-click before the menu opens.
    if (
      tab.classList.contains('has-mentions') ||
      tab.classList.contains('has-stream-event') ||
      tab.classList.contains('has-whispers')
    ) {
      e.preventDefault()
      tab.classList.remove('has-mentions', 'has-stream-event', 'has-whispers')
      // mentions / whispers / feed ARE their count, so there it clears too —
      // and the unread flag with it, or the tab sits white (idle is grey)
      if (mcIsReservedTab(tabId)) {
        markTabRead(tabId)
        tab.classList.remove('has-new')
      }
      // The red state is rebuilt on refresh from tabSeenAt (restore scan), so
      // acknowledging it must stamp that too or the next reload relights it.
      // Special tabs are server-backed via bumpSeen below.
      if (!mcIsReservedTab(tabId)) markTabSeen(tabId)
      // Sync server-backed seen state so the dot doesn't reappear and
      // every other client clears via WS broadcast.
      if (tabId === 'mentions') bumpSeen('mentions')
      else if (tabId === 'whispers') bumpSeen('whispers')
      else if (tabId === 'feed') bumpSeen('live')
      return
    }

    // Live (temp) tab: keep it, pick another open stream, edit platforms
    if (tabId === 'live') {
      e.preventDefault()
      document.getElementById('hs-mc-ctx-menu')?.remove()
      const menu = document.createElement('div')
      menu.id = 'hs-mc-ctx-menu'
      menu.style.cssText =
        'position:fixed;z-index:99999;background:#000;border:1px solid #ffffff;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'
      const addItem = (label, fn) => {
        const item = document.createElement('div')
        item.textContent = label
        item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#fff;'
        item.addEventListener('mouseenter', () => (item.style.background = '#000000'), {
          signal: mcSignal,
        })
        item.addEventListener('mouseleave', () => (item.style.background = ''), { signal: mcSignal })
        item.addEventListener('click', () => {
          menu.remove()
          fn()
        })
        menu.appendChild(item)
      }
      addItem(t('mc_tab_keep'), () => keepLiveTab())
      addItem(t('mc_tab_live'), () => showLiveChannelPicker(tab))
      addItem(t('mc_main_edit_platforms'), () => showEditLivePlatforms())
      document.body.appendChild(menu)
      const mw = menu.offsetWidth,
        mh = menu.offsetHeight
      menu.style.left = `${Math.min(e.clientX, window.innerWidth - mw - 4)}px`
      menu.style.top = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`
      const dismiss = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove()
          document.removeEventListener('click', dismiss)
        }
      }
      cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
      return
    }

    // Channel tabs get edit/remove context menu
    if (mcIsReservedTab(tabId)) return
    e.preventDefault()

    // Remove any existing context menu
    document.getElementById('hs-mc-ctx-menu')?.remove()

    const menu = document.createElement('div')
    menu.id = 'hs-mc-ctx-menu'
    menu.style.cssText =
      'position:fixed;z-index:99999;background:#000;border:1px solid #ffffff;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'

    const mkItem = (label, color, fn) => {
      const item = document.createElement('div')
      item.textContent = label
      item.tabIndex = 0
      item.setAttribute('role', 'menuitem')
      item.style.cssText = `padding:6px 12px;cursor:pointer;color:${color};`
      const hot = () => {
        item.style.background = '#ffffff'
        item.style.color = '#000000'
      }
      const cold = () => {
        item.style.background = ''
        item.style.color = color
      }
      item.addEventListener('mouseenter', hot, { signal: mcSignal })
      item.addEventListener('mouseleave', cold, { signal: mcSignal })
      item.addEventListener('focus', hot, { signal: mcSignal })
      item.addEventListener('blur', cold, { signal: mcSignal })
      const run = () => {
        menu.remove()
        fn()
      }
      item.addEventListener('click', run)
      item.addEventListener(
        'keydown',
        (ev) => {
          ev.stopPropagation()
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            run()
          } else if (ev.key === 'Escape') menu.remove()
          else if (ev.key === 'ArrowDown' || ev.key === 'j') (item.nextElementSibling || menu.firstElementChild).focus()
          else if (ev.key === 'ArrowUp' || ev.key === 'k')
            (item.previousElementSibling || menu.lastElementChild).focus()
        },
        { signal: mcSignal },
      )
      menu.appendChild(item)
    }

    mkItem(t('mc_ctx_edit'), '#fff', () => showEditChannelForm(tabId))
    mkItem(t('mc_ctx_remove'), 'var(--hs-danger)', () => removeChannel(tabId))

    // Append then clamp to viewport so it doesn't overflow off-screen
    document.body.appendChild(menu)
    const mw = menu.offsetWidth,
      mh = menu.offsetHeight
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - mw - 4)}px`
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`
    menu.firstElementChild?.focus()

    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove()
        document.removeEventListener('click', dismiss)
      }
    }
    cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
  })

  return container
}

// Edit form active — block renders while editing channel config
let editingChannel = false

// Track scroll state for "new messages" button
let isScrolledUp = false
// Pointer resting on an emote/name/badge: the feed is frozen (isScrolledUp) but this is
// not a reader's scroll-up, so renders during it never raise the "N new" button.
let hoverHeld = false
// A render asked for while the pointer held the feed. Release only repaints if
// one was: with nothing new the pane already shows everything, and the repaint
// (a 500-row diff, then a pin that forces layout) is what made every unhover
// cost ~16ms at cpu x4 (traced 2026-10-29).
let _holdMissedRender = false
let emoteReloadTimer = null
// Track scopes (channel:X / global / inventory) whose first emote payload
// we've already received this session. After first load, subsequent emote
// updates skip clearRenderedHtmlCache so old messages keep their rendering
// even when emotes are removed — "history is sacred" UX.
const _emoteFirstLoad = new Set()
const _emoteFirstLoadAt = new Map() // scope → first-seen ms
// Cold-load re-render window. The BG fires ONE channel_emotes_update per provider
// (bttv / ffz / 7tv / native) during the initial channel fetch, so a channel
// emote that lives in a LATE-resolving provider (e.g. a 7TV "Cabge"/"speed0" when
// 7tv lands after bttv) arrives AFTER the first payload. A first-payload-only gate
// would then never upgrade the plain-text history rows for it — the reported
// "7TV emotes render as text after refresh (but fine live)". Treat every payload
// within this window of a scope's first as still cold-loading so late providers
// still swap text→image; a genuine live add/remove (7TV EventAPI) lands long
// after and correctly stays in the history-preserving (no re-render) path.
const EMOTE_COLD_LOAD_MS = 25000
function _emoteColdLoad(scopes) {
  const now = Date.now()
  let cold = false
  for (const s of scopes) {
    const at = _emoteFirstLoadAt.get(s)
    if (at == null) {
      _emoteFirstLoadAt.set(s, now)
      _emoteFirstLoad.add(s)
      cold = true
    } else if (now - at < EMOTE_COLD_LOAD_MS) {
      cold = true
    }
  }
  return cold
}
// Scopes that arrived since the last debounce flush. Collected across
// progressive broadcasts (BTTV/FFZ/7TV/Twitch arrive separately for the
// same channel) so the eventual loadEmotes() knows every scope to
// first-load-clear in one shot. Drained when the timer fires.
let _pendingEmoteScopes = new Set()
// Set when a channel_emotes_update payload contains names that weren't
// renderable before — drives the upgrade-only history heal even outside the
// cold-load window (late provider / deferred join / refetch payloads).
let _pendingEmoteAdds = false
let newMessageCount = 0
let isProgrammaticScroll = false // Flag to ignore programmatic scrolls

// WYSIWYG mode (inline emote images in input)
let wysiwygEnabled = true

// Clickable links in chat messages (default on)
let linksEnabled = true

// Link preview tooltip on hover (default on)
let linkPreviewsEnabled = true

// Inline media embeds in chat — images/gifs/video/link-cards rendered below
// the message (never live iframes; see extractChatEmbed). Default on.
let mediaEmbedsEnabled = true

// Opt-in hover reply button on chat rows (default off) — hover-reply.js
let hoverReplyEnabled = false

// Vi mode for chat input (default off)
let viModeEnabled = false

// Platform badges [T]/[K]/[Y] on messages (default on)
let platformBadgesEnabled = true

// Mod/vip/sub badges as terse text chips instead of images (default off).
// Read from twitch-api.js's renderBadges and cosmetics.js's
// _patchBadgesInRoot — same concatenated scope, and both only run after
// init has executed this line, so the TDZ never bites (same guarantee
// _RUNTIME_BRIDGE above relies on).
let textBadgesEnabled = false

// Pronouns (pronoundb.org, twitch-only) on the profile card + hover
// tooltip (default on)
let pronounsEnabled = true

// Zebra striping — alternate row backgrounds (default on)
let zebraEnabled = true

// Toast on incoming whisper/DM while not on the whispers tab (default on) —
// the has-whispers tab badge alone was easy to miss (wollip kept missing
// whispers entirely).
let whisperToastEnabled = true

// Scroll-wheel volume on the player (classic BTTV behavior, default off) —
// read live by the document-level wheel listener (see setupScrollWheelVolume).
let scrollWheelVolumeEnabled = false

// Util row collapsed — hides C/T/F-/F+/⚙ for clean single-line tabs

// User-hidable tabs — persisted in ui_settings.hiddenTabs (auto-syncs cross-device)
const HIDABLE_TABS = ['feed', 'discover', 'whispers', 'mentions', 'pinned', 'modlog']
// Real steady-state default is STEADY_HIDDEN_TABS (see hiddenTabs registry entry
// in settings-schema.js) — this wider set is the fresh-install-only target:
// whispers/mentions/modlog are genuinely login-walled for a signed-out
// first-run user, so applyFreshInstallHiddenTabs() pushes new installs here
// once, and revealFreshInstallTabsOnce() un-hides them on first login.
//
// `feed` was on this list until 2026-08-25 and must never go back on it. It
// was correct when written (2026-07-27): the feed really was an empty wall
// for a signed-out user. The 2026-08-16 cold-start fix ended that — /hot
// serves 30 real rows anonymously and social.js dropped its auth gate on the
// explicit reasoning that "a logged-out session is EVERY brand-new install"
// — but this list was not revisited, so the tab showing that feed stayed off
// the bar until first login. Every new install therefore had no feed tab at
// all, which is why prod measured ~5 live installs a day and ZERO requests to
// the feed endpoint over three days. Same bug as the other three layers, one
// repo up: each looked fixed from the layer above.
const DEFAULT_HIDDEN_TABS = mcDefaultHiddenTabs()
// The set stamped on installs from 2026-07-27 to 2026-08-25. Still recognised
// so those installs are treated as "never customised" rather than stranded
// with a hidden feed forever.
const LEGACY_FRESH_HIDDEN_TABS = ['pinned', 'feed', 'whispers', 'mentions', 'modlog']
// The set stamped by the release before discover joined the list — still untouched
// until first login, so it must still count as "never customised".
const PREV_FRESH_HIDDEN_TABS = ['pinned', 'whispers', 'mentions', 'modlog']
// What a signed-in user who never touched Tabs sees hidden: pinned (opt-in),
// modlog (mods only) and discover (a destination, not a daily surface) — all
// off until asked, so the strip stays short.
const STEADY_HIDDEN_TABS = ['pinned', 'modlog', 'discover']
let hiddenTabs = new Set(STEADY_HIDDEN_TABS)

// One-time fresh-install tab hiding: background.js stamps hs_fresh_install_hidden_tabs
// on chrome.runtime.onInstalled(reason:'install') only — never on update, so
// existing users who never touched the Tabs setting are untouched. Consumes
// the flag immediately so this can never re-fire, and only applies if the
// user hasn't already customized hiddenTabs (never fights a manual choice).
async function applyFreshInstallHiddenTabs() {
  try {
    const { hs_fresh_install_hidden_tabs } = await browser.storage.local.get('hs_fresh_install_hidden_tabs')
    if (!hs_fresh_install_hidden_tabs) return
    // Settings lost the 5s boot race: hiddenTabs would read as its default and
    // this would stamp against a value the user never had. Leave the flag so
    // the next boot does it for real.
    if (!_settingsHydrated) return
    browser.storage.local.remove('hs_fresh_install_hidden_tabs').catch(() => {})
    const cur = getSetting('hiddenTabs')
    if (
      Array.isArray(cur) &&
      cur.length === STEADY_HIDDEN_TABS.length &&
      STEADY_HIDDEN_TABS.every((id) => cur.includes(id))
    ) {
      setSetting('hiddenTabs', DEFAULT_HIDDEN_TABS)
      saveUiSetting('hiddenTabsRevealPending', true)
    }
  } catch (_) {}
}
// Reveals the fresh-install-hidden tabs on first successful heatsync login.
// One-shot (guard flag consumed on first call) and only reveals if the user
// hasn't since customized hiddenTabs themselves — otherwise leaves their
// choice alone. Called both from the auth_changed broadcast and the
// get_auth_state boot probe (covers "already logged in before install finished").
async function revealFreshInstallTabsOnce() {
  try {
    const { ui_settings } = await browser.storage.sync.get('ui_settings')
    if (!ui_settings?.hiddenTabsRevealPending) return
    saveUiSetting('hiddenTabsRevealPending', false)
    const cur = getSetting('hiddenTabs')
    const matches = (set) => Array.isArray(cur) && cur.length === set.length && set.every((id) => cur.includes(id))
    // Either shape counts as untouched: an install stamped before feed came
    // off the list still carries the legacy set, and comparing only against
    // the current one would leave it hidden-forever instead of revealed.
    if (matches(DEFAULT_HIDDEN_TABS) || matches(PREV_FRESH_HIDDEN_TABS) || matches(LEGACY_FRESH_HIDDEN_TABS))
      setSetting('hiddenTabs', STEADY_HIDDEN_TABS)
  } catch (_) {}
}

// One-shot: give the feed tab back to installs stamped while `feed` was on the
// fresh-install hidden list (2026-07-27 → 2026-08-25).
//
// Without this, the fix above only helps installs made after the next release:
// everyone already carrying the legacy set keeps a hidden feed until they log
// in, which is the exact wall being removed — and they are the only users
// there are. Acts solely on an EXACT match of the legacy set, which no manual
// edit can leave behind, so a deliberate choice to hide the feed is never
// overridden. Removes only `feed`; whispers/mentions/modlog stay hidden until
// login, because those really are login-walled.
async function unhideFeedOnce() {
  try {
    // v2 deliberately ignores the v1 key. 1.7.65/66 shipped this migration
    // with its guard written BEFORE the read: boot races loadAllSettings()
    // against a 5s timeout, and on a slow chrome.storage.sync the cache is
    // still empty, so getSetting('hiddenTabs') returned the ['pinned']
    // registry default rather than the install's real value. isLegacy read
    // false, no feed tab came back — and hs_feed_unhidden was already set, so
    // that install was stranded permanently by the very code meant to rescue
    // it. Gating on _settingsHydrated (below) stops NEW strandings but cannot
    // help anyone already burned, and every existing install has run v1 by
    // now. A fresh key gives each of them exactly one more correctly-gated
    // attempt. It is a safe no-op for installs v1 migrated properly: their
    // hiddenTabs no longer matches the legacy set, so nothing fires. The only
    // cost is that someone who deliberately re-hid exactly the legacy five
    // sees feed once more, one time — worth it against users stranded for good.
    const { hs_feed_unhidden_v2 } = await browser.storage.local.get('hs_feed_unhidden_v2')
    if (hs_feed_unhidden_v2) return
    // Never spend the guard against a cache that never loaded — that is the
    // exact bug above. Leaving it unset means the next boot tries for real.
    if (!_settingsHydrated) return
    browser.storage.local.set({ hs_feed_unhidden_v2: true }).catch(() => {})
    const cur = getSetting('hiddenTabs')
    const isLegacy =
      Array.isArray(cur) &&
      cur.length === LEGACY_FRESH_HIDDEN_TABS.length &&
      LEGACY_FRESH_HIDDEN_TABS.every((id) => cur.includes(id))
    if (isLegacy) setSetting('hiddenTabs', DEFAULT_HIDDEN_TABS)
  } catch (_) {}
}

// One-shot: mod log and discover became off-by-default, so installs still
// sitting on an older default (hiddenTabs exactly ['pinned'] — what a first
// login stamps — or ['pinned', 'modlog'] — the previous release) get them
// hidden too. Exact match only: any list the user edited is left alone. Gated
// on _settingsHydrated and spent only after it, same as unhideFeedOnce, so a
// cache that never loaded can't burn the guard. v2 on purpose: v1 already ran
// for the ['pinned'] → ['pinned', 'modlog'] step.
async function hideSecondaryTabsOnce() {
  try {
    const { hs_secondary_tabs_hidden_v2 } = await browser.storage.local.get('hs_secondary_tabs_hidden_v2')
    if (hs_secondary_tabs_hidden_v2) return
    if (!_settingsHydrated) return
    browser.storage.local.set({ hs_secondary_tabs_hidden_v2: true }).catch(() => {})
    const cur = getSetting('hiddenTabs')
    const is = (set) => Array.isArray(cur) && cur.length === set.length && set.every((id) => cur.includes(id))
    if (is(['pinned']) || is(['pinned', 'modlog'])) setSetting('hiddenTabs', STEADY_HIDDEN_TABS)
  } catch (_) {}
}

// Timestamps on messages (default off)
let timestampsEnabled = false
window._hsTimestampsEnabled = false
let avatarsEnabled = false

// Auto-claim Twitch channel points bonus chests across every twitch
// channel in your multichat. Uses the official ClaimCommunityPoints GQL
// call (same one Twitch's own UI fires) — pure user benefit, ToS-clean.
// Toast notifies on each successful claim.
let autoClaimPoints = true

// Dim timed-out/banned messages instead of hiding (default on)
let dimTimeouts = true

// Opt-in (default off): confirm before a permanent ban — guards against a
// fat-fingered irreversible ban. Read at the dispatchModAction chokepoint.
let modConfirmBan = false

// Configurable ban reasons (one per line, default empty). When set, the ban
// dialog shows them as selectable chips; the choice flows to the ban API.
let modBanReasons = ''

// Boost username color brightness for readability on black bg (default on)
let readableNamesEnabled = true

// Input bar auto-hide — hidden when empty, shown on first keystroke
let autoHideInput = false
let inputBarVisible = true
// Rapid-fire guard: keepComposerOpen() suppresses auto-hide for a short
// window (Tab-reveal, sticky-focus sends on non-auto-hide setups) so a
// transient blur can't collapse the bar mid-flow. Auto-hide sends do NOT
// route through this — settleComposerAfterSend() zeroes the window and
// hides instantly on Enter; type-to-reveal covers the next keystroke.
let _keepComposerOpenUntil = 0
function keepComposerOpen(ms) {
  _keepComposerOpenUntil = performance.now() + (ms || 500)
}
// …except in the /live_chat pop-out — a blurred composer there sends f/t/etc.
// to the host page's find-as-you-type or a link-hint extension instead of chat.
// Works WITH vi mode: input-vi only acts while the composer is focused (and
// types the first printable key into an empty composer even in normal mode),
// so a hidden composer never eats keys — the type-to-reveal handler wins.
const autoHideEligible = () => autoHideInput && !isYtPopout
const canAutoHideInput = () => autoHideEligible() && performance.now() >= _keepComposerOpenUntil

// First-time chatter highlight — orange edge on first message from a user this session (default on)
let firstChatterGlow = true
// channelLower → Set<usernameLower> seen this session
const seenChattersByChannel = new Map()
function markChatterSeen(channel, username) {
  if (!channel || !username) return false
  const ch = channel.toLowerCase()
  const u = username.toLowerCase()
  let set = seenChattersByChannel.get(ch)
  if (!set) {
    set = new Set()
    seenChattersByChannel.set(ch, set)
    // Bound the OUTER map too: each unique channel ever visited (config +
    // every SPA-nav target) otherwise keeps its ~5000-name Set for the whole
    // session. Evict the oldest channel past a generous cap — mirrors the
    // LRU on knownColors/knownUserIds/mcUserCosmetics.
    if (seenChattersByChannel.size > 64) {
      seenChattersByChannel.delete(seenChattersByChannel.keys().next().value)
    }
  }
  if (set.has(u)) return false
  set.add(u)
  // LRU cap to 5000 per channel
  if (set.size > 5000) {
    const iter = set.values()
    for (let i = 0; i < 1000; i++) set.delete(iter.next().value)
  }
  return true
}

// ═══ Inline notification routing ═══
// Modular registry: each type can be toggled independently
// Colors match website conventions
// Derived from the settings registry boolmap entry — option rows carry
// tag/color/label keys; i18n resolves here (t() unavailable in lib scope).
const INLINE_NOTIF_TYPES = {}
for (const o of _SETTINGS_BY_KEY.get('inlineNotifs').options) {
  INLINE_NOTIF_TYPES[o.value] = {
    tag: o.tag,
    color: o.color,
    borderColor: o.borderColor,
    defaultOn: o.default,
    label: o.labelKey ? t(o.labelKey) : o.label,
    desc: o.tipKey ? t(o.tipKey) : o.tip,
  }
}
// 'cmd' — the slash-command receipt row (runSlashCommandWithReceipt, input.js).
// Deliberately NOT in the settings schema's inlineNotifs.options: every other
// entry there gates an incoming notification about someone ELSE, and 'cmd' has
// no such use — it is only ever your own action, injected with force:true, so
// a toggle for it would be a pill that does nothing when flipped. Color/tag
// live here instead of in a boolmap option nobody can meaningfully turn off.
INLINE_NOTIF_TYPES.cmd = { tag: '[cmd]', color: '#ffffff', borderColor: '#ffffff', defaultOn: true }
// Runtime state: { op: true, re: false, dm: false, mention: true }
const inlineNotifs = {}
for (const [k, v] of Object.entries(INLINE_NOTIF_TYPES)) inlineNotifs[k] = v.defaultOn

// Hermes event toggles (Twitch-native events: raids, hype trains, etc.) —
// same registry derivation as INLINE_NOTIF_TYPES above.
const HERMES_EVENT_TYPES = {}
for (const o of _SETTINGS_BY_KEY.get('hermesEvents').options) {
  HERMES_EVENT_TYPES[o.value] = {
    color: o.color,
    defaultOn: o.default,
    label: o.labelKey ? t(o.labelKey) : o.label,
    desc: o.tipKey ? t(o.tipKey) : o.tip,
  }
}
const hermesToggles = {}
for (const [k, v] of Object.entries(HERMES_EVENT_TYPES)) hermesToggles[k] = v.defaultOn

// Can the composer actually send from this tab? ONE answer, used by every
// path that shows, focuses, reveals, or sends from the bar — a box you can
// type into that quietly eats the message is worse than no box.
//   live      — the channel the page is on (nothing on /directory)
//   feed      — posts to your heatsync feed (placeholder says so)
//   whispers  — /r, /w, /dm; a bare send is refused out loud
//   mentions  — same, slash commands only
//   <channel> — a configured channel tab
// add / settings / discover / pinned / modlog — and any stale id left behind
// by a removed channel — can't send anywhere: sendMessage's targetChannel
// fell back to the TAB ID, so Enter on the modlog tab addressed a channel
// named "modlog" and the message went nowhere, silently.
// Narrower: tabs where a plain message goes to a live CHAT. The social tabs
// take input but refuse a bare send, so anything that means "start chatting
// to this person" (profile-card mention) needs this one, not the broad test.
function tabSendsToChat(id) {
  if (!id) return false
  if (id === 'live') return !!getLiveChannel()
  return !!getChannelById(id)
}
function tabAcceptsInput(id) {
  return tabSendsToChat(id) || id === 'feed' || id === 'whispers' || id === 'mentions'
}

// The DOM class is the truth; inputBarVisible is only a cache of it. Several
// paths add/remove hs-hidden directly (log + profile-card views, the autoHide
// toggle, a container rebuild that mints a fresh bar), so the cache can drift
// — and every drift is a dead composer: a stale `false` on a VISIBLE bar made
// hideInputBar() early-return forever (empty bar stranded on screen,
// "auto-hide stopped working"), a stale `true` on a HIDDEN bar made
// showInputBar() early-return (no way to type). Re-read before each decision.
function syncInputBarVisible() {
  const bar = document.getElementById('hs-mc-inputbar')
  if (bar) inputBarVisible = !bar.classList.contains('hs-hidden')
  return inputBarVisible
}

function showInputBar() {
  // Single choke point for every reveal (emote click-paste, quote, mention,
  // upload, type-to-reveal): a tab that can't send never gets a composer.
  if (!tabAcceptsInput(currentTab)) return
  if (syncInputBarVisible()) return
  inputBarVisible = true
  const bar = document.getElementById('hs-mc-inputbar')
  if (bar) bar.classList.remove('hs-hidden')
  // Overlay bottom inset is owned by _updateMcLayout (measured inputbar
  // height) — writing it here from CSS assumptions left a dead band when the
  // real composer height differed from the stylesheet fallback.
  // ResizeObserver doesn't fire on display:none → :flex; recompute anchors
  // so the docked Twitch callout follows the inputbar. (Also re-mirrors an
  // open picker onto the message list's new box — see syncPickerBox.)
  _updateMcLayout?.()
}

// vi-mode (chrome/vi-mode.js, same isolated world) reports "normal mode
// settled on an empty composer" — the keyboard-first "done here" signal.
// A keyboard-only flow never blurs on its own, so without this the empty
// bar could never auto-hide (the focused-composer guard blocked forever).
// Blur first so that guard passes, and zero the rapid-fire/sticky windows —
// an explicit Escape outranks post-send stickiness.
window.__hsViComposerEmpty = (el) => {
  if (el?.id !== 'hs-mc-input' || !autoHideEligible()) return
  _keepComposerOpenUntil = 0
  _composerStickyUntil = 0
  el.blur()
  hideInputBar()
}

let _autoHideRetryTimer = null
function hideInputBar() {
  if (!autoHideEligible()) return
  if (!syncInputBarVisible()) return
  // a share prompt (resub / watch streak) is waiting on this composer
  if (typeof _resubShareCtx !== 'undefined' && (_resubShareCtx || _watchstreakShareCtx)) return
  const input = document.getElementById('hs-mc-input')
  const hasText = input ? (input.value || input.textContent || '').trim().length > 0 : false
  const hasContent = hasText || input?.querySelector('img, span.hs-mc-emoji')
  if (hasContent) return
  // vi change-operators (cc/s/S/C, c+motion) empty the composer for one
  // synchronous beat before re-entering insert — never hide on that
  // transient empty. (Focus alone is NOT a keep signal: empty = hidden,
  // instantly; the rapid-fire send flow is covered by keepComposerOpen.)
  if (window.__hsViChanging?.()) return
  // Don't hide while emote picker is open
  const picker = document.getElementById('hs-mc-emote-picker')
  if (picker?.classList.contains('visible')) return
  // Don't hide while reply or quote is active
  if (replyState || quoteState) return
  // Rapid-fire window (keepComposerOpen): don't SWALLOW the hide — blur's
  // attempt is one-shot, so a hide dropped here used to leave the empty bar
  // stuck until some later blur ("auto-hide only works sometimes"). Retry
  // once the window expires; every guard above re-runs then.
  const wait = _keepComposerOpenUntil - performance.now()
  if (wait > 0) {
    if (!_autoHideRetryTimer) {
      _autoHideRetryTimer = cleanup.setTimeout(() => {
        _autoHideRetryTimer = null
        hideInputBar()
      }, wait + 50)
    }
    return
  }
  inputBarVisible = false
  const bar = document.getElementById('hs-mc-inputbar')
  if (bar) bar.classList.add('hs-hidden')
  // Hiding blurs the composer. Tell vi-mode to let go NOW — its own focusout
  // detach is 150ms behind, and a key pressed inside that gap runs as a vi
  // command on an invisible composer (blockEvent kills it) instead of
  // reaching the type-to-reveal handler. Every hide funnels through here, so
  // the timer-driven and reconciler-driven hides are covered too, not just
  // the vi-initiated one.
  try {
    window.__hsViDetachNow?.(document.getElementById('hs-mc-input'))
  } catch (_) {}
  // Overlay bottom follows via _updateMcLayout (hs-hidden → inputbar
  // measures 0) — a hardcoded '0' here was wrong for bottom-tabs, where the
  // inset must stay tabbar-height.
  _updateMcLayout?.()
}

function createOverlay() {
  const overlay = document.createElement('div')
  overlay.id = 'hs-mc-overlay'
  overlay.dir = HS_DIR()
  // Static hardcoded layout — only static strings, no user input, safe innerHTML
  const searchPlaceholder = t('mc_main_search_ph')
  overlay.innerHTML = `
      <div id="hs-mc-search-bar">
        <input id="hs-mc-search-input" type="text" placeholder="${searchPlaceholder}" autocomplete="off" spellcheck="false" />
        <span id="hs-mc-search-count"></span>
        <div id="hs-mc-search-spinner"></div>
      </div>
      <div id="hs-mc-statusbar">
        <div id="hs-notif-layer-statusbar" class="hs-notif-layer hs-notif-layer-statusbar"></div>
      </div>
      <div id="hs-mc-multistream-banner" hidden></div>
      <div id="hs-mc-pinbar" hidden></div>
      <div id="hs-mc-messages" role="log" aria-label="${t('mc_main_messages_aria')}">
        <!-- Skeleton state, painted before any join has even been issued —
             so it must be "connecting…", not "no messages yet". renderMessages
             owns the swap: it prints "no messages yet" only once _tabJoining
             says every leg has settled. This static string is the one a fresh
             install actually stares at while the panel wires up. -->
        <div class="hs-mc-empty">${t('mc_connecting')}</div>
      </div>
      <button id="hs-mc-new-msgs" style="display:none"></button>
    `

  // Setup scroll detection after DOM insertion
  cleanup.setTimeout(() => {
    const msgsEl = document.getElementById('hs-mc-messages')
    const newBtn = document.getElementById('hs-mc-new-msgs')
    if (!msgsEl || !newBtn) return
    wireModToolbarHover(msgsEl)

    // Retry broken emote imgs — 7TV/BTTV/FFZ CDNs occasionally 503 and
    // surface as broken (naturalWidth=0). Capture phase since 'error' doesn't
    // bubble. Backoff 1s/3s/8s, max 3 tries, scoped to .hs-mc-emote.
    cleanup.addEventListener(
      msgsEl,
      'error',
      (e) => {
        const img = e.target
        if (!(img instanceof HTMLImageElement)) return
        if (!img.classList.contains('hs-mc-emote') || hsOwnCopyFallback(img)) return
        const tries = +(img.dataset.hsRetries || 0)
        if (tries >= 3 || !img.src || !img.isConnected) return
        img.dataset.hsRetries = String(tries + 1)
        const delay = tries === 0 ? 1000 : tries === 1 ? 3000 : 8000
        const target = img.src
        cleanup.setTimeout(() => {
          if (!img.isConnected || img.src !== target) return
          // Straight to a cache-busted URL: stripping the src first collapses the image to its
          // alt text, which is the line that jumped up and back on every retry.
          const base = target.replace(/[?&]hsr=\d+$/, '')
          img.src = `${base}${base.includes('?') ? '&' : '?'}hsr=${tries + 1}`
        }, delay)
      },
      { capture: true },
    )

    const isStaticTab = () =>
      currentTab === 'feed' ||
      currentTab === 'settings' ||
      currentTab === 'discover' ||
      currentTab === 'pinned' ||
      currentTab === 'modlog'

    // Bulletproof scroll-pause: ANY upward movement pauses chat sticky.
    // Resumes ONLY when user lands within 2px of true bottom OR clicks "new" button.
    // Prior 50px slop let small wheels/drags re-trigger auto-scroll, breaking pause.
    const ATBOTTOM_PX = 2
    // Hover hold (below) rides the same pause. A real scroll-up while one is
    // active makes it a real pause: the button stays until the user resumes.
    let _hoverRelease = null
    const setPaused = (paused) => {
      if (paused) {
        if (hoverHeld) {
          hoverHeld = false
          isScrolledUp = false
        }
        if (!isScrolledUp) {
          isScrolledUp = true
          newBtn.innerHTML =
            newMessageCount > 0
              ? `<span class="hs-arrow-down">▼</span> ${t('mc_new_messages', [String(Number(newMessageCount) || 0)])}`
              : `<span class="hs-arrow-down">▼</span> ${t('mc_resume')}`
          newBtn.style.display = 'flex'
        }
      } else {
        if (isScrolledUp) {
          isScrolledUp = false
          newMessageCount = 0
          newBtn.style.display = 'none'
        }
      }
    }

    // BULLETPROOF AUTO-SCROLL RULE:
    // isScrolledUp is set TRUE only by explicit user input — wheel-up,
    // touchmove going up, PageUp/Home/ArrowUp keys, mousedown on scrollbar
    // thumb. NEVER by passive scroll events from DOM mutation, render
    // churn, image-load layout shift, or programmatic scrollMsgsToBottom.
    // Resume (FALSE) only when scroll events confirm we're back at bottom
    // AFTER a user-driven scroll, OR via the new-msgs button click, OR
    // explicit programmatic resume on tab switch.
    let _scrollFrame = null
    let _userInputScroll = false // set by wheel/touch/key, cleared after scroll settles
    mcSignal.addEventListener('abort', () => {
      if (_scrollFrame) {
        cancelAnimationFrame(_scrollFrame)
        _scrollFrame = null
      }
    })

    const checkAtBottom = () => {
      if (isStaticTab()) return msgsEl.scrollTop <= ATBOTTOM_PX
      return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight <= ATBOTTOM_PX
    }

    // Scroll/scrollend handler: ONLY resumes (sets isScrolledUp=false when
    // user-driven scroll lands at bottom). Never pauses — passive scroll
    // events caused by DOM mutation during boot would otherwise flip
    // isScrolledUp=true mid-build, then yellow "N new" accumulates without
    // ever auto-scrolling.
    const onScrollMaybeResume = () => {
      if (isProgrammaticScroll) return
      if (!_userInputScroll) return
      if (!isScrolledUp) return
      if (checkAtBottom()) {
        hoverHeld = false
        isScrolledUp = false
        newMessageCount = 0
        newBtn.style.display = 'none'
        _scrollbackWindow = 0 // back at the live tail — drop scrollback DOM
      }
    }

    // Near the top while paused → paint the next chunk of older history.
    const SCROLLBACK_TRIGGER_PX = 200
    const maybeLoadOlder = () => {
      if (isProgrammaticScroll) return
      if (!_userInputScroll) return
      if (!isScrolledUp) return
      if (isStaticTab()) return
      if (msgsEl.scrollTop > SCROLLBACK_TRIGGER_PX) return
      loadOlderScrollback()
    }

    msgsEl.addEventListener(
      'scroll',
      () => {
        if (_scrollFrame) return
        _scrollFrame = requestAnimationFrame(() => {
          _scrollFrame = null
          onScrollMaybeResume()
          maybeLoadOlder()
        })
      },
      { passive: true, signal: mcSignal },
    )

    msgsEl.addEventListener(
      'scrollend',
      () => {
        if (_scrollFrame) {
          cancelAnimationFrame(_scrollFrame)
          _scrollFrame = null
        }
        onScrollMaybeResume()
        // touch-end / wheel-coast finished — clear input flag so subsequent
        // passive scroll events don't accidentally count as user-driven.
        _userInputScroll = false
      },
      { signal: mcSignal },
    )

    // Wheel-up: pause INSTANTLY (before any scroll event fires).
    msgsEl.addEventListener(
      'wheel',
      (e) => {
        if (isStaticTab()) return
        _userInputScroll = true
        if (e.deltaY < 0) setPaused(true)
      },
      { passive: true, signal: mcSignal },
    )

    // Touch: track touchmove direction. Drag DOWN (page scrolls UP visually
    // — finger moves down means content moves down, we see earlier msgs)
    // pauses chat. mark _userInputScroll on any touch interaction.
    let _touchStartY = 0
    msgsEl.addEventListener(
      'touchstart',
      (e) => {
        _touchStartY = e.touches[0]?.clientY || 0
        _userInputScroll = true
      },
      { passive: true, signal: mcSignal },
    )
    msgsEl.addEventListener(
      'touchmove',
      (e) => {
        if (isStaticTab()) return
        const y = e.touches[0]?.clientY || 0
        if (y > _touchStartY + 4) setPaused(true)
        _touchStartY = y
      },
      { passive: true, signal: mcSignal },
    )

    // Keys that scroll up — pause.
    msgsEl.addEventListener(
      'keydown',
      (e) => {
        if (isStaticTab()) return
        if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
          _userInputScroll = true
          setPaused(true)
        } else if (e.key === 'PageDown' || e.key === 'End' || e.key === 'ArrowDown' || e.key === ' ') {
          _userInputScroll = true
        }
      },
      { signal: mcSignal },
    )

    // Mousedown on scrollbar thumb (target === msgsEl, click outside content)
    // — flag user input so subsequent scroll counts as user-driven.
    msgsEl.addEventListener(
      'mousedown',
      (e) => {
        if (e.target === msgsEl) _userInputScroll = true
      },
      { passive: true, signal: mcSignal },
    )

    newBtn.addEventListener(
      'click',
      () => {
        hoverHeld = false
        isScrolledUp = false
        newMessageCount = 0
        newBtn.style.display = 'none'
        _scrollbackWindow = 0 // jumping to live tail — drop scrollback DOM
        if (isStaticTab()) {
          // Static tabs: re-render then scroll to top (newest content)
          renderMessages(currentTab)
          msgsEl.scrollTop = 0
        } else {
          // Chat tabs: re-render then teleport to bottom. The new render
          // diff only auto-pins if user was AT bottom; here the user was
          // scrolled UP and clicked to come back, so force the scroll.
          renderMessages(currentTab)
          scrollMsgsToBottom(msgsEl)
        }
      },
      { signal: mcSignal },
    )

    // Hover hold: while the pointer rests on an emote, name or badge the feed
    // stops sliding, so the thing under the cursor stays under it (a new
    // message every second moved it away and the cursor fell back to an
    // arrow) and its tooltip stays on what you are pointing at. Messages keep
    // arriving into the buffer and show up the moment the pointer leaves.
    const holdTarget = (el) => el.closest('.hs-mc-emote-wrapper, .hs-mc-user, .hs-mc-badge-img')
    const releaseHold = () => {
      _hoverRelease = null
      if (!hoverHeld) return
      hoverHeld = false
      isScrolledUp = false
      newMessageCount = 0
      newBtn.style.display = 'none'
      if (isStaticTab()) return
      const missed = _holdMissedRender
      _holdMissedRender = false
      if (!missed) return
      renderMessages(currentTab)
      scrollMsgsToBottom(msgsEl)
    }
    msgsEl.addEventListener(
      'mouseover',
      (e) => {
        if (!(e.target instanceof Element)) return
        if (!holdTarget(e.target)) {
          // Pointer moved onto something else (or the held thing is gone):
          // let go after a beat so sweeping across emotes does not stutter.
          if (hoverHeld && !_hoverRelease) _hoverRelease = cleanup.setTimeout(releaseHold, 120)
          return
        }
        if (_hoverRelease) {
          cleanup.clearTimeout(_hoverRelease)
          _hoverRelease = null
        }
        if (hoverHeld && !isScrolledUp) hoverHeld = false // resumed by other means
        if (hoverHeld || isScrolledUp || isStaticTab()) return
        hoverHeld = true
        _holdMissedRender = false
        isScrolledUp = true
      },
      { passive: true, signal: mcSignal },
    )
    msgsEl.addEventListener('mouseleave', releaseHold, { passive: true, signal: mcSignal })
    window.addEventListener('blur', releaseHold, { passive: true, signal: mcSignal })

    // Bulletproof sticky-bottom: any change to msgsEl's box (panel resize,
    // window resize, tab/input bar height shift, font-size change) re-pins
    // to bottom unless the user explicitly scrolled up. Plugs the gap where
    // a width-rewrap shifted scrollTop a few px and the geometric
    // wasAtBottom check in renderMessages flipped to false.
    const _stickyResizeObs = new ResizeObserver(() => {
      if (isScrolledUp) return
      if (isStaticTab()) return
      // Shared frame-coalesced pinner — see onImgLoadOrError. A direct
      // scrollMsgsToBottom here was a second same-frame scrollTop writer
      // racing the append path's pin.
      scheduleScrollPin(msgsEl)
    })
    _stickyResizeObs.observe(msgsEl)
    cleanup.trackObserver(_stickyResizeObs)

    // Image-load re-pin: lazy-loaded emotes/badges/avatars decode AFTER the
    // message row rendered and we already pinned. Late-resolving height
    // grows the row, pushing bottom past the viewport → "drifted up by a
    // few px for a few sec" on busy channels with many lazy assets per
    // message. ResizeObserver doesn't catch this (msgsEl's box stays
    // constant). `load` doesn't bubble so capture phase is required.
    // Coalescing lives in scheduleScrollPin (shared with every other pin
    // trigger) so a 100-image burst still does one layout per frame.
    const onImgLoadOrError = (e) => {
      // A cosmetic badge img failed (e.g. 7TV CDN QUIC drop under request
      // burst). The URL is valid, so retry before giving up — only hide after
      // 2 failed retries — so we never render a permanent broken-image icon.
      if (e?.type === 'error') {
        const t = e.target
        if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-badge-img')) retryOrHideBadgeImg(t)
        if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-avatar')) t.style.display = 'none'
        // static-emote proxy failure (heatsync.org unreachable / 429) —
        // swap back to the original CDN url once instead of a broken icon
        if (
          t instanceof HTMLImageElement &&
          t.classList.contains('hs-mc-emote') &&
          (t.src || '').includes('/api/emote-proxy') &&
          !t.dataset.hsProxyFell
        ) {
          t.dataset.hsProxyFell = '1'
          const orig = t.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
          if (orig) t.src = orig
        }
        // CDN static-variant miss (brand-new emote still processing) — fall
        // back to the original animated url once instead of a broken icon.
        // avif static misses are excluded: the avif block below retries the
        // webp static variant first; only its failure lands back here.
        if (
          t instanceof HTMLImageElement &&
          t.classList.contains('hs-mc-emote') &&
          /(_static\.|\/static\/)/.test(t.src || '') &&
          !/\.avif(\?|$)/i.test(t.src || '') &&
          !t.dataset.hsStaticFell
        ) {
          t.dataset.hsStaticFell = '1'
          const orig = t.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
          if (orig) t.src = orig
        }
        // 7TV emote requested as AVIF (10x smaller for animated) but this
        // emote has no avif variant (rare — e.g. brand-new emote still
        // processing) → fall back to webp once instead of a broken icon.
        if (
          t instanceof HTMLImageElement &&
          t.classList.contains('hs-mc-emote') &&
          (t.src || '').includes('cdn.7tv.app/emote/') &&
          t.src.endsWith('.avif') &&
          !t.dataset.hsAvifFell
        ) {
          t.dataset.hsAvifFell = '1'
          t.src = t.src.replace(/\.avif$/, '.webp')
        }
      }
      // Snap the emote box to an integer width so the text after it stays on
      // the pixel grid (see hsSnapEmoteBox — fixes blurry post-emote text).
      if (e?.type === 'load') {
        const t = e.target
        if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-emote')) hsSnapEmoteBox(t)
      }
      if (isScrolledUp) return
      if (isStaticTab()) return
      // Route through the ONE frame-coalesced pinner. Every scroll-pin
      // trigger (append, resize, image decode) must share a single
      // scrollTop writer per frame — independent rAF writers raced each
      // other and the rows visibly jumped ("virtual scrolling bugging out").
      scheduleScrollPin(msgsEl)
    }
    msgsEl.addEventListener('load', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })
    msgsEl.addEventListener('error', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })

    // Hover-to-animate (animateEmotes: 'hover') — rows render static srcs;
    // pointing at a message swaps all its emotes to the original animated
    // url (data-emote-url), leaving restores the exact pre-hover src via a
    // stash (never recomputed, so proxy/avif fallbacks survive roundtrips).
    // Row-level swap: one hover animates the whole message, matching how
    // people actually read chat, and keeps the hit target big.
    let _hoverAnimRow = null
    const _restoreHoverRow = () => {
      if (!_hoverAnimRow) return
      for (const img of _hoverAnimRow.querySelectorAll('img.hs-mc-emote')) {
        if (img.dataset.hsStaticSrc) {
          img.src = img.dataset.hsStaticSrc
          delete img.dataset.hsStaticSrc
        }
      }
      _hoverAnimRow = null
    }
    msgsEl.addEventListener(
      'mouseover',
      (e) => {
        if (emoteAnimationMode !== 'hover') return
        const row = e.target instanceof Element ? e.target.closest('.hs-mc-msg') : null
        if (row === _hoverAnimRow) return
        _restoreHoverRow()
        if (!row) return
        _hoverAnimRow = row
        for (const img of row.querySelectorAll('img.hs-mc-emote')) {
          const orig = img.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
          if (orig && img.src !== orig && !img.dataset.hsStaticSrc) {
            img.dataset.hsStaticSrc = img.src
            img.src = orig
          }
        }
      },
      { passive: true, signal: mcSignal },
    )
    msgsEl.addEventListener('mouseleave', _restoreHoverRow, { passive: true, signal: mcSignal })

    // Reply-chain stack overlay — viewport-bounded stack of all parents above active row
    let _stackActiveRow = null
    // Live-extend bookkeeping: when a new reply arrives whose replyTo matches
    // the bottommost id of the current descendant chain, append it to the
    // down-stack so the user sees the new message slide into the olive zebra
    // while the thread is open.
    let _stackTailId = ''
    let _stackChannel = ''
    let _stackPlatform = ''
    let _stackOwnId = ''
    let _stackThreadId = ''
    const dismissStack = () => {
      _stackStyleCache = null
      // Flip the pill's state back — aria-expanded is what tells a screen
      // reader (and the caret rule) whether the thread is open, so it has to
      // track dismissal from every path: outside click, Escape, re-click.
      try {
        const prevPill = _stackActiveRow?.querySelector('.hs-mc-reply-ctx[aria-expanded="true"]')
        if (prevPill) prevPill.setAttribute('aria-expanded', 'false')
      } catch (_) {}
      const overlay = document.getElementById('hs-mc-reply-stack')
      if (overlay) {
        overlay.style.display = 'none'
        overlay.replaceChildren()
        overlay.dataset.expanded = ''
        overlay.style.overflowY = ''
        overlay.style.overscrollBehavior = ''
        overlay._fullChain = null
      }
      const overlayDown = document.getElementById('hs-mc-reply-stack-down')
      if (overlayDown) {
        overlayDown.style.display = 'none'
        overlayDown.replaceChildren()
      }
      if (_stackActiveRow) {
        _stackActiveRow.classList.remove('hs-mc-reply-stack-active')
      }
      _stackActiveRow = null
      _stackTailId = ''
      _stackChannel = ''
      _stackPlatform = ''
      _stackOwnId = ''
      _stackThreadId = ''
    }
    const lookupMsgById = (channel, platform, id) => {
      if (!id) return null
      const ch = (channel || '').toLowerCase()
      if (platform === 'kick') {
        const buf = kickChat?.channels?.get(ch)
        if (buf) {
          const msgs = buf.getAll()
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
        }
        return null
      }
      if (ch && irc?.channels) {
        const buf = irc.channels.get(ch)
        if (buf) {
          const msgs = buf.getAll()
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
        }
      }
      if (irc?.channels) {
        for (const buf of irc.channels.values()) {
          const msgs = buf.getAll()
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
        }
      }
      return null
    }
    // Thread = all messages sharing the same Twitch reply-thread root (or
    // Kick thread_id). Walks the channel buffer once, splits members into
    // those before and after the hovered row by buffer order. Falls back to
    // direct-parent linkage when threadId isn't set (older Kick payloads).
    // Returns ancestors (chronological, oldest→newest) and descendants
    // (chronological, oldest→newest).
    const walkThreadMembers = (channel, platform, hoveredMsg, maxMembers) => {
      const out = { ancestors: [], descendants: [] }
      if (!hoveredMsg) return out
      const threadId = hoveredMsg.replyTo?.threadId || hoveredMsg.replyTo?.id || hoveredMsg.id
      if (!threadId) return out
      const ch = (channel || '').toLowerCase()
      const isMember = (m) =>
        m === hoveredMsg || m.id === threadId || m.replyTo?.threadId === threadId || m.replyTo?.id === threadId
      const collectFrom = (buf) => {
        const msgs = buf.getAll()
        let foundHovered = false
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]
          const match = m === hoveredMsg || (hoveredMsg.id && m.id === hoveredMsg.id)
          if (match) {
            foundHovered = true
            continue
          }
          if (!isMember(m)) continue
          if (!foundHovered) {
            out.ancestors.push(m)
            if (out.ancestors.length > maxMembers) out.ancestors.shift()
          } else {
            out.descendants.push(m)
            if (out.descendants.length >= maxMembers) return true
          }
        }
        return foundHovered
      }
      if (platform === 'kick') {
        const buf = kickChat?.channels?.get(ch)
        if (buf) collectFrom(buf)
        return out
      }
      if (ch && irc?.channels) {
        const buf = irc.channels.get(ch)
        if (buf && collectFrom(buf)) return out
      }
      if (irc?.channels) {
        for (const buf of irc.channels.values()) {
          if (collectFrom(buf)) break
        }
      }
      return out
    }
    // Expose chain walkers so input.js's right-click handler can build the
    // "copy thread" item for any chat row (overlay-row or native).
    window.__hsMcLookupMsg = lookupMsgById
    window.__hsMcWalkThread = walkThreadMembers
    // Forward wheel events from the reply-stack overlays to the chat
    // container. Without this, wheeling while hovering the overlay
    // (positioned above/below the active row) does nothing — the overlay
    // has overflow:hidden and isn't a scroll target — so the user feels
    // the chat "lock up" mid-scroll.
    const forwardWheelToMsgs = (ev) => {
      // Expanded up-stack scrolls inside the overlay — let native wheel run
      // (CSS overscroll-behavior:contain blocks chaining at the edge).
      if (ev.currentTarget && ev.currentTarget.dataset?.expanded === '1') return
      if (isStaticTab()) return
      // Re-fetch the live msgsEl every wheel — the closure-captured ref can
      // become a detached node if the overlay HTML is ever rebuilt (SPA nav,
      // settings reload). Writing to a detached node is a silent no-op which
      // looks to the user like "scroll is broken when hovering a reply
      // thread" — wheel preventDefault fires but chat never moves.
      const liveMsgsEl = document.getElementById('hs-mc-messages') || msgsEl
      if (!liveMsgsEl) return
      ev.preventDefault()
      _userInputScroll = true
      if (ev.deltaY < 0) setPaused(true)
      // scrollBy honors deltaMode (lines/pages/pixels) so high-DPI mice and
      // line-mode wheels feel native. The += assignment treated everything
      // as pixels.
      const px =
        ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * liveMsgsEl.clientHeight : ev.deltaY
      liveMsgsEl.scrollTop += px
    }
    const ensureStackOverlay = () => {
      let el = document.getElementById('hs-mc-reply-stack')
      if (el) return el
      el = document.createElement('div')
      el.id = 'hs-mc-reply-stack'
      el.style.display = 'none'
      document.body.appendChild(cleanup.trackNode(el))
      wireModToolbarHover(el)
      el.addEventListener('wheel', forwardWheelToMsgs, { passive: false, signal: mcSignal })
      el.addEventListener(
        'click',
        (ev) => {
          const chip = ev.target.closest('.hs-mc-reply-stack-chip')
          if (!chip) return
          ev.preventDefault()
          ev.stopPropagation()
          // Expand inline: render the full chain into the up overlay and
          // turn it into a scrollable popover. User reads all parents in
          // place, no chat jump, hover stays alive.
          const chain = el._fullChain
          if (!chain?.length) return
          el.replaceChildren()
          el.dataset.expanded = '1'
          el.style.overflowY = 'auto'
          el.style.overscrollBehavior = 'contain'
          for (let i = 0; i < chain.length; i++) {
            const row = buildMessageDiv(chain[i], currentTab)
            if (!row) continue
            row.classList.add('hs-mc-reply-stack-row')
            el.insertBefore(row, el.firstChild)
          }
          // Pin to bottom — immediate parent (closest to active row) visible
          // first, oldest scroll-up.
          el.scrollTop = el.scrollHeight
        },
        { signal: mcSignal },
      )
      return el
    }
    const ensureStackOverlayDown = () => {
      let el = document.getElementById('hs-mc-reply-stack-down')
      if (el) return el
      el = document.createElement('div')
      el.id = 'hs-mc-reply-stack-down'
      el.style.display = 'none'
      document.body.appendChild(cleanup.trackNode(el))
      wireModToolbarHover(el)
      el.addEventListener('wheel', forwardWheelToMsgs, { passive: false, signal: mcSignal })
      return el
    }
    const showStack = (hoveredEl) => {
      const replyId = hoveredEl.dataset.replyId
      if (!replyId) return
      const channel = hoveredEl.dataset.msgChannel
      const platform = hoveredEl.dataset.msgPlatform
      const ownId = hoveredEl.dataset.msgId
      const threadId = hoveredEl.dataset.replyThreadId || replyId
      const hoveredMsg = ownId ? lookupMsgById(channel, platform, ownId) : null
      const { ancestors, descendants } = hoveredMsg
        ? walkThreadMembers(channel, platform, hoveredMsg, 128)
        : { ancestors: [], descendants: [] }
      // chain[0] = closest ancestor (immediate parent), chain[n] = oldest.
      // Up-overlay rendering loop prepends each → visual top-down is oldest→newest.
      const chain = ancestors.slice().reverse()
      const descChain = descendants
      if (!chain.length && !descChain.length) return
      // Overlay rows match native .hs-mc-msg padding exactly, so the stack
      // butts flush against the active row — no overlap into the row's
      // padding (which used to compensate for zero-padded overlay rows).
      const cRect = msgsEl.getBoundingClientRect()
      const hRect = hoveredEl.getBoundingClientRect()
      const availableUp = hRect.top - cRect.top
      const availableDown = cRect.bottom - hRect.bottom
      const layoutViewportHeight = document.documentElement.clientHeight

      // ── Render ANCESTORS in the up overlay ──
      let upShown = 0
      if (chain.length && availableUp >= 24) {
        const overlay = ensureStackOverlay()
        overlay.replaceChildren()
        overlay.dataset.expanded = ''
        overlay.style.overflowY = ''
        overlay.style.overscrollBehavior = ''
        overlay._fullChain = chain
        overlay.style.position = 'fixed'
        overlay.style.left = `${hRect.left}px`
        overlay.style.width = `${hRect.width}px`
        overlay.style.bottom = `${layoutViewportHeight - hRect.top}px`
        overlay.style.maxHeight = `${availableUp}px`
        overlay.style.display = 'block'
        for (let i = 0; i < chain.length; i++) {
          const parent = chain[i]
          const row = buildMessageDiv(parent, currentTab)
          if (!row) continue
          row.classList.add('hs-mc-reply-stack-row')
          overlay.insertBefore(row, overlay.firstChild)
          if (overlay.scrollHeight > availableUp) {
            overlay.removeChild(row)
            const remaining = chain.length - upShown
            if (remaining > 0) {
              const chip = document.createElement('div')
              chip.className = 'hs-mc-reply-stack-chip'
              chip.textContent = t('mc_main_reply_stack_more', [String(remaining)])
              chip.dataset.targetId = chain[chain.length - 1].id
              overlay.insertBefore(chip, overlay.firstChild)
            }
            break
          }
          upShown++
        }
        if (!upShown) overlay.style.display = 'none'
      } else {
        const overlay = document.getElementById('hs-mc-reply-stack')
        if (overlay) {
          overlay.style.display = 'none'
          overlay.replaceChildren()
        }
      }

      // ── Render DESCENDANTS in the down overlay ──
      let downShown = 0
      if (descChain.length && availableDown >= 24) {
        const overlay = ensureStackOverlayDown()
        overlay.replaceChildren()
        overlay.style.position = 'fixed'
        overlay.style.left = `${hRect.left}px`
        overlay.style.width = `${hRect.width}px`
        overlay.style.top = `${hRect.bottom}px`
        overlay.style.maxHeight = `${availableDown}px`
        overlay.style.display = 'block'
        for (let i = 0; i < descChain.length; i++) {
          const child = descChain[i]
          const row = buildMessageDiv(child, currentTab)
          if (!row) continue
          row.classList.add('hs-mc-reply-stack-row')
          overlay.appendChild(row) // chronological top-down
          if (overlay.scrollHeight > availableDown) {
            overlay.removeChild(row)
            break
          }
          downShown++
        }
        if (!downShown) overlay.style.display = 'none'
      } else {
        const overlay = document.getElementById('hs-mc-reply-stack-down')
        if (overlay) {
          overlay.style.display = 'none'
          overlay.replaceChildren()
        }
      }

      if (!upShown && !downShown) return
      if (_stackActiveRow && _stackActiveRow !== hoveredEl) {
        _stackActiveRow.classList.remove('hs-mc-reply-stack-active')
      }
      hoveredEl.classList.add('hs-mc-reply-stack-active')
      _stackActiveRow = hoveredEl
      // Tail = id of the actual chain tail (the deepest known descendant) so
      // new replies whose replyTo matches it slot in below. If descChain was
      // overflow-clipped, the tail is still the buffer's deepest descendant
      // — live appends roll the visible window forward.
      _stackTailId = descChain.length ? descChain[descChain.length - 1].id || '' : ownId || ''
      _stackChannel = (channel || '').toLowerCase()
      _stackPlatform = platform || ''
      _stackOwnId = ownId || ''
      _stackThreadId = threadId || ''
    }

    // Click the "Replying to" pill to open the thread stack. Click again on
    // the same row's pill to close. Click on the @user link inside the pill
    // still navigates to the profile (target=_blank). Opens pause chat
    // auto-scroll so the active row doesn't slide out from under the stack.
    msgsEl.addEventListener(
      'click',
      (e) => {
        const pill = e.target.closest('.hs-mc-reply-ctx')
        if (!pill) return
        if (e.target.closest('a')) return
        const msg = pill.closest('.hs-mc-msg')
        if (!msg?.dataset.replyId) return
        e.preventDefault()
        e.stopPropagation()
        if (_stackActiveRow === msg) {
          dismissStack()
          return
        }
        if (_stackActiveRow) dismissStack()
        setPaused(true)
        showStack(msg)
        pill.setAttribute('aria-expanded', 'true')
      },
      { signal: mcSignal },
    )
    // Keyboard: the pill is a button now, so Enter/Space must open it like
    // any other. Without this it was reachable by Tab and then inert, which
    // is worse than not being focusable at all.
    msgsEl.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const pill = e.target.closest?.('.hs-mc-reply-ctx')
        if (!pill) return
        e.preventDefault()
        pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      },
      { signal: mcSignal },
    )
    // Dismiss on outside click — keep open when clicking inside the active
    // row or either overlay (chip-expand, link clicks, etc.).
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!_stackActiveRow) return
        if (_stackActiveRow.contains(e.target)) return
        const oUp = document.getElementById('hs-mc-reply-stack')
        if (oUp?.contains(e.target)) return
        const oDown = document.getElementById('hs-mc-reply-stack-down')
        if (oDown?.contains(e.target)) return
        dismissStack()
      },
      { signal: mcSignal },
    )
    // Profile card opening is its own click, capture-swallowed upstream by
    // pcard-early.js — the "outside click" mousedown listener just above
    // never sees it, so the stack would linger, fixed and above the card
    // that just opened underneath it. openProfileCard fires this the
    // instant a card is actually about to open.
    document.addEventListener(
      'hs-mc-close-overlays',
      () => {
        if (_stackActiveRow) dismissStack()
      },
      { signal: mcSignal },
    )
    document.addEventListener(
      'keydown',
      (e) => {
        if (_stackActiveRow && e.key === 'Escape') {
          dismissStack()
          e.stopPropagation()
        }
      },
      { signal: mcSignal },
    )
    // On chat scroll, follow the active row by repositioning both overlays
    // (up + down) instead of dismissing. Only dismiss if the row scrolled
    // fully out of the chat viewport. Cache style metrics that don't change
    // for the same row — getComputedStyle in scroll path forced layout on
    // every wheel tick, the user-perceived "laggy when scrolling on a
    // reply thread."
    let _stackStyleCache = null // { row, layoutH }
    const refreshStackStyleCache = (row) => {
      if (!row) {
        _stackStyleCache = null
        return
      }
      _stackStyleCache = { row, layoutH: document.documentElement.clientHeight }
    }
    // msgsEl sits inside fixed-position #hs-mc-container, so its viewport
    // rect is invariant across chat-scroll. Cache it and invalidate only on
    // resize/layout updates — halves forced-layout reads per scroll frame
    // (was 2 getBoundingClientRect, now 1) so reply-stack scrolling stops
    // stalling the compositor on busy channels.
    let _msgsRectCache = null
    const invalidateMsgsRect = () => {
      _msgsRectCache = null
    }
    const getMsgsRect = () => {
      if (!_msgsRectCache) _msgsRectCache = msgsEl.getBoundingClientRect()
      return _msgsRectCache
    }
    let _repositionRaf = 0
    // Click-opened stack: scroll-out HIDES overlays (display:none) but keeps
    // their content + state so scrolling back into view restores them. The
    // gate for "should this overlay be visible if room allows?" is whether
    // it has children — showStack populates children, dismissStack clears.
    const repositionStack = () => {
      // No open reply stack → nothing to follow. Bail before scheduling so a
      // busy chat's continuous scroll doesn't queue a rAF per frame just to
      // no-op. (The inner guard stays: a dismiss can land between schedule and
      // frame.)
      if (!_stackActiveRow) return
      if (_repositionRaf) return
      _repositionRaf = requestAnimationFrame(() => {
        _repositionRaf = 0
        if (!_stackActiveRow) return
        // Row trimmed out of DOM (chat hit render cap during scroll) — no
        // way to restore. Real dismiss so click again on a new row works.
        if (!_stackActiveRow.isConnected) {
          dismissStack()
          return
        }
        const cRect = getMsgsRect()
        const hRect = _stackActiveRow.getBoundingClientRect()
        const overlayUp = document.getElementById('hs-mc-reply-stack')
        const overlayDown = document.getElementById('hs-mc-reply-stack-down')
        const rowOutOfView = hRect.bottom < cRect.top || hRect.top > cRect.bottom
        if (rowOutOfView) {
          if (overlayUp) overlayUp.style.display = 'none'
          if (overlayDown) overlayDown.style.display = 'none'
          return
        }
        if (!_stackStyleCache || _stackStyleCache.row !== _stackActiveRow) {
          refreshStackStyleCache(_stackActiveRow)
        }
        const { layoutH } = _stackStyleCache

        if (overlayUp?.firstChild) {
          const availableUp = hRect.top - cRect.top
          if (availableUp < 24) {
            overlayUp.style.display = 'none'
          } else {
            overlayUp.style.display = 'block'
            overlayUp.style.left = `${hRect.left}px`
            overlayUp.style.width = `${hRect.width}px`
            overlayUp.style.bottom = `${layoutH - hRect.top}px`
            overlayUp.style.maxHeight = `${availableUp}px`
          }
        }
        if (overlayDown?.firstChild) {
          const availableDown = cRect.bottom - hRect.bottom
          if (availableDown < 24) {
            overlayDown.style.display = 'none'
          } else {
            overlayDown.style.display = 'block'
            overlayDown.style.left = `${hRect.left}px`
            overlayDown.style.width = `${hRect.width}px`
            overlayDown.style.top = `${hRect.bottom}px`
            overlayDown.style.maxHeight = `${availableDown}px`
          }
        }
      })
    }
    msgsEl.addEventListener('scroll', repositionStack, { passive: true, signal: mcSignal })
    window.addEventListener(
      'resize',
      () => {
        invalidateMsgsRect()
        if (_stackActiveRow) repositionStack()
      },
      { passive: true, signal: mcSignal },
    )
    // Panel resize (drag handle) and tab/input bar height shifts change the
    // msgsEl viewport rect. Invalidate the cache so the next scroll-frame
    // reposition uses fresh coords.
    const _msgsRectInvalidator = new ResizeObserver(invalidateMsgsRect)
    _msgsRectInvalidator.observe(msgsEl)
    cleanup.trackObserver(_msgsRectInvalidator)

    // Live-extend the down-stack: when a new chat row is appended whose
    // replyTo id matches the current chain tail, mirror it into the down
    // overlay so the user sees it slot into the olive zebra without losing
    // hover. If the overlay is full, drop oldest rows from the top of the
    // down stack (closest to active row) so the latest reply stays visible
    // — same behavior chat itself has at-bottom.
    const tryExtendStack = (newDiv) => {
      if (!_stackActiveRow?.isConnected) return
      if (!_stackThreadId) return
      const replyId = newDiv.dataset.replyId || ''
      const replyThreadId = newDiv.dataset.replyThreadId || ''
      // Thread match: new reply belongs if its threadId matches, or its
      // direct parent is the thread root (covers Twitch + Kick fallbacks).
      if (replyThreadId !== _stackThreadId && replyId !== _stackThreadId && replyId !== _stackTailId) return
      const newMsgId = newDiv.dataset.msgId || ''
      if (!newMsgId) return
      const msgChannel = (newDiv.dataset.msgChannel || '').toLowerCase()
      const msgPlatform = newDiv.dataset.msgPlatform || ''
      if (msgChannel !== _stackChannel || msgPlatform !== _stackPlatform) return
      const m = lookupMsgById(msgChannel, msgPlatform, newMsgId)
      if (!m) return
      const overlay = ensureStackOverlayDown()
      const cRect = msgsEl.getBoundingClientRect()
      const hRect = _stackActiveRow.getBoundingClientRect()
      if (hRect.bottom < cRect.top || hRect.top > cRect.bottom) return
      if (!_stackStyleCache || _stackStyleCache.row !== _stackActiveRow) refreshStackStyleCache(_stackActiveRow)
      const availableDown = cRect.bottom - hRect.bottom
      if (availableDown < 24) return
      const maxH = availableDown
      overlay.style.position = 'fixed'
      overlay.style.left = `${hRect.left}px`
      overlay.style.width = `${hRect.width}px`
      overlay.style.top = `${hRect.bottom}px`
      overlay.style.maxHeight = `${maxH}px`
      overlay.style.display = 'block'
      const row = buildMessageDiv(m, currentTab)
      if (!row) return
      row.classList.add('hs-mc-reply-stack-row')
      overlay.appendChild(row)
      while (overlay.scrollHeight > maxH && overlay.firstElementChild && overlay.firstElementChild !== row) {
        overlay.removeChild(overlay.firstElementChild)
      }
      if (overlay.scrollHeight > maxH) {
        overlay.removeChild(row)
        if (!overlay.firstElementChild) overlay.style.display = 'none'
        return
      }
      _stackTailId = newMsgId
    }
    const _liveStackObs = new MutationObserver((muts) => {
      if (!_stackActiveRow) return
      for (const mut of muts) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue
          if (!node.classList?.contains('hs-mc-msg')) continue
          tryExtendStack(node)
        }
      }
    })
    _liveStackObs.observe(msgsEl, { childList: true })
    cleanup.trackObserver(_liveStackObs)
  }, 100)

  // Search bar wiring — debounce 250ms then call /api/search
  const searchInput = overlay.querySelector('#hs-mc-search-input')
  const searchSpinner = overlay.querySelector('#hs-mc-search-spinner')
  let _searchTimer = null
  let _searchActive = false
  let _searchToken = 0

  if (searchInput && searchSpinner) {
    searchInput.addEventListener(
      'input',
      () => {
        // Live/channel tabs: instant local buffer filter — no server call, no spinner.
        if (isLiveSearchTab(currentTab)) {
          if (_searchTimer) {
            cleanup.clearTimeout(_searchTimer)
            _searchTimer = null
          }
          searchSpinner.classList.remove('visible')
          // Typing changes the match set, so any n/N cursor position is stale.
          _clearLiveSearchCursor()
          // Debounce: renderMessages → fairMerge sorts up to ~4500 items + a
          // full DOM diff. Running that synchronously on every keystroke stalls
          // the frame on low-RAM hardware. 80ms coalesces a fast typist's burst
          // into a single render; currentTab is re-read at fire time.
          _searchTimer = cleanup.setTimeout(() => {
            _searchTimer = null
            renderMessages(currentTab)
          }, 80)
          return
        }
        if (_searchTimer) {
          cleanup.clearTimeout(_searchTimer)
          _searchTimer = null
        }
        const q = searchInput.value.trim()
        if (!q) {
          _searchActive = false
          _searchToken++
          searchSpinner.classList.remove('visible')
          if (currentTab === 'mentions') renderMessages('mentions')
          return
        }
        _searchActive = true
        searchSpinner.classList.add('visible')
        _searchTimer = cleanup.setTimeout(async () => {
          _searchTimer = null
          if (!_searchActive) return
          const token = ++_searchToken
          const msgsEl = document.getElementById('hs-mc-messages')
          if (!msgsEl || currentTab !== 'mentions') return
          try {
            const resp = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&mode=messages&limit=50`)
            // Bail if a newer query superseded this one mid-flight, else slow
            // responses can paint stale results out of order.
            if (token !== _searchToken || !_searchActive || currentTab !== 'mentions') return
            searchSpinner.classList.remove('visible')
            const results = resp?.data?.results || resp?.results || []
            renderSearchResults(msgsEl, results, q)
          } catch (_) {
            searchSpinner.classList.remove('visible')
          }
        }, 250)
      },
      { signal: mcSignal },
    )

    // Clear search state when input is cleared via keyboard
    searchInput.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          searchInput.value = ''
          _searchActive = false
          searchSpinner.classList.remove('visible')
          if (_searchTimer) {
            cleanup.clearTimeout(_searchTimer)
            _searchTimer = null
          }
          renderMessages(currentTab)
          searchInput.blur()
        }
      },
      { signal: mcSignal },
    )
  }

  return overlay
}

function renderSearchResults(msgsEl, results, query) {
  _clearMessageIndices()
  msgsEl.textContent = ''
  if (!results.length) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-search-empty'
    empty.textContent = query ? t('mc_main_search_none_for', [query]) : t('mc_main_search_none')
    msgsEl.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const r of results) {
    const div = document.createElement('div')
    div.className = 'hs-mc-search-result'

    const ts = r.created_at ? new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    const user = r.display_name || r.username || ''
    const content = r.content || ''
    const msgId = r.base36_id || ''
    const permalink = msgId ? buildPostPermalink(msgId) : null

    const meta = document.createElement('div')
    meta.className = 'hs-mc-search-meta'
    if (ts) {
      const tsSpan = document.createElement('span')
      tsSpan.textContent = ts
      meta.appendChild(tsSpan)
    }
    const userSpan = document.createElement('span')
    userSpan.className = 'hs-mc-search-user'
    hsNameApply(userSpan, {
      name: user,
      userId: r.user_id,
      platform: r.platform,
      colour: r.user_color,
      login: String(r.username || '').toLowerCase(),
    })
    meta.appendChild(userSpan)

    const body = document.createElement('div')
    body.className = 'hs-mc-search-content'
    appendTextWithHashtags(body, content)

    div.appendChild(meta)
    div.appendChild(body)

    if (permalink) {
      div.addEventListener('click', () => window.open(permalink, '_blank', 'noopener'))
    }

    frag.appendChild(div)
  }
  _snapCompleteEmotes(frag)
  msgsEl.appendChild(frag)
}

// Emote size — registry-managed (hs_emote_size); the emoteSize applier
// runs applyEmoteSize + picker invalidation. Kept as a named function for
// the picker's size buttons (emotes.js).
function setEmoteSize(size) {
  setSetting('hs_emote_size', size)
}

function applyEmoteSize() {
  const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean)
  // 32px = the site's --emote-size, so a chat line reads the same here and on
  // heatsync.org. Twitch /1.0 is 28px, so 1x draws it a touch upscaled; the
  // denser rung (hsWantedRung) keeps it sharp on a retina screen.
  const baseEmote = 32
  const vars = {
    '--hs-emote-size': `${baseEmote * emoteSize}px`,
    '--hs-time-font': `${10 * emoteSize}px`,
    '--hs-badge-size': `${18 * emoteSize}px`,
    '--hs-badge-font': `${10 * emoteSize}px`,
    '--hs-stat-badge-font': `${9 * emoteSize}px`,
    '--hs-stat-badge-line': `${16 * emoteSize}px`,
    '--hs-badge-img': `${18 * emoteSize}px`,
  }
  for (const el of targets) {
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  }
  // Already-posted messages cache their rendered HTML (m._renderedHtml) built
  // with the previous size's emote-res URLs, so a plain renderMessages would
  // re-serve the old low-res <img> (box grows, image can't). reloadEmotesInPlace
  // clears the per-message cache and reprocesses, so existing emotes rebuild at
  // the new res from getChatResUrl — matching new messages.
  reloadEmotesInPlace()
}

// Emoji scale — separate var, default 2x. Registry-managed (hs_emoji_size,
// incl. the legacy bigEmoji=false → 1x migration).
let emojiSize = 2
function applyEmojiSize() {
  const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean)
  for (const el of targets) el.style.setProperty('--hs-emoji-scale', String(emojiSize))
}

// Start typing while reading our chat and the keystroke lands in the
// composer. Gated on attention (pointer over the panel, or a popout where
// the panel IS the window) rather than firing globally — on twitch.tv the
// host owns single-key player shortcuts (space/k pause, m mute, f fullscreen,
// t theatre, digits seek) and swallowing those would be a worse bug than the
// one this fixes. See src/multichat/type-to-focus.js.
initTypeToFocus(mcSignal)

// ── chat commands ────────────────────────────────────────────────────
// ONE implementation each, reachable two ways: the vi-mode <Space> leader
// (composer keeps focus — see src/multichat/overlay-keys.js) and the bare
// key while the composer is blurred. vi mode is off by default, so the bare
// keys stay: without them a non-vi user would have no keyboard surface at
// all. Each returns false when it declined to act, so the leader can stay
// silent rather than claim the key.
//
// Every command here is non-destructive on purpose. Bare keys that MODERATE
// people used to live alongside these and fired off whatever row the mouse
// happened to rest on — see the note at the bottom of mod-toolbar.js.

// '/' focuses the live-tab chat filter (vim-style) — only when the filter
// bar is actually showing.
function focusLiveSearch() {
  if (!isLiveSearchTab(currentTab)) return false
  const bar = document.getElementById('hs-mc-search-bar')
  if (!bar?.classList.contains('visible')) return false
  const input = document.getElementById('hs-mc-search-input')
  if (!input) return false
  input.focus()
  input.select()
  return true
}

// n / N — vim-style cycling through the live-tab search filter's matches.
// The filter already hides every non-matching row, so every .hs-mc-msg
// currently in msgsEl IS a match; this just walks that list and marks one
// "current". Same guards as '/', plus a non-empty query (nothing to cycle
// through otherwise).
function cycleLiveSearch(dir) {
  if (!isLiveSearchTab(currentTab)) return false
  const bar = document.getElementById('hs-mc-search-bar')
  if (!bar?.classList.contains('visible')) return false
  if (!liveSearchQuery(currentTab)) return false
  cycleLiveSearchMatch(dir)
  return true
}

// Only the scrollable content tabs (feed/whispers/mentions/pinned/live +
// channels) are navigable — the util buttons (add/settings/collapse/popout)
// live outside .hs-mc-tabs-scroll, so the selector skips them.
function _navigableTabIds() {
  const out = []
  for (const el of document.querySelectorAll('.hs-mc-tabs-scroll .hs-mc-tab[data-tab]')) {
    if (el.dataset.tab === 'add' || el.offsetParent === null) continue
    out.push(el.dataset.tab)
  }
  return out
}
function jumpToTabIndex(idx) {
  const ids = _navigableTabIds()
  if (idx < 0 || idx >= ids.length) return false
  switchTab(ids[idx])
  return true
}
// Wraps. If the current tab isn't navigable (e.g. settings), start from the
// nearest end so the first press lands.
function cycleTab(fwd) {
  const ids = _navigableTabIds()
  if (!ids.length) return false
  const cur = ids.indexOf(currentTab)
  const base = cur === -1 ? (fwd ? -1 : 0) : cur
  const next = fwd ? (base + 1) % ids.length : (base - 1 + ids.length) % ids.length
  switchTab(ids[next])
  return true
}

initOverlayKeys(mcSignal)
registerOverlayKey('f', () => openFollowsView())
document.addEventListener('keydown', followsKeyHandler, { capture: true, signal: mcSignal })
registerOverlayKey('/', () => focusLiveSearch())
registerOverlayKey('n', () => cycleLiveSearch(1))
registerOverlayKey('N', () => cycleLiveSearch(-1))
registerOverlayKey(']', () => cycleTab(true))
registerOverlayKey('[', () => cycleTab(false))
for (let i = 1; i <= 9; i++) registerOverlayKey(String(i), () => jumpToTabIndex(i - 1))

// Bare-key entry points, composer blurred. `defaultPrevented` matters: both
// type-to-focus and the type-reveal handler run first and claim the key by
// typing it into the composer — without the check, '/' both typed a slash
// AND yanked focus into the search box.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
    const t = e.target
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
    if (focusLiveSearch()) e.preventDefault()
  },
  { signal: mcSignal },
)
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'n' && e.key !== 'N') return
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
    const t = e.target
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
    if (cycleLiveSearch(e.key === 'n' ? 1 : -1)) e.preventDefault()
  },
  { signal: mcSignal },
)

// alt+1..9 jump to the Nth content tab, alt+] / alt+[ cycle next/prev. Alt
// (not ctrl/cmd) avoids the browser's own ctrl/cmd+N tab switching. NOT
// gated on where focus is: alt+digit types nothing, so there is no reason to
// make the user leave the composer to switch tabs. e.code (Digit1.. /
// Bracket*) is layout-independent and immune to Alt-composition on
// non-Linux keymaps; the ctrlKey bail also covers AltGr (ctrl+alt).
document.addEventListener(
  'keydown',
  (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    const isDigit = /^Digit[1-9]$/.test(e.code || '')
    const isBracket = e.code === 'BracketRight' || e.code === 'BracketLeft'
    if (!isDigit && !isBracket) return
    const ok = isDigit ? jumpToTabIndex(Number(e.code.slice(5)) - 1) : cycleTab(e.code === 'BracketRight')
    if (ok) e.preventDefault()
  },
  { signal: mcSignal },
)
