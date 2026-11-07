// hover reply — opt-in ↪ on the hovered chat row (hoverReply, default OFF).
//
//   rowReplyState(msg, fallbackUser)   the reply target of a row, or null — the
//                                      ONE definition the row menu and this
//                                      button both read, so they reach the same rows
//   initHoverReply()                   document-wide listeners (once)
//   hoverReplyOff()                    the setting went off: drop the button now
//
// One button, moved into the row a MOUSE is over, so off means no button in any
// row. Absolute at the row's right edge (see 08-message-rows.css): the row never
// shifts. Touch keeps the long-press menu. Same reply as the menu's.

let _hoverReplyBtn = null
let _hoverReplyWired = false

function rowReplyState(msg, fallbackUser = '') {
  const d = msg?.dataset
  if (!d?.msgId) return null
  return {
    msgId: d.msgId,
    user: d.msgUser || fallbackUser,
    channel: d.msgChannel || '',
    platform: d.msgPlatform || '',
  }
}

function hoverReplyOff() {
  const b = _hoverReplyBtn
  if (!b) return
  b.parentElement?.removeAttribute('data-hs-hover-reply')
  b.remove()
}

function initHoverReply() {
  if (_hoverReplyWired) return
  _hoverReplyWired = true
  const opts = { signal: mcSignal, capture: true }
  document.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType !== 'mouse' || !hoverReplyEnabled) return
      const row = e.target.closest?.('.hs-mc-msg[data-msg-id]')
      if (!row || row.closest('#hs-mc-reply-stack, #hs-mc-reply-stack-down') || !rowReplyState(row)) return
      if (_hoverReplyBtn?.parentElement === row) return
      if (!_hoverReplyBtn) {
        const b = document.createElement('button')
        b.className = 'hs-mc-hover-reply'
        b.type = 'button'
        b.tabIndex = -1
        b.textContent = '↪'
        b.title = t('mc_input_reply')
        b.setAttribute('aria-label', t('mc_input_reply'))
        _hoverReplyBtn = b
      }
      hoverReplyOff()
      row.dataset.hsHoverReply = '1'
      row.appendChild(_hoverReplyBtn)
    },
    opts,
  )
  document.addEventListener(
    'pointerout',
    (e) => {
      const b = _hoverReplyBtn
      if (e.pointerType !== 'mouse' || !b?.parentElement) return
      if (e.relatedTarget && b.parentElement.contains(e.relatedTarget)) return
      hoverReplyOff()
    },
    opts,
  )
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest?.('.hs-mc-hover-reply')
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      const state = rowReplyState(btn.closest('.hs-mc-msg'))
      if (state) setReplyState(state)
    },
    opts,
  )
}
