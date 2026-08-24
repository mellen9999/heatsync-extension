// @ts-check
/**
 * Unified browser API wrapper for Chrome/Firefox compatibility.
 * Handles chrome.* vs browser.* API differences.
 *
 * Usage:
 *   import { api } from './lib/browser-api.js'
 *
 *   // Storage
 *   await api.storage.local.get('key')
 *   await api.storage.local.set({ key: value })
 *
 *   // Runtime messaging
 *   api.runtime.sendMessage({ type: 'foo' })
 *   api.runtime.onMessage.addListener(handler)
 */

// Detect browser environment.
// Do NOT use `typeof browser !== 'undefined'` — the content bundle aliases
// `browser = globalThis.browser || chrome`, so that test is true on Chrome too,
// which silently mis-routed FF-only branches (e.g. promisify, emote-CDN format).
// navigator.userAgent is the reliable cross-world signal (Firefox UA contains
// "Firefox"; no Chromium-family UA does), with the moz-extension URL scheme as a
// corroborating check for extension pages.
const isFirefox =
  (typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)) ||
  (typeof location !== 'undefined' && location.protocol === 'moz-extension:')
const isChrome = !isFirefox && typeof chrome !== 'undefined'

// Get the raw API object — prefer the API matching the detected browser, with a
// fallback chain so a missing global can never null out the wrapper.
const rawApi =
  (isFirefox && typeof browser !== 'undefined' && browser) ||
  (typeof chrome !== 'undefined' && chrome) ||
  (typeof browser !== 'undefined' && browser) ||
  null

let _ctxInvalidatedLogged = false
let _storageMissingLogged = false
function _warnStorageMissing() {
  if (_storageMissingLogged) return
  // Storage being absent is usually benign: MAIN-world injection
  // (autocomplete-hook, etc.) where chrome.* never exists by design, and
  // fresh-boot/teardown races while the context is still valid. Diagnosing
  // those as "context invalidated" was misdiagnosis noise on every boot.
  // Only warn when a runtime object exists but its id is gone — the actual
  // invalidation signal (accessing .id can also throw then).
  let invalidated = false
  try {
    invalidated = !!rawApi?.runtime && !rawApi.runtime.id
  } catch {
    invalidated = true
  }
  if (!invalidated) return
  _storageMissingLogged = true
  console.warn('[heatsync] Storage API not available (extension context invalidated — page reload needed)')
  // NOTE: do NOT arm a reload here. The canonical reload trigger is the
  // "Extension context invalidated" error thrown by runtime.sendMessage;
  // reload-arming lives there instead.
}

/**
 * Promisify Chrome callback-based APIs
 * Firefox's browser.* APIs are already Promise-based
 */
function promisify(fn) {
  if (isFirefox) return fn // Already returns promises

  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (result) => {
        if (rawApi?.runtime?.lastError) {
          reject(new Error(rawApi.runtime.lastError.message))
        } else {
          resolve(result)
        }
      })
    })
}

/**
 * Storage API wrapper
 */
