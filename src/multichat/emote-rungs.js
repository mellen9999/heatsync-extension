// emote-rungs.js — the smaller copies of our own uploads (server/lib/emote-variants
// on the site). Kept apart from emotes.js, which sits at its line ceiling; the
// provider-ladder code that calls this stays in emotes.js with getChatResUrl.

/**
 * Our own uploads keep a 32/64/96px copy beside the 128px file (4x), named
 * <hash>-1x.webp etc, and the payload lists the ones that exist as `variants`
 * (["1x","2x","3x","4x"]). Without that list nothing is guessed: an old upload
 * has no copies, and the url is the only file. With it, the smallest advertised
 * rung that is at least `want` — the canonical file when none is.
 */
const HS_OWN_UPLOAD = /^(https:\/\/cdn\.heatsync\.org\/uploads\/[A-Za-z0-9_-]+)\.webp$/
function hsOwnRungUrl(url, want, variants) {
  const m = HS_OWN_UPLOAD.exec(url)
  if (!m || !Array.isArray(variants)) return url
  for (const rung of [1, 2, 3]) {
    if (rung >= want && variants.includes(`${rung}x`)) return `${m[1]}-${rung}x.webp`
  }
  return url
}

/**
 * A chat emote <img> that failed on one of our own smaller copies — the cdn
 * mirror has not synced it yet (a new upload is advertised seconds before the
 * mirror has it). The 128px original is always there, so go straight to it
 * instead of the retry-with-backoff a flaky third-party cdn gets. True when
 * handled.
 */
function hsOwnCopyFallback(img) {
  const m = /^(https:\/\/cdn\.heatsync\.org\/uploads\/[A-Za-z0-9_-]+)-[123]x\.webp/.exec(img.src)
  if (!m) return false
  img.src = `${m[1]}.webp`
  return true
}
