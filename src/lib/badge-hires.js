// Hi-res badge preview, shared by the native tooltip (content.js) and the
// overlay's (multichat/tooltips.js). Inline badges render at 18px (1x); the
// tooltip shows them at 72px, so we want the CDN's largest variant. Only
// 7TV/FFZ/twitch expose size variants and their max differs (7TV 3x-4x, FFZ 4,
// twitch 3), so candidates are listed descending and probed in turn. BTTV and
// Chatterino are single-resolution: nothing to upgrade.
function hiResBadgeCandidates(src) {
  if (!src) return []
  if (src.includes('7tv'))
    return ['4x', '3x', '2x'].map((s) =>
      src.replace(/\/[1-4]x(\.\w+)?(\?.*)?$/i, (_m, ext, q) => `/${s}${ext || ''}${q || ''}`),
    )
  if (src.includes('frankerfacez'))
    return ['4', '2'].map((s) => src.replace(/\/[1-4](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
  // Twitch native badges (sub/bits/mod/vip) — URLs end in /1, /2, /3 (max 3, no 4x)
  if (src.includes('jtvnw')) return ['3', '2'].map((s) => src.replace(/\/[1-3](\?.*)?$/, (_m, q) => `/${s}${q || ''}`))
  return []
}

// Keep the 1x showing, probe each hi-res candidate, swap img.src to the first
// that loads. No blank flash, no broken-image icon when a variant 404s.
function upgradeBadgeImg(img, src) {
  const cands = hiResBadgeCandidates(src).filter((u) => u && u !== src)
  let i = 0
  const tryNext = () => {
    if (i >= cands.length || !img.isConnected) return
    const url = cands[i++]
    const probe = new Image()
    probe.onload = () => {
      if (img.isConnected && img.dataset.hsBadgeOrig === src) img.src = url
    }
    probe.onerror = tryNext
    probe.src = url
  }
  tryNext()
}
