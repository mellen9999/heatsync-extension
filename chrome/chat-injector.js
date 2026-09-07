// OP Message Injector - Inject followed users' red OP posts into Twitch/Kick chat
;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-injector]') : () => {}
  log(' Chat injector loaded')

  function sanitizeColor(color) {
    if (!color) return '#ffffff'
    if (/^#[0-9a-fA-F]{3,6}$/.test(color)) return color
    return '#ffffff'
  }

  // Lifecycle controller for cleanup
  const lifecycle = new AbortController()
  const injSignal = lifecycle.signal
  window.addEventListener('pagehide', () => lifecycle.abort())
  injSignal.addEventListener('abort', () => {
    document.getElementById('heatsync-emote-tooltip')?.remove()
    chrome.runtime.onMessage.removeListener(_onMessageInjector)
  })

  let followedUsers = new Set() // Users the current user follows
  const injectedMessages = new Set() // Track injected message IDs to prevent duplicates
  let chatReady = false
  let _containerMissingWarned = false // one-time ping if the container selector goes stale mid-session

  // Set up message listener IMMEDIATELY (not inside async init)
  // Named reference so we can removeListener before re-adding on SPA navigation
  function _onMessageInjector(message) {
    log(' 📬 Got runtime message:', message.type, message)
    if (message.type === 'new-message') {
      log(' 📬 Calling handleNewMessage with:', message.data)
      if (chatReady) {
        handleNewMessage(message.data)
      } else {
        log(' Chat not ready, queueing message')
        if (!window._queuedMessages) window._queuedMessages = []
        if (window._queuedMessages.length < 200) {
          window._queuedMessages.push(message.data)
        }
      }
    } else if (message.type === 'followed_users_updated') {
      followedUsers = new Set(message.users)
      log(' Updated followed users:', followedUsers.size)
    }
  }
  chrome.runtime.onMessage.removeListener(_onMessageInjector)
  chrome.runtime.onMessage.addListener(_onMessageInjector)

  // SPA navigation handler — reset stale state on channel switch
  window.addEventListener(
    'message',
    (event) => {
      // event.source===window: a same-origin twitch subframe (popout/clip) can
      // post here too; without this a co-resident frame could force a destructive
      // state reset (thrash). Mirrors every sibling postMessage guard.
      if (event.source !== window || event.origin !== location.origin) return
      if (event.data?.type === 'heatsync-nav') {
        chatReady = false
        injectedMessages.clear()
        followedUsers = new Set()
        initChatInjector()
      }
    },
    { signal: injSignal },
  )

  /**
   * Inject CSS to prevent hover effects on injected messages
   */
  function injectHoverBlockCSS() {
    if (document.getElementById('heatsync-hover-block')) return // Already injected

    const style = document.createElement('style')
    style.id = 'heatsync-hover-block'
    style.textContent = `
    .heatsync-injected-message,
    .heatsync-injected-message:hover,
    .heatsync-injected-message *,
    .heatsync-injected-message *:hover {
      background: transparent !important;
      cursor: default !important;
    }
    .heatsync-injected-message .heatsync-clickable {
      background: #ff0000 !important;
      cursor: pointer !important;
    }
    .heatsync-injected-message .heatsync-clickable:hover:not(.emote-hovered) {
      background: #fff !important;
      color: #000 !important;
    }
    .heatsync-injected-message .heatsync-emote {
      cursor: pointer !important;
      display: inline !important;
      vertical-align: middle !important;
      position: relative;
      z-index: 10;
    }
    .heatsync-injected-message .heatsync-emote:hover {
      filter: brightness(1.3);
    }
    /* Emote hover tooltip */
    #heatsync-emote-tooltip {
      position: fixed;
      z-index: 999999;
      background: #000;
      border-radius: 0;
      padding: 4px;
      pointer-events: none;
      display: none;
      transform: translate(-50%, calc(-100% - 8px));
    }
    #heatsync-emote-tooltip.active {
      display: block;
    }
    /* Size is set per-hover from the emote's own rendered rect (see
       showEmoteTooltip) so the preview is a true 4x of what's in chat. A fixed
       128px cap used to live here, which read as 4x only for a square ~28px
       emote and silently clipped every wide one to well under it — the
       "hover zoom isn't 4x" report. contain keeps the hi-res asset sharp
       inside whatever box the scale asks for. */
    #heatsync-emote-tooltip img {
      display: block;
      object-fit: contain;
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
    }
    .heatsync-injected-message .heatsync-op-badge,
    .heatsync-injected-message .heatsync-op-badge:hover {
      background: #ff0000 !important;
    }
  `
    document.head.appendChild(style)
  }

  // Hover preview magnification. Same factor the multichat overlay uses
  // (STACK_PREVIEW_SCALE in src/multichat/tooltips.js) — the two surfaces must
  // not disagree about what "zoom" means.
  const EMOTE_PREVIEW_SCALE = 4
  const PREVIEW_MARGIN = 16

  /**
   * Get max quality URL for an emote based on its CDN
   */
  function getMaxQualityEmoteUrl(url) {
    if (!url) return url
    // BTTV: /1x → /3x
    if (url.includes('cdn.betterttv.net')) {
      return url.replace(/\/[12]x(\.webp)?/, '/3x$1')
    }
    // FFZ: /1 or /2 → /4
    if (url.includes('cdn.frankerfacez.com')) {
      return url.replace(/\/[123]$/, '/4')
    }
    // 7TV: /1x or /2x → /4x
    if (url.includes('cdn.7tv.app')) {
      return url.replace(/\/[123]x(\.webp)?/, '/4x$1')
    }
    // Twitch: /1.0 or /2.0 → /3.0
    if (url.includes('static-cdn.jtvnw.net')) {
      return url.replace(/\/[12]\.0/, '/3.0')
    }
    return url
  }

  /**
   * Show emote tooltip with high-res preview
   */
  function showEmoteTooltip(emote, _event) {
    // Never preview a blocked emote's asset — chat hides it via CSS only.
    if (emote.closest?.('.emote-overlay-blocked') || emote.hasAttribute?.('data-hs-name-blocked')) return
    let tooltip = document.getElementById('heatsync-emote-tooltip')
    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.id = 'heatsync-emote-tooltip'
      const img = document.createElement('img')
      tooltip.appendChild(img)
      document.body.appendChild(tooltip)
    }

    const highResUrl = getMaxQualityEmoteUrl(emote.src)
    const img = tooltip.querySelector('img')
    if (img.src !== highResUrl) {
      img.src = highResUrl
    }

    // 4x of the size the emote actually renders at in chat, matching the
    // overlay's STACK_PREVIEW_SCALE — one zoom factor, both surfaces. Clamped
    // so a very wide emote can't grow past the viewport.
    const rect = emote.getBoundingClientRect()
    const scale = Math.min(
      EMOTE_PREVIEW_SCALE,
      (window.innerWidth - PREVIEW_MARGIN * 2) / (rect.width || 1),
      (window.innerHeight - PREVIEW_MARGIN * 2) / (rect.height || 1),
    )
    img.style.width = `${Math.round(rect.width * scale)}px`
    img.style.height = `${Math.round(rect.height * scale)}px`
    tooltip.style.left = `${rect.left + rect.width / 2}px`
    tooltip.style.top = `${rect.top - 8}px`
    tooltip.classList.add('active')
  }

  /**
   * Hide emote tooltip
   */
  function hideEmoteTooltip() {
    const tooltip = document.getElementById('heatsync-emote-tooltip')
    if (tooltip) {
      tooltip.classList.remove('active')
    }
  }

  /**
   * Setup emote hover listeners for injected messages
   */
  function setupEmoteHoverListeners(container) {
    container.querySelectorAll('.heatsync-emote').forEach((emote) => {
      if (emote._tooltipSetup) return
      emote._tooltipSetup = true
      emote.addEventListener('mouseenter', (e) => showEmoteTooltip(emote, e), { signal: injSignal })
      emote.addEventListener('mouseleave', hideEmoteTooltip, { signal: injSignal })
    })
  }

  /**
   * Initialize chat injector - wait for platform detection and WebSocket
   */
  async function initChatInjector() {
    try {
      // Wait for platform detection
      if (!window.heatsyncPlatform) {
        log(' Waiting for platform detector...')
        await new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (window.heatsyncPlatform) {
              clearInterval(checkInterval)
              resolve()
            }
          }, 100)
          injSignal.addEventListener('abort', () => clearInterval(checkInterval))
        })
      }

      const platform = window.heatsyncPlatform.detectPlatform()
      if (!platform) {
        log(' Not on Twitch/Kick, skipping')
        return
      }

      log(' Initializing on platform:', platform)

      // Wait for chat container
      const chatContainer = await window.heatsyncPlatform.waitForChatContainer()
      log(' Chat container ready:', chatContainer)

      // Inject CSS to prevent hover effects
      injectHoverBlockCSS()

      // Load followed users list
      await loadFollowedUsers()

      chatReady = true

      // Process queued messages
      if (window._queuedMessages?.length) {
        log(' Processing', window._queuedMessages.length, 'queued messages')
        window._queuedMessages.forEach(handleNewMessage)
        window._queuedMessages = []
      }

      log(' ✅ Initialized successfully')
    } catch (error) {
      // "Chat container not found" is expected on /directory, /settings, /inventory,
      // /wallet, /videos, /search etc. — pages outside a channel context. Log
      // quietly so the error buffer doesn't flood with non-actionable noise.
      const msg = String(error?.message || error || '')
      if (msg.startsWith('Chat container not found')) {
        log(' chat-injector: no chat on this page, skipping')
        return
      }
      console.error('[heatsync] chat-injector init failed:', error)
    }
  }

  /**
   * Load followed users from background script
   */
  async function loadFollowedUsers() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'get_followed_users' })
      if (response?.users) {
        followedUsers = new Set(response.users)
        log(' Loaded followed users:', followedUsers.size)
      }
    } catch {
      // Extension context may be invalidated — non-fatal
    }
  }

  /**
   * Handle new message from WebSocket
   * @param {object} message - Message data from WebSocket
   */
  function handleNewMessage(message) {
    log(' 🔍 handleNewMessage called:', {
      base36_id: message.base36_id,
      is_op: message.is_op,
      content: message.content?.substring(0, 30),
      already_injected: injectedMessages.has(message.base36_id),
    })

    // Check if message qualifies for injection
    if (!message.is_op) {
      log(' ❌ Skipping: not an OP (is_op:', message.is_op, ')')
      return // Not an OP message
    }

    if (injectedMessages.has(message.base36_id)) {
      log(' ❌ Skipping: already injected')
      return // Already injected
    }

    log(' 🔥 Injecting OP message:', message.content)
    injectMessage(message)
    injectedMessages.add(message.base36_id)
    if (injectedMessages.size > 500) {
      const arr = [...injectedMessages]
      injectedMessages.clear()
      arr.slice(-250).forEach((id) => {
        injectedMessages.add(id)
      })
    }
  }

  /**
   * Inject OP message into native chat
   * @param {object} message - Message to inject
   */
  function injectMessage(message) {
    const selectors = window.heatsyncPlatform.getPlatformSelectors()
    if (!selectors) return

    // selectors.container may be a single CSS selector string or a fallback
    // array (Kick) — qsArray (src/lib/utils.js) handles both.
    const container = qsArray(selectors.container)
    if (!container) {
      if (!_containerMissingWarned) {
        _containerMissingWarned = true
        console.error(
          '[heatsync] chat-injector: container selector matched nothing (' +
            [].concat(selectors.container).join(', ') +
            ') — OP message injection is silently disabled for this page load',
        )
      }
      return
    }

    const platform = window.heatsyncPlatform.detectPlatform()
    const messageElement = createMessageElement(message, platform)

    // Inject at the bottom of chat (new messages appear at bottom)
    container.appendChild(messageElement)

    // Prune oldest injected messages to prevent unbounded DOM growth.
    // Native chat keeps ~150 of its own; ours stack on top — keep small.
    const injected = container.querySelectorAll('.heatsync-injected-message')
    if (injected.length > 20) {
      const toRemove = injected.length - 20
      for (let i = 0; i < toRemove; i++) {
        injected[i].remove()
      }
    }

    // Setup emote hover tooltips for this message
    setupEmoteHoverListeners(messageElement)

    // Scroll to bottom if user is near bottom
    const scrollParent = container.parentElement || container
    const isNearBottom = scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 100

    if (isNearBottom) {
      requestAnimationFrame(() => {
        scrollParent.scrollTop = scrollParent.scrollHeight
      })
    }
  }

  /**
   * Create fake message element matching platform style
   * @param {object} message - Message data
   * @param {string} platform - 'twitch' | 'kick'
   * @returns {HTMLElement} Message element
   */
  function createMessageElement(message, platform) {
    const div = document.createElement('div')
    div.className = 'heatsync-injected-message'
    div.dataset.messageId = message.base36_id

    if (platform === 'twitch') {
      div.className += ' heatsync-twitch-message'
      div.innerHTML = `
      <div class="chat-line__no-background" style="padding: 0 8px; transition: none !important; opacity: 1 !important; filter: none !important; background: transparent !important; min-height: 32px;">
        <div class="chat-line__message" style="transition: none !important; background: transparent !important;">
          <span class="heatsync-op-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #ff0000; color: #ffffff; border-radius: 0 !important; font-size: 10px; font-weight: 400; font-family: monospace; margin: 0 1px; margin-right: 6px; vertical-align: middle; padding: 0; white-space: nowrap; box-sizing: border-box; line-height: 1;">OP</span>
          <span class="chat-author__display-name" style="font-weight: 700; color: ${sanitizeColor(message.user_color)}; transition: none !important;">
            ${escapeHtml(message.display_name || message.username)}
          </span>
          <span style="margin: 0 4px; transition: none !important;">:</span>
          <span class="text-fragment heatsync-clickable" style="background: #ff0000; color: #ffffff; padding: 2px 4px; font-weight: bold; transition: none !important; cursor: pointer;">${parseTwitchEmotes(message.content)}</span>
        </div>
      </div>
    `
    } else if (platform === 'kick') {
      div.className += ' heatsync-kick-message'
      div.setAttribute('data-index', 'hs-injected')
      // Safe: sanitizeColor validates hex, escapeHtml escapes all HTML entities, parseTwitchEmotes only inserts img tags with known CDN URLs
      div.innerHTML = `
      <div style="padding: 8px; margin: 4px 0; min-height: 32px;">
        <span class="heatsync-op-badge" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #ff0000; color: #ffffff; border-radius: 0; font-size: 10px; font-weight: 400; font-family: monospace; margin-right: 6px;">OP</span>
        <button class="inline font-bold" style="font-weight: 700; color: ${sanitizeColor(message.user_color) || '#00ff00'}; background: none; border: none; cursor: pointer;">
          ${escapeHtml(message.display_name || message.username)}
        </button>
        <span style="margin: 0 4px;">:</span>
        <span class="font-normal heatsync-clickable" style="background: #ff0000; color: #ffffff; padding: 2px 4px; font-weight: bold; cursor: pointer;">${parseTwitchEmotes(message.content)}</span>
      </div>
    `
    }

    // Add click handler only to red text span
    const clickableSpan = div.querySelector('.heatsync-clickable')
    if (clickableSpan) {
      clickableSpan.addEventListener(
        'click',
        (e) => {
          // Don't open post if clicking on an emote
          if (e.target.classList.contains('heatsync-emote')) {
            return
          }
          const url = `https://heatsync.org/m/${message.base36_id}`
          window.open(url, '_blank')
        },
        { signal: injSignal },
      )
    }

    // Stop emote clicks from bubbling to parent (prevents opening post when clicking emote)
    // Also handle hover state to prevent parent hover effect
    div.querySelectorAll('.heatsync-emote').forEach((emote) => {
      emote.addEventListener(
        'click',
        (e) => {
          e.stopPropagation()
          e.stopImmediatePropagation()
          e.preventDefault()
          log(' Emote clicked:', emote.alt)
          return false
        },
        { capture: true, signal: injSignal },
      )
      emote.addEventListener(
        'mouseenter',
        () => {
          clickableSpan?.classList.add('emote-hovered')
        },
        { signal: injSignal },
      )
      emote.addEventListener(
        'mouseleave',
        () => {
          clickableSpan?.classList.remove('emote-hovered')
        },
        { signal: injSignal },
      )
    })

    return div
  }

  /**
   * Escape HTML to prevent XSS
   * mirrors src/lib/utils.js escapeHtml — the two must remain identical
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    if (text == null) return ''
    return String(text).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    )
  }

  // Twitch global emotes - map of text codes to emote IDs
  const TWITCH_GLOBAL_EMOTES = {
    '<3': '9', // Heart (escaped as &lt;3 from server)
    ':)': '1',
    ':(': '2',
    ':o': '7',
    ':O': '7',
    ':z': '5',
    ':Z': '5',
    'B)': '3',
    ':\\': '10',
    ':/': '10',
    ';)': '11',
    ';p': '13',
    ';P': '13',
    ':p': '12',
    ':P': '12',
    'R)': '14',
    o_O: '6',
    O_o: '6',
    '>(': '4',
    '<]': '8',
    Kappa: '25',
    PogChamp: '305954156',
    LUL: '425618',
    '4Head': '354',
    HeyGuys: '30259',
    NotLikeThis: '58765',
    BibleThump: '86',
    ResidentSleeper: '245',
    Kreygasm: '41',
    PJSalt: '36',
    TriHard: '120232',
    CoolStoryBob: '123171',
    SeemsGood: '64138',
    VoHiYo: '81274',
  }

  /**
   * Parse Twitch emotes in text and replace with img tags
   * @param {string} text - Text content (already HTML escaped from server)
   * @returns {string} Text with emote img tags
   */
  // Pre-compiled regex + replacement HTML for each emote (built once, reused per message)
  const _emoteReplacements = Object.entries(TWITCH_GLOBAL_EMOTES)
    .filter(([code]) => code !== '<3')
    .map(([code, id]) => {
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return {
        regex: new RegExp(`(?<=^|\\s|>)${escaped}(?=$|\\s|<)`, 'g'),
        html: `<img class="chat-image chat-line__message--emote heatsync-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0" alt="${escapeHtml(code)}" style="height: 28px; vertical-align: middle;">`,
      }
    })

  function parseTwitchEmotes(text) {
    // `text` is a heatsync feed post (WS new-message from a followed user) —
    // stored PRE-ESCAPED by the server (sanitizeMessageContent → escapeHtml).
    // Re-escaping turned &amp;→&amp;amp; AND broke the &lt;3 heart match below
    // (stored &lt;3 would become &amp;lt;3). Use it as-is; the regex img
    // insertions below only add known-CDN <img> tags.
    let result = String(text == null ? '' : text)

    // Defense-in-depth: the server is a trust boundary — a MITM or a
    // sanitizer-bypass could deliver a raw `<img onerror=…>` into this innerHTML
    // sink. Neutralize any BARE `<` (properly-escaped content has none, so this
    // is a no-op there; it does NOT touch `&`, so `&amp;`/`&lt;3` stay intact).
    // Mirrors renderFeedContent in social.js, which guards the same data.
    result = result.replace(/</g, '&lt;')

    // Handle &lt;3 (escaped <3)
    result = result.replace(
      /&lt;3/g,
      '<img class="chat-image chat-line__message--emote heatsync-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/9/default/dark/1.0" alt="<3" style="height: 28px; vertical-align: middle;">',
    )

    // Use pre-compiled regexes
    for (const { regex, html } of _emoteReplacements) {
      result = result.replace(regex, html)
    }

    return result
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatInjector, { signal: injSignal })
  } else {
    initChatInjector()
  }
})()
