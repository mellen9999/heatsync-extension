// Platform detector - Detect Twitch vs Kick chat
;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[heatsync-platform]') : () => {}
  log(' Platform detector loaded')

  // mirrors src/lib/utils.js qsArray — kept local because this file is a
  // standalone copy-as-is content script (build.js COPY_FILES) with no
  // access to the bundled lib scope. Accepts a single CSS selector string
  // or an ordered array of fallback selectors, trying each until one hits.
  function qsArray(selectors, root = document) {
    if (!root) return null
    if (typeof selectors === 'string') return root.querySelector(selectors)
    if (!Array.isArray(selectors)) return null
    for (const sel of selectors) {
      const el = root.querySelector(sel)
      if (el) return el
    }
    return null
  }

  // mirrors src/lib/config.js SELECTORS.KICK_CHAT_CONTAINER — single source
  // of truth is config.js; this copy must stay in sync (see that file's
  // comment for the fallback-order rationale).
  const KICK_CHAT_CONTAINER = [
    '#chatroom-messages .no-scrollbar',
    '#chatroom-messages',
    '#channel-chatroom',
    '#channel-chatroom [class*="messages"]',
    '[class*="chat-messages-container"]',
  ]

  // mirrors src/lib/config.js SELECTORS.KICK_IDENTITY
  const KICK_IDENTITY = [
    '.chat-identity-name',
    '[class*="chat-identity"] span',
    '[class*="chat-identity"]',
    '[class*="chat-author"]',
    'button.inline.font-bold',
    '[class*="chat-entry-username"]',
    '[class*="chat-message-identity"] button',
  ]

  /**
   * Detect which platform the user is on
   * @returns {string|null} 'twitch' | 'kick' | null
   */
  function detectPlatform() {
    const hostname = window.location.hostname

    // m.twitch.tv serves a genuinely separate mobile DOM none of our
    // selectors match (manifest exclude_matches already keeps every content
    // script from injecting there at all — this keeps the detector honest
    // for any future caller that reaches it a different way).
    if (hostname === 'm.twitch.tv') {
      return null
    }

    if (hostname.includes('twitch.tv')) {
      return 'twitch'
    } else if (hostname.includes('kick.com')) {
      return 'kick'
    } else if (hostname.includes('youtube.com')) {
      return 'youtube'
    }

    return null
  }

  /**
   * Get platform-specific chat selectors
   * @returns {object|null} { container, message, username, messageText } | null
   */
  function getPlatformSelectors() {
    const platform = detectPlatform()

    if (platform === 'twitch') {
      return {
        container: '.chat-scrollable-area__message-container',
        message: '.chat-line__message',
        username: '.chat-author__display-name',
        messageText: '.text-fragment',
        messageContainer: '.chat-line__no-background',
      }
    } else if (platform === 'kick') {
      return {
        container: KICK_CHAT_CONTAINER,
        message: '[data-index], [data-chat-entry], #chatroom-messages .no-scrollbar > div > div',
        username: KICK_IDENTITY,
        messageText: 'span.font-normal, [class*="chat-entry-content"], [class*="chat-message"] > span',
        messageContainer: '[data-index], [data-chat-entry], #chatroom-messages .no-scrollbar > div > div',
      }
    } else if (platform === 'youtube') {
      return {
        container: 'yt-live-chat-item-list-renderer #items',
        message: 'yt-live-chat-text-message-renderer',
        username: '#author-name',
        messageText: '#message',
        messageContainer: 'yt-live-chat-text-message-renderer',
      }
    }

    return null
  }

  /**
   * Wait for chat container to be ready
   * @returns {Promise<Element>} Chat container element
   */
  function waitForChatContainer() {
    const selectors = getPlatformSelectors()
    if (!selectors) {
      return Promise.reject(new Error('Unsupported platform'))
    }

    return new Promise((resolve, reject) => {
      let elapsed = 0
      const check = () => {
        const container = qsArray(selectors.container)
        if (container && container.offsetHeight > 0) {
          resolve(container)
        } else if (elapsed >= 15000) {
          // Accept hidden container as fallback (Kick may show it later)
          const hidden = qsArray(selectors.container)
          if (hidden) resolve(hidden)
          else reject(new Error('Chat container not found after 15s'))
        } else {
          elapsed += 500
          setTimeout(check, 500)
        }
      }
      check()
    })
  }

  // Export for use in other scripts
  window.heatsyncPlatform = {
    detectPlatform,
    getPlatformSelectors,
    waitForChatContainer,
  }
})()
