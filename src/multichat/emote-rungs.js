// emote-rungs.js — the smaller copies of our own uploads (server/lib/emote-variants
// on the site). Kept apart from emotes.js, which sits at its line ceiling; the
// provider-ladder code that calls this stays in emotes.js with getChatResUrl.

/**
 * Our own uploads keep a 32/64/96px copy beside the 128px file (4x), named
 * <hash>-1x.webp etc, and the payload says which exist as `variants`. Two wire
 * shapes, both read here:
 *
 *   list    ["1x","2x","3x","4x"]  the rungs that exist; the url of a rung is
 *           the canonical url with -Nx before .webp (cdn.heatsync.org only);
 *   object  {"1x": url, "2x": url, "3x": url}  the url of each rung, as given
 *           — taken only if it is a heatsync upload file of THIS emote at THAT
 *           rung (a payload cannot point a chat emote at another file).
 *
 * Without `variants` nothing is guessed: an old upload has no copies, and the
 * url is the only file. With it, the smallest advertised rung that is at least
 * `want` — the canonical file when none is.
 */
const HS_OWN_UPLOAD = /^(https:\/\/cdn\.heatsync\.org\/uploads\/[A-Za-z0-9_-]+)\.webp$/
const HS_UPLOAD_ID = /^https:\/\/(?:cdn\.)?heatsync\.org\/uploads\/([A-Za-z0-9_-]+)\.webp$/
const HS_RUNG_FILE = /^https:\/\/(?:cdn\.)?heatsync\.org\/uploads\/([A-Za-z0-9_-]+)-([123])x\.webp$/
function hsOwnRungUrl(url, want, variants) {
  if (!variants) return url
  if (Array.isArray(variants)) {
    const m = HS_OWN_UPLOAD.exec(url)
    if (!m) return url
    for (const rung of [1, 2, 3]) {
      if (rung >= want && variants.includes(`${rung}x`)) return `${m[1]}-${rung}x.webp`
    }
    return url
  }
  const id = typeof variants === 'object' ? HS_UPLOAD_ID.exec(url)?.[1] : null
  if (!id) return url
  for (const rung of [1, 2, 3]) {
    if (rung < want) continue
    const v = variants[`${rung}x`]
    const m = typeof v === 'string' ? HS_RUNG_FILE.exec(v) : null
    if (m && m[1] === id && m[2] === String(rung)) return v
  }
  return url
}

/**
 * ` width="W" height="H"` for an <img> whose emote has a measured natural size,
 * else ''. The img is `width:auto; height:var(--hs-emote-size)` (10-emotes.css),
 * and with both attributes the browser derives the aspect ratio before the file
 * is decoded, so the box is its final width from the first paint (measured in
 * chromium: 256x64 → 132px before decode, 132px after) — a row of emotes no
 * longer pushes its text sideways as they trickle in. Integers only, bounded.
 */
function hsEmoteDimAttr(emote) {
  const w = emote?.width
  const h = emote?.height
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096
    ? ` width="${w}" height="${h}"`
    : ''
}

/**
 * A chat emote <img> that failed on one of our own smaller copies — the cdn
 * mirror has not synced it yet (a new upload is advertised seconds before the
 * mirror has it). The 128px original is always there, so go straight to it
 * instead of the retry-with-backoff a flaky third-party cdn gets. True when
 * handled.
 */
function hsOwnCopyFallback(img) {
  const m = /^(https:\/\/(?:cdn\.)?heatsync\.org\/uploads\/[A-Za-z0-9_-]+)-[123]x\.webp/.exec(img.src)
  if (!m) return false
  img.src = `${m[1]}.webp`
  return true
}

/**
 * The original of one of our own smaller copies (<id>-Nx.webp → <id>.webp, same
 * host), for the places that want the full-size picture: tooltips, the pinned
 * preview. Anything else comes back unchanged.
 */
function hsOwnCanonicalUrl(url) {
  const m = /^(https:\/\/(?:cdn\.)?heatsync\.org\/uploads\/[A-Za-z0-9_-]+)-[123]x\.webp$/.exec(url)
  return m ? `${m[1]}.webp` : url
}