const storage = {
  local: {
    get: async (keys) => {
      if (!rawApi?.storage?.local) {
        _warnStorageMissing()
        return {}
      }
      if (isFirefox) {
        return rawApi.storage.local.get(keys)
      }
      return promisify(rawApi.storage.local.get.bind(rawApi.storage.local))(keys)
    },
    set: async (items) => {
      if (!rawApi?.storage?.local) {
        _warnStorageMissing()
        return
      }
      if (isFirefox) {
        return rawApi.storage.local.set(items)
      }
      return promisify(rawApi.storage.local.set.bind(rawApi.storage.local))(items)
    },
    remove: async (keys) => {
      if (!rawApi?.storage?.local) return
      if (isFirefox) {
        return rawApi.storage.local.remove(keys)
      }
      return promisify(rawApi.storage.local.remove.bind(rawApi.storage.local))(keys)
    },
    clear: async () => {
      if (!rawApi?.storage?.local) return
      if (isFirefox) {
        return rawApi.storage.local.clear()
      }
      return promisify(rawApi.storage.local.clear.bind(rawApi.storage.local))()
    },
  },
  sync: {
    get: async (keys) => {
      if (!rawApi?.storage?.sync) return {}
      if (isFirefox) {
        return rawApi.storage.sync.get(keys)
      }
      return promisify(rawApi.storage.sync.get.bind(rawApi.storage.sync))(keys)
    },
    set: async (items) => {
      if (!rawApi?.storage?.sync) return
      if (isFirefox) {
        return rawApi.storage.sync.set(items)
      }
      return promisify(rawApi.storage.sync.set.bind(rawApi.storage.sync))(items)
    },
  },
  onChanged: {
    addListener: (callback) => {
      if (rawApi?.storage?.onChanged) {
        rawApi.storage.onChanged.addListener(callback)
      }
    },
    removeListener: (callback) => {
      if (rawApi?.storage?.onChanged) {
        rawApi.storage.onChanged.removeListener(callback)
      }
    },
  },
}

/**
 * Runtime API wrapper
 */
const runtime = {
  sendMessage: async (message) => {
    if (!rawApi?.runtime?.sendMessage) {
      console.warn('[heatsync] Runtime API not available')
      return null
    }
    try {
      if (isFirefox) {
        return await rawApi.runtime.sendMessage(message)
      }
      return promisify(rawApi.runtime.sendMessage.bind(rawApi.runtime))(message)
    } catch (err) {
      // Extension context invalidated (common during updates) — log once per session
      if (err.message?.includes('Extension context invalidated')) {
        if (!_ctxInvalidatedLogged) {
          _ctxInvalidatedLogged = true
          console.warn('[heatsync] Extension context invalidated')
          // Canonical ctx-death signal: runtime.sendMessage threw this exact
          // error. Unambiguous (unlike storage-missing which fires in MAIN
          // world too). Arm a deferred-to-visibility reload, dedupe via the
          // global flag content/bootstrap/main use.
          try {
            if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__heatsyncReloadScheduled) {
              window.__heatsyncReloadScheduled = true
              const doReload = () => {
                try {
                  location.reload()
                } catch (_) {}
              }
              if (document.visibilityState === 'visible') {
                setTimeout(doReload, 1000 + Math.random() * 4000)
              } else {
                // focus/pageshow escape hatches — popout windows can miss the
                // hidden→visible visibilitychange (see bootstrap.js ctx-death)
                const wake = () => {
                  if (document.visibilityState !== 'visible' && !document.hasFocus()) return
                  document.removeEventListener('visibilitychange', wake)
                  window.removeEventListener('focus', wake)
                  window.removeEventListener('pageshow', wake)
                  setTimeout(doReload, 500 + Math.random() * 2000)
                }
                document.addEventListener('visibilitychange', wake)
                window.addEventListener('focus', wake)
                window.addEventListener('pageshow', wake)
              }
            }
          } catch (_) {}
        }
        return null
      }
      throw err
    }
  },
  onMessage: {
    addListener: (callback) => {
      if (rawApi?.runtime?.onMessage) {
        rawApi.runtime.onMessage.addListener(callback)
      }
    },
    removeListener: (callback) => {
      if (rawApi?.runtime?.onMessage) {
        rawApi.runtime.onMessage.removeListener(callback)
      }
    },
  },
  getURL: (path) => {
    if (rawApi?.runtime?.getURL) {
      return rawApi.runtime.getURL(path)
    }
    return path
  },
  get id() {
    return rawApi?.runtime?.id || 'heatsync-extension'
  },
  get lastError() {
    return rawApi?.runtime?.lastError
  },
}

/**
 * Tabs API wrapper (for background scripts)
 */
