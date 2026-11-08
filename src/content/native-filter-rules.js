// Chat filter rules on NATIVE twitch/kick chat (content.js) — highlight words
// with the overlay off. The engine is the overlay's own (filter-rules.js) and
// the fold of the old text filters is the overlay's own (filter-rules-legacy.js):
// build.js embeds all three into content.js, so nothing here is a second copy of
// the logic. Highlight only, all-channel rules only: native chat never hid by
// text, and a rule scoped to an overlay tab has no tab here. Native rows carry
// text + sender, so badge / message-type rules don't match.
// Self-contained — deps come in through createNativeFilterRules, so tests import it.

const NATIVE_ROW_TEXT_SEL = '.text-fragment, [data-a-target="chat-message-text"], span.font-normal'
const NATIVE_ROW_USER_SEL =
  '.chat-author__display-name, [data-a-target="chat-message-username"], button.inline.font-bold'
const NATIVE_HL_CLASS = 'hs-keyword-match'

/** the row a native message element belongs to (twitch .chat-line__message, kick [data-index]) */
function nativeRowOf(el) {
  let row = el
  while (row && !row.classList.contains('chat-line__message') && !row.hasAttribute('data-index')) {
    row = row.parentElement
  }
  return row || el
}

/**
 * @param {object} d
 * @param {Document} d.document
 * @param {object} d.storage       browser.storage ({ sync, local })
 * @param {(m: object) => Promise} d.send   safeSendMessage
 * @param {'twitch'|'kick'} d.site
 * @param {() => string} d.me       the signed-in login, lower case ('' = unknown)
 * @param {object} d.engine        { compileFilterRules, evaluateFilterRules }
 * @param {object} d.legacy        { foldLegacyFilters, LEGACY_LOCAL_KEYS, LEGACY_UI_KEYS }
 * @param {(key: string, value: string) => boolean} d.syncEligible   isLargeKeySyncEligible
 */
function createNativeFilterRules({ document, storage, send, site, me, engine, legacy, syncEligible }) {
  let hlRules = false

  function load(raw) {
    let rules = null
    try {
      rules = JSON.parse(raw || '[]')
    } catch {}
    if (!Array.isArray(rules)) rules = []
    engine.compileFilterRules(rules)
    hlRules = rules.some((r) => r && r.action === 'highlight' && r.enabled !== false)
  }

  // Add-only on purpose: a re-sweep after emote replacement sees less text and
  // must not take a highlight back. repaint() is the one place that clears.
  function highlight(el, username, fragments) {
    if (!hlRules) return
    // own messages are exempt, as in the overlay
    const self = me()
    if (self && username && username.toLowerCase() === self) return
    let text = ''
    for (const f of fragments || el.querySelectorAll(NATIVE_ROW_TEXT_SEL)) {
      const s = f.textContent
      if (s) text = text ? `${text} ${s}` : s
    }
    if (!text) return
    if (engine.evaluateFilterRules({ text, user: username || '' }, null).highlight) {
      nativeRowOf(el).classList.add(NATIVE_HL_CLASS)
    }
  }

  function repaint() {
    for (const el of document.querySelectorAll(`.${NATIVE_HL_CLASS}`)) el.classList.remove(NATIVE_HL_CLASS)
    if (!hlRules) return
    for (const row of document.querySelectorAll('.chat-line__message, [data-index]')) {
      highlight(row, (row.querySelector(NATIVE_ROW_USER_SEL)?.textContent || '').trim())
    }
  }

  // The old highlight / mute / automod words fold into rules wherever heatsync
  // runs. With the overlay on, the overlay does it (after its server seed); with
  // it off on this site nothing else would, so this does — the same fold, and
  // the result rides the same server channel a settings edit does. Resolves to
  // the rules to run.
  async function fold() {
    const [synced, local] = await Promise.all([
      storage.sync.get('ui_settings'),
      storage.local.get([...legacy.LEGACY_LOCAL_KEYS, 'chat_filter_rules']),
    ])
    const ui = synced?.ui_settings || {}
    if (ui.subsystems?.[`overlay-${site}`] !== false) return local.chat_filter_rules
    const json = legacy.foldLegacyFilters(ui, local)
    // unreadable rules: keep every old value and leave the rules alone
    if (json === false) return local.chat_filter_rules
    if (json) {
      await storage.local.set({ chat_filter_rules: json })
      if (syncEligible('chatFilterRules', json)) {
        send({ type: 'ws_send', data: { type: 'ui-state:sync', patch: { chatFilterRules: json } } }).catch(() => {})
      }
    }
    await storage.local.remove(legacy.LEGACY_LOCAL_KEYS)
    // only the filter keys: the overlay adopts the other retired keys at hydration, then drops them
    if (legacy.LEGACY_UI_KEYS.some((k) => k in ui)) {
      await send({ type: 'ui_settings_rmw', patch: {}, dropRetired: legacy.LEGACY_UI_KEYS })
    }
    return json || local.chat_filter_rules
  }

  /** boot: fold (overlay off), then load + paint what is on screen */
  function start() {
    return fold()
      .catch(() => storage.local.get('chat_filter_rules').then((d) => d.chat_filter_rules))
      .then((raw) => {
        load(raw)
        repaint()
      })
      .catch(() => {})
  }

  return { load, highlight, repaint, fold, start }
}

export { createNativeFilterRules, NATIVE_HL_CLASS, nativeRowOf }
