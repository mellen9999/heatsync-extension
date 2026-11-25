// emote-rungs.js — which file an emote draws at a given rung: the provider ladders
// (hsRungUrl) and the smaller copies of our own uploads (server/lib/emote-variants
// on the site). Kept apart from emotes.js, which sits at its line ceiling, and
// because the native chat scripts (content.js, youtube-content.js) embed this file
// but not emotes.js; getChatResUrl, the overlay's memoized caller, stays there.

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

/** The emote url at one rung of its provider's ladder. `want` is a multiple of
 *  the emote's LOGICAL 1x size, not a pixel count — providers disagree about
 *  how many pixels 1x is (twitch 28, 7TV 32) and that disagreement is what
 *  "native size" means. 4 is the largest rung, not literally 4x: twitch's
 *  `3.0` is 112px = 4x its 28px base, and BTTV stops at `3x`. */
function hsRungUrl(url, want) {
  if (want === 1) {
    // True native: downgrade Twitch native (IRC fetches at /2.0) and 3rd-party CDNs to 1x.
    if (url.includes('static-cdn.jtvnw.net')) return url.replace(/\/[23]\.0/, '/1.0')
    if (url.includes('cdn.7tv.app')) return url.replace(/\/[234]x/, '/1x')
    if (url.includes('cdn.betterttv.net')) return url.replace(/\/[23]x/, '/1x')
    if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/[24](?=\.|$)/, '/1')
  } else if (want === 2) {
    if (url.includes('cdn.7tv.app')) return url.replace(/\/[134]x/, '/2x')
    if (url.includes('cdn.betterttv.net')) return url.replace(/\/[13]x/, '/2x')
    if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/[14](?=\.|$)/, '/2')
    if (url.includes('static-cdn.jtvnw.net')) return url.replace(/\/[13]\.0/, '/2.0')
  } else if (want === 4) {
    if (url.includes('cdn.7tv.app')) return url.replace(/\/[123]x/, '/4x')
    if (url.includes('cdn.betterttv.net')) return url.replace(/\/[12]x/, '/3x')
    if (url.includes('cdn.frankerfacez.com')) return url.replace(/\/[12](?=\.|$)/, '/4')
    if (url.includes('static-cdn.jtvnw.net')) return url.replace(/\/[12]\.0/, '/3.0')
  }
  return url
}

/**
 * The ONE file every copy of an emote draws at rung `want` — overlay and native
 * rows alike. Chrome gives two <img> with the same src one animation clock (they
 * stay frame-locked even mounted seconds apart) and two different urls of the
 * same picture each their own, so a 1x record and a 2x record of one 7tv emote
 * (a saved copy vs the channel set) played out of step. Every url of a picture
 * is therefore pulled to the one rung; 7tv's avif goes to webp (Firefox cannot
 * animate avif, and chrome decodes a chat of animated avif heavier). Our own
 * uploads go by their advertised `variants` and nothing else.
 */
function hsEmoteFileUrl(url, want, variants) {
  if (!url) return url
  if (variants) return hsOwnRungUrl(url, want, variants)
  const out = hsRungUrl(url, want)
  return out.includes('cdn.7tv.app') ? out.replace(/\.avif(\?|$)/i, '.webp$1') : out
}

/**
 * The file a NATIVE chat row draws for an emote (content.js, youtube-content.js):
 * the row's emote box is 28px, so the rung is the screen's — 2x on a dense
 * screen (devicePixelRatio >= 1.5, the overlay's own cut in hsWantedRung), else
 * 1x. The same file the overlay draws (hsEmoteFileUrl), so two copies of one
 * picture stay on one clock. Zero-width (overlay) emotes keep their own url at
 * the call site: they are sized by the file's natural width, and a different
 * file would be a different size.
 */
function hsNativeRowUrl(emote) {
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio >= 1.5 ? 2 : 1
  return hsEmoteFileUrl(emote?.url, dpr, emote?.variants)
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
