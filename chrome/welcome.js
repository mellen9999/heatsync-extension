function t(k) {
  if (window.hsI18n) return window.hsI18n.t(k)
  try {
    return chrome.i18n.getMessage(k) || k
  } catch {
    return k
  }
}
;(async () => {
  if (window.hsI18n) await window.hsI18n.init()
  document.documentElement.dir = window.hsI18n ? window.hsI18n.bidiDir() : t('@@bidi_dir')
  if (window.hsI18n) {
    window.hsI18n.hydrate(document)
  } else {
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n) || el.textContent
  }
  document.title = t('welcome_title')
})()

// Deep-link the CTA to the hottest live twitch/kick channel instead of the
// twitch front page — click → busy chat → emotes render → wow, no browsing
// step in between. Fail path: /api/live/top failing or coming back empty
// used to silently keep the default href (twitch.tv's front page) while the
// copy still implied a specific stream was picked — reinstating the exact
// "browse for a stream" step this CTA exists to remove. Swap to honest copy
// instead so the CTA never over-promises.
;(async () => {
  const cta = document.querySelector('.cta[data-when="out"]')
  try {
    const res = await fetch('https://heatsync.org/api/live/top?limit=50')
    if (!res.ok) throw new Error('live/top not ok')
    const { streams } = await res.json()
    const usable = (streams || []).filter(
      (x) => (x?.platform === 'twitch' || x?.platform === 'kick') && /^[a-zA-Z0-9_]{2,32}$/.test(x?.username || ''),
    )
    // Prefer a simulcaster (≥2 platforms) so the first click demos the
    // multichat weave, not just emotes; hottest single-platform otherwise.
    const s = usable.find((x) => Object.keys(x?.platformUsernames || {}).length >= 2) || usable[0]
    if (!s) throw new Error('no live streams')
    if (!cta) return
    cta.href = s.platform === 'kick' ? `https://kick.com/${s.username}` : `https://www.twitch.tv/${s.username}`
    const label = t('welcome_cta_live')
    cta.textContent = `${label === 'welcome_cta_live' ? 'watch live' : label} → ${s.username}`
  } catch {
    if (cta) cta.textContent = t('welcome_cta_fallback')
  }
})()

// Live success state: the moment oauth completes (in the tab we open), the
// background script writes auth_token_encrypted to storage.local. Swap the
// sign-in elements for the "you're in + next action" block so this tab closes
// the loop instead of sitting stale. Fail-safe: if storage is unavailable we
// never hide the CTA, so the logged-out path always works.
;(() => {
  const KEY = 'auth_token_encrypted'
  const api = typeof browser !== 'undefined' && browser.storage ? browser : chrome
  if (!api?.storage?.local) return
  const render = (loggedIn) => {
    for (const el of document.querySelectorAll('[data-when]')) el.hidden = (el.dataset.when === 'in') !== !!loggedIn
  }
  api.storage.local
    .get(KEY)
    .then((o) => render(!!o[KEY]))
    .catch(() => {})
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) render(!!changes[KEY].newValue)
  })
})()

// Headline import step — one-click "pull every 7tv/bttv/ffz emote you
// already have into your heatsync set". Reuses the exact server endpoint
// (POST /api/user/emotes/import-channel) and message shape as the in-chat
// import CTA (chrome/heatsync-button.js hsImportChannel / src/multichat/
// emotes.js hsMcImportChannelEmotes) — the only new thing here is resolving
// WHICH channel to import: welcome.html has no page channel context, so it
// imports the just-signed-in user's OWN linked handle (background.js's
// fetchUserInfo writes user_info to storage.local right after login).
;(() => {
  const api = typeof browser !== 'undefined' && browser.storage ? browser : chrome
  const btn = document.getElementById('hs-import-btn')
  if (!api?.storage?.local || !btn) return

  // Twitch > kick > youtube — same preference order used elsewhere for a
  // same-name platform guess (getLivePlatformNames et al).
  function ownChannel(info) {
    if (info?.twitch_username) return { channel: info.twitch_username, platform: 'twitch' }
    if (info?.kick_username) return { channel: info.kick_username, platform: 'kick' }
    if (info?.youtube_username) return { channel: info.youtube_username, platform: 'youtube' }
    return null
  }

  const label = t('welcome_import_cta')
  let own = null
  let busy = false

  // Never actually disabled — even with no linked platform yet the button
  // stays clickable, just pointing at account-linking instead of a dead end.
  function renderButtonState() {
    btn.classList.remove('ok', 'err')
    btn.textContent = own ? label : t('welcome_import_no_platform')
  }

  function applyUserInfo(info) {
    own = ownChannel(info)
    if (!busy) renderButtonState()
  }

  api.storage.local
    .get('user_info')
    .then((o) => applyUserInfo(o.user_info))
    .catch(() => {})
  // user_info is written by a separate async call than auth_token_encrypted
  // (both fire off the same login event) — if it lands after this button is
  // first shown, pick it up live instead of leaving the button stuck locked.
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'user_info' in changes) applyUserInfo(changes.user_info.newValue)
  })

  btn.addEventListener('click', async () => {
    if (busy) return
    if (!own) {
      window.open('https://heatsync.org/settings/account', '_blank', 'noopener')
      return
    }
    busy = true
    btn.classList.remove('ok', 'err')
    btn.textContent = t('welcome_import_importing')
    try {
      const resp = await api.runtime.sendMessage({
        type: 'api_fetch',
        path: '/api/user/emotes/import-channel',
        method: 'POST',
        auth: true,
        body: { channel: own.channel, platform: own.platform },
      })
      if (resp && resp.ok !== false) {
        const n = resp.data?.imported ?? resp.imported ?? resp.data?.count ?? 0
        btn.textContent = chrome.i18n.getMessage('welcome_import_done', [String(n)]) || label
        btn.classList.add('ok')
      } else {
        btn.textContent = t('welcome_import_failed')
        btn.classList.add('err')
        setTimeout(renderButtonState, 2500)
      }
    } catch {
      btn.textContent = t('welcome_import_failed')
      btn.classList.add('err')
      setTimeout(renderButtonState, 2500)
    } finally {
      busy = false
    }
  })
})()
