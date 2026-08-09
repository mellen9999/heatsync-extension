// Styles - all CSS for multichat panel, tabs, messages, modals

// ============================================
// STYLES (injected once)
// ============================================

function injectStyles() {
  if (document.getElementById('hs-mc-styles')) return

  const style = document.createElement('style')
  style.id = 'hs-mc-styles'
  const css = '__HS_STYLES_BUNDLE__'
  const cozetteUrl =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('fonts/CozetteVector.woff2') : ''
  style.textContent = css.replace(/__HS_FONT_COZETTE__/g, cozetteUrl)
  document.head.appendChild(cleanup.trackNode(style))
  // Default to bitmap-mode on style inject — Cozette is the default font.
  // applyFontSettings() flips this off if the user picked a non-bitmap font.
  // Set here so tabs render crisp even before the async settings load fires
  // (settings hydration races with container mount; bare default prevents
  // the brief AA-on flash).
  document.body.classList.add('hs-font-bitmap')
  document.documentElement.classList.add('hs-font-bitmap')
  declareDarkColorScheme()
}

// UA auto-dark (chromium WebContentsForceDark / android "darken websites")
// double-inverts hosts that render dark but never declare it — twitch's dark
// theme has no color-scheme meta, so the whole page (overlay included) paints
// inverted to light. Declaring `dark` makes the UA skip the page. Gated on the
// host actually rendering dark so the declaration is never a lie; no-op when
// the page already declares a scheme (heatsync.org does).
function declareDarkColorScheme() {
  try {
    // Chromium only. This is a workaround for a chromium-family force-dark
    // behaviour; gecko has no equivalent, so on firefox the meta buys nothing
    // and is pure blast radius — it is a PAGE-LEVEL declaration, so it retimes
    // the host's own canvas, controls, scrollbars and same-origin frames, not
    // just our overlay. It landed in 1.7.43 and is the one change a firefox
    // reporter could bisect the white player to; 1.7.42 (without it) is clean
    // for them. cfbb08b scoped the per-element color-scheme RULES and left this
    // page-level stamp untouched, which is why the report survived 1.7.45-47.
    // navigator.userAgentData is chromium-only (gecko/webkit don't ship it) —
    // a structural signal rather than a UA-string sniff.
    if (!navigator.userAgentData) return
    if (document.head.querySelector('meta[name="color-scheme"]')) return
    const channels = (el) => {
      const c = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g)
      if (!c || c.length < 3) return null
      if (c.length > 3 && Number(c[3]) === 0) return null // transparent
      return c.slice(0, 3).map(Number)
    }
    const rgb = channels(document.body) || channels(document.documentElement)
    if (!rgb) return
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    if (luminance > 60) return // host is light-themed — not ours to declare
    const meta = document.createElement('meta')
    meta.name = 'color-scheme'
    meta.content = 'dark'
    document.head.appendChild(cleanup.trackNode(meta))
  } catch (_) {}
}
