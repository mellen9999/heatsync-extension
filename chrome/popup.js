// Heatsync Popup - Minimal status view
(function() {
  'use strict'

  const API_URL = 'https://heatsync.org'

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  async function init() {
    const content = document.getElementById('content')
    const dot = document.getElementById('status-dot')

    // Load stored data
    const stored = await chrome.storage.local.get([
      'auth_token', 'auth_token_encrypted', 'user_info', 'emote_inventory', 'global_emotes', 'blocked_emotes'
    ])

    // Check API connectivity
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 3000)
      const resp = await fetch(`${API_URL}/api/health`, { signal: controller.signal })
      if (resp.ok) {
        dot.className = 'status-dot green'
        dot.title = 'connected'
      } else {
        dot.className = 'status-dot red'
        dot.title = 'api error'
      }
    } catch {
      dot.className = 'status-dot red'
      dot.title = 'offline'
    }

    const token = stored.auth_token || stored.auth_token_encrypted
    const user = stored.user_info

    if (token && user) {
      // Logged in
      const rawAvatar = user.avatar_url || user.profile_image_url || ''
      const avatar = rawAvatar.startsWith('https://') ? rawAvatar : ''
      const name = user.display_name || user.username || 'user'
      const emoteCount = (stored.emote_inventory || []).length
      const globalCount = (stored.global_emotes || []).length

      content.innerHTML = `
        <div class="user-section">
          <div class="user-row">
            ${avatar ? `<img src="${escapeHtml(avatar)}" class="user-avatar" alt="">` : '<div class="user-avatar"></div>'}
            <div>
              <div class="user-name">${escapeHtml(name)}</div>
              <div class="user-stats">${emoteCount} emotes · ${globalCount} global</div>
            </div>
          </div>
        </div>
        <div class="actions">
          <a href="https://heatsync.org/emotes" target="_blank" class="action-btn">emotes</a>
          <button class="action-btn" id="refresh-btn">refresh</button>
          <a href="https://heatsync.org" target="_blank" class="action-btn">site</a>
        </div>
      `

      document.getElementById('refresh-btn')?.addEventListener('click', async (e) => {
        e.target.textContent = '...'
        e.target.disabled = true
        await chrome.runtime.sendMessage({ type: 'refresh_all' })
        e.target.textContent = 'done'
        setTimeout(() => { e.target.textContent = 'refresh'; e.target.disabled = false }, 1000)
      })
    } else {
      // Not logged in
      content.innerHTML = `
        <div class="login-section">
          log in to sync emotes
          <br>
          <a href="https://heatsync.org" target="_blank" class="login-btn">heatsync.org</a>
        </div>
      `
    }
  }

  function initPopout() {
    const input = document.getElementById('popout-input')
    const btn = document.getElementById('popout-btn')

    // auto-fill from active tab if on twitch
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.url) return
      try {
        const url = new URL(tab.url)
        if (url.hostname.includes('twitch.tv')) {
          const m = url.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_]+)/)
          if (m && !['directory', 'settings', 'videos', 'moderator', 'subscriptions'].includes(m[1].toLowerCase())) {
            input.value = m[1].toLowerCase()
          }
        }
      } catch {}
    })

    function openPopout() {
      const channel = input.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
      if (!channel) { input.focus(); return }
      chrome.tabs.create({ url: `https://www.twitch.tv/popout/${channel}/chat` })
    }

    btn.addEventListener('click', openPopout)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openPopout()
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch(e => console.error('popup init failed:', e))
    initPopout()
  })
})()
