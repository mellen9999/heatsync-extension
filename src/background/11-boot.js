// background part 11 of 11 — boot.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// History-pull endpoints
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  // Reject messages from other extensions — must be this extension's own scripts.
  const _senderUrl2 = sender?.tab?.url || sender?.url || ''
  const _isFromPopup2 = !sender?.tab
  const _isOwnExt2 = sender?.id === chrome.runtime.id
  const _isValidOrigin2 =
    _isFromPopup2 ||
    /^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|kick\.com|heatsync\.org|youtube\.com)(\/|$)/.test(_senderUrl2)
  if (!(_isOwnExt2 && _isValidOrigin2)) {
    sendResponse({ ok: false, error: 'unauthorized sender' })
    return true
  }
  if (message.type === 'bg_kick_history') {
    const ch = (message.channel || '').toLowerCase()
    ;(async () => {
      try {
        if (!BG_KICK.storageRestored) await bgKickRestoreFromStorage()
        const buf = BG_KICK.channels.get(ch)
        sendResponse({ ok: true, msgs: buf ? buf.getAll() : [] })
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e), msgs: [] })
      }
    })()
    return true
  }
  if (message.type === 'bg_kick_append') {
    ;(async () => {
      if (!BG_KICK.storageRestored) await bgKickRestoreFromStorage()
      sendResponse({ ok: true, added: bgKickAppend(message.channel, message.msgs) })
    })()
    return true
  }
  if (message.type === 'bg_kick_mark') {
    ;(async () => {
      if (!BG_KICK.storageRestored) await bgKickRestoreFromStorage()
      sendResponse({ ok: true, changed: bgKickMarkFromTab(message) })
    })()
    return true
  }
  // The saved mentions list (multichat's Mentions tab, ~500 rows). One record in
  // the background's IndexedDB: tabs hand it over and read it back by message,
  // never through storage.local (every write there clones the value into every
  // tab's onChanged). Last writer wins, as before.
  if (message.type === 'bg_mentions_put') {
    const msgs = Array.isArray(message.msgs) ? message.msgs.slice(-500) : []
    const owner = typeof message.owner === 'string' ? message.owner.slice(0, 64) : ''
    bgIdbPut(BG_IDB_MENTIONS, 'v2', { msgs, ts: Date.now(), owner }).then(() => sendResponse({ ok: true }))
    return true
  }
  if (message.type === 'bg_mentions_get') {
    ;(async () => {
      let row = await bgIdbGet(BG_IDB_MENTIONS, 'v2')
      if (!row) {
        // one-time: the list a build before the IndexedDB move kept in storage.local
        const legacy = (await browser.storage.local.get('hs_mentions_v2').catch(() => ({}))).hs_mentions_v2
        if (legacy?.msgs) {
          row = legacy
          await bgIdbPut(BG_IDB_MENTIONS, 'v2', legacy)
        }
        browser.storage.local.remove('hs_mentions_v2').catch(() => {})
      }
      sendResponse({ ok: true, msgs: row?.msgs || [], ts: row?.ts || 0, owner: row?.owner || '' })
    })()
    return true
  }
  return false
})

// Boot restore
bgKickRestoreFromStorage()
bgYtRestoreFromStorage()
// A token saved by an older release moves onto the real key now, not whenever
// the cookie happens to be unreadable. A failure just means a sign-in later.
retrieveToken().catch((err) => log(' token migration failed:', err?.message))

// Evaluation-complete marker. A service worker that throws partway through
// still REGISTERS, so "a worker exists" proves nothing — scripts/smoke-extension.ts
// asserts this flag instead, which is only reachable if the whole file ran.
// Must stay the last statement in this file.
self.__hsBootOk = true
