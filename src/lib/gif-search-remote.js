/**
 * gif-search-remote.js — the gifs tab's fetch layer.
 *
 * Talks only to heatsync. The corpus is ours (migration 301), so a keystroke
 * here reaches our postgres and nothing else — which is the entire reason the
 * gifs tab exists in this shape rather than as a giphy/tenor client.
 *
 * Shaped like utils/emote-search-remote.js on purpose, with ONE deliberate
 * difference: there is no localStorage cache. The emote LRU stores tiny
 * {name,url} records; a gif record is several urls and a label, and 20 queries
 * of 24 results would be hundreds of KB of a quota already shared with the
 * emote cache, the recents lists and the settings blob. The server redis-caches
 * and collapses concurrent hits, so an in-memory LRU is the right size here.
 *
 * @module utils/gif-search-remote
 */

export const GIF_PAGE_SIZE = 24

/** A gif record, or null if the payload is missing the one field that matters. */
export function normalizeGif(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!url) return null
  return {
    id: String(raw.id ?? url),
    url,
    // The still the grid paints. Falling back to the animated url is a
    // degradation, not a default — see the comment in renderGifs.
    preview: typeof raw.preview === 'string' && raw.preview ? raw.preview : url,
    animated: typeof raw.animated === 'string' && raw.animated ? raw.animated : url,
    label: typeof raw.label === 'string' ? raw.label : '',
    uses: Number(raw.uses) || 0,
  }
}

/**
 * One request. Throws with `status` (and `resetAt` on a 429) attached, because
 * a bare Error loses the one piece of information the status line needs.
 *
 * `base` is '' here and 'https://heatsync.org' in the extension, which ships
 * this file byte-identical (scripts/sync-site-copies.sh) and runs it from a
 * twitch.tv page, where a root-relative path would ask TWITCH for our gifs.
 * Both routes answer `Access-Control-Allow-Origin: *`, and a cross-origin fetch
 * sends no cookies unless it asks to — so the extension's request carries no
 * heatsync session, which is the posture we want for a search box.
 */
export async function fetchGifs(q, { limit = GIF_PAGE_SIZE, signal, base = '' } = {}) {
  const path = q
    ? `${base}/api/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}`
    : `${base}/api/gifs/top?limit=${limit}`
  const res = await fetch(path, { signal })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(`gifs ${res.status}`), { status: res.status, resetAt: body?.resetAt })
  }
  const data = await res.json()
  return {
    gifs: (Array.isArray(data?.gifs) ? data.gifs : []).map(normalizeGif).filter(Boolean),
    library: data?.library || { state: 'ready', indexed: 0 },
  }
}

/**
 * An instance-scoped searcher: one in-flight request at a time, a small TTL'd
 * LRU in front of it.
 */
export function createGifSearch({ ttl = 5 * 60_000, max = 20, base = '' } = {}) {
  const cache = new Map()
  let ctrl = null

  return {
    async search(q, limit = GIF_PAGE_SIZE) {
      const key = `${q}|${limit}`
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < ttl) return hit.val

      ctrl?.abort()
      ctrl = new AbortController()
      const val = await fetchGifs(q, { limit, signal: ctrl.signal, base })

      cache.set(key, { val, at: Date.now() })
      if (cache.size > max) cache.delete(cache.keys().next().value)
      return val
    },
    abort() { ctrl?.abort(); ctrl = null },
  }
}

/**
 * Grid navigation, as a pure function so the model is testable with no DOM.
 *
 * Clamps at the edges rather than wrapping: wrapping from the end of one row to
 * the start of the next is what vim does in a BUFFER, not in a grid, and a
 * cursor that teleports across the panel is disorienting. Returns null for a
 * key this does not own, so the caller can let it through to the input.
 */
export function nextGridIndex(index, key, { count, cols }) {
  if (count <= 0) return null
  const c = Math.max(1, cols | 0)
  const i = index < 0 ? 0 : index
  const clamp = (n) => Math.max(0, Math.min(count - 1, n))
  switch (key) {
    case 'ArrowLeft': case 'h': return clamp(i - 1)
    case 'ArrowRight': case 'l': return clamp(i + 1)
    case 'ArrowUp': case 'k': return clamp(i - c)
    case 'ArrowDown': case 'j': return clamp(i + c)
    case 'g': return 0
    case 'G': return count - 1
    default: return null
  }
}
