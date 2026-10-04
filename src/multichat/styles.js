// Styles - all CSS for multichat panel, tabs, messages, modals

// ============================================
// STYLES (injected once)
// ============================================

function injectStyles() {
  if (document.getElementById('hs-mc-styles')) return

  const style = document.createElement('style')
  style.id = 'hs-mc-styles'
  const css = '__HS_STYLES_BUNDLE__'
  style.textContent = css
  document.head.appendChild(cleanup.trackNode(style))
}

// The page-level `<meta name="color-scheme" content="dark">` this file used to
// stamp on the host is GONE. It was never a declaration about our overlay — it
// was a declaration about someone else's page, and it reached everything on it.
//
// What it bought: chromium force-dark skips a page that declares itself dark,
// so twitch (dark, but declaring nothing) stopped being double-inverted to
// light. The per-element `color-scheme: dark` rules in styles/00-palette.css
// took that job over and do it better — they shield every hs- root regardless
// of host theme or meta timing, which is exactly why they were added.
//
// What it cost: a white video player. Suppressing force-dark for the PAGE
// suppresses it for the frames on it too, and a twitch overlay extension is a
// frame stacked on the player — one whose light surface force-dark had been
// darkening. Declare the page dark and that surface renders as-is: a white
// rectangle over the whole video, appearing and disappearing exactly as the
// extension is toggled. The same symptom was reported on firefox and bisected
// to the commit that added this (1.7.43); gating it to chromium in 7c2f77e
// fixed that reporter and left every chromium user with it.
//
// The shield we need is per-element and already applied. Do not reintroduce a
// page-level stamp — force-dark on the host page is the user's setting, and
// overriding it for a page we do not own is not a thing this extension does.
