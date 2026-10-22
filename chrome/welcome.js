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

document.getElementById('hs-close-btn')?.addEventListener('click', () => window.close())
