// YouTube Live Chat content script — read-only message extraction
// Sends chat messages to background for multichat relay
(function() {
  'use strict'

  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[hs-youtube]') : () => {}

  const ac = new AbortController()

  // Extract videoId from URL (?v= param or /live_chat?v=)
  const videoId = new URLSearchParams(window.location.search).get('v') || ''

  function waitForContainer() {
    return new Promise((resolve, reject) => {
      let elapsed = 0
      const check = () => {
        const el = document.querySelector('yt-live-chat-item-list-renderer #items')
        if (el) return resolve(el)
        if (elapsed >= 15000) return reject(new Error('YouTube chat container not found'))
        elapsed += 500
        setTimeout(check, 500)
      }
      check()
    })
  }

  function extractMessage(el) {
    const authorEl = el.querySelector('#author-name')
    const messageEl = el.querySelector('#message')
    if (!authorEl || !messageEl) return null

    const user = authorEl.textContent.trim()
    if (!user) return null

    // Build text from child nodes — text nodes + img alt for emoji
    let text = ''
    for (const node of messageEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent
      } else if (node.nodeName === 'IMG') {
        text += node.alt || ''
      } else if (node.textContent) {
        text += node.textContent
      }
    }
    text = text.trim()
    if (!text) return null

    return { user, text }
  }

  function processNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return
    if (node.tagName !== 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') return
    if (node.dataset.hsYtProcessed) return
    node.dataset.hsYtProcessed = '1'

    const msg = extractMessage(node)
    if (!msg) return

    log('yt msg:', msg.user, msg.text)

    chrome.runtime.sendMessage({
      type: 'youtube_chat_message',
      videoId,
      user: msg.user,
      text: msg.text,
      color: '#ff0000',
      time: Date.now(),
      platform: 'youtube'
    }).catch(() => {})
  }

  async function init() {
    try {
      const container = await waitForContainer()
      log('found chat container')

      // Process existing messages
      for (const child of container.children) {
        requestAnimationFrame(() => processNode(child))
      }

      // Watch for new messages
      const observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            requestAnimationFrame(() => processNode(node))
          }
        }
      })

      observer.observe(container, { childList: true })
      ac.signal.addEventListener('abort', () => observer.disconnect())

      log('observer active, videoId:', videoId)
    } catch (err) {
      log('init failed:', err.message)
    }
  }

  init()
})()
