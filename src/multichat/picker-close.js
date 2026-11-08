// picker-close.js — how the emote picker's document-level click + Esc close
// handlers come and go. Split out of emotes.js (line ceiling); the
// `_pickerCloseHandler` binding itself is still declared there.

let _pickerEscHandler = null
// cleanup.addEventListener wraps the handler, so the handlers above are not
// what is registered on the document: taking them down means calling what
// cleanup.addEventListener handed back. (removeEventListener(handler) matched
// nothing, and a click + a keydown listener piled up on every open.)
let _pickerCloseOff = null
let _pickerEscOff = null
let _pickerAttachTimer = null

/** Take down the document-level close handlers. */
function detachPickerCloseHandlers() {
  if (_pickerAttachTimer != null) cleanup.clearTimeout(_pickerAttachTimer)
  _pickerAttachTimer = null
  if (_pickerCloseOff) _pickerCloseOff()
  if (_pickerEscOff) _pickerEscOff()
  _pickerCloseHandler = null
  _pickerEscHandler = null
  _pickerCloseOff = null
  _pickerEscOff = null
}

/**
 * The one way to close the panel from code.
 *
 * Those document handlers self-remove when THEY close the picker, so anything
 * that closes it on its own has to take them down too — or the next Escape
 * still runs hideInputBar(), over a composer the reader is typing into. A gif
 * pick is the first close that does not go through them.
 *
 * `keepInput` is for exactly that case: the panel goes away, the composer does
 * not, because the reader is mid-send with a url already in the box.
 */
function closeEmotePickerPanel({ keepInput = false } = {}) {
  const picker = document.getElementById('hs-mc-emote-picker')
  if (!picker) return
  picker.classList.remove('visible')
  if (!keepInput) hideInputBar()
  stopPredictionPoll()
  detachPickerCloseHandlers()
}

function attachPickerCloseHandler(picker) {
  detachPickerCloseHandlers()
  _pickerAttachTimer = cleanup.setTimeout(() => {
    _pickerAttachTimer = null
    _pickerCloseHandler = (e) => {
      if (mcSignal?.aborted) return detachPickerCloseHandlers()
      if (!picker.contains(e.target) && !e.target.closest('#hs-mc-emote-btn')) closeEmotePickerPanel()
    }
    _pickerEscHandler = (e) => {
      if (e.key !== 'Escape') return
      if (mcSignal?.aborted) return detachPickerCloseHandlers()
      closeEmotePickerPanel()
    }
    _pickerCloseOff = cleanup.addEventListener(document, 'click', _pickerCloseHandler, 'mc-picker-close')
    _pickerEscOff = cleanup.addEventListener(document, 'keydown', _pickerEscHandler, 'mc-picker-esc')
  }, 0)
}
