// Notifs — central notification system for multichat.
//
// Single source of truth for every popup/toast/callout/banner in multichat.
// Adding a new notif type is a single registerType call. Layer positioning is
// computed in ONE place (HsNotifs.updateLayout) instead of scattered CSS-var
// spew across main.js + styles.js.
//
// THREE ABSTRACTIONS
//
//   1. Layer  — positioned region of the page (toast-stack, chat-docked-bottom,
//               chat-docked-top, modal, …). Owns its container element + a
//               geometry function that returns top/left/right/bottom from the
//               current overlay/inputbar/tabbar rects. The manager publishes
//               those values as --hs-layer-{name}-{prop} CSS vars; CSS in
//               styles.js positions the layer container off them.
//
//   2. Type   — declarative notif spec: which layer, render fn, dedupe key,
//               timeout, action buttons (primary/dismiss/secondary). Each
//               type is independent; deleting the registerType call removes
//               the notif from the system entirely.
//
//   3. Source — adapter that feeds notifs in. Three flavors:
//                 direct       HsNotifs.emit('toast', { text, level })
//                 dom-observer registerType handles its own observer in onInit
//                 irc-events   subscribe to irc.on('message'), emit on match
//
// HOW TO ADD A NEW TYPE (worked example)
//
//     HsNotifs.registerType('twitch-raid', {
//       layer: 'chat-docked-top',
//       dedupeKey: ({ raidFrom }) => `raid:${raidFrom}`,
//       timeout: 30000,
//       render: ({ data }) => {
//         const el = document.createElement('span')
//         el.textContent = `${data.raidFrom} raided with ${data.viewers}!`
//         return el
//       },
//       actions: { dismiss: { label: '✕' } },
//     })
//     // Then anywhere:
//     HsNotifs.emit('twitch-raid', { raidFrom: 'someone', viewers: 50 })
//
// HOW TO REMOVE — delete the registerType call. Done.
//
// LAYER GEOMETRY — main.js's _updateMcLayout calls HsNotifs.updateLayout(ctx)
// once per layout change. The manager iterates layers and re-publishes their
// CSS vars. Animations are CSS, not JS.

