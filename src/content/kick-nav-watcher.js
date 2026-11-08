// Runs in MAIN world at document_start on Kick BEFORE Kick's JS.
// Hooks history.pushState/replaceState + popstate so the content script
// detects SPA nav INSTANTLY (via window.postMessage) instead of waiting
// up to 5 seconds for the URL-poll fallback. Without this, Kick's React
// tears down #channel-chatroom + the chat-layout parent before our panel
// has a chance to migrate to <body>, and the multichat overlay flashes/
// reloads on every streamer switch.
//
// Mirrors the Twitch path in early-inject-main.js exactly; this file
// exists separately because early-inject-main.js carries 800 lines of
// Twitch-specific instrumentation (Hermes WS, GQL fetch, emote rewriting)
// that has no business running on Kick.
;(() => {
  if (window.__heatsyncKickNav) return
  window.__heatsyncKickNav = true

  const origPushState = history.pushState.bind(history)
  const origReplaceState = history.replaceState.bind(history)

  function notifyNav() {
    try {
      window.postMessage({ type: 'heatsync-nav', url: location.href }, location.origin)
    } catch {}
  }

  history.pushState = (...args) => {
    origPushState(...args)
    notifyNav()
  }

  history.replaceState = (...args) => {
    origReplaceState(...args)
    notifyNav()
  }

  window.addEventListener('popstate', notifyNav, { passive: true })
})()
