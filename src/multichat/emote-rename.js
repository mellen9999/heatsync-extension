// Rename an emote of yours, from the emote's right-click menu. The server owns the rule (a name
// that is taken answers 409, a bad one 400); the line the viewer reads comes from the shared
// emote notice (src/lib/emote-notice.js), never from the server's own words.

const EMOTE_NAME_MAX = 32

// A small name box in the pane panel (the same place a mod's warn reason is asked).
// Resolves the trimmed new name, or null when cancelled / unchanged / empty.
function emoteRenamePrompt(oldName) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hs-ms-input'
    input.maxLength = EMOTE_NAME_MAX
    input.autocomplete = 'off'
    input.value = oldName
    input.setAttribute('aria-label', t('hsbtn_rename'))
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'hs-mc-confirm-cancel'
    cancel.textContent = t('mc_ms_cancel')
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'hs-mc-confirm-ok'
    save.textContent = t('mc_mr_save')
    let finishRef = null
    cancel.addEventListener('click', () => finishRef?.(false, true))
    save.addEventListener('click', () => finishRef?.(true, true))
    const panel = hsPanePanelOpenWith({
      label: `${t('hsbtn_rename')} :${oldName}:`,
      body: input,
      buttons: [cancel, save],
      onKey: (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        finishRef?.(true, true)
      },
      onDone: (ok) => {
        const next = input.value.trim()
        resolve(ok && next && next !== oldName && !/\s/.test(next) ? next.slice(0, EMOTE_NAME_MAX) : null)
      },
    })
    if (!panel) return resolve(null)
    finishRef = activePanePanel.finish
    input.focus()
    input.select()
  })
}

/**
 * Rename an emote of yours. Says the shared notice line either way; on success the local
 * inventory maps follow the new name, so the picker and the next line sent use it.
 * @returns {Promise<boolean>} whether the server renamed it
 */
async function renameEmoteInInventory(oldName, newName) {
  const slot = viewerPersonalEmotes.get(oldName)?.slot
  if (!oldName || !newName || !Number.isInteger(slot)) {
    const n = emoteNotice('rename', 0, newName || oldName)
    showToast(n.text, n.kind)
    return false
  }
  pendingEmoteOps.add(oldName)
  try {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'api_fetch', path: `/api/user/emotes/${slot}/rename`, method: 'PUT', auth: true, body: { newName } },
        (r) => resolve(chrome.runtime.lastError ? undefined : r),
      )
    })
    const ok = !!resp && resp.ok !== false
    const n = emoteNotice('rename', ok ? 200 : (resp?.status ?? 0), newName)
    showToast(n.text, n.kind)
    if (!ok) return false
    const entry = viewerPersonalEmotes.get(oldName)
    viewerPersonalEmotes.delete(oldName)
    if (entry) viewerPersonalEmotes.set(newName, entry)
    inventoryEmotes.delete(oldName)
    inventoryEmotes.add(newName)
    const hash = inventoryHashes.get(oldName)
    inventoryHashes.delete(oldName)
    if (hash) {
      inventoryHashes.set(newName, hash)
      emoteHashes.set(newName, hash)
      hashToName.set(hash, newName)
    }
    return true
  } catch (_) {
    const n = emoteNotice('rename', 0, newName)
    showToast(n.text, n.kind)
    return false
  } finally {
    pendingEmoteOps.delete(oldName)
  }
}