const HsNotifs = (() => {
  const layers = new Map() // name -> { def, current: [], _container }
  const types = new Map() // name -> def
  let _idCounter = 0
  // Active viewed channels. null = scope filter inactive (show everything).
  // A Set of lowercase channel names = only show `channelScoped` notifs whose
  // data.channel is in the set. Tracks the user's current tab in multichat so
  // per-channel callouts (resub-share, watchstreak) don't bleed across tabs.
  let _activeChannels = null

  function registerLayer(name, def) {
    if (layers.has(name)) return
    layers.set(name, { def: def || {}, current: [], _container: null })
  }

  function registerType(name, def) {
    if (!def?.layer) {
      console.warn('[notifs] type', name, 'missing layer')
      return
    }
    if (!layers.has(def.layer)) {
      console.warn('[notifs] type', name, 'unknown layer', def.layer)
      return
    }
    types.set(name, def)
  }

  function emit(typeName, data) {
    const t = types.get(typeName)
    if (!t) {
      console.warn('[notifs] unknown type', typeName)
      return null
    }
    const l = layers.get(t.layer)

    const key = t.dedupeKey?.(data)
    if (key) {
      const existing = l.current.find((n) => n.key === key)
      if (existing) {
        if (t.onDedupe) {
          try {
            t.onDedupe(existing.data, data)
          } catch (_) {}
          if (existing.el) _renderInto(existing)
          if (t.timeout) {
            if (existing._timer) cleanup.clearTimeout(existing._timer)
            existing._timer = cleanup.setTimeout(() => dismiss(existing.id), t.timeout)
          }
          return existing.id
        }
        if (t.dedupePolicy === 'replace') {
          existing.data = data
          if (existing.el) _renderInto(existing)
          return existing.id
        }
        return existing.id
      }
    }

    if (l.def.stack === 'replace' && l.current.length > 0) {
      for (const old of [...l.current]) dismiss(old.id)
    }
    if (l.def.maxVisible && l.current.length >= l.def.maxVisible) {
      dismiss(l.current[0].id)
    }

    const id = `hs-notif-${typeName}-${++_idCounter}`
    const notif = { id, typeName, type: t, data, key, el: null, _timer: null }
    _mount(notif, l)
    return id
  }

  function dismiss(id) {
    for (const l of layers.values()) {
      const idx = l.current.findIndex((n) => n.id === id)
      if (idx >= 0) {
        const n = l.current[idx]
        l.current.splice(idx, 1)
        if (n._timer) {
          cleanup.clearTimeout(n._timer)
          n._timer = null
        }
        try {
          n.type.onDismiss?.(n.data)
        } catch (_) {}
        // Exit animation — flag wrapper for CSS to fade/slide out, then
        // remove on animation end. Falls back to immediate remove if the
        // animation event never fires (detached, reduced-motion, etc.).
        const el = n.el
        if (el?.isConnected) {
          el.classList.add('hs-notif-exiting')
          let removed = false
          const finishExit = () => {
            if (removed) return
            removed = true
            try {
              el.remove()
            } catch (_) {}
          }
          el.addEventListener('animationend', finishExit, { once: true })
          cleanup.setTimeout(finishExit, 220)
        } else {
          try {
            el?.remove()
          } catch (_) {}
        }
        return true
      }
    }
    return false
  }

  function dismissByKey(typeName, key) {
    const t = types.get(typeName)
    if (!t) return false
    const l = layers.get(t.layer)
    const found = l.current.find((n) => n.typeName === typeName && n.key === key)
    return found ? dismiss(found.id) : false
  }

  function _mount(notif, l) {
    const container = _ensureContainer(notif.type.layer, l)
    if (!container) return
    const wrapper = document.createElement('div')
    wrapper.className = `hs-notif hs-notif-${notif.typeName}`
    wrapper.dataset.notifId = notif.id
    wrapper.setAttribute('role', notif.data?.level === 'error' ? 'alert' : 'status')
    notif.el = wrapper
    // Stamp channel for scope filtering. Empty/missing channel = global notif,
    // never filtered. Lowercase normalization matches getActiveViewedChannels.
    if (notif.data?.channel) wrapper.dataset.channel = String(notif.data.channel).toLowerCase()
    _renderInto(notif)
    container.appendChild(wrapper)
    l.current.push(notif)
    _applyScopeTo(notif)
    // clickToDismiss: any click anywhere on the wrapper dismisses. Inner
    // action buttons stopPropagation in _renderInto so they still fire
    // their own onClick before the dismiss bubbles. Without this, toast
    // pointer-events:none made the wrapper unclickable — see registerType
    // 'toast' below.
    if (notif.type.clickToDismiss) {
      wrapper.addEventListener('click', () => dismiss(notif.id))
    } else if (notif.type.layer === 'toast-stack') {
      // Toast-stack CSS shows a pointer cursor on the whole toast — honor it:
      // body click fires the primary action (relink/retry/open), or dismisses
      // when the type has none. Action buttons stopPropagation in _renderInto,
      // so ✕ never double-fires. Other layers keep their explicit-button-only
      // behavior (statusbar callouts may carry side-effectful primaries).
      wrapper.addEventListener('click', () => {
        const primary = notif.type.actions?.primary
        if (!primary) return dismiss(notif.id)
        let result
        try {
          result = primary.onClick?.(notif.data, () => dismiss(notif.id))
        } catch (_) {}
        if (result === true) dismiss(notif.id)
      })
    }
    // Right-click dismiss — global UX convention: every popup/indicator
    // accepts right-click to clear without firing any action.
    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      dismiss(notif.id)
    })
    try {
      notif.type.onMount?.(notif.data, () => dismiss(notif.id), wrapper)
    } catch (_) {}
    if (notif.type.timeout) {
      // Pause-on-hover. Errors are easy to miss if they vanish mid-read.
      let remaining = notif.type.timeout
      let startedAt = Date.now()
      notif._timer = cleanup.setTimeout(() => dismiss(notif.id), remaining)
      wrapper.addEventListener('mouseenter', () => {
        if (notif._timer) {
          cleanup.clearTimeout(notif._timer)
          notif._timer = null
          remaining = Math.max(0, remaining - (Date.now() - startedAt))
        }
      })
      wrapper.addEventListener('mouseleave', () => {
        if (!notif._timer && remaining > 0) {
          startedAt = Date.now()
          notif._timer = cleanup.setTimeout(() => dismiss(notif.id), remaining)
        }
      })
    }
  }

  function _renderInto(notif) {
    const wrapper = notif.el
    if (!wrapper) return
    wrapper.textContent = ''
    const dismissFn = () => dismiss(notif.id)
    let body
    try {
      body = notif.type.render({ data: notif.data, dismiss: dismissFn })
    } catch (e) {
      console.warn('[notifs] render threw for', notif.typeName, e)
      body = ''
    }
    // Always render a body wrapper. If render returned nothing usable, fall
    // back to a placeholder so a notif can never be a blank rectangle.
    const bodyEl = document.createElement('span')
    bodyEl.className = 'hs-notif-body'
    if (typeof body === 'string' && body.length > 0) {
      bodyEl.textContent = body
    } else if (body instanceof Node) {
      bodyEl.appendChild(body)
    } else {
      bodyEl.textContent = `[${notif.typeName}]`
      bodyEl.classList.add('hs-notif-body-fallback')
    }
    wrapper.appendChild(bodyEl)
    if (notif.type.actions) {
      const actionsEl = document.createElement('span')
      actionsEl.className = 'hs-notif-actions'
      for (const [kind, def] of Object.entries(notif.type.actions)) {
        if (!def) continue
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `hs-notif-action hs-notif-action-${kind}`
        btn.textContent = def.label || kind
        if (def.title) btn.title = def.title
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          e.preventDefault()
          let result
          try {
            result = def.onClick?.(notif.data, dismissFn)
          } catch (_) {}
          if (kind === 'dismiss' || result === true) dismissFn()
        })
        actionsEl.appendChild(btn)
      }
      wrapper.appendChild(actionsEl)
    }
  }

  function _ensureContainer(name, l) {
    if (l._container && document.body.contains(l._container)) return l._container
    let el = document.getElementById(`hs-notif-layer-${name}`)
    if (!el) {
      // external layers are owned by overlay chrome (e.g. the statusbar slot
      // lives inside #hs-mc-statusbar). Never body-fallback — just wait for the
      // overlay to render it. Emits before then no-op (mount returns on null).
      if (l.def.external) return null
      el = document.createElement('div')
      el.id = `hs-notif-layer-${name}`
      el.className = `hs-notif-layer hs-notif-layer-${name}`
      document.body.appendChild(el)
    }
    l._container = el
    return el
  }

  // Set the channel scope. Pass null/undefined to disable filtering, or an
  // iterable of channel names to restrict `channelScoped` notifs to those
  // channels. Idempotent — comparing the set against existing skips no-op
  // work when the user clicks around inside the same channel context.
  function setActiveChannels(channels) {
    if (channels == null) {
      if (_activeChannels === null) return
      _activeChannels = null
    } else {
      const next = new Set()
      for (const c of channels) {
        if (c) next.add(String(c).toLowerCase())
      }
      if (_activeChannels && _activeChannels.size === next.size) {
        let same = true
        for (const c of next) {
          if (!_activeChannels.has(c)) {
            same = false
            break
          }
        }
        if (same) return
      }
      _activeChannels = next
    }
    for (const l of layers.values()) for (const n of l.current) _applyScopeTo(n)
  }

  function _applyScopeTo(notif) {
    const el = notif.el
    if (!el) return
    if (!notif.type.channelScoped || !notif.data?.channel) return
    const ch = String(notif.data.channel).toLowerCase()
    const hidden = _activeChannels != null && !_activeChannels.has(ch)
    el.classList.toggle('hs-notif-out-of-scope', hidden)
  }

  // Recompute every layer's geometry. Called from main.js's _updateMcLayout.
  // ctx: { overlayElement, inputBarElement, tabBarElement, containerElement,
  //        tabPosition, activeChannels }
  function updateLayout(ctx) {
    if (ctx && 'activeChannels' in ctx) setActiveChannels(ctx.activeChannels)
    const root = document.documentElement
    for (const [name, l] of layers) {
      _ensureContainer(name, l)
      let geom = null
      try {
        geom = l.def.geometry?.(ctx || {})
      } catch (_) {}
      if (geom) {
        for (const [k, v] of Object.entries(geom)) {
          const cssName = `--hs-layer-${name}-${k}`
          if (v == null) root.style.removeProperty(cssName)
          else root.style.setProperty(cssName, typeof v === 'number' ? `${v}px` : v)
        }
      }
    }
  }

  // === STANDARD LAYERS ===

  // Toast stack — top-right of the chat overlay, max 3 visible at once.
  // Previously bottom-right at 70px, which planted toasts directly on top of
  // the newest chat message and crowded the inputbar. Topping the overlay
  // keeps them off the read zone (chat reads bottom-up, so the top edge is
  // the *oldest* visible messages — those scroll away naturally). Falls back
  // to viewport corner if overlay rect isn't available yet.
  registerLayer('toast-stack', {
    stack: 'queue',
    maxVisible: 3,
    geometry: ({ overlayElement, tabBarElement, tabPosition }) => {
      const ovRect = overlayElement ? overlayElement.getBoundingClientRect() : null
      const tbVisible = tabBarElement && !tabBarElement.classList.contains('hs-hidden')
      const tbRect = tbVisible ? tabBarElement.getBoundingClientRect() : null
      if (!ovRect || ovRect.width <= 0) return { top: 12, right: 20, bottom: null }
      const topY = tabPosition === 'top' && tbRect && tbRect.height > 0 ? tbRect.bottom + 6 : ovRect.top + 6
      return {
        top: topY,
        right: window.innerWidth - (ovRect.left + ovRect.width) + 6,
        bottom: null,
      }
    },
  })

  // Chat-docked-bottom — full-width band above the inputbar (and tabbar in
  // bottom-tabs mode). Spans the chat content area horizontally; right edge
  // ends at the vertical tab strip's left edge when tabs are left/right.
  // Used by twitch-resub-share, twitch-watchstreak-share, sub-anniversary,
  // viewer-milestone callouts. Stacks vertically (newer on top) so multiple
  // celebration opportunities can coexist — user picks which to share first.
  /**
   * Clamp a docked layer's horizontal box into the viewport.
   *
   * A docked layer mirrors whatever it docks to (the chat overlay). That rect is
   * not guaranteed to be on screen: at narrow widths the chat column can sit
   * fully past the right edge, and the layer faithfully followed it — measured
   * live at `left: 1053px; right: -11px` in a 1048px viewport, i.e. a **6px
   * sliver**. The notification was present, correct and completely unreadable,
   * which reads to a user as the feature simply not working.
   *
   * A notification is the one thing that must never be silently invisible, so the
   * dock is a preference, not a contract: follow the target when it is usable,
   * clamp on screen when it is not.
   */
  function clampDockedBox(left, width, minWidth = 180) {
    const vw = window.innerWidth
    let w = Math.min(width, vw)
    if (w < minWidth) w = Math.min(minWidth, vw)
    let l = left
    if (l + w > vw) l = vw - w
    if (l < 0) l = 0
    return { left: l, right: Math.max(0, vw - (l + w)) }
  }

  registerLayer('chat-docked-bottom', {
    stack: 'queue',
    maxVisible: 3,
    geometry: ({ overlayElement, inputBarElement, tabBarElement, tabPosition }) => {
      if (!overlayElement && !inputBarElement) return null
      const ibVisible = inputBarElement && !inputBarElement.classList.contains('hs-hidden')
      const tbVisible = tabBarElement && !tabBarElement.classList.contains('hs-hidden')
      const ibRect = ibVisible ? inputBarElement.getBoundingClientRect() : null
      const tbRect = tbVisible ? tabBarElement.getBoundingClientRect() : null
      const ovRect = overlayElement ? overlayElement.getBoundingClientRect() : null
      let bottomY = null
      if (ibRect && ibRect.height > 0) bottomY = ibRect.top
      if (tabPosition === 'bottom' && tbRect && tbRect.height > 0) {
        bottomY = bottomY !== null ? Math.min(bottomY, tbRect.top) : tbRect.top
      }
      const horRect = ovRect && ovRect.width > 0 ? ovRect : ibRect
      if (!horRect || bottomY === null) return null
      const box = clampDockedBox(horRect.left, horRect.width)
      return {
        bottom: window.innerHeight - bottomY,
        left: box.left,
        right: box.right,
      }
    },
  })

  // Chat-docked-top — top of overlay (or below tabbar in top-tabs mode).
  // For raid alerts, "stream went live" inline notifications, etc.
  registerLayer('chat-docked-top', {
    stack: 'queue',
    maxVisible: 1,
    geometry: ({ overlayElement, tabBarElement, tabPosition }) => {
      if (!overlayElement) return null
      const ovRect = overlayElement.getBoundingClientRect()
      const tbVisible = tabBarElement && !tabBarElement.classList.contains('hs-hidden')
      const tbRect = tbVisible ? tabBarElement.getBoundingClientRect() : null
      const topY = tabPosition === 'top' && tbRect && tbRect.height > 0 ? tbRect.bottom : ovRect.top
      const box = clampDockedBox(ovRect.left, ovRect.width)
      return {
        top: topY,
        left: box.left,
        right: box.right,
      }
    },
  })

  // Statusbar — the thin always-present strip at the top of the overlay
  // (#hs-mc-statusbar, rendered by main.js's createOverlay). Its container slot
  // is #hs-notif-layer-statusbar, adopted in-place (external: true) so toasts
  // render INLINE in the bar instead of floating over the read zone. A single
  // status line: each new notif replaces the prior (stack: 'replace'), identical
  // text still coalesces to ×N via the type's dedupe. No geometry — the slot
  // sits in the bar's normal flex flow.
  registerLayer('statusbar', {
    stack: 'replace',
    maxVisible: 1,
    external: true,
    // The bar is absolutely positioned OVER the top of the messages area
    // (06-statusbar-callouts.css) so appearing/vanishing toasts can never
    // resize the messages column — chat rows must not move on a status line.
    // Only offset needed: sit below the search bar when that's open. The
    // value is overlay-relative (the bar's offset parent), unlike the
    // viewport-based geometry of the floating layers.
    geometry: () => {
      const sb = document.getElementById('hs-mc-search-bar')
      return { top: sb?.classList.contains('visible') ? sb.offsetHeight : 0 }
    },
  })

  // === STANDARD TYPES ===

  // Toast — short status message, color-coded by level. Click anywhere on
  // the toast to dismiss (clickToDismiss → _mount wires the click handler).
  // 4s default (was 1.5s — too fast to read for errors). Empty/whitespace
  // text falls back to "[level]" so an error toast can never render as an
  // empty black-box-with-red-outline (the old bug where any showToast call
  // with an undefined/missing error code produced an unclickable square).
  registerType('toast', {
    layer: 'statusbar',
    timeout: 2000,
    clickToDismiss: true,
    // Dedupe identical text — repeated kick/twitch send failures used to
    // stack one toast per attempt, crowding the chat. Same text+level now
    // collapses to a single toast with a "×N" counter and a refreshed timer.
    dedupeKey: ({ text, level }) => `toast:${level || 'info'}:${String(text || '').slice(0, 200)}`,
    onDedupe: (existing) => {
      existing._count = (existing._count || 1) + 1
    },
    render: ({ data }) => {
      const level = data.level || 'info'
      const base = (typeof data.text === 'string' ? data.text : '').trim() || `[${level}]`
      const count = data._count | 0
      const el = document.createElement('span')
      el.textContent = count > 1 ? `${base} ×${count}` : base
      el.className = `hs-notif-toast-text hs-notif-toast-${level}`
      return el
    },
  })

  // Whisper/DM receipt — popup toast while the user is NOT on the whispers
  // tab. The has-whispers tab badge alone was easy to miss (wollip missed
  // whispers entirely). Click jumps to the whispers tab; wrapper
  // clickToDismiss then clears the toast. Per-sender dedupe collapses a
  // burst into one toast with the latest snippet and a ×N counter.
  registerType('whisper-receipt', {
    layer: 'toast-stack',
    timeout: 6000,
    clickToDismiss: true,
    dedupeKey: ({ platform, user }) => `whisper:${platform}:${String(user || '').toLowerCase()}`,
    onDedupe: (existing, next) => {
      existing.text = next.text
      existing._count = (existing._count || 1) + 1
    },
    render: ({ data }) => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-whisper'
      const who = document.createElement('strong')
      who.textContent = data.user || '?'
      if (data.color) who.style.color = data.color
      const count = data._count | 0
      const snippet = String(data.text || '').slice(0, 80)
      el.append(who, ` whispered: ${snippet}${count > 1 ? ` ×${count}` : ''}`)
      el.addEventListener('click', () => {
        try {
          if (typeof switchTab === 'function') switchTab('whispers')
        } catch (_) {}
      })
      return el
    },
  })

  // Emote-loading — transient progress line shown while content.js fetches
  // third-party emotes (BTTV/FFZ/7TV). Persistent (no timeout): content.js
  // dismisses it via dismissByKey when loading finishes. Single fixed key so
  // repeated progress updates ("loading… (2/5)") replace the text in place.
  registerType('emote-loading', {
    layer: 'statusbar',
    dedupeKey: () => 'emote-loading',
    dedupePolicy: 'replace',
    render: ({ data }) => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-toast-info'
      el.textContent = (typeof data?.text === 'string' && data.text.trim()) || 'loading emotes…'
      return el
    },
  })

  // Twitch resub-share — user's own resub callout. Surfaces above input,
  // shows month count + Share button (clicks the native Twitch share so the
  // existing _enterResubShareMode flow runs) and X to dismiss. Native DOM is
  // hidden via CSS; we render our own controlled version.
  registerType('twitch-resub-share', {
    layer: 'chat-docked-bottom',
    channelScoped: true,
    dedupeKey: ({ months, channel }) => `resub:${channel}:${months}`,
    render: ({ data }) => {
      const months = data.months | 0
      const el = document.createElement('span')
      el.className = 'hs-notif-resub-body'
      const icon = document.createElement('span')
      icon.className = 'hs-notif-resub-icon'
      icon.textContent = '★'
      // Text broken into parts so container queries can progressively shorten:
      //   wide   "Celebrating 104 months as a subscriber"
      //   < 280  "104 months as a subscriber"
      //   < 220  "104 months"
      //   < 140  "104mo"
      // Button always remains visible — message gives up space, not the action.
      const text = document.createElement('span')
      text.className = 'hs-notif-resub-text'
      const parts = [
        ['hs-rt-prefix', 'celebrating '],
        ['hs-rt-num', String(months)],
        ['hs-rt-mo', 'mo'],
        ['hs-rt-months', ' months'],
        ['hs-rt-suffix', ' as a subscriber'],
      ]
      for (const [cls, t] of parts) {
        const s = document.createElement('span')
        s.className = cls
        s.textContent = t
        text.appendChild(s)
      }
      el.appendChild(icon)
      el.appendChild(text)
      return el
    },
    actions: {
      primary: {
        label: 'share',
        onClick: (data) => {
          // Bypass the native Twitch share button — its native onClick auto-
          // sends a default "<user> is celebrating Nmo as a subscriber!"
          // message to chat, robbing the user of the custom-message window.
          // Call _enterResubShareMode directly via the exposed API instead.
          //
          // ONLY when we hold a real token, though. Our share mode finishes by
          // calling Chat_ShareResub_UseResubToken, and with a guessed token
          // that mutation fails and falls back to posting the text as ordinary
          // chat — which looks like it worked while twitch never marks the
          // resub shared, so the callout returns on every refresh. With no
          // token, hand the click to twitch's own button: it is the only thing
          // that can actually consume the resub.
          try {
            if (data._resubToken) {
              window.__hsResubShare?.enter?.(data.months, data.user, data.channel, data._resubToken)
              return false // resub-share mode controls dismissal
            }
            const btn = data._nativeShareBtn
            if (btn) {
              window.__hsResubShare?.clickNative?.(btn)
              return true // twitch owns the flow now — close our prompt
            }
          } catch (_) {}
          return false
        },
      },
      dismiss: { label: '✕' },
    },
  })

  // Twitch watch-streak share — user's own daily watch-streak callout.
  // Mirrors resub-share UI but uses ▲ icon + orange tone. Once-per-day rate-limit
  // is enforced upstream in main.js's surface() via localStorage.
  registerType('twitch-watchstreak-share', {
    layer: 'chat-docked-bottom',
    channelScoped: true,
    dedupeKey: ({ streakCount, channel }) => `watchstreak:${channel}:${streakCount}`,
    render: ({ data }) => {
      const n = data.streakCount | 0
      const el = document.createElement('span')
      el.className = 'hs-notif-watchstreak-body'
      const icon = document.createElement('span')
      icon.className = 'hs-notif-watchstreak-icon'
      icon.textContent = '▲'
      const text = document.createElement('span')
      text.className = 'hs-notif-watchstreak-text'
      const parts = [
        ['hs-wt-prefix', 'on a '],
        ['hs-wt-num', String(n)],
        ['hs-wt-stream', ' stream'],
        ['hs-wt-suffix', ' watch streak'],
      ]
      for (const [cls, t] of parts) {
        const s = document.createElement('span')
        s.className = cls
        s.textContent = t
        text.appendChild(s)
      }
      el.appendChild(icon)
      el.appendChild(text)
      return el
    },
    actions: {
      primary: {
        label: 'share',
        onClick: (data) => {
          try {
            window.__hsWatchstreakShare?.enter?.(data.streakCount, data.user, data.channel)
          } catch (_) {}
          return false
        },
      },
      dismiss: { label: '✕' },
    },
  })

  // Server-driven "please update" prompt — fires when the version-floor in
  // /api/extension/health is above current manifest version. dedupeKey keeps
  // it to one prompt per (current, min) pair so re-fetching health doesn't
  // re-stack toasts. No auto-timeout: it stays until dismissed or update.
  registerType('hs-update-required', {
    layer: 'toast-stack',
    dedupeKey: ({ current, min }) => `upd:${current}:${min}`,
    render: ({ data }) => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-toast-warn'
      const body = data.msg
        ? String(data.msg).slice(0, 200)
        : `update available — running ${data.current}, latest is ${data.min}+`
      el.textContent = body
      return el
    },
    actions: { dismiss: { label: '✕' } },
  })

  // Send-pending — fires when an outgoing chat message hasn't echoed back from
  // the platform within PENDING_ECHO_TIMEOUT_MS (input.js). Persistent: stays
  // until the user clicks retry/dismiss, or until confirmPending() arrives
  // late and dismisses by synthId. dedupeKey=synthId keeps each failed send
  // independent so multiple stalled sends can stack without overwriting.
  registerType('send-pending', {
    layer: 'toast-stack',
    dedupeKey: ({ synthId }) => `send-pending:${synthId}`,
    render: ({ data }) => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-toast-warn'
      const reasonMap = {
        auth_failed: 'twitch auth failed',
        no_user: 'no twitch username',
        connect_failed: 'connection failed',
        send_failed: 'send failed',
        kick_not_logged_in: 'kick not logged in',
        no_kick_tab: 'no kick tab open',
        no_channel: 'kick channel not found',
        // Deliberately not worded as a failure: kick may well have posted it
        // (see kick-send.js KICK_SEND_TIMEOUT_MS). "retry" here is an informed
        // choice to send it a second time, not a repair.
        kick_unconfirmed: 'kick did not confirm — it may have posted',
        'missing params': 'kick send rejected',
        no_youtube_tab: 'no youtube tab open',
        no_input: 'youtube chat still loading',
        chat_disabled: 'log into youtube first',
        send_disabled: 'youtube blocked the send',
        send_not_confirmed: 'youtube did not confirm the send',
        bridge_timeout: 'youtube chat bridge timed out',
      }
      let why
      const _reasonStr = String(data.reason || '')
      if (data.reason === 'no_echo') {
        // Name the platform(s) that never confirmed (markPendingFailed sends
        // the awaiting set) — a kick or yt no-echo used to blame twitch.
        const plat = (data.platforms || []).map((p) => (p === 'yt' ? 'youtube' : p)).join('+')
        why = `${plat || 'platform'} did not confirm — may not have posted`
      } else if (_reasonStr.startsWith('chat_restricted')) {
        // "chat_restricted:<yt's human reason>" — surface yt's own words
        // (subscribers-only mode, members-only, follower age gate).
        const detail = _reasonStr.includes(':') ? _reasonStr.slice(_reasonStr.indexOf(':') + 1).toLowerCase() : ''
        why = detail ? `chat restricted — ${detail}` : 'chat restricted'
      } else {
        why = reasonMap[data.reason] || data.reason || 'send may have failed'
      }
      const snippet = String(data.text || '').slice(0, 60)
      el.textContent = `${why}: "${snippet}${data.text?.length > 60 ? '…' : ''}"`
      return el
    },
    actions: {
      primary: {
        label: 'retry',
        onClick: (data) => {
          try {
            globalThis.__hsRetryPendingSend?.(data.synthId)
          } catch (_) {}
          return true
        },
      },
      dismiss: { label: '✕' },
    },
  })

  // Twitch auth required — fires from cross-platform tabs (kick.com/youtube.com)
  // when the user attempts to send to a Twitch channel without a valid
  // twitch.tv auth-token cookie. Replaces the 2s placeholder-flash that users
  // physically can't read in time. dedupeKey is fixed so repeated send
  // attempts collapse to one notif.
  registerType('twitch-auth-required', {
    layer: 'toast-stack',
    dedupeKey: () => 'twitch-auth-required',
    render: ({ data }) => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-toast-error'
      el.textContent = data.text || 'log into twitch.tv to chat'
      return el
    },
    actions: {
      primary: {
        label: 'open twitch',
        onClick: () => {
          try {
            window.open('https://www.twitch.tv/', '_blank', 'noopener')
          } catch (_) {}
          return true
        },
      },
      dismiss: { label: '✕' },
    },
  })

  // AutoMod hold-queue lost its watch — background.js's automod-watch
  // registration got a 401 relink_required from the server (missing/expired
  // twitch OAuth scope). Fires at most once per SW lifetime (BG dedupes the
  // broadcast); fixed dedupeKey collapses any stray duplicate here too.
  registerType('automod-relink', {
    layer: 'toast-stack',
    dedupeKey: () => 'automod-relink',
    render: () => {
      const el = document.createElement('span')
      el.className = 'hs-notif-toast-text hs-notif-toast-warn'
      el.textContent = t('mc_automod_relink_toast')
      return el
    },
    actions: {
      primary: {
        label: t('mc_automod_relink_action'),
        onClick: () => {
          try {
            window.open('https://heatsync.org/api/auth/login?scopes=automod', '_blank', 'noopener')
          } catch (_) {}
          return true
        },
      },
      dismiss: { label: '✕' },
    },
  })

  // Server-evaluated mention rule match — heatsync.org evaluated the user's
  // saved mention rules on the server and found a match in a channel message.
  // Shows as a toast; tap/click to dismiss. Deduplicated per channel+snippet
  // to avoid repeat fires from the same message being re-evaluated.
  registerType('server-mention-rule', {
    layer: 'toast-stack',
    timeout: 8000,
    dedupeKey: ({ channel, snippet }) => `smr:${channel}:${snippet}`,
    render: ({ data }) => {
      const el = document.createElement('span')
      const who = data.username ? `${data.username}: ` : ''
      const ch = data.channel ? `[${data.channel}] ` : ''
      el.textContent = `${ch}${who}${data.snippet}`
      el.className = 'hs-notif-toast-text hs-notif-toast-mention'
      return el
    },
    actions: { dismiss: { label: '✕' } },
  })

  return {
    registerLayer,
    registerType,
    emit,
    dismiss,
    dismissByKey,
    updateLayout,
    setActiveChannels,
    _layers: layers,
    _types: types,
  }
})()

// Expose for devtools / cross-script debug. Same singleton; mutating it from
// the page will affect all multichat notifs, so use only for inspection.
try {
  window.HsNotifs = HsNotifs
} catch (_) {}