const tabs = {
  query: async (queryInfo) => {
    if (!rawApi?.tabs?.query) return []
    if (isFirefox) {
      return rawApi.tabs.query(queryInfo)
    }
    return promisify(rawApi.tabs.query.bind(rawApi.tabs))(queryInfo)
  },
  sendMessage: async (tabId, message) => {
    if (!rawApi?.tabs?.sendMessage) return null
    try {
      if (isFirefox) {
        return await rawApi.tabs.sendMessage(tabId, message)
      }
      return promisify(rawApi.tabs.sendMessage.bind(rawApi.tabs))(tabId, message)
    } catch (_) {
      // Tab may have closed
      return null
    }
  },
  create: async (createProperties) => {
    if (!rawApi?.tabs?.create) return null
    if (isFirefox) {
      return rawApi.tabs.create(createProperties)
    }
    return promisify(rawApi.tabs.create.bind(rawApi.tabs))(createProperties)
  },
}

/**
 * Check if extension context is valid
 */
function isContextValid() {
  try {
    return !!rawApi?.runtime?.id
  } catch (_) {
    return false
  }
}

/**
 * Get platform info
 */
const platform = {
  isFirefox,
  isChrome,
  manifestVersion: isFirefox ? 2 : 3,
  name: isFirefox ? 'firefox' : 'chrome',
}

// Export unified API
const api = {
  storage,
  runtime,
  tabs,
  platform,
  isContextValid,
  raw: rawApi,
}

/**
 * i18n helper — wraps chrome.i18n.getMessage with optional manual locale override.
 * Override is read from storage key 'hs_ui_locale'; matching locale's messages.json
 * is fetched from the extension's _locales/ at boot. Until the fetch resolves,
 * t() falls back to the browser's default locale via chrome.i18n.
 */
const I18N_STORAGE_KEY = 'hs_ui_locale'
let _i18nOverride = null
let _i18nOverrideLocale = ''
let _i18nInitPromise = null

function _i18nApplyPlaceholders(messageObj, substitutions) {
  if (!messageObj) return ''
  let message = String(messageObj.message ?? messageObj)
  const placeholders = messageObj.placeholders || {}
  const phLookup = {}
  for (const [name, def] of Object.entries(placeholders)) {
    phLookup[name.toLowerCase()] = def?.content || ''
  }
  let subsArr = []
  if (substitutions != null) {
    subsArr = Array.isArray(substitutions) ? substitutions : [substitutions]
  }
  const ESC = ''
  message = message.split('$$').join(ESC)
  message = message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name) => {
    const content = phLookup[name.toLowerCase()]
    if (content === undefined) return match
    return content.replace(/\$(\d+)/g, (_, n) => subsArr[parseInt(n, 10) - 1] ?? '')
  })
  message = message.replace(/\$(\d+)/g, (_, n) => subsArr[parseInt(n, 10) - 1] ?? '')
  message = message.split(ESC).join('$')
  return message
}

// chrome.i18n.getMessage returns '' — not the message — when ANY substitution is
// null/undefined or a non-string. The old `|| key` then rendered the raw key
// straight into the UI ("mc_input_send_channel" sitting in the composer, seen
// live 2026-07-21). One caller passing an unresolved value could do that to any
// of the 600+ strings, so the coercion belongs here, not at each call site.
function _i18nSubs(substitutions) {
  if (substitutions == null) return undefined
  const arr = Array.isArray(substitutions) ? substitutions : [substitutions]
  return arr.map((s) => (s == null ? '' : String(s)))
}

function t(key, substitutions) {
  if (!key) return ''
  const subs = _i18nSubs(substitutions)
  if (key.startsWith('@@')) {
    try {
      return rawApi?.i18n?.getMessage(key, subs) || key
    } catch {
      return key
    }
  }
  if (_i18nOverride?.[key]) {
    const out = _i18nApplyPlaceholders(_i18nOverride[key], subs)
    if (out) return out
  }
  try {
    const msg = rawApi?.i18n?.getMessage(key, subs)
    if (msg) return msg
    // Still empty with sanitized subs ⇒ the substitution COUNT is wrong for this
    // message. Retry bare: a template with a visible $PLACEHOLDER$ is ugly, but
    // it's real copy — a raw key is a bug leaking onto the user's screen.
    const bare = subs ? rawApi?.i18n?.getMessage(key) : ''
    return bare || key
  } catch {
    return key
  }
}

