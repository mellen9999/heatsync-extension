// heatsync popup — channel popout only.
;(() => {
  // i18n: localize static [data-i18n*] strings from _locales, with the inline
  // HTML text as the en fallback (a missing key never blanks the UI). Dynamic
  // strings (errors/detected) use t() with the same || english guard below.
  const i18n = typeof browser !== 'undefined' && browser.i18n ? browser.i18n : chrome.i18n
  const t = (k, subs) => (i18n?.getMessage ? i18n.getMessage(k, subs) : '') || ''
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const m = t(el.dataset.i18n)
    if (m) el.textContent = m
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    const m = t(el.dataset.i18nPh)
    if (m) el.placeholder = m
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const m = t(el.dataset.i18nTitle)
    if (m) el.title = m
  }

  const input = document.getElementById('popout-input')
  const btn = document.getElementById('popout-btn')
  const detected = document.getElementById('detected')
  const platPick = document.getElementById('plat-pick')
  let platform = 'twitch'
  let ytIsHandle = false

  // Reflect the active platform on the segmented picker. A bare channel name is
  // platform-ambiguous ("trainwreckstv" streams on both), so the segment is the
  // authority for non-URL input; a pasted URL overrides it via setPlatform().
  function setPlatform(p) {
    platform = p
    for (const el of platPick.querySelectorAll('.plat')) {
      el.setAttribute('aria-selected', el.dataset.plat === p ? 'true' : 'false')
    }
  }

  function parseInput(raw) {
    const v = (raw || '').trim()
    if (!v) return null
    if (/^https?:\/\//i.test(v)) {
      try {
        const u = new URL(v)
        const h = u.hostname.replace(/^www\./, '')
        if (h.endsWith('twitch.tv')) {
          const m = u.pathname.match(/^\/(?:popout\/|embed\/)?([a-z0-9_]+)/i)
          if (m) return { platform: 'twitch', channel: m[1].toLowerCase(), isHandle: false }
        }
        if (h.endsWith('kick.com')) {
          const m = u.pathname.match(/^\/(?:popout\/)?([a-z0-9_]+)/i)
          if (m) return { platform: 'kick', channel: m[1].toLowerCase(), isHandle: false }
        }
        if (h.endsWith('youtube.com') || h === 'youtu.be') {
          const handle = u.pathname.match(/^\/@([^/]+)/)
          if (handle) return { platform: 'youtube', channel: handle[1].toLowerCase(), isHandle: true }
          const live = u.pathname.match(/^\/live\/([^/?]+)/)
          if (live) return { platform: 'youtube', channel: live[1], isHandle: false }
          const vid = u.searchParams.get('v')
          if (vid) return { platform: 'youtube', channel: vid, isHandle: false }
        }
      } catch {}
      // Looked like a URL but matched no channel — don't fall through to bare
      // stripping (which would mangle the whole url into a junk channel name).
      return null
    }
    const channel = v
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
    if (!channel) return null
    return { platform, channel, isHandle: ytIsHandle && platform === 'youtube' }
  }

  function buildUrl(p) {
    if (p.platform === 'youtube') {
      return p.isHandle
        ? `https://www.youtube.com/@${p.channel}/live`
        : `https://www.youtube.com/live_chat?v=${p.channel}&is_popout=1`
    }
    if (p.platform === 'kick') return `https://kick.com/popout/${p.channel}/chat`
    return `https://www.twitch.tv/popout/${p.channel}/chat`
  }

  async function openPopoutWindow(url) {
    if (!url) return
    const winApi = (typeof browser !== 'undefined' ? browser : chrome).windows
    const tabsApi = (typeof browser !== 'undefined' ? browser : chrome).tabs
    // type:'popup' = a clean window with no toolbar/menubar (matches the
    // multichat panel popout). The key: NO explicit left/top — position hints
    // make tiling compositors (dwl/wlroots) FLOAT the window; without them it
    // tiles into the layout. (window.open returns null from an action popup, and
    // type:'normal' drags in the full browser chrome — both wrong here.)
    if (winApi?.create) {
      try {
        await winApi.create({ url, type: 'popup', width: 400, height: 600, focused: true })
        window.close()
        return
      } catch {}
    }
    try {
      await tabsApi.create({ url })
    } catch {}
    window.close()
  }

  function openPopout() {
    const p = parseInput(input.value)
    if (!p) {
      input.focus()
      return
    }
    openPopoutWindow(buildUrl(p))
  }

  function setDetected(p, channel) {
    while (detected.firstChild) detected.removeChild(detected.firstChild)
    if (!p || !channel) return
    detected.appendChild(document.createTextNode(t('popup_detected_prefix') || 'on '))
    const b = document.createElement('b')
    b.textContent = `${p}/${channel}`
    detected.appendChild(b)
  }

  function autofillFromActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0]
      if (!tab?.url) return
      try {
        const url = new URL(tab.url)
        const host = url.hostname.replace(/^www\./, '')
        if (host.endsWith('twitch.tv')) {
          setPlatform('twitch')
          const m = url.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_]+)/)
          if (
            m &&
            ![
              'directory',
              'settings',
              'videos',
              'moderator',
              'subscriptions',
              'search',
              'jobs',
              'turbo',
              'prime',
              'p',
              'popout',
              'embed',
            ].includes(m[1].toLowerCase())
          ) {
            input.value = m[1].toLowerCase()
            setDetected('twitch', m[1].toLowerCase())
          }
        } else if (host.endsWith('kick.com')) {
          setPlatform('kick')
          const m = url.pathname.match(/^\/([a-zA-Z0-9_]+)/)
          if (m && !['categories', 'following', 'settings', 'search', 'browse'].includes(m[1].toLowerCase())) {
            input.value = m[1].toLowerCase()
            setDetected('kick', m[1].toLowerCase())
          }
        } else if (host.endsWith('youtube.com')) {
          setPlatform('youtube')
          const handle = url.pathname.match(/^\/@([^/]+)/)
          if (handle) {
            input.value = handle[1].toLowerCase()
            ytIsHandle = true
            setDetected('youtube', `@${handle[1].toLowerCase()}`)
          } else {
            const vid = url.searchParams.get('v')
            const live = url.pathname.match(/^\/live\/([^/?]+)/)
            if (vid) {
              input.value = vid
              setDetected('youtube', vid)
            } else if (live) {
              input.value = live[1]
              setDetected('youtube', live[1])
            }
          }
        }
      } catch {}
    })
  }

  for (const el of platPick.querySelectorAll('.plat')) {
    el.addEventListener('click', () => {
      setPlatform(el.dataset.plat)
      // bare input under youtube is a handle (/@name/live); video ids come via
      // pasted URL, which parseInput handles authoritatively.
      ytIsHandle = platform === 'youtube'
      setDetected(null, null)
      input.focus()
    })
  }

  btn.addEventListener('click', openPopout)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openPopout()
  })
  input.addEventListener('input', () => {
    // A pasted URL is authoritative — sync the segment to it. Otherwise keep the
    // chosen platform; a bare name under youtube is treated as a handle.
    const raw = input.value.trim()
    if (/^https?:\/\//i.test(raw)) {
      const p = parseInput(raw)
      if (p) {
        setPlatform(p.platform)
        ytIsHandle = !!p.isHandle
        return
      }
    }
    ytIsHandle = platform === 'youtube'
    setDetected(null, null)
  })
  input.addEventListener('focus', () => {
    input.select()
  })

  // Errors footer: left-click → copy last 50 to clipboard, right-click → clear.
  // Stored as ring-buffer in chrome.storage.local key 'hs_errors' by lib/error-reporter.js
  // (content scripts) and inline reporter in background.js (service worker).
  const linkErrors = document.getElementById('link-errors')
  function refreshErrorCount() {
    chrome.storage.local.get('hs_errors', (cur) => {
      const arr = Array.isArray(cur?.hs_errors) ? cur.hs_errors : []
      linkErrors.textContent = t('popup_errors_count', [String(arr.length)]) || `errors (${arr.length})`
    })
  }
  async function copyErrors() {
    const cur = await new Promise((r) => chrome.storage.local.get('hs_errors', r))
    const arr = Array.isArray(cur?.hs_errors) ? cur.hs_errors : []
    let diag = null
    try {
      diag = (await chrome.runtime.sendMessage({ type: 'get_diag' }))?.diag || null
    } catch {}
    if (arr.length === 0 && !diag) {
      linkErrors.textContent = t('popup_no_errors') || 'no errors'
      setTimeout(refreshErrorCount, 1200)
      return
    }
    const ua = navigator.userAgent
    const ver = chrome.runtime.getManifest().version
    const payload = { ver, ua, diag, count: arr.length, errors: arr }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      linkErrors.textContent = t('popup_copied', [String(arr.length)]) || `copied ${arr.length}`
    } catch {
      linkErrors.textContent = t('popup_copy_failed') || 'copy failed'
    }
    setTimeout(refreshErrorCount, 1200)
  }
  function clearErrors() {
    chrome.storage.local.remove('hs_errors', () => {
      linkErrors.textContent = t('popup_cleared') || 'cleared'
      setTimeout(refreshErrorCount, 800)
    })
  }
  linkErrors.addEventListener('click', (e) => {
    e.preventDefault()
    copyErrors()
  })
  linkErrors.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    clearErrors()
  })
  refreshErrorCount()

  // Auth state indicator: show note if not signed in
  const notSignedIn = document.getElementById('not-signed-in')
  const setupLink = document.getElementById('setup-link')
  const api = typeof browser !== 'undefined' && browser.storage ? browser : chrome
  function updateAuthUI() {
    if (!api?.storage?.local) {
      notSignedIn.hidden = true
      return
    }
    api.storage.local
      .get('auth_token_encrypted')
      .then((o) => {
        notSignedIn.hidden = !!o.auth_token_encrypted
      })
      .catch(() => {
        notSignedIn.hidden = true
      })
  }
  if (api?.storage?.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'auth_token_encrypted' in changes) updateAuthUI()
    })
  }
  setupLink.addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
  })
  updateAuthUI()

  // Feedback / bug report — footer link toggles the pane, background posts it
  // (bg owns the auth token; anonymous send still works).
  const linkFeedback = document.getElementById('link-feedback')
  const fbPane = document.getElementById('fb-pane')
  const fbText = document.getElementById('fb-text')
  const fbSend = document.getElementById('fb-send')
  const fbStatus = document.getElementById('fb-status')
  let fbKind = 'feedback'
  for (const el of document.querySelectorAll('#fb-kind .plat')) {
    el.addEventListener('click', () => {
      fbKind = el.dataset.kind
      for (const b of document.querySelectorAll('#fb-kind .plat')) b.setAttribute('aria-selected', String(b === el))
      fbText.placeholder = fbKind === 'bug' ? 'what broke? what did you expect?' : 'what should heatsync do better?'
      fbText.focus()
    })
  }
  linkFeedback.addEventListener('click', (e) => {
    e.preventDefault()
    fbPane.hidden = !fbPane.hidden
    if (!fbPane.hidden) fbText.focus()
  })
  fbSend.addEventListener('click', async () => {
    const body = fbText.value.trim()
    if (body.length < 3) {
      fbStatus.textContent = 'say a little more'
      return
    }
    fbSend.disabled = true
    fbSend.textContent = 'sending...'
    fbStatus.textContent = ''
    let url = ''
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      url = (tab?.url || '').slice(0, 2000)
    } catch {}
    const platform = /twitch\.tv/.test(url)
      ? 'twitch'
      : /kick\.com/.test(url)
        ? 'kick'
        : /youtube\.com/.test(url)
          ? 'youtube'
          : ''
    const context = {
      version: chrome.runtime.getManifest().version,
      ua: navigator.userAgent.slice(0, 500),
    }
    if (url) context.url = url
    if (platform) context.platform = platform
    let res = null
    try {
      res = await chrome.runtime.sendMessage({ type: 'bg_submit_feedback', kind: fbKind, body, context })
    } catch {}
    fbSend.textContent = 'send'
    fbSend.disabled = false
    if (res?.ok) {
      fbStatus.textContent = 'sent — thank you'
      fbText.value = ''
      setTimeout(() => {
        fbPane.hidden = true
        fbStatus.textContent = ''
      }, 1200)
    } else {
      fbStatus.textContent = 'failed to send. try again.'
    }
  })

  // Lite mode removed — the overlay always boots now.

  // Inventory slot count — personal emotes only (filter out subscription:true).
  // Also names the signed-in account: a stale/mismatched HS session is
  // invisible otherwise, and emotes added under the wrong account silently
  // render for nobody (the singuleroleroty failure).
  ;(async () => {
    const invEl = document.getElementById('inv-line')
    if (!invEl) return
    try {
      const data = await new Promise((r) =>
        chrome.storage.local.get(['auth_token_encrypted', 'emote_inventory', 'user_info'], r),
      )
      const signedIn = !!data.auth_token_encrypted
      const arr = Array.isArray(data.emote_inventory) ? data.emote_inventory : []
      const personalCount = arr.filter((e) => !e.subscription).length
      while (invEl.firstChild) invEl.removeChild(invEl.firstChild)
      if (!signedIn) {
        const s = document.createElement('span')
        s.className = 'inv-label'
        s.textContent = '5,000 emote slots'
        invEl.appendChild(s)
        return
      }
      if (data.user_info?.username) {
        const who = document.createElement('div')
        who.className = 'inv-label'
        who.textContent = `signed in as ${data.user_info.username}`
        invEl.appendChild(who)
      }
      const c = document.createElement('span')
      c.className = 'inv-count'
      c.textContent = personalCount.toLocaleString('en-US')
      invEl.appendChild(c)
      const l = document.createElement('span')
      l.className = 'inv-label'
      l.textContent = ' / 5,000 slots'
      invEl.appendChild(l)
      if (personalCount === 0) {
        const h = document.createElement('span')
        h.className = 'inv-label'
        h.textContent = ' · import a channel to fill it'
        invEl.appendChild(h)
      }
    } catch {}
  })()

  autofillFromActiveTab()
  input.focus()
})()
