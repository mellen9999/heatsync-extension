/**
 * type-to-focus — start typing while reading chat and the keystroke lands in
 * the composer instead of nowhere.
 *
 * heatsync.org has had this for a while (client/chat/type-to-focus.js); the
 * extension never did, so on twitch the same keystroke was simply swallowed.
 * Reported as: "im typing and its not auto going into the input box? i dont
 * have vi mode even."
 *
 * WHY THIS IS NOT A COPY OF THE SITE'S VERSION
 *
 * On heatsync.org the whole page is ours, so claiming every printable key is
 * free. On twitch.tv we are a guest in someone else's document, and the host
 * owns single-key shortcuts on the player: space/k pause, m mutes, f goes
 * fullscreen, t theatre, c captions, digits seek. A global "any letter focuses
 * our box" would quietly break all of them, which is a far worse bug than the
 * one being fixed — and it would be blamed on twitch, not on us.
 *
 * So the gate is attention, not availability: we take the keystroke only when
 * the pointer is over our panel (you are reading OUR chat) — or when the panel
 * IS the window, in a popout, where there is no host UI left to steal from.
 * Hovering is checked live via :hover rather than tracked with enter/leave
 * bookkeeping that can desync when the panel re-renders under the cursor.
 *
 * WHERE IT LISTENS
 *
 * On the root element (<html>), in the capture phase. That one spot is after
 * every capture listener on window and document, which is where our own
 * single-key handlers live (vi's i/a, `\`, row mode): one of them claiming the
 * key shows as `defaultPrevented`, and we stand down. And it is before every
 * listener on the way back up, which is where the host's player shortcuts
 * live. It used to listen on document in the bubble phase, behind the host:
 * on twitch and kick, `k` with the pointer over chat paused the stream, and
 * on twitch the letter was not even typed (e2e s22, 11-17). Taking the key
 * here and stopping it is what keeps the player from hearing it.
 */

/** The composer, if one is actually usable right now. */
function findComposer() {
  const el = document.getElementById('hs-mc-input')
  if (!el) return null
  // offsetParent is null for display:none and for a detached node — either way
  // focusing it would send the keystroke into a void, which is the exact bug
  // the site version hit when it targeted a hidden omnibar input.
  if (el.offsetParent === null) return null
  return el
}

/** Is the user's attention on our panel? See the header for why this exists. */
function attentionIsOnPanel() {
  if (document.body?.classList.contains('hs-popout')) return true
  const c = document.getElementById('hs-mc-container')
  if (!c) return false
  try {
    return c.matches(':hover')
  } catch (_) {
    return false
  }
}

/** Put the caret at the end and insert one character, for either composer shape. */
function insertChar(el, ch) {
  if (el.isContentEditable) {
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    // execCommand is deprecated but is still the only call that produces a
    // native input event + undo entry in a contenteditable; the ext's own
    // emote insertion uses it for the same reason.
    document.execCommand('insertText', false, ch)
    return
  }
  // plain <input> (wysiwyg off)
  const start = el.value.length
  el.value += ch
  try {
    el.setSelectionRange(start + 1, start + 1)
  } catch (_) {}
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function initTypeToFocus(signal) {
  document.documentElement.addEventListener(
    'keydown',
    (e) => {
      // printable single character only — no shortcuts, no navigation keys
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!e.key || e.key.length !== 1) return
      // A key one of our own capture handlers already claimed must not ALSO be
      // typed. preventDefault upstream does not stop us; the flag does.
      if (e.defaultPrevented) return
      // never steal from something already accepting text — ours or the host's
      const a = document.activeElement
      if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return
      if (!attentionIsOnPanel()) return

      const input = findComposer()
      if (!input) return

      input.focus()
      insertChar(input, e.key)
      // Claim it and end it here, so the host does not ALSO act on the key we
      // just consumed (its listeners are all still ahead on the event's path).
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    { signal, capture: true },
  )
}