async function _i18nFetchLocale(loc) {
  if (!loc) return null
  try {
    const url = rawApi?.runtime?.getURL?.(`_locales/${loc}/messages.json`)
    if (!url) return null
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function initI18n() {
  if (_i18nInitPromise) return _i18nInitPromise
  _i18nInitPromise = (async () => {
    try {
      const data = await storage.local.get(I18N_STORAGE_KEY)
      const loc = data?.[I18N_STORAGE_KEY]
      if (!loc) {
        // chrome reports Filipino as fil but the catalog ships as tl, so chrome.i18n never matches it
        let ui = ''
        try {
          ui = rawApi?.i18n?.getUILanguage?.() || ''
        } catch {}
        if (/^fil([-_]|$)/.test(ui)) _i18nOverride = await _i18nFetchLocale('tl')
        return
      }
      const catalog = await _i18nFetchLocale(loc)
      if (!catalog) return
      _i18nOverride = catalog
      _i18nOverrideLocale = loc
    } catch {}
  })()
  return _i18nInitPromise
}

function getI18nLocale() {
  return _i18nOverrideLocale
}

const I18N_LOCALE_NAMES = {
  '': 'Auto (browser language)',
  ar: 'العربية',
  bg: 'Български',
  cs: 'Čeština',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'Español',
  fi: 'Suomi',
  fr: 'Français',
  he: 'עברית',
  hi: 'हिन्दी',
  hu: 'Magyar',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  ms: 'Bahasa Melayu',
  nl: 'Nederlands',
  no: 'Norsk',
  pl: 'Polski',
  pt_BR: 'Português (Brasil)',
  pt_PT: 'Português (Portugal)',
  ro: 'Română',
  ru: 'Русский',
  sk: 'Slovenčina',
  sv: 'Svenska',
  th: 'ไทย',
  tl: 'Filipino',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  zh_CN: '简体中文',
  zh_TW: '繁體中文',
}

async function setI18nLocale(loc) {
  await storage.local.set({ [I18N_STORAGE_KEY]: loc || '' })
  _i18nOverride = null
  _i18nOverrideLocale = ''
  _i18nInitPromise = null
  await initI18n()
}
function bidiDir() {
  if (_i18nOverrideLocale) {
    const rtl = ['ar', 'he', 'fa', 'ur']
    return rtl.includes(_i18nOverrideLocale.toLowerCase().split('_')[0]) ? 'rtl' : 'ltr'
  }
  try {
    return rawApi?.i18n?.getMessage('@@bidi_dir') || 'ltr'
  } catch {
    return 'ltr'
  }
}

// Kick off override load eagerly so content scripts pick it up before panel renders
try {
  initI18n()
} catch {}

function hydrateI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const h = /** @type {HTMLElement} */ (el)
    h.textContent = t(h.dataset.i18n) || h.textContent
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const h = /** @type {HTMLInputElement} */ (el)
    h.placeholder = t(h.dataset.i18nPlaceholder) || h.placeholder
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const h = /** @type {HTMLElement} */ (el)
    h.title = t(h.dataset.i18nTitle) || h.title
  }
}

// Global export for non-module scripts
if (typeof window !== 'undefined') {
  window.heatsyncApi = api
}

export {
  api,
  bidiDir,
  getI18nLocale,
  hydrateI18n,
  I18N_LOCALE_NAMES,
  initI18n,
  isContextValid,
  platform,
  runtime,
  setI18nLocale,
  storage,
  t,
  tabs,
}
export default api
