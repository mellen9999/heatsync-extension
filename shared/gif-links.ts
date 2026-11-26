/**
 * gif-links.ts — one place that knows what a GIF url means.
 *
 * The corpus (migration 301) is built from twitch's Tier 2/3 GIF keyboard,
 * which is GIPHY-backed and puts a plain media url on the wire. Two facts here
 * are load-bearing and both are easy to get wrong:
 *
 *  1. The DEDUPE KEY IS THE ID, NEVER THE URL. Giphy serves one gif from
 *     media0..media4.giphy.com and the shard rotates between requests, so
 *     keying on the url forks one gif into five rows that each look unpopular.
 *
 *  2. THE STILL IS FREE. Giphy exposes per-rendition filenames off the same id,
 *     so `<id>/200_s.gif` is a still frame and `<id>/200.gif` is the animated
 *     fixed-height rendition — no API call, no key, no extra round trip. That
 *     is the whole reason the picker can show a grid of gifs on a passive-
 *     cooled box: it paints stills and animates exactly one.
 *
 * Shared rather than server-only because the picker derives the animated
 * rendition from the same id when a tile is hovered.
 */

/** Hosts giphy serves media from. Kept in step with client/utils/trusted-image-hosts.js. */
const GIPHY_MEDIA_HOSTS = new Set([
  'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com',
  'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com',
  'i.giphy.com',
])

const TENOR_MEDIA_HOSTS = new Set(['media.tenor.com', 'media1.tenor.com', 'c.tenor.com'])

const GIF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface GifSighting {
  provider: 'giphy' | 'tenor' | 'twitch'
  providerId: string
  /** Canonical direct media url — shard normalised, query string stripped. */
  mediaUrl: string
  label: string
  /** Lowercased, space-normalised search haystack. */
  terms: string
}

/**
 * Twitch's gif fragment carries GIPHY's own display text, which is a caption
 * and an attribution glued together in brackets:
 *
 *   [Tired Give Up GIF by Boomerang Official]
 *
 * The brackets are markup, and "GIF by <studio>" is a credit — neither is
 * something anyone types when they are looking for a gif, and leaving the word
 * GIF in the haystack makes it match every row in the corpus. Strip both and
 * keep the caption.
 */
