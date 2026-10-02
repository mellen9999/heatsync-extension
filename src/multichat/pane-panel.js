// pane-panel.js — a popup that is the whole message pane. Shared by the user
// card (profile-card.js) and the confirm dialog (hsConfirm, below).
//
// The panel fills #hs-mc-messages (below the tabs + 2nd row); the 2nd row
// (#hs-mc-subrow) carries the surface's actions and ONE thick × as its last
// cell. Esc, ×, or a tab switch closes it and the row goes back to what it was.

// Draw `items` ([{label,href,external?,live?}]) + the × into the 2nd row.
function hsPaneMountRow(items, onClose) {
  const row = document.getElementById('hs-mc-subrow')
  if (!row) return
  row.replaceChildren(
    ...items.map((it) => {
      const a = document.createElement('a')
      a.className = 'hs-mc-dest'
      a.textContent = it.label + (it.live ? ' ●' : '')
      a.href = it.external ? it.href : `https://heatsync.org${it.href}`
      a.target = '_blank'
      a.rel = 'noopener'
      return a
    }),
  )
  row.append(hsXButton('hs-x-cell', 'close', onClose))
  row.hidden = false
}

let activePanePanel = null // { el, finish }

function hsPanePanelOpen() {
  return !!activePanePanel
}

// A tab switch tears the panel down WITHOUT touching the row: the switch repaints
// the row for the new tab itself. The pending promise resolves as a cancel.
function hsPanePanelAbort() {
  if (activePanePanel) activePanePanel.finish(false, false)
}

// Mount `body` (node) + `buttons` (nodes, laid out at the bottom) as the pane
// panel. Resolves once with whatever `settle(v)` is given. `onKey` may claim a key.
// Returns null (nothing mounted) when the pane isn't there.
function hsPanePanelOpenWith({ label, body, buttons, onKey, onDone }) {
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return null
  if (activePanePanel) activePanePanel.finish(false, true)
  const row = document.getElementById('hs-mc-subrow')
  const savedRow = row ? { nodes: [...row.childNodes], hidden: row.hidden } : null
  const el = document.createElement('div')
  el.className = 'hs-pane-panel'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', label)
  const bodyEl = document.createElement('div')
  bodyEl.className = 'hs-pane-body'
  bodyEl.append(body)
  const actions = document.createElement('div')
  actions.className = 'hs-pane-actions'
  actions.append(...buttons)
  el.append(bodyEl, actions)

  let closed = false
  const finish = (value, restoreRow) => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', keyHandler, true)
    el.remove()
    if (activePanePanel?.el === el) activePanePanel = null
    if (restoreRow && row && savedRow) {
      row.replaceChildren(...savedRow.nodes)
      row.hidden = savedRow.hidden
      // chat rows that arrived while the panel covered the pane are in the buffer
      if (typeof activeProfileCard !== 'undefined' && activeProfileCard) renderProfileCardView()
      else if (typeof activeChatLogs !== 'undefined' && activeChatLogs) {
        // chat-logs paints itself on its own data; nothing was skipped for it
      } else if (typeof predViewOpen === 'function' && predViewOpen()) renderPredView()
      else if (typeof renderMessages === 'function') renderMessages(currentTab)
    }
    onDone?.(value)
  }
  const keyHandler = (e) => {
    // a repaint that wiped the pane took the panel with it: nothing to answer
    if (!el.isConnected) return finish(false, false)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(false, true)
      return
    }
    onKey?.(e, finish)
  }
  document.addEventListener('keydown', keyHandler, true)
  hsPaneMountRow([], () => finish(false, true))
  msgsEl.appendChild(el)
  activePanePanel = { el, finish }
  return el
}

// Confirm dialog — Promise<{ ok, reason }>. Esc / × / tab switch = cancel, Enter =
// confirm. `reasons` (optional) renders selectable chips; the chosen one comes back
// in `reason` (empty if none / cancelled). Reusable for any destructive action.
// The pane absent (overlay not mounted) resolves a cancel: a destructive action
// never runs on a dialog nobody could see.
function hsConfirm(message, confirmLabel = 'confirm', reasons = []) {
  return new Promise((resolve) => {
    let selectedReason = ''
    const body = document.createElement('div')
    const msg = document.createElement('div')
    msg.className = 'hs-mc-confirm-msg'
    msg.textContent = message
    body.append(msg)
    if (Array.isArray(reasons) && reasons.length) {
      const chips = document.createElement('div')
      chips.className = 'hs-mc-confirm-reasons'
      for (const rsn of reasons) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'hs-mc-confirm-reason'
        chip.textContent = rsn
        chip.addEventListener('click', () => {
          const wasSel = chip.classList.contains('sel')
          for (const c of chips.querySelectorAll('.hs-mc-confirm-reason')) c.classList.remove('sel')
          selectedReason = wasSel ? '' : rsn
          if (!wasSel) chip.classList.add('sel')
        })
        chips.append(chip)
      }
      body.append(chips)
    }
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'hs-mc-confirm-cancel'
    cancelBtn.textContent = 'cancel'
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = 'hs-mc-confirm-ok'
    okBtn.textContent = confirmLabel
    let finishRef = null
    cancelBtn.addEventListener('click', () => finishRef?.(false, true))
    okBtn.addEventListener('click', () => finishRef?.(true, true))
    const el = hsPanePanelOpenWith({
      label: message,
      body,
      buttons: [cancelBtn, okBtn],
      onKey: (e, finish) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        finish(true, true)
      },
      onDone: (v) => resolve({ ok: !!v, reason: v ? selectedReason : '' }),
    })
    if (!el) return resolve({ ok: false, reason: '' })
    finishRef = activePanePanel.finish
    okBtn.focus()
  })
}
