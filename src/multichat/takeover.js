// takeover.js — one rule for every surface that takes over the chat pane
// (profile card, confirm / mod panels, chat logs, predictions, the filled video
// player): while one is open the ACTIVE tab reads ← back and clicking it closes
// the surface. The class drives the label + the hidden "N new" pill in CSS
// (02-tab-bar.css, 03-overlay-container.css).
//
// (hsTakeoverCloser / hsTakeoverSync live in pane-panel.js, which the panels
// themselves call on open and close.)

// Capture, on pointerdown: the tab bar repaints whenever a chat line lands, and
// a repaint between press and release detaches the pressed tab, so the browser
// never fires the click (reported 2026-10-23, popout, a busy chatter's card).
// The press itself is what closes; the click that may follow is swallowed.
// With no takeover open the class is stale by definition — drop it and let the
// press through.
let hsTakeoverSwallow = 0
function hsTakeoverHit(e) {
  if (e.button > 0 || !e.target?.closest?.('.hs-mc-tab.active')) return false
  const close = hsTakeoverCloser()
  if (!close) {
    hsTakeoverSync()
    return false
  }
  e.preventDefault()
  e.stopPropagation()
  close()
  return true
}
document.addEventListener(
  'pointerdown',
  (e) => {
    if (hsTakeoverHit(e)) hsTakeoverSwallow = Date.now() + 600
  },
  { signal: mcSignal, capture: true },
)
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() < hsTakeoverSwallow && e.target?.closest?.('.hs-mc-tab')) {
      e.preventDefault()
      e.stopPropagation()
      hsTakeoverSwallow = 0
      return
    }
    hsTakeoverHit(e)
  },
  { signal: mcSignal, capture: true },
)