export function gifLabel(raw: string): string {
  return raw
    .replace(/^\s*\[(.*)\]\s*$/, '$1')
    .replace(/\s+GIF\s+by\s+.*$/i, '')
    .replace(/\s+GIF$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** Collapse a label into the search haystack. Lowercase so LIKE stays indexable. */
export function gifTerms(label: string): string {
  return label
    .replace(/[_-]+/g, ' ')
    // camelCase labels ("catJAM") are one word to a human and two to a search
    // box; split them so "jam" finds "catJAM".
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * What gif is this url, if any? Returns null for anything we cannot name with a
 * STABLE id — including giphy's newer `/media/v1.<cid>/` form, where that
 * segment is a per-request content id rather than the gif's identity. Indexing
 * that would key the library on something that means a different thing on the
 * next request.
 */
export function canonicalGif(rawUrl: string, label = ''): GifSighting | null {
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password) return null

  const seg = u.pathname.split('/').filter(Boolean)
  const clean = (provider: GifSighting['provider'], id: string | undefined, mediaUrl: string) =>
    id && GIF_ID_RE.test(id)
      ? (() => {
          const clean = gifLabel(label)
          return { provider, providerId: id, mediaUrl, label: clean, terms: gifTerms(clean) }
        })()
      : null

  if (GIPHY_MEDIA_HOSTS.has(u.hostname)) {
    const id = u.hostname === 'i.giphy.com'
      ? seg[0]?.split('.')[0]
      : (seg[0] === 'media' && !seg[1]?.startsWith('v1.') ? seg[1] : undefined)
    // Normalised to one host so the same gif from five shards is one row.
    return id ? clean('giphy', id, `https://media.giphy.com/media/${id}/giphy.gif`) : null
  }

  if (TENOR_MEDIA_HOSTS.has(u.hostname)) {
    const id = seg[0] === 'images' ? seg[1] : seg[0]
    return clean('tenor', id, u.origin + u.pathname)
  }

  // A twitch-hosted gif (the fragment url is not always giphy). Nothing to
  // normalise — the url IS the identity, so the id is carried by the caller.
  return null
}

/**
 * The still frame for a grid tile, and the animated rendition for the one tile
 * that is hovered or selected. Giphy only: tenor has no equally reliable
 * derivable still, so a tenor row shows its own gif and the picker leans on the
 * hard visible cap instead. Do not pretend the two providers are symmetric.
 */
export function gifRenditions(g: { provider: string; providerId: string; mediaUrl: string }): {
  still: string
  animated: string
} {
  if (g.provider === 'giphy') {
    return {
      still: `https://media.giphy.com/media/${g.providerId}/200_s.gif`,
      animated: `https://media.giphy.com/media/${g.providerId}/200.gif`,
    }
  }
  return { still: g.mediaUrl, animated: g.mediaUrl }
}

// ─── The live line ────────────────────────────────────────────────────────────
// Everything above is about a gif as a LIBRARY row (a stable id, a search
// haystack). A live chat row needs the opposite: no identity, just "which
// picture goes where this caption was", and a url safe to hand a browser.

/** A gif a live twitch line carries: the fragment's exact text, and the picture that replaces it. */
export interface ChatGif {
  /** The fragment text as twitch sent it ("[Mood Lol GIF by Giphy]"); the row finds the caption by it. */
  text: string
  /** https media url, no query string — hosts the chat renderer already trusts for images. */
  url: string
}

/** A line holds one caption per gif and twitch caps a line at 500 characters; nobody reads nine. */
export const MAX_CHAT_GIFS = 4

/** The most a caption can be: a whole twitch line. */
const CHAT_GIF_TEXT_MAX = 500

const CHAT_GIF_HOSTS = new Set([...GIPHY_MEDIA_HOSTS, ...TENOR_MEDIA_HOSTS])

/** A picture the chat embed can draw. A page link on a trusted host is not one. */
const CHAT_GIF_FILE_RE = /\.(?:gif|webp|png|jpe?g|avif)$/i

/**
 * One gif for a live row, or null.
 *
 * Narrower than the renderer's trusted-host list on purpose: the gif keyboard is
 * giphy-backed and tenor is the other gif host the site knows, so those are the
 * only ones a `gif` fragment can name here. A url is kept as twitch sent it
 * (same shard, same filename — the `/media/v1.<cid>/` form too, which the
 * library refuses for want of a stable id and a live row does not need one),
 * minus the query string, which is tracking. Never rewritten to another host
 * or rendition: what the sender saw is what the room draws.
 *
 * tests/unit/gif-hosts-agree.test.ts keeps the host lists in step with
 * client/utils/trusted-image-hosts.js.
 */
export function chatGif(rawUrl: unknown, text: unknown): ChatGif | null {
  if (typeof rawUrl !== 'string' || typeof text !== 'string') return null
  if (!text || text.length > CHAT_GIF_TEXT_MAX) return null
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  if (!CHAT_GIF_HOSTS.has(u.hostname) || !CHAT_GIF_FILE_RE.test(u.pathname)) return null
  return { text, url: u.origin + u.pathname }
}

/**
 * A list of unknown shape (a wire frame, a stored row) reduced to the gifs a
 * live row may draw: each one through chatGif, one per caption, capped.
 */
export function chatGifs(raw: unknown): ChatGif[] {
  if (!Array.isArray(raw)) return []
  const out: ChatGif[] = []
  for (const item of raw) {
    if (out.length >= MAX_CHAT_GIFS) break
    const g = item && typeof item === 'object' ? chatGif((item as { url?: unknown }).url, (item as { text?: unknown }).text) : null
    if (g && !out.some(o => o.text === g.text)) out.push(g)
  }
  return out
}
