// takeover.js — one rule for every surface that takes over the chat pane
// (profile card, confirm / mod panels, chat logs, predictions, the filled video
// player): while one is open the ACTIVE tab reads ← back and clicking it closes
// the surface. The class drives the label + the hidden "N new" pill in CSS
// (02-tab-bar.css, 03-overlay-container.css).
//
// (hsTakeoverCloser / hsTakeoverSync live in pane-panel.js, which the panels
// themselves call on open and close.)

// Capture: the tab's own switch handler never sees the click. With no takeover
// open the class is stale by definition — drop it and let the click through.
document.addEventListener(
  'click',
  (e) => {
    if (!e.target?.closest?.('.hs-mc-tab.active')) return
    const close = hsTakeoverCloser()
    if (!close) return hsTakeoverSync()
    e.preventDefault()
    e.stopPropagation()
    close()
  },
  { signal: mcSignal, capture: true },
)
